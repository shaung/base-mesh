// ---------------------------------------------------------------------------
// Lark IM adapter for Cloudflare Workers
//
// Implements the LarkAdapter interface using fetch() calls directly,
// without the @larksuiteoapi/node-sdk (Node.js only).
//
// Handles: reply, react, removeReaction, fetchMessageText, sendMessage
// ---------------------------------------------------------------------------

import type { Env } from '../index.js';
import type { FeishuAdapter, FeishuCredentials } from '../../../core/types.js';

/** Base URL for Lark Open API. */
function baseUrl(domain: string): string {
  return `https://${domain}`;
}

/** Credentials-plus-domain tuple for tenant token fetching. */
interface CredKey {
  appId: string;
  appSecret: string;
  domain: string;
}

/** Cache for tenant access tokens keyed by credentials. */
const tokenCache = new Map<CredKey, { token: string; expiresAt: number }>();

function makeCredKey(appId: string, appSecret: string, domain: string): CredKey {
  // Use a simple object — injection-safe since we control all callers.
  return { appId, appSecret, domain };
}

/** Fetch and cache a tenant_access_token. */
async function fetchTenantToken(appId: string, appSecret: string, domain: string): Promise<string | null> {
  const key = makeCredKey(appId, appSecret, domain);
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  try {
    const resp = await fetch(`${baseUrl(domain)}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const data = await resp.json() as Record<string, unknown>;
    const token = (data.tenant_access_token as string) || null;
    if (token) tokenCache.set(key, { token, expiresAt: Date.now() + 55 * 60 * 1000 });
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
  private domain: string;
  private appId: string;
  private appSecret: string;

  constructor(env: Env);
  constructor(credentials: FeishuCredentials, domain: string);
  constructor(...args: any[]) {
    if (args[0] && typeof args[0] === 'object' && 'appId' in args[0] && !('LARK_APP_ID' in args[0])) {
      // Operator credentials constructor
      const creds = args[0] as FeishuCredentials;
      this.appId = creds.appId;
      this.appSecret = creds.appSecret || '';
      this.domain = args[1] || 'open.larksuite.com';
    } else {
      // Env constructor (primary app)
      const env = args[0] as Env;
      this.appId = env.LARK_APP_ID;
      this.appSecret = env.LARK_APP_SECRET;
      this.domain = env.OPEN_API_DOMAIN || 'open.larksuite.com';
    }
  }

  async getTenantToken(): Promise<string | null> {
    return fetchTenantToken(this.appId, this.appSecret, this.domain);
  }

  /** Reply to a message, optionally in thread mode. */
  async reply(
    messageId: string,
    content: string,
    replyInThread = true,
    msgType: 'interactive' | 'text' = 'interactive',
  ): Promise<void> {
    if (!content.trim()) return;
    const token = await fetchTenantToken(this.appId, this.appSecret, this.domain);
    if (!token) throw new Error('No tenant token available');

    const body: Record<string, unknown> = {
      msg_type: msgType,
      content: msgType === 'interactive' ? textCard(content) : JSON.stringify({ text: content }),
      reply_in_thread: replyInThread,
    };

    const resp = await fetch(
      `${baseUrl(this.domain)}/open-apis/im/v1/messages/${messageId}/reply`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({})) as Record<string, unknown>;
      const code = (errData as any).code;
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
    const token = await fetchTenantToken(this.appId, this.appSecret, this.domain);
    if (!token) return;
    await fetch(`${baseUrl(this.domain)}/open-apis/im/v1/messages/${messageId}/reactions`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
    });
  }

  // ── CardKit streaming card methods ──────────────────────────────────────

  async createStreamingCard(cardSpec: object, rootMsgId: string, replyInThread = true): Promise<string | null> {
    const token = await fetchTenantToken(this.appId, this.appSecret, this.domain);
    if (!token) return null;
    try {
      const resp = await fetch(`${baseUrl(this.domain)}/open-apis/cardkit/v1/cards`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'card_json', data: JSON.stringify(cardSpec) }),
      });
      const d = await resp.json() as any;
      if (d.code !== 0 || !d.data?.card_id) return null;
      const cardId = d.data.card_id;
      await fetch(`${baseUrl(this.domain)}/open-apis/im/v1/messages/${rootMsgId}/reply`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: cardId } }), reply_in_thread: replyInThread }),
      });
      return cardId;
    } catch { return null; }
  }

  async updateCardElement(cardId: string, elementId: string, content: string, seq: number, uuid: string): Promise<void> {
    const token = await fetchTenantToken(this.appId, this.appSecret, this.domain);
    if (!token) return;
    try {
      await fetch(`${baseUrl(this.domain)}/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`, {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, sequence: seq, uuid }),
      });
    } catch { /* best-effort */ }
  }

  async disableStreamingMode(cardId: string, seq: number, summary: string, uuid: string): Promise<void> {
    const token = await fetchTenantToken(this.appId, this.appSecret, this.domain);
    if (!token) return;
    try {
      await fetch(`${baseUrl(this.domain)}/open-apis/cardkit/v1/cards/${cardId}/settings`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: summary } } }), sequence: seq, uuid }),
      });
    } catch { /* best-effort */ }
  }

  /** Find and remove a reaction by emoji type. */
  async removeReaction(messageId: string, emojiType: string): Promise<void> {
    const token = await fetchTenantToken(this.appId, this.appSecret, this.domain);
    if (!token) return;
    const listResp = await fetch(`${baseUrl(this.domain)}/open-apis/im/v1/messages/${messageId}/reactions`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!listResp.ok) return;
    const listData = await listResp.json() as Record<string, unknown>;
    const items = (listData as any).data?.items ?? [];
    for (const r of items) {
      if (r.reaction_type?.emoji_type === emojiType && r.reaction_id) {
        await fetch(`${baseUrl(this.domain)}/open-apis/im/v1/messages/${messageId}/reactions/${r.reaction_id}`, {
          method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` },
        });
        return;
      }
    }
  }

  /** Fetch a message's text content by message ID. */
  async fetchMessageText(messageId: string): Promise<string> {
    const token = await fetchTenantToken(this.appId, this.appSecret, this.domain);
    if (!token) return '';
    const resp = await fetch(`${baseUrl(this.domain)}/open-apis/im/v1/messages/${messageId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!resp.ok) return '';
    const data = await resp.json() as Record<string, unknown>;
    const msg = (data as any)?.data?.items?.[0];
    if (!msg?.msg_type || !msg?.body?.content) return '';
    const msgType = msg.msg_type as string;
    const rawContent = msg.body.content as string;
    if (msgType === 'text') {
      try { return JSON.parse(rawContent).text ?? rawContent; } catch { return rawContent; }
    }
    if (msgType === 'post') {
      try {
        const parsed = JSON.parse(rawContent);
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
    const token = await fetchTenantToken(this.appId, this.appSecret, this.domain);
    if (!token) return;
    await fetch(`${baseUrl(this.domain)}/open-apis/im/v1/messages`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receive_id: chatId, msg_type: 'interactive', content: textCard(content) }),
    });
  }
}
