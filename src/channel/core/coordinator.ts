// ---------------------------------------------------------------------------
// CoreCoordinator — pure business logic for round state machine, task routing,
// result processing, and streaming card management.
//
// Deployment-agnostic — uses adapter interfaces (BitableAdapter,
// ExecutorPoolInterface, FeishuAdapter) instead of concrete transport.
// ---------------------------------------------------------------------------

import type {
  BitableAdapter,
  ExecutorPoolInterface,
  FeishuAdapter,
  ExecutorInfo,
  TicketRecord,
  RoundRecord,
  StreamCardState,
  ExecutorResultPayload,
  StreamUpdatePayload,
  StreamEndPayload,
  Logger,
} from './types.js';
import type { Config } from '../../lib/types.js';

import { parseDomains, latestTurnMessageId, extractAppIdFromTurn, parseExecutorIdentity } from './helpers.js';
import {
  getTicket, getRound, getTurns, getCurrentRound,
  searchRoundsByStatus, searchStuckRounds, searchRoster,
  claimRound, releaseRound, transitionRound, setRoundResult,
  appendTurn, writeTicketResult, claimTicket, releaseTicket,
} from './bitable-ops.js';

// =============================================================================
// CoreCoordinator
// =============================================================================

export class CoreCoordinator {
  /** In-flight round processing promises (dedup concurrent calls). */
  private inflightRounds = new Map<string, Promise<void>>();

  // ── Streaming card state ──────────────────────────────────────────────
  private streamingCards = new Map<string, StreamCardState>();
  private streamBuffer = new Map<string, Array<{ content: string; type: string }>>();
  private streamThinkingAccumulated = new Map<string, string>();
  private streamAnswerAccumulated = new Map<string, string>();

  /** Per-operator adapters keyed by appId (for multi-credential IM replies). */
  private feishuMap = new Map<string, FeishuAdapter>();

  constructor(
    private bitable: BitableAdapter,
    private executorPool: ExecutorPoolInterface,
    private feishu: FeishuAdapter,
    private cfg: Config,
    private log: Logger,
    operatorFeishus?: Map<string, FeishuAdapter>,
  ) {
    if (operatorFeishus) this.feishuMap = operatorFeishus;
  }

  /** Get the FeishuAdapter for a given appId, falling back to the primary adapter. */
  private getFeishu(appId?: string): FeishuAdapter {
    if (appId) {
      const op = this.feishuMap.get(appId);
      if (op) return op;
    }
    return this.feishu;
  }

  // ===========================================================================
  // Round state machine
  // ===========================================================================

  /** Process a single Round by record_id. */
  async processRound(roundId: string): Promise<void> {
    // Dedup concurrent calls
    const existing = this.inflightRounds.get(roundId);
    if (existing) {
      await existing;
      return;
    }
    const promise = this.executeProcessRound(roundId);
    this.inflightRounds.set(roundId, promise);
    try {
      await promise;
    } finally {
      this.inflightRounds.delete(roundId);
    }
  }

  private async executeProcessRound(roundId: string): Promise<void> {
    const round = await getRound(this.bitable, this.cfg,roundId);
    if (!round) return;
    const status = String(round.fields[this.cfg.fields.round.status] ?? '');

    switch (status) {
      case this.cfg.roundStatuses.pending:
        await this.processPendingRound(round);
        break;
      case this.cfg.roundStatuses.pendingApproval:
        await this.processPendingApprovalRound(round);
        break;
      case this.cfg.roundStatuses.approved:
        await this.processApprovedRound(round);
        break;
      case this.cfg.roundStatuses.executing:
        await this.processStuckRound(round);
        break;
    }
  }

