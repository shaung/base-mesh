// ---------------------------------------------------------------------------
// Executor Dashboard — redesigned web UI with overview, session logs,
// and settings modification.
// Files: <sessionDir>/<ticketId>/<roundId>.jsonl (one JSONL per round).
// Config: ~/.bam/profiles/<profile>.toml (executor section).
// ---------------------------------------------------------------------------

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../lib/log.js';
import { readProfile, saveProfile } from '../lib/config.js';

// ---------------------------------------------------------------------------
// Dashboard state — shared between executor.ts and this module.
// Executor writes to it; dashboard serves it via GET /api/status.
// ---------------------------------------------------------------------------

export interface DashboardState {
  connected: boolean;
  startedAt: number;
  ticketsProcessed: number;
  activeTicket: string | null;
  connectedAt: number | null;
  profile: string;
}

export const dashboardState: DashboardState = {
  connected: false,
  startedAt: Date.now(),
  ticketsProcessed: 0,
  activeTicket: null,
  connectedAt: null,
  profile: 'default',
};

// ---------------------------------------------------------------------------
// Session scanning helpers (unchanged logic from original)
// ---------------------------------------------------------------------------

interface SessionEntry {
  type: string;
  timestamp: string;
  [key: string]: unknown;
}

function scanSessions(sessionDir: string): { ticketId: string; sessions: string[] }[] {
  if (!existsSync(sessionDir)) return [];
  const entries = readdirSync(sessionDir, { withFileTypes: true });
  const tickets = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const ticketDir = join(sessionDir, entry.name);
    const files = readdirSync(ticketDir).filter(f => f.endsWith('.jsonl'));
    const sessions = files.map(f => join(ticketDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (sessions.length > 0) tickets.set(entry.name, sessions);
  }
  return Array.from(tickets.entries()).map(([ticketId, sessions]) => ({ ticketId, sessions }))
    .sort((a, b) => statSync(b.sessions[0]).mtimeMs - statSync(a.sessions[0]).mtimeMs);
}

function parseSessionFile(path: string): SessionEntry[] {
  try {
    return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

function getRounds(sessionDir: string, ticketId: string) {
  const ticketDir = join(sessionDir, ticketId);
  if (!existsSync(ticketDir)) return [];
  const files = readdirSync(ticketDir).filter(f => f.endsWith('.jsonl'));
  return files.map(f => {
    const path = join(ticketDir, f);
    const entries = parseSessionFile(path);
    entries.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    return { roundId: f.replace('.jsonl', ''), entries, updatedAt: statSync(path).mtimeMs };
  }).sort((a, b) => a.updatedAt - b.updatedAt);
}

/** Extract a preview (first user turn content) from the most recent session log. */
function getTicketPreview(sessionPath: string): string {
  try {
    const entries = parseSessionFile(sessionPath);
    for (const e of entries) {
      if (e.type === 'execution-start') {
        const turns = (e as any).userTurns;
        if (Array.isArray(turns) && turns.length > 0) {
          const t = turns[0];
          const txt = t && typeof t === 'object' && 'content' in t
            ? String((t as any).content)
            : typeof t === 'string' ? t : String(t ?? '');
          return txt.slice(0, 200);
        }
      }
      if (e.type === 'user') {
        const msg = (e as any).message || {};
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const b of content) {
          if (b && typeof b === 'object' && (b as any).type === 'text') {
            return String((b as any).text).slice(0, 200);
          }
        }
      }
    }
  } catch { /* best-effort */ }
  return '';
}

// ---------------------------------------------------------------------------
// Config read / write helpers
// ---------------------------------------------------------------------------

/** TOML key mapping: camelCase → snake_case */
const TO_KEY: Record<string, string> = {
  coordinatorUrl: 'coordinator_url',
  sessionDir: 'session_dir',
  selfCheck: 'self_check',
  approvalTimeoutMinutes: 'approval_timeout_minutes',
  httpDownloadTimeout: 'http_download_timeout',
  defaultDomain: 'default_domain',
  hitlPolicy: 'hitl_policy',
  systemPrompt: 'system_prompt',
  securityPrompt: 'security_prompt',
  allowedTools: 'allowed_tools',
  disallowedTools: 'disallowed_tools',
  permissionMode: 'permission_mode',
  maxRetries: 'max_retries',
  fallbackModel: 'fallback_model',
  maxBudgetUsd: 'max_budget_usd',
  backends: 'backends',
  roleDef: 'role_def',
};

function toTomlKey(camel: string): string {
  return TO_KEY[camel] || camel.replace(/([A-Z])/g, '_$1').toLowerCase();
}

const ALLOWED_EXECUTOR_KEYS = new Set([
  'domains', 'coordinatorUrl', 'prompt', 'sessionDir', 'selfCheck',
  'hitl', 'hitlPolicy', 'approvalTimeoutMinutes', 'httpDownloadTimeout',
  'defaultDomain',
]);

const ALLOWED_DOMAIN_KEYS = new Set([
  'backend', 'systemPrompt', 'securityPrompt', 'command', 'model', 'timeout',
  'args', 'effort', 'backends', 'allowedTools', 'disallowedTools',
  'permissionMode', 'maxRetries', 'fallbackModel', 'maxBudgetUsd',
]);

function readConfigFull(profile: string): Record<string, unknown> {
  const raw = readProfile(profile);
  if (!raw) return {};
  const result: Record<string, unknown> = {};

  // ── executor section ──────────────────────────────────────
  const executor = raw.executor as Record<string, unknown> | undefined;
  if (executor) {
    for (const [ck, cv] of Object.entries(executor)) {
      const camelKey = Object.entries(TO_KEY).find(([, v]) => v === ck)?.[0] || ck;
      if (ALLOWED_EXECUTOR_KEYS.has(camelKey)) {
        result[camelKey] = cv;
      }
    }
    // default_domain → defaultDomain with domain key mapping + backends
    if (executor.default_domain) {
      result.defaultDomain = mapDomainConfig(executor.default_domain as Record<string, unknown>);
    }
  }

  // ── domain.* sections ──────────────────────────────────
  const rawDomains = raw.domain as Record<string, unknown> | undefined;
  if (rawDomains) {
    const dc: Record<string, unknown> = {};
    for (const [name, val] of Object.entries(rawDomains)) {
      const mapped = mapDomainConfig(val as Record<string, unknown>);
      if (Object.keys(mapped).length > 0) dc[name] = mapped;
    }
    if (Object.keys(dc).length > 0) result.domainsConfig = dc;
  }

  return result;
}

/** Map a raw TOML domain config object (snake_case) → camelCase API object. */
function mapDomainConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [ck, cv] of Object.entries(raw)) {
    const camelKey = Object.entries(TO_KEY).find(([, v]) => v === ck)?.[0] || ck;
    if (camelKey === 'backends' && cv && typeof cv === 'object') {
      const bmap: Record<string, unknown> = {};
      for (const [bk, bv] of Object.entries(cv as Record<string, unknown>)) {
        const bc = bv as Record<string, unknown>;
        const be: Record<string, unknown> = {};
        if (bc.command) be.command = bc.command;
        if (bc.model) be.model = bc.model;
        if (bc.timeout) be.timeout = bc.timeout;
        if (bc.args) be.args = bc.args;
        if (Object.keys(be).length > 0) bmap[bk] = be;
      }
      if (Object.keys(bmap).length > 0) mapped.backends = bmap;
    } else if (ALLOWED_DOMAIN_KEYS.has(camelKey)) {
      mapped[camelKey] = cv;
    }
  }
  return mapped;
}

/** Map a camelCase API domain config object → TOML snake_case. */
function unmapDomainConfig(dc: Record<string, unknown>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [ck, cv] of Object.entries(dc)) {
    if (ck === 'backends' && cv && typeof cv === 'object') {
      const bmap: Record<string, unknown> = {};
      for (const [bk, bv] of Object.entries(cv as Record<string, unknown>)) {
        const bc = bv as Record<string, unknown>;
        const be: Record<string, unknown> = {};
        if (bc.command) be.command = bc.command;
        if (bc.model) be.model = bc.model;
        if (bc.timeout) be.timeout = bc.timeout;
        if (bc.args) be.args = bc.args;
        if (Object.keys(be).length > 0) bmap[bk] = be;
      }
      if (Object.keys(bmap).length > 0) raw.backends = bmap;
    } else if (ALLOWED_DOMAIN_KEYS.has(ck)) {
      raw[toTomlKey(ck)] = cv;
    }
  }
  return raw;
}

