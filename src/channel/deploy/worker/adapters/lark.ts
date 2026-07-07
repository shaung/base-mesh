// ---------------------------------------------------------------------------
// Lark IM adapter for Cloudflare Workers
//
// Implements the LarkAdapter interface using fetch() calls directly,
// without the @larksuiteoapi/node-sdk (Node.js only).
//
// Handles: reply, react, removeReaction, fetchMessageText, sendMessage
// ---------------------------------------------------------------------------

import type { Env } from '../index.js';
import type { FeishuAdapter } from '../../core/types.js';          // interface has generic name

/** Base URL for Lark Open API. */
function baseUrl(env: Env): string {
  return `https://${env.OPEN_API_DOMAIN || 'open.larksuite.com'}`;
}

/** Cache for tenant access tokens (keyed by env reference). */
const tokenCache = new WeakMap<Env, { token: string; expiresAt: number }>();

/** Get a tenant_access_token using internal app credentials.
 *  Cached for 55 minutes (tokens expire in 120 min but we refresh early). */
async function getTenantToken(env: Env): Promise<string | null> {
  const cached = tokenCache.get(env);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  try {
    const resp = await fetch(`${baseUrl(env)}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: env.LARK_APP_ID,
        app_secret: env.LARK_APP_SECRET,
      }),
    });
    const data = await resp.json() as Record<string, unknown>;
    const token = (data.tenant_access_token as string) || null;
    if (token) {
      tokenCache.set(env, { token, expiresAt: Date.now() + 55 * 60 * 1000 });
    }
    return token;
  } catch (err) {
    console.error('[worker-lark] getTenantToken failed:', err);
    return null;
  }
}

/** Build MessageKit card JSON for a text reply. */
function textCard(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    body: {
      elements: [{ tag: 'markdown', content: text }],
    },
  });
}

// ---- Adapter ---------------------------------------------------------------

export class WorkerLarkAdapter implements FeishuAdapter {
  constructor(private env: Env) {}

  async getTenantToken(): Promise<string | null> {
    return getTenantToken(this.env);
  }

  /** Reply to a message, optionally in thread mode. Falls back to plain text
   *  if the card table limit is exceeded. */
  async reply(
    messageId: string,
    content: string,
    replyInThread = true,
    msgType: 'interactive' | 'text' = 'interactive',
  ): Promise<void> {
    if (!content.trim()) return;
    const token = await getTenantToken(this.env);
    if (!token) throw new Error('No tenant token available');

    const body: Record<string, unknown> = {
      msg_type: msgType,
      content: msgType === 'interactive' ? textCard(content) : JSON.stringify({ text: content }),
      reply_in_thread: replyInThread,
    };

    const resp = await fetch(
      `${baseUrl(this.env)}/open-apis/im/v1/messages/${messageId}/reply`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({})) as Record<string, unknown>;
      const code = (errData as any).code;

      // Card table limit exceeded — fall back to text
      if (code === 230099 || String(errData?.msg ?? '').includes('card table number over limit')) {
        if (msgType === 'interactive') {
          await this.reply(messageId, content, replyInThread, 'text');
          return;
        }
      }

      console.error(`[worker-lark] reply failed: ${JSON.stringify(errData).slice(0, 200)}`);
      throw new Error(`Reply failed: code=${code}`);
    }
  }

  /** Add an emoji reaction to a message. */
  async react(messageId: string, emojiType: string): Promise<void> {
    const token = await getTenantToken(this.env);
    if (!token) return;

    await fetch(
      `${baseUrl(this.env)}/open-apis/im/v1/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reaction_type: { emoji_type: emojiType },
        }),
      },
    );
  }

  /** Find and remove a reaction by emoji type. */
  async removeReaction(messageId: string, emojiType: string): Promise<void> {
    const token = await getTenantToken(this.env);
    if (!token) return;

    // List existing reactions
    const listResp = await fetch(
      `${baseUrl(this.env)}/open-apis/im/v1/messages/${messageId}/reactions`,
      { headers: { 'Authorization': `Bearer ${token}` } },
    );
    if (!listResp.ok) return;

    const listData = await listResp.json() as Record<string, unknown>;
    const items = (listData as any).data?.items ?? [];

    for (const r of items) {
      if (r.reaction_type?.emoji_type === emojiType && r.reaction_id) {
        await fetch(
          `${baseUrl(this.env)}/open-apis/im/v1/messages/${messageId}/reactions/${r.reaction_id}`,
          { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } },
        );
        return;
      }
    }
  }

  /** Fetch a message's text content by message ID. */
  async fetchMessageText(messageId: string): Promise<string> {
    const token = await getTenantToken(this.env);
    if (!token) return '';

    const resp = await fetch(
      `${baseUrl(this.env)}/open-apis/im/v1/messages/${messageId}`,
      { headers: { 'Authorization': `Bearer ${token}` } },
    );
    if (!resp.ok) return '';

    const data = await resp.json() as Record<string, unknown>;
    const msg = (data as any)?.data?.items?.[0];
    if (!msg?.msg_type || !msg?.body?.content) return '';

    // Parse message content based on type
    const msgType = msg.msg_type as string;
    const rawContent = msg.body.content as string;

    if (msgType === 'text') {
      try { return JSON.parse(rawContent).text ?? rawContent; } catch { return rawContent; }
    }
    if (msgType === 'post') {
      try {
        const parsed = JSON.parse(rawContent);
        // Extract text from post structure
        const section = parsed.content ? parsed : Object.values(parsed)[0] as any;
        if (section?.content) {
          return section.content.flatMap((p: any[]) =>
            p.map((e: any) => e.text ?? '').join(' '),
          ).join('\n').trim();
        }
      } catch { /* */ }
    }

    return '';
  }

  /** Send a message to a chat (not a reply). */
  async sendMessage(chatId: string, content: string): Promise<void> {
    const token = await getTenantToken(this.env);
    if (!token) return;

    await fetch(
      `${baseUrl(this.env)}/open-apis/im/v1/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'interactive',
          content: textCard(content),
        }),
      },
    );
  }
}