  /** Main coordination cycle: process Rounds in each state. */
  async roundCoordinationCycle(): Promise<void> {
    try {
      // 1. Stuck round detection (executing with expired lease)
      const stuckTimeout = (this.cfg.coordinator?.heartbeatSeconds ?? 60) * 2000;
      const stuck = await searchStuckRounds(this.bitable, this.cfg,stuckTimeout);
      for (const r of stuck) {
        await this.processStuckRound(r);
      }

      // 2. Process pending Rounds → HITL decision
      const pending = await searchRoundsByStatus(this.bitable, this.cfg,this.cfg.roundStatuses.pending);
      for (const r of pending) {
        await this.processPendingRound(r);
      }

      // 3. Process pending_approval Rounds → check for timeout override
      const pendingApproval = await searchRoundsByStatus(this.bitable, this.cfg,this.cfg.roundStatuses.pendingApproval);
      for (const r of pendingApproval) {
        await this.processPendingApprovalRound(r);
      }

      // 4. Process approved Rounds → assign executor
      const approved = await searchRoundsByStatus(this.bitable, this.cfg,this.cfg.roundStatuses.approved);
      for (const r of approved) {
        await this.processApprovedRound(r);
      }
    } catch (err) {
      this.log.error('[core-coordinator] roundCoordinationCycle error:', err);
    }
  }

  /** Process a pending Round: decide HITL vs direct execution. */
  private async processPendingRound(round: RoundRecord): Promise<void> {
    const roundId = round.record_id;
    if (!roundId) return;

    const ticketId = String(round.fields[this.cfg.fields.round.ticketRecordId] ?? '');
    if (!ticketId) return;

    // Re-read round to confirm it's still pending — a previous cycle or
    // bitable event may have already advanced it.
    const fresh = await getRound(this.bitable, this.cfg,roundId);
    if (!fresh) return;
    const curStatus = String(fresh.fields[this.cfg.fields.round.status] ?? '');
    if (curStatus !== this.cfg.roundStatuses.pending) {
      this.log.info(`[core-coordinator] round ${roundId} skip: status=${curStatus} (no longer pending)`);
      return;
    }

    const ticket = await getTicket(this.bitable, this.cfg,ticketId);
    if (!ticket) return;

    const domains = parseDomains(round.fields[this.cfg.fields.round.domains]);
    const needsApproval = await this.checkHitlRequired(domains);

    if (needsApproval) {
      this.log.info(`[core-coordinator] round ${roundId} → pending_approval`);
      await transitionRound(this.bitable, this.cfg,roundId, this.cfg.roundStatuses.pendingApproval);
    } else {
      this.log.info(`[core-coordinator] round ${roundId} → executing (direct)`);
      await this.assignRoundToExecutor(round, ticket);
    }
  }

  /** Process a pending_approval Round: check for timeout. */
  private async processPendingApprovalRound(round: RoundRecord): Promise<void> {
    const roundId = round.record_id;
    if (!roundId) return;

    const createdAt = Number(round.fields[this.cfg.fields.round.createdAt] ?? 0);
    const timeoutMs = (this.cfg.executor?.approvalTimeoutMinutes ?? 30) * 60 * 1000;
    if (createdAt > 0 && Date.now() - createdAt > timeoutMs) {
      this.log.info(`[core-coordinator] round ${roundId} approval timeout, reverting to pending`);
      await transitionRound(this.bitable, this.cfg,roundId, this.cfg.roundStatuses.pending);
    }
  }

  /** Process an approved Round: assign an executor. */
  private async processApprovedRound(round: RoundRecord): Promise<void> {
    const roundId = round.record_id;
    if (!roundId) return;

    const ticketId = String(round.fields[this.cfg.fields.round.ticketRecordId] ?? '');
    if (!ticketId) return;
    const ticket = await getTicket(this.bitable, this.cfg,ticketId);
    if (!ticket) return;

    this.log.info(`[core-coordinator] round ${roundId} approved, assigning executor`);
    await this.assignRoundToExecutor(round, ticket);
  }

