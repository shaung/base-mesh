import { logger } from '../../../lib/log.js';
// NodeCoordinator — Node.js push-mode central node.
// Manages executor WebSocket connections, HTTP server, file proxy.
// Delegates round processing to CoreCoordinator.

import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Client } from '@larksuiteoapi/node-sdk';
import { Config, BitableRecord } from '../../../lib/types.js';
import { BitableClient } from '../../../lib/bitable/client.js';
import { Session } from '../../../lib/bitable/protocol.js';
import { extractText } from '../../../lib/messaging/text.js';
import { createSession, validateSession } from '../../../lib/sessions.js';

import { getDomainConfig } from '../../../lib/bitable/domain.js';
import { CoreCoordinator } from '../../core/coordinator.js';
import { latestTurnMessageId } from '../../core/helpers.js';
import { NodeLarkAdapter } from './adapters/lark.js';
import { NodeBitableAdapter } from './adapters/bitable.js';
import type { ExecutorPoolInterface, FeishuAdapter } from '../../core/types.js';
import type { Logger } from '../../core/types.js';
import { routeA2ARequest, verifyA2AAuth } from '../../a2a.js';

interface PushExecutor { ws: WebSocket; identity: string; domains: string[]; activeTicketId?: string; lastHeartbeat: number; }

export class NodeCoordinator {
  private wss: WebSocketServer | null = null;
  private executors = new Map<string, PushExecutor>();
  private bitable: BitableClient;
  private session: Session;
  private client: Client;           // primary channel-credential Client
  /** Per-operator Lark Clients for multi-credential IM sending. */
  private operatorClients = new Map<string, Client>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private roundPollTimer: ReturnType<typeof setInterval> | null = null;
  private coreCoordinator: CoreCoordinator;
  private nodeExecutorPool: NodeExecutorPool;

  constructor(private cfg: Config) {
    this.bitable = new BitableClient(cfg);
    this.session = new Session('channel', 'Channel', cfg, this.bitable);
    const dc = getDomainConfig(cfg.openApiDomain);
    this.client = new Client({ appId: cfg.appId, appSecret: cfg.appSecret || 'unused', domain: dc.sdkBaseUrl, loggerLevel: 3 });
    // Initialize per-operator Clients for multi-credential IM sending
    if (cfg.operators) {
      for (const op of cfg.operators) {
        if (op.appId && op.appSecret && op.appId !== cfg.appId) {
          try {
            const opClient = new Client({ appId: op.appId, appSecret: op.appSecret, domain: dc.sdkBaseUrl, loggerLevel: 3 });
            this.operatorClients.set(op.appId, opClient);
          } catch (err) {
            logger.error(`[coordinator] failed to init operator client "${op.name}":`, err);
          }
        }
      }
    }
    // Create CoreCoordinator for streaming card management (and round coordination)
    const bitableAdapter = new NodeBitableAdapter(this.bitable);
    const feishuAdapter = new NodeLarkAdapter((appId?: string) => this.getClient(appId));
    const operatorFeishus = new Map<string, FeishuAdapter>();
    if (cfg.operators) {
      for (const op of cfg.operators) {
        if (op.appId && op.appSecret && op.appId !== cfg.appId && !operatorFeishus.has(op.appId)) {
          operatorFeishus.set(op.appId, new NodeLarkAdapter((_appId?: string) => this.getClient(op.appId)));
        }
      }
    }
    this.nodeExecutorPool = new NodeExecutorPool(this.executors);
    this.coreCoordinator = new CoreCoordinator(
      bitableAdapter, this.nodeExecutorPool, feishuAdapter, cfg,
      { info: (m: string, ...args: any[]) => logger.info(m, ...args), error: (m: string, ...args: any[]) => logger.error(m, ...args) } as Logger,
      operatorFeishus,
    );
  }

  /** Get the Lark IM Client for a given appId, falling back to the primary client. */
  private getClient(appId?: string): Client {
    if (appId) {
      const c = this.operatorClients.get(appId);
      if (c) return c;
    }
    return this.client;
  }

  private running = true;

