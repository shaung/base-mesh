import { describe, it, expect, vi } from 'vitest';
import { Config, RoundStatusMapping } from './types.js';
import {
  roundStatusToA2A,
  buildAgentCard,
  parseBody,
  verifyA2AAuth,
  buildA2ATaskFromRoundAndTurns,
  type A2ATask,
  type A2ACreateTaskRequest,
  type A2ACreateTaskResponse,
  type AgentCard,
} from './a2a.js';

// ---------------------------------------------------------------------------
// Mock Config
// ---------------------------------------------------------------------------

function mockConfig(overrides: Partial<Config> = {}): Config {
  const defaultRS: RoundStatusMapping = {
    pending: 'pending',
    pendingApproval: 'pending_approval',
    approved: 'approved',
    rejected: 'rejected',
    executing: 'executing',
    done: 'done',
    failed: 'failed',
    cancelled: 'cancelled',
  };

  return {
    appId: 'test_app',
    appSecret: 'test_secret',
    appToken: 'test_app_token',
    ticketsTableId: 'tbl_tickets',
    turnsTableId: 'tbl_turns',
    rosterTableId: 'tbl_roster',
    roundsTableId: 'tbl_rounds',
    identity: 'test-identity',
    nickname: 'test-nick',
    clientId: 'test-client',
    fields: {
      ticket: { status: 'status', owner: 'owner', ownerLeaseAt: 'owner_lease_at', retryCount: 'retry_count', summary: 'summary', keyfacts: 'keyfacts', rootMsgId: 'root_msg_id', chatId: 'chat_id', senderId: 'sender_id', result: 'result', approvers: 'approvers', lastOwner: 'last_owner', domain: 'domain', lastRoundId: 'last_round_id', metadata: 'metadata', createdAt: 'created_at', updatedAt: 'updated_at' },
      turn: { ticketRecordId: 'ticket_record_id', roundId: 'round_id', rootMsgId: 'root_msg_id', role: 'role', content: 'content', parts: 'parts', attachments: 'attachments', status: 'turn_status', dedupKey: 'dedup_key', agentIdentity: 'agent_identity', human: 'human', deliveryOwner: 'delivery_owner', deliveryLeaseAt: 'delivery_lease_at', createdAt: 'created_at', notified: 'notified', metadata: 'metadata', updatedAt: 'updated_at' },
      round: { ticketRecordId: 'ticket_record_id', requiredAbilities: 'required_abilities', status: 'round_status', executor: 'executor', reviewer: 'reviewer', reviewComment: 'review_comment', supplementPrompt: 'supplement_prompt', result: 'result', artifacts: 'artifacts', createdAt: 'created_at', updatedAt: 'updated_at' },
      roster: { identity: 'identity', nickname: 'nickname', kind: 'kind', systemType: 'system_type', channelType: 'channel_type', hostname: 'hostname', user: 'user', pid: 'pid', lastSeenAt: 'last_seen_at', registeredAt: 'registered_at', roles: 'roles', human: 'human', enabled: 'enabled', description: 'description', hitl: 'hitl', hitlPolicy: 'hitl_policy', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    statuses: { draft: 'draft', pending: 'pending', assigned: 'assigned', pendingApproval: 'pending_approval', done: 'done', failed: 'failed', closed: 'closed' },
    roundStatuses: defaultRS,
    peakInterval: 3,
    offPeakInterval: 30,
    nightInterval: 300,
    heartbeatIntervalSeconds: 60,
    errorRetrySeconds: 30,
    leaseDuration: 300,
    claudeTimeout: 600,
    claudeArgs: [],
    aiCommand: 'claude',
    aiPromptFlag: '-p',
    maxRetries: 3,
    maxConcurrency: 5,
    prompt: 'Test prompt',
    ...overrides,
  } as Config;
}

// ---------------------------------------------------------------------------
// roundStatusToA2A
// ---------------------------------------------------------------------------

describe('roundStatusToA2A', () => {
  it('maps pending to submitted', () => {
    const cfg = mockConfig();
    expect(roundStatusToA2A('pending', cfg.roundStatuses)).toBe('submitted');
  });

  it('maps pending_approval to input-required', () => {
    const cfg = mockConfig();
    expect(roundStatusToA2A('pending_approval', cfg.roundStatuses)).toBe('input-required');
  });

  it('maps executing to working', () => {
    const cfg = mockConfig();
    expect(roundStatusToA2A('executing', cfg.roundStatuses)).toBe('working');
  });

  it('maps done to completed', () => {
    const cfg = mockConfig();
    expect(roundStatusToA2A('done', cfg.roundStatuses)).toBe('completed');
  });

  it('maps failed to failed', () => {
    const cfg = mockConfig();
    expect(roundStatusToA2A('failed', cfg.roundStatuses)).toBe('failed');
  });

  it('maps cancelled to canceled', () => {
    const cfg = mockConfig();
    expect(roundStatusToA2A('cancelled', cfg.roundStatuses)).toBe('canceled');
  });

  it('maps unknown status to failed', () => {
    const cfg = mockConfig();
    expect(roundStatusToA2A('nonexistent', cfg.roundStatuses)).toBe('failed');
  });

  it('works with custom status values', () => {
    const cfg = mockConfig({
      roundStatuses: {
        pending: 'queued',
        pendingApproval: 'needs_review',
        approved: 'ok',
        rejected: 'denied',
        executing: 'running',
        done: 'finished',
        failed: 'errored',
        cancelled: 'aborted',
      },
    });
    expect(roundStatusToA2A('queued', cfg.roundStatuses)).toBe('submitted');
    expect(roundStatusToA2A('needs_review', cfg.roundStatuses)).toBe('input-required');
    expect(roundStatusToA2A('running', cfg.roundStatuses)).toBe('working');
    expect(roundStatusToA2A('finished', cfg.roundStatuses)).toBe('completed');
    expect(roundStatusToA2A('errored', cfg.roundStatuses)).toBe('failed');
    expect(roundStatusToA2A('aborted', cfg.roundStatuses)).toBe('canceled');
  });
});

// ---------------------------------------------------------------------------
// buildAgentCard
// ---------------------------------------------------------------------------

describe('buildAgentCard', () => {
  it('builds agent card from config', () => {
    const cfg = mockConfig({
      coordinator: {
        port: 8080,
        a2a: { enabled: true, baseUrl: 'http://my-host:8080' },
      },
      nickname: 'BAM-Prod',
    });
    const card = buildAgentCard(cfg);
    expect(card.name).toBe('BAM-Prod');
    expect(card.url).toBe('http://my-host:8080');
    expect(card.version).toBe('0.0.3');
    expect(card.defaultInputModes).toContain('text');
    expect(card.defaultInputModes).toContain('file');
    expect(card.capabilities.pushNotifications).toBe(true);
  });

  it('falls back to localhost when no baseUrl configured', () => {
    const cfg = mockConfig({ coordinator: { port: 9999 } });
    const card = buildAgentCard(cfg);
    expect(card.url).toContain('localhost');
    expect(card.url).toContain('9999');
  });

  it('includes auth when apiToken is set', () => {
    const cfg = mockConfig({
      coordinator: { port: 8080, a2a: { enabled: true, apiToken: 'secret123' } },
    });
    const card = buildAgentCard(cfg);
    expect(card.authentication).toBeDefined();
    expect(card.authentication!.schemes).toContain('bearer');
    expect(card.authentication!.credentials).toBe('secret123');
  });

  it('omits auth when no apiToken', () => {
    const cfg = mockConfig({ coordinator: { port: 8080, a2a: { enabled: true } } });
    const card = buildAgentCard(cfg);
    expect(card.authentication).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseBody
// ---------------------------------------------------------------------------

describe('parseBody', () => {
  it('parses JSON body', async () => {
    const req = createMockRequest(JSON.stringify({ hello: 'world' }));
    const body = await parseBody(req);
    expect(body.hello).toBe('world');
  });

  it('returns empty object for empty body', async () => {
    const req = createMockRequest('');
    const body = await parseBody(req);
    expect(body).toEqual({});
  });

  it('rejects on invalid JSON', async () => {
    const req = createMockRequest('not json');
    await expect(parseBody(req)).rejects.toThrow();
  });
});

/** Create a mock HTTP IncomingMessage that emits data and end events. */
function createMockRequest(body: string): any {
  const listeners = new Map<string, (...args: any[]) => void>();
  const req: any = {
    on: vi.fn((event: string, cb: (...args: any[]) => void) => {
      listeners.set(event, cb);
      // Simulate stream by emitting data+end on next tick
      if (event === 'data' && body) {
        setTimeout(() => cb(Buffer.from(body)), 0);
      } else if (event === 'end') {
        setTimeout(() => cb(), 0);
      }
    }),
  };
  return req;
}

// ---------------------------------------------------------------------------
// verifyA2AAuth
// ---------------------------------------------------------------------------

describe('verifyA2AAuth', () => {
  it('allows requests when no token configured', () => {
    const cfg = mockConfig({ coordinator: { port: 8080, a2a: { enabled: true } } });
    expect(verifyA2AAuth({ headers: {} }, cfg)).toBe(true);
  });

  it('allows requests with correct bearer token', () => {
    const cfg = mockConfig({
      coordinator: { port: 8080, a2a: { enabled: true, apiToken: 'secret123' } },
    });
    expect(verifyA2AAuth({ headers: { authorization: 'Bearer secret123' } }, cfg)).toBe(true);
  });

  it('allows requests with raw token in auth header', () => {
    const cfg = mockConfig({
      coordinator: { port: 8080, a2a: { enabled: true, apiToken: 'secret123' } },
    });
    expect(verifyA2AAuth({ headers: { authorization: 'secret123' } }, cfg)).toBe(true);
  });

  it('rejects requests with wrong token', () => {
    const cfg = mockConfig({
      coordinator: { port: 8080, a2a: { enabled: true, apiToken: 'secret123' } },
    });
    expect(verifyA2AAuth({ headers: { authorization: 'Bearer wrong' } }, cfg)).toBe(false);
  });

  it('rejects requests with no auth header when token required', () => {
    const cfg = mockConfig({
      coordinator: { port: 8080, a2a: { enabled: true, apiToken: 'secret123' } },
    });
    expect(verifyA2AAuth({ headers: {} }, cfg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildA2ATaskFromRoundAndTurns
// ---------------------------------------------------------------------------

describe('buildA2ATaskFromRoundAndTurns', () => {
  it('builds A2A task from round and turns', async () => {
    const cfg = mockConfig();
    const round = {
      record_id: 'round_001',
      fields: {
        [cfg.fields.round.status]: 'done',
        [cfg.fields.round.executor]: 'agent-1',
        [cfg.fields.round.result]: 'Task completed',
        [cfg.fields.round.artifacts]: JSON.stringify([
          { name: 'report.pdf', mime_type: 'application/pdf', uri: '/files/abc123' },
        ]),
      },
    };
    const turns = [
      { record_id: 'turn_001', fields: { [cfg.fields.turn.role]: 'user', [cfg.fields.turn.content]: 'Hello', [cfg.fields.turn.parts]: '' } },
      { record_id: 'turn_002', fields: { [cfg.fields.turn.role]: 'agent', [cfg.fields.turn.content]: 'Hi there!', [cfg.fields.turn.parts]: '' } },
    ];

    const task = await buildA2ATaskFromRoundAndTurns(round as any, turns as any, cfg);

    expect(task.id).toBe('round_001');
    expect(task.status).toBe('completed');
    expect(task.messages).toHaveLength(2);
    expect(task.messages![0].role).toBe('user');
    expect(task.messages![0].parts[0]).toEqual({ kind: 'text', text: 'Hello' });
    expect(task.messages![1].role).toBe('agent');
    expect(task.messages![1].parts[0]).toEqual({ kind: 'text', text: 'Hi there!' });
    expect(task.artifacts).toHaveLength(1);
    expect(task.artifacts![0].name).toBe('report.pdf');
  });

  it('parses parts from Turn.parts when available', async () => {
    const cfg = mockConfig();
    const round = { record_id: 'round_002', fields: { [cfg.fields.round.status]: 'executing', [cfg.fields.round.artifacts]: '' } };
    const turns = [
      {
        record_id: 'turn_003',
        fields: {
          [cfg.fields.turn.role]: 'user',
          [cfg.fields.turn.content]: 'legacy text',
          [cfg.fields.turn.parts]: JSON.stringify([
            { kind: 'text', text: 'structured text' },
            { kind: 'file', file_token: 'box123', file_uri: '/files/box123', name: 'img.png', mime_type: 'image/png' },
          ]),
        },
      },
    ];

    const task = await buildA2ATaskFromRoundAndTurns(round as any, turns as any, cfg);

    expect(task.status).toBe('working');
    expect(task.messages![0].parts).toHaveLength(2);
    expect(task.messages![0].parts[0]).toEqual({ kind: 'text', text: 'structured text' });
    expect(task.messages![0].parts[1]).toMatchObject({ kind: 'file', file_token: 'box123' });
  });

  it('handles empty round and turns gracefully', async () => {
    const cfg = mockConfig();
    const round = { record_id: '', fields: { [cfg.fields.round.status]: '', [cfg.fields.round.artifacts]: '' } };
    const task = await buildA2ATaskFromRoundAndTurns(round as any, [], cfg);
    expect(task.id).toBe('');
    expect(task.status).toBe('failed');
    expect(task.messages).toEqual([]);
  });

  it('includes metadata with executor and reviewer', async () => {
    const cfg = mockConfig();
    const round = {
      record_id: 'round_003',
      fields: {
        [cfg.fields.round.status]: 'pending',
        [cfg.fields.round.executor]: 'exec-1#agent-1',
        [cfg.fields.round.reviewer]: [{ id: 'ou_reviewer' }],
        [cfg.fields.round.artifacts]: '',
      },
    };
    const task = await buildA2ATaskFromRoundAndTurns(round as any, [], cfg);
    expect(task.metadata).toBeDefined();
    expect(task.metadata!.executor).toBe('exec-1#agent-1');
  });
});

// ---------------------------------------------------------------------------
// A2A Client functions
// ---------------------------------------------------------------------------

describe('sendToExternalAgent', () => {
  it('sends task to external A2A agent', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'ext_task_1', status: 'submitted' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { sendToExternalAgent } = await import('./a2a.js');
    const task: A2ATask = { id: 'local_1', status: 'submitted', messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }] };
    const result = await sendToExternalAgent('http://external-agent:8080', task);

    expect(result.id).toBe('ext_task_1');
    expect(result.status).toBe('submitted');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://external-agent:8080/a2a/tasks',
      expect.objectContaining({ method: 'POST' }),
    );

    vi.unstubAllGlobals();
  });

  it('throws on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });
    vi.stubGlobal('fetch', mockFetch);

    const { sendToExternalAgent } = await import('./a2a.js');
    await expect(sendToExternalAgent('http://ext:8080', { id: 't1', status: 'submitted' }))
      .rejects.toThrow('A2A client error 401');

    vi.unstubAllGlobals();
  });

  it('sends Authorization header when apiToken provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 't1', status: 'submitted' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { sendToExternalAgent } = await import('./a2a.js');
    await sendToExternalAgent('http://ext:8080', { id: 't1', status: 'submitted' }, 'my_token');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer my_token' }),
      }),
    );

    vi.unstubAllGlobals();
  });
});

describe('cancelExternalTask', () => {
  it('sends cancel request to external agent', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const { cancelExternalTask } = await import('./a2a.js');
    const result = await cancelExternalTask('http://ext:8080', 'task_1');

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://ext:8080/a2a/tasks/task_1/cancel',
      expect.objectContaining({ method: 'POST' }),
    );

    vi.unstubAllGlobals();
  });

  it('returns false on failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));
    vi.stubGlobal('fetch', mockFetch);

    const { cancelExternalTask } = await import('./a2a.js');
    const result = await cancelExternalTask('http://ext:8080', 'task_1');
    expect(result).toBe(false);

    vi.unstubAllGlobals();
  });
});