  /** Check if HITL approval is needed based on executor Roster configurations. */
  private async checkHitlRequired(domains: string[]): Promise<boolean> {
    try {
      const agents = await searchRoster(this.bitable, this.cfg,{
        conjunction: 'and',
        conditions: [
          { field_name: this.cfg.fields.roster.kind, operator: 'is', value: ['agent'] },
          { field_name: this.cfg.fields.roster.enabled, operator: 'is', value: [true] },
        ],
      });

      const { PrefixMatcher } = await import('../../lib/messaging/matcher.js');
      const matcher = new PrefixMatcher();

      for (const agent of agents) {
        const agentDomains: string[] = Array.isArray(agent.fields[this.cfg.fields.roster.domains])
          ? agent.fields[this.cfg.fields.roster.domains] as string[] : [];
        if (domains.length > 0 && !matcher.matches(domains, agentDomains)) continue;

        const hitl = String(agent.fields[this.cfg.fields.roster.hitl] ?? 'off');
        const hitlPolicy = String(agent.fields[this.cfg.fields.roster.hitlPolicy] ?? 'default');
        if (hitl === 'always' || (hitl === 'auto' && hitlPolicy === 'always')) {
          return true;
        }
      }
    } catch (err) {
      this.log.error('[core-coordinator] checkHitlRequired error:', err);
    }
    return false;
  }

  /** Assign a Round to an executor via ExecutorPoolInterface. */
  private async assignRoundToExecutor(round: RoundRecord, ticket: TicketRecord): Promise<void> {
    const roundId = round.record_id;
    const recordId = ticket.record_id;
    if (!roundId || !recordId) return;

    const requiredDomains = parseDomains(round.fields[this.cfg.fields.round.domains]);

    // Phase 1: Try affinity — assign to last known owner
    const rawLastOwner = String(ticket.fields[this.cfg.fields.ticket.lastOwner] ?? '');
    const lastOwnerIdentity = parseExecutorIdentity(rawLastOwner);
    if (lastOwnerIdentity) {
      const available = await this.executorPool.getAvailableExecutors(requiredDomains);
      const matched = available.find(e => e.identity === lastOwnerIdentity && !e.activeTicketId);
      if (matched) {
        const won = await claimRound(this.bitable, this.cfg,round, matched.identity, this.cfg.roundStatuses.executing);
        if (won) {
          this.dispatchRoundToExecutor(matched, round, ticket);
          return;
        }
      }
    }

    // Phase 2: Any available executor
    const available = await this.executorPool.getAvailableExecutors(requiredDomains);
    this.log.info(`[core-coordinator] assignRoundToExecutor: ${available.length} candidates for round ${roundId}`);
    for (const ex of available) {
      if (ex.identity === lastOwnerIdentity) continue;
      const won = await claimRound(this.bitable, this.cfg,round, ex.identity, this.cfg.roundStatuses.executing);
      if (!won) { this.log.info(`[core-coordinator] claimRound lost for ${ex.identity}`); continue; }
      this.dispatchRoundToExecutor(ex, round, ticket);
      return;
    }

    this.log.info(`[core-coordinator] no executor for round ${roundId} with domains=${requiredDomains}, waiting`);
  }

  /** After a new executor connects, try assigning it to any pending round. */
  async tryAssignPendingToExecutor(identity: string, domains: string[]): Promise<void> {
    const pending = await searchRoundsByStatus(this.bitable, this.cfg,this.cfg.roundStatuses.pending);
    for (const round of pending) {
      const requiredDomains = parseDomains(round.fields[this.cfg.fields.round.domains]);
      if (requiredDomains.length > 0) {
        // Use prefix matching — skip if executor's domains don't cover required domains
        const { PrefixMatcher } = await import('../../lib/messaging/matcher.js');
        const matcher = new PrefixMatcher();
        if (!matcher.matches(requiredDomains, domains)) continue;
      }
      const won = await claimRound(this.bitable, this.cfg,round, identity, this.cfg.roundStatuses.executing);
      if (!won) continue;
      const ticketId = String(round.fields[this.cfg.fields.round.ticketRecordId] ?? '');
      if (!ticketId) continue;
      const ticket = await getTicket(this.bitable, this.cfg,ticketId);
      if (!ticket) continue;
      this.dispatchRoundToExecutor({ identity, domains, activeTicketId: undefined, connected: true, lastHeartbeat: Date.now() }, round, ticket);
      return;
    }
  }

