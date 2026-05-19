import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, homedir } from 'node:os';
import { Config, BitableRecord } from './types.js';
import { BitableClient } from './bitable.js';
import { logger } from './log.js';
import { formatMessage } from './messages.js';

// Feishu Multiline text fields store values as { text, type } objects.
// Normalise to a plain string for internal use.
export function extractText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((e) => extractText(e)).join('');
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
  }
  return String(v ?? '');
}

/**
 * Extract user open_ids from a Feishu Person field (type 11) or Lookup
 * field wrapping a Person field.
 *
 * Person field value:        [{ id: "ou_xxx", name: "...", ... }]
 * Lookup wrapping Person:    { type: 11, value: [{ id: "ou_xxx", name: "...", ... }] }
 *
 * Returns comma-separated open_ids, or empty string.
 */
export function extractUserIds(v: unknown): string {
  if (!v) return '';

  // Lookup field wrapping a Person value
  if (typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if (obj.type === 11 && Array.isArray(obj.value)) {
      return extractUserIds(obj.value);
    }
    return '';
  }

  // Direct Person field value (array of user objects)
  if (Array.isArray(v)) {
    return v
      .map((item: any) => (typeof item?.id === 'string' ? item.id : ''))
      .filter(Boolean)
      .join(',');
  }

  return '';
}

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

  private log(...args: unknown[]): void {
    logger.info(`[session]`, ...args);
  }

  logToFile(msg: string): void {
    try {
      const dir = join(homedir(), '.cache', 'bitable-mesh');
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
      const roles = this.cfg.executor?.roles?.length ? this.cfg.executor.roles : ['general'];
      rosterFields[this.rf.roles] = roles;
      rosterFields[this.rf.enabled] = true;
      rosterFields[this.rf.hostname] = hostname();
      rosterFields[this.rf.user] = process.env.USER ?? 'unknown';
      rosterFields[this.rf.pid] = String(process.pid);
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

  /** Search for pending tickets (was: searchClaimable). Also finds orphan
   *  assigned tickets whose lease has expired (executor crashed after claim). */
  async searchPending(): Promise<BitableRecord[]> {
    // 1. Normal pending tickets
    const pending = await this.bitable.searchRecords(this.cfg.ticketsTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: this.tf.status, operator: 'is', value: [this.sv.pending] },
      ],
    });

    // 2. Orphaned assigned tickets (executor crashed after claim, lease expired).
    //    We don't use operator:'less' here because owner_lease_at may be stored
    //    as a Text field in Bitable, which doesn't support comparison operators.
    //    Instead, filter in code.
    const assigned = await this.bitable.searchRecords(this.cfg.ticketsTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: this.tf.status, operator: 'is', value: [this.sv.assigned] },
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

  /** Promote a draft ticket to pending with summary and capabilities. */
  async promoteToPending(
    recordId: string,
    summary: string,
    capabilities?: string[],
  ): Promise<void> {
    const update: Record<string, unknown> = {
      [this.tf.status]: this.sv.pending,
      [this.tf.summary]: summary,
    };
    if (capabilities && capabilities.length > 0) {
      update[this.tf.forRoles] = capabilities; // MultiSelect: array directly
    }
    await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, update);
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
        [this.tf.status]: this.sv.assigned,
      });
    } catch (err) {
      this.log(`claim write failed ticket=${recordId.slice(0, 12)}:`, err);
      return false;
    }

    // Wait for Bitable eventual consistency, then verify
    await sleep(300);

    const updated = await this.bitable.getRecord(this.cfg.ticketsTableId, recordId);
    if (!updated) return false;

    const currentOwner = String(updated.fields[this.tf.owner] ?? '');
    if (!currentOwner.endsWith(`#${this.identity}`)) {
      this.log(`claim lost ticket=${recordId.slice(0, 12)}: owner=${currentOwner}`);
      return false;
    }

    this.log(`claim success ticket=${recordId.slice(0, 12)} as ${ownerValue}`);
    return true;
  }

  async release(ticketRecordId: string, status?: string, opts?: {
    forRoles?: string[];
    forKind?: string;
  }): Promise<void> {
    const nextStatus = status ?? this.sv.pending;

    // Owner guard: only release if we still hold the lease
    const rec = await this.bitable.getRecord(this.cfg.ticketsTableId, ticketRecordId);
    if (!rec) return;
    const currentOwner = String(rec.fields[this.tf.owner] ?? '');
    if (currentOwner && !currentOwner.endsWith(`#${this.identity}`)) {
      this.log(`release: owner changed, skip ticket=${ticketRecordId.slice(0, 12)}`);
      return;
    }

    const update: Record<string, unknown> = {
      [this.tf.owner]: '',
      [this.tf.ownerLeaseAt]: 0,
      [this.tf.status]: nextStatus,
    };
    if (currentOwner) update[this.tf.lastOwner] = currentOwner;
    if (opts?.forRoles?.length) update[this.tf.forRoles] = opts.forRoles; // MultiSelect: array directly
    if (opts?.forKind) update[this.tf.forKind] = opts.forKind;

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
      this.log(`finalize: owner changed, skip ticket=${ticketRecordId.slice(0, 12)}`);
      return;
    }

    // Re-fetch turns to check if new user messages arrived while processing
    const turns = await this.getTurns(ticketRecordId);
    const hasUnanswered = this.findUnansweredTurns(turns).length > 0;
    const nextStatus = hasUnanswered ? this.sv.pending : this.sv.done;

    const update: Record<string, unknown> = {
      [this.tf.owner]: '',
      [this.tf.ownerLeaseAt]: 0,
      [this.tf.status]: nextStatus,
    };
    if (currentOwner) update[this.tf.lastOwner] = currentOwner;
    if (payload.newSummary) update[this.tf.summary] = payload.newSummary;
    if (payload.newKeyfacts) update[this.tf.keyfacts] = JSON.stringify(payload.newKeyfacts);

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
      [this.tf.status]: this.sv.done,
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
      this.log(`markFailed: owner changed, skip ${recordId.slice(0, 12)}`);
      return;
    }
    await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
      [this.tf.owner]: '',
      [this.tf.ownerLeaseAt]: 0,
      [this.tf.lastOwner]: currentOwner,
      [this.tf.status]: this.sv.failed,
    });
  }

  // ---------------------------------------------------------------------------
  // Human-in-the-loop: pre-execution approval
  // ---------------------------------------------------------------------------

  /** Set ticket status to pending_approval (keep owner/lease for polling).
   *  Also copies approvers from the Roster record's human field to the ticket. */
  async setPendingApproval(recordId: string): Promise<void> {
    // Owner guard
    const rec = await this.bitable.getRecord(this.cfg.ticketsTableId, recordId);
    if (!rec) return;
    const currentOwner = String(rec.fields[this.tf.owner] ?? '');
    if (currentOwner && !currentOwner.endsWith(`#${this.identity}`)) {
      this.log(`setPendingApproval: owner changed, skip ${recordId.slice(0, 12)}`);
      return;
    }

    // Look up approvers from this executor's Roster record
    const rosterRec = await this.bitable.searchRecords(this.cfg.rosterTableId, {
      conjunction: 'and',
      conditions: [{ field_name: this.rf.identity, operator: 'is', value: [this.identity] }],
    });

    const update: Record<string, unknown> = {
      [this.tf.status]: this.sv.pendingApproval,
    };
    if (rosterRec.length > 0) {
      const human = rosterRec[0].fields[this.rf.human];
      if (human) update[this.tf.approvers] = human;
    }

    await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, update);
  }

  /** Poll ticket.status for approval result. Returns when status changes
   *  from pending_approval, or when timeoutMs elapses. */
  async pollApproval(
    recordId: string,
    timeoutMs: number,
  ): Promise<'approved' | 'rejected' | 'timeout'> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ticket = await this.bitable.getRecord(this.cfg.ticketsTableId, recordId);
      if (!ticket) return 'rejected';
      const status = String(ticket.fields[this.tf.status] ?? '');
      if (status === this.sv.pendingApproval) {
        await sleep(5000);
        continue;
      }
      // Status changed from pending_approval
      if (status === this.sv.assigned) return 'approved';
      if (status === this.sv.done) return 'approved';
      return 'rejected';
    }
    return 'timeout';
  }

  // ---------------------------------------------------------------------------
  // Human-in-the-loop: post-answer review
  // ---------------------------------------------------------------------------

  /** Poll the pending_review turn for review result. Looks for the specific
   *  turn that was written as pending_review, then watches its status change. */
  async pollReview(
    ticketRecordId: string,
    timeoutMs: number,
  ): Promise<'approved' | 'rejected' | 'timeout'> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const turns = await this.getTurns(ticketRecordId);
      // Find the turn that was originally written as pending_review
      const reviewTurn = [...turns].reverse().find((t) =>
        String(t.fields[this.nf.role] ?? '') === 'agent' &&
        String(t.fields[this.nf.status] ?? '') !== 'processing',
      );
      if (reviewTurn) {
        const status = String(reviewTurn.fields[this.nf.status] ?? '');
        if (status === 'approved') return 'approved';
        if (status === 'rejected') return 'rejected';
        if (status === 'answered') return 'approved'; // skip-mode fallback
      }
      await sleep(5000);
    }
    return 'timeout';
  }

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
      this.log(`releaseWithRetry: owner changed, skip ticket=${recordId.slice(0, 12)}`);
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
        [this.tf.status]: this.sv.pending,
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
        [this.tf.status]: this.sv.failed,
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
      this.log(`resetRetryCount failed ${recordId.slice(0, 12)}:`, err);
    }
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
      this.log(`claimTurnDelivery write failed turn=${turnRecordId.slice(0, 12)}:`, err);
      return false;
    }

    await sleep(300);

    const record = await this.bitable.getRecord(this.cfg.turnsTableId, turnRecordId);
    if (!record) return false;

    const currentOwner = String(record.fields[this.nf.deliveryOwner] ?? '');
    if (currentOwner !== ownerValue) {
      this.log(`claimTurnDelivery lost turn=${turnRecordId.slice(0, 12)}: owner=${currentOwner}`);
      return false;
    }

    this.log(`claimTurnDelivery won turn=${turnRecordId.slice(0, 12)} as ${ownerValue}`);
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
      [this.nf.notified]: 0,
      [this.nf.deliveryLeaseAt]: 0,
    };
    if (human) fields[this.nf.human] = human;
    if (rootMsgId) fields[this.nf.rootMsgId] = rootMsgId;
    if (turnStatus) fields[this.nf.status] = turnStatus;

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
      this.log(`writeErrorTurn failed ticket=${ticketRecordId.slice(0, 12)}:`, err);
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
