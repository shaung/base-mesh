// ---------------------------------------------------------------------------
// LarkConnection Durable Object
//
// Manages the Lark WebSocket connection for receiving events (messages,
// bitable changes, card actions). Uses WebSocket Hibernation API to stay
// at zero cost when idle.
//
// Lifecycle:
//   1. Worker entry receives /lark/ws upgrade → routes to this DO
//   2. DO accepts WebSocket, registers event handlers
//   3. Incoming messages processed via core coordinator/operator
//   4. When idle, DO hibernates (memory freed, no CPU cost)
//   5. Ping/pong handled at edge without waking DO
//
// Config enrichment:
//   Runtime config (coordinator settings, message templates, etc.) is
//   loaded from the Bitable Configs table and cached in DO storage.
//   POST /reload clears the cache and re-reads from the table.
// ---------------------------------------------------------------------------

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../index.js';
import { CoreCoordinator } from '../../../core/coordinator.js';
import { WorkerBitableAdapter } from '../adapters/bitable.js';
import { WorkerLarkAdapter } from '../adapters/lark.js';
import { WorkerSessionAdapter } from '../session-adapter.js';
import { buildWorkerConfig, enrichConfigFromTable } from '../config.js';
import { DOExecutorPool } from './executor-pool.js';
import type { Config } from '../../../lib/types.js';

// ---- Attachment types stored on hibernated WebSockets ---------------------

interface LarkWsAttachment {
  type: 'lark';
  connectedAt: number;
}

// ---- Durable Object -------------------------------------------------------

export class LarkConnection extends DurableObject<Env> {
  /** Primary Lark event WebSocket. */
  private larkWs: WebSocket | null = null;
  /** Track all active sessions. */
  private sessions = new Map<WebSocket, LarkWsAttachment>();

  /** CoreCoordinator instance for round processing and result handling. */
  private coordinator: CoreCoordinator;

  /** Base config from env vars (always available, synchronous). */
  private baseCfg: Config;
  /** Enriched config (after loading from Configs table). */
  private enrichedCfg: Config | null = null;
  /** Promise that resolves when initial config enrichment completes. */
  private cfgReadyPromise: Promise<void>;

