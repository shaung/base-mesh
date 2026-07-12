import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config, BitableRecord } from '../../lib/types.js';

// Mock ws BEFORE importing Coordinator — EventEmitter-like so tests can
// capture 'message' handlers and trigger them with custom payloads.
const { default: MockWS } = vi.hoisted(() => {
  class MockWS {
    handlers = new Map<string, (...args: any[]) => void>();
    on(event: string, handler: (...args: any[]) => void) { this.handlers.set(event, handler); }
    emit(event: string, ...args: any[]) { this.handlers.get(event)?.(...args); }
    send = vi.fn();
    close = vi.fn();
  }
  return { default: MockWS as any };
});

vi.mock('ws', () => ({
  default: MockWS,
  WebSocketServer: class MockWSS {
    on() {}
    close() {}
  },
  WebSocket: MockWS,
}));

// Mock Feishu SDK
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class MockClient {
    constructor() {}
    im = {
      v1: {
        messageReaction: { create: vi.fn() },
        message: { reply: vi.fn() },
      },
    };
  },
  WSClient: class MockWSClient {},
  EventDispatcher: class MockDispatcher { register() {} },
}));

// Mock sessions module
vi.mock('../../lib/sessions.js', () => ({
  createSession: vi.fn(() => 'mock_session_token'),
  validateSession: vi.fn(() => null),
}));

import { NodeCoordinator as Coordinator } from '../deploy/node/coordinator.js';
import { BitableClient } from '../../lib/bitable/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RECORDS = new Map<string, Map<string, BitableRecord>>();

// Override BitableClient mock to provide an in-memory implementation
vi.mock('../../lib/bitable/client.js', () => ({
  BitableClient: class MockBitableClient {
    constructor(cfg: any) {
      (this as any).cfg = cfg;
    }
    async createRecord(tableId: string, fields: Record<string, unknown>) {
      if (!RECORDS.has(tableId)) RECORDS.set(tableId, new Map());
      const id = `rec_${tableId}_${RECORDS.get(tableId)!.size}_${Date.now()}`;
      const record: BitableRecord = { record_id: id, fields: { ...fields } };
      RECORDS.get(tableId)!.set(id, record);
      return record;
    }
    async getRecord(tableId: string, recordId: string) {
      const tbl = RECORDS.get(tableId);
      if (!tbl) return null;
      const rec = tbl.get(recordId);
      return rec ? { record_id: rec.record_id, fields: { ...rec.fields } } : null;
    }
    async updateRecord(tableId: string, recordId: string, fields: Record<string, unknown>) {
      const tbl = RECORDS.get(tableId);
      if (!tbl) throw new Error(`table ${tableId} not found`);
      const rec = tbl.get(recordId);
      if (!rec) throw new Error(`record ${recordId} not found`);
      for (const [k, v] of Object.entries(fields)) {
        (rec as any).fields[k] = v;
      }
    }
    async searchRecords(tableId: string, query: any) {
      const tbl = RECORDS.get(tableId);
      if (!tbl) return [];
      const results: BitableRecord[] = [];
      for (const rec of tbl.values()) {
        const matches = query.conditions.every((c: any) => {
          const val = (rec.fields as any)[c.field_name];
          if (c.operator === 'is') {
            if (c.value.length === 0) return false;
            return c.value.some((v: any) => String(val) === String(v));
          }
          if (c.operator === 'isLess') {
            return Number(val) < Number(c.value[0]);
          }
          return false;
        });
        if (matches) results.push({ record_id: rec.record_id, fields: { ...rec.fields } });
      }
      return results;
    }
  },
}));

function makeCoordinatorConfig(): Config {
  const cfg: Config = {
    appId: 'test_app',
    appSecret: 'test_secret',
    appToken: 'test_token',
    ticketsTableId: 'tbl_tickets',
    turnsTableId: 'tbl_turns',
    rosterTableId: 'tbl_roster',
    roundsTableId: 'tbl_rounds',
    identity: 'coordinator-1',
    clientId: 'coordinator-1',
    nickname: 'Coordinator',
    aiCommand: '/usr/bin/env',
    aiPromptFlag: '-p',
    claudeArgs: [],
    claudeTimeout: 60_000,
    prompt: 'You are a coordinator.',
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
        domains: 'f_roles', human: 'f_human', enabled: 'f_enabled',
        description: 'f_description', hitl: 'f_hitl', hitlPolicy: 'f_hitl_policy',
        createdAt: 'f_created_at', updatedAt: 'f_updated_at',
      },
      round: {
        ticketRecordId: 'f_r_ticket_id', domains: 'f_r_abilities', status: 'f_r_status',
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
    coordinator: {
      pollIntervalSeconds: 3600, // Long interval so tests don't race
      heartbeatSeconds: 60,
      port: 0, // No WS server for tests
    },
    executor: { domains: ['general'] },
  };
  return cfg;
}

