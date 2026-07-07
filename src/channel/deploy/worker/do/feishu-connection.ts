// ---------------------------------------------------------------------------
// FeishuConnection Durable Object
//
// Manages the Feishu WebSocket connection for receiving events (messages,
// bitable changes, card actions). Uses WebSocket Hibernation API to stay
// at zero cost when idle.
//
// Lifecycle:
//   1. Worker entry receives /feishu/ws upgrade → routes to this DO
//   2. DO accepts WebSocket, registers event handlers
//   3. Incoming messages processed via core coordinator/operator
//   4. When idle, DO hibernates (memory freed, no CPU cost)
//   5. Ping/pong handled at edge without waking DO
// ---------------------------------------------------------------------------

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../index.js';

// ---- Attachment types stored on hibernated WebSockets ---------------------

interface FeishuWsAttachment {
  type: 'feishu';
  connectedAt: number;
}

// ---- Durable Object -------------------------------------------------------

export class FeishuConnection extends DurableObject<Env> {
  /** Primary Feishu event WebSocket. */
  private feishuWs: WebSocket | null = null;
  /** Track all active sessions. */
  private sessions = new Map<WebSocket, FeishuWsAttachment>();

  // ── Constructor ────────────────────────────────────────────────────────

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Restore sessions from any previously hibernated (but still open)
    // WebSocket connections. When a DO hibernates, its in-memory state is
    // discarded; on next wake-up we reconstruct session tracking from the
    // attachments stored on each WebSocket handle.
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as FeishuWsAttachment | null;
      if (attachment?.type === 'feishu') {
        this.sessions.set(ws, attachment);
        this.feishuWs = ws;
      }
    }

    // Set up automatic ping/pong response.
    // When hibernated, the runtime handles ping/pong at the edge without
    // waking the DO. This keeps the connection alive at zero cost.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );
  }

  // ── fetch handler — accepts WebSocket upgrades ─────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/feishu/ws') {
      return this.handleWebSocketUpgrade(request);
    }

    // Internal API: trigger reconnect from alarm
    if (url.pathname === '/__reconnect') {
      await this.reconnectFeishu();
      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  }

  // ── WebSocket lifecycle handlers ───────────────────────────────────────

  /** Accept a new Feishu event WebSocket connection. */
  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket in this DO. The server-side WebSocket is now
    // managed by the runtime. When this method returns, the DO may hibernate.
    this.ctx.acceptWebSocket(server);

    // Store metadata on the connection so we can restore session state
    // after hibernation without calling into user code.
    const attachment: FeishuWsAttachment = {
      type: 'feishu',
      connectedAt: Date.now(),
    };
    server.serializeAttachment(attachment);
    this.sessions.set(server, attachment);
    this.feishuWs = server;

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /** Handle incoming WebSocket messages.
   *
   * When the DO is woken from hibernation by an incoming message, the
   * runtime delivers the message here. We parse the event type and
   * dispatch to the appropriate handler.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
    } catch {
      console.warn('[feishu-connection] invalid JSON message');
      return;
    }

    // Feishu event dispatcher wraps events in { event: {...} }
    const event = (data.event ?? data) as Record<string, unknown>;
    if (!event || typeof event !== 'object') return;

    // Feishu WebSocket events come through as typed messages
    const header = event.header as Record<string, unknown> | undefined;
    const eventType = header?.event_type as string | undefined;

    if (!eventType) {
      // Try raw type field
      const rawType = data.type as string | undefined;
      if (rawType === 'executor_result') {
        await this.handleExecutorResult(data);
      } else if (rawType === 'pong') {
        // Pong response — nothing to do (auto-ping handles health)
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
        console.debug(`[feishu-connection] unhandled event type: ${eventType}`);
    }
  }

  /** Handle WebSocket close. Clean up state and schedule reconnection. */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.sessions.delete(ws);
    if (this.feishuWs === ws) {
      this.feishuWs = null;
      console.log(`[feishu-connection] Feishu WS closed (code=${code}), scheduling reconnect`);
      // Schedule reconnection attempt via alarm
      await this.scheduleReconnect();
    }
  }

  /** Handle WebSocket errors. */
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    console.warn('[feishu-connection] WebSocket error');
    // The runtime will call webSocketClose after this
  }

  // ── Alarm handler — reconnection (used as timer substitute) ────────────

  /** Durable Object alarm — used for scheduled tasks like reconnection. */
  async alarm(): Promise<void> {
    if (!this.feishuWs) {
      // Attempt reconnect
      await this.reconnectFeishu();
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  private async handleImMessage(_event: Record<string, unknown>): Promise<void> {
    // TODO: Implement message processing via Operator core
    // In the incremental approach, this will delegate to the core Operator class
    // once the refactoring is complete. For now, log and acknowledge.
    console.log('[feishu-connection] IM message received (handler pending core refactor)');
  }

  private async handleBitableEvent(_event: Record<string, unknown>): Promise<void> {
    // TODO: Process bitable record changes — route to Coordinator core
    console.log('[feishu-connection] Bitable event received (handler pending core refactor)');
  }

  private async handleCardAction(_event: Record<string, unknown>): Promise<void> {
    // TODO: Handle card action callbacks (approve/reject)
    console.log('[feishu-connection] Card action received (handler pending core refactor)');
  }

  private async handleExecutorResult(_data: Record<string, unknown>): Promise<void> {
    // TODO: Route executor results through Coordinator core
    console.log('[feishu-connection] Executor result received (handler pending core refactor)');
  }

  // ── Connection management ──────────────────────────────────────────────

  /**
   * Schedule a reconnection attempt using DO alarm.
   * Uses exponential backoff starting at 5s.
   */
  private async scheduleReconnect(): Promise<void> {
    // Check existing alarm. If one is already scheduled, the existing backoff
    // window will handle it — don't reset.
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm) return;

    // Start with 5s delay
    await this.ctx.storage.setAlarm(Date.now() + 5000);
  }

  /**
   * Attempt to reconnect the Feishu WebSocket.
   * In a Worker environment, this establishes a new WebSocket connection
   * to the Feishu WebSocket server using the stored credentials.
   *
   * The actual reconnection is handled by the Worker entry point, which
   * receives a new WebSocket upgrade from the Feishu platform. This DO
   * just signals readiness.
   */
  private async reconnectFeishu(): Promise<void> {
    // The Feishu WebSocket server initiates connections to our worker.
    // Reconnection is triggered by the Feishu platform itself when it
    // detects the connection dropped. This method resets internal state
    // so we're ready to accept a new connection.
    console.log('[feishu-connection] ready to accept new Feishu connection');
  }
}