  // ── Constructor ────────────────────────────────────────────────────────

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Restore sessions from any previously hibernated (but still open)
    // WebSocket connections.
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as LarkWsAttachment | null;
      if (attachment?.type === 'lark') {
        this.sessions.set(ws, attachment);
        this.larkWs = ws;
      }
    }

    // Set up automatic ping/pong response.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );

    // Build base config from env vars (synchronous, no IO).
    this.baseCfg = buildWorkerConfig(env);

    // Create a temporary coordinator with the base config. It may be
    // upgraded to an enriched config once loadAndCacheConfig() completes.
    this.coordinator = this.buildCoordinator(this.baseCfg);

    // Start async config enrichment — loads from DO storage cache first,
    // then falls back to the Bitable Configs table on cold start.
    this.cfgReadyPromise = this.initConfig();
  }

  // ── Coordinator factory ────────────────────────────────────────────────

  private buildCoordinator(cfg: Config): CoreCoordinator {
    const bitable = new WorkerBitableAdapter(this.env);
    const feishu = new WorkerLarkAdapter(this.env);
    const sessionAdapter = new WorkerSessionAdapter(bitable, cfg);
    const executorPool = new DOExecutorPool(this.env);
    return new CoreCoordinator(sessionAdapter, executorPool, feishu, cfg, console);
  }

  // ── Config enrichment ─────────────────────────────────────────────────

  /** Load enriched config and start Lark WS connection.
   *  This is the DO initialization sequence — both config and WS
   *  connection must complete before we consider the DO "ready".
   *  Any fetch() that awaits cfgReadyPromise ensures both are done. */
  private async initConfig(): Promise<void> {
    try {
      // 1. Try DO storage cache first (survives hibernation).
      const cached = await this.ctx.storage.get<string>('enriched_cfg');
      if (cached) {
        this.enrichedCfg = JSON.parse(cached) as Config;
        this.coordinator = this.buildCoordinator(this.enrichedCfg);
        console.log('[lark-connection] config loaded from DO cache');
        // Start WS connection; awaited so the DO doesn't hibernate too early
        await this.connectToLark();
        return;
      }

      // 2. Cold start — load from Configs table if configured.
      if (this.baseCfg.configsTableId) {
        await this.loadAndCacheConfig();
      }
    } catch (err) {
      console.error('[lark-connection] config init error (using base config):', err);
    }

    // Start WS connection (even if config loading failed, try with base config)
    await this.connectToLark();
  }

  /** Load config from the Bitable Configs table and cache in DO storage. */
  private async loadAndCacheConfig(): Promise<Config> {
    const bitable = new WorkerBitableAdapter(this.env);
    // Copy base config so enrich mutates a fresh object, not the original.
    const cfg: Config = JSON.parse(JSON.stringify(this.baseCfg));
    await enrichConfigFromTable(cfg, bitable);

    this.enrichedCfg = cfg;
    this.coordinator = this.buildCoordinator(cfg);

    // Cache in DO storage for hibernation survival.
    await this.ctx.storage.put('enriched_cfg', JSON.stringify(cfg));
    return cfg;
  }

  // ── fetch handler — accepts WebSocket upgrades and internal requests ──

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST /reload — force re-read from Configs table
    if (url.pathname === '/reload') {
      return this.handleReload();
    }

    // Alarm-triggered internal request
    if (url.pathname === '/__reconnect') {
      await this.cfgReadyPromise;
      await this.reconnectLark();
      return new Response('OK', { status: 200 });
    }

    // Ensure enriched config is ready.
    await this.cfgReadyPromise;

    // Ensure Lark WS connection is active (kick off if constructor's
    // attempt failed before hibernation).
    this.ensureLarkConnected().catch(() => {});

    if (url.pathname === '/lark/ws') {
      return this.handleWebSocketUpgrade(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  /** POST /reload — reload runtime config from the Configs table. */
  private async handleReload(): Promise<Response> {
    if (!this.baseCfg.configsTableId) {
      return new Response(JSON.stringify({
        ok: false, message: 'no configs table configured (BITABLE_CONFIGS_TABLE_ID)',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      await this.loadAndCacheConfig();
      console.log('[lark-connection] config reloaded from Configs table');
      // Reconnect Lark WS with new config (await so DO stays alive)
      await this.connectToLark();
      return new Response(JSON.stringify({ ok: true, message: 'config reloaded' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error('[lark-connection] config reload failed:', err);
      return new Response(JSON.stringify({ ok: false, error: String(err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // ── WebSocket lifecycle handlers ───────────────────────────────────────

  /** Accept a new Lark event WebSocket connection. */
  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    const attachment: LarkWsAttachment = {
      type: 'lark',
      connectedAt: Date.now(),
    };
    server.serializeAttachment(attachment);
    this.sessions.set(server, attachment);
    this.larkWs = server;

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Ensure config is loaded before processing any event.
    // On DO wake from hibernation, this awaits the DO storage cache read,
    // which is fast (typically <10 ms).
    await this.cfgReadyPromise;

    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
    } catch {
      console.warn('[lark-connection] invalid JSON message');
      return;
    }

    // Lark event dispatcher wraps events in { event: {...} }
    const event = (data.event ?? data) as Record<string, unknown>;
    if (!event || typeof event !== 'object') return;

    const header = event.header as Record<string, unknown> | undefined;
    const eventType = header?.event_type as string | undefined;

    if (!eventType) {
      const rawType = data.type as string | undefined;
      if (rawType === 'executor_result') {
        await this.handleExecutorResult(data);
      } else if (rawType === 'pong') {
        // Pong response — nothing to do
      }
      return;
    }

    switch (eventType) {
      case 'im.message.receive_v1':
        await this.handleImMessage(event);
        break;
      case 'drive.file.bitable_record_changed_v1':
        await this.handleBitableEvent(event);
        break;
      case 'card.action.trigger':
        await this.handleCardAction(event);
        break;
      default:
        console.debug(`[lark-connection] unhandled event type: ${eventType}`);
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.sessions.delete(ws);
    if (this.larkWs === ws) {
      this.larkWs = null;
      console.log(`[lark-connection] Lark WS closed (code=${code}), scheduling reconnect`);
      await this.scheduleReconnect();
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    console.warn('[lark-connection] WebSocket error');
  }

  // ── Alarm handler ──────────────────────────────────────────────────────

  async alarm(): Promise<void> {
    if (!this.larkWs) {
      await this.reconnectLark();
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  private async handleImMessage(event: Record<string, unknown>): Promise<void> {
    const eventType = (event.header as Record<string, unknown> | undefined)?.event_type as string ?? 'im.message.receive_v1';
    console.log(`[lark-connection] ${eventType} — IM message handling pending operator core`);
  }

  private async handleBitableEvent(event: Record<string, unknown>): Promise<void> {
    const cfg = this.enrichedCfg ?? this.baseCfg;
    const tableId = event.table_id as string | undefined;
    const actionList = Array.isArray(event.action_list) ? event.action_list : [];
    const action = actionList[0] as Record<string, unknown> | undefined;
    const recordId = action?.record_id as string | undefined;

    if (!tableId || !recordId) {
      console.log('[lark-connection] bitable event missing table_id or record_id');
      return;
    }

    console.log(`[lark-connection] bitable event: ${tableId}/${recordId}`);

    if (cfg.roundsTableId && tableId === cfg.roundsTableId) {
      await this.coordinator.processRound(recordId);
    }
  }

  private async handleCardAction(event: Record<string, unknown>): Promise<void> {
    const action = (event.action ?? event) as Record<string, unknown> | undefined;
    const roundId = (action?.value as Record<string, unknown> | undefined)?.round_id as string | undefined;
    const decision = (action?.value as Record<string, unknown> | undefined)?.action as string | undefined;

    if (!roundId || !decision) {
      console.log('[lark-connection] card action missing round_id or decision');
      return;
    }

    console.log(`[lark-connection] card action: ${decision} round=${roundId}`);
    try {
      const cfg = this.enrichedCfg ?? this.baseCfg;
      if (decision === 'approve') {
        await this.coordinator['session'].transitionRound(roundId, cfg.roundStatuses.approved);
      } else if (decision === 'reject') {
        await this.coordinator['session'].transitionRound(roundId, cfg.roundStatuses.rejected);
      }
    } catch (err) {
      console.error(`[lark-connection] card action failed round=${roundId}:`, err);
    }
  }

  private async handleExecutorResult(data: Record<string, unknown>): Promise<void> {
    const ticketId = data.ticket_id as string;
    const roundId = data.round_id as string | undefined;
    const answer = (data.answer as string) || '';
    const rootMsgId = (data.root_msg_id as string) || '';

    if (!ticketId || !answer) {
      console.log('[lark-connection] executor result missing ticket_id or answer');
      return;
    }

    console.log(`[lark-connection] executor result: ticket=${ticketId} answer=${answer.slice(0, 60)}`);

    await this.coordinator.processResult('worker-executor', {
      ticket_id: ticketId,
      round_id: roundId,
      answer,
      root_msg_id: rootMsgId,
      parts: data.parts as unknown[] | undefined,
      reassignTo: data.reassignTo as { roles?: string[]; kind?: string } | undefined,
      streamed: data.streamed as boolean | undefined,
      newSummary: data.newSummary as string | undefined,
    });
  }

  // ── Connection management ──────────────────────────────────────────────

  private async scheduleReconnect(): Promise<void> {
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm) return;
    await this.ctx.storage.setAlarm(Date.now() + 5000);
  }

  private async reconnectLark(): Promise<void> {
    await this.connectToLark();
  }

  // ── Outgoing WebSocket to Lark event service ──────────────────────────

  /** Connect to Lark's WebSocket event push service as a client.
   *  This is the Worker equivalent of what @larksuiteoapi/node-sdk's
   *  WSClient does: obtain a ticket, connect, authenticate, receive events. */
  private async connectToLark(): Promise<void> {
    try {
      console.log('[lark-connection] starting Lark WS connection...');
      const token = await this.getTenantTokenForWs();
      if (!token) {
        console.warn('[lark-connection] cannot connect: no tenant token');
        await this.scheduleReconnect();
        return;
      }

      // Get WebSocket ticket from Lark
      const dc = this.env.OPEN_API_DOMAIN || 'open.feishu.cn';
      console.log(`[lark-connection] fetching WS ticket from ${dc}...`);
      const ticketResp = await fetch(`https://${dc}/open-apis/ws/v1/app_ticket`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!ticketResp.ok) {
        const errBody = await ticketResp.text().catch(() => '');
        console.warn(`[lark-connection] failed to get WS ticket: HTTP ${ticketResp.status} ${errBody.slice(0, 200)}`);
        await this.scheduleReconnect();
        return;
      }
      const ticketData = await ticketResp.json() as Record<string, unknown>;
      const ticket = (ticketData.data as Record<string, unknown> | undefined)?.ticket as string | undefined;
      if (!ticket) {
        console.warn(`[lark-connection] no ticket in response: ${JSON.stringify(ticketData).slice(0, 200)}`);
        await this.scheduleReconnect();
        return;
      }

      console.log('[lark-connection] got WS ticket, connecting...');
      // Connect to Lark WebSocket with the ticket
      const wsUrl = `wss://${dc}/open-apis/ws/v1/app_ticket?ticket=${ticket}`;
      console.log(`[lark-connection] WS URL: ${wsUrl.replace(ticket, 'TICKET')}`);
      let larkWs: WebSocket;
      try {
        larkWs = new WebSocket(wsUrl);
      } catch (err) {
        console.error('[lark-connection] WebSocket constructor FAILED:', err instanceof Error ? err.message : err);
        await this.scheduleReconnect();
        return;
      }
      console.log('[lark-connection] WebSocket constructor OK');

      larkWs.addEventListener('open', () => {
        console.log('[lark-connection] connected to Lark WS, authenticating');

        // Authenticate with app credentials
        larkWs.send(JSON.stringify({
          type: 'auth',
          app_id: this.env.LARK_APP_ID,
          app_secret: this.env.LARK_APP_SECRET,
        }));

        this.larkWs = larkWs as any;
      });

      larkWs.addEventListener('message', async (event: MessageEvent) => {
        const text = typeof event.data === 'string' ? event.data : '';
        if (!text) return;

        let data: Record<string, unknown>;
        try { data = JSON.parse(text); } catch { return; }

        // Handle ping/pong
        if (data.type === 'ping') {
          larkWs.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        // Handle auth result
        if (data.type === 'auth_success') {
          console.log('[lark-connection] Lark WS authenticated successfully');
          return;
        }
        if (data.type === 'auth_failed') {
          console.error('[lark-connection] Lark WS auth failed:', text);
          larkWs.close();
          return;
        }

        // Route to event handlers (same dispatch as incoming WS connections)
        await this.cfgReadyPromise;
        const packet = (data.event ?? data) as Record<string, unknown>;
        if (!packet || typeof packet !== 'object') return;

        const header = packet.header as Record<string, unknown> | undefined;
        const eventType = header?.event_type as string | undefined;

        if (eventType === 'im.message.receive_v1') {
          await this.handleImMessage(packet);
        } else if (eventType === 'drive.file.bitable_record_changed_v1') {
          await this.handleBitableEvent(packet);
        } else if (eventType === 'card.action.trigger') {
          await this.handleCardAction(packet);
        } else {
          console.debug(`[lark-connection] unhandled event: ${eventType || text.slice(0, 100)}`);
        }
      });

      larkWs.addEventListener('close', (event: CloseEvent) => {
        console.log(`[lark-connection] Lark WS closed (code=${event.code}), scheduling reconnect`);
        this.larkWs = null;
        this.scheduleReconnect();
      });

      larkWs.addEventListener('error', () => {
        console.warn('[lark-connection] Lark WS error');
      });
    } catch (err) {
      console.error('[lark-connection] connectToLark failed:', err);
      await this.scheduleReconnect();
    }
  }

  /** Ensure the Lark WS connection is active. If not, kick off a reconnect. */
  private async ensureLarkConnected(): Promise<void> {
    if (this.larkWs) {
      // Check if the WebSocket is still open (readyState === 1 = OPEN)
      try {
        if ((this.larkWs as any).readyState === 1) return;
      } catch { /* not available */ }
    }
    // Not connected — check if we should start one
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (!existingAlarm) {
      await this.connectToLark();
    }
  }

  /** Get a tenant_access_token for the WebSocket connection. */
  private async getTenantTokenForWs(): Promise<string | null> {
    const dc = this.env.OPEN_API_DOMAIN || 'open.feishu.cn';
    try {
      const resp = await fetch(`https://${dc}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: this.env.LARK_APP_ID,
          app_secret: this.env.LARK_APP_SECRET,
        }),
      });
      const data = await resp.json() as Record<string, unknown>;
      if (!resp.ok || !data.tenant_access_token) {
        console.warn(`[lark-connection] getTenantToken failed: HTTP ${resp.status} code=${data.code}`);
        return null;
      }
      return data.tenant_access_token as string;
    } catch (err) {
      console.error('[lark-connection] getTenantTokenForWs failed:', err);
      return null;
    }
  }
}
