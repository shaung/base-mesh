// ---------------------------------------------------------------------------
// Worker config builder — constructs a Config-compatible object from Env
// for use with CoreCoordinator and WorkerSessionAdapter.
// ---------------------------------------------------------------------------

import type { Env } from './index.js';
import type { Config } from '../../lib/types.js';

/** Parse a JSON-encoded env var with fallback. */
function parseJSON<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** Build a minimal Config-compatible object from Worker Env.
 *  Field and status mappings can be supplied as JSON env vars or use
 *  sensible defaults for a standard base-mesh Bitable schema. */
export function buildWorkerConfig(env: Env): Config {
  // Default field mappings (standard base-mesh schema)
  const defaultFields = {
    ticket: {
      status: 'status', owner: 'owner', ownerLeaseAt: 'owner_lease_at',
      retryCount: 'retry_count', summary: 'summary', keyfacts: 'keyfacts',
      rootMsgId: 'root_msg_id', chatId: 'chat_id', senderId: 'sender_id',
      result: 'result', approvers: 'approvers', lastOwner: 'last_owner',
      domain: 'domain', lastRoundId: 'last_round_id',
      metadata: 'metadata', createdAt: 'created_at', updatedAt: 'updated_at',
    },
    turn: {
      ticketRecordId: 'ticket_record_id', roundId: 'round_id',
      rootMsgId: 'root_msg_id', role: 'role', content: 'content',
      parts: 'parts', attachments: 'attachments', status: 'status',
      dedupKey: 'dedup_key', agentIdentity: 'agent_identity',
      human: 'human', deliveryOwner: 'delivery_owner',
      deliveryLeaseAt: 'delivery_lease_at',
      createdAt: 'created_at', notified: 'notified',
      metadata: 'metadata', updatedAt: 'updated_at', appId: 'app_id',
    },
    round: {
      ticketRecordId: 'ticket_record_id', domains: 'required_domains',
      status: 'round_status', executor: 'executor', reviewer: 'reviewer',
      reviewComment: 'review_comment', supplementPrompt: 'supplement_prompt',
      result: 'round_result', artifacts: 'artifacts', input: 'input',
      createdAt: 'created_at', updatedAt: 'updated_at', appId: 'app_id',
    },
    roster: {
      identity: 'identity', nickname: 'nickname', kind: 'kind',
      metadata: 'metadata', lastSeenAt: 'last_seen_at',
      registeredAt: 'registered_at', domains: 'domains',
      human: 'human', enabled: 'enabled', description: 'description',
      hitl: 'hitl_mode', hitlPolicy: 'hitl_policy',
      createdAt: 'created_at', updatedAt: 'updated_at',
    },
  };

  // Default status mappings
  const defaultStatuses = { draft: 'draft', active: 'active', closed: 'closed' };
  const defaultRoundStatuses = {
    pending: 'pending', pendingApproval: 'pending_approval',
    approved: 'approved', rejected: 'rejected',
    executing: 'executing', done: 'done', failed: 'failed', cancelled: 'cancelled',
  };

  const fields = parseJSON(env.FIELDS_TICKET, null)
    ? {
        ticket: parseJSON(env.FIELDS_TICKET, defaultFields.ticket),
        turn: parseJSON(env.FIELDS_TURN, defaultFields.turn),
        round: parseJSON(env.FIELDS_ROUND, defaultFields.round),
        roster: parseJSON(env.FIELDS_ROSTER, defaultFields.roster),
      }
    : defaultFields;

  const statuses = parseJSON(env.STATUSES, defaultStatuses);
  const roundStatuses = parseJSON(env.ROUND_STATUSES, defaultRoundStatuses);

  return {
    // Identity (used by Session, not critical for Worker)
    identity: 'worker-channel',
    nickname: 'WorkerChannel',
    appId: env.LARK_APP_ID,
    appSecret: env.LARK_APP_SECRET,
    appToken: env.BITABLE_APP_TOKEN,
    openApiDomain: env.OPEN_API_DOMAIN || 'open.larksuite.com',

    // Table IDs
    ticketsTableId: env.BITABLE_TICKETS_TABLE_ID,
    turnsTableId: env.BITABLE_TURNS_TABLE_ID,
    rosterTableId: env.BITABLE_ROSTER_TABLE_ID,
    roundsTableId: env.BITABLE_ROUNDS_TABLE_ID || undefined,
    domainsTableId: env.BITABLE_DOMAINS_TABLE_ID || undefined,
    configsTableId: env.BITABLE_CONFIGS_TABLE_ID || undefined,

    // Field and status mappings
    fields: fields as Config['fields'],
    statuses,
    roundStatuses: roundStatuses as Config['roundStatuses'],
    leaseDuration: 60,

    // Coordinator config from env
    coordinator: {
      globalPrompt: env.COORDINATOR_GLOBAL_PROMPT || '',
      streamOutput: env.COORDINATOR_STREAM_OUTPUT !== 'false',
      streamThinking: env.COORDINATOR_STREAM_THINKING === 'true',
      heartbeatSeconds: parseInt(env.COORDINATOR_HEARTBEAT_SECONDS || '60', 10),
      pollIntervalSeconds: parseInt(env.COORDINATOR_POLL_INTERVAL_SECONDS || '10', 10),
    },

    // Executor config
    executor: {
      approvalTimeoutMinutes: parseInt(env.EXECUTOR_APPROVAL_TIMEOUT_MINUTES || '30', 10),
    },

    // Placeholder fields not used by core but required by Config type
    clientId: undefined as any,
    intent: undefined as any,
    messages: undefined as any,
    operators: undefined as any,
    ownerOpenId: undefined as any,
    ownerUnionId: undefined as any,
    authSecret: undefined as any,
    enableFileLogging: false,
    logDir: undefined as any,
    logLevel: undefined as any,
    openApiBaseUrl: undefined as any,
  } as unknown as Config;
}