  start() {
    const port = this.cfg.coordinator?.port || 0;
    if (!port) { logger.info('[coordinator] port not configured, skipping'); return; }

    const fileProxyEnabled = this.cfg.coordinator?.fileProxyEnabled !== false;
    const a2aEnabled = this.cfg.coordinator?.a2a?.enabled === true;
    const server = createServer(async (req, res) => {
      // A2A protocol endpoints
      if (a2aEnabled && (req.url?.startsWith('/a2a/') || req.url === '/.well-known/agent.json')) {
        if (!verifyA2AAuth(req, this.cfg)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const handled = await routeA2ARequest(req, res, this.session, this.cfg);
        if (handled) return;
      }
      if (fileProxyEnabled && req.url?.startsWith('/files/') && req.method === 'GET') {
        await this.handleFileProxy(req, res);
      } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else if (!a2aEnabled || (!req.url?.startsWith('/a2a/') && req.url !== '/.well-known/agent.json')) {
        res.writeHead(404); res.end();
      }
    });
    this.wss = new WebSocketServer({ server });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    server.listen(port, () => logger.info(`[coordinator] listening on :${port}`));

    const interval = (this.cfg.coordinator?.heartbeatSeconds ?? 60) * 1000;
    this.heartbeatTimer = setInterval(() => this.heartbeatAll(), interval);

    // Start Round state machine if Round table is configured
    this.startRoundCoordination();
  }

  stop() {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.roundPollTimer) clearInterval(this.roundPollTimer);
    this.wss?.close();
    for (const [, ex] of this.executors) { try { ex.ws.close(); } catch { /* */ } }
  }

