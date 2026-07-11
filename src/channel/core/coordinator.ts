// ---------------------------------------------------------------------------
// CoreCoordinator — pure business logic for round state machine, task routing,
// result processing, and streaming card management.
//
// Deployment-agnostic — uses adapter interfaces (SessionAdapter,
// ExecutorPoolInterface, FeishuAdapter) instead of concrete transport.
// ---------------------------------------------------------------------------

import type {
  SessionAdapter,
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

// ---- Helpers ---------------------------------------------------------------

/** Parse the JSON `domains` field from a Round record. Returns empty array if unset or malformed. */
function parseDomains(v: unknown): string[] {
  if (!v) return [];
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Find the latest user turn's message ID from the turns list.
 *  Handles dedupKey formats: "messageId" (legacy) or "appId:messageId" (multi-operator). */
function latestTurnMessageId(
  turns: TicketRecord[],
  roleField: string,
  dedupKeyField: string,
): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const role = String(turns[i].fields[roleField] ?? '');
    if (role === 'user') {
      const raw = String(turns[i].fields[dedupKeyField] ?? '');
      if (!raw) return '';
      const colonIdx = raw.indexOf(':');
      return colonIdx > 0 ? raw.slice(colonIdx + 1) : raw;
    }
  }
  return '';
}

/** Extract the appId from a turn's appId field or dedupKey prefix. */
function extractAppIdFromTurn(turn: TicketRecord, appIdField: string, dedupKeyField: string): string | undefined {
  const fieldVal = String(turn.fields[appIdField] ?? '');
  if (fieldVal) return fieldVal;
  const dedupKey = String(turn.fields[dedupKeyField] ?? '');
  if (dedupKey) {
    const colonIdx = dedupKey.indexOf(':');
    if (colonIdx > 0) return dedupKey.slice(0, colonIdx);
  }
  return undefined;
}