async function createTicket(cfg: Config): Promise<BitableRecord> {
  const bitable = new (BitableClient as any)(cfg) as any;
  const ticket = await bitable.createRecord(cfg.ticketsTableId, {
    [cfg.fields.ticket.status]: cfg.statuses.pending,
    [cfg.fields.ticket.summary]: 'test ticket',
    [cfg.fields.ticket.rootMsgId]: 'om_test',
    [cfg.fields.ticket.senderId]: 'ou_test_user',
  });
  return ticket;
}

async function createRound(cfg: Config, ticketRecordId: string, status?: string, overrides?: Record<string, unknown>): Promise<BitableRecord> {
  const bitable = new (BitableClient as any)(cfg) as any;
  const round = await bitable.createRecord(cfg.roundsTableId!, {
    [cfg.fields.round.ticketRecordId]: ticketRecordId,
    [cfg.fields.round.status]: status ?? cfg.roundStatuses.pending,
    [cfg.fields.round.executor]: '',
    [cfg.fields.round.createdAt]: Date.now(),
    [cfg.fields.round.updatedAt]: Date.now(),
    ...(overrides ?? {}),
  });
  return round;
}

async function createAgentRoster(cfg: Config, bitable: any, identity: string, overrides?: Record<string, unknown>) {
  return bitable.createRecord(cfg.rosterTableId, {
    [cfg.fields.roster.identity]: identity,
    [cfg.fields.roster.kind]: 'agent',
    [cfg.fields.roster.enabled]: true,
    [cfg.fields.roster.domains]: ['general'],
    [cfg.fields.roster.hitl]: 'off',
    [cfg.fields.roster.hitlPolicy]: 'default',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Coordinator — Round state machine', () => {
  let cfg: Config;
  let coordinator: Coordinator;

  beforeEach(() => {
    RECORDS.clear();
    cfg = makeCoordinatorConfig();
    coordinator = new Coordinator(cfg);
  });

  afterEach(() => {
    coordinator.stop();
  });

  describe('checkHitlRequired', () => {
    it('returns true when matching agent has hitl=always', async () => {
      const bitable = new (BitableClient as any)(cfg) as any;
      await createAgentRoster(cfg, bitable, 'agent-1', {
        [cfg.fields.roster.hitl]: 'always',
      });

      const result = await (coordinator as any).coreCoordinator['checkHitlRequired'](['general']);
      expect(result).toBe(true);
    });

    it('returns false when matching agent has hitl=off', async () => {
      const bitable = new (BitableClient as any)(cfg) as any;
      await createAgentRoster(cfg, bitable, 'agent-1', {
        [cfg.fields.roster.hitl]: 'off',
      });

      const result = await (coordinator as any).coreCoordinator['checkHitlRequired'](['general']);
      expect(result).toBe(false);
    });

    it('returns false when no agents in roster', async () => {
      const result = await (coordinator as any).coreCoordinator['checkHitlRequired'](['general']);
      expect(result).toBe(false);
    });

    it('skips agents that do not match the ticket roles', async () => {
      const bitable = new (BitableClient as any)(cfg) as any;
      await createAgentRoster(cfg, bitable, 'admin-agent', {
        [cfg.fields.roster.domains]: ['admin'],
        [cfg.fields.roster.hitl]: 'always',
      });

      const result = await (coordinator as any).coreCoordinator['checkHitlRequired'](['general']);
      expect(result).toBe(false);
    });

    it('returns true when hitl=auto and hitl_policy=always', async () => {
      const bitable = new (BitableClient as any)(cfg) as any;
      await createAgentRoster(cfg, bitable, 'agent-1', {
        [cfg.fields.roster.hitl]: 'auto',
        [cfg.fields.roster.hitlPolicy]: 'always',
      });

      const result = await (coordinator as any).coreCoordinator['checkHitlRequired'](['general']);
      expect(result).toBe(true);
    });
  });

  describe('processPendingRound', () => {
    it('transitions to pending_approval when HITL is required', async () => {
      const bitable = new (BitableClient as any)(cfg) as any;
      await createAgentRoster(cfg, bitable, 'agent-1', {
        [cfg.fields.roster.hitl]: 'always',
      });
      const ticket = await createTicket(cfg);
      const round = await createRound(cfg, ticket.record_id);

      await (coordinator as any).coreCoordinator['processPendingRound'](round);

      const updated = await bitable.getRecord(cfg.roundsTableId!, round.record_id);
      expect((updated?.fields as any)[cfg.fields.round.status]).toBe(cfg.roundStatuses.pendingApproval);
    });

    it('leaves round pending when HITL is not required and no push executor available', async () => {
      const bitable = new (BitableClient as any)(cfg) as any;
      await createAgentRoster(cfg, bitable, 'agent-1', {
        [cfg.fields.roster.hitl]: 'off',
      });
      const ticket = await createTicket(cfg);
      const round = await createRound(cfg, ticket.record_id);

      await (coordinator as any).coreCoordinator['processPendingRound'](round);

      const updated = await bitable.getRecord(cfg.roundsTableId!, round.record_id);
      // No push executor → round remains pending
      expect((updated?.fields as any)[cfg.fields.round.status]).toBe(cfg.roundStatuses.pending);
    });
  });

  describe('processPendingApprovalRound', () => {
    it('reverts to pending when approval times out', async () => {
      const bitable = new (BitableClient as any)(cfg) as any;
      const ticket = await createTicket(cfg);
      const oldTs = Date.now() - 7200_000; // 2 hours ago
      const round = await bitable.createRecord(cfg.roundsTableId!, {
        [cfg.fields.round.ticketRecordId]: ticket.record_id,
        [cfg.fields.round.status]: cfg.roundStatuses.pendingApproval,
        [cfg.fields.round.createdAt]: oldTs,
        [cfg.fields.round.updatedAt]: oldTs,
      });

      // approvalTimeoutMinutes defaults to 30 min, and round is 2 hours old → should timeout
      await (coordinator as any).coreCoordinator['processPendingApprovalRound'](round);

      const updated = await bitable.getRecord(cfg.roundsTableId!, round.record_id);
      expect((updated?.fields as any)[cfg.fields.round.status]).toBe(cfg.roundStatuses.pending);
    });

    it('does not revert when within timeout', async () => {
      const bitable = new (BitableClient as any)(cfg) as any;
      const ticket = await createTicket(cfg);
      const recentTs = Date.now() - 60_000; // 1 min ago (within 30 min timeout)
      const round = await bitable.createRecord(cfg.roundsTableId!, {
        [cfg.fields.round.ticketRecordId]: ticket.record_id,
        [cfg.fields.round.status]: cfg.roundStatuses.pendingApproval,
        [cfg.fields.round.createdAt]: recentTs,
        [cfg.fields.round.updatedAt]: recentTs,
      });

      await (coordinator as any).coreCoordinator['processPendingApprovalRound'](round);

      const updated = await bitable.getRecord(cfg.roundsTableId!, round.record_id);
      expect((updated?.fields as any)[cfg.fields.round.status]).toBe(cfg.roundStatuses.pendingApproval);
    });
  });

  describe('processApprovedRound', () => {
    it('leaves approved round unchanged when no push executor available', async () => {
      const bitable = new (BitableClient as any)(cfg) as any;
      const ticket = await createTicket(cfg);
      const round = await createRound(cfg, ticket.record_id, cfg.roundStatuses.approved);

      await (coordinator as any).coreCoordinator['processApprovedRound'](round);

      // No push executor → round stays approved
      const updated = await bitable.getRecord(cfg.roundsTableId!, round.record_id);
      expect((updated?.fields as any)[cfg.fields.round.status]).toBe(cfg.roundStatuses.approved);
    });
  });

  describe('processStuckRound', () => {
    it('reverts stuck executing round to pending', async () => {
      const bitable = new (BitableClient as any)(cfg) as any;
      const ticket = await createTicket(cfg);
      const round = await createRound(cfg, ticket.record_id, cfg.roundStatuses.executing, {
        [cfg.fields.round.updatedAt]: Date.now() - 300_000, // 5 min old = past stuck timeout
      });

      await (coordinator as any).coreCoordinator['processStuckRound'](round);

      const updated = await bitable.getRecord(cfg.roundsTableId!, round.record_id);
      const status = (updated?.fields as any)[cfg.fields.round.status];
      expect(status).toBe(cfg.roundStatuses.pending);
      expect((updated?.fields as any)[cfg.fields.round.executor]).toBe('');
    });
  });

  describe('assignRoundToExecutor', () => {
    it('leaves round pending when no push executors', async () => {
      const bitable = new (BitableClient as any)(cfg) as any;
      const ticket = await createTicket(cfg);
      const round = await createRound(cfg, ticket.record_id);

      await (coordinator as any).coreCoordinator['assignRoundToExecutor'](round, ticket);

      const updated = await bitable.getRecord(cfg.roundsTableId!, round.record_id);
      // No push executor → round stays pending
      expect((updated?.fields as any)[cfg.fields.round.status]).toBe(cfg.roundStatuses.pending);
    });
  });

  describe('roundCoordinationCycle (full cycle)', () => {
    it('processes pending rounds and leaves them pending (no push executors)', async () => {
      const bitable = new (BitableClient as any)(cfg) as any;
      // Create an agent with hitl=off
      await createAgentRoster(cfg, bitable, 'agent-1', {
        [cfg.fields.roster.hitl]: 'off',
      });
      // Create ticket + round
      const ticket = await createTicket(cfg);
      await createRound(cfg, ticket.record_id);

      // Run the cycle
      await (coordinator as any).coreCoordinator['roundCoordinationCycle']();

      // No push executor → round stays pending, not done
      const rounds = await bitable.searchRecords(cfg.roundsTableId!, {
        conjunction: 'and',
        conditions: [{ field_name: cfg.fields.round.status, operator: 'is', value: [cfg.roundStatuses.done] }],
      });
      expect(rounds.length).toBe(0);
    });

    it('recovers stuck executing rounds and re-processes them', async () => {
      const bitable = new (BitableClient as any)(cfg) as any;
      const ticket = await createTicket(cfg);
      const oldTs = Date.now() - 3600_000; // 1 hour ago
      const round = await bitable.createRecord(cfg.roundsTableId!, {
        [cfg.fields.round.ticketRecordId]: ticket.record_id,
        [cfg.fields.round.status]: cfg.roundStatuses.executing,
        [cfg.fields.round.createdAt]: oldTs,
        [cfg.fields.round.updatedAt]: oldTs,
      });

      await (coordinator as any).coreCoordinator['roundCoordinationCycle']();

      const updated = await bitable.getRecord(cfg.roundsTableId!, round.record_id);
      // The round was recovered (stuck→pending) then immediately processed.
      // With no push executors available, it stays pending.
      expect((updated?.fields as any)[cfg.fields.round.status]).toBe(cfg.roundStatuses.pending);
    });
  });

  describe('IM delivery', () => {
    beforeEach(() => {
      vi.mocked((coordinator as any).client.im.v1.message.reply).mockClear();
    });

    it('notifyIM replies to the correct message thread', async () => {
      await (coordinator as any)['notifyIM']('om_test_root', 'Hello from agent');

      const mockReply = vi.mocked((coordinator as any).client.im.v1.message.reply);
      expect(mockReply).toHaveBeenCalledTimes(1);
      const callArg = mockReply.mock.calls[0][0];
      expect(callArg.path.message_id).toBe('om_test_root');
      const body = JSON.parse(callArg.data.content);
      expect(body.body.elements[0].content).toContain('Hello from agent');
    });

    it('notifyIM sends when appSecret is empty (uses default Client)', async () => {
      const saved = cfg.appSecret;
      cfg.appSecret = '';
      await (coordinator as any)['notifyIM']('om_test_root', 'Should still send');

      const mockReply = vi.mocked((coordinator as any).client.im.v1.message.reply);
      expect(mockReply).toHaveBeenCalledTimes(1);
      cfg.appSecret = saved;
    });

    it('delivers IM reply when WS receives a result message', async () => {
      // Create ticket + round in bitable
      const bitable = new (BitableClient as any)(cfg) as any;
      const ticket = await bitable.createRecord(cfg.ticketsTableId, {
        [cfg.fields.ticket.status]: cfg.statuses.pending,
        [cfg.fields.ticket.rootMsgId]: 'om_test_root',
        [cfg.fields.ticket.summary]: 'test ticket',
        [cfg.fields.ticket.senderId]: 'ou_test_user',
      });
      const round = await bitable.createRecord(cfg.roundsTableId!, {
        [cfg.fields.round.ticketRecordId]: ticket.record_id,
        [cfg.fields.round.status]: cfg.roundStatuses.pending,
        [cfg.fields.round.createdAt]: Date.now(),
        [cfg.fields.round.updatedAt]: Date.now(),
      });

      // Mock fetch so auth_token handler succeeds
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ code: 0 }),
      });

      const ws = new MockWS();
      await (coordinator as any)['handleConnection'](ws, {});

      // Auth the executor
      ws.emit('message', Buffer.from(JSON.stringify({
        type: 'auth_token',
        token: 'mock_token',
        identity: 'test-executor-1',
        domains: ['general'],
      })));

      // Wait for async handlers to process
      await new Promise(r => setTimeout(r, 50));

      // Send result
      ws.emit('message', Buffer.from(JSON.stringify({
        type: 'result',
        ticket_id: ticket.record_id,
        round_id: round.record_id,
        answer: 'This is the agent answer',
        root_msg_id: 'om_test_root',
        parts: [],
      })));

      await new Promise(r => setTimeout(r, 50));

      globalThis.fetch = origFetch;

      const mockReply = vi.mocked((coordinator as any).client.im.v1.message.reply);
      expect(mockReply).toHaveBeenCalled();
      const callArg = mockReply.mock.calls[0][0];
      expect(callArg.path.message_id).toBe('om_test_root');
      const body = JSON.parse(callArg.data.content);
      expect(body.body.elements[0].content).toContain('This is the agent answer');
    });
  });
});
