// Session token persistence for Channel push mode.
// Stored in ~/.bitable-mesh/sessions.json — no Bitable API calls.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const SESSIONS_DIR = join(homedir(), '.bitable-mesh');
const SESSIONS_PATH = join(SESSIONS_DIR, 'sessions.json');

export interface SessionEntry {
  token: string;
  identity: string;
  roles: string[];
  createdAt: number;
  expiresAt: number;
}

function loadAll(): Record<string, SessionEntry> {
  try {
    return JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8')) as Record<string, SessionEntry>;
  } catch {
    return {};
  }
}

function saveAll(map: Record<string, SessionEntry>): void {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SESSIONS_PATH, JSON.stringify(map, null, 2), { mode: 0o600 });
}

/** Create a new session token for an identity. Returns the token. */
export function createSession(identity: string, roles: string[], ttlDays = 30): string {
  const token = randomBytes(32).toString('hex');
  const map = loadAll();
  // Remove any existing sessions for this identity
  for (const [k, v] of Object.entries(map)) {
    if (v.identity === identity) delete map[k];
  }
  map[token] = {
    token,
    identity,
    roles,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlDays * 86400_000,
  };
  saveAll(map);
  return token;
}

/** Validate a session token. Returns the SessionEntry or null. */
export function validateSession(token: string): SessionEntry | null {
  const map = loadAll();
  const entry = map[token];
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry;
}

/** Revoke a session token. */
export function revokeSession(token: string): void {
  const map = loadAll();
  delete map[token];
  saveAll(map);
}

/** Token file path for Executor side. */
export function executorTokenPath(): string {
  return join(SESSIONS_DIR, 'session_token');
}

/** Read executor's saved session token. */
export function readExecutorToken(): string | null {
  try {
    return readFileSync(executorTokenPath(), 'utf-8').trim();
  } catch {
    return null;
  }
}

/** Write executor's session token. */
export function writeExecutorToken(token: string): void {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(executorTokenPath(), token + '\n', { mode: 0o600 });
}
