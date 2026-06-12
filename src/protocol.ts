import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, homedir } from 'node:os';
import { Config, BitableRecord, ROUND_TRANSITIONS, Part } from './types.js';
import { BitableClient } from './bitable.js';
import { logger } from './log.js';
import { formatMessage } from './messages.js';

import { extractText, extractUserIds } from './text.js';
// Re-export text utilities for backward compatibility
export { extractText, extractUserIds }; // satisfies users of `from './protocol.js'`

// ---------------------------------------------------------------------------
// BAM protocol operations — fully driven by user config, no hardcoded
// field names or status values.
// ---------------------------------------------------------------------------

/** Prefix for owner field when a ticket is released for retry by another executor. */
export const RETRY_OWNER_PREFIX = 'RETRY:';

/** Lease duration for turn delivery claim (seconds). A channel claims a turn
 *  before delivering via IM. If the channel crashes mid-delivery, the lease
 *  expires and another channel can reclaim the turn. */
const TURN_DELIVERY_LEASE_SEC = 30;

export class Session {
  nickname: string;
  private rosterRecordId: string | null = null;

  constructor(
    public identity: string,
    nickname: string,
    private cfg: Config,
    private bitable: BitableClient,
  ) {
    this.nickname = nickname;
  }

  // -- config shortcuts ---------------------------------------------------

  private get tf(): import('./types.js').TicketFieldMapping {
    return this.cfg.fields.ticket;
  }

  private get nf(): import('./types.js').TurnFieldMapping {
    return this.cfg.fields.turn;
  }

  private get rf(): import('./types.js').RosterFieldMapping {
    return this.cfg.fields.roster;
  }

  private get sv(): import('./types.js').StatusMapping {
    return this.cfg.statuses;
  }

  /** Round field mapping getter. */
  private get rfRound(): import('./types.js').RoundFieldMapping {
    return this.cfg.fields.round;
  }

  /** Round status mapping getter. */
  private get rsv(): import('./types.js').RoundStatusMapping {
    return this.cfg.roundStatuses;
  }

  /** Validate a Round state transition against ROUND_TRANSITIONS. */
  private validateRoundTransition(current: string, next: string): boolean {
    // Map config status names → canonical names
    const rs = this.cfg.roundStatuses;
    const reverse = (v: string): string | null => {
      for (const [key, val] of Object.entries(rs)) {
        if (val === v) return key;
      }
      return null;
    };
    const curCanonical = reverse(current);
    const nextCanonical = reverse(next);
    if (!curCanonical || !nextCanonical) return false;
    const allowed = ROUND_TRANSITIONS[curCanonical];
    return allowed ? allowed.includes(nextCanonical) : false;
  }

  private log(...args: unknown[]): void {
    logger.info(`[session]`, ...args);
  }

