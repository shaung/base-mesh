// ---------------------------------------------------------------------------
// ExecutorPool Durable Object
//
// Manages a shard of push executor WebSocket connections. Each DO instance
// is responsible for a set of executors sharded by executor_id.
//
// Responsibilities:
//   - Accept WebSocket connections from executors
//   - Authenticate executors via Lark OAuth token or session token
//   - Track executor identity, domains, and heartbeat
//   - Dispatch tasks to available executors
//   - Handle streaming updates from executors
//
// Uses WebSocket Hibernation API to reduce cost when idle.
// ---------------------------------------------------------------------------

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../index.js';
import type { ExecutorPoolInterface, ExecutorInfo } from '../../../core/types.js';

// ---- Types -----------------------------------------------------------------

interface ExecutorState {
  ws: WebSocket;
  identity: string;
  domains: string[];
  connectedAt: number;
  lastHeartbeat: number;
  activeTicketId?: string;
}

interface ExecutorWsAttachment {
  type: 'executor';
  identity: string;
  domains: string[];
}

// ---- Durable Object --------------------------------------------------------

export class ExecutorPool extends DurableObject<Env> {
  /** Active executors in this shard. */
  private executors = new Map<string, ExecutorState>();
  /** Identity lookup keyed by WebSocket. */
  private wsToIdentity = new Map<WebSocket, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Restore sessions from previous DO activation
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as ExecutorWsAttachment | null;
      if (attachment?.type === 'executor') {
        const state: ExecutorState = {
          ws,
          identity: attachment.identity,
          domains: attachment.domains,
          connectedAt: Date.now(),
          lastHeartbeat: Date.now(),
        };
        this.executors.set(attachment.identity, state);
        this.wsToIdentity.set(ws, attachment.identity);
      }
    }

    // Auto ping/pong at the edge
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );
  }

  // ── fetch — accept WebSocket upgrades or handle internal requests ──────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/executor/ws') {
      return this.handleWebSocketUpgrade(request);
    }

    // Internal REST API for dispatching tasks to executors in this shard
    if (url.pathname === '/dispatch' && request.method === 'POST') {
      return this.handleDispatch(request);
    }

    // List executors in this shard
    if (url.pathname === '/executors') {
      const list = Array.from(this.executors.values()).map(e => ({
        identity: e.identity,
        domains: e.domains,
        connected: true,
        lastHeartbeat: e.lastHeartbeat,
        activeTicketId: e.activeTicketId,
      }));
      return new Response(JSON.stringify(list), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Force a heartbeat sweep
    if (url.pathname === '/heartbeat-sweep') {
      this.sweepStaleExecutors();
      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  }

  // ── WebSocket lifecycle ────────────────────────────────────────────────

  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    // Initially store minimal attachment — identity is set after auth
    server.serializeAttachment({
      type: 'executor',
      identity: '',
      domains: [],
    } satisfies ExecutorWsAttachment);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);

    // Heartbeat
    if (text.trim() === 'ping') {
      this.updateHeartbeat(ws);
      return;
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
    } catch {
      console.warn('[executor-pool] invalid JSON');
      return;
    }

    const type = data.type as string | undefined;
    if (!type) return;

    switch (type) {
      case 'auth':
        await this.handleAuth(ws, data);
        break;
      case 'reauth':
        await this.handleReauth(ws, data);
        break;
      case 'auth_token':
        await this.handleAuthToken(ws, data);
        break;
      case 'result':
        await this.handleResult(ws, data);
        break;
      case 'stream_update':
        await this.handleStreamUpdate(ws, data);
        break;
      case 'stream_end':
        await this.handleStreamEnd(ws, data);
        break;
      default:
        console.debug(`[executor-pool] unknown message type: ${type}`);
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const identity = this.wsToIdentity.get(ws);
    if (identity) {
      console.log(`[executor-pool] executor disconnected: ${identity}`);
      this.executors.delete(identity);
      this.wsToIdentity.delete(ws);
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const identity = this.wsToIdentity.get(ws);
    console.warn(`[executor-pool] WebSocket error${identity ? `: ${identity}` : ''}`);
    // webSocketClose will follow
  }

  // ── Auth handlers (follow existing Coordinator pattern) ─────────────────

  /** Handle initial auth request: executor sends identity, server asks for token. */
  private async handleAuth(ws: WebSocket, data: Record<string, unknown>): Promise<void> {
    const identity = (data.identity as string) || '';
    console.log(`[executor-pool] auth requested for ${identity}`);

    ws.send(JSON.stringify({
      type: 'auth_required',
      appId: this.env.LARK_APP_ID,
      openApiDomain: this.env.OPEN_API_DOMAIN || 'open.larksuite.com',
    }));
  }

  /** Handle token-based auth: validate Lark OAuth token. */
  private async handleAuthToken(ws: WebSocket, data: Record<string, unknown>): Promise<void> {
    const token = data.token as string;
    const identity = (data.identity as string) || '';
    const domains = Array.isArray(data.domains) ? data.domains as string[] : [];

    if (!token) {
      ws.send(JSON.stringify({ type: 'error', message: 'token required' }));
      ws.close();
      return;
    }

    // Validate token against Lark Open API
    const domain = this.env.OPEN_API_DOMAIN || 'open.larksuite.com';
    let valid = false;
    try {
      const resp = await fetch(`https://${domain}/open-apis/authen/v1/user_info`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await resp.json() as Record<string, unknown>;
      valid = (body as any).code === 0;
    } catch {
      // Token validation failed
    }

    if (!valid) {
      ws.send(JSON.stringify({ type: 'error', message: 'auth failed' }));
      ws.close();
      return;
    }

    // Register executor
    this.registerExecutor(ws, identity, domains);

    ws.send(JSON.stringify({
      type: 'auth_ok',
      session_token: `session_${identity}_${Date.now()}`,
    }));

    console.log(`[executor-pool] executor authenticated: ${identity} domains=[${domains.join(',')}]`);
  }

  /** Handle re-authentication with existing session token. */
  private async handleReauth(ws: WebSocket, data: Record<string, unknown>): Promise<void> {
    const sessionToken = data.session_token as string;
    const identity = (data.identity as string) || '';
    const domains = Array.isArray(data.domains) ? data.domains as string[] : [];

    if (!sessionToken || !identity) {
      ws.send(JSON.stringify({ type: 'error', message: 'session_token and identity required' }));
      ws.close();
      return;
    }

    // TODO: Validate session token against stored sessions
    // For now, accept any well-formed session token
    if (!sessionToken.startsWith('session_')) {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid session' }));
      ws.close();
      return;
    }

    this.registerExecutor(ws, identity, domains);
    ws.send(JSON.stringify({ type: 'reauth_ok' }));
    console.log(`[executor-pool] executor re-authenticated: ${identity}`);
  }

  // ── Result handlers ────────────────────────────────────────────────────

  private async handleResult(ws: WebSocket, data: Record<string, unknown>): Promise<void> {
    const identity = this.wsToIdentity.get(ws);
    if (!identity) {
      ws.send(JSON.stringify({ type: 'error', message: 'not authenticated' }));
      return;
    }

    console.log(`[executor-pool] result from ${identity}: ticket=${data.ticket_id}`);

    // Clear active ticket
    const ex = this.executors.get(identity);
    if (ex) {
      ex.activeTicketId = undefined;
    }

    // Acknowledge receipt
    ws.send(JSON.stringify({ type: 'ack' }));

    // TODO: Forward result to Bitable via the Coordinator core
  }

  private async handleStreamUpdate(ws: WebSocket, data: Record<string, unknown>): Promise<void> {
    const identity = this.wsToIdentity.get(ws);
    if (!identity) return;
    // TODO: Forward streaming updates to Lark card
    console.log(`[executor-pool] stream update from ${identity}: ticket=${data.ticket_id}`);
  }

  private async handleStreamEnd(ws: WebSocket, data: Record<string, unknown>): Promise<void> {
    const identity = this.wsToIdentity.get(ws);
    if (!identity) return;
    // TODO: Finalize streaming card and write result
    console.log(`[executor-pool] stream end from ${identity}: ticket=${data.ticket_id}`);
  }

  // ── Task dispatch ──────────────────────────────────────────────────────

  /**
   * Dispatch a task to an executor in this shard by identity.
   * POST /dispatch with JSON body: { identity, payload }
   */
  private async handleDispatch(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    const identity = body.identity as string;
    const payload = body.payload as Record<string, unknown>;

    if (!identity || !payload) {
      return new Response('Missing identity or payload', { status: 400 });
    }

    const sent = this.dispatchTask(identity, payload);
    return new Response(JSON.stringify({ sent }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /** Send a task payload to a specific executor. Returns true if sent. */
  dispatchTask(identity: string, payload: unknown): boolean {
    const ex = this.executors.get(identity);
    if (!ex) return false;

    try {
      ex.ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      console.error(`[executor-pool] failed to send to ${identity}:`, err);
      return false;
    }
  }

  /** Send a message to all connected executors in this shard. */
  broadcast(message: string): number {
    let count = 0;
    for (const [, ex] of this.executors) {
      try {
        ex.ws.send(message);
        count++;
      } catch {
        // Skip failed sends
      }
    }
    return count;
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private registerExecutor(ws: WebSocket, identity: string, domains: string[]): void {
    // Remove old registration if identity was previously connected via a different WS
    const old = this.executors.get(identity);
    if (old && old.ws !== ws) {
      try { old.ws.close(1000, 'replaced'); } catch { /* */ }
      this.wsToIdentity.delete(old.ws);
    }

    const state: ExecutorState = {
      ws,
      identity,
      domains,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
    };

    this.executors.set(identity, state);
    this.wsToIdentity.set(ws, identity);

    // Persist identity on the WebSocket attachment for hibernation recovery
    ws.serializeAttachment({
      type: 'executor',
      identity,
      domains,
    } satisfies ExecutorWsAttachment);
  }

  private updateHeartbeat(ws: WebSocket): void {
    const identity = this.wsToIdentity.get(ws);
    if (identity) {
      const ex = this.executors.get(identity);
      if (ex) {
        ex.lastHeartbeat = Date.now();
      }
    }
  }

  /** Remove executors that haven't sent a heartbeat in > 120s. */
  private sweepStaleExecutors(): void {
    const staleThreshold = Date.now() - 120_000;
    for (const [identity, ex] of this.executors) {
      if (ex.lastHeartbeat < staleThreshold) {
        console.log(`[executor-pool] sweeping stale executor: ${identity}`);
        try { ex.ws.close(1000, 'stale'); } catch { /* */ }
        this.executors.delete(identity);
        this.wsToIdentity.delete(ex.ws);
      }
    }
  }
}

// =============================================================================
// DOExecutorPool — implements ExecutorPoolInterface by calling the ExecutorPool
// DO via internal fetch. Used by CoreCoordinator running in LarkConnection DO.
// =============================================================================

/** Resolve the DO stub for a given executor_id. */
function executorPoolStub(env: Env, executorId: string): DurableObjectStub {
  const id = env.EXECUTOR_POOL.idFromName(executorId);
  return env.EXECUTOR_POOL.get(id);
}

export class DOExecutorPool implements ExecutorPoolInterface {
  constructor(private env: Env) {}

  getAvailableExecutors(_domains?: string[]): ExecutorInfo[] {
    // Non-blocking: returns empty list. In practice, executors are spread
    // across DO shards, so a full listing requires iterating all shards.
    // Use the /executors endpoint on individual DO stubs for targeted lookups.
    return [];
  }

  dispatchTask(executorId: string, payload: unknown): boolean {
    const stub = executorPoolStub(this.env, executorId);
    // Fire-and-forget — the DO will handle the dispatch asynchronously.
    stub.fetch('http://do/dispatch', {
      method: 'POST',
      body: JSON.stringify({ identity: executorId, payload }),
    }).catch(() => {});
    return true;
  }

  dispatchCancel(executorId: string, _roundId: string): boolean {
    const stub = executorPoolStub(this.env, executorId);
    stub.fetch('http://do/cancel', {
      method: 'POST',
      body: JSON.stringify({ identity: executorId, round_id: _roundId }),
    }).catch(() => {});
    return true;
  }

  broadcast(message: string): number {
    // Broadcasting across all shards is not supported from a single DO.
    // Each shard's ExecutorPool DO handles broadcast within its shard.
    return 0;
  }
}

/** No-op executor pool — used when no executors are connected or
 *  when the executor pool is managed by a separate DO. */
export class NoopExecutorPool implements ExecutorPoolInterface {
  getAvailableExecutors(): ExecutorInfo[] { return []; }
  dispatchTask(): boolean { return false; }
  dispatchCancel(): boolean { return false; }
  broadcast(): number { return 0; }
}
