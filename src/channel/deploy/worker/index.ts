// ---------------------------------------------------------------------------
// Cloudflare Worker entry point for BAM Channel
//
// Routes:
//   /feishu/ws     → FeishuConnection DO (Feishu WebSocket events)
//   /executor/ws   → ExecutorPool DO (Executor WebSocket connections)
//   /health        → Health check
// ---------------------------------------------------------------------------

import { FeishuConnection } from './do/feishu-connection.js';
import { ExecutorPool } from './do/executor-pool.js';

export { FeishuConnection, ExecutorPool };

export interface Env {
  // Durable Object bindings
  FEISHU_CONNECTION: DurableObjectNamespace<FeishuConnection>;
  EXECUTOR_POOL: DurableObjectNamespace<ExecutorPool>;

  // Secrets
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
  BITABLE_APP_TOKEN: string;
  BITABLE_TICKETS_TABLE_ID: string;
  BITABLE_TURNS_TABLE_ID: string;
  BITABLE_ROSTER_TABLE_ID: string;
  BITABLE_ROUNDS_TABLE_ID?: string;
  BITABLE_DOMAINS_TABLE_ID?: string;
  BITABLE_CONFIGS_TABLE_ID?: string;

  // Open API domain (default: open.feishu.cn)
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

// Use the nodejs_compat compatibility flag for fetch, WebSocket, crypto, etc.
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── WebSocket upgrade routes ──────────────────────────────────────

    if (path === '/feishu/ws') {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      // Single DO instance for all Feishu connections (identified by appId)
      const id = env.FEISHU_CONNECTION.idFromName(env.FEISHU_APP_ID);
      const stub = env.FEISHU_CONNECTION.get(id);
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
        appId: env.FEISHU_APP_ID,
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
