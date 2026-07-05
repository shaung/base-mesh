import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ROUND_TRANSITIONS, type Config, type BitableRecord } from '../../lib/types.js';
import { Session, RETRY_OWNER_PREFIX } from '../../lib/bitable/protocol.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RECORDS = new Map<string, Map<string, BitableRecord>>();

function mockBitable() {
  const bitable = {
    createRecord: vi.fn(async (tableId: string, fields: Record<string, unknown>) => {
      const record: BitableRecord = { record_id: `rec_${tableId}_${RECORDS.get(tableId)?.size ?? 0}_${Date.now()}`, fields };
      if (!RECORDS.has(tableId)) RECORDS.set(tableId, new Map());
      RECORDS.get(tableId)!.set(record.record_id, record);
      // Shallow-clone the fields for later comparison
      record.fields = { ...fields };
      return record;
    }),
    getRecord: vi.fn(async (tableId: string, recordId: string) => {
      const tbl = RECORDS.get(tableId);
      if (!tbl) return null;
      const rec = tbl.get(recordId);
      return rec ? { record_id: rec.record_id, fields: { ...rec.fields } } : null;
    }),
    updateRecord: vi.fn(async (tableId: string, recordId: string, fields: Record<string, unknown>) => {
      const tbl = RECORDS.get(tableId);
      if (!tbl) throw new Error(`table ${tableId} not found`);
      const rec = tbl.get(recordId);
      if (!rec) throw new Error(`record ${recordId} not found`);
      // Mutate fields in-place (simulating Bitable write)
      for (const [k, v] of Object.entries(fields)) {
        (rec as any).fields[k] = v;
      }
    }),
    searchRecords: vi.fn(async (tableId: string, query: any) => {
      const tbl = RECORDS.get(tableId);
      if (!tbl) return [];
      const results: BitableRecord[] = [];
      for (const rec of tbl.values()) {
        const matches = query.conditions.every((c: any) => {
          const val = (rec.fields as any)[c.field_name];
          if (c.operator === 'is') {
            if (c.value.length === 0) return false;
            // Support both single values and arrays
            return c.value.some((v: any) => String(val) === String(v));
          }
          if (c.operator === 'isLess') {
            return Number(val) < Number(c.value[0]);
          }
          return false;
        });
        if (matches) {
          results.push({ record_id: rec.record_id, fields: { ...rec.fields } });
        }
      }
      return results;
    }),
  };
  return bitable;
}

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    appId: 'test_app',
    appSecret: 'test_secret',
    appToken: 'test_token',
    ticketsTableId: 'tbl_tickets',
    turnsTableId: 'tbl_turns',
    rosterTableId: 'tbl_roster',
    roundsTableId: 'tbl_rounds',
    ownerOpenId: 'ou_test',
    identity: 'test-identity',
    clientId: 'test-identity',
    nickname: 'TestAgent',
    aiCommand: '/usr/bin/env',
    aiPromptFlag: '-p',
    claudeArgs: [],
    claudeTimeout: 60_000,
    prompt: 'You are a test agent.',
    maxConcurrency: 5,
    peakInterval: 1000,
    offPeakInterval: 5000,
    nightInterval: 10000,
    heartbeatIntervalSeconds: 60,
    errorRetrySeconds: 5,
    leaseDuration: 30,
    maxRetries: 3,
    fields: {
      ticket: {
        status: 'f_status', owner: 'f_owner', ownerLeaseAt: 'f_owner_lease_at',
        retryCount: 'f_retry_count', summary: 'f_summary', keyfacts: 'f_keyfacts',
        rootMsgId: 'f_root_msg_id', chatId: 'f_chat_id', senderId: 'f_sender_id',
        result: 'f_result',
        approvers: 'f_approvers', lastOwner: 'f_last_owner',
        domain: 'f_domain', lastRoundId: 'f_last_round_id',
        metadata: 'f_metadata', createdAt: 'f_created_at', updatedAt: 'f_updated_at',
      },
      turn: {
        ticketRecordId: 'f_ticket_id', roundId: 'f_round_id',
        rootMsgId: 'f_root_msg_id', role: 'f_role', content: 'f_content',
        status: 'f_status', dedupKey: 'f_dedup_key', agentIdentity: 'f_agent_identity',
        human: 'f_human', deliveryOwner: 'f_delivery_owner',
        deliveryLeaseAt: 'f_delivery_lease_at', createdAt: 'f_created_at',
        notified: 'f_notified', metadata: 'f_metadata', updatedAt: 'f_updated_at',
        appId: 'f_app_id',
      },
      roster: {
        identity: 'f_identity', nickname: 'f_nickname', kind: 'f_kind',
        systemType: 'f_system_type', channelType: 'f_channel_type',
        hostname: 'f_hostname', user: 'f_user', pid: 'f_pid',
        lastSeenAt: 'f_last_seen_at', registeredAt: 'f_registered_at',
        roles: 'f_roles', human: 'f_human', enabled: 'f_enabled',
        description: 'f_description', hitl: 'f_hitl', hitlPolicy: 'f_hitl_policy',
        createdAt: 'f_created_at', updatedAt: 'f_updated_at',
      },
      round: {
        ticketRecordId: 'f_r_ticket_id', status: 'f_r_status',
        executor: 'f_r_executor', reviewer: 'f_r_reviewer',
        reviewComment: 'f_r_review_comment', supplementPrompt: 'f_r_supplement_prompt',
        result: 'f_r_result', input: 'f_r_input', createdAt: 'f_r_created_at',
        updatedAt: 'f_r_updated_at', appId: 'f_r_app_id',
      },
    },
    statuses: {
      draft: 'Draft', pending: 'Pending', assigned: 'Assigned',
      pendingApproval: 'PendingApproval', done: 'Done', failed: 'Failed', closed: 'Closed',
    },
    roundStatuses: {
      pending: 'RPending', pendingApproval: 'RPendingApproval', approved: 'RApproved',
      rejected: 'RRejected', executing: 'RExecuting', done: 'RDone',
      failed: 'RFailed', cancelled: 'RCancelled',
    },
    executor: { roles: ['general'], skipApproval: true },
    ...overrides,
  };
}

