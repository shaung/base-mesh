// ---------------------------------------------------------------------------
// Shared helpers — utility functions shared by all deployment targets
//
// Consolidated from duplicated copies in core/coordinator.ts,
// node/coordinator.ts, and node/channel.ts.
// ---------------------------------------------------------------------------

/**
 * Parse the JSON `domains` field from a Round record.
 * Returns empty array if unset or malformed.
 */
export function parseDomains(v: unknown): string[] {
  if (!v) return [];
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Find the latest user turn's message ID from the turns list.
 * Handles dedupKey formats: "messageId" (legacy) or "appId:messageId" (multi-operator).
 */
export function latestTurnMessageId(
  turns: Array<{ fields: Record<string, unknown> }>,
  roleField: string,
  dedupKeyField: string,
): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const role = String(turns[i].fields[roleField] ?? '');
    if (role === 'user') {
      const raw = String(turns[i].fields[dedupKeyField] ?? '');
      if (!raw) return '';
      const colonIdx = raw.indexOf(':');
      return colonIdx > 0 ? raw.slice(colonIdx + 1) : raw;
    }
  }
  return '';
}

/**
 * Extract the appId from a turn's appId field or dedupKey prefix.
 */
export function extractAppIdFromTurn(
  turn: { fields: Record<string, unknown> },
  appIdField: string,
  dedupKeyField: string,
): string | undefined {
  const fieldVal = String(turn.fields[appIdField] ?? '');
  if (fieldVal) return fieldVal;
  const dedupKey = String(turn.fields[dedupKeyField] ?? '');
  if (dedupKey) {
    const colonIdx = dedupKey.indexOf(':');
    if (colonIdx > 0) return dedupKey.slice(0, colonIdx);
  }
  return undefined;
}

/**
 * Extract the identity from an executor field value (strips prefix like "RETRY:").
 */
export function parseExecutorIdentity(v: string): string {
  return v.includes('#') ? v.split('#').pop()! : v;
}