function writeExecutorConfig(profile: string, changes: Record<string, unknown>): void {
  const raw = readProfile(profile) || {};
  const executor = (raw.executor as Record<string, unknown>) || {};

  for (const [camelKey, value] of Object.entries(changes)) {
    const tomlKey = toTomlKey(camelKey);

    // ── domainsConfig → write to raw.domain.* ──────────────
    if (camelKey === 'domainsConfig' && value && typeof value === 'object') {
      if (!raw.domain) raw.domain = {};
      for (const [domainName, domainVal] of Object.entries(value as Record<string, unknown>)) {
        if (domainVal && typeof domainVal === 'object') {
          const unmapped = unmapDomainConfig(domainVal as Record<string, unknown>);
          (raw.domain as Record<string, unknown>)[domainName] = unmapped;
        }
      }
      continue;
    }

    if (!ALLOWED_EXECUTOR_KEYS.has(camelKey)) continue;

    // ── defaultDomain ─────────────────────────────────────
    if (camelKey === 'defaultDomain' && value && typeof value === 'object') {
      executor.default_domain = unmapDomainConfig(value as Record<string, unknown>);
    } else {
      executor[tomlKey] = value;
    }
  }

  raw.executor = executor;
  saveProfile(profile, raw);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const PKG_VERSION = '0.0.5';

export function startDashboard(
  sessionDir: string,
  port = 3456,
  state?: DashboardState,
): void {
  const st = state || dashboardState;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // ── API: status ────────────────────────────────────────────────
    if (url === '/api/status') {
      const delta = Date.now() - st.startedAt;
      const uptime = delta > 0
        ? `${Math.floor(delta / 60000)}m ${Math.floor((delta % 60000) / 1000)}s`
        : '0s';
      respondJson(res, {
        connected: st.connected,
        uptime,
        startedAt: st.startedAt,
        ticketsProcessed: st.ticketsProcessed,
        activeTicket: st.activeTicket,
        connectedAt: st.connectedAt,
        profile: st.profile,
        version: PKG_VERSION,
      });
      return;
    }

    // ── API: config (GET) ──────────────────────────────────────────
    if (url === '/api/config' && method === 'GET') {
      respondJson(res, readConfigFull(st.profile));
      return;
    }

    // ── API: config (PUT) ──────────────────────────────────────────
    if (url === '/api/config' && method === 'PUT') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const changes = JSON.parse(body) as Record<string, unknown>;
          writeExecutorConfig(st.profile, changes);
          respondJson(res, { success: true });
        } catch (err: any) {
          respondJson(res, { success: false, error: err.message }, 400);
        }
      });
      return;
    }

    // ── API: tickets list (existing) ───────────────────────────────
    if (url === '/api/tickets') {
      const tickets = scanSessions(sessionDir).map(t => ({
        ticketId: t.ticketId, sessionCount: t.sessions.length,
        updatedAt: t.sessions[0] ? statSync(t.sessions[0]).mtimeMs : 0,
        preview: t.sessions[0] ? getTicketPreview(t.sessions[0]) : '',
      }));
      respondJson(res, tickets);
      return;
    }

    // ── API: sessions for a ticket (existing) ──────────────────────
    if (url.startsWith('/api/sessions/')) {
      const ticketId = url.replace('/api/sessions/', '').split('?')[0];
      const rounds = getRounds(sessionDir, ticketId);
      respondJson(res, { ticketId, rounds });
      return;
    }

    // ── Dashboard HTML ─────────────────────────────────────────────
    if (url === '/' || url === '/index.html') {
      try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html(st));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error: ' + err.message);
      }
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.listen(port, () => console.log(`[dashboard] http://localhost:${port}`));
  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[dashboard] port ${port} in use, skipped`);
    } else {
      logger.error('[dashboard]', err);
    }
  });
}

function respondJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// HTML / CSS / JS
// ---------------------------------------------------------------------------

const CSS = `
:root {
  --bg: #0c0c12;
  --surface: #13131f;
  --surface2: #1a1a2a;
  --surface3: #222238;
  --border: #2a2a40;
  --border-light: #3a3a52;
  --text: #e2e2ee;
  --text-muted: #7a7a92;
  --text-dim: #55556a;
  --accent: #7c8aff;
  --accent-hover: #96a3ff;
  --accent-dim: #5a68cc;
  --green: #44c9a1;
  --green-glow: rgba(68,201,161,.2);
  --amber: #e5a845;
  --red: #e5535b;
  --red-glow: rgba(229,83,91,.2);
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --font: -apple-system,BlinkMacSystemFont,"SF Pro","Inter","Noto Sans SC",sans-serif;
  --font-mono: "SF Mono","JetBrains Mono","Cascadia Code",monospace;
  --ease: cubic-bezier(.16,1,.3,1);
}
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{
  font-family:var(--font);background:var(--bg);color:var(--text);
  display:flex;flex-direction:column;overflow:hidden;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale
}
a{color:var(--accent);text-decoration:none}