  // -- Push executor connection ---------------------------------------------
  private async handleConnection(ws: WebSocket, _req: any) {
    let identity = ""; let domains: string[] = [];

    ws.on('message', async (raw) => {
      const text = raw.toString().trim();
      if (text === 'ping') return; // executor heartbeat
      try {
        const msg = JSON.parse(text) as Record<string, unknown>;
        const type = msg.type as string;

        if (type === 'auth') {
          identity = msg.identity as string || '';
          logger.info(`[coordinator] auth requested for ${identity}, sending app credentials`);
          ws.send(JSON.stringify({
            type: 'auth_required',
            appId: this.cfg.appId,
            openApiDomain: this.cfg.openApiDomain || 'open.feishu.cn',
          }));
          return;
        }

        if (type === 'auth_token') {
          const token = msg.token as string;
          identity = msg.identity as string || '';
          domains = Array.isArray(msg.domains) ? msg.domains as string[] : [];
          if (!token) { ws.send(JSON.stringify({ type: 'error', message: 'token required' })); ws.close(); return; }
          let valid = false;
          try {
            const resp = await fetch(`https://${this.cfg.openApiDomain || 'open.feishu.cn'}/open-apis/authen/v1/user_info`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            valid = ((await resp.json()) as any).code === 0;
          } catch { /* invalid */ }
          if (!valid) { ws.send(JSON.stringify({ type: 'error', message: 'auth failed' })); ws.close(); return; }
          const sessionToken = createSession(identity, domains, this.cfg.coordinator?.sessionTTLDays ?? 30, this.cfg.appSecret || 'default-secret');
          this.executors.set(identity, { ws, identity, domains, lastHeartbeat: Date.now() });
          try {
            await this.upsertRoster(identity, domains, msg);
            logger.info(`[coordinator] roster upserted for ${identity}`);
          } catch (err: any) {
            logger.error(`[coordinator] roster upsert failed: ${err.message}`, err);
          }
          logger.info(`[coordinator] push executor connected: ${identity} domains=[${domains}]`);
          ws.send(JSON.stringify({ type: 'auth_ok', session_token: sessionToken }));
          this.tryAssignPendingToExecutor(identity, domains).catch(() => {});
          return;
        }

        if (type === 'reauth') {
          const entry = validateSession(msg.session_token as string, this.cfg.appSecret || 'default-secret');
          if (!entry) { ws.send(JSON.stringify({ type: 'error', message: 'session expired' })); ws.close(); return; }
          identity = entry.identity;
          domains = Array.isArray(msg.domains) ? msg.domains as string[] : (entry.domains || []);
          this.executors.set(identity, { ws, identity, domains, lastHeartbeat: Date.now() });
          try {
            await this.upsertRoster(identity, domains, msg);
            logger.info(`[coordinator] roster upserted (reauth) for ${identity}`);
          } catch (err: any) {
            logger.error(`[coordinator] roster upsert failed: ${err.message}`, err);
          }
          ws.send(JSON.stringify({ type: 'reauth_ok' }));
          return;
        }

        // ── Streaming output (delegated to CoreCoordinator) ─────
        if (type === 'stream_update' && this.cfg.coordinator?.streamOutput) {
          await this.coreCoordinator.handleStreamUpdate(msg as any);
          return;
        }

        if (type === 'stream_end' && this.cfg.coordinator?.streamOutput) {
          await this.coreCoordinator.handleStreamEnd(msg as any);
          // Fall through to type: 'result' for Bitable writes
        }


        if (type === 'result') {
          // Delegate all result processing to CoreCoordinator
          await this.coreCoordinator.processResult(identity, {
            ticket_id: msg.ticket_id as string,
            round_id: msg.round_id as string | undefined,
            answer: (msg.answer as string) || '',
            root_msg_id: (msg.root_msg_id as string) || '',
            parts: Array.isArray(msg.parts) ? msg.parts as any[] : undefined,
            reassignTo: msg.reassignTo as any,
            streamed: msg.streamed as boolean | undefined,
            newSummary: msg.newSummary as string | undefined,
            duration_ms: msg.duration_ms as number | undefined,
            token_usage: msg.token_usage as any,
          });

          // Node-specific: WebSocket ack and executor state
          const ex = this.executors.get(identity);
          if (ex) ex.activeTicketId = undefined;
          ws.send(JSON.stringify({ type: 'ack' }));
          return;
        }
      } catch (err) { logger.error('[coordinator] message error:', err); }
    });

    ws.on('close', () => logger.info(`[coordinator] push executor disconnected: ${identity}`));
    ws.on('error', () => { /* */ });
  }

  // -- Task routing ---------------------------------------------------------
  async tryRoute(ticket: BitableRecord): Promise<boolean> {
    const recordId = ticket.record_id; if (!recordId) { logger.info('[coordinator] tryRoute: no record_id'); return false; }
    const status = String(ticket.fields[this.cfg.fields.ticket.status] ?? '');
    logger.info(`[coordinator] tryRoute ticket=${recordId.slice(0,12)} status=${status} roundMode=${!!this.cfg.roundsTableId} executors=${this.executors.size}`);

    // In Round-driven mode, tryRoute NEVER creates Rounds. Rounds are created
    // by handleThreadReply (Channel). The Round creation event drives processing
    // via processRound. tryRoute only nudges existing active Rounds.
    if (this.cfg.roundsTableId) {
      const currentRound = await this.session.getCurrentRound(recordId);
      logger.info(`[coordinator] tryRoute roundMode: currentRound=${currentRound?.record_id?.slice(0,12) || 'none'}`);
      if (currentRound) {
        await this.processRound(currentRound.record_id!);
      }
      return true;
    }
    // Non-round path (legacy): use empty domains, match any executor
    logger.info(`[coordinator] tryRoute legacy (no round mode) executorCount=${this.executors.size}`);

    const rawLastOwner = String(ticket.fields[this.cfg.fields.ticket.lastOwner] ?? '');
    const lastOwnerIdentity = rawLastOwner.includes('#') ? rawLastOwner.split('#').pop()! : rawLastOwner;
    if (lastOwnerIdentity) {
      const ex = this.executors.get(lastOwnerIdentity);
      if (ex && !ex.activeTicketId) {
        const won = await this.session.claim(ticket);
        if (won) {
          await this.dispatchTask(ex, ticket, recordId);
          return true;
        }
      }
    }
    for (const [, ex] of this.executors) {
      if (ex.activeTicketId) continue;
      if (ex.identity === lastOwnerIdentity) continue;
      const won = await this.session.claim(ticket);
      if (!won) continue;
      await this.dispatchTask(ex, ticket, recordId);
      return true;
    }
    return false;
  }

  /** Send task to a push executor over WebSocket and notify via IM. */
  private async dispatchTask(ex: PushExecutor, ticket: BitableRecord, recordId: string): Promise<void> {
    ex.activeTicketId = recordId;
    const turns = await this.session.getTurns(recordId);
    // Determine appId from the first user turn's field or dedupKey
    const appId = (() => {
      for (const t of turns) {
        const role = extractText(t.fields[this.cfg.fields.turn.role]);
        if (role === 'user') {
          const fieldVal = extractText(t.fields[this.cfg.fields.turn.appId]);
          if (fieldVal) return fieldVal;
          const dedupKey = extractText(t.fields[this.cfg.fields.turn.dedupKey]);
          if (dedupKey) {
            const colonIdx = dedupKey.indexOf(':');
            if (colonIdx > 0) return dedupKey.slice(0, colonIdx);
          }
        }
      }
      return undefined;
    })();
    ex.ws.send(JSON.stringify({
      type: 'task', ticket: { record_id: recordId, fields: ticket.fields },
      turns: turns.map(t => ({ record_id: t.record_id, fields: t.fields })),
      globalPrompt: this.cfg.coordinator?.globalPrompt || '',
      stream_output: this.cfg.coordinator?.streamOutput === true,
      stream_thinking: this.cfg.coordinator?.streamThinking === true,
    }));

    // React to the latest user turn message, not the thread root
    const latestMsgId = latestTurnMessageId(turns, this.cfg.fields.turn.role, this.cfg.fields.turn.dedupKey);
    if (latestMsgId) {
      try { await this.removeReaction(latestMsgId, 'OneSecond', appId); } catch { /* */ }
      try { await this.reactToMessage(latestMsgId, 'OnIt', appId); } catch { /* */ }
    }
    logger.info(`[coordinator] ticket ${recordId} assigned to ${ex.identity} appId=${appId || 'primary'}`);
  }

  canHandle(_ticket: BitableRecord): boolean {
    for (const [, ex] of this.executors) {
      if (ex.activeTicketId) continue;
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Round state machine (Round-driven mode only)
  // ---------------------------------------------------------------------------

  /** Process a single Round by record_id (called from Bitable event). */

  /** Process a single Round — delegates to CoreCoordinator. */
  async processRound(roundId: string): Promise<void> {
    await this.coreCoordinator.processRound(roundId);
  }

  /** Start polling loop — delegates round coordination to CoreCoordinator. */
  private startRoundCoordination(): void {
    if (!this.cfg.roundsTableId) {
      logger.info('[coordinator] round mode not enabled (no roundsTableId)');
      return;
    }
    logger.info('[coordinator] round state machine started');
    const interval = (this.cfg.coordinator?.pollIntervalSeconds ?? 10) * 1000;
    this.roundPollTimer = setInterval(() => {
      this.coreCoordinator.roundCoordinationCycle().catch((err) =>
        logger.error('[coordinator] round cycle error:', err),
      );
    }, interval);
    this.coreCoordinator.roundCoordinationCycle().catch((err) =>
      logger.error('[coordinator] round cycle error:', err),
    );
  }

  async dispatchCancelToExecutor(roundId: string): Promise<boolean> {
    return this.coreCoordinator.dispatchCancelToExecutor(roundId);
  }

  /** After a new executor connects, try assigning it to any pending round. */
  private async tryAssignPendingToExecutor(identity: string, domains: string[]): Promise<void> {
    await this.coreCoordinator.tryAssignPendingToExecutor(identity, domains);
  }

  // ── Node-specific: HTTP file proxy ─────────────────────────────────────

  private async handleFileProxy(req: any, res: any): Promise<void> {
    const fileToken = req.url?.split('/files/')[1]?.split('?')[0];
    if (!fileToken) { res.writeHead(400); res.end('Missing file token'); return; }
    let tenantToken: string | null = null;
    try {
      const resp = await fetch(`https://${this.cfg.openApiDomain || 'open.feishu.cn'}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.cfg.appId, app_secret: this.cfg.appSecret }),
      });
      const data = await resp.json() as any;
      tenantToken = data.tenant_access_token ?? null;
    } catch { /* */ }
    if (!tenantToken) { res.writeHead(502); res.end('Failed to obtain tenant token'); return; }
    try {
      const dc = getDomainConfig(this.cfg.openApiDomain || 'open.feishu.cn');
      const downloadUrl = `${dc.sdkBaseUrl}/open-apis/drive/v1/medias/${fileToken}/download`;
      const proxyResp = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${tenantToken}` } });
      if (!proxyResp.ok) { res.writeHead(proxyResp.status); res.end('Download failed'); return; }
      const contentType = proxyResp.headers.get('content-type') || 'application/octet-stream';
      const contentLength = proxyResp.headers.get('content-length');
      const headers: Record<string, string> = { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' };
      if (contentLength) headers['Content-Length'] = contentLength;
      res.writeHead(200, headers);
      const buffer = Buffer.from(await proxyResp.arrayBuffer());
      res.end(buffer);
    } catch { res.writeHead(500); res.end('Proxy error'); }
  }

  // ── Node-specific: executor heartbeat ──────────────────────────────────

  private async heartbeatAll() {
    const nowMs = Date.now();
    for (const [identity] of this.executors) {
      try {
        const records = await this.bitable.searchRecords(this.cfg.rosterTableId, {
          conjunction: 'and', conditions: [{ field_name: this.cfg.fields.roster.identity, operator: 'is', value: [identity] }],
        });
        if (records.length > 0 && records[0].record_id) {
          await this.bitable.updateRecord(this.cfg.rosterTableId, records[0].record_id, { [this.cfg.fields.roster.lastSeenAt]: nowMs });
        }
      } catch { /* */ }
    }
  }

  // ── Node-specific: roster & IM helpers ─────────────────────────────────

  private async upsertRoster(identity: string, domains: string[] | undefined, msg: Record<string, unknown>) {
    const safeDomains = Array.isArray(domains) ? domains : [];
    logger.info(`[coordinator] upsertRoster identity=${identity} domains=${safeDomains}`);
    const recs = await this.bitable.searchRecords(this.cfg.rosterTableId, {
      conjunction: 'and', conditions: [{ field_name: this.cfg.fields.roster.identity, operator: 'is', value: [identity] }],
    });
    const fields: Record<string, unknown> = {
      [this.cfg.fields.roster.kind]: 'agent',
      [this.cfg.fields.roster.domains]: safeDomains.length > 0 ? safeDomains : ['general'],
      [this.cfg.fields.roster.enabled]: true,
      [this.cfg.fields.roster.description]: (msg.description as string) || '',
      [this.cfg.fields.roster.hitl]: (msg.hitl as string) || 'off',
      [this.cfg.fields.roster.hitlPolicy]: (msg.hitlPolicy as string) || 'default',
      [this.cfg.fields.roster.lastSeenAt]: Date.now(),
    };
    if (recs.length > 0 && recs[0].record_id) {
      await this.bitable.updateRecord(this.cfg.rosterTableId, recs[0].record_id, fields);
    } else {
      await this.bitable.createRecord(this.cfg.rosterTableId, { [this.cfg.fields.roster.identity]: identity, ...fields, [this.cfg.fields.roster.registeredAt]: Date.now() });
    }
  }

  private async reactToMessage(messageId: string, emojiType: string, appId?: string) {
    const imClient = this.getClient(appId);
    try { await (imClient as any).im.v1.messageReaction.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: emojiType } } }); }
    catch (err: any) { this.logSDKError('react', appId, err); }
  }

  private async removeReaction(messageId: string, emojiType: string, appId?: string) {
    const imClient = this.getClient(appId);
    try {
      const listResp = await (imClient as any).im.v1.messageReaction.list({ path: { message_id: messageId } });
      const items = listResp?.data?.items ?? [];
      for (const r of items) {
        if (r.reaction_type?.emoji_type === emojiType && r.reaction_id) {
          await (imClient as any).im.v1.messageReaction.delete({ path: { message_id: messageId, reaction_id: r.reaction_id } });
          return;
        }
      }
    } catch (err: any) { this.logSDKError('removeReaction', appId, err); }
  }

  private async notifyIM(rootMsgId: string, text: string, appId?: string) {
    if (!text.trim()) return;
    const imClient = this.getClient(appId);
    const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: text }] } };
    try {
      await (imClient as any).im.v1.message.reply({
        path: { message_id: rootMsgId },
        data: { msg_type: 'interactive', content: JSON.stringify(card), reply_in_thread: true },
      });
    } catch { /* best-effort */ }
  }

  private logSDKError(label: string, appId: string | undefined, err: any): void {
    logger.error(`[coordinator] ${label} appId=${appId}: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// NodeExecutorPool — bridges Node WebSocket executor Map to ExecutorPoolInterface
// ---------------------------------------------------------------------------

import type { ExecutorInfo } from '../../core/types.js';

class NodeExecutorPool implements ExecutorPoolInterface {
  constructor(private executors: Map<string, PushExecutor>) {}

  async getAvailableExecutors(domains?: string[]): Promise<ExecutorInfo[]> {
    const list: ExecutorInfo[] = [];
    for (const [, ex] of this.executors) {
      list.push({
        identity: ex.identity, domains: ex.domains,
        connected: true, lastHeartbeat: ex.lastHeartbeat,
        activeTicketId: ex.activeTicketId,
      });
    }
    return list;
  }

  dispatchTask(executorId: string, payload: unknown): boolean {
    const ex = this.executors.get(executorId);
    if (!ex) return false;
    try {
      ex.ws.send(JSON.stringify(payload));
      return true;
    } catch { return false; }
  }

  dispatchCancel(executorId: string, _roundId: string): boolean {
    const ex = this.executors.get(executorId);
    if (!ex) return false;
    try {
      ex.ws.send(JSON.stringify({ type: 'cancel', round_id: _roundId }));
      return true;
    } catch { return false; }
  }

  broadcast(message: string): number {
    let count = 0;
    for (const [, ex] of this.executors) {
      try { ex.ws.send(message); count++; } catch {}
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers (parseDomains and latestTurnMessageId imported from core/helpers.ts)
// ---------------------------------------------------------------------------