  /** Build the task payload and dispatch to an executor. */
  private async dispatchRoundToExecutor(
    ex: ExecutorInfo,
    round: RoundRecord,
    ticket: TicketRecord,
  ): Promise<void> {
    const recordId = ticket.record_id;
    if (!recordId) return;

    // Status already set to executing by claimRound, no extra transition needed.

    const turns = await getTurns(this.bitable, this.cfg,recordId);
    const supplementPrompt = String(round.fields[this.cfg.fields.round.supplementPrompt] ?? '');

    // Determine reaction appId from the first user turn
    const turnAppId = (() => {
      for (const t of turns) {
        const role = String(t.fields[this.cfg.fields.turn.role] ?? '');
        if (role === 'user') {
          return extractAppIdFromTurn(t, this.cfg.fields.turn.appId, this.cfg.fields.turn.dedupKey);
        }
      }
      return undefined;
    })();

    const payload = {
      type: 'task',
      ticket: { record_id: recordId, fields: ticket.fields },
      turns: turns.map(t => ({ record_id: t.record_id, fields: t.fields })),
      globalPrompt: this.cfg.coordinator?.globalPrompt || '',
      stream_output: this.cfg.coordinator?.streamOutput === true,
      stream_thinking: this.cfg.coordinator?.streamThinking === true,
      round: {
        record_id: round.record_id,
        fields: round.fields,
        supplementPrompt,
      },
    };

    this.executorPool.dispatchTask(ex.identity, payload);

    // React to the latest user turn message
    const latestMsgId = latestTurnMessageId(turns, this.cfg.fields.turn.role, this.cfg.fields.turn.dedupKey);
    if (latestMsgId) {
      try { await this.feishu.removeReaction(latestMsgId, 'OneSecond'); } catch { /* */ }
      try { await this.feishu.react(latestMsgId, 'OnIt'); } catch { /* */ }
    }

    this.log.info(`[core-coordinator] round ${round.record_id!} dispatched to ${ex.identity}`);
  }

  /** Send cancel to an executor assigned to this Round. */
  async dispatchCancelToExecutor(roundId: string): Promise<boolean> {
    try {
      const round = await getRound(this.bitable, this.cfg,roundId);
      if (!round) return false;
      const executorField = String(round.fields[this.cfg.fields.round.executor] ?? '');
      if (!executorField) return false;
      const identity = parseExecutorIdentity(executorField);
      return this.executorPool.dispatchCancel(identity, roundId);
    } catch (err) {
      this.log.error('[core-coordinator] dispatchCancelToExecutor failed:', err);
      return false;
    }
  }

  /** Process a stuck Round (executing with expired lease). */
  private async processStuckRound(round: RoundRecord): Promise<void> {
    const roundId = round.record_id;
    if (!roundId) return;

    const stuckTimeout = (this.cfg.coordinator?.heartbeatSeconds ?? 60) * 2000;
    const updatedAt = Number(round.fields[this.cfg.fields.round.updatedAt] ?? 0);
    if (updatedAt > 0 && Date.now() - updatedAt < stuckTimeout) return;

    const executorField = String(round.fields[this.cfg.fields.round.executor] ?? '');
    const identity = parseExecutorIdentity(executorField);

    if (identity) {
      const available = await this.executorPool.getAvailableExecutors();
      const stillConnected = available.some(e => e.identity === identity);
      if (stillConnected) {
        // still connected, skip stuck check
        return;
      }
    }

    this.log.info(`[core-coordinator] stuck round ${roundId}, reverting to pending`);
    try {
      await releaseRound(this.bitable, this.cfg,roundId);
    } catch (err) {
      this.log.error(`[core-coordinator] processStuckRound failed ${roundId}:`, err);
    }
  }