/* ── Top bar ───────────────────────────────────────────── */
.topbar{
  display:flex;align-items:center;gap:0;
  height:52px;padding:0 20px;flex-shrink:0;
  background:rgba(19,19,31,.92);backdrop-filter:blur(16px);
  border-bottom:1px solid var(--border);
  z-index:100;position:relative;
}
.topbar-logo{
  font-size:14px;font-weight:600;color:var(--text);letter-spacing:.3px;
  display:flex;align-items:center;gap:8px;margin-right:28px;
}
.topbar-logo span{color:var(--accent)}
.topbar-nav{display:flex;align-items:center;gap:4px;flex:1}
.topbar-nav a{
  display:flex;align-items:center;height:52px;padding:0 16px;
  font-size:13px;font-weight:500;color:var(--text-muted);
  cursor:pointer;position:relative;transition:color var(--ease) 150ms;
  text-decoration:none;border-bottom:2px solid transparent;
}
.topbar-nav a:hover{color:var(--text)}
.topbar-nav a.active{color:var(--accent);border-bottom-color:var(--accent)}
.topbar-right{
  display:flex;align-items:center;gap:12px;
  font-size:12px;color:var(--text-muted)
}
.status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.status-dot.on{background:var(--green);box-shadow:0 0 8px var(--green-glow);animation:pulse 2s ease-in-out infinite}
.status-dot.off{background:var(--red);box-shadow:0 0 8px var(--red-glow)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.profile-badge{
  font-size:11px;padding:3px 10px;border-radius:99px;
  background:var(--surface2);color:var(--text-muted);border:1px solid var(--border);
  font-family:var(--font-mono)
}

/* ── Layout ────────────────────────────────────────────── */
.main-wrap{flex:1;display:flex;overflow:hidden}
.page{display:none;flex:1;overflow-y:auto;padding:28px 32px}
.page.active{display:block}
.page.sessions-page{display:none;padding:0}
.page.sessions-page.active{display:flex}

/* ── Sidebar (sessions page only) ─────────────────────── */
.sidebar{
  width:280px;display:flex;flex-direction:column;flex-shrink:0;
  border-right:1px solid var(--border);background:var(--surface);
}
.sidebar-header{padding:16px;border-bottom:1px solid var(--border)}
.sidebar-search{
  width:100%;padding:8px 12px;border-radius:var(--radius-sm);
  background:var(--surface2);border:1px solid var(--border);
  color:var(--text);font-size:13px;outline:none;transition:border-color var(--ease) 150ms;
  font-family:var(--font)
}
.sidebar-search:focus{border-color:var(--accent)}
.sidebar-search::placeholder{color:var(--text-dim)}
.sidebar-list{flex:1;overflow-y:auto;padding:8px}
.filter-bar{padding:6px 12px;border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;gap:3px}
.filter-chip{
  font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer;user-select:none;
  font-weight:600;letter-spacing:.3px;font-family:var(--font-mono);line-height:1.5;
  transition:all var(--ease) 150ms;
}
.filter-chip.on{background:var(--surface3);color:var(--text)}
.filter-chip.off{background:transparent;color:var(--text-dim);opacity:.35}
.filter-chip.off:hover{opacity:.6}
.ticket-item{
  display:flex;padding:10px 12px;border-radius:var(--radius-sm);
  cursor:pointer;transition:background var(--ease) 150ms;margin-bottom:2px;
}
.ticket-item:hover{background:var(--surface2)}
.ticket-item.active{background:var(--surface2);border-left:2px solid var(--accent);padding-left:10px}
.ticket-item .info{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.ticket-preview{
  font-size:12px;color:var(--text);line-height:1.4;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.ticket-meta{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.meta-tag{
  font-size:9px;padding:1px 6px;border-radius:3px;
  font-family:var(--font-mono);letter-spacing:.2px;
  color:var(--text-dim);background:var(--surface2);
}
.meta-id{color:var(--accent);background:rgba(124,138,255,.1)}
.meta-rounds{color:var(--green);background:rgba(68,201,161,.1)}

/* ── Sessions main area ───────────────────────────────── */
.sessions-main{flex:1;overflow-y:auto;padding:24px 32px}
.round-section{margin-bottom:32px}
.round-header{
  display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:8px 0;
  cursor:pointer;border-radius:var(--radius-sm);transition:background var(--ease) 150ms;
  user-select:none;
}
.round-header:hover{background:var(--surface2);margin-left:-12px;padding-left:12px;margin-right:-12px;padding-right:12px}
.round-header .collapse{font-size:10px;color:var(--text-dim);transition:transform var(--ease) 200ms;width:12px;text-align:center}
.round-header .collapse.open{transform:rotate(90deg)}
.round-num{
  font-size:11px;font-weight:600;color:var(--accent);text-transform:uppercase;
  letter-spacing:.5px;background:var(--surface2);padding:3px 10px;
  border-radius:4px;font-family:var(--font-mono)
}
.round-id{font-size:11px;color:var(--text-dim);font-family:var(--font-mono)}
.round-preview{font-size:11px;color:var(--text-muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.round-body{overflow:hidden;transition:max-height .3s var(--ease);max-height:0}
.round-body.open{max-height:20000px}

/* ── Timeline ──────────────────────────────────────────── */
.timeline{padding-left:4px;border-left:1px solid var(--border);margin-left:5px}
.entry{display:flex;gap:12px;padding:8px 0 8px 16px;align-items:flex-start;position:relative}
.entry::before{content:'';position:absolute;left:-1px;top:0;bottom:0;width:1px;background:var(--border)}
.entry:last-child::before{display:none}
.entry .dot{
  width:8px;height:8px;border-radius:50%;margin-top:6px;flex-shrink:0;
  position:relative;z-index:1;background:var(--surface3);
  border:2px solid var(--text-dim);
}
.entry.assistant .dot{border-color:var(--accent);background:rgba(124,138,255,.2)}
.entry.tool .dot{border-color:var(--amber);background:rgba(229,168,69,.2)}
.entry.error .dot{border-color:var(--red);background:rgba(229,83,91,.2)}
.entry.system .dot{border-color:var(--text-dim);background:var(--surface3)}
.entry .body{flex:1;min-width:0}
.entry .label{
  font-size:13px;display:flex;align-items:center;gap:6px;
  color:var(--text);line-height:1.5;flex-wrap:wrap;
}
.entry .label .time{font-size:11px;color:var(--text-dim);font-family:var(--font-mono);white-space:nowrap}
.entry .label .tag{
  font-size:10px;font-weight:600;padding:2px 7px;border-radius:3px;
  text-transform:uppercase;letter-spacing:.5px;
}
.tag.t-assistant{background:rgba(124,138,255,.15);color:var(--accent)}
.tag.t-tool{background:rgba(229,168,69,.15);color:var(--amber)}
.tag.t-error{background:rgba(229,83,91,.15);color:var(--red)}
.tag.t-system{background:rgba(107,107,123,.15);color:var(--text-muted)}
.entry .turn-role{color:var(--green);font-size:11px;font-weight:600;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px}
.entry .turn-text{color:var(--text);line-height:1.6;white-space:pre-wrap;font-size:13px}

/* ── Event tags ───────────────────────────────────────── */
.evtag{
  font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;
  letter-spacing:.5px;white-space:nowrap;flex-shrink:0;
}
.evtag-exec,.evtag-done,.evtag-result,.evtag-user{background:rgba(68,201,161,.15);color:var(--green)}
.evtag-assistant{background:rgba(124,138,255,.15);color:var(--accent)}
.evtag-tool,.evtag-toolres{background:rgba(107,107,123,.15);color:var(--text-muted)}
.evtag-error{background:rgba(229,83,91,.15);color:var(--red)}
.evtag-stream{background:rgba(229,168,69,.15);color:var(--amber)}
.evtag-thinking{background:rgba(68,201,161,.15);color:var(--green)}
.evtag-message{background:rgba(124,138,255,.15);color:var(--accent)}
.evtag-usage{background:rgba(107,107,123,.15);color:var(--text-muted)}
.evtag-sys{background:rgba(107,107,123,.15);color:var(--text-muted)}

/* ── Preview text (inline, one line, clickable) ──────── */
.ev-preview{
  font-size:12px;color:var(--text-muted);cursor:pointer;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  flex:1;min-width:0;line-height:1.5;
  transition:color var(--ease) 150ms;
}
.ev-preview:hover{color:var(--text)}

/* ── Event detail (key-value, hidden by default) ────── */
.ev-detail{
  display:none;margin-top:8px;padding:10px 14px;
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius-sm);font-family:var(--font-mono);font-size:12px;
  position:relative;
}
.ev-detail.open{display:block}
.ev-detail .kv{display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);line-height:1.5;align-items:flex-start}
.ev-detail .kv:last-child{border-bottom:none}
.ev-detail .kv-key{color:var(--accent);font-weight:600;white-space:nowrap;min-width:80px;flex-shrink:0;font-size:11px;text-transform:uppercase;letter-spacing:.3px}
.ev-detail .kv-val{color:var(--text-muted);word-break:break-word;white-space:pre-wrap}
.copy-btn{
  position:absolute;top:6px;right:6px;padding:2px 8px;font-size:10px;
  background:var(--surface3);border:1px solid var(--border);
  color:var(--text-muted);border-radius:4px;cursor:pointer;
  opacity:0;transition:opacity var(--ease) 150ms;
  font-family:var(--font-mono);line-height:1.6;
}
.ev-detail:hover .copy-btn{opacity:1}

/* ── Overview page ────────────────────────────────────── */
.page-header{margin-bottom:24px}
.page-header h2{font-size:18px;font-weight:600;color:var(--text)}
.page-header p{font-size:13px;color:var(--text-muted);margin-top:4px}
.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:28px}
.stat-card{
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius-md);padding:18px 20px;
  transition:border-color var(--ease) 150ms,transform var(--ease) 150ms;
}
.stat-card:hover{border-color:var(--border-light);transform:translateY(-1px)}
.stat-card .stat-value{font-size:24px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums}
.stat-card .stat-label{font-size:12px;color:var(--text-muted);margin-top:4px}
.stat-card .stat-sub{font-size:11px;color:var(--text-dim);margin-top:2px}
.section-header{
  display:flex;align-items:center;justify-content:space-between;
  margin-bottom:12px;
}
.section-header h3{font-size:14px;font-weight:600;color:var(--text)}
.activity-list{
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius-md);overflow:hidden;
}
.activity-item{
  display:flex;align-items:center;gap:10px;
  padding:12px 16px;border-bottom:1px solid var(--border);
  font-size:13px;transition:background var(--ease) 150ms;
}
.activity-item:last-child{border-bottom:none}
.activity-item:hover{background:var(--surface2)}
.activity-item .status-badge{
  font-size:10px;padding:2px 8px;border-radius:99px;font-weight:600;white-space:nowrap;
  font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.3px;
}
.status-badge.done{background:rgba(68,201,161,.15);color:var(--green)}
.status-badge.active{background:rgba(124,138,255,.15);color:var(--accent)}
.status-badge.failed{background:rgba(229,83,91,.15);color:var(--red)}
.activity-item{flex-direction:column;align-items:stretch;gap:4px;padding:10px 16px;cursor:pointer}
.activity-item .apreview{font-size:12px;color:var(--text);line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.activity-item .ameta{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.activity-item .ameta .atag{font-size:9px;padding:1px 6px;border-radius:3px;font-family:var(--font-mono);letter-spacing:.2px;color:var(--text-dim);background:var(--surface2)}
.activity-item .ameta .atag.aid{color:var(--accent);background:rgba(124,138,255,.1)}
.activity-item .ameta .atag.arounds{color:var(--green);background:rgba(68,201,161,.1)}
.activity-item .time{font-size:11px;color:var(--text-dim);white-space:nowrap}
.quick-actions{display:flex;gap:8px;margin-top:16px}
.quick-actions a{
  padding:8px 18px;border-radius:var(--radius-sm);
  font-size:13px;font-weight:500;cursor:pointer;
  transition:background var(--ease) 150ms,color var(--ease) 150ms;
  text-decoration:none;
}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent-hover)}
.btn-secondary{background:var(--surface2);color:var(--text);border:1px solid var(--border)}
.btn-secondary:hover{background:var(--surface3)}

/* ── Settings page ───────────────────────────────────────── */
.settings-section{
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius-md);padding:20px 24px;margin-bottom:16px;
}
.settings-section h3{font-size:14px;font-weight:600;color:var(--text);margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.form-group{margin-bottom:14px}
.form-group:last-child{margin-bottom:0}
.form-label{display:block;font-size:12px;font-weight:500;color:var(--text-muted);margin-bottom:4px}
.form-input,.form-select{
  width:100%;padding:8px 12px;border-radius:var(--radius-sm);
  background:var(--surface2);border:1px solid var(--border);
  color:var(--text);font-size:13px;outline:none;transition:border-color var(--ease) 150ms;
  font-family:var(--font);
}
.form-input:focus,.form-select:focus{border-color:var(--accent)}
.form-input::placeholder{color:var(--text-dim)}
.form-input-mono{font-family:var(--font-mono);font-size:12px}
textarea.form-input{min-height:80px;resize:vertical;font-family:var(--font-mono);font-size:12px;line-height:1.5;tab-size:2}
.tag-editor{display:flex;flex-wrap:wrap;gap:6px;padding:8px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);min-height:36px}
.tag-item{display:flex;align-items:center;gap:4px;font-size:12px;padding:3px 8px;background:var(--surface3);border-radius:4px;color:var(--text);font-family:var(--font-mono)}
.tag-item .remove{cursor:pointer;color:var(--text-dim);font-size:14px;line-height:1;transition:color var(--ease) 150ms}
.tag-item .remove:hover{color:var(--red)}
.tag-input{flex:1;min-width:80px;border:none;background:transparent;color:var(--text);font-size:12px;outline:none;font-family:var(--font-mono)}
.form-actions{display:flex;align-items:center;gap:10px;margin-top:14px}
.btn-save{
  padding:7px 18px;border-radius:var(--radius-sm);font-size:12px;font-weight:600;
  background:var(--accent);color:#fff;border:none;cursor:pointer;
  transition:background var(--ease) 150ms,opacity var(--ease) 150ms;
}
.btn-save:hover{background:var(--accent-hover)}
.btn-save:disabled{opacity:.5;cursor:not-allowed}
.save-feedback{font-size:12px;font-weight:500;transition:opacity .3s;opacity:0}
.save-feedback.show{opacity:1}
.save-feedback.ok{color:var(--green)}
.save-feedback.err{color:var(--red)}