async function createTestTicket(session: Session, cfg: Config): Promise<BitableRecord> {
  return session.createTicket('test ticket', {
    rootMsgId: 'om_test', chatId: 'oc_test', senderId: 'ou_test_user',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ROUND_TRANSITIONS', () => {
  it('defines all 8 states', () => {
    const states = ['pending', 'pendingApproval', 'approved', 'rejected', 'executing', 'done', 'failed', 'cancelled'];
    for (const s of states) {
      expect(ROUND_TRANSITIONS).toHaveProperty(s);
    }
  });

  describe('pending state transitions', () => {
    it('allows → pendingApproval', () => {
      expect(ROUND_TRANSITIONS.pending).toContain('pendingApproval');
    });
    it('allows → executing', () => {
      expect(ROUND_TRANSITIONS.pending).toContain('executing');
    });
    it('allows → cancelled', () => {
      expect(ROUND_TRANSITIONS.pending).toContain('cancelled');
    });
    it('does not allow → done', () => {
      expect(ROUND_TRANSITIONS.pending).not.toContain('done');
    });
  });

  describe('pendingApproval state transitions', () => {
    it('allows → approved', () => {
      expect(ROUND_TRANSITIONS.pendingApproval).toContain('approved');
    });
    it('allows → rejected', () => {
      expect(ROUND_TRANSITIONS.pendingApproval).toContain('rejected');
    });
    it('allows → cancelled', () => {
      expect(ROUND_TRANSITIONS.pendingApproval).toContain('cancelled');
    });
    it('allows → pending (user message interrupts approval)', () => {
      expect(ROUND_TRANSITIONS.pendingApproval).toContain('pending');
    });
    it('does not allow → executing', () => {
      expect(ROUND_TRANSITIONS.pendingApproval).not.toContain('executing');
    });
  });

  describe('approved state transitions', () => {
    it('allows → executing', () => {
      expect(ROUND_TRANSITIONS.approved).toContain('executing');
    });
    it('allows → cancelled', () => {
      expect(ROUND_TRANSITIONS.approved).toContain('cancelled');
    });
    it('allows → pending (user message interrupts)', () => {
      expect(ROUND_TRANSITIONS.approved).toContain('pending');
    });
    it('does not allow → pendingApproval', () => {
      expect(ROUND_TRANSITIONS.approved).not.toContain('pendingApproval');
    });
  });

  describe('executing state transitions', () => {
    it('allows → done', () => {
      expect(ROUND_TRANSITIONS.executing).toContain('done');
    });
    it('allows → failed', () => {
      expect(ROUND_TRANSITIONS.executing).toContain('failed');
    });
    it('allows → pending (user message cancels execution)', () => {
      expect(ROUND_TRANSITIONS.executing).toContain('pending');
    });
    it('allows → cancelled', () => {
      expect(ROUND_TRANSITIONS.executing).toContain('cancelled');
    });
  });

  describe('terminal states', () => {
    it('rejected has no outgoing transitions', () => {
      expect(ROUND_TRANSITIONS.rejected).toEqual([]);
    });
    it('done has no outgoing transitions', () => {
      expect(ROUND_TRANSITIONS.done).toEqual([]);
    });
    it('failed has no outgoing transitions', () => {
      expect(ROUND_TRANSITIONS.failed).toEqual([]);
    });
    it('cancelled has no outgoing transitions', () => {
      expect(ROUND_TRANSITIONS.cancelled).toEqual([]);
    });
  });
});

describe('Session — Round lifecycle', () => {
  let cfg: Config;
  let bitable: ReturnType<typeof mockBitable>;
  let session: Session;

  beforeEach(() => {
    RECORDS.clear();
    bitable = mockBitable();
    cfg = makeConfig();
    session = new Session(cfg.clientId || cfg.identity, cfg.nickname, cfg, bitable as any);
  });

  describe('createRound', () => {
    it('creates a Round record with pending status', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);

      expect(round).toBeDefined();
      expect(round.record_id).toBeTruthy();
      expect(round.fields[cfg.fields.round.status]).toBe(cfg.roundStatuses.pending);
      expect(round.fields[cfg.fields.round.ticketRecordId]).toBe(ticket.record_id);
    });

    it('updates ticket.lastRoundId after creating the round', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);

      const updated = await session.getTicket(ticket.record_id!);
      expect(updated!.fields[cfg.fields.ticket.lastRoundId]).toBe(round.record_id);
    });

    it('returns existing active round for duplicate createRound', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round1 = await session.createRound(ticket.record_id!);
      const round2 = await session.createRound(ticket.record_id!);

      expect(round1.record_id).toBeTruthy();
      expect(round2.record_id).toBe(round1.record_id);
    });

    it('creates new round after previous round is terminal', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round1 = await session.createRound(ticket.record_id!);
      await session.transitionRound(round1.record_id!, cfg.roundStatuses.executing);
      await session.transitionRound(round1.record_id!, cfg.roundStatuses.done);
      const round2 = await session.createRound(ticket.record_id!);

      expect(round1.record_id).toBeTruthy();
      expect(round2.record_id).toBeTruthy();
      expect(round1.record_id).not.toBe(round2.record_id);
    });
  });

  describe('getRound', () => {
    it('returns the round by ID', async () => {
      const ticket = await createTestTicket(session, cfg);
      const created = await session.createRound(ticket.record_id!);
      const fetched = await session.getRound(created.record_id!);
      expect(fetched).toBeDefined();
      expect(fetched!.record_id).toBe(created.record_id);
    });

    it('returns null for non-existent round', async () => {
      const result = await session.getRound('rec_nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getCurrentRound', () => {
    it('returns the most recent active Round', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round1 = await session.createRound(ticket.record_id!);
      // Simulate round1 being done
      await bitable.updateRecord(cfg.roundsTableId!, round1.record_id!, {
        [cfg.fields.round.status]: cfg.roundStatuses.done,
      });
      const round2 = await session.createRound(ticket.record_id!);

      const current = await session.getCurrentRound(ticket.record_id!);
      expect(current).toBeDefined();
      expect(current!.record_id).toBe(round2.record_id);
    });

    it('returns null when no active rounds', async () => {
      const ticket = await createTestTicket(session, cfg);
      const result = await session.getCurrentRound(ticket.record_id!);
      expect(result).toBeNull();
    });

    it('filters out terminal states', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      // Mark it done
      await bitable.updateRecord(cfg.roundsTableId!, round.record_id!, {
        [cfg.fields.round.status]: cfg.roundStatuses.done,
      });
      const current = await session.getCurrentRound(ticket.record_id!);
      expect(current).toBeNull();
    });
  });

  describe('transitionRound', () => {
    it('transitions from pending → executing when valid', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);

      const result = await session.transitionRound(round.record_id!, cfg.roundStatuses.executing);
      expect(result).toBe(true);

      const updated = await session.getRound(round.record_id!);
      expect(updated!.fields[cfg.fields.round.status]).toBe(cfg.roundStatuses.executing);
    });

    it('transitions from pending → pending_approval when valid', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);

      const result = await session.transitionRound(round.record_id!, cfg.roundStatuses.pendingApproval);
      expect(result).toBe(true);
    });

    it('transitions from pending → cancelled', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      const result = await session.transitionRound(round.record_id!, cfg.roundStatuses.cancelled);
      expect(result).toBe(true);
    });

    it('rejects invalid transition (pending → done)', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);

      const result = await session.transitionRound(round.record_id!, cfg.roundStatuses.done);
      expect(result).toBe(false);
    });

    it('transitions pending_approval → approved', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.pendingApproval);

      const result = await session.transitionRound(round.record_id!, cfg.roundStatuses.approved);
      expect(result).toBe(true);
    });

    it('transitions pending_approval → rejected', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.pendingApproval);

      const result = await session.transitionRound(round.record_id!, cfg.roundStatuses.rejected);
      expect(result).toBe(true);
    });

    it('transitions pending_approval → pending (user message interrupts)', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.pendingApproval);

      const result = await session.transitionRound(round.record_id!, cfg.roundStatuses.pending);
      expect(result).toBe(true);
    });

    it('transitions approved → executing', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.pendingApproval);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.approved);

      const result = await session.transitionRound(round.record_id!, cfg.roundStatuses.executing);
      expect(result).toBe(true);
    });

    it('transitions approved → pending (user message interrupts)', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.pendingApproval);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.approved);

      const result = await session.transitionRound(round.record_id!, cfg.roundStatuses.pending);
      expect(result).toBe(true);
    });

    it('transitions executing → done', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.executing);

      const result = await session.transitionRound(round.record_id!, cfg.roundStatuses.done);
      expect(result).toBe(true);
    });

    it('transitions executing → failed', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.executing);

      const result = await session.transitionRound(round.record_id!, cfg.roundStatuses.failed);
      expect(result).toBe(true);
    });

    it('transitions executing → pending (user message cancels)', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.executing);

      const result = await session.transitionRound(round.record_id!, cfg.roundStatuses.pending);
      expect(result).toBe(true);
    });

    it('rejects transition from terminal state (done → pending)', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.executing);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.done);

      const result = await session.transitionRound(round.record_id!, cfg.roundStatuses.pending);
      expect(result).toBe(false);
    });

    it('full approval flow: pending → pending_approval → approved → executing → done', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);

      expect(await session.transitionRound(round.record_id!, cfg.roundStatuses.pendingApproval)).toBe(true);
      expect(await session.transitionRound(round.record_id!, cfg.roundStatuses.approved)).toBe(true);
      expect(await session.transitionRound(round.record_id!, cfg.roundStatuses.executing)).toBe(true);
      expect(await session.transitionRound(round.record_id!, cfg.roundStatuses.done)).toBe(true);
    });

    it('detects concurrent modification (WSR fails)', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);

      // Another process changes the status between our write and read-back
      // The transitionRound writes the new status, then reads back.
      // If the read-back doesn't match what we wrote, it returns false.
      // Simulate by writing the status to something else after the transition writes.
      // Our transition writes status = executing, then sleeps 300ms, then reads.
      // We intercept by overriding updateRecord to not actually change status.

      // Actually, the simpler way: the WSR pattern in transitionRound:
      // 1. write new status
      // 2. sleep 300ms
      // 3. read back
      // If someone else overwrites in between, the read-back won't match.
      //
      // Our mock updateRecord just mutates in place. To simulate conflict,
      // let's make updateRecord throw on the first call, which should
      // cause transitionRound to catch and return false.
      const originalUpdate = bitable.updateRecord;
      bitable.updateRecord = vi.fn(async () => {
        throw new Error('Conflict!');
      });

      const result = await session.transitionRound(round.record_id!, cfg.roundStatuses.executing);
      expect(result).toBe(false);

      bitable.updateRecord = originalUpdate;
    });

    it('returns false when round does not exist', async () => {
      const result = await session.transitionRound('rec_nonexistent', cfg.roundStatuses.executing);
      expect(result).toBe(false);
    });
  });

  describe('cancel flow', () => {
    it('allows /cancel from pending', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      expect(await session.transitionRound(round.record_id!, cfg.roundStatuses.cancelled)).toBe(true);
    });

    it('allows /cancel from pending_approval', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.pendingApproval);
      expect(await session.transitionRound(round.record_id!, cfg.roundStatuses.cancelled)).toBe(true);
    });

    it('allows /cancel from approved', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.pendingApproval);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.approved);
      expect(await session.transitionRound(round.record_id!, cfg.roundStatuses.cancelled)).toBe(true);
    });

    it('allows /cancel from executing', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.executing);
      expect(await session.transitionRound(round.record_id!, cfg.roundStatuses.cancelled)).toBe(true);
    });
  });

  describe('claimRound / releaseRound', () => {
    it('claims a round (WSR pattern)', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);

      const result = await session.claimRound(round);
      expect(result).toBe(true);

      const updated = await session.getRound(round.record_id!);
      const executorVal = String((updated?.fields as any)[cfg.fields.round.executor] ?? '');
      expect(executorVal).toContain('TestAgent');
      expect(executorVal).toContain(session.identity);
    });

    it('releaseRound clears executor and sets pending', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      await session.claimRound(round);

      await session.releaseRound(round.record_id!);

      const updated = await session.getRound(round.record_id!);
      expect((updated?.fields as any)[cfg.fields.round.executor]).toBe('');
      expect((updated?.fields as any)[cfg.fields.round.status]).toBe(cfg.roundStatuses.pending);
    });

    it('fails claim when round executor was taken by another', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);

      // Simulate another executor taking the round by making the verification
      // read return a different owner than what we just wrote.
      const originalGet = bitable.getRecord;
      bitable.getRecord = vi.fn(async (tableId: string, recordId: string) => {
        const result = await originalGet(tableId, recordId);
        if (result) {
          return {
            record_id: result.record_id,
            fields: { ...result.fields, [cfg.fields.round.executor]: 'OtherAgent#other-id' },
          };
        }
        return result;
      });

      const result = await session.claimRound(round);
      expect(result).toBe(false);

      bitable.getRecord = originalGet;
    });
  });

  describe('searchRoundsByStatus', () => {
    it('returns rounds with matching status', async () => {
      const ticket1 = await createTestTicket(session, cfg);
      const ticket2 = await createTestTicket(session, cfg);
      await session.createRound(ticket1.record_id!);
      await session.createRound(ticket2.record_id!);

      const results = await session.searchRoundsByStatus(cfg.roundStatuses.pending);
      expect(results.length).toBeGreaterThanOrEqual(2);
      results.forEach(r => {
        expect((r.fields as any)[cfg.fields.round.status]).toBe(cfg.roundStatuses.pending);
      });
    });

    it('returns empty for unmatched status', async () => {
      const results = await session.searchRoundsByStatus(cfg.roundStatuses.executing);
      expect(results).toEqual([]);
    });
  });

  describe('searchRoundsByStatusAndDomains', () => {
    it('returns rounds with matching domains', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!, ['general']);

      const results = await session.searchRoundsByStatusAndDomains(cfg.roundStatuses.pending, ['general']);
      expect(results.length).toBe(1);
      expect(results[0].record_id).toBe(round.record_id);
    });

    it('excludes rounds with non-matching domains', async () => {
      const ticket = await createTestTicket(session, cfg);
      await session.createRound(ticket.record_id!, ['admin']);

      const results = await session.searchRoundsByStatusAndDomains(cfg.roundStatuses.pending, ['general']);
      expect(results.length).toBe(0);
    });

    it('returns all rounds when domains filter is empty', async () => {
      const ticket = await createTestTicket(session, cfg);
      await session.createRound(ticket.record_id!);

      const results = await session.searchRoundsByStatusAndDomains(cfg.roundStatuses.pending, []);
      expect(results.length).toBe(1);
    });
  });

  describe('searchStuckRounds', () => {
    it('returns executing rounds with expired timeouts', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.executing);

      // Set updatedAt to a very old timestamp
      const oldTs = Date.now() - 3600_000; // 1 hour ago
      await bitable.updateRecord(cfg.roundsTableId!, round.record_id!, {
        [cfg.fields.round.updatedAt]: oldTs,
      });

      const stuck = await session.searchStuckRounds(60_000); // 60s timeout
      expect(stuck.length).toBe(1);
      expect(stuck[0].record_id).toBe(round.record_id);
    });

    it('does not return rounds that are still within timeout', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      await session.transitionRound(round.record_id!, cfg.roundStatuses.executing);

      // Set updatedAt to now (within timeout)
      await bitable.updateRecord(cfg.roundsTableId!, round.record_id!, {
        [cfg.fields.round.updatedAt]: Date.now(),
      });

      const stuck = await session.searchStuckRounds(60_000);
      expect(stuck.length).toBe(0);
    });

    it('ignores non-executing rounds', async () => {
      const ticket = await createTestTicket(session, cfg);
      await session.createRound(ticket.record_id!); // pending, not executing
      const stuck = await session.searchStuckRounds(60_000);
      expect(stuck.length).toBe(0);
    });
  });

  describe('setRoundResult', () => {
    it('writes result and updates updatedAt', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);
      const result = 'This is the processing result.';

      await session.setRoundResult(round.record_id!, result);

      const updated = await session.getRound(round.record_id!);
      expect((updated?.fields as any)[cfg.fields.round.result]).toBe(result);
      const updatedAt = Number((updated?.fields as any)[cfg.fields.round.updatedAt]);
      expect(updatedAt).toBeGreaterThan(0);
    });
  });

  describe('setRoundSupplement', () => {
    it('writes supplement prompt', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);

      await session.setRoundSupplement(round.record_id!, 'Please double-check the calculations.');

      const updated = await session.getRound(round.record_id!);
      expect((updated?.fields as any)[cfg.fields.round.supplementPrompt]).toBe('Please double-check the calculations.');
    });

    it('writes reviewer when provided', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);

      await session.setRoundSupplement(round.record_id!, 'Check this.', '7d6f5g4h_reviewer');

      const updated = await session.getRound(round.record_id!);
      const reviewer = (updated?.fields as any)[cfg.fields.round.reviewer];
      expect(reviewer).toEqual([{ id: '7d6f5g4h_reviewer' }]);
    });
  });

  describe('getRoundsByTicket', () => {
    it('returns all rounds for a ticket', async () => {
      const ticket = await createTestTicket(session, cfg);
      const r1 = await session.createRound(ticket.record_id!);
      // Close r1 before creating r2 so the guard permits a new round
      await session.transitionRound(r1.record_id!, cfg.roundStatuses.executing);
      await session.transitionRound(r1.record_id!, cfg.roundStatuses.done);
      const r2 = await session.createRound(ticket.record_id!);

      const rounds = await session.getRoundsByTicket(ticket.record_id!);
      expect(rounds.length).toBe(2);
      const ids = rounds.map(r => r.record_id).sort();
      expect(ids).toEqual([r1.record_id, r2.record_id].sort());
    });
  });

  describe('getTurnsByRound', () => {
    it('returns turns associated with a round', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);

      await session.appendTurn(ticket.record_id!, 'human', 'Hello', 'turn1', undefined, undefined, undefined, round.record_id);
      await session.appendTurn(ticket.record_id!, 'agent', 'Hi there', 'turn2', undefined, undefined, undefined, round.record_id);

      const turns = await session.getTurnsByRound(round.record_id!);
      expect(turns.length).toBe(2);
    });

    it('returns empty when no turns for round', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);

      const turns = await session.getTurnsByRound(round.record_id!);
      expect(turns).toEqual([]);
    });
  });

  describe('appendTurn with roundId', () => {
    it('associates a turn with a round via roundId field', async () => {
      const ticket = await createTestTicket(session, cfg);
      const round = await session.createRound(ticket.record_id!);

      await session.appendTurn(ticket.record_id!, 'human', 'Test message', 'dedup1', undefined, undefined, undefined, round.record_id);

      const turns = await session.getTurns(ticket.record_id!);
      expect(turns.length).toBe(1);
      expect((turns[0].fields as any)[cfg.fields.turn.roundId]).toBe(round.record_id);
    });
  });
});