  // ===========================================================================
  // Task routing (non-round mode — legacy path)
  // ===========================================================================

  /** Try to route a pending ticket to an available executor. */
  async tryRoute(ticket: TicketRecord): Promise<boolean> {
    const recordId = ticket.record_id;
    if (!recordId) {
      this.log.info('[core-coordinator] tryRoute: no record_id');
      return false;
    }

    const status = String(ticket.fields[this.cfg.fields.ticket.status] ?? '');
    this.log.info(`[core-coordinator] tryRoute ticket=${recordId.slice(0, 12)} status=${status}`);

    // In Round-driven mode, nudge the existing active round
    if (this.cfg.roundsTableId) {
      const currentRound = await getCurrentRound(this.bitable, this.cfg,recordId);
      if (currentRound?.record_id) {
        await this.processRound(currentRound.record_id);
      }
      return true;
    }

    // Non-round path: match any free executor
    const rawLastOwner = String(ticket.fields[this.cfg.fields.ticket.lastOwner] ?? '');
    const lastOwnerIdentity = parseExecutorIdentity(rawLastOwner);

    // Try affinity first
    if (lastOwnerIdentity) {
      const available = await this.executorPool.getAvailableExecutors();
      const matched = available.find(e => e.identity === lastOwnerIdentity && !e.activeTicketId);
      if (matched) {
        const won = await claimTicket(this.bitable, this.cfg,ticket);
        if (won) {
          await this.dispatchTask(matched, ticket, recordId);
          return true;
        }
      }
    }

    // Try any available executor
    const available = await this.executorPool.getAvailableExecutors();
    for (const ex of available) {
      if (ex.activeTicketId) continue;
      if (ex.identity === lastOwnerIdentity) continue;
      const won = await claimTicket(this.bitable, this.cfg,ticket);
      if (!won) continue;
      await this.dispatchTask(ex, ticket, recordId);
      return true;
    }

    return false;
  }

  /** Dispatch a task (non-round mode). */
  private async dispatchTask(ex: ExecutorInfo, ticket: TicketRecord, recordId: string): Promise<void> {
    const turns = await getTurns(this.bitable, this.cfg,recordId);

    const appId = (() => {
      for (const t of turns) {
        const role = String(t.fields[this.cfg.fields.turn.role] ?? '');
        if (role === 'user') {
          return extractAppIdFromTurn(t, this.cfg.fields.turn.appId, this.cfg.fields.turn.dedupKey);
        }
      }
      return undefined;
    })();

    const payload = {
      type: 'task',
      ticket: { record_id: recordId, fields: ticket.fields },
      turns: turns.map(t => ({ record_id: t.record_id, fields: t.fields })),
      globalPrompt: this.cfg.coordinator?.globalPrompt || '',
      stream_output: this.cfg.coordinator?.streamOutput === true,
      stream_thinking: this.cfg.coordinator?.streamThinking === true,
    };

    this.executorPool.dispatchTask(ex.identity, payload);

    const latestMsgId = latestTurnMessageId(turns, this.cfg.fields.turn.role, this.cfg.fields.turn.dedupKey);
    if (latestMsgId) {
      try { await this.feishu.removeReaction(latestMsgId, 'OneSecond'); } catch { /* */ }
      try { await this.feishu.react(latestMsgId, 'OnIt'); } catch { /* */ }
    }

    this.log.info(`[core-coordinator] ticket ${recordId} assigned to ${ex.identity}`);
  }

  // ===========================================================================
  // Result processing
  // ===========================================================================

