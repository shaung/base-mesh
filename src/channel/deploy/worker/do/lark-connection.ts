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
import { CoreOperator } from '../../../core/operator.js';
import { WorkerBitableAdapter } from '../adapters/bitable.js';
import { WorkerLarkAdapter } from '../adapters/lark.js';
import { WorkerSessionAdapter } from '../session-adapter.js';
import { buildWorkerConfig, enrichConfigFromTable } from '../config.js';
import { DOExecutorPool } from './executor-pool.js';
import { decodeFrame, FRAME_DATA, HEADER_TYPE, HEADER_MESSAGE_ID, HEADER_SUM, HEADER_SEQ } from '../lark-ws-protocol.js';
import type { DecodedFrame } from '../lark-ws-protocol.js';
import type { Config } from '../../../lib/types.js';
import { log as L } from '../logger.js';

// ---- Attachment types stored on hibernated WebSockets ---------------------

interface LarkWsAttachment {
  type: 'lark-inbound' | 'lark-outbound';
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
  /** CoreOperator instance for IM message processing. */
  private operator: CoreOperator;

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
    // WebSocket connections. The outgoing Lark WS (type 'lark-outbound')
    // is restored as `this.larkWs` so the DO reuses it on wake-up
    // instead of re-connecting.
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as LarkWsAttachment | null;
      if (attachment?.type === 'lark-outbound') {
        this.larkWs = ws;
        this.sessions.set(ws, attachment);
      } else if (attachment?.type === 'lark-inbound') {
        this.sessions.set(ws, attachment);
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
    this.operator = new CoreOperator(sessionAdapter, feishu, bitable, cfg, console);
    return new CoreCoordinator(sessionAdapter, executorPool, feishu, cfg, console);
  }

  // ── Config enrichment ─────────────────────────────────────────────────

  /** Load enriched config into the DO. Connection is initiated in fetch(),
   *  not here — constructor runs on every wake-up and would re-connect. */
  private async initConfig(): Promise<void> {
    try {
      const cached = await this.ctx.storage.get<string>('enriched_cfg');
      if (cached) {
        this.enrichedCfg = JSON.parse(cached) as Config;
        this.coordinator = this.buildCoordinator(this.enrichedCfg);
        L.info('lark-connection', 'initConfig', { source: 'cache' });
        // Start round coordination after config loads
        await this.scheduleNextPoll();
        return;
      }
      if (this.baseCfg.configsTableId) {
        await this.loadAndCacheConfig();
      }
    } catch (err) {
      console.error('[lark-connection] config init error (using base config):', err);
    }
    await this.scheduleNextPoll();
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

    if (url.pathname === '/stream-update' && request.method === 'POST') {
      await this.cfgReadyPromise;
      const data = await request.json() as Record<string, unknown>;
      await this.handleStreamUpdate(data);
      return new Response('OK', { status: 200 });
    }

    if (url.pathname === '/stream-end' && request.method === 'POST') {
      await this.cfgReadyPromise;
      const data = await request.json() as Record<string, unknown>;
      await this.handleStreamEnd(data);
      return new Response('OK', { status: 200 });
    }

    if (url.pathname === '/executor-result' && request.method === 'POST') {
      await this.cfgReadyPromise;
      const data = await request.json() as Record<string, unknown>;
      const cfg = this.enrichedCfg ?? this.baseCfg;
      L.info('lark-connection', 'executorResult', { ticket: data.ticket_id, round: data.round_id, answerLen: String((data.answer as string || '').length) });
      await this.coordinator.processResult('worker-executor', {
        ticket_id: data.ticket_id as string,
        round_id: data.round_id as string | undefined,
        answer: (data.answer as string) || '',
        root_msg_id: (data.root_msg_id as string) || '',
        parts: data.parts as unknown[] | undefined,
        reassignTo: data.reassignTo as { roles?: string[]; kind?: string } | undefined,
        streamed: data.streamed as boolean | undefined,
        newSummary: data.newSummary as string | undefined,
        duration_ms: data.duration_ms as number | undefined,
        token_usage: data.token_usage as { input?: number; output?: number } | undefined,
      });
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
      L.info('lark-connection', 'configReloaded', {});
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
      type: 'lark-inbound',
      connectedAt: Date.now(),
    };
    server.serializeAttachment(attachment);
    this.sessions.set(server, attachment);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
    } catch {
      console.warn('[lark-connection] invalid JSON message');
      return;
    }

