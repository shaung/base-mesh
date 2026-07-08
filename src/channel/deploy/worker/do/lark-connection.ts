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

  /** Load enriched config and start Lark WS connection. */
  private async initConfig(): Promise<void> {
    try {
      const cached = await this.ctx.storage.get<string>('enriched_cfg');
      if (cached) {
        this.enrichedCfg = JSON.parse(cached) as Config;
        this.coordinator = this.buildCoordinator(this.enrichedCfg);
        console.log('[lark-connection] config loaded from DO cache');
        await this.connectToLark();
        return;
      }
      if (this.baseCfg.configsTableId) {
        await this.loadAndCacheConfig();
      }
    } catch (err) {
      console.error('[lark-connection] config init error (using base config):', err);
    }
    await this.connectToLark();
  }

  /** Load config from the Bitable Configs table and cache in DO storage. */
  private async loadAndCacheConfig(): Promise<Config> {
    const bitable = new WorkerBitableAdapter(this.env);
    const cfg: Config = JSON.parse(JSON.stringify(this.baseCfg));
    await enrichConfigFromTable(cfg, bitable);

    this.enrichedCfg = cfg;
    this.coordinator = this.buildCoordinator(cfg);

    await this.ctx.storage.put('enriched_cfg', JSON.stringify(cfg));
    return cfg;
  }

  // ── fetch handler — accepts WebSocket upgrades and internal requests ──

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/reload') {
      return this.handleReload();
    }

    if (url.pathname === '/__warmup' || url.pathname === '/__reconnect') {
      await this.cfgReadyPromise;
      if (!this.larkWs) await this.connectToLark();
      return new Response('OK', { status: 200 });
    }

    await this.cfgReadyPromise;
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
    await this.cfgReadyPromise;

    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
    } catch {
      console.warn('[lark-connection] invalid JSON message');
      return;
    }

    const event = (data.event ?? data) as Record<string, unknown>;
    if (!event || typeof event !== 'object') return;

    const header = event.header as Record<string, unknown> | undefined;
    const eventType = header?.event_type as string | undefined;

    if (!eventType) {
      const rawType = data.type as string | undefined;
      if (rawType === 'executor_result') {
        await this.handleExecutorResult(data);
      } else if (rawType === 'pong') {
        // nothing
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

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
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
      await this.connectToLark();
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

    if (!tableId || !recordId) return;

    console.log(`[lark-connection] bitable event: ${tableId}/${recordId}`);

    if (cfg.roundsTableId && tableId === cfg.roundsTableId) {
      await this.coordinator.processRound(recordId);
    }
  }

  private async handleCardAction(event: Record<string, unknown>): Promise<void> {
    const action = (event.action ?? event) as Record<string, unknown> | undefined;
    const roundId = (action?.value as Record<string, unknown> | undefined)?.round_id as string | undefined;
    const decision = (action?.value as Record<string, unknown> | undefined)?.action as string | undefined;

    if (!roundId || !decision) return;

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

    if (!ticketId || !answer) return;

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

  /** Ensure the Lark WS connection is active. If not, kick off a reconnect. */
  private async ensureLarkConnected(): Promise<void> {
    if (this.larkWs) {
      try {
        if ((this.larkWs as any).readyState === 1) return;
      } catch { /* */ }
    }
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (!existingAlarm) {
      await this.connectToLark();
    }
  }

  // ── Outgoing WebSocket to Lark event service ──────────────────────────

  /** Connect to Lark's WebSocket event push service.
   *  Matches the @larksuiteoapi/node-sdk WSClient protocol:
   *  1. POST {domain}/callback/ws/endpoint with AppID + AppSecret
   *  2. Connect to the returned WebSocket URL
   *  3. Respond to server ping with pong */
  private async connectToLark(): Promise<void> {
    const dc = this.env.OPEN_API_DOMAIN || 'open.feishu.cn';
    const baseUrl = `https://${dc}`;

    try {
      console.log('[lark-connection] fetching WS endpoint...');

      // Step 1: Get WebSocket endpoint config (matches SDK's pullConnectConfig)
      const endpointResp = await fetch(`${baseUrl}/callback/ws/endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          AppID: this.env.LARK_APP_ID,
          AppSecret: this.env.LARK_APP_SECRET,
        }),
      });

      if (!endpointResp.ok) {
        const errBody = await endpointResp.text().catch(() => '');
        console.warn(`[lark-connection] failed to get WS endpoint: HTTP ${endpointResp.status} ${errBody.slice(0, 200)}`);
        await this.scheduleReconnect();
        return;
      }

      const endpointData = await endpointResp.json() as Record<string, unknown>;
      if ((endpointData as any).code !== 0) {
        console.warn(`[lark-connection] endpoint error: code=${(endpointData as any).code}`);
        await this.scheduleReconnect();
        return;
      }

      const wsData = (endpointData as any).data as { URL: string } | undefined;
      const connectUrl = wsData?.URL;
      if (!connectUrl) {
        console.warn(`[lark-connection] no URL in response: ${JSON.stringify(endpointData).slice(0, 200)}`);
        await this.scheduleReconnect();
        return;
      }

      console.log('[lark-connection] got WS endpoint, connecting...');

      // Step 2: Connect to the WebSocket URL (matches SDK's connect())
      let larkWs: WebSocket;
      try {
        larkWs = new WebSocket(connectUrl);
      } catch (err) {
        console.error('[lark-connection] WebSocket constructor FAILED:', err);
        await this.scheduleReconnect();
        return;
      }

      larkWs.addEventListener('open', () => {
        console.log('[lark-connection] connected to Lark WS');
        this.larkWs = larkWs as any;
      });

      larkWs.addEventListener('message', async (event: MessageEvent) => {
        const text = typeof event.data === 'string' ? event.data : '';
        if (!text) return;

        let data: Record<string, unknown>;
        try { data = JSON.parse(text); } catch { return; }

        // Handle ping/pong — server pings, client must pong
        if (data.type === 'ping') {
          larkWs.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (data.type === 'pong') return;

        // Route event to handler
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
        console.log(`[lark-connection] Lark WS closed (code=${event.code})`);
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
}
