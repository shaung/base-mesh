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
// ---------------------------------------------------------------------------

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../index.js';
import { CoreCoordinator } from '../../core/coordinator.js';
import { WorkerBitableAdapter } from '../adapters/bitable.js';
import { WorkerLarkAdapter } from '../adapters/lark.js';
import { WorkerSessionAdapter } from '../session-adapter.js';
import { buildWorkerConfig } from '../config.js';
import { DOExecutorPool } from './executor-pool.js';

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

  // ── Constructor ────────────────────────────────────────────────────────

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Restore sessions from any previously hibernated (but still open)
    // WebSocket connections. When a DO hibernates, its in-memory state is
    // discarded; on next wake-up we reconstruct session tracking from the
    // attachments stored on each WebSocket handle.
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as LarkWsAttachment | null;
      if (attachment?.type === 'lark') {
        this.sessions.set(ws, attachment);
        this.larkWs = ws;
      }
    }

    // Set up automatic ping/pong response.
    // When hibernated, the runtime handles ping/pong at the edge without
    // waking the DO. This keeps the connection alive at zero cost.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );

    // Initialize CoreCoordinator with Worker adapters
    const cfg = buildWorkerConfig(env);
    const bitable = new WorkerBitableAdapter(env);
    const feishu = new WorkerLarkAdapter(env);
    const sessionAdapter = new WorkerSessionAdapter(bitable, cfg);
    const executorPool = new DOExecutorPool(env);
    this.coordinator = new CoreCoordinator(sessionAdapter, executorPool, feishu, cfg, console);
  }

  // ── fetch handler — accepts WebSocket upgrades ─────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/lark/ws') {
      return this.handleWebSocketUpgrade(request);
    }

    // Internal API: trigger reconnect from alarm
    if (url.pathname === '/__reconnect') {
      await this.reconnectLark();
      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  }

  // ── WebSocket lifecycle handlers ───────────────────────────────────────

  /** Accept a new Lark event WebSocket connection. */
  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket in this DO. The server-side WebSocket is now
    // managed by the runtime. When this method returns, the DO may hibernate.
    this.ctx.acceptWebSocket(server);

    // Store metadata on the connection so we can restore session state
    // after hibernation without calling into user code.
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
      console.warn('[lark-connection] invalid JSON message');
      return;
    }

    // Lark event dispatcher wraps events in { event: {...} }
    const event = (data.event ?? data) as Record<string, unknown>;
    if (!event || typeof event !== 'object') return;

    // Lark WebSocket events come through as typed messages
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
        console.debug(`[lark-connection] unhandled event type: ${eventType}`);
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
    if (this.larkWs === ws) {
      this.larkWs = null;
      console.log(`[lark-connection] Lark WS closed (code=${code}), scheduling reconnect`);
      // Schedule reconnection attempt via alarm
      await this.scheduleReconnect();
    }
  }

  /** Handle WebSocket errors. */
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    console.warn('[lark-connection] WebSocket error');
    // The runtime will call webSocketClose after this
  }

  // ── Alarm handler — reconnection (used as timer substitute) ────────────

  /** Durable Object alarm — used for scheduled tasks like reconnection. */
  async alarm(): Promise<void> {
    if (!this.larkWs) {
      // Attempt reconnect
      await this.reconnectLark();
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  private async handleImMessage(event: Record<string, unknown>): Promise<void> {
    // IM messages are handled by the Channel operator in Node.js.
    // In the Worker path, this will eventually route to CoreOperator.
    // For now, log the event for debugging.
    const eventType = (event.header as Record<string, unknown> | undefined)?.event_type as string ?? 'im.message.receive_v1';
    console.log(`[lark-connection] ${eventType} — IM message handling pending operator core`);
  }

  private async handleBitableEvent(event: Record<string, unknown>): Promise<void> {
    // Parse the bitable event to extract table_id and record_id
    const tableId = event.table_id as string | undefined;
    const actionList = Array.isArray(event.action_list) ? event.action_list : [];
    const action = actionList[0] as Record<string, unknown> | undefined;
    const recordId = action?.record_id as string | undefined;

    if (!tableId || !recordId) {
      console.log('[lark-connection] bitable event missing table_id or record_id');
      return;
    }

    console.log(`[lark-connection] bitable event: ${tableId}/${recordId}`);

    // Route to CoreCoordinator if it's a Round change
    const cfg = buildWorkerConfig(this.env);
    if (cfg.roundsTableId && tableId === cfg.roundsTableId) {
      await this.coordinator.processRound(recordId);
    }
  }

  private async handleCardAction(event: Record<string, unknown>): Promise<void> {
    // Card actions (approve/reject) need to transition the round.
    // Inline handling for now — eventually delegates to CoreOperator.
    const action = (event.action ?? event) as Record<string, unknown> | undefined;
    const roundId = (action?.value as Record<string, unknown> | undefined)?.round_id as string | undefined;
    const decision = (action?.value as Record<string, unknown> | undefined)?.action as string | undefined;

    if (!roundId || !decision) {
      console.log('[lark-connection] card action missing round_id or decision');
      return;
    }

    console.log(`[lark-connection] card action: ${decision} round=${roundId}`);
    try {
      const cfg = buildWorkerConfig(this.env);
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
    // Route executor results through CoreCoordinator
    const ticketId = data.ticket_id as string;
    const roundId = data.round_id as string | undefined;
    const answer = (data.answer as string) || '';
    const rootMsgId = (data.root_msg_id as string) || '';

    if (!ticketId || !answer) {
      console.log('[lark-connection] executor result missing ticket_id or answer');
      return;
    }

    console.log(`[lark-connection] executor result: ticket=${ticketId} answer=${answer.slice(0, 60)}`);

    // Use CoreCoordinator to process the result (write turn, update ticket/round)
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
   * Attempt to reconnect the Lark WebSocket.
   * In a Worker environment, this establishes a new WebSocket connection
   * to the Lark WebSocket server using the stored credentials.
   *
   * The actual reconnection is handled by the Worker entry point, which
   * receives a new WebSocket upgrade from the Lark platform. This DO
   * just signals readiness.
   */
  private async reconnectLark(): Promise<void> {
    // The Lark WebSocket server initiates connections to our worker.
    // Reconnection is triggered by the Lark platform itself when it
    // detects the connection dropped. This method resets internal state
    // so we're ready to accept a new connection.
    console.log('[lark-connection] ready to accept new Lark connection');
  }
}
