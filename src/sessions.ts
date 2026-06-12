// JWT-based session management — no file storage needed on coordinator side.
// Token is self-contained: signature verified with HMAC-SHA256(appSecret).

import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SESSIONS_DIR = join(homedir(), '.bam');

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromBase64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function encodeJWT(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64url(Buffer.from(JSON.stringify(payload)));
  const sig = sign(header + '.' + body, secret);
  return header + '.' + body + '.' + sig;
}

function decodeJWT(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, bodyB64, sig] = parts;
  const expectedSig = sign(headerB64 + '.' + bodyB64, secret);
  // Constant-time comparison using HMAC to prevent timing attacks
  const actual = createHmac('sha256', sig).update(expectedSig).digest();
  const expected = createHmac('sha256', expectedSig).update(sig).digest();
  if (!actual.equals(expected)) return null;
  try {
    const payload = JSON.parse(fromBase64url(bodyB64).toString()) as Record<string, unknown>;
    return payload;
  } catch {
    return null;
  }
}

/** Create a signed JWT session token. */
export function createSession(identity: string, domains: string[], ttlDays = 30, secret: string): string {
  return encodeJWT({
    identity,
    domains,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlDays * 86400,
  }, secret);
}

/** Validate a JWT session token. Returns identity+domains or null. */
export function validateSession(token: string, secret: string): { identity: string; domains: string[] } | null {
  const payload = decodeJWT(token, secret);
  if (!payload) return null;
  const exp = payload.exp as number;
  if (exp && exp < Math.floor(Date.now() / 1000)) return null;
  const identity = payload.identity as string;
  const domains = payload.domains as string[];
  if (!identity) return null;
  return { identity, domains: Array.isArray(domains) ? domains as string[] : [] };
}

/** Token file path for Executor side (reconnection persistence). */
export function executorTokenPath(): string {
  return join(SESSIONS_DIR, 'session_token');
}

/** Read executor's saved JWT session token. */
export function readExecutorToken(): string | null {
  try {
    return readFileSync(executorTokenPath(), 'utf-8').trim();
  } catch {
    return null;
  }
}

/** Write executor's JWT session token. */
export function writeExecutorToken(token: string): void {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(executorTokenPath(), token + '\n', { mode: 0o600 });
}
