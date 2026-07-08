// ---------------------------------------------------------------------------
// WorkerSessionAdapter — implements SessionAdapter using WorkerBitableAdapter
// and a Config-compatible object, without @larksuiteoapi/node-sdk.
// ---------------------------------------------------------------------------

import { ROUND_TRANSITIONS } from '../../lib/types.js';
import type { Config, BitableRecord } from '../../lib/types.js';
import type {
  SessionAdapter, TicketRecord, TurnRecord, RoundRecord, RosterRecord,
} from '../../core/types.js';
import type { WorkerBitableAdapter } from './adapters/bitable.js';

// Helper: config field accessors to match Session's pattern
function tf(cfg: Config) { return cfg.fields.ticket; }
function nf(cfg: Config) { return cfg.fields.turn; }
function rfRound(cfg: Config) { return cfg.fields.round; }
function rsv(cfg: Config) { return cfg.roundStatuses; }
function sv(cfg: Config) { return cfg.statuses; }

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Validate a Round state transition against ROUND_TRANSITIONS. */
function validateRoundTransition(cfg: Config, current: string, next: string): boolean {
  const reverse = (v: string): string | null => {
    for (const [key, val] of Object.entries(rsv(cfg))) {
      if (val === v) return key;
    }
    return null;
  };
  const curCanonical = reverse(current);
  const nextCanonical = reverse(next);
  if (!curCanonical || !nextCanonical) return false;
  const allowed = ROUND_TRANSITIONS[curCanonical];
  return allowed.includes(nextCanonical);
}

export class WorkerSessionAdapter implements SessionAdapter {
  constructor(
    private bitable: WorkerBitableAdapter,
    private cfg: Config,
  ) {}

  async getTicket(ticketId: string): Promise<TicketRecord | null> {
    return this.bitable.getRecord(this.cfg.ticketsTableId, ticketId);
  }

