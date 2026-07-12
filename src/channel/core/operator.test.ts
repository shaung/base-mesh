import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../lib/types.js';

// Mock Feishu SDK BEFORE importing Channel
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class MockClient {
    constructor() { (this as any).im = { v1: { messageReaction: { create: vi.fn() }, message: { reply: vi.fn(), list: vi.fn() } } }; }
  },
  WSClient: class MockWSClient {
    start = vi.fn();
    close = vi.fn();
  },
  EventDispatcher: class MockDispatcher { register() {} },
}));

vi.mock('../../lib/sessions.js', () => ({
  createSession: vi.fn(() => 'mock_session_token'),
  validateSession: vi.fn(() => null),
}));

vi.mock('../a2a.js', () => ({
  resolvePostMessageImages: vi.fn(),
}));

const RECORDS = new Map<string, Map<string, any>>();

vi.mock('../../lib/bitable/client.js', () => ({
  BitableClient: class MockBitableClient {
    constructor(cfg: any) { (this as any).cfg = cfg; }
    async createRecord(tableId: string, fields: Record<string, unknown>) {
      if (!RECORDS.has(tableId)) RECORDS.set(tableId, new Map());
      const id = `rec_${tableId}_${RECORDS.get(tableId)!.size}_${Date.now()}`;
      const record: any = { record_id: id, fields: { ...fields } };
      RECORDS.get(tableId)!.set(id, record);
      return record;
    }
    async getRecord(tableId: string, recordId: string) {
      const tbl = RECORDS.get(tableId); if (!tbl) return null;
      const rec = tbl.get(recordId);
      return rec ? { record_id: rec.record_id, fields: { ...rec.fields } } : null;
    }
    async updateRecord(tableId: string, recordId: string, fields: Record<string, unknown>) {
      const tbl = RECORDS.get(tableId); if (!tbl) throw new Error(`table ${tableId} not found`);
      const rec = tbl.get(recordId); if (!rec) throw new Error(`record ${recordId} not found`);
      for (const [k, v] of Object.entries(fields)) rec.fields[k] = v;
    }
    async searchRecords(tableId: string, query: any) {
      const tbl = RECORDS.get(tableId); if (!tbl) return [];
      const results: any[] = [];
      for (const rec of tbl.values()) {
        const matches = query.conditions.every((c: any) => {
          const val = rec.fields[c.field_name];
          if (c.operator === 'is') {
            if (c.value.length === 0) return false;
            return c.value.some((v: any) => String(val) === String(v));
          }
          if (c.operator === 'isLess') return Number(val) < Number(c.value[0]);
          return false;
        });
        if (matches) results.push({ record_id: rec.record_id, fields: { ...rec.fields } });
      }
      return results;
    }
  },
}));

import { Channel } from '../deploy/node/channel.js';