/* ── Domain panels ───────────────────────────────────── */
.domain-section{margin-bottom:12px}
.domain-panel{
  background:var(--surface2);border:1px solid var(--border);
  border-radius:var(--radius-sm);margin-bottom:8px;overflow:hidden;
}
.domain-header{
  display:flex;align-items:center;gap:8px;
  padding:10px 14px;cursor:pointer;user-select:none;
  font-size:13px;font-weight:600;color:var(--accent);
  font-family:var(--font-mono);transition:background var(--ease) 150ms;
}
.domain-header:hover{background:var(--surface3)}
.domain-header .arrow{font-size:10px;color:var(--text-dim);transition:transform var(--ease) 200ms}
.domain-header .arrow.open{transform:rotate(90deg)}
.domain-body{padding:10px 14px;border-top:1px solid var(--border);display:none}
.domain-body.open{display:block}
.backend-panel{
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius-sm);padding:10px 14px;margin-top:8px;
}
.backend-panel h4{font-size:11px;font-weight:600;color:var(--amber);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}

/* ── Settings sidebar ────────────────────────────────── */
.settings-wrap{display:flex;flex:1;overflow:hidden}
.settings-sidebar{
  width:220px;flex-shrink:0;overflow-y:auto;
  border-right:1px solid var(--border);background:var(--surface);
  padding:12px 0;
}
.settings-sidebar .sgroup{font-size:10px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;padding:8px 16px 4px}
.settings-sidebar .sitem{
  display:block;padding:7px 16px;font-size:13px;color:var(--text-muted);
  cursor:pointer;text-decoration:none;transition:all var(--ease) 150ms;
  border-left:2px solid transparent;
}
.settings-sidebar .sitem:hover{color:var(--text);background:var(--surface2)}
.settings-sidebar .sitem.active{color:var(--accent);background:var(--surface2);border-left-color:var(--accent)}
.settings-sidebar .sitem.sub{padding-left:28px;font-size:12px}
.settings-content{flex:1;overflow-y:auto;padding:24px 28px}
.empty-state{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  height:100%;color:var(--text-muted);text-align:center;padding:40px;
}
.empty-state .icon{font-size:40px;margin-bottom:12px;opacity:.2}
.empty-state p{font-size:13px;line-height:1.6}
.empty-state .hint{font-size:12px;color:var(--text-dim);margin-top:6px}

