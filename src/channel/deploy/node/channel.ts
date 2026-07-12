import { logger } from '../../../lib/log.js';
import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { Config, Part, BotConfig } from '../../../lib/types.js';
import { parsePostToParts } from '../../../lib/messaging/message-parser.js';
import { BitableClient } from '../../../lib/bitable/client.js';
import { Session } from '../../../lib/bitable/protocol.js';
import { getDomainConfig } from '../../../lib/bitable/domain.js';
import { NodeCoordinator as Coordinator } from './coordinator.js';
import { CoreOperator } from '../../core/operator.js';
import { parseMessageContent } from '../../core/message-parser.js';
import { NodeLarkAdapter } from './adapters/lark.js';
import type { FeishuAdapter } from '../../core/types.js';
import { NodeBitableAdapter } from './adapters/bitable.js';
import { NodeSessionAdapter } from './session-adapter.js';

const DEFAULT_EMOJI = 'OneSecond';

// ---------------------------------------------------------------------------
// Per-operator client state
// ---------------------------------------------------------------------------

interface OperatorClient {
  wsClient: WSClient;
  dispatcher: EventDispatcher;
  client: Client;
  config: BotConfig;
  appId: string;
  domain?: string;
  /** Bot's own open_id, fetched from bot/v3/info, used for @-mention matching. */
  botOpenId?: string;
}

// ---------------------------------------------------------------------------
// Channel — Feishu IM communication only.
//
// Responsibilities:
//   1. Receive user DMs via WebSocket (one per operator bot)
//   2. Create draft topics and gather info (multi-turn if needed)
//   3. Optionally use LLM to assess completeness
//   4. Promote drafts to pending for executors
//   5. Poll for done topics and notify users via IM thread reply
//   6. Clean up stale draft topics
//
// Never executes tasks or sends IM on behalf of executors — that's the
// executor's job (writing results).
// ---------------------------------------------------------------------------

export class Channel {
  private operatorClients = new Map<string, OperatorClient>();
  private bitable: BitableClient;
  private session: Session;
  private client: Client;            // primary channel-credential Client for Bitable ops
  private coordinator: Coordinator | null = null;
  private coreOperator: CoreOperator;
  private feishuAdapter: NodeLarkAdapter;
  private running = true;
  private draftCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private lite: boolean;

