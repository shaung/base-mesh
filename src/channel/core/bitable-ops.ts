// ---------------------------------------------------------------------------
// Bitable operations — deployment-agnostic business logic on top of
// BitableAdapter. All SessionAdapter functionality consolidated here.
//
// Each function takes (bitable, cfg, ...args) — no deployment-specific
// abstractions needed. Both Node SDK and Worker fetch paths share this code.
// ---------------------------------------------------------------------------

import type { BitableAdapter, TicketRecord, TurnRecord, RoundRecord, RosterRecord } from './types.js';
import type { Config } from '../../lib/types.js';
import { ROUND_TRANSITIONS } from '../../lib/types.js';

// ---- Helpers ---------------------------------------------------------------

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function tf(cfg: Config) { return cfg.fields.ticket; }
function nf(cfg: Config) { return cfg.fields.turn; }
function rf(cfg: Config) { return cfg.fields.round; }
function rsv(cfg: Config) { return cfg.roundStatuses; }

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

// ---- Tickets ---------------------------------------------------------------

export async function getTicket(bitable: BitableAdapter, cfg: Config, ticketId: string): Promise<TicketRecord | null> {
  return bitable.getRecord(cfg.ticketsTableId, ticketId);
}

export async function claimTicket(bitable: BitableAdapter, cfg: Config, ticket: TicketRecord, identity = 'channel'): Promise<boolean> {
  const recordId = ticket.record_id;
  if (!recordId) return false;
  try {
    await bitable.updateRecord(cfg.ticketsTableId, recordId, {
      [tf(cfg).owner]: identity,
    });
    await sleep(300);
    const updated = await getTicket(bitable, cfg, recordId);
    if (!updated) return false;
    return String(updated.fields[tf(cfg).owner] ?? '') === identity;
  } catch {
    return false;
  }
}

export async function releaseTicket(bitable: BitableAdapter, cfg: Config, ticketId: string, newStatus?: string): Promise<void> {
  try {
    const fields: Record<string, unknown> = {};
    if (newStatus) fields[tf(cfg).status] = newStatus;
    await bitable.updateRecord(cfg.ticketsTableId, ticketId, fields);
  } catch { /* best effort */ }
}

export async function writeTicketResult(bitable: BitableAdapter, cfg: Config, ticketId: string, answer: string, newSummary?: string): Promise<void> {
  try {
    const fields: Record<string, unknown> = {
      [tf(cfg).result]: answer,
      [tf(cfg).status]: cfg.statuses.closed,
    };
    if (newSummary) fields[tf(cfg).summary] = newSummary;
    await bitable.updateRecord(cfg.ticketsTableId, ticketId, fields);
  } catch { /* best effort */ }
}

export async function searchTicketsBySender(bitable: BitableAdapter, cfg: Config, senderId: string): Promise<TicketRecord[]> {
  return bitable.searchRecords(cfg.ticketsTableId, {
    conjunction: 'and',
    conditions: [
      { field_name: tf(cfg).senderId, operator: 'is', value: [senderId] },
    ],
  });
}

/** Check if a ticket is claimable (lease not expired, not already claimed by another). */
export async function isTicketClaimable(bitable: BitableAdapter, cfg: Config, ticket: TicketRecord): Promise<boolean> {
  const recordId = ticket.record_id;
  if (!recordId) return false;
  try {
    const updated = await bitable.getRecord(cfg.ticketsTableId, recordId);
    if (!updated) return false;
    const status = String(updated.fields[tf(cfg).status] ?? '');
    if (status !== cfg.statuses.active) return false;
    return true;
  } catch {
    return false;
  }
}

// ---- Turns -----------------------------------------------------------------

export async function getTurns(bitable: BitableAdapter, cfg: Config, ticketId: string): Promise<TurnRecord[]> {
  return bitable.searchRecords(cfg.turnsTableId, {
    conjunction: 'and',
    conditions: [
      { field_name: nf(cfg).ticketRecordId, operator: 'is', value: [ticketId] },
    ],
  });
}

export async function appendTurn(
  bitable: BitableAdapter, cfg: Config,
  ticketId: string, role: string, content: string, dedupKey: string,
  agentIdentity: string, status: string, rootMsgId?: string,
  roundId?: string, parts?: unknown[], notified?: number, appId?: string,
): Promise<string | undefined> {
  // Dedup check
  if (dedupKey) {
    const existing = await bitable.searchRecords(cfg.turnsTableId, {
      conjunction: 'and',
      conditions: [
        { field_name: nf(cfg).dedupKey, operator: 'is', value: [dedupKey] },
      ],
    });
    if (existing.length > 0) return existing[0].record_id;
  }

  const fields: Record<string, unknown> = {
    [nf(cfg).ticketRecordId]: ticketId,
    [nf(cfg).role]: role,
    [nf(cfg).content]: content,
    [nf(cfg).dedupKey]: dedupKey || '',
    [nf(cfg).agentIdentity]: agentIdentity,
    [nf(cfg).notified]: notified ?? 0,
  };
  if (rootMsgId) fields[nf(cfg).rootMsgId] = rootMsgId;
  if (status) fields[nf(cfg).status] = status;
  if (roundId) fields[nf(cfg).roundId] = roundId;
  if (parts && parts.length > 0) fields[nf(cfg).parts] = JSON.stringify(parts);
  if (appId) fields[nf(cfg).appId] = appId;

  const record = await bitable.createRecord(cfg.turnsTableId, fields);
  return record.record_id;
}

// ---- Rounds ----------------------------------------------------------------

export async function getRound(bitable: BitableAdapter, cfg: Config, roundId: string): Promise<RoundRecord | null> {
  if (!cfg.roundsTableId) return null;
  try {
    return await bitable.getRecord(cfg.roundsTableId, roundId);
  } catch {
    return null;
  }
}