  /** Process an executor result: write turn, update ticket/round, manage reactions. */
  async processResult(identity: string, data: ExecutorResultPayload): Promise<void> {
    const { ticket_id: ticketId, round_id: roundId, answer,
            parts, reassignTo, streamed, newSummary } = data;
    let { root_msg_id: rootMsgId } = data;

    // Resolve rootMsgId from turns if executor didn't include it
    if (!rootMsgId) {
      try {
        const turns = await getTurns(this.bitable, this.cfg,ticketId);
        for (const t of turns) {
          const rid = String(t.fields[this.cfg.fields.turn.rootMsgId] ?? '');
          if (rid) { rootMsgId = rid; break; }
        }
      } catch { /* */ }
    }

    this.log.info(`[core-coordinator] result from ${identity} ticket=${ticketId} rootMsgId=${rootMsgId || '(empty)'} streamed=${!!streamed} answer=${(answer || '').slice(0, 60)}`);

    // Resolve appId from round for multi-operator IM routing
    let resultAppId: string | undefined;
    if (roundId && this.cfg.roundsTableId) {
      try {
        const round = await getRound(this.bitable, this.cfg,roundId);
        if (round) resultAppId = String(round.fields[this.cfg.fields.round.appId] ?? '') || undefined;
      } catch { /* ignore */ }
    }

    // Write agent turn
    try {
      const agentDedupKey = `${ticketId}_${Date.now()}`;
      const turnId = await appendTurn(this.bitable, this.cfg,
        ticketId, 'agent', answer, agentDedupKey, identity,
        'answered', rootMsgId, roundId, parts, 1, resultAppId,
      );
      this.log.info(`[core-coordinator] agent turn written ticket=${ticketId} turnId=${turnId}`);

      // Direct IM delivery for non-streamed results
      if (answer && rootMsgId && !streamed) {
        try {
          await this.getFeishu(resultAppId).reply(rootMsgId, answer, true);
        } catch (imErr) {
          this.log.error('[core-coordinator] direct IM delivery failed:', imErr);
        }
      }
    } catch (err: any) {
      this.log.error(`[core-coordinator] appendTurn failed: ${err.message}`, err);
    }

    // Record lastOwner for future affinity routing
    // Note: In Node, session.release handles lastOwner. In Worker, release only
    // updates status — the executor field on the Round serves as the affinity
    // record. Both deployments get equivalent affinity behavior.
    try {
      await releaseTicket(this.bitable, this.cfg,ticketId, this.cfg.statuses.active);
    } catch { /* best effort */ }

    // Update ticket status
    const needsReassign = reassignTo && reassignTo.roles && reassignTo.roles.length > 0;
    if (needsReassign) {
      this.log.info(`[core-coordinator] reassigning ticket=${ticketId} to roles=${reassignTo!.roles}`);
      await releaseTicket(this.bitable, this.cfg,ticketId, this.cfg.statuses.active);
    } else {
      this.log.info(`[core-coordinator] writeResult ticket=${ticketId}`);
      try {
        await writeTicketResult(this.bitable, this.cfg,ticketId, answer, newSummary || '');
      } catch (err: any) {
        this.log.error(`[core-coordinator] writeResult failed: ${err.message}`, err);
      }
    }

    // Update Round status
    if (roundId && this.cfg.roundsTableId) {
      try {
        await setRoundResult(this.bitable, this.cfg,roundId, answer);
        if (needsReassign) {
          await transitionRound(this.bitable, this.cfg,roundId, this.cfg.roundStatuses.pending);
        } else {
          const currentRound = await getRound(this.bitable, this.cfg,roundId);
          const rStatus = String(currentRound?.fields?.[this.cfg.fields.round.status] ?? '');
          if (rStatus === this.cfg.roundStatuses.executing) {
            await transitionRound(this.bitable, this.cfg,roundId, this.cfg.roundStatuses.done);
          }
        }
      } catch (err: any) {
        this.log.error(`[core-coordinator] round result update failed: ${err.message}`, err);
      }
    }

    // Remove OnIt emoji
    try {
      const resultTurns = await getTurns(this.bitable, this.cfg,ticketId);
      const latestId = latestTurnMessageId(resultTurns, this.cfg.fields.turn.role, this.cfg.fields.turn.dedupKey);
      if (latestId) {
        try { await this.feishu.removeReaction(latestId, 'OnIt'); } catch { /* */ }
      }
    } catch { /* */ }
  }

