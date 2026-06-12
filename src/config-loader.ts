// ---------------------------------------------------------------------------
// Config loader — reads channel/operator/messages/coordinator config from
// the Configs Bitable table (key-value, one row per setting).
//
// Table schema:
//   section (SingleSelect) — "channel" | "operator" | "messages" | "coordinator"
//                           or dotted sub-section e.g. "coordinator.a2a"
//   key    (Text)          — leaf field name in snake_case
//   value  (Text)          — user-set value (may be empty)
//   default (Text)         — fallback when value is empty/invalid
//   type   (SingleSelect)  — "string" | "number" | "boolean"
// ---------------------------------------------------------------------------

import { BitableClient } from './bitable.js';
import { extractText } from './text.js';
import type { Config } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TableConfigRow {
  section: string;
  key: string;
  value: string;
  default: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

/** Coerce a raw value string according to its declared type. Falls back to
 *  `fallback` when `value` is empty or coercion fails. */
export function coerce(value: string, fallback: string, type: string): unknown {
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
export function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Convert all keys in an object from snake_case to camelCase. */
export function camelizeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) result[snakeToCamel(k)] = v;
  return result;
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

/** Read all rows from the Configs table and return parsed config values. */
export async function loadConfigsFromTable(
  configsTableId: string,
  bitable: BitableClient,
): Promise<TableConfigRow[]> {
  const records = await bitable.searchRecords(configsTableId, {
    conjunction: 'and',
    conditions: [],
  });

  return records
    .map(r => ({
      section: extractText(r.fields['section'] ?? ''),
      key: extractText(r.fields['key'] ?? ''),
      value: extractText(r.fields['value'] ?? ''),
      default: extractText(r.fields['default'] ?? ''),
      type: extractText(r.fields['type'] ?? 'string'),
    }))
    .filter(r => r.section && r.key);
}

/** Group raw rows by section, coerce values, and merge into a Config object.
 *  Modifies `cfg` in place, updating channel/operator/messages/coordinator
 *  and the top-level `intent` field. */
export function mergeConfigRows(cfg: Config, rows: TableConfigRow[]): void {
  // Group by section
  const groups: Record<string, Record<string, unknown>> = {};
  for (const r of rows) {
    if (!groups[r.section]) groups[r.section] = {};
    groups[r.section][r.key] = coerce(r.value, r.default, r.type);
  }

  // Apply each section group to the Config object
  for (const [section, fields] of Object.entries(groups)) {
    const parts = section.split('.').map(snakeToCamel);
    const rootSection = parts[0] as keyof Config;
    if (!['channel', 'operator', 'messages', 'coordinator'].includes(rootSection as string)) continue;

    if (parts.length === 1) {
      // Root-level section: assign directly
      (cfg as any)[rootSection] = { ...(cfg as any)[rootSection], ...camelizeKeys(fields) };
    } else {
      // Dotted section: traverse to nested depth
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
      const envVar = String(intent.apiKeyEnv || 'BAM_INTENT_API_KEY');
      intent.apiKey = process.env[envVar] || '';
      delete intent.apiKeyEnv;
      delete intent.enabled;
      (cfg as any).intent = intent;
    } else {
      (cfg as any).intent = undefined;
    }
  }

  // Promote known channel keys to Config root (table IDs from Configs table
  // take precedence over TOML values).
  const channelFields = groups['channel'];
  if (channelFields) {
    const camelized = camelizeKeys(channelFields);
    for (const rootKey of ['ticketsTableId', 'turnsTableId', 'rosterTableId', 'roundsTableId', 'domainsTableId']) {
      if (camelized[rootKey]) (cfg as any)[rootKey] = camelized[rootKey];
    }
  }
}