  async getTurns(ticketId: string): Promise<TurnRecord[]> {
    const records = await this.bitable.searchRecords(this.cfg.turnsTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: nf(this.cfg).ticketRecordId, operator: 'is', value: [ticketId] },
      ],
    });
    return records;
  }

  async getRound(roundId: string): Promise<RoundRecord | null> {
    if (!this.cfg.roundsTableId) return null;
    try {
      return await this.bitable.getRecord(this.cfg.roundsTableId, roundId);
    } catch {
      return null;
    }
  }

  async getCurrentRound(ticketId: string): Promise<RoundRecord | null> {
    if (!this.cfg.roundsTableId) return null;
    const all = await this.bitable.searchRecords(this.cfg.roundsTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: rfRound(this.cfg).ticketRecordId, operator: 'is', value: [ticketId] },
      ],
    });
    const terminal = [rsv(this.cfg).done, rsv(this.cfg).failed, rsv(this.cfg).cancelled];
    const active = all.filter(r =>
      !terminal.includes(String(r.fields[rfRound(this.cfg).status] ?? '')),
    );
    return active.length > 0 ? active[active.length - 1] : null;
  }

  async claimRound(round: RoundRecord, identity: string): Promise<boolean> {
    const roundId = round.record_id;
    if (!roundId || !this.cfg.roundsTableId) return false;
    try {
      await this.bitable.updateRecord(this.cfg.roundsTableId, roundId, {
        [rfRound(this.cfg).executor]: identity,
      });
    } catch {
      return false;
    }
    await sleep(300);
    const updated = await this.getRound(roundId);
    if (!updated) return false;
    const currentExecutor = String(updated.fields[rfRound(this.cfg).executor] ?? '');
    return currentExecutor === identity;
  }

  async releaseRound(roundId: string): Promise<void> {
    if (!this.cfg.roundsTableId) return;
    try {
      await this.bitable.updateRecord(this.cfg.roundsTableId, roundId, {
        [rfRound(this.cfg).executor]: '',
        [rfRound(this.cfg).status]: rsv(this.cfg).pending,
      });
    } catch { /* best effort */ }
  }

  async claim(ticket: TicketRecord): Promise<boolean> {
    const recordId = ticket.record_id;
    if (!recordId) return false;
    try {
      await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
        [tf(this.cfg).owner]: 'worker-channel',
      });
      await sleep(300);
      const updated = await this.getTicket(recordId);
      if (!updated) return false;
      return String(updated.fields[tf(this.cfg).owner] ?? '') === 'worker-channel';
    } catch {
      return false;
    }
  }

  async release(ticketId: string, newStatus?: string): Promise<void> {
    try {
      const fields: Record<string, unknown> = {};
      if (newStatus) fields[tf(this.cfg).status] = newStatus;
      await this.bitable.updateRecord(this.cfg.ticketsTableId, ticketId, fields);
    } catch { /* best effort */ }
  }

  async transitionRound(roundId: string, newStatus: string): Promise<boolean> {
    if (!this.cfg.roundsTableId) return false;
    const round = await this.getRound(roundId);
    if (!round) return false;
    const currentStatus = String(round.fields[rfRound(this.cfg).status] ?? '');
    if (!validateRoundTransition(this.cfg, currentStatus, newStatus)) return false;
    try {
      await this.bitable.updateRecord(this.cfg.roundsTableId, roundId, {
        [rfRound(this.cfg).status]: newStatus,
      });
      await sleep(300);
      const updated = await this.getRound(roundId);
      if (!updated) return false;
      return String(updated.fields[rfRound(this.cfg).status] ?? '') === newStatus;
    } catch {
      return false;
    }
  }

  async setRoundResult(roundId: string, result: string): Promise<void> {
    if (!this.cfg.roundsTableId) return;
    try {
      await this.bitable.updateRecord(this.cfg.roundsTableId, roundId, {
        [rfRound(this.cfg).result]: result,
        [rfRound(this.cfg).updatedAt]: Date.now(),
      });
    } catch { /* best effort */ }
  }

  async appendTurn(
    ticketId: string, role: string, content: string, dedupKey: string,
    agentIdentity: string, status: string, rootMsgId?: string,
    roundId?: string, parts?: unknown[], notified?: number, appId?: string,
  ): Promise<string | undefined> {
    // Dedup check
    if (dedupKey) {
      const existing = await this.bitable.searchRecords(this.cfg.turnsTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: nf(this.cfg).dedupKey, operator: 'is', value: [dedupKey] },
        ],
      });
      if (existing.length > 0) return existing[0].record_id;
    }

    const fields: Record<string, unknown> = {
      [nf(this.cfg).ticketRecordId]: ticketId,
      [nf(this.cfg).role]: role,
      [nf(this.cfg).content]: content,
      [nf(this.cfg).dedupKey]: dedupKey || '',
      [nf(this.cfg).agentIdentity]: agentIdentity,
      [nf(this.cfg).notified]: notified ?? 0,
    };
    if (rootMsgId) fields[nf(this.cfg).rootMsgId] = rootMsgId;
    if (status) fields[nf(this.cfg).status] = status;
    if (roundId) fields[nf(this.cfg).roundId] = roundId;
    if (parts && parts.length > 0) fields[nf(this.cfg).parts] = JSON.stringify(parts);
    if (appId) fields[nf(this.cfg).appId] = appId;

    const record = await this.bitable.createRecord(this.cfg.turnsTableId, fields);
    return record.record_id;
  }

  async writeResult(ticketId: string, answer: string, newSummary?: string): Promise<void> {
    try {
      const fields: Record<string, unknown> = {
        [tf(this.cfg).result]: answer,
        [tf(this.cfg).status]: sv(this.cfg).closed,
      };
      if (newSummary) fields[tf(this.cfg).summary] = newSummary;
      await this.bitable.updateRecord(this.cfg.ticketsTableId, ticketId, fields);
    } catch { /* best effort */ }
  }

  async searchRoundsByStatus(status: string): Promise<RoundRecord[]> {
    if (!this.cfg.roundsTableId) return [];
    return this.bitable.searchRecords(this.cfg.roundsTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: rfRound(this.cfg).status, operator: 'is', value: [status] },
      ],
    });
  }

  async searchStuckRounds(stuckTimeoutMs: number): Promise<RoundRecord[]> {
    if (!this.cfg.roundsTableId) return [];
    const executing = await this.bitable.searchRecords(this.cfg.roundsTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: rfRound(this.cfg).status, operator: 'is', value: [rsv(this.cfg).executing] },
      ],
    });
    const cutoff = Date.now() - stuckTimeoutMs;
    return executing.filter(r => {
      const updatedAt = Number(r.fields[rfRound(this.cfg).updatedAt] ?? 0);
      return updatedAt > 0 && updatedAt < cutoff;
    });
  }

  async searchRoster(filter: {
    conjunction: string;
    conditions: Array<{ field_name: string; operator: string; value: unknown[] }>;
  }): Promise<RosterRecord[]> {
    return this.bitable.searchRecords(this.cfg.rosterTableId, filter);
  }

  async getRosterByIdentity(identity: string): Promise<Record<string, unknown> | null> {
    const records = await this.bitable.searchRecords(this.cfg.rosterTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: this.cfg.fields.roster.identity, operator: 'is', value: [identity] },
      ],
    });
    return records.length > 0 ? records[0].fields : null;
  }

  async registerRoster(identity: string, fields: Record<string, unknown>): Promise<void> {
    const recordFields = {
      [this.cfg.fields.roster.identity]: identity,
      ...fields,
      [this.cfg.fields.roster.kind]: fields.kind || 'agent',
      [this.cfg.fields.roster.enabled]: fields.enabled ?? true,
    };
    await this.bitable.createRecord(this.cfg.rosterTableId, recordFields);
  }
}