  logToFile(msg: string): void {
    try {
      const dir = join(homedir(), '.bam', 'cache');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'subagent.log'), `[${new Date().toISOString()}] ${msg}\n`);
    } catch { /* ignore */ }
  }

  // -- roster -------------------------------------------------------------

  async register(): Promise<void> {
    const records = await this.bitable.searchRecords(this.cfg.rosterTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: this.rf.identity, operator: 'is', value: [this.identity] },
      ],
    });

    const nowMs = Date.now();

    const rosterFields: Record<string, unknown> = {
      [this.rf.nickname]: this.nickname,
      [this.rf.lastSeenAt]: nowMs,
    };
    // Write owner as Roster.human so turns can CC them
    if (this.cfg.ownerOpenId) {
      rosterFields[this.rf.human] = [{ id: this.cfg.ownerOpenId }];
    }

    if (records.length > 0) {
      const existing = records[0];
      this.rosterRecordId = existing.record_id;
      const storedNickname = extractText(existing.fields[this.rf.nickname]);
      if (storedNickname) this.nickname = storedNickname;
      this.log(`register: found identity=${this.identity} nickname=${this.nickname}`);

      await this.bitable.updateRecord(this.cfg.rosterTableId, this.rosterRecordId, rosterFields);
    } else {
      this.log(`register: new identity=${this.identity} nickname=${this.nickname}`);
      rosterFields[this.rf.identity] = this.identity;
      rosterFields[this.rf.kind] = 'agent';
      const executorDomains = this.cfg.executor?.domains?.length ? this.cfg.executor.domains : ['general'];
      rosterFields[this.rf.domains] = executorDomains;
      rosterFields[this.rf.enabled] = true;
      rosterFields[this.rf.metadata] = JSON.stringify({
        hostname: hostname(), user: process.env.USER ?? 'unknown', pid: process.pid,
      });
      rosterFields[this.rf.registeredAt] = nowMs;
      const record = await this.bitable.createRecord(this.cfg.rosterTableId, rosterFields);
      this.rosterRecordId = record.record_id;
    }
  }

  async heartbeat(): Promise<void> {
    if (!this.rosterRecordId) return;
    try {
      await this.bitable.updateRecord(this.cfg.rosterTableId, this.rosterRecordId, {
        [this.rf.lastSeenAt]: Date.now(),
      });
    } catch (err) {
      this.log('heartbeat error:', err);
    }
  }

  // -- ticket lifecycle ---------------------------------------------------

  /** Create a new ticket in draft status with IM metadata. */
  async createTicket(
    summary: string,
    im?: { rootMsgId: string; chatId: string; senderId: string },
  ): Promise<BitableRecord> {
    const fields: Record<string, unknown> = {
      [this.tf.status]: this.sv.draft,
      [this.tf.summary]: summary || '',
      [this.tf.keyfacts]: '{}',
      [this.tf.owner]: '',
      [this.tf.ownerLeaseAt]: 0,
      [this.tf.result]: '',
    };
    if (im) {
      fields[this.tf.rootMsgId] = im.rootMsgId;
      fields[this.tf.chatId] = im.chatId;
      fields[this.tf.senderId] = im.senderId;
    }
    return this.bitable.createRecord(this.cfg.ticketsTableId, fields);
  }

  /** Find draft tickets by sender (for multi-turn info gathering). */
  async searchDraftsBySender(senderId: string): Promise<BitableRecord[]> {
    return this.bitable.searchRecords(this.cfg.ticketsTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: this.tf.status, operator: 'is', value: [this.sv.draft] },
        { field_name: this.tf.senderId, operator: 'is', value: [senderId] },
      ],
    });
  }

  /** Search tickets by sender ID without status restriction (for /cancel etc.). */
  async searchTicketsBySender(senderId: string): Promise<BitableRecord[]> {
    return this.bitable.searchRecords(this.cfg.ticketsTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: this.tf.senderId, operator: 'is', value: [senderId] },
      ],
    });
  }

  /** Search for pending tickets (was: searchClaimable). Also finds orphan
   *  assigned tickets whose lease has expired (executor crashed after claim). */
  async searchPending(): Promise<BitableRecord[]> {
    // 1. Normal pending tickets
    const pending = await this.bitable.searchRecords(this.cfg.ticketsTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: this.tf.status, operator: 'is', value: [this.sv.active] },
      ],
    });

    // 2. Orphaned assigned tickets (executor crashed after claim, lease expired).
    //    We don't use operator:'less' here because owner_lease_at may be stored
    //    as a Text field in Bitable, which doesn't support comparison operators.
    //    Instead, filter in code.
    const assigned = await this.bitable.searchRecords(this.cfg.ticketsTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: this.tf.status, operator: 'is', value: [this.sv.active] },
      ],
    });
    const now = Date.now();
    const orphans = assigned.filter((r) => Number(r.fields[this.tf.ownerLeaseAt] ?? 0) < now);

    // Deduplicate by record_id
    const seen = new Set(pending.map(r => r.record_id));
    return [...pending, ...orphans.filter(r => !seen.has(r.record_id))];
  }

  /** Alias for backward compat — delegates to searchPending. */
  async searchClaimable(): Promise<BitableRecord[]> {
    return this.searchPending();
  }

  /** Promote a draft ticket to pending with summary. */
  async promoteToPending(
    recordId: string,
    summary: string,
  ): Promise<void> {
    await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
      [this.tf.status]: this.sv.active,
      [this.tf.summary]: summary,
    });
  }

  /** Find a ticket by its root IM message ID (for thread replies). */
  async findByThreadRoot(rootMsgId: string): Promise<BitableRecord | null> {
    const records = await this.bitable.searchRecords(this.cfg.ticketsTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: this.tf.rootMsgId, operator: 'is', value: [rootMsgId] },
      ],
    });
    return records.length > 0 ? records[0] : null;
  }

  /** Get a single ticket by record_id. */
  async getTicket(recordId: string): Promise<BitableRecord | null> {
    try {
      return await this.bitable.getRecord(this.cfg.ticketsTableId, recordId);
    } catch {
      return null;
    }
  }

  /** Set ticket status directly (used to revert pending_approval when no approvers). */
  async setTicketStatus(recordId: string, status: string): Promise<void> {
    await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
      [this.tf.status]: status,
    });
  }

  isClaimable(ticket: BitableRecord): boolean {
    const f = ticket.fields;
    const owner = String(f[this.tf.owner] ?? '');
    const leaseAt = Number(f[this.tf.ownerLeaseAt] ?? 0);
    return !owner || leaseAt < Date.now();
  }

  async claim(ticket: BitableRecord): Promise<boolean> {
    const recordId = ticket.record_id;
    const ownerValue = `${this.nickname}#${this.identity}`;
    const leaseMs = Date.now() + this.cfg.leaseDuration * 1000;

    try {
      await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
        [this.tf.owner]: ownerValue,
        [this.tf.ownerLeaseAt]: leaseMs,
        [this.tf.status]: this.sv.active,
      });
    } catch (err) {
      this.log(`claim write failed ticket=${recordId}:`, err);
      return false;
    }

    // Wait for Bitable eventual consistency, then verify
    await sleep(300);

    const updated = await this.bitable.getRecord(this.cfg.ticketsTableId, recordId);
    if (!updated) return false;

    const currentOwner = String(updated.fields[this.tf.owner] ?? '');
    if (!currentOwner.endsWith(`#${this.identity}`)) {
      this.log(`claim lost ticket=${recordId}: owner=${currentOwner}`);
      return false;
    }

    this.log(`claim success ticket=${recordId} as ${ownerValue}`);
    return true;
  }

  async release(ticketRecordId: string, status?: string): Promise<void> {
    const nextStatus = status ?? this.sv.active;

    // Owner guard: only release if we still hold the lease
    const rec = await this.bitable.getRecord(this.cfg.ticketsTableId, ticketRecordId);
    if (!rec) return;
    const currentOwner = String(rec.fields[this.tf.owner] ?? '');
    if (currentOwner && !currentOwner.endsWith(`#${this.identity}`)) {
      this.log(`release: owner changed, skip ticket=${ticketRecordId}`);
      return;
    }

    const update: Record<string, unknown> = {
      [this.tf.owner]: '',
      [this.tf.ownerLeaseAt]: 0,
      [this.tf.status]: nextStatus,
    };
    if (currentOwner) update[this.tf.lastOwner] = currentOwner;

    await this.bitable.updateRecord(this.cfg.ticketsTableId, ticketRecordId, update);
  }

  async finalize(
    ticketRecordId: string,
    payload: { newSummary?: string; newKeyfacts?: Record<string, string> },
  ): Promise<void> {
    // Owner guard
    const rec = await this.bitable.getRecord(this.cfg.ticketsTableId, ticketRecordId);
    if (!rec) return;
    const currentOwner = String(rec.fields[this.tf.owner] ?? '');
    if (currentOwner && !currentOwner.endsWith(`#${this.identity}`)) {
      this.log(`finalize: owner changed, skip ticket=${ticketRecordId}`);
      return;
    }

    // Re-fetch turns to check if new user messages arrived while processing
    const turns = await this.getTurns(ticketRecordId);
    const hasUnanswered = this.findUnansweredTurns(turns).length > 0;
    const nextStatus = hasUnanswered ? this.sv.active : this.sv.closed;

    const update: Record<string, unknown> = {
      [this.tf.owner]: '',
      [this.tf.ownerLeaseAt]: 0,
      [this.tf.status]: nextStatus,
    };
    if (currentOwner) update[this.tf.lastOwner] = currentOwner;
    if (payload.newSummary) update[this.tf.summary] = payload.newSummary;
    if (payload.newKeyfacts && Object.keys(payload.newKeyfacts).length > 0) update[this.tf.keyfacts] = JSON.stringify(payload.newKeyfacts);

    await this.bitable.updateRecord(this.cfg.ticketsTableId, ticketRecordId, update);
  }

  /** Write the Claude result and mark done. */
  async writeResult(
    recordId: string,
    result: string,
    summary?: string,
    owner?: string,
  ): Promise<void> {
    const update: Record<string, unknown> = {
      [this.tf.result]: result,
      [this.tf.owner]: '',
      [this.tf.ownerLeaseAt]: 0,
      [this.tf.status]: this.sv.closed,
    };
    if (summary) update[this.tf.summary] = summary;
    if (owner) update[this.tf.lastOwner] = owner;
    await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, update);
  }

  /** Mark a ticket as failed (executor error, unhandled, etc.). */
  async markFailed(recordId: string, _reason: string): Promise<void> {
    // Owner guard
    const rec = await this.bitable.getRecord(this.cfg.ticketsTableId, recordId);
    if (!rec) return;
    const currentOwner = String(rec.fields[this.tf.owner] ?? '');
    if (currentOwner && !currentOwner.endsWith(`#${this.identity}`)) {
      this.log(`markFailed: owner changed, skip ${recordId}`);
      return;
    }
    await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
      [this.tf.owner]: '',
      [this.tf.ownerLeaseAt]: 0,
      [this.tf.lastOwner]: currentOwner,
      [this.tf.status]: this.sv.closed,
    });
  }

  // ---------------------------------------------------------------------------
  // Human-in-the-loop: pre-execution approval
  // ---------------------------------------------------------------------------

  /** Look up a roster record by identity. */
  async getRosterByIdentity(identity: string): Promise<Record<string, unknown> | null> {
    const records = await this.bitable.searchRecords(this.cfg.rosterTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: this.rf.identity, operator: 'is', value: [identity] },
      ],
    });
    return records.length > 0 ? records[0].fields : null;
  }

  /** Release a ticket with retry tracking. If retry count < maxRetries, mark
   *  owner as RETRY:... so other executors can pick it up but this one won't
   *  reclaim it. If retries exhausted, mark as failed. */
  async releaseWithRetry(
    recordId: string,
    reasonKind: string,
    reasonText: string,
    rootMsgId?: string,
  ): Promise<void> {
    // Owner guard
    const rec = await this.bitable.getRecord(this.cfg.ticketsTableId, recordId);
    if (!rec) return;
    const currentOwner = String(rec.fields[this.tf.owner] ?? '');
    if (currentOwner && !currentOwner.endsWith(`#${this.identity}`)) {
      this.log(`releaseWithRetry: owner changed, skip ticket=${recordId}`);
      return;
    }

    const retryCount = Number(rec.fields[this.tf.retryCount] ?? 0);
    const nextRetryCount = retryCount + 1;
    const maxRetries = this.cfg.maxRetries ?? 3;

    if (nextRetryCount < maxRetries) {
      // Not yet exhausted — mark with RETRY owner prefix so other executors
      // can claim it, but this executor's self-filter will skip it.
      await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
        [this.tf.owner]: `${RETRY_OWNER_PREFIX}${this.nickname}#${this.identity}`,
        [this.tf.ownerLeaseAt]: 0,
        [this.tf.lastOwner]: currentOwner,
        [this.tf.status]: this.sv.active,
        [this.tf.retryCount]: nextRetryCount,
      });

      const text = formatMessage(this.cfg.messages?.retryFallback || 'Analysis could not be completed ({reason}), will auto-retry ({retryCount}/{maxRetries}).', {
        reason: reasonText,
        retryCount: String(nextRetryCount),
        maxRetries: String(maxRetries),
      });
      const dedupKey = `${recordId}_err_${reasonKind}`;
      await this.appendTurn(recordId, 'agent', text, dedupKey, this.identity, 'error', rootMsgId);
    } else {
      // Exhausted retries — mark as failed
      await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
        [this.tf.owner]: '',
        [this.tf.ownerLeaseAt]: 0,
        [this.tf.lastOwner]: currentOwner,
        [this.tf.status]: this.sv.closed,
        [this.tf.retryCount]: nextRetryCount,
      });

      const text = formatMessage(this.cfg.messages?.exhaustedFallback || 'Analysis could not be completed ({reason}), all retries exhausted. Reply to this message to reactivate the ticket.', { reason: reasonText });
      const dedupKey = `${recordId}_err_${reasonKind}_final`;
      await this.appendTurn(recordId, 'agent', text, dedupKey, this.identity, 'error', rootMsgId);
    }
  }

  /** Reset retry count (e.g. when user reactivates a failed ticket). */
  async resetRetryCount(recordId: string): Promise<void> {
    try {
      await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
        [this.tf.retryCount]: 0,
      });
    } catch (err) {
      this.log(`resetRetryCount failed ${recordId}:`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Round lifecycle (Round-driven state machine mode)
  // ---------------------------------------------------------------------------

  /** In-memory dedup for createRound: maps ticketRecordId → roundId.
   *  Protects against Bitable eventual consistency where a freshly created
   *  round is not yet visible to search queries, preventing the guard below
   *  from seeing it and allowing a duplicate. */
  private creatingRounds = new Map<string, string>();

  /** Create a new Round in pending status linked to a ticket.
   *  If the ticket already has an active (non-terminal) Round, returns the
   *  existing one instead of creating a duplicate. This prevents duplicate
   *  Round creation from Bitable event races regardless of the trigger path.
   *  @param abilities — required ability labels stored in Round.required_abilities */
  async createRound(ticketRecordId: string, domains?: string[]): Promise<BitableRecord> {
    // In-memory guard: check if we already started creating a round for this ticket.
    // Verifies via Bitable so a terminal round doesn't block a new one.
    const inFlight = this.creatingRounds.get(ticketRecordId);
    if (inFlight) {
      const existing = await this.getRound(inFlight);
      if (existing) {
        const status = String(existing.fields[this.rfRound.status] ?? '');
        const terminal = [this.rsv.done, this.rsv.failed, this.rsv.cancelled];
        if (!terminal.includes(status)) {
          this.log(`createRound: ticket ${ticketRecordId} already creating active round ${inFlight}, returning existing`);
          return existing;
        }
        // Round is terminal — let it create a new one
        this.creatingRounds.delete(ticketRecordId);
      }
    }

    // Bitable guard: check for existing active Round before creating a new one
    const currentRound = await this.getCurrentRound(ticketRecordId);
    if (currentRound?.record_id) {
      this.log(`createRound: ticket ${ticketRecordId} already has active round ${currentRound.record_id}, returning existing`);
      return currentRound;
    }

    const roundFields: Record<string, unknown> = {
      [this.rfRound.ticketRecordId]: ticketRecordId,
      [this.rfRound.status]: this.rsv.pending,
      [this.rfRound.executor]: '',
      [this.rfRound.reviewer]: [],
      [this.rfRound.reviewComment]: '',
      [this.rfRound.supplementPrompt]: '',
      [this.rfRound.result]: '',
    };
    if (domains && domains.length > 0) {
      roundFields[this.rfRound.domains] = JSON.stringify(domains);
    }
    const round = await this.bitable.createRecord(this.cfg.roundsTableId!, roundFields);
    // Register in in-memory dedup map for eventual-consistency resilience
    if (round.record_id) {
      this.creatingRounds.set(ticketRecordId, round.record_id);
      // Clear after 10s (well beyond Bitable search consistency window)
      setTimeout(() => {
        if (this.creatingRounds.get(ticketRecordId) === round.record_id) {
          this.creatingRounds.delete(ticketRecordId);
        }
      }, 10_000);
    }
    // Update ticket's lastRoundId to point to this Round
    try {
      await this.bitable.updateRecord(this.cfg.ticketsTableId, ticketRecordId, {
        [this.tf.lastRoundId]: round.record_id,
      });
    } catch (err) {
      this.log(`createRound: failed to update ticket.lastRoundId ${ticketRecordId}:`, err);
    }
    return round;
  }

  /** Fetch a single Round by record_id. */
  async getRound(roundId: string): Promise<BitableRecord | null> {
    try {
      return await this.bitable.getRecord(this.cfg.roundsTableId!, roundId);
    } catch {
      return null;
    }
  }

  /** Find the most recent non-terminal Round for a ticket. */
  async getCurrentRound(ticketRecordId: string): Promise<BitableRecord | null> {
    const all = await this.bitable.searchRecords(this.cfg.roundsTableId!, {
      conjunction: 'and',
      conditions: [
        { field_name: this.rfRound.ticketRecordId, operator: 'is', value: [ticketRecordId] },
      ],
    });
    // Filter out terminal states (done, failed, cancelled)
    const terminal = [this.rsv.done, this.rsv.failed, this.rsv.cancelled];
    const active = all.filter(r => !terminal.includes(String(r.fields[this.rfRound.status] ?? '')));
    // Return the most recently created active Round (last in array by default order)
    return active.length > 0 ? active[active.length - 1] : null;
  }

  /** Transition a Round to a new status with WSR optimistic concurrency.
   *  Validates the transition is allowed by ROUND_TRANSITIONS, writes the new
   *  status, then reads back to verify. Returns false if the transition was
   *  invalid or another process changed the status concurrently. */
  async transitionRound(roundId: string, newStatus: string): Promise<boolean> {
    const round = await this.getRound(roundId);
    if (!round) return false;
    const currentStatus = String(round.fields[this.rfRound.status] ?? '');
    if (!this.validateRoundTransition(currentStatus, newStatus)) {
      this.log(`transitionRound invalid: ${currentStatus} → ${newStatus} (round=${roundId})`);
      return false;
    }
    try {
      await this.bitable.updateRecord(this.cfg.roundsTableId!, roundId, {
        [this.rfRound.status]: newStatus,
      });
      await sleep(300);
      const updated = await this.getRound(roundId);
      if (!updated) return false;
      const actualStatus = String(updated.fields[this.rfRound.status] ?? '');
      return actualStatus === newStatus;
    } catch (err) {
      this.log(`transitionRound failed ${roundId}:`, err);
      return false;
    }
  }

  /** Claim a Round for execution (write executor + lease, verify).
   *  @param owner — optional explicit owner identity (default: this.nickname#this.identity) */
  async claimRound(round: BitableRecord, owner?: string): Promise<boolean> {
    const roundId = round.record_id;
    if (!roundId) return false;
    const ownerValue = owner || `${this.nickname}#${this.identity}`;
    const leaseMs = Date.now() + this.cfg.leaseDuration * 1000;
    try {
      await this.bitable.updateRecord(this.cfg.roundsTableId!, roundId, {
        [this.rfRound.executor]: ownerValue,
      });
    } catch (err) {
      this.log(`claimRound write failed round=${roundId}:`, err);
      return false;
    }
    await sleep(300);
    const updated = await this.getRound(roundId);
    if (!updated) return false;
    // Verify we still own it AND the round hasn't been claimed by another assign cycle
    const currentExecutor = String(updated.fields[this.rfRound.executor] ?? '');
    if (owner) {
      if (currentExecutor !== owner) {
        this.log(`claimRound lost round=${roundId}: executor=${currentExecutor}`);
        return false;
      }
    } else if (!currentExecutor.endsWith(`#${this.identity}`)) {
      this.log(`claimRound lost round=${roundId}: executor=${currentExecutor}`);
      return false;
    }
    // Verify the round is still in a claimable status (not already executing)
    const status = String(updated.fields[this.rfRound.status] ?? '');
    if (status !== this.rsv.pending && status !== this.rsv.approved) {
      this.log(`claimRound stale round=${roundId}: status=${status}`);
      return false;
    }
    this.log(`claimRound success round=${roundId} as ${ownerValue}`);
    return true;
  }

  /** Release a Round back to pending (clear executor). */
  async releaseRound(roundId: string): Promise<void> {
    try {
      await this.bitable.updateRecord(this.cfg.roundsTableId!, roundId, {
        [this.rfRound.executor]: '',
        [this.rfRound.status]: this.rsv.pending,
      });
    } catch (err) {
      this.log(`releaseRound failed ${roundId}:`, err);
    }
  }

  /** Search Rounds by status. */
  async searchRoundsByStatus(status: string): Promise<BitableRecord[]> {
    return this.bitable.searchRecords(this.cfg.roundsTableId!, {
      conjunction: 'and',
      conditions: [
        { field_name: this.rfRound.status, operator: 'is', value: [status] },
      ],
    });
  }

  /** Search Rounds by status with prefix-based ability matching.
   *  Reads `required_abilities` directly from the Round record — no Ticket lookup. */
  async searchRoundsByStatusAndDomains(status: string, domains: string[]): Promise<BitableRecord[]> {
    const rounds = await this.searchRoundsByStatus(status);
    if (domains.length === 0) return rounds;
    const { PrefixMatcher } = await import('./matcher.js');
    const matcher = new PrefixMatcher();
    return rounds.filter(r => {
      const raw = String(r.fields[this.rfRound.domains] ?? '');
      if (!raw) return true; // no requirement = match all
      try {
        const required: string[] = JSON.parse(raw);
        return matcher.matches(required, domains);
      } catch {
        return true;
      }
    });
  }

  /** Find stuck Rounds (executing status with expired lease). */
  async searchStuckRounds(timeoutMs: number): Promise<BitableRecord[]> {
    const executing = await this.bitable.searchRecords(this.cfg.roundsTableId!, {
      conjunction: 'and',
      conditions: [
        { field_name: this.rfRound.status, operator: 'is', value: [this.rsv.executing] },
      ],
    });
    const cutoff = Date.now() - timeoutMs;
    return executing.filter(r => {
      const updatedAt = Number(r.fields[this.rfRound.updatedAt] ?? 0);
      return updatedAt > 0 && updatedAt < cutoff;
    });
  }

  /** Write the processing result to a Round record. */
  async setRoundResult(roundId: string, result: string): Promise<void> {
    try {
      await this.bitable.updateRecord(this.cfg.roundsTableId!, roundId, {
        [this.rfRound.result]: result,
        [this.rfRound.updatedAt]: Date.now(),
      });
    } catch (err) {
      this.log(`setRoundResult failed ${roundId}:`, err);
    }
  }

  /** Write supplement prompt and reviewer to a Round (after approval). */
  async setRoundSupplement(roundId: string, prompt: string, reviewerOpenId?: string): Promise<void> {
    const update: Record<string, unknown> = {
      [this.rfRound.supplementPrompt]: prompt,
      [this.rfRound.updatedAt]: Date.now(),
    };
    if (reviewerOpenId) {
      update[this.rfRound.reviewer] = [{ id: reviewerOpenId }];
    }
    try {
      await this.bitable.updateRecord(this.cfg.roundsTableId!, roundId, update);
    } catch (err) {
      this.log(`setRoundSupplement failed ${roundId}:`, err);
    }
  }

  /** Get all Rounds for a ticket. */
  async getRoundsByTicket(ticketRecordId: string): Promise<BitableRecord[]> {
    return this.bitable.searchRecords(this.cfg.roundsTableId!, {
      conjunction: 'and',
      conditions: [
        { field_name: this.rfRound.ticketRecordId, operator: 'is', value: [ticketRecordId] },
      ],
    });
  }

  /** Find turns associated with a specific Round. */
  async getTurnsByRound(roundId: string): Promise<BitableRecord[]> {
    return this.bitable.searchRecords(this.cfg.turnsTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: this.nf.roundId, operator: 'is', value: [roundId] },
      ],
    });
  }

  /** Assign unowned Turns to a Round (set their roundId field). Returns count assigned. */
  async assignTurnsToRound(ticketRecordId: string, roundId: string): Promise<number> {
    const turns = await this.getTurns(ticketRecordId);
    let assigned = 0;
    for (const turn of turns) {
      const existingRoundId = String(turn.fields[this.nf.roundId] ?? '');
      if (!existingRoundId && turn.record_id) {
        try {
          await this.bitable.updateRecord(this.cfg.turnsTableId, turn.record_id, {
            [this.nf.roundId]: roundId,
          });
          assigned++;
        } catch { /* skip individual failures */ }
      }
    }
    return assigned;
  }

  /** Build a conversation prompt string from Turns belonging to a Round. */
  async buildConversation(round: BitableRecord): Promise<string> {
    const roundId = round.record_id;
    if (!roundId) return '';
    const turns = await this.getTurnsByRound(roundId);
    const supplementPrompt = String(round.fields[this.rfRound.supplementPrompt] ?? '');

    const lines: string[] = [];
    for (const turn of turns) {
      const role = String(turn.fields[this.nf.role] ?? '');
      const content = String(turn.fields[this.nf.content] ?? '');
      if (role && content) {
        lines.push(`[${role}]\n${content}`);
      }
    }

    let conversation = lines.join('\n\n---\n\n');
    if (supplementPrompt) {
      conversation += `\n\n[system supplement]\n${supplementPrompt}`;
    }
    return conversation;
  }

  /** Build a conversation prompt string from Turns belonging to a Round,
   *  using the A2A `parts` field when available and falling back to `content`
   *  for backward compatibility with unstructured messages. */
  async buildConversationWithParts(round: BitableRecord): Promise<string> {
    const roundId = round.record_id;
    if (!roundId) return '';
    const turns = await this.getTurnsByRound(roundId);
    const supplementPrompt = String(round.fields[this.rfRound.supplementPrompt] ?? '');

    const lines: string[] = [];
    for (const turn of turns) {
      const role = String(turn.fields[this.nf.role] ?? '');
      if (!role) continue;

      // Priority 1: parse structured `parts` field
      const partsRaw = extractText(turn.fields[this.nf.parts]);
      if (partsRaw) {
        try {
          const parts: Part[] = JSON.parse(partsRaw);
          const text = parts.map((p) => {
            switch (p.kind) {
              case 'text': return p.text;
              case 'file': return `[attachment: ${p.name ?? 'file'}](${p.file_uri})`;
              case 'data': return `[data: ${JSON.stringify(p.data)}]`;
              default: return '';
            }
          }).join('\n');
          if (text) lines.push(`[${role}]\n${text}`);
          continue;
        } catch {
          // Malformed parts JSON — fall through to content
        }
      }

      // Priority 2: fall back to legacy `content` field
      const content = String(turn.fields[this.nf.content] ?? '');
      if (content) lines.push(`[${role}]\n${content}`);
    }

    let conversation = lines.join('\n\n---\n\n');
    if (supplementPrompt) {
      conversation += `\n\n[system supplement]\n${supplementPrompt}`;
    }
    return conversation;
  }

  /** Find turns ready for IM delivery. */
  async searchNotifiableTurns(): Promise<BitableRecord[]> {
    // Search each turn_status value separately — Text fields only support
    // single-value 'is'. SingleSelect fields support multi-value, which
    // allows collapsing into one call once the field is migrated.
    //
    // The deliveryLeaseAt < now filter prevents finding turns that another
    // Channel process just claimed but hasn't yet marked notified=1. Without
    // this guard, a second Channel could find the turn (notified still 0 due
    // to Bitable eventual consistency), race the claim, and both win the
    // TOCTOU check — producing duplicate IM messages.
    //
    // Approved turns skip the deliveryLeaseAt check because they've already
    // been reviewed — no claim racing concern.
    const dedup = new Map<string, BitableRecord>();

    const searchWithLease = async (status: string) => {
      return this.bitable.searchRecords(this.cfg.turnsTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.nf.status, operator: 'is', value: [status] },
          { field_name: this.nf.notified, operator: 'is', value: [0] },
          { field_name: this.nf.deliveryLeaseAt, operator: 'isLess', value: [Date.now()] },
        ],
      });
    };

    const searchWithoutLease = async (status: string) => {
      return this.bitable.searchRecords(this.cfg.turnsTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.nf.status, operator: 'is', value: [status] },
          { field_name: this.nf.notified, operator: 'is', value: [0] },
        ],
      });
    };

    for (const status of ['processing', 'answered', 'error']) {
      let batch: BitableRecord[];
      try {
        batch = await searchWithLease(status);
      } catch {
        // The deliveryLeaseAt field or less operator may not be supported
        // in the user's Bitable schema. Fall back to basic search.
        console.log(`[protocol] searchNotifiableTurns: lease query failed for "${status}", falling back`);
        try {
          batch = await searchWithoutLease(status);
        } catch {
          continue;
        }
      }
      for (const rec of batch) {
        if (rec.record_id) dedup.set(rec.record_id, rec);
      }
    }

    // Separately search for approved turns (no deliveryLeaseAt needed)
    try {
      const approved = await this.bitable.searchRecords(this.cfg.turnsTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.nf.status, operator: 'is', value: ['approved'] },
          { field_name: this.nf.notified, operator: 'is', value: [0] },
        ],
      });
      for (const rec of approved) {
        if (rec.record_id) dedup.set(rec.record_id, rec);
      }
    } catch { /* skip */ }

    return [...dedup.values()];
  }

  /** Mark a turn as delivered via IM. */
  async markTurnNotified(turnRecordId: string): Promise<void> {
    await this.bitable.updateRecord(this.cfg.turnsTableId, turnRecordId, {
      [this.nf.notified]: 1,
    });
  }

  /**
   * Claim a turn for delivery (write-then-verify).
   *
   * Multiple Channel processes can race for the same turn. This method uses
   * the same soft-preemption pattern as ticket claiming: write deliveryOwner
   * + deliveryLeaseAt, wait for eventual consistency, then read back. Only
   * the process whose identity survives convergence should proceed with
   * IM delivery.
   *
   * NOTE: This does NOT set notified=1. Only call markTurnNotified() AFTER
   * the IM message is successfully sent. If we lose the claim and return
   * false, the turn remains notifiable — another Channel can claim it.
   *
   * Returns true if this process won the claim and should proceed with delivery.
   */
  async claimTurnDelivery(turnRecordId: string): Promise<boolean> {
    const ownerValue = `${this.nickname}#${this.identity}`;
    const leaseMs = Date.now() + TURN_DELIVERY_LEASE_SEC * 1000;
    try {
      await this.bitable.updateRecord(this.cfg.turnsTableId, turnRecordId, {
        [this.nf.deliveryOwner]: ownerValue,
        [this.nf.deliveryLeaseAt]: leaseMs,
      });
    } catch (err) {
      this.log(`claimTurnDelivery write failed turn=${turnRecordId}:`, err);
      return false;
    }

    await sleep(300);

    const record = await this.bitable.getRecord(this.cfg.turnsTableId, turnRecordId);
    if (!record) return false;

    const currentOwner = String(record.fields[this.nf.deliveryOwner] ?? '');
    if (currentOwner !== ownerValue) {
      this.log(`claimTurnDelivery lost turn=${turnRecordId}: owner=${currentOwner}`);
      return false;
    }

    this.log(`claimTurnDelivery won turn=${turnRecordId}`);
    return true;
  }

  /** Find turns with a specific status for a ticket. */
  async getTurnsByStatus(ticketRecordId: string, status: string): Promise<BitableRecord[]> {
    return this.bitable.searchRecords(this.cfg.turnsTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: this.nf.ticketRecordId, operator: 'is', value: [ticketRecordId] },
        { field_name: this.nf.status, operator: 'is', value: [status] },
      ],
    });
  }

  // -- turns --------------------------------------------------------------

  async getTurns(ticketRecordId: string): Promise<BitableRecord[]> {
    return this.bitable.searchRecords(this.cfg.turnsTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: this.nf.ticketRecordId, operator: 'is', value: [ticketRecordId] },
      ],
    });
  }

  async appendTurn(
    ticketRecordId: string,
    role: string,
    content: string,
    dedupKey?: string,
    agentIdentity?: string,
    turnStatus?: string,
    rootMsgId?: string,
    roundId?: string,
    parts?: Part[],
    notified?: number,
  ): Promise<string | null> {
    // Dedup check
    if (dedupKey) {
      const existing = await this.bitable.searchRecords(this.cfg.turnsTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.nf.dedupKey, operator: 'is', value: [dedupKey] },
        ],
      });
      if (existing.length > 0) return existing[0].record_id;
    }

    const resolvedAgentIdentity = agentIdentity ?? this.identity;
    let human: unknown;
    if (role === 'agent') {
      try {
        const roster = await this.getRosterByIdentity(resolvedAgentIdentity);
        human = roster?.[this.rf.human];
      } catch {
        human = undefined;
      }
    }

    const fields: Record<string, unknown> = {
      [this.nf.ticketRecordId]: ticketRecordId,
      [this.nf.role]: role,
      [this.nf.content]: content,
      [this.nf.dedupKey]: dedupKey ?? '',
      [this.nf.agentIdentity]: resolvedAgentIdentity,
      [this.nf.notified]: notified ?? 0,
      [this.nf.deliveryLeaseAt]: 0,
    };
    if (human) fields[this.nf.human] = human;
    if (rootMsgId) fields[this.nf.rootMsgId] = rootMsgId;
    if (turnStatus) fields[this.nf.status] = turnStatus;
    if (roundId) fields[this.nf.roundId] = roundId;
    if (parts && parts.length > 0) fields[this.nf.parts] = JSON.stringify(parts);

    const record = await this.bitable.createRecord(this.cfg.turnsTableId, fields);
    return record.record_id;
  }

  async writeErrorTurn(
    ticketRecordId: string,
    reasonKind: string,
    reasonText: string,
    rootMsgId?: string,
  ): Promise<void> {
    const text = formatMessage(this.cfg.messages?.errorFallback || 'Analysis could not be completed ({reason}), handing off to human; ticket re-queued, another online agent may pick it up.', { reason: reasonText });
    const dedupKey = `${ticketRecordId}_err_${reasonKind}`;
    try {
      await this.appendTurn(ticketRecordId, 'agent', text, dedupKey, this.identity, 'error', rootMsgId);
    } catch (err) {
      this.log(`writeErrorTurn failed ticket=${ticketRecordId}:`, err);
    }
  }

  // -- helpers for ack / turn analysis ------------------------------------

  findUnansweredTurns(turns: BitableRecord[]): BitableRecord[] {
    let lastAgentIdx = -1;
    for (let i = 0; i < turns.length; i++) {
      if (String(turns[i].fields[this.nf.role] ?? '') === 'agent') {
        lastAgentIdx = i;
      }
    }
    return turns.filter((t, i) => {
      if (i <= lastAgentIdx) return false;
      return String(t.fields[this.nf.role] ?? '') === 'user';
    });
  }

  buildAckText(unanswered: BitableRecord[]): string {
    const latestText = unanswered.length > 0
      ? String(unanswered[unanswered.length - 1].fields[this.nf.content] ?? '')
      : '';

    const hints: string[] = [];
    for (const m of latestText.matchAll(/\bAID[：:\s]+(\d+)/gi)) {
      hints.push(`AID=${m[1]}`);
    }
    for (const m of latestText.matchAll(/\bPID[：:\s]+(\d+)/gi)) {
      hints.push(`PID=${m[1]}`);
    }
    for (const m of latestText.matchAll(/\b(?:order[_\s]?id|订单)[：:\s]+(\w+)/gi)) {
      hints.push(`order_id=${m[1]}`);
    }
    for (const m of latestText.matchAll(/\btrace[_\s]?id[：:\s]+(\w+)/gi)) {
      hints.push(`trace_id=${m[1]}`);
    }

    const ackHints = hints.length > 0 ? ': ' + hints.join(', ') : ' your issue';
    return formatMessage(this.cfg.messages?.ackTemplate || 'Received, checking{ackHints}. Will reply shortly. ({nickname})', {
      ackHints,
      nickname: this.nickname,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
