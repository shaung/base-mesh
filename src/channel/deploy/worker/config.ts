// ---------------------------------------------------------------------------
// Worker config builder — constructs a Config-compatible object from Env
// for use with CoreCoordinator and WorkerSessionAdapter.
//
// Field and status mappings are HARDCODED — they are a schema contract, not
// runtime configuration. Only runtime-tunable values (coordinator settings,
// message templates, etc.) may be overridden via the Bitable Configs table.
// ---------------------------------------------------------------------------

import type { Env } from './index.js';
import type { Config } from '../../../lib/types.js';
import type { BitableAdapter } from '../../core/types.js';

// ---------------------------------------------------------------------------
// Hardcoded field mappings — standard base-mesh schema.
// These MUST stay in sync with DEFAULT_FIELDS in src/lib/config.ts.
// ---------------------------------------------------------------------------

const FIELDS: Config['fields'] = {
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
    parts: 'parts', attachments: 'attachments', status: 'turn_status',
    dedupKey: 'dedup_key', agentIdentity: 'agent_identity',
    human: 'human', deliveryOwner: 'delivery_owner',
    deliveryLeaseAt: 'delivery_lease_at',
    createdAt: 'created_at', notified: 'notified',
    metadata: 'metadata', updatedAt: 'updated_at', appId: 'app_id',
  },
  round: {
    ticketRecordId: 'ticket_record_id', domains: 'domains',
    status: 'round_status', executor: 'executor', reviewer: 'reviewer',
    reviewComment: 'review_comment', supplementPrompt: 'supplement_prompt',
    result: 'result', artifacts: 'artifacts', input: 'input',
    createdAt: 'created_at', updatedAt: 'updated_at', appId: 'app_id',
  },
  roster: {
    identity: 'identity', nickname: 'nickname', kind: 'kind',
    metadata: 'metadata', lastSeenAt: 'last_seen_at',
    registeredAt: 'registered_at', domains: 'domains',
    human: 'human', enabled: 'enabled', description: 'description',
    hitl: 'hitl', hitlPolicy: 'hitl_policy',
    createdAt: 'created_at', updatedAt: 'updated_at',
  },
};

// ---------------------------------------------------------------------------
// Hardcoded status mappings
// ---------------------------------------------------------------------------

const STATUSES = { draft: 'draft', active: 'active', closed: 'closed' };

const ROUND_STATUSES = {
  pending: 'pending', pendingApproval: 'pending_approval',
  approved: 'approved', rejected: 'rejected',
  executing: 'executing', done: 'done', failed: 'failed', cancelled: 'cancelled',
};

// ---------------------------------------------------------------------------
// Configs table loading (runtime config overrides)
// ---------------------------------------------------------------------------

/** Row shape in the Configs Bitable table. */
interface ConfigTableRow {
  section: string;
  key: string;
  value: string;
  default: string;
  type: string;
}

/** Parse a raw value according to its declared type. Falls back to `fallback`. */
function coerce(value: string, fallback: string, type: string): unknown {
  const raw = value || fallback;
  try {
    switch (type) {
      case 'number': return Number(raw) || Number(fallback);
      case 'boolean': return raw === 'true' ? true : raw === 'false' ? false : fallback === 'true';
      default: return raw;
    }
  } catch {
    return fallback;
  }
}

/** Convert snake_case to camelCase. */
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Convert all keys in an object from snake_case to camelCase. */
function camelizeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) result[snakeToCamel(k)] = v;
  return result;
}

/** Read all rows from the Configs table. Must have a valid configsTableId. */
async function loadConfigRows(
  tableId: string,
  bitable: BitableAdapter,
): Promise<ConfigTableRow[]> {
  const records = await bitable.searchRecords(tableId, {
    conjunction: 'and',
    conditions: [],
  });

  return records
    .map(r => ({
      section: String(r.fields['section'] ?? ''),
      key: String(r.fields['key'] ?? ''),
      value: String(r.fields['value'] ?? ''),
      default: String(r.fields['default'] ?? ''),
      type: String(r.fields['type'] ?? 'string'),
    }))
    .filter(r => r.section && r.key);
}

/** Group rows by section, coerce values, and merge into `cfg` in place.
 *  Only affects the `channel`, `operator`, `messages`, `coordinator`
 *  sub-objects — field/status mappings are never touched. */
function mergeConfigRows(cfg: Config, rows: ConfigTableRow[]): void {
  // Group by section
  const groups: Record<string, Record<string, unknown>> = {};
  for (const r of rows) {
    if (!groups[r.section]) groups[r.section] = {};
    groups[r.section][r.key] = coerce(r.value, r.default, r.type);
  }

  // Apply each section group
  for (const [section, fields] of Object.entries(groups)) {
    const parts = section.split('.').map(snakeToCamel);
    const rootSection = parts[0] as keyof Config;
    if (!['channel', 'operator', 'messages', 'coordinator'].includes(rootSection as string)) continue;

    if (parts.length === 1) {
      (cfg as any)[rootSection] = { ...(cfg as any)[rootSection], ...camelizeKeys(fields) };
    } else {
      let target = (cfg as any)[rootSection] ?? {};
      (cfg as any)[rootSection] = target;
      for (let i = 1; i < parts.length - 1; i++) {
        target[parts[i]] = target[parts[i]] || {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = camelizeKeys(fields);
    }
  }

  // Special case: operator.intent → cfg.intent (only when enabled=true)
  if (groups['operator.intent']) {
    const intent = camelizeKeys(groups['operator.intent']);
    if (intent.enabled === true) {
      delete intent.enabled;
      (cfg as any).intent = intent;
    } else {
      (cfg as any).intent = undefined;
    }
  }

  // Promote known channel keys to Config root
  const channelFields = groups['channel'];
  if (channelFields) {
    const camelized = camelizeKeys(channelFields);
    for (const rootKey of ['ticketsTableId', 'turnsTableId', 'rosterTableId', 'roundsTableId', 'domainsTableId']) {
      if (camelized[rootKey]) (cfg as any)[rootKey] = camelized[rootKey];
    }
  }
}

/** Enrich a Config with runtime values from the Configs Bitable table.
 *  Field/status mappings are never overridden — only runtime knobs
 *  (channel, operator, messages, coordinator) are loaded.
 *  Returns the same `cfg` reference, mutated in place. */
export async function enrichConfigFromTable(
  cfg: Config,
  bitable: BitableAdapter,
): Promise<Config> {
  if (!cfg.configsTableId) return cfg;
  try {
    const rows = await loadConfigRows(cfg.configsTableId, bitable);
    mergeConfigRows(cfg, rows);
  } catch (err) {
    console.error('[worker-config] failed to load configs from Bitable:', err);
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Build a Config-compatible object from Worker Env.
 *
 *  Field and status mappings are hardcoded — see FIELDS / STATUSES /
 *  ROUND_STATUSES above. Runtime-tunable values (coordinator, operator,
 *  messages, executor) use env var defaults and may be enriched later
 *  via enrichConfigFromTable() from the Bitable Configs table. */
export function buildWorkerConfig(env: Env): Config {
  return {
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

    // Hardcoded field and status mappings
    fields: FIELDS,
    statuses: STATUSES,
    roundStatuses: ROUND_STATUSES,
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
