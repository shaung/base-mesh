import { logger } from './log.js';
// Coordinator — push mode central node. Manages executor registration,
// routes tasks, proxies Bitable writes, sends one-time IM notifications.

import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Client } from '@larksuiteoapi/node-sdk';
import { Config, BitableRecord } from './types.js';
import { BitableClient } from './bitable.js';
import { Session, extractText, extractUserIds } from './protocol.js';
import { createSession, validateSession } from './sessions.js';
import { getDomainConfig } from './domain.js';
import { formatMessage } from './messages.js';

interface PushExecutor { ws: WebSocket; identity: string; roles: string[]; activeTicketId?: string; lastHeartbeat: number; }

export class Coordinator {
  private wss: WebSocketServer | null = null;
  private executors = new Map<string, PushExecutor>();
  private bitable: BitableClient;
  private session: Session;
  private client: Client;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private cfg: Config) {
    this.bitable = new BitableClient(cfg);
    this.session = new Session(cfg.clientId || cfg.identity, cfg.nickname, cfg, this.bitable);
    const dc = getDomainConfig(cfg.openApiDomain);
    this.client = new Client({ appId: cfg.appId, appSecret: cfg.appSecret || 'unused', domain: dc.sdkBaseUrl });
  }

  private running = true;

  start() {
    const port = this.cfg.coordinator?.port || 0;
    if (!port) { console.log('[coordinator] port not configured, skipping'); return; }

    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    this.wss = new WebSocketServer({ server });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    server.listen(port, () => console.log(`[coordinator] listening on :${port}`));

    const interval = (this.cfg.coordinator?.heartbeatSeconds ?? 60) * 1000;
    this.heartbeatTimer = setInterval(() => this.heartbeatAll(), interval);
  }

  stop() {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.wss?.close();
    for (const [, ex] of this.executors) { try { ex.ws.close(); } catch { /* */ } }
  }

  // -- Push executor connection ---------------------------------------------
  private async handleConnection(ws: WebSocket, _req: any) {
    let identity = ''; let roles: string[] = [];

    ws.on('message', async (raw) => {
      const text = raw.toString().trim();
      if (text === 'ping') return; // executor heartbeat
      try {
        const msg = JSON.parse(text) as Record<string, unknown>;
        const type = msg.type as string;

        if (type === 'auth') {
          const token = msg.token as string;
          const authType = (msg.auth_type as string) || 'oauth';
          identity = msg.identity as string || '';
          roles = Array.isArray(msg.roles) ? msg.roles as string[] : [];

          let valid = authType === 'app_secret' ? (typeof token === 'string' && token.length > 10) : false;
          if (authType === 'oauth') {
            try {
              const resp = await fetch(`https://${this.cfg.openApiDomain || 'open.feishu.cn'}/open-apis/authen/v1/user_info`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              valid = ((await resp.json()) as any).code === 0;
            } catch { valid = typeof token === 'string' && token.length > 10; }
          }
          if (!valid) { ws.send(JSON.stringify({ type: 'error', message: 'auth failed' })); ws.close(); return; }

          const sessionToken = createSession(identity, roles, this.cfg.coordinator?.sessionTTLDays ?? 30);
          this.executors.set(identity, { ws, identity, roles, lastHeartbeat: Date.now() });
          try {
            await this.upsertRoster(identity, roles, msg);
            console.log(`[coordinator] roster upserted for ${identity}`);
          } catch (err: any) {
            logger.error(`[coordinator] roster upsert failed: ${err.message}`, err);
          }
          console.log(`[coordinator] push executor connected: ${identity} roles=[${roles}]`);
          ws.send(JSON.stringify({ type: 'auth_ok', session_token: sessionToken }));
          return;
        }

        if (type === 'reauth') {
          const entry = validateSession(msg.session_token as string);
          if (!entry) { ws.send(JSON.stringify({ type: 'error', message: 'session expired' })); ws.close(); return; }
          identity = entry.identity; roles = entry.roles;
          this.executors.set(identity, { ws, identity, roles, lastHeartbeat: Date.now() });
          try {
            await this.upsertRoster(identity, roles, msg);
            console.log(`[coordinator] roster upserted (reauth) for ${identity}`);
          } catch (err: any) {
            logger.error(`[coordinator] roster upsert failed: ${err.message}`, err);
          }
          ws.send(JSON.stringify({ type: 'reauth_ok' }));
          return;
        }

        if (type === 'result') {
          const ticketId = msg.ticket_id as string;
          const answer = msg.answer as string || '';
          const rootMsgId = msg.root_msg_id as string || '';
          const reassignTo = msg.reassignTo as { roles?: string[]; kind?: string } | undefined;

          console.log(`[coordinator] result from ${identity} ticket=${ticketId.slice(0, 12)} answer=${answer.slice(0, 60)}`);
          console.log(`[coordinator] writing agent turn for ticket=${ticketId.slice(0, 12)}`);
          try {
            const turnId = await this.session.appendTurn(ticketId, 'agent', answer, `${ticketId}_${Date.now()}`, identity, 'answered', rootMsgId);
            console.log(`[coordinator] agent turn written ticket=${ticketId.slice(0, 12)} turnId=${turnId}`);
          } catch (err: any) {
            logger.error(`[coordinator] appendTurn failed: ${err.message}`, err);
          }

          // Record lastOwner as push executor identity for future affinity routing
          try {
            await this.bitable.updateRecord(this.cfg.ticketsTableId, ticketId, {
              [this.cfg.fields.ticket.lastOwner]: identity,
            });
          } catch { /* best effort */ }

          if (reassignTo) {
            console.log(`[coordinator] reassigning ticket=${ticketId.slice(0, 12)} to roles=${reassignTo.roles} kind=${reassignTo.kind}`);
            await this.session.release(ticketId, this.cfg.statuses.pending, {
              forRoles: reassignTo.roles, forKind: reassignTo.kind as 'human' | 'agent' | undefined,
            });
          } else {
            console.log(`[coordinator] writeResult ticket=${ticketId.slice(0, 12)}`);
            try {
              await this.session.writeResult(ticketId, answer, (msg.newSummary as string) || '');
              console.log(`[coordinator] writeResult done ticket=${ticketId.slice(0, 12)}`);
            } catch (err: any) {
              logger.error(`[coordinator] writeResult failed: ${err.message}`, err);
            }
          }

          const ex = this.executors.get(identity);
          if (ex) ex.activeTicketId = undefined;
          ws.send(JSON.stringify({ type: 'ack' }));
          if (rootMsgId) { try { await this.notifyIM(rootMsgId, this.cfg.messages?.taskDone || '✅ Done processing'); } catch { /* */ } }
          return;
        }
      } catch (err) { logger.error('[coordinator] message error:', err); }
    });

    ws.on('close', () => console.log(`[coordinator] push executor disconnected: ${identity}`));
    ws.on('error', () => { /* */ });
  }

  // -- Task routing ---------------------------------------------------------
  async tryRoute(ticket: BitableRecord): Promise<boolean> {
    const recordId = ticket.record_id; if (!recordId) return false;
    const forRoles: string[] = Array.isArray(ticket.fields[this.cfg.fields.ticket.forRoles])
      ? ticket.fields[this.cfg.fields.ticket.forRoles] as string[] : [];

    // Phase 1: Try affinity — assign to last known owner if available
    const rawLastOwner = String(ticket.fields[this.cfg.fields.ticket.lastOwner] ?? '');
    const lastOwnerIdentity = rawLastOwner.includes('#') ? rawLastOwner.split('#').pop()! : rawLastOwner;
    if (lastOwnerIdentity) {
      const ex = this.executors.get(lastOwnerIdentity);
      if (ex && !ex.activeTicketId) {
        if (forRoles.length === 0 || forRoles.some(r => ex.roles.includes(r))) {
          const won = await this.session.claim(ticket);
          if (won) {
            await this.dispatchTask(ex, ticket, recordId);
            console.log(`[coordinator] ticket ${recordId.slice(0, 12)} assigned to ${ex.identity} (affinity)`);
            return true;
          }
        }
      }
    }

    // Phase 2: Fall back to any available executor
    for (const [, ex] of this.executors) {
      if (ex.activeTicketId) continue;
      if (forRoles.length > 0 && !forRoles.some(r => ex.roles.includes(r))) continue;
      if (ex.identity === lastOwnerIdentity) continue; // already tried in Phase 1
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
    ex.ws.send(JSON.stringify({
      type: 'task', ticket: { record_id: recordId, fields: ticket.fields },
      turns: turns.map(t => ({ record_id: t.record_id, fields: t.fields })),
      globalPrompt: this.cfg.coordinator?.globalPrompt || '',
    }));

    const rootMsgId = extractText(ticket.fields[this.cfg.fields.ticket.rootMsgId]);
    if (rootMsgId) {
      try {
        await this.notifyIM(rootMsgId, formatMessage(this.cfg.messages?.taskAssigned || '🤖 {identity} started processing', { identity: ex.identity }));
      } catch { /* */ }
    }
    console.log(`[coordinator] ticket ${recordId.slice(0, 12)} assigned to ${ex.identity}`);
  }

  canHandle(ticket: BitableRecord): boolean {
    const forRoles: string[] = Array.isArray(ticket.fields[this.cfg.fields.ticket.forRoles])
      ? ticket.fields[this.cfg.fields.ticket.forRoles] as string[] : [];
    for (const [, ex] of this.executors) {
      if (ex.activeTicketId) continue;
      if (forRoles.length === 0 || forRoles.some(r => ex.roles.includes(r))) return true;
    }
    return false;
  }

  // -- Human notifications --------------------------------------------------
  async notifyHumans() {
    try {
      const tickets = await this.bitable.searchRecords(this.cfg.ticketsTableId, {
        conjunction: 'and', conditions: [
          { field_name: this.cfg.fields.ticket.status, operator: 'is', value: [this.cfg.statuses.pending] },
          { field_name: this.cfg.fields.ticket.forKind, operator: 'is', value: ['human'] },
        ],
      });
      for (const ticket of tickets) {
        const forRoles: string[] = Array.isArray(ticket.fields[this.cfg.fields.ticket.forRoles]) ? ticket.fields[this.cfg.fields.ticket.forRoles] as string[] : [];
        const rootMsgId = extractText(ticket.fields[this.cfg.fields.ticket.rootMsgId]);
        const senderId = extractText(ticket.fields[this.cfg.fields.ticket.senderId]);
        const summary = extractText(ticket.fields[this.cfg.fields.ticket.summary]);

        const roster = await this.bitable.searchRecords(this.cfg.rosterTableId, {
          conjunction: 'and', conditions: [
            { field_name: this.cfg.fields.roster.kind, operator: 'is', value: ['human'] },
            { field_name: this.cfg.fields.roster.enabled, operator: 'is', value: [true] },
          ],
        });
        const matched = roster.filter(r => {
          const hr: string[] = Array.isArray(r.fields[this.cfg.fields.roster.roles]) ? r.fields[this.cfg.fields.roster.roles] as string[] : [];
          if (forRoles.length === 0) return true;
          return forRoles.some(role => hr.includes(role));
        });
        if (matched.length === 0) continue;

        let atMentions = '';
        if (senderId) { atMentions = `<at id=${senderId}></at>`; } else {
          const ids = matched.flatMap(h => extractUserIds(h.fields[this.cfg.fields.roster.human]).split(',').filter(Boolean));
          atMentions = ids.map(id => `<at id=${id.trim()}></at>`).join(' ');
        }
        if (rootMsgId) {
          const notification = formatMessage(this.cfg.messages?.humanNotification || '📋 New task pending {mentions}\n{summary}', {
            mentions: atMentions, summary,
          });
          await this.notifyIM(rootMsgId, notification);
        }
      }
    } catch { /* */ }
  }

  // -- One-time IM notification (not recorded as Turn) ----------------------
  private async notifyIM(rootMsgId: string, text: string) {
    if (!text.trim() || !this.cfg.appSecret) return;
    const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: text }] } };
    await this.client.im.v1.message.reply({
      path: { message_id: rootMsgId },
      data: { msg_type: 'interactive', content: JSON.stringify(card), reply_in_thread: true } as any,
    });
  }

  // -- Roster & heartbeat ---------------------------------------------------
  private async upsertRoster(identity: string, roles: string[], msg: Record<string, unknown>) {
    console.log(`[coordinator] upsertRoster identity=${identity} roles=${roles}`);
    const recs = await this.bitable.searchRecords(this.cfg.rosterTableId, {
      conjunction: 'and', conditions: [{ field_name: this.cfg.fields.roster.identity, operator: 'is', value: [identity] }],
    });
    console.log(`[coordinator] roster search result: ${recs.length} records`);
    const fields = {
      [this.cfg.fields.roster.kind]: 'agent', [this.cfg.fields.roster.roles]: roles.length > 0 ? roles : ['general'],
      [this.cfg.fields.roster.enabled]: true, [this.cfg.fields.roster.description]: (msg.description as string) || '',
      [this.cfg.fields.roster.hitl]: (msg.hitl as string) || 'off', [this.cfg.fields.roster.hitlPolicy]: (msg.hitlPolicy as string) || 'default',
      [this.cfg.fields.roster.lastSeenAt]: Date.now(),
    };
    if (recs.length > 0 && recs[0].record_id) {
      await this.bitable.updateRecord(this.cfg.rosterTableId, recs[0].record_id, fields);
    } else {
      await this.bitable.createRecord(this.cfg.rosterTableId, { [this.cfg.fields.roster.identity]: identity, ...fields, [this.cfg.fields.roster.registeredAt]: Date.now() });
    }
  }

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
}