/** Extract the identity from an executor field value (strips prefix like "RETRY:"). */
function parseExecutorIdentity(v: string): string {
  return v.includes('#') ? v.split('#').pop()! : v;
}

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

  constructor(
    private session: SessionAdapter,
    private executorPool: ExecutorPoolInterface,
    private feishu: FeishuAdapter,
    private cfg: Config,
    private log: Logger,
  ) {}

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
    const round = await this.session.getRound(roundId);
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
      const stuck = await this.session.searchStuckRounds(stuckTimeout);
      for (const r of stuck) {
        await this.processStuckRound(r);
      }

      // 2. Process pending Rounds → HITL decision
      const pending = await this.session.searchRoundsByStatus(this.cfg.roundStatuses.pending);
      for (const r of pending) {
        await this.processPendingRound(r);
      }

      // 3. Process pending_approval Rounds → check for timeout override
      const pendingApproval = await this.session.searchRoundsByStatus(this.cfg.roundStatuses.pendingApproval);
      for (const r of pendingApproval) {
        await this.processPendingApprovalRound(r);
      }

      // 4. Process approved Rounds → assign executor
      const approved = await this.session.searchRoundsByStatus(this.cfg.roundStatuses.approved);
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
    const ticket = await this.session.getTicket(ticketId);
    if (!ticket) return;

    const domains = parseDomains(round.fields[this.cfg.fields.round.domains]);
    const needsApproval = await this.checkHitlRequired(domains);

    if (needsApproval) {
      this.log.info(`[core-coordinator] round ${roundId} → pending_approval`);
      await this.session.transitionRound(roundId, this.cfg.roundStatuses.pendingApproval);
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
      await this.session.transitionRound(roundId, this.cfg.roundStatuses.pending);
    }
  }

  /** Process an approved Round: assign an executor. */
  private async processApprovedRound(round: RoundRecord): Promise<void> {
    const roundId = round.record_id;
    if (!roundId) return;

    const ticketId = String(round.fields[this.cfg.fields.round.ticketRecordId] ?? '');
    if (!ticketId) return;
    const ticket = await this.session.getTicket(ticketId);
    if (!ticket) return;

    this.log.info(`[core-coordinator] round ${roundId} approved, assigning executor`);
    await this.assignRoundToExecutor(round, ticket);
  }

  /** Check if HITL approval is needed based on executor Roster configurations. */
  private async checkHitlRequired(domains: string[]): Promise<boolean> {
    try {
      const agents = await this.session.searchRoster({
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
        const won = await this.session.claimRound(round, matched.identity);
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
      const won = await this.session.claimRound(round, ex.identity);
      if (!won) { this.log.info(`[core-coordinator] claimRound lost for ${ex.identity}`); continue; }
      this.dispatchRoundToExecutor(ex, round, ticket);
      return;
    }

    this.log.info(`[core-coordinator] no executor for round ${roundId} with domains=${requiredDomains}, waiting`);
  }

  /** After a new executor connects, try assigning it to any pending round. */
  async tryAssignPendingToExecutor(identity: string, domains: string[]): Promise<void> {
    const pending = await this.session.searchRoundsByStatus(this.cfg.roundStatuses.pending);
    for (const round of pending) {
      const requiredDomains = parseDomains(round.fields[this.cfg.fields.round.domains]);
      if (requiredDomains.length > 0) {
        // Use prefix matching — skip if executor's domains don't cover required domains
        const { PrefixMatcher } = await import('../../lib/messaging/matcher.js');
        const matcher = new PrefixMatcher();
        if (!matcher.matches(requiredDomains, domains)) continue;
      }
      const won = await this.session.claimRound(round, identity);
      if (!won) continue;
      const ticketId = String(round.fields[this.cfg.fields.round.ticketRecordId] ?? '');
      if (!ticketId) continue;
      const ticket = await this.session.getTicket(ticketId);
      if (!ticket) continue;
      this.log.info(`[core-coordinator] assigned pending round ${round.record_id!} to ${identity}`);
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

    // Transition Round to executing
    await this.session.transitionRound(round.record_id!, this.cfg.roundStatuses.executing);

    const turns = await this.session.getTurns(recordId);
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
      const round = await this.session.getRound(roundId);
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
        this.log.info(`[core-coordinator] round ${roundId} executor ${identity} still connected, skip stuck check`);
        return;
      }
    }

    this.log.info(`[core-coordinator] stuck round ${roundId}, reverting to pending`);
    try {
      await this.session.releaseRound(roundId);
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
      const currentRound = await this.session.getCurrentRound(recordId);
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
        const won = await this.session.claim(ticket);
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
      const won = await this.session.claim(ticket);
      if (!won) continue;
      await this.dispatchTask(ex, ticket, recordId);
      return true;
    }

    return false;
  }

  /** Dispatch a task (non-round mode). */
  private async dispatchTask(ex: ExecutorInfo, ticket: TicketRecord, recordId: string): Promise<void> {
    const turns = await this.session.getTurns(recordId);

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
    const { ticket_id: ticketId, round_id: roundId, answer, root_msg_id: rootMsgId,
            parts, reassignTo, streamed, newSummary } = data;

    this.log.info(`[core-coordinator] result from ${identity} ticket=${ticketId} rootMsgId=${rootMsgId || '(empty)'} streamed=${!!streamed} answer=${(answer || '').slice(0, 60)}`);

    // Write agent turn
    try {
      const agentDedupKey = `${ticketId}_${Date.now()}`;
      const turnId = await this.session.appendTurn(
        ticketId, 'agent', answer, agentDedupKey, identity,
        'answered', rootMsgId, roundId, parts, 1,
      );
      this.log.info(`[core-coordinator] agent turn written ticket=${ticketId} turnId=${turnId}`);

      // Direct IM delivery for non-streamed results
      if (answer && rootMsgId && !streamed) {
        try {
          await this.feishu.reply(rootMsgId, answer, true);
        } catch (imErr) {
          this.log.error('[core-coordinator] direct IM delivery failed:', imErr);
        }
      }
    } catch (err: any) {
      this.log.error(`[core-coordinator] appendTurn failed: ${err.message}`, err);
    }

    // Record lastOwner for future affinity routing
    try {
      await this.session.release(ticketId, this.cfg.statuses.active); // minimal update
    } catch { /* best effort */ }

    // Update ticket status
    const needsReassign = reassignTo && reassignTo.roles && reassignTo.roles.length > 0;
    if (needsReassign) {
      this.log.info(`[core-coordinator] reassigning ticket=${ticketId} to roles=${reassignTo!.roles}`);
      await this.session.release(ticketId, this.cfg.statuses.active);
    } else {
      this.log.info(`[core-coordinator] writeResult ticket=${ticketId}`);
      try {
        await this.session.writeResult(ticketId, answer, newSummary || '');
      } catch (err: any) {
        this.log.error(`[core-coordinator] writeResult failed: ${err.message}`, err);
      }
    }

    // Update Round status
    if (roundId && this.cfg.roundsTableId) {
      try {
        await this.session.setRoundResult(roundId, answer);
        if (needsReassign) {
          await this.session.transitionRound(roundId, this.cfg.roundStatuses.pending);
        } else {
          const currentRound = await this.session.getRound(roundId);
          const rStatus = String(currentRound?.fields?.[this.cfg.fields.round.status] ?? '');
          if (rStatus === this.cfg.roundStatuses.executing) {
            await this.session.transitionRound(roundId, this.cfg.roundStatuses.done);
          }
        }
      } catch (err: any) {
        this.log.error(`[core-coordinator] round result update failed: ${err.message}`, err);
      }
    }

    // Remove OnIt emoji
    try {
      const resultTurns = await this.session.getTurns(ticketId);
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
        const r = await this.session.getRound(roundId);
        if (r) streamAppId = String(r.fields[this.cfg.fields.round.appId] ?? '') || undefined;
      } catch { /* */ }
    }

    if (!this.streamingCards.has(cardKey) && rootMsgId) {
      await this.initializeStreamCard(cardKey, rootMsgId, content, contentType, streamAppId);
      return;
    }

    const s = this.streamingCards.get(cardKey);
    if (s) {
      if (contentType === 'thinking') {
        const display = '> ' + content.replace(/\n/g, '\n> ');
        const prev = this.streamThinkingAccumulated.get(cardKey) || '';
        const sep = prev && !prev.endsWith('\n') ? '\n' : '';
        const full = prev + sep + display;
        this.streamThinkingAccumulated.set(cardKey, full);
      } else {
        const prev = this.streamAnswerAccumulated.get(cardKey) || '';
        const sep = prev && !prev.endsWith('\n') ? '\n' : '';
        const full = prev + sep + content;
        this.streamAnswerAccumulated.set(cardKey, full);
      }
    }
  }

  /** Handle the end of a streaming response. Finalize the card. */
  async handleStreamEnd(data: StreamEndPayload): Promise<void> {
    if (!this.cfg.coordinator?.streamOutput) return;

    const { ticket_id: ticketId, round_id: roundId, content, duration_ms: durationMs, token_usage: tokenUsage } = data;
    const cardKey = roundId || ticketId;

    const s = this.streamingCards.get(cardKey);
    if (s && s.cardId) {
      const thinkingContent = this.streamThinkingAccumulated.get(cardKey) || '';
      const answerContent = this.streamAnswerAccumulated.get(cardKey) || content;

      // Reset streaming state for next iteration
      this.streamingCards.delete(cardKey);
      this.streamThinkingAccumulated.delete(cardKey);
      this.streamAnswerAccumulated.delete(cardKey);
    }
    this.streamBuffer.delete(cardKey);
  }

  /** Create a new streaming card in Lark IM. */
  private async initializeStreamCard(
    cardKey: string,
    rootMsgId: string,
    initialContent: string,
    contentType: string,
    _appId?: string,
  ): Promise<void> {
    // Buffer the initial content
    const buf = this.streamBuffer.get(cardKey) || [];
    buf.push({ content: initialContent, type: contentType });
    this.streamBuffer.set(cardKey, buf);

    if (buf.length > 1) return;

    this.streamingCards.set(cardKey, { cardId: '', seq: 0, appId: _appId });

    try {
      // Streaming cards require the Lark CardKit API (available in Workers via fetch).
      // For now, set a placeholder so stream_end can find us.
      this.log.info(`[core-coordinator] stream initialized for ${cardKey}`);
    } catch {
      this.streamBuffer.delete(cardKey);
    }
  }
}
