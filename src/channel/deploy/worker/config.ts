// ---------------------------------------------------------------------------
// Worker config builder — constructs a Config-compatible object from Env
// for use with CoreCoordinator and WorkerSessionAdapter.
//
// Field / status mappings import from src/lib/config-defaults.ts (shared
// with the Node.js config loader).  Runtime-tunable values (table IDs,
// coordinator settings, message templates, etc.) are loaded from the
// Bitable Configs table via enrichConfigFromTable().
// ---------------------------------------------------------------------------

import {
  DEFAULT_FIELDS,
  DEFAULT_STATUSES,
  DEFAULT_ROUND_STATUSES,
} from '../../../lib/config-defaults.js';
import type { Env } from './index.js';
import type { Config } from '../../../lib/types.js';
import type { BitableAdapter } from '../../core/types.js';

// ---- Configs table loading (runtime config overrides) --------------------

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
  const groups: Record<string, Record<string, unknown>> = {};
  for (const r of rows) {
    if (!groups[r.section]) groups[r.section] = {};
    groups[r.section][r.key] = coerce(r.value, r.default, r.type);
  }

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

  // operator.intent → cfg.intent
  if (groups['operator.intent']) {
    const intent = camelizeKeys(groups['operator.intent']);
    if (intent.enabled === true) {
      delete intent.enabled;
      (cfg as any).intent = intent;
    } else {
      (cfg as any).intent = undefined;
    }
  }

  // Promote channel keys to Config root (table IDs from Configs table)
  const channelFields = groups['channel'];
  if (channelFields) {
    const camelized = camelizeKeys(channelFields);
    console.log(`[worker-config] channel fields from Configs table: ${JSON.stringify(camelized)}`);
    for (const rootKey of ['ticketsTableId', 'turnsTableId', 'rosterTableId', 'roundsTableId', 'domainsTableId']) {
      if (camelized[rootKey]) (cfg as any)[rootKey] = camelized[rootKey];
    }
  }
}

/** Enrich a Config with runtime values from the Configs Bitable table.
 *  Field / status mappings are never overridden.
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

// ---- Builder -------------------------------------------------------------

/** Build a Config-compatible object from Worker Env.
 *
 *  Field and status mappings come from shared defaults (see
 *  src/lib/config-defaults.ts).  Runtime-tunable values may be enriched
 *  later via enrichConfigFromTable() from the Bitable Configs table.
 *
 *  Only static env vars that must be available before the first Bitable
 *  call are required here: LARK_APP_ID, LARK_APP_SECRET, BITABLE_APP_TOKEN,
 *  and BITABLE_CONFIGS_TABLE_ID (if Configs table is in use). */
export function buildWorkerConfig(env: Env): Config {
  return {
    identity: 'worker-channel',
    nickname: 'WorkerChannel',
    appId: env.LARK_APP_ID,
    appSecret: env.LARK_APP_SECRET,
    appToken: env.BITABLE_APP_TOKEN,
    openApiDomain: env.OPEN_API_DOMAIN || 'open.larksuite.com',

    // Table IDs — check env vars first (from .dev.vars / wrangler.toml),
    // then allow override from Configs table at runtime via enrichConfigFromTable().
    ticketsTableId: env.BITABLE_TICKETS_TABLE_ID || '',
    turnsTableId: env.BITABLE_TURNS_TABLE_ID || '',
    rosterTableId: env.BITABLE_ROSTER_TABLE_ID || '',
    roundsTableId: env.BITABLE_ROUNDS_TABLE_ID || undefined,
    domainsTableId: env.BITABLE_DOMAINS_TABLE_ID || undefined,
    configsTableId: env.BITABLE_CONFIGS_TABLE_ID || undefined,

    // Shared defaults (no hardcoding)
    fields: DEFAULT_FIELDS,
    statuses: DEFAULT_STATUSES,
    roundStatuses: DEFAULT_ROUND_STATUSES,
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