function makeChannelConfig(): Config {
  return {
    appId: 'test_app', appSecret: 'test_secret', appToken: 'test_token',
    ticketsTableId: 'tbl_tickets', turnsTableId: 'tbl_turns',
    rosterTableId: 'tbl_roster', roundsTableId: 'tbl_rounds',
    identity: 'ch-1', clientId: 'ch-1', nickname: 'Channel',
    aiCommand: '/usr/bin/env', aiPromptFlag: '-p', claudeArgs: [], claudeTimeout: 60_000,
    prompt: 'You are a channel.',
    maxConcurrency: 5, peakInterval: 1000, offPeakInterval: 5000, nightInterval: 10000,
    heartbeatIntervalSeconds: 60, errorRetrySeconds: 5, leaseDuration: 30, maxRetries: 3,
    fields: {
      ticket: {
        status: 'f_status', owner: 'f_owner', ownerLeaseAt: 'f_lease', retryCount: 'f_retry',
        summary: 'f_summary', keyfacts: 'f_keyfacts', rootMsgId: 'f_root_msg_id',
        chatId: 'f_chat_id', senderId: 'f_sender_id', result: 'f_result',
        approvers: 'f_approvers', lastOwner: 'f_last_owner', domain: 'f_domain',
        lastRoundId: 'f_last_round_id', metadata: 'f_metadata',
        createdAt: 'f_created_at', updatedAt: 'f_updated_at',
      },
      turn: {
        ticketRecordId: 'f_ticket_id', roundId: 'f_round_id', rootMsgId: 'f_root_msg_id',
        role: 'f_role', content: 'f_content', status: 'f_status', dedupKey: 'f_dedup_key',
        agentIdentity: 'f_agent_identity', human: 'f_human', parts: 'f_parts',
        deliveryOwner: 'f_delivery_owner', deliveryLeaseAt: 'f_delivery_lease_at',
        createdAt: 'f_created_at', notified: 'f_notified', metadata: 'f_metadata',
        updatedAt: 'f_updated_at', appId: 'f_app_id',
      },
      roster: {
        identity: 'f_identity', nickname: 'f_nickname', kind: 'f_kind',
        systemType: 'f_system_type', channelType: 'f_channel_type',
        hostname: 'f_hostname', user: 'f_user', pid: 'f_pid',
        lastSeenAt: 'f_last_seen_at', registeredAt: 'f_registered_at',
        domains: 'f_domains', human: 'f_human', enabled: 'f_enabled',
        description: 'f_description', hitl: 'f_hitl', hitlPolicy: 'f_hitl_policy',
        createdAt: 'f_created_at', updatedAt: 'f_updated_at',
      },
      round: {
        ticketRecordId: 'f_r_ticket_id', domains: 'f_r_domains', status: 'f_r_status',
        executor: 'f_r_executor', reviewer: 'f_r_reviewer',
        reviewComment: 'f_r_review_comment', supplementPrompt: 'f_r_supplement_prompt',
        result: 'f_r_result', input: 'f_r_input', createdAt: 'f_r_created_at',
        updatedAt: 'f_r_updated_at', appId: 'f_r_app_id',
      },
    },
    statuses: { draft: 'Draft', active: 'Pending', closed: 'Closed' },
    roundStatuses: {
      pending: 'RPending', pendingApproval: 'RPendingApproval', approved: 'RApproved',
      rejected: 'RRejected', executing: 'RExecuting', done: 'RDone',
      failed: 'RFailed', cancelled: 'RCancelled',
    },
    operator: { pollIntervalSeconds: 3600, draftTTLMinutes: 60 },
    executor: { domains: ['general'] },
  };
}

