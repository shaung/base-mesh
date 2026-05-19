import { logger } from './log.js';
// ---------------------------------------------------------------------------
// Push executor scheduler — runs inside Channel, manages WebSocket connections
// to push-mode executors, routes tickets, and proxies Bitable writes.
// ---------------------------------------------------------------------------

import { createServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Config, BitableRecord } from './types.js';
import { Session } from './protocol.js';
import { BitableClient } from './bitable.js';
import { createSession, validateSession } from './sessions.js';

export interface PushExecutor {
  ws: WebSocket;
  identity: string;
  roles: string[];
  activeTicketId?: string;
}

export class Scheduler {
  private wss: WebSocketServer | null = null;
  private executors = new Map<string, PushExecutor>();
  private session: Session;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private cfg: Config,
    private bitable: BitableClient,
    session: Session,
  ) {
    this.session = session;
  }

  start() {
    const port = this.cfg.channel?.coordinatorPort || 0;
    if (!port) return;

    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    server.listen(port, () => {
      console.log(`[scheduler] push WS listening on :${port}`);
    });

    // Heartbeat for all push executors
    const interval = (this.cfg.channel?.pushHeartbeatSeconds ?? 60) * 1000;
    this.heartbeatTimer = setInterval(() => this.heartbeatAll(), interval);
  }

  stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.wss?.close();
    for (const [, ex] of this.executors) {
      try { ex.ws.close(); } catch { /* */ }
    }
  }

  // -- connection handling ---------------------------------------------------

  private async handleConnection(ws: WebSocket, req: IncomingMessage) {
    let identity = '';
    let roles: string[] = [];

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        const type = msg.type as string;

        if (type === 'auth') {
          const token = msg.token as string;
          const authType = (msg.auth_type as string) || 'oauth';
          identity = msg.identity as string || '';
          roles = Array.isArray(msg.roles) ? msg.roles as string[] : [];

          // Validate token. For OAuth, try user_info. For app_secret, trust the token.
          let valid = false;
          if (authType === 'app_secret') {
            // App access token — trust the format, skip user_info
            valid = typeof token === 'string' && token.length > 10;
          } else {
            // OAuth user token — validate via Feishu user_info
            try {
              const resp = await fetch(`https://${this.cfg.openApiDomain || 'open.feishu.cn'}/open-apis/authen/v1/user_info`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              const data = await resp.json() as Record<string, unknown>;
              valid = data.code === 0;
            } catch { /* try as app token */ valid = typeof token === 'string' && token.length > 10; }
          }

          if (!valid) {
            ws.send(JSON.stringify({ type: 'error', message: 'auth failed' }));
            ws.close();
            return;
          }

          // Register/update executor in Roster via Channel (proxy write)
          const rosterRecs = await this.bitable.searchRecords(this.cfg.rosterTableId, {
            conjunction: 'and',
            conditions: [{ field_name: this.cfg.fields.roster.identity, operator: 'is', value: [identity] }],
          });
          if (rosterRecs.length > 0 && rosterRecs[0].record_id) {
            await this.bitable.updateRecord(this.cfg.rosterTableId, rosterRecs[0].record_id, {
              [this.cfg.fields.roster.kind]: 'agent',
              [this.cfg.fields.roster.roles]: roles.length > 0 ? roles : ['general'],
              [this.cfg.fields.roster.enabled]: true,
              [this.cfg.fields.roster.description]: (msg.description as string) || '',
              [this.cfg.fields.roster.hitl]: (msg.hitl as string) || 'off',
              [this.cfg.fields.roster.hitlPolicy]: (msg.hitlPolicy as string) || 'default',
              [this.cfg.fields.roster.lastSeenAt]: Date.now(),
            });
          } else {
            await this.bitable.createRecord(this.cfg.rosterTableId, {
              [this.cfg.fields.roster.identity]: identity,
              [this.cfg.fields.roster.kind]: 'agent',
              [this.cfg.fields.roster.roles]: roles.length > 0 ? roles : ['general'],
              [this.cfg.fields.roster.description]: (msg.description as string) || '',
              [this.cfg.fields.roster.hitl]: (msg.hitl as string) || 'off',
              [this.cfg.fields.roster.hitlPolicy]: (msg.hitlPolicy as string) || 'default',
              [this.cfg.fields.roster.lastSeenAt]: Date.now(),
              [this.cfg.fields.roster.registeredAt]: Date.now(),
            });
          }

          // Generate session token
          const sessionToken = createSession(identity, roles, this.cfg.channel?.pushSessionTTLDays ?? 30);

          this.executors.set(identity, { ws, identity, roles });
          console.log(`[scheduler] push executor connected: ${identity} roles=[${roles}]`);
          ws.send(JSON.stringify({ type: 'auth_ok', session_token: sessionToken }));
          return;
        }

        if (type === 'reauth') {
          // Reconnect with saved session token
          const sessionToken = msg.session_token as string;
          const entry = validateSession(sessionToken);
          if (!entry) {
            ws.send(JSON.stringify({ type: 'error', message: 'session expired, re-authenticate' }));
            ws.close();
            return;
          }
          identity = entry.identity;
          roles = entry.roles;
          this.executors.set(identity, { ws, identity, roles });
          console.log(`[scheduler] push executor reconnected: ${identity}`);
          ws.send(JSON.stringify({ type: 'reauth_ok' }));
          return;
        }

        if (type === 'result') {
          // Push executor reports task result → Channel proxies writes to Bitable
          const ticketId = msg.ticket_id as string;
          const answer = msg.answer as string || '';
          const newSummary = msg.newSummary as string || '';
          const rootMsgId = msg.root_msg_id as string || '';
          const reassignTo = msg.reassignTo as { roles?: string[]; kind?: string } | undefined;

          // Append turn and write result
          await this.session.appendTurn(ticketId, 'agent', answer, `${ticketId}_${Date.now()}`, identity, 'answered', rootMsgId);

          // Record lastOwner as push executor identity for future affinity routing
          try {
            await this.bitable.updateRecord(this.cfg.ticketsTableId, ticketId, {
              [this.cfg.fields.ticket.lastOwner]: identity,
            });
          } catch { /* best effort */ }

          if (reassignTo) {
            await this.session.release(ticketId, this.cfg.statuses.pending, {
              forRoles: reassignTo.roles,
              forKind: reassignTo.kind as 'human' | 'agent' | undefined,
            });
          } else {
            await this.session.writeResult(ticketId, answer, newSummary);
          }

          const ex = this.executors.get(identity);
          if (ex) ex.activeTicketId = undefined;
          ws.send(JSON.stringify({ type: 'ack' }));
          console.log(`[scheduler] result written for ticket ${ticketId.slice(0, 12)} by ${identity}`);
          return;
        }
      } catch (err) {
        logger.error('[scheduler] message error:', err);
      }
    });

    ws.on('close', () => {
      // Don't remove executor on close — wait for reconnect
      console.log(`[scheduler] push executor disconnected: ${identity}`);
    });

    ws.on('error', () => { /* */ });
  }

  // -- task routing ----------------------------------------------------------

  /** Try to route a ticket to a connected push executor. Returns true if assigned. */
  async tryRoute(ticket: BitableRecord): Promise<boolean> {
    const recordId = ticket.record_id;
    if (!recordId) return false;

    const forRoles: string[] = Array.isArray(ticket.fields[this.cfg.fields.ticket.forRoles])
      ? ticket.fields[this.cfg.fields.ticket.forRoles] as string[] : [];

    // Phase 1: Try affinity — assign to last known owner if available
    const rawLastOwner = String(ticket.fields[this.cfg.fields.ticket.lastOwner] ?? '');
    const lastOwnerIdentity = rawLastOwner.includes('#') ? rawLastOwner.split('#').pop()! : rawLastOwner;
    if (lastOwnerIdentity) {
      const ex = this.executors.get(lastOwnerIdentity);
      if (ex && !ex.activeTicketId) {
        if (forRoles.length === 0 || forRoles.some((r) => ex.roles.includes(r))) {
          const won = await this.session.claim(ticket);
          if (won) {
            ex.activeTicketId = recordId;
            const turns = await this.session.getTurns(recordId);
            ex.ws.send(JSON.stringify({
              type: 'task',
              ticket: { record_id: recordId, fields: ticket.fields },
              turns: turns.map((t) => ({ record_id: t.record_id, fields: t.fields })),
              globalPrompt: this.cfg.channel?.globalPrompt || '',
            }));
            console.log(`[scheduler] ticket ${recordId.slice(0, 12)} assigned to ${ex.identity} (affinity)`);
            return true;
          }
        }
      }
    }

    // Phase 2: Fall back to any available executor
    for (const [, ex] of this.executors) {
      if (ex.activeTicketId) continue; // already busy
      if (forRoles.length > 0 && !forRoles.some((r) => ex.roles.includes(r))) continue;
      if (ex.identity === lastOwnerIdentity) continue; // already tried in Phase 1

      const won = await this.session.claim(ticket);
      if (!won) continue; // pull executor got it or race condition

      ex.activeTicketId = recordId;
      const turns = await this.session.getTurns(recordId);
      ex.ws.send(JSON.stringify({
        type: 'task',
        ticket: { record_id: recordId, fields: ticket.fields },
        turns: turns.map((t) => ({ record_id: t.record_id, fields: t.fields })),
        globalPrompt: this.cfg.channel?.globalPrompt || '',
      }));
      console.log(`[scheduler] ticket ${recordId.slice(0, 12)} assigned to ${ex.identity}`);
      return true;
    }

    return false;
  }

  /** Check if any push executor can handle this ticket. */
  canHandle(ticket: BitableRecord): boolean {
    const forRoles: string[] = Array.isArray(ticket.fields[this.cfg.fields.ticket.forRoles])
      ? ticket.fields[this.cfg.fields.ticket.forRoles] as string[] : [];

    for (const [, ex] of this.executors) {
      if (ex.activeTicketId) continue;
      if (forRoles.length === 0 || forRoles.some((r) => ex.roles.includes(r))) return true;
    }
    return false;
  }

  // -- heartbeat -------------------------------------------------------------

  private async heartbeatAll() {
    const nowMs = Date.now();
    for (const [identity] of this.executors) {
      try {
        const records = await this.bitable.searchRecords(this.cfg.rosterTableId, {
          conjunction: 'and',
          conditions: [{ field_name: this.cfg.fields.roster.identity, operator: 'is', value: [identity] }],
        });
        if (records.length > 0 && records[0].record_id) {
          await this.bitable.updateRecord(this.cfg.rosterTableId, records[0].record_id, {
            [this.cfg.fields.roster.lastSeenAt]: nowMs,
          });
        }
      } catch { /* best effort */ }
    }
  }
}