    // Handle Lark application-level ping/pong. The Lark WS protocol sends
    // {"type":"ping"} JSON messages — these are distinct from the WebSocket
    // frame-level ping/pong handled by setWebSocketAutoResponse.
    if (data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (data.type === 'pong') return;

    await this.cfgReadyPromise;

    const event = (data.event ?? data) as Record<string, unknown>;
    if (!event || typeof event !== 'object') return;

    const header = event.header as Record<string, unknown> | undefined;
    const eventType = header?.event_type as string | undefined;

    if (!eventType) {
      const rawType = data.type as string | undefined;
      if (rawType === 'executor_result') {
        await this.handleExecutorResult(data);
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
      case 'im.message.reaction.created_v1':
      case 'im.message.reaction.deleted_v1':
        break; // no-op
      default:
        if (eventType) console.debug(`[lark-connection] unhandled event type: ${eventType}`);
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
    await this.cfgReadyPromise;

    // 1. Reconnect Lark WS if needed
    if (!this.larkWs) {
      await this.connectToLark();
    }

    // 2. Coordinate pending rounds (like Node's roundCoordinationCycle)
    if (this.coordinator) {
      await this.coordinator.roundCoordinationCycle();
    }

    // 3. Schedule next poll
    await this.ctx.storage.setAlarm(Date.now() + LarkConnection.POLL_INTERVAL);
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  private async handleImMessage(eventBody: Record<string, unknown>): Promise<void> {
    const { message, sender } = eventBody as { message?: Record<string, unknown>; sender?: Record<string, unknown> };
    if (!message || !sender || !message.content) return;

    // Parse message content to plain text
    const content = parseMessageToText(message);
    if (!content) return;

    const messageId = String(message.message_id ?? '');
    const chatType = String(message.chat_type ?? '');

    // Construct the parsed event for CoreOperator
    const parsedEvent = {
      content,
      parts: [],
      message: {
        message_id: messageId,
        message_type: String(message.message_type ?? 'text') as any,
        content: String(message.content ?? ''),
        chat_type: chatType as any,
        chat_id: String(message.chat_id ?? ''),
        root_id: message.root_id as string | undefined,
        parent_id: message.parent_id as string | undefined,
        mentions: (message.mentions || []) as any[],
      },
      sender: {
        sender_type: String(sender.sender_type ?? 'user') as any,
        sender_id: {
          open_id: String((sender.sender_id as any)?.open_id ?? ''),
          union_id: (sender.sender_id as any)?.union_id as string | undefined,
        },
      },
      appId: this.env.LARK_APP_ID,
      botMentioned: false,
    };

    const roundId = await this.operator.handleMessage(parsedEvent);
    // If a round was created, process it immediately (same DO, no need to wait for bitable events)
    if (roundId) {
      L.info('lark-connection', 'processingNewRound', { roundId });
      await this.coordinator.processRound(roundId);
    }
  }

  private async handleBitableEvent(event: Record<string, unknown>): Promise<void> {
    const cfg = this.enrichedCfg ?? this.baseCfg;
    const tableId = event.table_id as string | undefined;
    const actionList = Array.isArray(event.action_list) ? event.action_list : [];
    const action = actionList[0] as Record<string, unknown> | undefined;
    const recordId = action?.record_id as string | undefined;

    if (!tableId || !recordId) return;

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

  // ── Event frame handling ─────────────────────────────────────────────

  /** Buffer for multi-frame event reassembly. */
  private eventChunks = new Map<string, { chunks: (Uint8Array | null)[]; createdAt: number }>();
  /** Serial processing queue for events. */
  private eventQueue: Promise<void> = Promise.resolve();
  /** Round coordination cycle interval in ms. */
  private static readonly POLL_INTERVAL = 15_000;

  /** Process a decoded event frame: reassemble chunks, dispatch, send ACK. */
  private async handleEventFrame(
    frame: DecodedFrame,
    headers: Map<string, string>,
    ws: WebSocket,
  ): Promise<void> {
    const messageId = headers.get(HEADER_MESSAGE_ID) || '';
    const sum = parseInt(headers.get(HEADER_SUM) || '1', 10);
    const seq = parseInt(headers.get(HEADER_SEQ) || '0', 10);

    if (!messageId) return;

    // Reassemble multi-chunk events
    const fullPayload = this.reassembleEvent(messageId, frame.payload, sum, seq);
    if (!fullPayload) return; // waiting for more chunks

    // Parse event JSON
    let eventData: Record<string, unknown>;
    try {
      const jsonStr = new TextDecoder().decode(fullPayload);
      eventData = JSON.parse(jsonStr);
    } catch (err) {
      console.error('[lark-connection] event JSON parse failed:', err);
      return;
    }

    // Send ACK
    this.sendFrameAck(ws, frame, 0);

    await this.cfgReadyPromise;
    const cfg = this.enrichedCfg ?? this.baseCfg;
    if (!cfg.rosterTableId) {
      console.warn('[lark-connection] rosterTableId not configured — tickets will not be created. Run /reload or check Configs table.');
    }

    // Dispatch
    const header = eventData.header as Record<string, unknown> | undefined;
    const eventType = header?.event_type as string | undefined;
    const eventBody = (eventData.event ?? eventData) as Record<string, unknown>;

    switch (eventType) {
      case 'im.message.receive_v1':
        await this.handleImMessage(eventBody);
        break;
      case 'drive.file.bitable_record_changed_v1':
        await this.handleBitableEvent(eventBody);
        break;
      case 'card.action.trigger':
        await this.handleCardAction(eventBody);
        break;
      case 'im.message.reaction.created_v1':
      case 'im.message.reaction.deleted_v1':
        break; // no-op
      default:
        if (eventType) console.debug(`[lark-connection] unhandled event type: ${eventType}`);
    }
  }

  /** Reassemble multi-chunk event payloads. Returns null if still waiting. */
  private reassembleEvent(
    messageId: string,
    chunk: Uint8Array,
    total: number,
    seq: number,
  ): Uint8Array | null {
    let entry = this.eventChunks.get(messageId);
    if (!entry) {
      entry = { chunks: new Array(total).fill(null), createdAt: Date.now() };
      this.eventChunks.set(messageId, entry);
    }
    entry.chunks[seq] = chunk;

    // Check if all chunks received
    if (entry.chunks.some(c => c === null)) return null;

    // Concatenate
    const totalLen = entry.chunks.reduce((s, c) => s + c!.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of entry.chunks) {
      merged.set(c!, offset);
      offset += c!.byteLength;
    }

    this.eventChunks.delete(messageId);
    return merged;
  }

  /** Send an ACK response frame for a received event. */
  private sendFrameAck(ws: WebSocket, frame: DecodedFrame, code: number): void {
    try {
      // Simple protobuf-encoded response: Frame with code in payload
      // We reuse the same SeqID/LogID so the server correlates the ACK
      const respPayload = JSON.stringify({ code });
      const encoder = new TextEncoder();

      // Build response Frame as protobuf bytes (minimal encoding)
      // Fields: 1=SeqID(varint), 2=LogID(varint), 4=method(varint),
      //         5=headers(length-delimited), 8=payload(bytes)
      const chunks: Uint8Array[] = [];
      const w = (fn: number, ...bytes: number[]) => chunks.push(new Uint8Array([fn, ...bytes]));
      const wVarint = (fn: number, val: bigint) => {
        const b: number[] = [];
        let v = val;
        while (v > 0x7fn) { b.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
        b.push(Number(v));
        w(fn << 3 | 0, ...b);
      };
      const wBytes = (fn: number, data: Uint8Array) => {
        const len: number[] = [];
        let l = data.byteLength;
        while (l > 0x7f) { len.push((l & 0x7f) | 0x80); l >>>= 7; }
        len.push(l);
        w(fn << 3 | 2, ...len, ...Array.from(data));
      };

      wVarint(1, frame.seqId);
      wVarint(2, frame.logId);
      wVarint(4, 0n); // method = control (0)
      wBytes(8, encoder.encode(respPayload));

      const full = new Uint8Array(chunks.reduce((s, c) => s + c.byteLength, 0));
      let off = 0;
      for (const c of chunks) { full.set(c, off); off += c.byteLength; }
      ws.send(full.buffer as ArrayBuffer);
    } catch (err) {
      console.warn('[lark-connection] ACK send failed:', err);
    }
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
        const state = (this.larkWs as any).readyState;
        // 1 = OPEN, 0 = CONNECTING — already in progress, skip
        if (state === 1 || state === 0) return;
      } catch { /* */ }
    }
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (!existingAlarm) {
      await this.connectToLark();
    }
  }

  /** Schedule the next round coordination poll (alarm-based). */
  private async scheduleNextPoll(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (!existing) {
      await this.ctx.storage.setAlarm(Date.now() + LarkConnection.POLL_INTERVAL);
    }
  }

  // ── Outgoing WebSocket to Lark event service ──────────────────────────

  /** Connect to Lark's WebSocket event push service.
   *  Matches the @larksuiteoapi/node-sdk WSClient protocol:
   *  1. POST {domain}/callback/ws/endpoint with AppID + AppSecret
   *  2. Connect to the returned WebSocket URL
   *  3. Register with Hibernation API so the connection survives DO
   *     hibernation — on wake-up the constructor restores it from
   *     getWebSockets() instead of re-connecting.
   *  4. Respond to server ping with pong (via webSocketMessage) */
  private async connectToLark(): Promise<void> {
    const dc = this.env.OPEN_API_DOMAIN || 'open.feishu.cn';
    const baseUrl = `https://${dc}`;

    try {
      // Step 0: Close any existing Lark WS before opening a new one
      if (this.larkWs) {
        try { this.larkWs.close(1000, 'reconnecting'); } catch { /* may already be closed */ }
        this.larkWs = null;
      }

      L.info('lark-connection', 'fetchEndpoint', {});

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

      L.info('lark-connection', 'connecting', {});

      // Step 2: Connect to the WebSocket URL (matches SDK's connect())
      let larkWs: WebSocket;
      try {
        larkWs = new WebSocket(connectUrl);
      } catch (err) {
        console.error('[lark-connection] WebSocket constructor FAILED:', err);
        await this.scheduleReconnect();
        return;
      }

      // Step 3: Use inline event listeners. Client-initiated WebSockets
      // (new WebSocket) cannot use Hibernation API — they'll reconnect via
      // alarm on every DO wake.
      this.larkWs = larkWs;

      larkWs.addEventListener('open', () => {
        L.info('lark-connection', 'wsConnected', {});
      });

      larkWs.addEventListener('message', async (event: MessageEvent) => {
        let buf: ArrayBuffer;
        if (typeof event.data === 'string') {
          // Text message — legacy fallback (shouldn't happen with current protocol)
          const text = event.data;
          let data: Record<string, unknown>;
          try { data = JSON.parse(text); } catch { return; }
          if (data.type === 'ping') { larkWs.send('{"type":"pong"}'); return; }
          return;
        } else if (event.data instanceof ArrayBuffer) {
          buf = event.data;
        } else if (event.data instanceof Blob) {
          buf = await event.data.arrayBuffer();
        } else {
          return;
        }

        // Decode protobuf frame
        let frame: DecodedFrame;
        try {
          frame = decodeFrame(buf);
        } catch (err) {
          console.error('[lark-connection] protobuf decode failed:', err);
          return;
        }

        // Build header lookup
        const hdrs = new Map(frame.headers.map(h => [h.key, h.value]));
        const msgType = hdrs.get(HEADER_TYPE);

        if (frame.method === FRAME_DATA && msgType === 'event') {
          // Serialize events: process one at a time in order
          this.eventQueue = this.eventQueue
            .then(() => this.handleEventFrame(frame, hdrs, larkWs))
            .catch(err => L.error('lark-connection', 'eventQueue', { error: err }));
          // Don't await — the queue runs independently so new frames can queue up
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

      // ── Streaming card handlers ───────────────────────────────────────────

  private streamState = new Map<string, { cardId: string; seq: number; think: string; answer: string }>();

  private async handleStreamUpdate(data: Record<string, unknown>): Promise<void> {
    const cfg = this.enrichedCfg ?? this.baseCfg;
    if (!cfg.coordinator?.streamOutput) return;
    const ticketId = data.ticket_id as string;
    const roundId = data.round_id as string || '';
    const content = (data.content as string) || '';
    const contentType = (data.content_type as string) || 'message';
    const rootMsgId = (data.root_msg_id as string) || '';
    const cardKey = roundId || ticketId;
    if (!rootMsgId && !this.streamState.has(cardKey)) return;
    if (!this.streamState.has(cardKey)) {
      const card = await this.createStreamingCard(rootMsgId);
      if (!card) return;
      this.streamState.set(cardKey, { cardId: card.cardId, seq: 0, think: '', answer: '' });
    }
    const st = this.streamState.get(cardKey)!;
    const dc = `https://${this.env.OPEN_API_DOMAIN || 'open.feishu.cn'}`;
    const token = await this.getStreamToken();
    if (!token) return;
    if (contentType === 'thinking') {
      st.think += (st.think ? '\n' : '') + '> ' + content.replace(/\n/g, '\n> ');
    } else {
      st.answer += (st.answer ? '\n' : '') + content;
    }
    st.seq++;
    await this.updateCardElement(st.cardId, contentType === 'thinking' ? 'stream_thinking' : 'stream_answer',
      contentType === 'thinking' ? st.think : st.answer, st.seq, token, dc);
  }

  private async handleStreamEnd(data: Record<string, unknown>): Promise<void> {
    const cfg = this.enrichedCfg ?? this.baseCfg;
    if (!cfg.coordinator?.streamOutput) return;
    const cardKey = (data.round_id as string) || (data.ticket_id as string);
    const st = this.streamState.get(cardKey);
    if (!st) return;
    const dc = `https://${this.env.OPEN_API_DOMAIN || 'open.feishu.cn'}`;
    const token = await this.getStreamToken();
    if (!token) return;
    if (st.think) { st.seq++; await this.updateCardElement(st.cardId, 'stream_thinking', st.think, st.seq, token, dc); }
    if (st.answer) { st.seq++; await this.updateCardElement(st.cardId, 'stream_answer', st.answer, st.seq, token, dc); }
    try {
      await fetch(`${dc}/open-apis/cardkit/v1/cards/${st.cardId}/settings`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: (st.answer || st.think).slice(0, 50) || '[Done]' } } }),
          sequence: ++st.seq,
          uuid: `c_${st.cardId}_${st.seq}`,
        }),
      });
    } catch {}
    this.streamState.delete(cardKey);
  }

  private async createStreamingCard(rootMsgId: string): Promise<{ cardId: string } | null> {
    const dc = `https://${this.env.OPEN_API_DOMAIN || 'open.feishu.cn'}`;
    const token = await this.getStreamToken();
    if (!token || !rootMsgId) return null;
    try {
      const cardSpec = { schema: '2.0', config: { streaming_mode: true, summary: { content: '[Generating...]' }, streaming_config: { print_frequency_ms: { default: 70 }, print_step: { default: 1 }, print_strategy: 'fast' } }, body: { elements: [{ tag: 'markdown', element_id: 'stream_thinking', content: '', text_size: 'text_size_note' }, { tag: 'markdown', element_id: 'stream_answer', content: '...' }, { tag: 'markdown', element_id: 'stream_stats', content: '', text_size: 'body' }] } };
      const resp = await fetch(`${dc}/open-apis/cardkit/v1/cards`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'card_json', data: JSON.stringify(cardSpec) }),
      });
      const d = await resp.json() as any;
      if (d.code !== 0 || !d.data?.card_id) return null;
      const cardId = d.data.card_id;
      await fetch(`${dc}/open-apis/im/v1/messages/${rootMsgId}/reply`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: cardId } }), reply_in_thread: true }),
      });
      return { cardId };
    } catch { return null; }
  }

  private async updateCardElement(cardId: string, elementId: string, content: string, seq: number, token: string, dc: string): Promise<void> {
    try {
      await fetch(`${dc}/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, sequence: seq, uuid: `${elementId}_${cardId}_${seq}` }),
      });
    } catch {}
  }

  private async getStreamToken(): Promise<string | null> {
    const dc = `https://${this.env.OPEN_API_DOMAIN || 'open.feishu.cn'}`;
    try {
      const resp = await fetch(`${dc}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.env.LARK_APP_ID, app_secret: this.env.LARK_APP_SECRET }),
      });
      const d = await resp.json() as any;
      return d.tenant_access_token || null;
    } catch { return null; }
  }
}

// ---- Message parsing helpers -----------------------------------------------
  private async handleStreamUpdate(data: Record<string, unknown>): Promise<void> {
    const cfg = this.enrichedCfg ?? this.baseCfg;
    if (!cfg.coordinator?.streamOutput) return;
    const ticketId = data.ticket_id as string;
    const roundId = data.round_id as string || '';
    const content = (data.content as string) || '';
    const contentType = (data.content_type as string) || 'message';
    const rootMsgId = (data.root_msg_id as string) || '';
    const cardKey = roundId || ticketId;
    if (!rootMsgId && !this.streamState.has(cardKey)) return;
    if (!this.streamState.has(cardKey)) {
      const card = await this.createStreamingCard(rootMsgId);
      if (!card) return;
      this.streamState.set(cardKey, { cardId: card.cardId, seq: 0, think: '', answer: '' });
    }
    const st = this.streamState.get(cardKey)!;
    const dc = `https://${this.env.OPEN_API_DOMAIN || 'open.feishu.cn'}`;
    const token = await this.getStreamToken();
    if (!token) return;
    if (contentType === 'thinking') {
      st.think += (st.think ? '\n' : '') + '> ' + content.replace(/\n/g, '\n> ');
    } else {
      st.answer += (st.answer ? '\n' : '') + content;
    }
    st.seq++;
    await this.updateCardElement(st.cardId, contentType === 'thinking' ? 'stream_thinking' : 'stream_answer',
      contentType === 'thinking' ? st.think : st.answer, st.seq, token, dc);
  }

  private async handleStreamEnd(data: Record<string, unknown>): Promise<void> {
    const cfg = this.enrichedCfg ?? this.baseCfg;
    if (!cfg.coordinator?.streamOutput) return;
    const cardKey = (data.round_id as string) || (data.ticket_id as string);
    const st = this.streamState.get(cardKey);
    if (!st) return;
    const dc = `https://${this.env.OPEN_API_DOMAIN || 'open.feishu.cn'}`;
    const token = await this.getStreamToken();
    if (!token) return;
    if (st.think) { st.seq++; await this.updateCardElement(st.cardId, 'stream_thinking', st.think, st.seq, token, dc); }
    if (st.answer) { st.seq++; await this.updateCardElement(st.cardId, 'stream_answer', st.answer, st.seq, token, dc); }
    try {
      await fetch(`${dc}/open-apis/cardkit/v1/cards/${st.cardId}/settings`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: (st.answer || st.think).slice(0, 50) || '[Done]' } } }), sequence: ++st.seq, uuid: `c_${st.cardId}_${st.seq}` }),
      });
    } catch {}
    this.streamState.delete(cardKey);
  }

  private async createStreamingCard(rootMsgId: string): Promise<{ cardId: string } | null> {
    const dc = `https://${this.env.OPEN_API_DOMAIN || 'open.feishu.cn'}`;
    const token = await this.getStreamToken();
    if (!token || !rootMsgId) return null;
    try {
      const resp = await fetch(`${dc}/open-apis/cardkit/v1/cards`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'card_json', data: JSON.stringify({ schema: '2.0', config: { streaming_mode: true, summary: { content: '[Generating...]' }, streaming_config: { print_frequency_ms: { default: 70 }, print_step: { default: 1 }, print_strategy: 'fast' } }, body: { elements: [{ tag: 'markdown', element_id: 'stream_thinking', content: '', text_size: 'text_size_note' }, { tag: 'markdown', element_id: 'stream_answer', content: '...' }, { tag: 'markdown', element_id: 'stream_stats', content: '', text_size: 'body' }] } }) }),
      });
      const d = await resp.json() as any;
      if (d.code !== 0 || !d.data?.card_id) return null;
      const cardId = d.data.card_id;
      await fetch(`${dc}/open-apis/im/v1/messages/${rootMsgId}/reply`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: cardId } }), reply_in_thread: true }),
      });
      return { cardId };
    } catch { return null; }
  }

  private async updateCardElement(cardId: string, elementId: string, content: string, seq: number, token: string, dc: string): Promise<void> {
    try {
      await fetch(`${dc}/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, sequence: seq, uuid: `${elementId}_${cardId}_${seq}` }),
      });
    } catch {}
  }

  private async getStreamToken(): Promise<string | null> {
    const dc = `https://${this.env.OPEN_API_DOMAIN || 'open.feishu.cn'}`;
    try {
      const resp = await fetch(`${dc}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.env.LARK_APP_ID, app_secret: this.env.LARK_APP_SECRET }),
      });
      const d = await resp.json() as any;
      return d.tenant_access_token || null;
    } catch { return null; }
  }
    }
  }
}

// ---- Message parsing helpers -----------------------------------------------

/** Extract plain text from a Lark IM message event. */
function parseMessageToText(msg: Record<string, unknown>): string {
  const msgType = String(msg.message_type ?? '');
  const rawContent = String(msg.content ?? '');

  if (msgType === 'text') {
    try {
      const parsed = JSON.parse(rawContent);
      return (parsed.text ?? rawContent).replace(/@_user_\d+/g, '').trim();
    } catch {
      return rawContent.replace(/@_user_\d+/g, '').trim();
    }
  }

  if (msgType === 'post') {
    try {
      const parsed = JSON.parse(rawContent);
      const section = parsed.content ? parsed : Object.values(parsed)[0] as any;
      if (!section?.content) return '';
      const lines: string[] = [];
      for (const para of section.content) {
        if (!Array.isArray(para)) { lines.push(''); continue; }
        const parts = para.map((e: any) => {
          if (e.tag === 'text') return e.text ?? '';
          if (e.tag === 'a') return e.text ?? e.href ?? '';
          if (e.tag === 'at') return `@${e.user_name ?? 'user'}`;
          return '';
        });
        lines.push(parts.filter(Boolean).join(''));
      }
      return lines.join('\n\n').trim();
    } catch { return ''; }
  }

  if (msgType === 'interactive') {
    try {
      const parsed = JSON.parse(rawContent);
      const elements: any[] = parsed?.body?.elements ?? parsed?.elements ?? [];
      return elements
        .filter((e: any) => e.tag === 'markdown' || e.tag === 'div')
        .map((e: any) => e.content || e.text?.content || '')
        .filter(Boolean)
        .join('\n\n')
        .trim();
    } catch { return ''; }
  }

  return '';
}