describe('Channel', () => {
  let cfg: Config;
  let channel: Channel;

  beforeEach(() => {
    RECORDS.clear();
    cfg = makeChannelConfig();
    channel = new Channel(cfg, true); // lite=true to skip coordinator init
  });

  // -- IM helpers -------------------------------------------------------------

  describe('reply', () => {
    it('sends interactive card reply', async () => {
      await (channel as any)['reply']('om_test', 'Hello from channel', true);

      const mockReply = (channel as any).client.im.v1.message.reply;
      expect(mockReply).toHaveBeenCalledTimes(1);
      const arg = mockReply.mock.calls[0][0];
      expect(arg.path.message_id).toBe('om_test');
      expect(arg.data.reply_in_thread).toBe(true);
      const card = JSON.parse(arg.data.content);
      expect(card.body.elements[0].content).toBe('Hello from channel');
    });
  });

  describe('react', () => {
    it('adds emoji reaction', async () => {
      await (channel as any)['react']('om_test', 'OnIt');
      expect((channel as any).client.im.v1.messageReaction.create).toHaveBeenCalledWith({
        path: { message_id: 'om_test' },
        data: { reaction_type: { emoji_type: 'OnIt' } },
      });
    });
  });

  // -- deliverTurns -----------------------------------------------------------

  // Note: deliverTurns is now delegated to CoreOperator (core/operator.ts).
  // Tests access it through channel.coreOperator.

  describe('deliverTurns', () => {
    function coreOp() { return (channel as any).coreOperator; }

    it('delivers agent turn and marks notified', async () => {
      const bitable = (channel as any).bitable;
      const ticket = await bitable.createRecord(cfg.ticketsTableId, {
        [cfg.fields.ticket.rootMsgId]: 'om_root', [cfg.fields.ticket.status]: cfg.statuses.done,
      });
      await bitable.createRecord(cfg.turnsTableId, {
        [cfg.fields.turn.ticketRecordId]: ticket.record_id,
        [cfg.fields.turn.rootMsgId]: 'om_root',
        [cfg.fields.turn.content]: 'Channel answer',
        [cfg.fields.turn.role]: 'agent',
        [cfg.fields.turn.status]: 'answered',
        [cfg.fields.turn.notified]: 0,
      });

      await coreOp().deliverTurns();

      const mockReply = (channel as any).client.im.v1.message.reply;
      expect(mockReply).toHaveBeenCalled();
      const arg = mockReply.mock.calls[0][0];
      expect(arg.path.message_id).toBe('om_root');
    });

    it('includes human mentions in delivery', async () => {
      const bitable = (channel as any).bitable;
      const ticket = await bitable.createRecord(cfg.ticketsTableId, {
        [cfg.fields.ticket.rootMsgId]: 'om_root', [cfg.fields.ticket.status]: cfg.statuses.done,
      });
      await bitable.createRecord(cfg.turnsTableId, {
        [cfg.fields.turn.ticketRecordId]: ticket.record_id,
        [cfg.fields.turn.rootMsgId]: 'om_root',
        [cfg.fields.turn.content]: 'Answer with cc',
        [cfg.fields.turn.role]: 'agent',
        [cfg.fields.turn.status]: 'answered',
        [cfg.fields.turn.notified]: 0,
        [cfg.fields.turn.human]: 'ou_human_1',
      });

      await coreOp().deliverTurns();

      const mockReply = (channel as any).client.im.v1.message.reply;
      expect(mockReply).toHaveBeenCalled();
      const card = JSON.parse(mockReply.mock.calls[0][0].data.content);
      expect(card.body.elements[0].content).toContain('<at id=ou_human_1></at>');
    });

    it('skips already-delivered turns', async () => {
      const bitable = (channel as any).bitable;
      const ticket = await bitable.createRecord(cfg.ticketsTableId, {
        [cfg.fields.ticket.rootMsgId]: 'om_root', [cfg.fields.ticket.status]: cfg.statuses.done,
      });
      const turn = await bitable.createRecord(cfg.turnsTableId, {
        [cfg.fields.turn.ticketRecordId]: ticket.record_id,
        [cfg.fields.turn.rootMsgId]: 'om_root',
        [cfg.fields.turn.content]: 'Already sent',
        [cfg.fields.turn.role]: 'agent',
        [cfg.fields.turn.status]: 'answered',
        [cfg.fields.turn.notified]: 1,
      });

      coreOp().deliveredTurnIds.add(turn.record_id);
      await coreOp().deliverTurns();
      expect((channel as any).client.im.v1.message.reply).not.toHaveBeenCalled();
    });
  });

  // -- onOperatorMessage -------------------------------------------------------

  describe('onOperatorMessage', () => {
    function makeTextMsg(overrides: Record<string, unknown> = {}) {
      return {
        event: {
          sender: { sender_id: { open_id: 'ou_test' }, sender_type: 'user' },
          message: {
            message_id: 'om_msg_123',
            message_type: 'text',
            chat_id: 'oc_test',
            chat_type: 'p2p',
            content: JSON.stringify({ text: 'Need help' }),
            ...overrides,
          },
        },
      };
    }

    it('ignores non-user senders', async () => {
      await (channel as any)['onOperatorMessage']('test_app', undefined, {
        event: {
          sender: { sender_id: { open_id: 'ou_test' }, sender_type: 'app' },
          message: { message_id: 'om_msg_456', message_type: 'text', chat_type: 'p2p', content: JSON.stringify({ text: 'test' }) },
        },
      });
      const bitable = (channel as any).bitable;
      const turns = await bitable.searchRecords(cfg.turnsTableId, { conjunction: 'and', conditions: [] });
      expect(turns).toHaveLength(0);
    });

    it('processes p2p text messages', async () => {
      await (channel as any)['onOperatorMessage']('test_app', undefined, makeTextMsg());

      const bitable = (channel as any).bitable;
      const turns = await bitable.searchRecords(cfg.turnsTableId, {
        conjunction: 'and', conditions: [{ field_name: cfg.fields.turn.role, operator: 'is', value: ['user'] }],
      });
      expect(turns).toHaveLength(1);
      expect(turns[0].fields[cfg.fields.turn.content]).toBe('Need help');
    });

    it('deduplicates by appId:messageId', async () => {
      const bitable = (channel as any).bitable;
      await bitable.createRecord(cfg.turnsTableId, {
        [cfg.fields.turn.dedupKey]: 'test_app:om_msg_123', [cfg.fields.turn.role]: 'user',
        [cfg.fields.turn.content]: 'original',
      });
      await (channel as any)['onOperatorMessage']('test_app', undefined, makeTextMsg());

      const turns = await bitable.searchRecords(cfg.turnsTableId, {
        conjunction: 'and', conditions: [{ field_name: cfg.fields.turn.dedupKey, operator: 'is', value: ['test_app:om_msg_123'] }],
      });
      expect(turns).toHaveLength(1);
    });
  });

  // -- Lite mode --------------------------------------------------------------

  describe('constructor', () => {
    it('non-lite by default, coordinator null until run()', () => {
      const ch = new Channel(cfg);
      expect((ch as any).lite).toBe(false);
      expect((ch as any).coordinator).toBeNull(); // created in run()
    });
  });
});