  constructor(private cfg: Config, lite = false) {
    this.lite = lite;
    this.bitable = new BitableClient(cfg);
    this.session = new Session('channel', 'Channel', cfg, this.bitable);
    const dc = getDomainConfig(cfg.openApiDomain);
    // Primary channel-credential Client (Bitable ops, coordinator)
    this.client = new Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret || 'unused',
      domain: dc.sdkBaseUrl,
      loggerLevel: 3,
    });
    // CoreOperator for shared message processing logic
    const sessionAdapter = new NodeSessionAdapter(this.session);
    const bitableAdapter = new NodeBitableAdapter(this.bitable);
    this.feishuAdapter = new NodeLarkAdapter((appId?: string) => (appId ? this.operatorClients.get(appId)?.client : undefined) ?? this.client);
    // Build per-operator FeishuAdapters for multi-credential IM routing
    const operatorFeishus = new Map<string, FeishuAdapter>();
    if (cfg.operators) {
      for (const op of cfg.operators) {
        if (op.appId && op.appSecret && op.appId !== cfg.appId && !operatorFeishus.has(op.appId)) {
          const fixedAppId = op.appId;
          operatorFeishus.set(fixedAppId, new NodeLarkAdapter(() => this.getClient(fixedAppId)));
        }
      }
    }
    this.coreOperator = new CoreOperator(sessionAdapter, this.feishuAdapter, bitableAdapter, cfg, {
      info: (m: string, ...args: any[]) => logger.info(m, ...args),
      error: (m: string, ...args: any[]) => logger.error(m, ...args),
    } as any, operatorFeishus);
  }

  async run(): Promise<void> {
    const { enableFileLogging } = await import('../../../lib/log.js');
    enableFileLogging();

    process.on('SIGTERM', () => { this.stop(); process.exit(0); });
    process.on('SIGINT', () => { this.stop(); process.exit(0); });

    const label = this.lite ? 'channel-lite' : 'channel';
    logger.info(`[${label}] started`);

    // Load runtime config from Configs Bitable table if configured
    const { enrichConfigFromBitable } = await import('../../../lib/config.js');
    await enrichConfigFromBitable(this.cfg);

    // Start coordinator (push executor WS server) unless in lite mode
    if (!this.lite) {
      this.coordinator = new Coordinator(this.cfg);
      this.coordinator.start();
    }

    await this.subscribeBitableEvents();
    await this.connectOperatorWebSockets();

    // Draft TTL cleanup
    const ttlMs = (this.cfg.operator?.draftTTLMinutes ?? 60) * 60 * 1000;
    this.draftCleanupTimer = setInterval(() => this.coreOperator.cleanupStaleDrafts(ttlMs), ttlMs);

    while (this.running) {
      await sleep((this.cfg.operator?.pollIntervalSeconds ?? 3) * 1000);
      try {
        await this.coreOperator.deliverTurns();
      } catch { /* ignore */ }
      try {
        await this.coreOperator.deliverApprovalCards();
      } catch { /* ignore */ }
    }

    this.cleanup();
    logger.info('[channel] stopped');
    process.exit(0);
  }

  stop(): void {
    this.running = false;
    if (this.draftCleanupTimer) clearInterval(this.draftCleanupTimer);
    if (this.coordinator) this.coordinator.stop();
    for (const [, oc] of this.operatorClients) {
      try { oc.wsClient.close({ force: true }); } catch { /* ignore */ }
    }
    this.operatorClients.clear();
  }

  /** Get the Lark Client for a given appId, falling back to the primary client. */
  private getClient(appId?: string): Client {
    if (appId) {
      const oc = this.operatorClients.get(appId);
      if (oc) return oc.client;
    }
    return this.client;
  }

  // -----------------------------------------------------------------------
  // Bitable event handler — routes to coordinator for push assignment
  // -----------------------------------------------------------------------

  private recentEvents = new Set<string>();

  private async onBitableEvent(data: any): Promise<void> {
    try {
      // Feishu WS event payload: can be { event: {...} } or the event object directly
      const event = data?.event ?? data;
      if (!event || typeof event !== 'object') return;
      const tableId = event.table_id;
      if (!tableId || typeof tableId !== 'string') return;
      const actionList = Array.isArray(event.action_list) ? event.action_list : [];
      const action = actionList[0];
      const recordId = action?.record_id;
      if (!recordId || typeof recordId !== 'string') return;

      // Dedup: skip same record within 10s to prevent self-triggered loops
    const key = `${tableId}:${recordId}`;
    if (this.recentEvents.has(key)) return;
    this.recentEvents.add(key);
    setTimeout(() => this.recentEvents.delete(key), 10_000);
    // Skip log for Roster heartbeat noise
    if (tableId !== this.cfg.rosterTableId) {
      logger.info(`[channel] bitable event: ${tableId}/${recordId} ${action?.action}`);
    }

    // Dispatch by table
    if (tableId === this.cfg.ticketsTableId) {
      if (!this.cfg.roundsTableId && this.coordinator) {
        try {
          const ticket = await this.bitable.getRecord(this.cfg.ticketsTableId, recordId);
          if (!ticket) return;
          const ticketStatus = String(ticket.fields[this.cfg.fields.ticket.status] ?? '');
          if (ticketStatus === this.cfg.statuses.active && this.session.isClaimable(ticket)) {
            await this.coordinator.tryRoute(ticket);
          }
        } catch { /* */ }
      }
    } else if (tableId === this.cfg.roundsTableId) {
      if (!this.coordinator) return;
      try {
        await this.coordinator.processRound(recordId);
      } catch { /* */ }
    }
    // Note: turnsTableId events are not handled here — the main loop's
    // CoreOperator.deliverTurns() polls and delivers all notifiable turns.
    } catch (err) {
      logger.error('[channel] onBitableEvent crashed:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Event subscription
  // -----------------------------------------------------------------------

  private async subscribeBitableEvents(): Promise<void> {
    if (!this.cfg.appSecret || !this.cfg.appToken) return;
    try {
      const dc = getDomainConfig(this.cfg.openApiDomain);
      const tokenResp = await fetch(`${dc.sdkBaseUrl}/open-apis/auth/v3/app_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.cfg.appId, app_secret: this.cfg.appSecret }),
      });
      const tokenData = await tokenResp.json() as Record<string, unknown>;
      const token = tokenData.app_access_token as string;
      if (!token) { console.warn('[channel] no app token for event subscribe'); return; }

      const qs = new URLSearchParams({ file_type: 'bitable' });
      const resp = await fetch(`${dc.sdkBaseUrl}/open-apis/drive/v1/files/${this.cfg.appToken}/subscribe?${qs}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const rawBody = await resp.text();
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(rawBody); } catch { /* not JSON */ }
      if (body.code === 0) logger.info('[channel] subscribed to bitable events');
      else console.warn(`[channel] subscribe failed (HTTP ${resp.status}):`, rawBody.slice(0, 500));
    } catch (err: any) {
      console.warn(`[channel] subscribe failed: ${err.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // WebSocket — one connection per operator
  // -----------------------------------------------------------------------

  private async connectOperatorWebSockets(): Promise<void> {
    const operators = this.getOperatorList();
    for (const op of operators) {
      await this.connectOneOperator(op);
    }
  }

  /** Get list of operator configs to connect. Falls back to single channel bot. */
  private getOperatorList(): BotConfig[] {
    if (this.cfg.operators && this.cfg.operators.length > 0) {
      // Filter to operators that have appSecret (can connect WS)
      return this.cfg.operators.filter(op => op.appSecret);
    }
    // Fallback: single operator from channel credentials
    if (this.cfg.appSecret) {
      return [{
        name: 'default',
        appId: this.cfg.appId,
        appSecret: this.cfg.appSecret,
      }];
    }
    return [];
  }

  private async connectOneOperator(bot: BotConfig): Promise<void> {
    if (this.operatorClients.has(bot.appId)) return;
    if (!bot.appSecret) {
      logger.info(`[channel] operator "${bot.name}" (${bot.appId}): appSecret required for WS, skipping`);
      return;
    }

    try {
      const dc = getDomainConfig(this.cfg.openApiDomain);
      const client = new Client({
        appId: bot.appId,
        appSecret: bot.appSecret,
        domain: dc.sdkBaseUrl,
        loggerLevel: 2, // warn
      });

      const wsClient = new WSClient({
        appId: bot.appId,
        appSecret: bot.appSecret,
        domain: dc.sdkBaseUrl,
        loggerLevel: 2,
        autoReconnect: true,
        onReady: () => logger.info(`[channel] WS connected: ${bot.name} (${bot.appId})`),
        onError: (err) => logger.error(`[channel] WS error ${bot.name}: ${err.message}`),
        onReconnecting: () => logger.info(`[channel] WS reconnecting: ${bot.name}`),
        onReconnected: () => logger.info(`[channel] WS reconnected: ${bot.name}`),
      });

      const dispatcher = new EventDispatcher({});
      const appId = bot.appId;
      const domain = bot.domain;

      dispatcher.register({
        'im.message.receive_v1': async (data: any) => {
          try { await this.onOperatorMessage(appId, domain, data); } catch (err) { logger.error(`[channel] onOperatorMessage crashed: ${bot.name}`, err); }
        },
        'drive.file.bitable_record_changed_v1': async (data: any) => { await this.onBitableEvent(data); },
        'card.action.trigger': async (data: any) => {
          try { await this.coreOperator.handleCardActionFromRaw(data); } catch (err) { logger.error(`[channel] handleCardAction crashed: ${bot.name}`, err); }
        },
        'im.message.reaction.created_v1': async () => {},
        'im.message.reaction.deleted_v1': async () => {},
      });

      await wsClient.start({ eventDispatcher: dispatcher });

      // Fetch bot's own open_id via bot/v3/info (used for @-mention matching).
      // mention.id.open_id contains the bot's open_id; app_id is NOT returned.
      let botOpenId: string | undefined;
      try {
        const tr = await fetch(`${dc.sdkBaseUrl}/open-apis/auth/v3/app_access_token/internal`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: bot.appId, app_secret: bot.appSecret }),
        });
        const td = await tr.json() as any;
        const tk = td?.app_access_token as string;
        if (tk) {
          const br = await fetch(`${dc.sdkBaseUrl}/open-apis/bot/v3/info`, {
            headers: { Authorization: `Bearer ${tk}` },
          });
          const bd = await br.json() as any;
          logger.info(`[channel] bot/v3/info for "${bot.name}": ${JSON.stringify(bd).slice(0, 300)}`);
          if (bd?.code === 0) botOpenId = bd?.bot?.open_id as string | undefined;
        } else {
          console.warn(`[channel] app_token failed "${bot.name}": ${JSON.stringify(td).slice(0,150)}`);
        }
      } catch (err: any) {
        console.warn(`[channel] botOpenId error "${bot.name}": ${err.message}`);
      }

      this.operatorClients.set(appId, {
        wsClient,
        dispatcher,
        client,
        config: bot,
        appId,
        domain,
        botOpenId,
      });

      logger.info(`[channel] operator "${bot.name}" (${bot.appId}) ${domain ? `domain="${domain}" ` : ''}${botOpenId ? 'botOpenId cached' : ''} connected`);
    } catch (err: any) {
      console.warn(`[channel] WS init failed for "${bot.name}" (${bot.appId}): ${err.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Message handler — per-operator routing
  // -----------------------------------------------------------------------

  private async onOperatorMessage(appId: string, domain: string | undefined, raw: any): Promise<void> {
    const data = raw.event ?? raw;
    const msg = data.message;
    logger.info(`[channel] IM event type=${msg?.message_type} chat=${msg?.chat_type} operator=${appId}`);

    if (!msg) {
      logger.info(`[channel] no message in event, raw=${JSON.stringify(raw).slice(0, 500)}`);
      return;
    }

    // Only messages from real users
    if (data.sender?.sender_type !== 'user') return;

    if (msg.chat_type !== 'p2p' && msg.chat_type !== 'group') return;

    // Identify which bot was @-mentioned. Feishu mentions for bots carry
    // the bot's open_id in mention.id.open_id (NOT app_id). We fetch each
    // bot's open_id once via the SDK Client and cache it for matching.
    const botMentioned = Array.isArray(msg.mentions) && msg.mentions.some(
      (m: any) => m?.mentioned_type === 'bot' && (
        // Match by cached bot open_id (from bot/v3/info via SDK)
        m?.id?.open_id === this.operatorClients.get(appId)?.botOpenId
      ),
    );

    // For new conversations in group chat (no thread parent), skip entirely
    // when this bot was not @-mentioned. Thread replies (root_id present)
    // need to pass through so the last-operator bot can capture the turn.
    if (msg.chat_type === 'group' && !botMentioned && !msg.root_id) {
      logger.info(`[channel] skip: non-mentioned group msg (op=${appId}...)`);
      return;
    }

    // /reload — only respond to @mentioned /reload
    const contentRaw = String(msg.content ?? '');
    let textContent = '';
    try { textContent = JSON.parse(contentRaw).text ?? contentRaw; } catch { textContent = contentRaw; }
    if (botMentioned && textContent.trim().toLowerCase() === '/reload') {
      if (!this.cfg.configsTableId) {
        await this.reply(msg.message_id, '⚠️ No configs table configured.', true, appId);
      } else {
        try {
          const { enrichConfigFromBitable } = await import('../../../lib/config.js');
          await enrichConfigFromBitable(this.cfg);
          await this.reply(msg.message_id, '✅ Configs reloaded from Bitable.', true, appId);
        } catch (err: any) {
          await this.reply(msg.message_id, `⚠️ Reload failed: ${err.message}`, true, appId);
        }
      }
      return;
    }

    // Parse content — support text, post (rich text), and interactive (card) messages
    let content: string;
    let parts: Part[] = [];
    if (msg.message_type === 'post') {
      try {
        logger.info(`[channel] post raw=${msg.content}`);
        content = parseMessageContent('post', msg.content);
        const parsedParts = parsePostToParts(msg.content);
        parts = parsedParts.parts;
        if (!parts.length) logger.info(`[channel] parsePostToParts returned empty parts, raw=${msg.content.slice(0, 300)}`);
        if (!content) logger.info(`[channel] post content empty, raw=${msg.content.slice(0, 300)}`);
      } catch (err) {
        logger.info(`[channel] post parse failed raw=${String(msg.content).slice(0, 300)} err=${(err as Error).message}`);
        content = '';
      }
    } else if (msg.message_type === 'interactive') {
      try {
        content = parseMessageContent('interactive', msg.content);
      } catch (err) {
        logger.info(`[channel] interactive parse failed raw=${String(msg.content).slice(0, 300)} err=${(err as Error).message}`);
        content = '';
      }
    } else if (msg.message_type === 'text') {
      try { content = JSON.parse(msg.content).text ?? msg.content; } catch { content = msg.content; }
      content = content.replace(/@_user_\d+/g, '').trim();
      if (content) parts.push({ kind: 'text', text: content });
    } else {
      return; // unsupported message type
    }
    if (!content) return;

    const messageId = msg.message_id;
    if (!messageId) return;

    const senderId = data.sender.sender_id?.open_id ?? 'unknown';
    // union_id is cross-app resolvable — use it for Person field writes
    // since the BitableClient uses channel app credentials and can't
    // resolve other operator apps' open_ids.
    const senderUnionId = data.sender.sender_id?.union_id;
    const chatId = msg.chat_id;
    const rootId = msg.root_id;

    // If this message is a reply to another message, fetch the parent's text
    if (msg.parent_id && msg.parent_id !== rootId) {
      try {
        const parentText = await this.fetchMessageText(msg.parent_id, appId);
        if (parentText) {
          content = `> ${parentText.replace(/\n/g, '\n> ')}\n\n${content}`;
        }
      } catch (err) {
        logger.info(`[channel] fetch parent message failed id=${msg.parent_id} err=${(err as Error).message}`);
      }
    }

    logger.info(`[channel] DM from ${senderId}: ${content} (op=${appId})`);

    // Acknowledge receipt — only when bot is @mentioned
    if (botMentioned) {
      const mode = this.cfg.operator?.reactionMode ?? 'emoji';
      const ackMsg = this.cfg.messages?.ackReceived || '✅ Received';
      if (mode !== 'card') {
        try { await this.react(messageId, DEFAULT_EMOJI, appId); } catch {
          if (mode === 'both') await this.reply(messageId, ackMsg, false, appId);
        }
      }
      if (mode === 'card') {
        try { await this.reply(messageId, ackMsg, false, appId); } catch { /* best effort */ }
      }
    }

    // Dedup key includes appId for multi-operator isolation
    const dedupKey = `${appId}:${messageId}`;
    try {
      const existing = await this.bitable.searchRecords(this.cfg.turnsTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.cfg.fields.turn.dedupKey, operator: 'is', value: [dedupKey] },
        ],
      });
      if (existing.length > 0) {
        logger.info(`[channel] dedup: ${dedupKey.slice(0, 30)} already processed, skipping`);
        return;
      }
    } catch { /* best effort */ }

    // --- /cancel command ────────────────────────────────────────────

    if (this.cfg.roundsTableId && content.trim() === '/cancel') {
      await this.coreOperator.handleCancel(senderId, messageId, appId);
      return;
    }

    // --- Delegate to CoreOperator for message processing ─────────────

    const parsedEvent = {
      content,
      parts,
      message: {
        message_id: messageId,
        message_type: msg.message_type,
        content: String(msg.content ?? ''),
        chat_type: msg.chat_type,
        chat_id: chatId,
        root_id: rootId,
        parent_id: msg.parent_id,
        mentions: Array.isArray(msg.mentions) ? msg.mentions : [],
      },
      sender: {
        sender_type: 'user',
        sender_id: { open_id: senderId, union_id: senderUnionId },
      },
      appId,
      botMentioned,
      domain,
    };

    const roundId = await this.coreOperator.handleMessage(parsedEvent as any);
    if (roundId && this.coordinator) {
      await this.coordinator.processRound(roundId);
    }
  }

  // -----------------------------------------------------------------------
  // Draft processing — delegated to CoreOperator (core/operator.ts)
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Turn delivery + approval cards + draft cleanup — delegated to CoreOperator
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Human participant management — delegated to CoreOperator (core/operator.ts)
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // IM helpers — operator-aware
  // -----------------------------------------------------------------------

  private async react(messageId: string, emojiType: string, appId?: string): Promise<void> {
    await this.getClient(appId).im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
  }

  /** Reply to a message, optionally in thread mode and with a specific operator appId. */
  private async reply(messageId: string, text: string, replyInThread?: boolean, appId?: string): Promise<void> {
    if (!text.trim()) return;

    const card = {
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: text },
        ],
      },
    };

    const imClient = this.getClient(appId);

    try {
      await imClient.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
          reply_in_thread: replyInThread,
        } as any,
      });
    } catch (err: any) {
      const apiCode = err?.response?.data?.code ?? err?.code;
      const isTableLimit = apiCode === 230099 || String(err?.message ?? err).includes('card table number over limit');
      if (isTableLimit) {
        await imClient.im.v1.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: 'text',
            content: JSON.stringify({ text }),
            reply_in_thread: replyInThread,
          } as any,
        });
      } else {
        throw err;
      }
    }
  }

  /** Fetch a message by ID using the appropriate bot client. */
  private async fetchMessageText(messageId: string, appId?: string): Promise<string> {
    const resp: any = await this.getClient(appId).im.v1.message.get({
      path: { message_id: messageId },
    });
    const msg = resp?.data?.items?.[0];
    if (!msg?.msg_type || !msg?.body?.content) return '';
    return parseMessageContent(msg.msg_type, msg.body.content);
  }

  private cleanup(): void {
    if (this.draftCleanupTimer) clearInterval(this.draftCleanupTimer);
    for (const [, oc] of this.operatorClients) {
      try { oc.wsClient.close({ force: true }); } catch { /* ignore */ }
    }
    this.operatorClients.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