/* ── Loading ──────────────────────────────────────────── */
.loading{display:flex;align-items:center;justify-content:center;padding:40px;color:var(--text-dim);font-size:13px;gap:8px}
.spinner{width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── Responsive ───────────────────────────────────────── */
@media(max-width:768px){
  .topbar{padding:0 12px;gap:0}
  .topbar-logo{margin-right:12px;font-size:13px}
  .topbar-nav a{padding:0 10px;font-size:12px}
  .sidebar{width:220px}
  .page{padding:16px}
  .sessions-main{padding:16px}
  .stats-row{grid-template-columns:repeat(2,1fr)}
  .profile-badge{display:none}
}
`;

function html(st: DashboardState): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Executor Dashboard</title>
<style>${CSS}</style>
</head><body>

<!-- Top Bar -->
<header class="topbar">
  <div class="topbar-logo"><span>◆</span> base-mesh</div>
  <nav class="topbar-nav">
    <a href="#overview" class="active" data-page="overview">≈Overview</a>
    <a href="#sessions" data-page="sessions">≈Sessions</a>
    <a href="#settings" data-page="settings">≈Settings</a>
  </nav>
  <div class="topbar-right">
    <span class="status-dot" id="statusDot"></span>
    <span id="statusLabel">loading</span>
    <span class="profile-badge">${st.profile}</span>
  </div>
</header>

<!-- Main Content -->
<div class="main-wrap">

  <!-- Overview Page -->
  <div class="page active" id="page-overview">
    <div class="page-header">
      <h2>Overview</h2>
      <p>Executor status and recent activity</p>
    </div>
    <div class="stats-row" id="statsRow">
      <div class="stat-card"><div class="stat-value" id="statTickets">—</div><div class="stat-label">Tickets Processed</div></div>
      <div class="stat-card"><div class="stat-value" id="statUptime">—</div><div class="stat-label">Uptime</div></div>
      <div class="stat-card"><div class="stat-value" id="statActive">—</div><div class="stat-label">Active Ticket</div></div>
      <div class="stat-card"><div class="stat-value" id="statVersion">${PKG_VERSION}</div><div class="stat-label">Version</div></div>
    </div>
    <div class="section-header"><h3>Recent Activity</h3></div>
    <div class="activity-list" id="activityList"><div class="empty-state"><div class="icon">◈</div><p>No session data yet</p><div class="hint">Start the executor to begin collecting session logs</div></div></div>
    <div class="quick-actions">
      <a href="#sessions" class="btn-primary" data-nav>View Sessions</a>
      <a href="#settings" class="btn-secondary" data-nav>Edit Settings</a>
    </div>
  </div>

  <!-- Sessions Page -->
  <div class="page sessions-page" id="page-sessions">
    <div class="sidebar" id="sessionSidebar">
      <div class="sidebar-header"><input class="sidebar-search" id="sessionSearch" type="text" placeholder="Search tickets…"></div>
      <div class="filter-bar" id="filterBar"></div>
      <div class="sidebar-list" id="ticketList"></div>
    </div>
    <div class="sessions-main" id="sessionMain"><div class="empty-state"><div class="icon">◆</div><p>Select a ticket from the sidebar</p></div></div>
  </div>

  <!-- Settings Page -->
  <div class="page" id="page-settings">
    <div class="settings-wrap">
      <nav class="settings-sidebar" id="settingsSidebar"></nav>
      <div class="settings-content" id="settingsContent">
        <div class="empty-state"><div class="icon">⚙</div><p>Loading settings…</p></div>
      </div>
    </div>
  </div>

</div>

<script>
// ── Helpers ─────────────────────────────────────────────
function E(v){return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function S(v,m){var t=typeof v==='string'?v:(v?JSON.stringify(v,null,2):'');return t.slice(0,m||50000)}
function tag(c,t){return'<span class="tag t-'+c+'">'+t+'</span>'}
function qs(s){return document.querySelector(s)}
function qsa(s){return document.querySelectorAll(s)}

// ── Status poll ─────────────────────────────────────────
function pollStatus(){
  fetch('/api/status').then(function(r){return r.json()}).then(function(s){
    var dot=document.getElementById('statusDot');
    var label=document.getElementById('statusLabel');
    dot.className='status-dot '+(s.connected?'on':'off');
    label.textContent=s.connected?'Connected':'Disconnected';
    // Update overview stats
    var st=document.getElementById('statTickets');
    if(st)st.textContent=s.ticketsProcessed;
    var su=document.getElementById('statUptime');
    if(su)su.textContent=s.uptime;
    var sa=document.getElementById('statActive');
    if(sa){
      if(s.activeTicket){
        sa.textContent=s.activeTicket.slice(0,20);
        sa.title=s.activeTicket;
      }else{
        sa.textContent='—';
        sa.title='';
      }
    }
  }).catch(function(){});
}
setInterval(pollStatus,5000);pollStatus();

// ── SPA Router ──────────────────────────────────────────
function showPage(name){
  qsa('.page').forEach(function(p){p.classList.remove('active')});
  var el=document.getElementById('page-'+name);
  if(el)el.classList.add('active');
  qsa('.topbar-nav a').forEach(function(a){a.classList.toggle('active',a.dataset.page===name)});
  if(name==='sessions')initSessions();
  if(name==='settings')initSettings();
  if(name==='overview')refreshOverview();
}
function onHash(){
  var hash=location.hash.slice(1)||'overview';
  showPage(hash);
}
window.addEventListener('hashchange',onHash);
document.addEventListener('click',function(e){
  var nav=e.target.closest('[data-nav]');
  if(nav){e.preventDefault();location.hash=nav.getAttribute('href').replace('#','')}
});
setTimeout(function(){if(!location.hash)location.hash='overview';else onHash()},0);

// ── Overview page ───────────────────────────────────────
function refreshOverview(){
  fetch('/api/tickets').then(function(r){return r.json()}).then(function(tickets){
    var list=document.getElementById('activityList');
    if(!tickets||!tickets.length){
      list.innerHTML='<div class="empty-state"><div class="icon">◈</div><p>No session data yet</p><div class="hint">Start the executor to begin collecting session logs</div></div>';
      return;
    }
    var h='';
    tickets.slice(0,10).forEach(function(t){
      var time=t.updatedAt?new Date(t.updatedAt).toLocaleString('zh'):'';
      var preview=t.preview||'(no messages)';
      h+='<div class="activity-item" onclick="location.hash=\\'sessions\\'"><span class="apreview">'+E(preview)+'</span><div class="ameta"><span class="atag aid">'+E(t.ticketId)+'</span><span class="atag arounds">'+t.sessionCount+' round'+(t.sessionCount!==1?'s':'')+'</span><span class="atag">'+E(time)+'</span></div></div>';
    });
    list.innerHTML=h;
  }).catch(function(){});
}

// ── Sessions page ───────────────────────────────────────
var _tickets=[],_selectedTicket='';

var EVTAGS={execution_start:'evtag-exec',execution_end:'evtag-done',result:'evtag-result',error:'evtag-error',assistant:'evtag-assistant',user:'evtag-user',tool_use:'evtag-tool',tool_result:'evtag-toolres',stream_event:'evtag-stream',thinking:'evtag-thinking',message:'evtag-message',usage:'evtag-usage',system:'evtag-sys'};
var EVLABELS={execution_start:'EXEC',execution_end:'DONE',result:'RESULT',error:'ERROR',assistant:'CLAUDE',user:'USER',tool_use:'TOOL',tool_result:'TOOL-RESULT',stream_event:'STREAM',thinking:'THINKING',message:'MESSAGE',usage:'USAGE',system:'SYS'};

function tagType(t){return EVTAGS[t]||'evtag-sys'}
function tagLabel(t){return EVLABELS[t]||t.toUpperCase()}

function toggleEvDetail(el){
  var d=el.parentElement.nextElementSibling;
  if(d&&d.classList.contains('ev-detail'))d.classList.toggle('open');
}
function fmtTime(ts){if(!ts)return'';var d=new Date(ts);return d.toLocaleTimeString('zh',{hour12:false})+'.'+String(d.getMilliseconds()).padStart(3,'0')}

function renderBlocks(container,time){
  var msg=container.message||{},usage=msg.usage;
  var texts=[],toolCalls=0,toolResults=0,thinkings=0;
  (msg.content||[]).forEach(function(b){
    if(b.type==='text')texts.push(b);
    else if(b.type==='tool_use')toolCalls++;
    else if(b.type==='tool_result')toolResults++;
    else if(b.type==='thinking')thinkings++;
  });
  var preview='';
  if(texts.length)preview=texts[0].text;
  if(toolCalls)preview+=(preview?' · ':'')+toolCalls+' tool';
  if(toolResults)preview+=(preview?' · ':'')+toolResults+' result';
  if(thinkings)preview+=(preview?' · ':'')+thinkings+' thought';
  if(!preview)preview='(no content)';
  var kvs='';
  if(texts.length)kvs+='<div class="kv"><span class="kv-key">Response</span><span class="kv-val">'+E(texts.map(function(t){return t.text}).join('\\n\\n'))+'</span></div>';
  if(toolCalls){
    var tc=[];
    (msg.content||[]).forEach(function(b){if(b.type==='tool_use')tc.push(b.name+': '+S(b.input,200))});
    kvs+='<div class="kv"><span class="kv-key">Tools</span><span class="kv-val">'+E(tc.join('\\n'))+'</span></div>';
  }
  if(thinkings){
    var th=[];
    (msg.content||[]).forEach(function(b){if(b.type==='thinking')th.push(b.thinking)});
    kvs+='<div class="kv"><span class="kv-key">Thinking</span><span class="kv-val">'+E(th.join('\\n\\n'))+'</span></div>';
  }
  if(usage)kvs+='<div class="kv"><span class="kv-key">Tokens</span><span class="kv-val">'+(usage.input_tokens||0)+' in / '+(usage.output_tokens||0)+' out</span></div>';
  var row='<div class="entry assistant"><div class="dot"></div><div class="body"><div class="label"><span class="time">'+time+'</span><span class="evtag evtag-assistant">CLAUDE</span><span class="ev-preview" onclick="toggleEvDetail(this)">'+E(preview)+'</span></div>';
  if(kvs)row+='<div class="ev-detail"><span class="copy-btn" onclick="event.stopPropagation();navigator.clipboard.writeText(this.parentElement.textContent.trim())">copy</span>'+kvs+'</div>';
  row+='</div></div>';
  return row;
}

function renderEntry(e){
  var time=fmtTime(e.timestamp);
  var tag=tagType(e.type),label=tagLabel(e.type);
  var preview='',kvs='',cls='tool';
  if(e.type==='execution-start'){
    cls='tool';
    preview='Prompt: '+(e.promptLength||'?')+' chars';
    kvs='<div class="kv"><span class="kv-key">Prompt Length</span><span class="kv-val">'+(e.promptLength||0)+' chars</span></div>';
    if(e.prompt)kvs+='<div class="kv"><span class="kv-key">Prompt</span><span class="kv-val">'+E(S(e.prompt,5000))+'</span></div>';
    if(e.userTurns&&e.userTurns.length){
      (e.userTurns||[]).forEach(function(ut,i){
        kvs+='<div class="kv"><span class="kv-key">Turn '+(i+1)+'</span><span class="kv-val">'+E(String(ut.content||ut).slice(0,300))+'</span></div>';
      });
    }
    if(e.ticketId)kvs+='<div class="kv"><span class="kv-key">Ticket</span><span class="kv-val">'+E(e.ticketId)+'</span></div>';
  }else if(e.type==='execution-end'){
    cls='tool';
    var el=Math.round((e.elapsedMs||0)/1000);
    preview='elapsed '+el+'s'+(e.exitCode?' exit '+e.exitCode:'');
    kvs='<div class="kv"><span class="kv-key">Elapsed</span><span class="kv-val">'+el+'s</span></div>';
    if(e.exitCode)kvs+='<div class="kv"><span class="kv-key">Exit Code</span><span class="kv-val">'+e.exitCode+'</span></div>';
    if(e.stdout)kvs+='<div class="kv"><span class="kv-key">Stdout</span><span class="kv-val">'+E(S(e.stdout,5000))+'</span></div>';
    if(e.stderr)kvs+='<div class="kv"><span class="kv-key">Stderr</span><span class="kv-val">'+E(S(e.stderr,5000))+'</span></div>';
  }else if(e.type==='result'){
    cls='assistant';
    var ans=e.answer||e.result||'';
    preview=String(ans);
    kvs='<div class="kv"><span class="kv-key">Answer</span><span class="kv-val">'+E(ans||'(empty)')+'</span></div>';
  }else if(e.type==='error'){
    cls='error';
    var em=e.message||e.error||'';
    preview=String(em);
    kvs='<div class="kv"><span class="kv-key">Error</span><span class="kv-val">'+E(S(em,5000))+'</span></div>';
  }else if(e.type==='assistant'){
    return renderBlocks(e,time);
  }else if(e.type==='user'){
    cls='tool';
    var uc=(e.message&&e.message.content)||[],uBlocks=Array.isArray(uc)?uc:[uc];
    var txts=[],fCount=0;
    uBlocks.forEach(function(b){
      if(b.type==='text')txts.push(b.text);
      else if(b.type==='file')fCount++;
      else if(b.type==='tool_result')txts.push('[result]');
    });
    preview=(txts.join(' ')||'(no text)')+(fCount?' · '+fCount+' file':'');
    kvs=uBlocks.map(function(b){
      if(b.type==='text')return'<div class="kv"><span class="kv-key">Text</span><span class="kv-val">'+E(b.text)+'</span></div>';
      if(b.type==='file')return'<div class="kv"><span class="kv-key">File</span><span class="kv-val">'+E(b.name||'unnamed')+(b.mime_type?' ('+b.mime_type+')':'')+'</span></div>';
      if(b.type==='tool_result')return'<div class="kv"><span class="kv-key">Tool Result</span><span class="kv-val">'+E(S(b.content,3000))+'</span></div>';
      return'<div class="kv"><span class="kv-key">Content</span><span class="kv-val">'+E(S(b,1000))+'</span></div>';
    }).join('');
  }else if(e.type==='tool_use'){
    cls='tool';
    var tName=e.tool||e.name||'?';
    preview=tName+' · '+S(e.input,120);
    kvs='<div class="kv"><span class="kv-key">Tool</span><span class="kv-val">'+E(tName)+'</span></div>';
    kvs+='<div class="kv"><span class="kv-key">Input</span><span class="kv-val">'+E(typeof e.input==='string'?e.input:S(e.input,5000))+'</span></div>';
  }else if(e.type==='tool_result'){
    cls='tool';
    var tResTool=e.tool?' · '+e.tool:'';
    preview=(e.is_error?'error':'success')+tResTool+(e.content?' · '+String(e.content).length+' chars':' · empty');
    kvs='<div class="kv"><span class="kv-key">Status</span><span class="kv-val">'+(e.is_error?'Error':'Success')+'</span></div>';
    if(e.tool)kvs+='<div class="kv"><span class="kv-key">Tool</span><span class="kv-val">'+E(e.tool)+'</span></div>';
    if(e.content)kvs+='<div class="kv"><span class="kv-key">Content</span><span class="kv-val">'+E(S(e.content,5000))+'</span></div>';
  }else if(e.type==='thinking'){
    cls='tool';
    preview=String(e.content||'(thinking)').slice(0,80);
    kvs='<div class="kv"><span class="kv-key">Thinking</span><span class="kv-val">'+E(e.content||'')+'</span></div>';
  }else if(e.type==='message'){
    cls='assistant';
    preview=String(e.content||'').slice(0,80);
    kvs='<div class="kv"><span class="kv-key">Message</span><span class="kv-val">'+E(e.content||'')+'</span></div>';
  }else if(e.type==='usage'){
    cls='tool';
    preview='in '+(e.inputTokens||0)+' · out '+(e.outputTokens||0)+' · cacheR '+(e.cacheReadTokens||0)+' · cacheW '+(e.cacheWriteTokens||0);
    kvs='<div class="kv"><span class="kv-key">Input Tokens</span><span class="kv-val">'+(e.inputTokens||0)+'</span></div>';
    kvs+='<div class="kv"><span class="kv-key">Output Tokens</span><span class="kv-val">'+(e.outputTokens||0)+'</span></div>';
    if(e.cacheReadTokens)kvs+='<div class="kv"><span class="kv-key">Cache Read</span><span class="kv-val">'+e.cacheReadTokens+'</span></div>';
    if(e.cacheWriteTokens)kvs+='<div class="kv"><span class="kv-key">Cache Write</span><span class="kv-val">'+e.cacheWriteTokens+'</span></div>';
  }else if(e.type==='stream_event'){
    cls='tool';
    var se=e.event||{};
    if(se.delta&&se.delta.type==='text_delta'){
      preview=(se.delta.text||'');
      kvs='<div class="kv"><span class="kv-key">Delta</span><span class="kv-val">'+E(se.delta.text||'')+'</span></div>';
    }else{preview='stream event';kvs='<div class="kv"><span class="kv-key">Event</span><span class="kv-val">'+E(S(se,2000))+'</span></div>'}
  }else if(e.type==='system'){
    cls='tool';
    var sub=e.subtype||'';
    preview=sub.replace(/_/g,' ');
    if(sub==='init'){
      kvs='<div class="kv"><span class="kv-key">Model</span><span class="kv-val">'+E(e.model||'?')+'</span></div>';
      kvs+='<div class="kv"><span class="kv-key">Tools</span><span class="kv-val">'+E(S(e.tools,500))+'</span></div>';
    }else if(sub==='turn_duration'){kvs='<div class="kv"><span class="kv-key">Duration</span><span class="kv-val">'+(e.durationMs||0)+' ms</span></div>'
    }else if(sub==='thinking_tokens'){return''
    }else if(sub==='api_error'){kvs='<div class="kv"><span class="kv-key">Error</span><span class="kv-val">'+E(S(e.error,2000))+'</span></div>'
    }else if(sub==='compact_boundary'){kvs='<div class="kv"><span class="kv-key">Content</span><span class="kv-val">'+E(e.content||S(e.compactMetadata,500))+'</span></div>'
    }else if(sub==='informational'){kvs='<div class="kv"><span class="kv-key">Info</span><span class="kv-val">'+E(e.content||'')+'</span></div>'
    }else{kvs='<div class="kv"><span class="kv-key">Data</span><span class="kv-val">'+E(S(e,1000))+'</span></div>'}
  }else if(e.type==='status'){return''}
  else{cls='tool';preview=e.content?String(e.content):(e.type||'event');kvs='';for(var k in e){if(k==='type'||k==='timestamp'||!e.hasOwnProperty(k))continue;var v=e[k];kvs+='<div class="kv"><span class="kv-key">'+k.replace(/([A-Z])/g,' $1').replace(/^./,function(s){return s.toUpperCase()})+'</span><span class="kv-val">'+E(typeof v==='string'?S(v,5000):S(v,3000))+'</span></div>'}}
  var row='<div class="entry '+cls+'"><div class="dot"></div><div class="body"><div class="label"><span class="time">'+time+'</span><span class="evtag '+tag+'">'+label+'</span>';
  if(preview)row+='<span class="ev-preview" onclick="toggleEvDetail(this)">'+E(preview)+'</span>';
  row+='</div>';
  if(kvs)row+='<div class="ev-detail"><span class="copy-btn" onclick="event.stopPropagation();navigator.clipboard.writeText(this.parentElement.textContent.trim())">copy</span>'+kvs+'</div>';
  row+='</div></div>';
  return row;
}

function roundPreview(rd){
  var preview='',first=rd.entries[0];
  if(first&&first.userTurns&&first.userTurns.length)preview=first.userTurns[0].content.slice(0,60);
  for(var ei=0;ei<rd.entries.length;ei++){
    var e=rd.entries[ei];
    if(e.type==='result'||e.type==='execution-end'){
      if(e.answer||e.stdout){preview=(e.answer||e.stdout||'').slice(0,60);break}
    }
  }
  return preview||'(no input)';
}

function loadTicket(id){
  _selectedTicket=id;
  [].slice.call(document.querySelectorAll('.ticket-item')).forEach(function(el){el.classList.toggle('active',el.dataset.id===id)});
  var m=document.getElementById('sessionMain');
  m.innerHTML='<div class="loading"><div class="spinner"></div>Loading…</div>';
  fetch('/api/sessions/'+id).then(function(r){return r.json()}).then(function(d){
    var rounds=d.rounds||[];
    if(!rounds.length){m.innerHTML='<div class="empty-state"><p>No data for this ticket</p></div>';return}
    var h='<h3 style="font-size:14px;color:var(--accent);margin-bottom:16px;font-family:var(--font-mono)">'+E(id)+'</h3>';
    for(var ri=0;ri<rounds.length;ri++){
      var rd=rounds[ri],pv=roundPreview(rd);
      var collapsed=ri>=2?'':' open';
      h+='<div class="round-section" id="round-'+(ri+1)+'">';
      h+='<div class="round-header" onclick="toggleRound('+(ri+1)+')"><span class="collapse'+(collapsed?' open':'')+'">\\u25B6</span><span class="round-num">Round '+(ri+1)+'</span><span class="round-id">'+E(rd.roundId)+'</span><span class="round-preview">'+E(pv)+'</span></div>';
      h+='<div class="round-body'+collapsed+'" id="roundBody-'+(ri+1)+'">';
      var start=rd.entries[0];
      if(start&&start.userTurns&&start.userTurns.length){
        for(var ui=0;ui<start.userTurns.length;ui++){
          var ut=start.userTurns[ui];
          h+='<div class="entry"><div class="dot" style="border-color:var(--green);background:rgba(68,201,161,.2)"></div><div class="body"><div class="turn-role">User message</div><div class="turn-text">'+E(ut.content)+'</div></div></div>';
        }
      }
      h+='<div class="timeline">';
      for(var ei=0;ei<rd.entries.length;ei++){
        if(_filters[rd.entries[ei].type]===0)continue;
        h+=renderEntry(rd.entries[ei]);
      }
      h+='</div></div></div>';
    }
    m.innerHTML=h;
  }).catch(function(err){m.innerHTML='<div class="empty-state"><p>Error: '+E(err.message)+'</p></div>'});
}

function toggleRound(n){
  var body=document.getElementById('roundBody-'+n);
  if(!body)return;
  body.classList.toggle('open');
  var header=body.previousElementSibling;
  if(header)header.querySelector('.collapse').classList.toggle('open');
}

// ── Event filters ────────────────────────────────────────
var FILTER_DEFAULTS={
  'execution-start':1,'execution-end':1,'result':1,'error':1,
  'assistant':1,'user':1,'thinking':1,'message':1,
  'stream_event':1,'system':1,
  'tool_use':0,'tool_result':0,'usage':0
};
var _filters={};

function loadFilters(){
  try{var s=JSON.parse(localStorage.getItem('bam-filters'));if(s)for(var k in s)_filters[k]=s[k]}catch(e){}
  for(var k in FILTER_DEFAULTS)if(_filters[k]===undefined)_filters[k]=FILTER_DEFAULTS[k];
}
function saveFilters(){
  try{localStorage.setItem('bam-filters',JSON.stringify(_filters))}catch(e){}
}

function toggleFilter(type){
  _filters[type]=_filters[type]?0:1;
  saveFilters();renderFilterBar();
  if(_selectedTicket)loadTicket(_selectedTicket);
}

function renderFilterBar(){
  var bar=document.getElementById('filterBar');
  if(!bar)return;
  var order=['execution-start','execution-end','assistant','thinking','message','user','tool_use','tool_result','error','stream_event','system','usage'];
  var h='';
  order.forEach(function(type){
    if(_filters[type]===undefined)_filters[type]=FILTER_DEFAULTS[type]!==0?1:0;
    var label=EVLABELS[type]||type.toUpperCase();
    h+='<span class="filter-chip '+(_filters[type]?'on':'off')+'" data-type="'+type+'" onclick="toggleFilter(\\''+type+'\\')">'+label+'</span>';
  });
  bar.innerHTML=h;
}

function initSessions(){
  loadFilters();
  renderFilterBar();
  fetch('/api/tickets').then(function(r){return r.json()}).then(function(tickets){
    _tickets=tickets||[];
    renderTicketList();
    if(!_selectedTicket&&_tickets.length)loadTicket(_tickets[0].ticketId);
  }).catch(function(){});
}

function renderTicketList(filter){
  var list=document.getElementById('ticketList');
  var f=(filter||'').toLowerCase();
  var filtered=_tickets.filter(function(t){return t.ticketId.toLowerCase().includes(f)});
  if(!filtered.length){
    list.innerHTML='<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:12px">No tickets matching</div>';
    return;
  }
  var h='';
  filtered.forEach(function(t){
    var time=t.updatedAt?new Date(t.updatedAt).toLocaleString('zh'):'';
    var preview=t.preview||'(no messages)';
    h+='<div class="ticket-item'+(t.ticketId===_selectedTicket?' active':'')+'" data-id="'+t.ticketId+'" onclick="loadTicket(\\''+t.ticketId+'\\')">';
    h+='<div class="info"><span class="ticket-preview">'+E(preview)+'</span>';
    h+='<div class="ticket-meta"><span class="meta-tag meta-id">'+E(t.ticketId)+'</span><span class="meta-tag meta-rounds">'+t.sessionCount+' round'+(t.sessionCount!==1?'s':'')+'</span><span class="meta-tag">'+E(time)+'</span></div></div></div>';
  });
  list.innerHTML=h;
}

document.addEventListener('DOMContentLoaded',function(){
  var search=document.getElementById('sessionSearch');
  if(search)search.addEventListener('input',function(){renderTicketList(this.value)});
});

// ── Settings page ────────────────────────────────────────
function initSettings(){
  var sidebar=document.getElementById('settingsSidebar');
  var content=document.getElementById('settingsContent');
  if(!sidebar||!content)return;
  content.innerHTML='<div class="loading"><div class="spinner"></div>Loading config…</div>';
  fetch('/api/config').then(function(r){return r.json()}).then(function(cfg){
    _settingsCfg=cfg;
    renderSettingsSidebar(cfg);
    showSettingsTab('general');
  }).catch(function(err){
    content.innerHTML='<div class="empty-state"><p>Error: '+E(err.message)+'</p></div>';
  });
}

function renderSettingsSidebar(cfg){
  var side=document.getElementById('settingsSidebar');
  var domains=Array.isArray(cfg.domains)?cfg.domains:[];
  var h='<div class="sgroup">General</div><a class="sitem active" data-stab="general" >General</a>';
  h+='<div class="sgroup" style="margin-top:8px">Execution</div><a class="sitem" data-stab="defaultDomain" >Default Domain</a>';
  h+='<div class="sgroup" style="margin-top:8px">Domains</div>';
  if(domains.length){
    domains.forEach(function(n){
      h+='<a class="sitem sub" data-stab="domain-'+n+'" >'+E(n)+'</a>';
    });
  }
  h+='<a class="sitem sub" style="color:var(--text-dim);font-size:12px;cursor:pointer" onclick="addDomain()">+ Add Domain</a>';
  side.innerHTML=h;
}

document.getElementById('settingsSidebar').addEventListener('click',function(e){var t=e.target.closest('.sitem');if(t&&t.dataset.stab)showSettingsTab(t.dataset.stab)});

function showSettingsTab(tab){
  qsa(\'#settingsSidebar .sitem\').forEach(function(el){el.classList.toggle(\'active\',el.dataset.stab===tab)});
  var content=document.getElementById('settingsContent');
  var cfg=_settingsCfg;
  if(!cfg)return;

  if(tab==='general'){
    var h='<div class="page-header"><h2>General</h2><p>Executor connection and behaviour</p></div>';
    h+='<div class="settings-section"><h3>Connection</h3><div class="form-group"><label class="form-label">Coordinator URL</label><input class="form-input form-input-mono" id="cfg-coordinatorUrl" value="'+E(cfg.coordinatorUrl||\'\')+\'" placeholder="ws://localhost:8765"></div><div class="form-actions"><button class="btn-save" onclick="saveGeneral()">Save</button><span class="save-feedback" id="fb-general"></span></div></div>';
    h+='<div class="settings-section"><h3>System Prompt</h3><div class="form-group"><label class="form-label">Sent to the AI backend</label><textarea class="form-input" id="cfg-prompt" rows="5">'+E(cfg.prompt||\'\')+'</textarea></div><div class="form-actions"><button class="btn-save" onclick="saveGeneral()">Save</button><span class="save-feedback" id="fb-general"></span></div></div>';
    h+='<div class="settings-section"><h3>Sessions & Logs</h3><div class="form-group"><label class="form-label">Session Directory</label><input class="form-input form-input-mono" id="cfg-sessionDir" value="'+E(cfg.sessionDir||\'\')+\'" placeholder="~/.bam/claude/sessions"></div><div class="form-actions"><button class="btn-save" onclick="saveGeneral()">Save</button><span class="save-feedback" id="fb-general"></span></div></div>';
    h+='<div class="settings-section"><h3>Human-in-the-Loop</h3>';
    h+='<div class="form-group"><label class="form-label">HITL Mode</label><select class="form-select" id="cfg-hitl"><option value="off"'+sel(cfg.hitl,\'off\')+'>Off</option><option value="auto"'+sel(cfg.hitl,\'auto\')+'>Auto</option><option value="always"'+sel(cfg.hitl,\'always\')+'>Always</option></select></div>';
    h+='<div class="form-group"><label class="form-label">HITL Policy</label><select class="form-select" id="cfg-hitlPolicy"><option value="default"'+sel(cfg.hitlPolicy,\'default\')+'>Default</option><option value="off"'+sel(cfg.hitlPolicy,\'off\')+'>Off</option><option value="auto"'+sel(cfg.hitlPolicy,\'auto\')+'>Auto</option><option value="always"'+sel(cfg.hitlPolicy,\'always\')+'>Always</option></select></div>';
    h+='<div class="form-actions"><button class="btn-save" onclick="saveGeneral()">Save</button><span class="save-feedback" id="fb-general"></span></div></div>';
    h+='<div class="settings-section"><h3>Advanced</h3><div class="form-group" style="display:flex;align-items:center;gap:10px"><label class="form-label" style="margin:0">Self-check on startup</label><input type="checkbox" id="cfg-selfCheck"\'+(cfg.selfCheck?\' checked\':\'\')+' style="accent-color:var(--accent)"></div>';
    h+='<div class="form-group"><label class="form-label">HTTP Download Timeout (seconds)</label><input class="form-input form-input-mono" id="cfg-httpDownloadTimeout" value="\'+(cfg.httpDownloadTimeout||\'\')+\'" placeholder="30"></div>';
    h+='<div class="form-actions"><button class="btn-save" onclick="saveGeneral()">Save</button><span class="save-feedback" id="fb-general"></span></div></div>';
    content.innerHTML=h;

  }else if(tab===\'defaultDomain\'){
    var knownBkNames=[\'antigravity\',\'claude\',\'codex\',\'opencode\'];
    var _cfgBkNames=Object.keys((cfg.defaultDomain&&cfg.defaultDomain.backends)||{});
    _cfgBkNames.forEach(function(n){if(knownBkNames.indexOf(n)<0)knownBkNames.push(n)});
    var dd=cfg.defaultDomain||{};
    var h=\'<div class="page-header"><h2>Default Domain</h2><p>Baseline configuration inherited by all domains</p></div>\';
    h+=buildFullDomainForm(\'dd\',dd,false,knownBkNames);
    h+=\'<div class="form-actions" style="margin-top:16px"><button class="btn-save" onclick="saveDefaultDomain()">Save Default Domain</button><span class="save-feedback" id="fb-defaultDomain"></span></div>\';
    content.innerHTML=h;

  }else if(tab && tab.indexOf(\'domain-\')===0){
    var name=tab.slice(7);
    var dc=cfg.domainsConfig||{};
    var dcfg=dc[name]||{};
    var knownBkNames=[\'antigravity\',\'claude\',\'codex\',\'opencode\'];
    var _cfgBkNames=Object.keys((cfg.defaultDomain&&cfg.defaultDomain.backends)||{});
    _cfgBkNames.forEach(function(n){if(knownBkNames.indexOf(n)<0)knownBkNames.push(n)});
    var h=\'<div class="page-header"><h2>Domain: \'+E(name)+\'</h2><p style="font-size:12px;color:var(--text-dim)">Values left empty inherit from Default Domain</p></div>\';
    h+=\'<div style="margin-bottom:12px"><span style="font-size:11px;color:var(--red);cursor:pointer" onclick="removeDomain(\\\'\'+name+\'\\\')">\\u2715 Remove this domain</span></div>\';
    h+=buildFullDomainForm(\'dd-\'+name,dcfg,true,knownBkNames);
    h+=\'<div class="form-actions" style="margin-top:16px"><button class="btn-save" onclick="saveDomain(\\\'\'+name+\'\\\')">Save Domain</button><span class="save-feedback" id="dbfb-\'+name+\'"></span></div>\';
    content.innerHTML=h;
  }
}

function saveGeneral(){
  var fb=document.getElementById('fb-general');
  if(!fb)return;
  fb.className='save-feedback';fb.textContent='';
  var payload={};
  payload.coordinatorUrl=document.getElementById('cfg-coordinatorUrl').value||null;
  payload.prompt=document.getElementById('cfg-prompt').value||null;
  payload.sessionDir=document.getElementById('cfg-sessionDir').value||null;
  payload.hitl=document.getElementById('cfg-hitl').value;
  payload.hitlPolicy=document.getElementById('cfg-hitlPolicy').value;
  payload.selfCheck=document.getElementById('cfg-selfCheck').checked;
  var to=document.getElementById('cfg-httpDownloadTimeout').value;
  if(to)payload.httpDownloadTimeout=Number(to);
  doSave(payload,fb);
}

function saveDefaultDomain(){
  var fb=document.getElementById('fb-defaultDomain');
  if(!fb)return;
  fb.className='save-feedback';fb.textContent='';
  var dd=collectDomainConfig('dd');
  var payload={defaultDomain:Object.keys(dd).length?dd:null};
  doSave(payload,fb);
}

function doSave(payload,fb){
  qsa('.btn-save').forEach(function(b){b.disabled=true});
  fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(function(r){return r.json()})
    .then(function(r){
      if(r.success){
        fb.textContent=\'\\u2713 Saved (restart to apply)\';
        fb.className='save-feedback ok show';
        setTimeout(function(){fb.className='save-feedback'},3000);
      }else{
        fb.textContent=\'\\u2717 \'+E(r.error||\'Save failed\');
        fb.className='save-feedback err show';
      }
    })
    .catch(function(err){
      fb.textContent=\'\\u2717 \'+E(err.message);
      fb.className='save-feedback err show';
    })
    .finally(function(){qsa('.btn-save').forEach(function(b){b.disabled=false})});
}

function addDomain(){
  var name=prompt('New domain name:');
  if(!name||!name.trim())return;
  name=name.trim();
  var cfg=_settingsCfg;
  var domains=Array.isArray(cfg.domains)?cfg.domains:[];
  if(domains.indexOf(name)>=0){alert(\'Domain already exists\');return}
  domains.push(name);
  var dc=cfg.domainsConfig||{};
  dc[name]={};
  var payload={domains:domains,domainsConfig:dc};
  doSave(payload,{className:\'save-feedback\',textContent:\'\'});
  fetch('/api/config').then(function(r){return r.json()}).then(function(cfg2){
    _settingsCfg=cfg2;
    renderSettingsSidebar(cfg2);
    showSettingsTab(\'domain-\'+name);
  });
}

function removeDomain(name){
  if(!confirm(\'Remove domain "\'+name+\'" ?\'))return;
  var cfg=_settingsCfg;
  var domains=Array.isArray(cfg.domains)?cfg.domains:[];
  var idx=domains.indexOf(name);
  if(idx>=0)domains.splice(idx,1);
  var dc=cfg.domainsConfig||{};
  delete dc[name];
  var payload={domains:domains,domainsConfig:dc};
  doSave(payload,{className:\'save-feedback\',textContent:\'\'});
  fetch('/api/config').then(function(r){return r.json()}).then(function(cfg2){
    _settingsCfg=cfg2;
    renderSettingsSidebar(cfg2);
    showSettingsTab(\'defaultDomain\');
  });
}

/** Render a full domain config form (shared by default_domain and per-domain panels). */
function buildFullDomainForm(prefix,dcfg,inherit,knownBkNames){
  var ph=inherit?' (inherit)':'';
  var h='<div class="form-group"><label class="form-label">Backend</label><select class="form-select" id="'+prefix+'-backend"><option value="">'+(inherit?'(inherit)':'(default)')+'</option>';
  var bkOpts=knownBkNames||['antigravity','claude','codex','opencode'];
  bkOpts.forEach(function(n){h+='<option value="'+n+'"'+sel(dcfg.backend,n)+'>'+n+'</option>'});
  h+='</select></div>';
  h+='<div class="form-group"><label class="form-label">Timeout (s)</label><input class="form-input form-input-mono" id="'+prefix+'-timeout" value="'+(dcfg.timeout||'')+'" placeholder="(inherit)'+ph+'"></div>';
  h+='<div class="form-group"><label class="form-label">System Prompt</label><textarea class="form-input" id="'+prefix+'-sysPrompt" rows="3">'+E(dcfg.systemPrompt||'')+'</textarea></div>';
  // Backends
  h+='<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)"><label class="form-label" style="margin-bottom:8px;font-size:12px">Backend Configurations (leave empty to inherit)</label>';
  var bks=dcfg.backends||{};
  var existNames=Object.keys(bks);
  var allBkNames=knownBkNames&&knownBkNames.length?knownBkNames.slice():['antigravity','claude','codex','opencode'];
  existNames.forEach(function(n){if(allBkNames.indexOf(n)<0)allBkNames.push(n)});
  allBkNames.forEach(function(bk){
    var bc=bks[bk]||{};
    h+='<div class="backend-panel" id="'+prefix+'-bk-'+bk+'">';
    h+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><h4>'+E(bk)+'</h4><span class="rm-btn" data-rm="'+prefix+'-bk-'+bk+'" style="font-size:10px;color:var(--red);cursor:pointer">\\u2715 remove</span></div>';
    h+='<div class="form-group" style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div><label class="form-label">Command</label><input class="form-input form-input-mono" id="'+prefix+'-'+bk+'-cmd" value="'+E(bc.command||'')+'" placeholder="claude'+ph+'"></div>';
    h+='<div><label class="form-label">Model</label><input class="form-input form-input-mono" id="'+prefix+'-'+bk+'-model" value="'+E(bc.model||'')+'" placeholder="(optional)'+ph+'"></div></div>';
    h+='<div class="form-group" style="display:grid;grid-template-columns:1fr 2fr;gap:10px"><div><label class="form-label">Timeout (s)</label><input class="form-input form-input-mono" id="'+prefix+'-'+bk+'-timeout" value="'+(bc.timeout||'')+'" placeholder="600'+ph+'"></div>';
    h+='<div><label class="form-label">Args (comma separated)</label><input class="form-input form-input-mono" id="'+prefix+'-'+bk+'-args" value="'+E(Array.isArray(bc.args)?bc.args.join(', '):(bc.args||''))+'"></div></div>';
    h+='</div>';
  });
  h+='<div style="margin-top:6px;display:flex;gap:6px"><input class="form-input form-input-mono" id="'+prefix+'-newBkName" placeholder="New backend name" style="width:160px"><button class="btn-save" style="font-size:10px;padding:4px 10px" onclick="addBackend(\\''+prefix+'\\')">+ Add</button></div>';
  h+='</div>';
  return h;
}

function addBackend(prefix){
  var nameInput=document.getElementById(prefix+'-newBkName');
  var name=nameInput?nameInput.value.trim():'';
  if(!name)return;
  var panel=document.createElement('div');
  panel.className='backend-panel';
  panel.id=prefix+'-bk-'+name;
  panel.innerHTML='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><h4>'+E(name)+'</h4><span class="rm-btn" data-rm="'+prefix+'-bk-'+name+'" style="font-size:10px;color:var(--red);cursor:pointer">\\u2715 remove</span></div>'
    +'<div class="form-group" style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div><label class="form-label">Command</label><input class="form-input form-input-mono" id="'+prefix+'-'+name+'-cmd" placeholder="claude"></div>'
    +'<div><label class="form-label">Model</label><input class="form-input form-input-mono" id="'+prefix+'-'+name+'-model" placeholder="(optional)"></div></div>'
    +'<div class="form-group" style="display:grid;grid-template-columns:1fr 2fr;gap:10px"><div><label class="form-label">Timeout (s)</label><input class="form-input form-input-mono" id="'+prefix+'-'+name+'-timeout" placeholder="600"></div>'
    +'<div><label class="form-label">Args (comma separated)</label><input class="form-input form-input-mono" id="'+prefix+'-'+name+'-args"></div></div>';
  var container=nameInput.parentElement;
  container.parentElement.insertBefore(panel,container);
  nameInput.value='';
}

function collectDomainConfig(prefix){
  var dcfg={};
  var be=document.getElementById(prefix+'-backend');
  if(be&&be.value)dcfg.backend=be.value;
  var timeout=document.getElementById(prefix+'-timeout');
  if(timeout&&timeout.value)dcfg.timeout=Number(timeout.value);
  var sp=document.getElementById(prefix+'-sysPrompt');
  if(sp&&sp.value)dcfg.systemPrompt=sp.value;
  var backends={};
  var bkPanels=document.querySelectorAll('[id^="'+prefix+'-bk-"]');
  bkPanels.forEach(function(panel){
    var id=panel.id;
    var bkName=id.slice((prefix+'-bk-').length);
    if(!bkName)return;
    var bc={};
    var cmd=document.getElementById(prefix+'-'+bkName+'-cmd');
    if(cmd&&cmd.value)bc.command=cmd.value;
    var bm=document.getElementById(prefix+'-'+bkName+'-model');
    if(bm&&bm.value)bc.model=bm.value;
    var bt=document.getElementById(prefix+'-'+bkName+'-timeout');
    if(bt&&bt.value)bc.timeout=Number(bt.value);
    var ba=document.getElementById(prefix+'-'+bkName+'-args');
    if(ba&&ba.value)bc.args=ba.value.split(',').map(function(s){return s.trim()}).filter(function(s){return s});
    if(Object.keys(bc).length>0)backends[bkName]=bc;
  });
  if(Object.keys(backends).length>0)dcfg.backends=backends;
  return dcfg;
}

function buildDomainPanel(name,dcfg,knownBkNames){
  var dHtml='<div class="domain-panel">';
  dHtml+='<div class="domain-header" onclick="toggleDomain(\\''+name+'\\')"><span class="arrow" id="darr-'+name+'">\\u25B6</span>'+E(name)+'</div>';
  dHtml+='<div class="domain-body" id="db-'+name+'">';
  dHtml+=buildFullDomainForm('dd-'+name,dcfg,true,knownBkNames);
  dHtml+='<div class="form-actions"><button class="btn-save" onclick="saveDomain(\\''+name+'\\')">Save Domain</button><span class="save-feedback" id="dbfb-'+name+'"></span></div>';
  dHtml+='</div></div>';
  return dHtml;
}

function toggleDomain(name){
  var body=document.getElementById('db-'+name);
  var arrow=document.getElementById('darr-'+name);
  if(body){body.classList.toggle('open');if(arrow)arrow.classList.toggle('open')}
}

function saveDomain(name){
  var fb=document.getElementById('dbfb-'+name);
  if(!fb)return;
  fb.className='save-feedback';fb.textContent='';
  var dcfg=collectDomainConfig('dd-'+name);
  var payload={};
  payload[name]=dcfg;
  fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({domainsConfig:payload})})
    .then(function(r){return r.json()})
    .then(function(r){
      if(r.success){
        fb.textContent='\\u2713 Saved';
        fb.className='save-feedback ok show';
        setTimeout(function(){fb.className='save-feedback'},3000);
      }else{
        fb.textContent='\\u2717 '+E(r.error||'Save failed');
        fb.className='save-feedback err show';
      }
    })
    .catch(function(err){
      fb.textContent='\\u2717 '+E(err.message);
      fb.className='save-feedback err show';
    });
}

function sel(val,opt){return val===opt?' selected':''}


// ── Init ────────────────────────────────────────────────
// Auto-load first ticket once sessions page is shown
</script>
</body></html>`;
}