export async function getCurrentRound(bitable: BitableAdapter, cfg: Config, ticketId: string): Promise<RoundRecord | null> {
  if (!cfg.roundsTableId) return null;
  const all = await bitable.searchRecords(cfg.roundsTableId, {
    conjunction: 'and',
    conditions: [
      { field_name: rf(cfg).ticketRecordId, operator: 'is', value: [ticketId] },
    ],
  });
  const terminal = [rsv(cfg).done, rsv(cfg).failed, rsv(cfg).cancelled];
  const active = all.filter(r =>
    !terminal.includes(String(r.fields[rf(cfg).status] ?? '')),
  );
  return active.length > 0 ? active[active.length - 1] : null;
}

export async function searchRoundsByStatus(bitable: BitableAdapter, cfg: Config, status: string): Promise<RoundRecord[]> {
  if (!cfg.roundsTableId) return [];
  return bitable.searchRecords(cfg.roundsTableId, {
    conjunction: 'and',
    conditions: [
      { field_name: rf(cfg).status, operator: 'is', value: [status] },
    ],
  });
}

export async function searchStuckRounds(bitable: BitableAdapter, cfg: Config, stuckTimeoutMs: number): Promise<RoundRecord[]> {
  if (!cfg.roundsTableId) return [];
  const executing = await bitable.searchRecords(cfg.roundsTableId, {
    conjunction: 'and',
    conditions: [
      { field_name: rf(cfg).status, operator: 'is', value: [rsv(cfg).executing] },
    ],
  });
  const cutoff = Date.now() - stuckTimeoutMs;
  return executing.filter(r => {
    const updatedAt = Number(r.fields[rf(cfg).updatedAt] ?? 0);
    return updatedAt > 0 && updatedAt < cutoff;
  });
}

/** Claim a round: check claimable status, write executor+status, verify. */
export async function claimRound(
  bitable: BitableAdapter, cfg: Config,
  round: RoundRecord, identity: string, nextStatus?: string,
): Promise<boolean> {
  const roundId = round.record_id;
  if (!roundId || !cfg.roundsTableId) return false;
  // Only claim if round is still in a claimable state
  try {
    const current = await getRound(bitable, cfg, roundId);
    if (!current) return false;
    const curStatus = String(current.fields[rf(cfg).status] ?? '');
    const claimable = [cfg.roundStatuses.pending, cfg.roundStatuses.approved];
    if (!claimable.includes(curStatus)) return false;
  } catch {
    return false;
  }
  try {
    const fields: Record<string, unknown> = {
      [rf(cfg).executor]: identity,
    };
    if (nextStatus) fields[rf(cfg).status] = nextStatus;
    await bitable.updateRecord(cfg.roundsTableId, roundId, fields);
  } catch {
    return false;
  }
  await sleep(300);
  const updated = await getRound(bitable, cfg, roundId);
  if (!updated) return false;
  return String(updated.fields[rf(cfg).executor] ?? '') === identity;
}

export async function releaseRound(bitable: BitableAdapter, cfg: Config, roundId: string): Promise<void> {
  if (!cfg.roundsTableId) return;
  try {
    await bitable.updateRecord(cfg.roundsTableId, roundId, {
      [rf(cfg).executor]: '',
      [rf(cfg).status]: rsv(cfg).pending,
    });
  } catch { /* best effort */ }
}

export async function transitionRound(bitable: BitableAdapter, cfg: Config, roundId: string, newStatus: string): Promise<boolean> {
  if (!cfg.roundsTableId) return false;
  const round = await getRound(bitable, cfg, roundId);
  if (!round) return false;
  const currentStatus = String(round.fields[rf(cfg).status] ?? '');
  if (!validateRoundTransition(cfg, currentStatus, newStatus)) return false;
  try {
    await bitable.updateRecord(cfg.roundsTableId, roundId, {
      [rf(cfg).status]: newStatus,
    });
    await sleep(300);
    const updated = await getRound(bitable, cfg, roundId);
    if (!updated) return false;
    return String(updated.fields[rf(cfg).status] ?? '') === newStatus;
  } catch {
    return false;
  }
}

export async function setRoundResult(bitable: BitableAdapter, cfg: Config, roundId: string, result: string): Promise<void> {
  if (!cfg.roundsTableId) return;
  try {
    await bitable.updateRecord(cfg.roundsTableId, roundId, {
      [rf(cfg).result]: result,
      [rf(cfg).updatedAt]: Date.now(),
    });
  } catch { /* best effort */ }
}

// ---- Roster ----------------------------------------------------------------

export async function searchRoster(
  bitable: BitableAdapter, cfg: Config,
  filter: { conjunction: string; conditions: Array<{ field_name: string; operator: string; value: unknown[] }> },
): Promise<RosterRecord[]> {
  return bitable.searchRecords(cfg.rosterTableId, filter);
}

export async function getRosterByIdentity(bitable: BitableAdapter, cfg: Config, identity: string): Promise<Record<string, unknown> | null> {
  const records = await bitable.searchRecords(cfg.rosterTableId, {
    conjunction: 'and',
    conditions: [
      { field_name: cfg.fields.roster.identity, operator: 'is', value: [identity] },
    ],
  });
  return records.length > 0 ? records[0].fields : null;
}

export async function registerRoster(bitable: BitableAdapter, cfg: Config, identity: string, fields: Record<string, unknown>): Promise<void> {
  const recordFields: Record<string, unknown> = {
    [cfg.fields.roster.identity]: identity,
    ...fields,
    [cfg.fields.roster.kind]: fields.kind || 'agent',
    [cfg.fields.roster.enabled]: fields.enabled ?? true,
  };
  await bitable.createRecord(cfg.rosterTableId, recordFields);
}
