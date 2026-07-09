// ---------------------------------------------------------------------------
// Cloudflare Worker entry point for BAM Channel
//
// Routes:
//   /lark/ws       → LarkConnection DO (Lark WebSocket events)
//   /executor/ws   → ExecutorPool DO (Executor WebSocket connections)
//   /reload        → POST — reload runtime config from Configs table into DO
//   /health        → Health check
// ---------------------------------------------------------------------------

import { LarkConnection } from './do/lark-connection.js';
import { ExecutorPool } from './do/executor-pool.js';

export { LarkConnection, ExecutorPool };

export interface Env {
  // Durable Object bindings
  LARK_CONNECTION: DurableObjectNamespace<LarkConnection>;
  EXECUTOR_POOL: DurableObjectNamespace<ExecutorPool>;

  // Static secrets (table IDs loaded from Configs table at runtime)
  LARK_APP_ID: string;
  LARK_APP_SECRET: string;
  BITABLE_APP_TOKEN: string;
  BITABLE_CONFIGS_TABLE_ID?: string;

  // Open API domain (default: open.larksuite.com)
  OPEN_API_DOMAIN?: string;

  // A2A API token (optional)
  A2A_API_TOKEN?: string;

  // Coordinator config
  COORDINATOR_GLOBAL_PROMPT?: string;
  COORDINATOR_STREAM_OUTPUT?: string;
  COORDINATOR_STREAM_THINKING?: string;
  COORDINATOR_HEARTBEAT_SECONDS?: string;
  COORDINATOR_POLL_INTERVAL_SECONDS?: string;

  // Executor config
  EXECUTOR_APPROVAL_TIMEOUT_MINUTES?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Eagerly initialize LarkConnection DO on first request so it starts
    // connecting to the Lark event WebSocket. The DO's constructor calls
    // connectToLark() as part of initConfig(), but DOs are lazy — they
    // only spin up when they receive their first request.
    ctx.waitUntil(
      env.LARK_CONNECTION.idFromName(env.LARK_APP_ID).fetch(
        new Request('http://do/__warmup'),
      ).catch(() => {/* warmup failure is non-fatal */}),
    );

    // ── WebSocket upgrade routes ──────────────────────────────────────

    if (path === '/lark/ws') {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      // Single DO instance for all Lark connections (identified by appId)
      const id = env.LARK_CONNECTION.idFromName(env.LARK_APP_ID);
      const stub = env.LARK_CONNECTION.get(id);
      return stub.fetch(request);
    }

    if (path === '/executor/ws') {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      // All executors connect through a single DO instance. The executor's
      // identity is established via auth message after the WebSocket is open.
      const id = env.EXECUTOR_POOL.idFromName('default-pool');
      const stub = env.EXECUTOR_POOL.get(id);
      return stub.fetch(request);
    }

    // ── Config reload ─────────────────────────────────────────────────

    if (path === '/reload') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }
      // Forward to LarkConnection DO which owns the cached config
      const id = env.LARK_CONNECTION.idFromName(env.LARK_APP_ID);
      const stub = env.LARK_CONNECTION.get(id);
      return stub.fetch(request);
    }

    // ── Health check ─────────────────────────────────────────────────

    if (path === '/health') {
      return new Response(JSON.stringify({
        ok: true,
        appId: env.LARK_APP_ID,
        mode: 'worker',
        timestamp: Date.now(),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Default: 404 ─────────────────────────────────────────────────

    return new Response('Not Found', { status: 404 });
  },
};
