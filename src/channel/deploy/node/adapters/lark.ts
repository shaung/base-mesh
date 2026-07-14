// ---------------------------------------------------------------------------
// NodeLarkAdapter — wraps @larksuiteoapi/node-sdk Client as FeishuAdapter
//
// Implements FeishuAdapter (including CardKit methods) using the Lark Node.js
// SDK, for use with CoreCoordinator in the Node.js deployment path.
// ---------------------------------------------------------------------------

import type { Client } from '@larksuiteoapi/node-sdk';
import type { FeishuAdapter } from '../../../core/types.js';

/** Build MessageKit card JSON for a text reply. */
function textCard(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    body: {
      elements: [{ tag: 'markdown', content: text }],
    },
  });
}

export class NodeLarkAdapter implements FeishuAdapter {
  constructor(
    private getClient: (appId?: string) => Client,
  ) {}

  async getTenantToken(): Promise<string | null> {
    try {
      const resp = await this.getClient().request<{ tenant_access_token?: string }>({
        method: 'POST',
        url: '/open-apis/auth/v3/tenant_access_token/internal',
        data: {} as any,
      });
      return resp.tenant_access_token ?? null;
    } catch { return null; }
  }

  async reply(
    messageId: string, content: string, replyInThread = true,
    msgType: 'interactive' | 'text' = 'interactive',
  ): Promise<void> {
    if (!content.trim()) return;
    const client = this.getClient();
    const body: Record<string, unknown> = {
      msg_type: msgType,
      content: msgType === 'interactive' ? textCard(content) : JSON.stringify({ text: content }),
      reply_in_thread: replyInThread,
    };
    try {
      await (client as any).im.v1.message.reply({
        path: { message_id: messageId },
        data: body,
      });
    } catch (err: any) {
      const apiCode = err?.response?.data?.code ?? err?.code;
      if (apiCode === 230099 || String(err?.message ?? err).includes('card table number over limit')) {
        if (msgType === 'interactive') {
          await this.reply(messageId, content, replyInThread, 'text');
          return;
        }
      }
      throw err;
    }
  }

  async react(messageId: string, emojiType: string): Promise<void> {
    try {
      await (this.getClient() as any).im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
    } catch { /* best-effort */ }
  }

  async removeReaction(messageId: string, emojiType: string): Promise<void> {
    try {
      const listResp = await (this.getClient() as any).im.v1.messageReaction.list({
        path: { message_id: messageId },
      });
      const items = listResp?.data?.items ?? [];
      for (const r of items) {
        if (r.reaction_type?.emoji_type === emojiType && r.reaction_id) {
          await (this.getClient() as any).im.v1.messageReaction.delete({
            path: { message_id: messageId, reaction_id: r.reaction_id },
          });
          return;
        }
      }
    } catch { /* best-effort */ }
  }

  async fetchMessageText(messageId: string): Promise<string> {
    try {
      const resp = await (this.getClient() as any).im.v1.message.get({
        path: { message_id: messageId },
      });
      const msg = resp?.data?.items?.[0];
      if (!msg?.msg_type || !msg?.body?.content) return '';
      const rawContent = msg.body.content as string;
      if (msg.msg_type === 'text') {
        try { return JSON.parse(rawContent).text ?? rawContent; } catch { return rawContent; }
      }
      if (msg.msg_type === 'post') {
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
    } catch { return ''; }
  }

  async sendMessage(chatId: string, content: string): Promise<void> {
    try {
      await (this.getClient() as any).im.v1.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: textCard(content),
        },
      });
    } catch { /* best-effort */ }
  }

  // ── CardKit streaming card methods ──────────────────────────────────────

  async createStreamingCard(cardSpec: object, rootMsgId: string, replyInThread = true): Promise<string | null> {
    const client = this.getClient();
    try {
      const cardResp = await (client as any).cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify(cardSpec) },
      });
      const cardId = cardResp?.data?.card_id;
      if (!cardId) return null;
      const sendResp = await (client as any).im.v1.message.reply({
        path: { message_id: rootMsgId },
        data: { msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: cardId } }), reply_in_thread: replyInThread },
      });
      if (!sendResp?.data?.message_id) return null;
      return cardId;
    } catch { return null; }
  }

  async updateCardElement(cardId: string, elementId: string, content: string, seq: number, uuid: string): Promise<void> {
    try {
      await (this.getClient() as any).cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: elementId },
        data: { content, sequence: seq, uuid },
      });
    } catch { /* best-effort */ }
  }

  async disableStreamingMode(cardId: string, seq: number, summary: string, uuid: string): Promise<void> {
    try {
      await (this.getClient() as any).cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: summary } } }),
          sequence: seq, uuid,
        },
      });
    } catch { /* best-effort */ }
  }
}