  // ===========================================================================
  // Streaming card management
  // ===========================================================================

  /** Handle a streaming update from an executor. Creates or updates a Lark card. */
  async handleStreamUpdate(data: StreamUpdatePayload): Promise<void> {
    if (!this.cfg.coordinator?.streamOutput) return;

    const { ticket_id: ticketId, round_id: roundId, content, content_type: contentType, root_msg_id: rootMsgId } = data;
    const cardKey = roundId || ticketId;

    // Look up or determine the appId from the round
    let streamAppId: string | undefined;
    if (roundId && this.cfg.roundsTableId) {
      try {
        const r = await getRound(this.bitable, this.cfg,roundId);
        if (r) streamAppId = String(r.fields[this.cfg.fields.round.appId] ?? '') || undefined;
      } catch { /* */ }
    }

    if (!this.streamingCards.has(cardKey) && rootMsgId) {
      await this.initializeStreamCard(cardKey, rootMsgId, content, contentType, streamAppId);
      return;
    }

    const s = this.streamingCards.get(cardKey);
    if (!s || !s.cardId) return;

    const feishu = this.getFeishu(streamAppId);
    if (contentType === 'thinking') {
      const display = '> ' + content.replace(/\n/g, '\n> ');
      const prev = this.streamThinkingAccumulated.get(cardKey) || '';
      const sep = prev && !prev.endsWith('\n') ? '\n' : '';
      const full = prev + sep + display;
      this.streamThinkingAccumulated.set(cardKey, full);
      s.seq++;
      try { await feishu.updateCardElement!(s.cardId, 'stream_thinking', full, s.seq, `st_${s.cardId}_${s.seq}`); } catch {}
    } else {
      const prev = this.streamAnswerAccumulated.get(cardKey) || '';
      const sep = prev && !prev.endsWith('\n') ? '\n' : '';
      const full = prev + sep + content;
      this.streamAnswerAccumulated.set(cardKey, full);
      s.seq++;
      try { await feishu.updateCardElement!(s.cardId, 'stream_answer', full, s.seq, `sa_${s.cardId}_${s.seq}`); } catch {}
    }
  }

  /** Handle the end of a streaming response. Finalize the card. */
  async handleStreamEnd(data: StreamEndPayload): Promise<void> {
    if (!this.cfg.coordinator?.streamOutput) return;

    const { ticket_id: ticketId, round_id: roundId, content, duration_ms: durationMs, token_usage: tokenUsage } = data;
    const cardKey = roundId || ticketId;

    const s = this.streamingCards.get(cardKey);
    if (!s) { this.streamBuffer.delete(cardKey); return; }

    // Card creation still in progress — buffer end content
    if (!s.cardId && this.streamBuffer.has(cardKey)) {
      this.streamBuffer.get(cardKey)!.push({ content, type: 'message' });
      return;
    }

    if (s.cardId) {
      const feishu = this.getFeishu(s.appId);
      const thinkingContent = this.streamThinkingAccumulated.get(cardKey) || '';
      const answerContent = this.streamAnswerAccumulated.get(cardKey) || content;

      // Finalize both elements
      if (thinkingContent) {
        s.seq++;
        try { await feishu.updateCardElement!(s.cardId, 'stream_thinking', thinkingContent, s.seq, `ft_${s.cardId}_${s.seq}`); } catch {}
      }
      if (answerContent) {
        s.seq++;
        try { await feishu.updateCardElement!(s.cardId, 'stream_answer', answerContent, s.seq, `fa_${s.cardId}_${s.seq}`); } catch {}
      }

      // Stats line
      const statsParts: string[] = [];
      if (tokenUsage) {
        const total = (tokenUsage.input || 0) + (tokenUsage.output || 0);
        if (total > 0) statsParts.push(`⚡ ${total.toLocaleString()} tokens`);
      }
      if (durationMs && durationMs > 100) {
        statsParts.push(`${(durationMs / 1000).toFixed(1)}s`);
      }
      if (statsParts.length > 0) {
        s.seq++;
        try { await feishu.updateCardElement!(s.cardId, 'stream_stats', `— *${statsParts.join(' · ')}* —`, s.seq, `ss_${s.cardId}_${s.seq}`); } catch {}
      }

      // Disable streaming mode
      const summary = (answerContent || thinkingContent).slice(0, 50) || '[Done]';
      s.seq++;
      try { await feishu.disableStreamingMode!(s.cardId, s.seq, summary, `c_${s.cardId}_${s.seq}`); } catch {}
    }

    // Cleanup
    this.streamingCards.delete(cardKey);
    this.streamThinkingAccumulated.delete(cardKey);
    this.streamAnswerAccumulated.delete(cardKey);
    this.streamBuffer.delete(cardKey);
  }

