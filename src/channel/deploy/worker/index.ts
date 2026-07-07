// ---------------------------------------------------------------------------
// Cloudflare Worker entry point for BAM Channel
//
// Routes:
//   /lark/ws       → LarkConnection DO (Lark WebSocket events)
//   /executor/ws   → ExecutorPool DO (Executor WebSocket connections)
//   /health        → Health check
// ---------------------------------------------------------------------------

import { LarkConnection } from './do/lark-connection.js';
import { ExecutorPool } from './do/executor-pool.js';

export { LarkConnection, ExecutorPool };

export interface Env {
  // Durable Object bindings
  LARK_CONNECTION: DurableObjectNamespace<LarkConnection>;
  EXECUTOR_POOL: DurableObjectNamespace<ExecutorPool>;

  // Secrets
  LARK_APP_ID: string;
  LARK_APP_SECRET: string;
  BITABLE_APP_TOKEN: string;
  BITABLE_TICKETS_TABLE_ID: string;
  BITABLE_TURNS_TABLE_ID: string;
  BITABLE_ROSTER_TABLE_ID: string;
  BITABLE_ROUNDS_TABLE_ID?: string;
  BITABLE_DOMAINS_TABLE_ID?: string;
  BITABLE_CONFIGS_TABLE_ID?: string;

  // Open API domain (default: open.larksuite.com)
  OPEN_API_DOMAIN?: string;

  // A2A API token (optional)
  A2A_API_TOKEN?: string;

  // Coordinator config
  COORDINATOR_PORT?: string;
  COORDINATOR_GLOBAL_PROMPT?: string;
  COORDINATOR_STREAM_OUTPUT?: string;
  COORDINATOR_STREAM_THINKING?: string;
  COORDINATOR_HEARTBEAT_SECONDS?: string;
  COORDINATOR_POLL_INTERVAL_SECONDS?: string;

  // Executor config
  EXECUTOR_APPROVAL_TIMEOUT_MINUTES?: string;

  // Field mappings (JSON-encoded)
  FIELDS_TICKET?: string;
  FIELDS_TURN?: string;
  FIELDS_ROSTER?: string;
  FIELDS_ROUND?: string;

  // Status mappings (JSON-encoded)
  STATUSES?: string;
  ROUND_STATUSES?: string;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

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
      // Shard by executor_id: each executor gets its own DO instance
      const executorId = url.searchParams.get('executor_id');
      const shardKey = executorId || `anon_${crypto.randomUUID()}`;
      const id = env.EXECUTOR_POOL.idFromName(shardKey);
      const stub = env.EXECUTOR_POOL.get(id);
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