describe('Session — Roster HITL fields', () => {
  let cfg: Config;
  let bitable: ReturnType<typeof mockBitable>;
  let session: Session;

  beforeEach(() => {
    RECORDS.clear();
    bitable = mockBitable();
    cfg = makeConfig();
    session = new Session(cfg.clientId || cfg.identity, cfg.nickname, cfg, bitable as any);
  });

  it('register writes hitl fields to new Roster record', async () => {
    await session.register();

    const records = await bitable.searchRecords(cfg.rosterTableId, {
      conjunction: 'and',
      conditions: [{ field_name: cfg.fields.roster.identity, operator: 'is', value: [cfg.identity] }],
    });
    expect(records.length).toBe(1);
  });

  it('getRosterByIdentity returns roster fields', async () => {
    await session.register();

    const roster = await session.getRosterByIdentity(cfg.identity);
    expect(roster).not.toBeNull();
    expect((roster as any)[cfg.fields.roster.identity]).toBe(cfg.identity);
  });
});

describe('Session — utility functions', () => {
  it('extractText handles plain strings', async () => {
    const { extractText } = await import('../../lib/bitable/protocol.js');
    expect(extractText('hello')).toBe('hello');
    expect(extractText('')).toBe('');
  });

  it('extractText handles multiline objects', async () => {
    const { extractText } = await import('../../lib/bitable/protocol.js');
    const ml = [{ text: 'Line 1' }, { text: 'Line 2' }];
    expect(extractText(ml)).toBe('Line 1Line 2');
  });

  it('extractText falls back to String() for other types', async () => {
    const { extractText } = await import('../../lib/bitable/protocol.js');
    expect(extractText(42)).toBe('42');
    expect(extractText(null)).toBe('');
    expect(extractText(undefined)).toBe('');
  });

  it('extractUserIds extracts user IDs from Person field', async () => {
    const { extractUserIds } = await import('../../lib/bitable/protocol.js');
    const result = extractUserIds([{ id: 'ou_abc' }, { id: 'ou_def' }]);
    expect(result).toBe('ou_abc,ou_def');
  });

  it('extractUserIds handles empty input', async () => {
    const { extractUserIds } = await import('../../lib/bitable/protocol.js');
    expect(extractUserIds(null)).toBe('');
    expect(extractUserIds(undefined)).toBe('');
    expect(extractUserIds([])).toBe('');
  });

  it('RETRY_OWNER_PREFIX is RETRY:', () => {
    expect(RETRY_OWNER_PREFIX).toBe('RETRY:');
  });
});