  /** Create a new streaming card in Lark IM. Buffers content during creation. */
  private async initializeStreamCard(
    cardKey: string,
    rootMsgId: string,
    initialContent: string,
    contentType: string,
    appId?: string,
  ): Promise<void> {
    const buf = this.streamBuffer.get(cardKey) || [];
    buf.push({ content: initialContent, type: contentType });
    this.streamBuffer.set(cardKey, buf);
    if (buf.length > 1) return;

    this.streamingCards.set(cardKey, { cardId: '', seq: 0, appId });
    const feishu = this.getFeishu(appId);

    try {
      const cardSpec = {
        schema: '2.0',
        config: { streaming_mode: true, summary: { content: '[Generating...]' }, streaming_config: { print_frequency_ms: { default: 70 }, print_step: { default: 1 }, print_strategy: 'fast' } },
        body: { elements: [
          { tag: 'markdown', element_id: 'stream_thinking', content: '', text_size: 'text_size_note' },
          { tag: 'markdown', element_id: 'stream_answer', content: '...' },
          { tag: 'markdown', element_id: 'stream_stats', content: '', text_size: 'body' },
        ] },
      };
      const cardId = await feishu.createStreamingCard!(cardSpec, rootMsgId, true);
      if (!cardId) { this.streamingCards.delete(cardKey); this.streamBuffer.delete(cardKey); return; }

      const st = this.streamingCards.get(cardKey);
      if (st) st.cardId = cardId;

      // Flush buffered content
      const pending = this.streamBuffer.get(cardKey) || [];
      this.streamBuffer.delete(cardKey);
      let thinkingFull = '';
      let answerFull = '';
      for (const chunk of pending) {
        if (chunk.type === 'thinking') {
          const sep = thinkingFull ? '\n' : '';
          thinkingFull += sep + '> ' + chunk.content.replace(/\n/g, '\n> ');
        } else {
          const sep = answerFull ? '\n' : '';
          answerFull += sep + chunk.content;
        }
      }
      const st2 = this.streamingCards.get(cardKey);
      if (thinkingFull && st2) {
        st2.seq++;
        try { await feishu.updateCardElement!(cardId, 'stream_thinking', thinkingFull, st2.seq, `t_${cardId}_${st2.seq}`); } catch {}
      }
      if (answerFull && st2) {
        st2.seq++;
        try { await feishu.updateCardElement!(cardId, 'stream_answer', answerFull, st2.seq, `a_${cardId}_${st2.seq}`); } catch {}
      }
      this.streamThinkingAccumulated.set(cardKey, thinkingFull);
      this.streamAnswerAccumulated.set(cardKey, answerFull);
    } catch {
      this.streamingCards.delete(cardKey);
      this.streamBuffer.delete(cardKey);
    }
  }
}
