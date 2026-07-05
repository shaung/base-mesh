import { logger } from '../lib/log.js';
import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { Config, BitableRecord, Part, BotConfig } from '../lib/types.js';
import { parsePostToParts } from '../lib/messaging/message-parser.js';
import { BitableClient } from '../lib/bitable/client.js';
import { Session } from '../lib/bitable/protocol.js';
import { extractText, extractUserIds } from '../lib/messaging/text.js';
import { getDomainConfig } from '../lib/bitable/domain.js';
import { formatMessage } from '../lib/messaging/messages.js';
import { Coordinator } from '../channel/coordinator.js';

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
  private running = true;
  private draftCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private deliveredTurnIds = new Set<string>();
  private deliveryInFlight = new Set<string>();
  private lite: boolean;
  private cachedDomains: import('../lib/messaging/intent.js').Domain[] | null = null;

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
  }

  async run(): Promise<void> {
    const { enableFileLogging } = await import('../lib/log.js');
    enableFileLogging();

    process.on('SIGTERM', () => { this.stop(); process.exit(0); });
    process.on('SIGINT', () => { this.stop(); process.exit(0); });

    const label = this.lite ? 'channel-lite' : 'channel';
    logger.info(`[${label}] started`);

    // Load runtime config from Configs Bitable table if configured
    const { enrichConfigFromBitable } = await import('../lib/config.js');
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
    this.draftCleanupTimer = setInterval(() => this.cleanupStaleDrafts(ttlMs), ttlMs);

    while (this.running) {
      await sleep((this.cfg.operator?.pollIntervalSeconds ?? 3) * 1000);
      try {
        await this.deliverTurns();
      } catch { /* ignore */ }
      try {
        await this.deliverApprovalCards();
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
    } else if (tableId === this.cfg.turnsTableId) {
      try {
        const turn = await this.bitable.getRecord(this.cfg.turnsTableId, recordId);
        if (!turn) return;
        const status = String(turn.fields[this.cfg.fields.turn.status] ?? '');
        const notified = Number(turn.fields[this.cfg.fields.turn.notified] ?? 0);
        const notifyStatuses = ['processing', 'answered', 'error', 'approved'];
        if (notifyStatuses.includes(status) && notified === 0) {
          await this.deliverTurn(turn);
        }
      } catch { /* */ }
    }
    } catch (err) {
      logger.error('[channel] onBitableEvent crashed:', err);
    }
  }

  /** Deliver a single turn to IM (extracted from deliverTurns batch logic). */
  private async deliverTurn(turn: BitableRecord): Promise<void> {
    const turnRecordId = turn.record_id;
    if (!turnRecordId || this.deliveredTurnIds.has(turnRecordId)) return;
    if (this.deliveryInFlight.has(turnRecordId)) return;
    this.deliveryInFlight.add(turnRecordId);
    const claimed = await this.session.claimTurnDelivery(turnRecordId);
    if (!claimed) { this.deliveryInFlight.delete(turnRecordId); return; }
    const content = extractText(turn.fields[this.cfg.fields.turn.content]);
    const rootMsgId = extractText(turn.fields[this.cfg.fields.turn.rootMsgId]);
    if (!content || !rootMsgId) { this.deliveryInFlight.delete(turnRecordId); return; }
    const human = extractUserIds(turn.fields[this.cfg.fields.turn.human]);
    const turnAppId = this.getAppIdFromTurn(turn);
    let finalContent = content;
    if (human) {
      const parts = human.split(',').filter(Boolean);
      const mentions = parts.map(p => p.startsWith('ou_') ? `<at id=${p}></at>` : p).join(' ');
      finalContent = formatMessage(this.cfg.messages?.ccFormat || '{content}\n\ncc {mentions}', { content, mentions });
    }
    try {
      await this.reply(rootMsgId, finalContent, true, turnAppId);
      this.deliveredTurnIds.add(turnRecordId);
      await this.session.markTurnNotified(turnRecordId);
    } catch { /* */ } finally {
      this.deliveryInFlight.delete(turnRecordId);
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
          try { await this.onCardAction(data); } catch (err) { logger.error(`[channel] onCardAction crashed: ${bot.name}`, err); }
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
          const { enrichConfigFromBitable } = await import('../lib/config.js');
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
        const parsed = JSON.parse(msg.content);
        logger.info(`[channel] post raw=${msg.content}`);
        content = extractPostText(parsed);
        const parsedParts = parsePostToParts(msg.content);
        parts = parsedParts.parts;
        if (!parts.length) logger.info(`[channel] parsePostToParts returned empty parts, raw=${msg.content.slice(0, 300)}`);
        if (!content) logger.info(`[channel] post content empty, raw=${JSON.stringify(parsed).slice(0, 300)}`);
      } catch (err) {
        logger.info(`[channel] post parse failed raw=${String(msg.content).slice(0, 300)} err=${(err as Error).message}`);
        content = '';
      }
    } else if (msg.message_type === 'interactive') {
      try {
        content = extractCardText(JSON.parse(msg.content));
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
      await this.handleCancel(senderId, messageId, appId);
      return;
    }

    // --- Thread reply ────────────────────────────────────────────────

    if (rootId) {
      logger.info(`[channel] thread reply lookup rootId=${rootId} botMentioned=${botMentioned}`);
      let ticket = await this.session.findByThreadRoot(rootId);
      if (!ticket || !ticket.record_id) {
        logger.info(`[channel] thread root not found, fallback by chat_id=${chatId}`);
        const recent = await this.bitable.searchRecords(this.cfg.ticketsTableId, {
          conjunction: 'and',
          conditions: [
            { field_name: this.cfg.fields.ticket.chatId, operator: 'is', value: [chatId] },
          ],
        });
        recent.sort((a, b) => Number(b.fields[this.cfg.fields.ticket.updatedAt] ?? 0) - Number(a.fields[this.cfg.fields.ticket.updatedAt] ?? 0));
        ticket = recent[0] ?? null;
        if (ticket) logger.info(`[channel] fallback found ticket ${ticket.record_id}`);
        else logger.info('[channel] no ticket found for this chat');
      }
      if (ticket?.record_id) {
        logger.info(`[channel] thread reply → ticket ${ticket.record_id} mentioned=${botMentioned}`);
        await this.handleThreadReply(ticket, content, messageId, senderId, parts, botMentioned, appId);
        return;
      }
    }

    // --- New conversation ────────────────────────────────────────────

    await this.ensureHumanRoster(senderId, senderUnionId);

    try {
      const ticket = await this.session.createTicket(content, {
        rootMsgId: rootId || messageId,
        chatId,
        senderId,
      });

      let resolvedParts = parts;
      let attachmentTokens: string[] = [];
      if (msg.message_type === 'post' && parts.some(p => p.kind === 'file')) {
        const { resolveImageParts } = await import('../channel/a2a.js');
        const result = await resolveImageParts(parts, this.cfg, messageId);
        resolvedParts = result.parts;
        attachmentTokens = result.attachmentTokens;
      }

      const turnFields: Record<string, unknown> = {
        [this.cfg.fields.turn.ticketRecordId]: ticket.record_id,
        [this.cfg.fields.turn.rootMsgId]: messageId,
        [this.cfg.fields.turn.role]: 'user',
        [this.cfg.fields.turn.content]: content,
        [this.cfg.fields.turn.dedupKey]: dedupKey,
        [this.cfg.fields.turn.agentIdentity]: senderId,
        [this.cfg.fields.turn.appId]: appId,
        [this.cfg.fields.turn.createdAt]: Date.now(),
      };
      if (resolvedParts.length > 0) turnFields[this.cfg.fields.turn.parts] = JSON.stringify(resolvedParts);
      if (attachmentTokens.length > 0) turnFields[this.cfg.fields.turn.attachments] = attachmentTokens.map(t => ({ file_token: t }));
      const turnRecord = await this.bitable.createRecord(this.cfg.turnsTableId, turnFields);

      await this.processDraft(ticket, content, messageId, chatId, appId, domain);

      if (this.cfg.roundsTableId && ticket.record_id) {
        const currentRound = await this.session.getCurrentRound(ticket.record_id);
        if (currentRound?.record_id) {
          await this.session.assignTurnsToRound(ticket.record_id, currentRound.record_id, appId);
        }
      }
    } catch (err) {
      logger.error('[channel] failed to create ticket:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Draft processing
  // -----------------------------------------------------------------------

  private async handleThreadReply(
    ticket: BitableRecord,
    content: string,
    messageId: string,
    senderId: string,
    parts: Part[] = [],
    mentioned = false,
    appId?: string,
  ): Promise<void> {
    const recordId = ticket.record_id!;
    const status = String(ticket.fields[this.cfg.fields.ticket.status] ?? '');
    const chatId = String(ticket.fields[this.cfg.fields.ticket.chatId] ?? '');

    // When the user replies without @-mentioning a bot, only the last
    // operator bot for this ticket should write the user turn. This
    // prevents duplicate turns in multi-operator group chat scenarios.
    if (!mentioned && appId) {
      const lastAppId = await this.session.getLastOperatorAppId(recordId);
      if (lastAppId && lastAppId !== appId) {
        // Skip if the actual last operator is still connected — they'll
        // handle the turn. If they're offline, fall through so any
        // available operator captures the turn as a best-effort fallback.
        if (this.operatorClients.has(lastAppId)) {
          logger.info(`[channel] thread reply: ticket=${recordId.slice(0,12)} lastOp=${lastAppId} online, deferring`);
          return;
        }
        logger.info(`[channel] thread reply: ticket=${recordId.slice(0,12)} lastOp=${lastAppId} offline, fallback`);
      }
    }

    const dedupKey = appId ? `${appId}:${messageId}` : messageId;

    let resolvedReplyParts = parts;
    let replyAttachTokens: string[] = [];
    if (parts.some(p => p.kind === 'file')) {
      const { resolveImageParts } = await import('../channel/a2a.js');
      const result = await resolveImageParts(parts, this.cfg, messageId);
      resolvedReplyParts = result.parts;
      replyAttachTokens = result.attachmentTokens;
    }

    const rootMsgId = extractText(ticket.fields[this.cfg.fields.ticket.rootMsgId]);
    const replyFields: Record<string, unknown> = {
      [this.cfg.fields.turn.ticketRecordId]: recordId,
      [this.cfg.fields.turn.rootMsgId]: rootMsgId,
      [this.cfg.fields.turn.role]: 'user',
      [this.cfg.fields.turn.content]: content,
      [this.cfg.fields.turn.dedupKey]: dedupKey,
      [this.cfg.fields.turn.agentIdentity]: senderId,
      [this.cfg.fields.turn.appId]: appId ?? this.cfg.appId,
      [this.cfg.fields.turn.createdAt]: Date.now(),
    };
    if (resolvedReplyParts.length > 0) replyFields[this.cfg.fields.turn.parts] = JSON.stringify(resolvedReplyParts);
    if (replyAttachTokens.length > 0) replyFields[this.cfg.fields.turn.attachments] = replyAttachTokens.map(t => ({ file_token: t }));
    const turnRecord = await this.bitable.createRecord(this.cfg.turnsTableId, replyFields);

    if (mentioned && status === this.cfg.statuses.draft) {
      await this.processDraft(ticket, content, messageId, chatId, appId);
      if (this.cfg.roundsTableId && recordId) {
        const round = await this.session.getCurrentRound(recordId);
        if (round?.record_id) {
          await this.session.assignTurnsToRound(recordId, round.record_id, appId);
        }
      }
      return;
    }

    logger.info(`[channel] thread reply: ticket=${recordId.slice(0,12)} status=${status} mentioned=${mentioned}`);
    if (!mentioned) return;

    if (status === this.cfg.statuses.active) {
      if (this.cfg.roundsTableId) {
        const currentRound = await this.session.getCurrentRound(recordId);
        if (currentRound?.record_id) {
          const roundStatus = String(currentRound.fields[this.cfg.fields.round.status] ?? '');
          const terminal = [this.cfg.roundStatuses.done, this.cfg.roundStatuses.failed, this.cfg.roundStatuses.cancelled];
          const nonPendingActive = [this.cfg.roundStatuses.pendingApproval, this.cfg.roundStatuses.approved, this.cfg.roundStatuses.executing];
          if (roundStatus === this.cfg.roundStatuses.pending) {
            logger.info(`[channel] pending round ${currentRound.record_id}, cancelling and creating new round`);
            await this.session.transitionRound(currentRound.record_id, this.cfg.roundStatuses.cancelled);
            const domains = await this.runIntent(ticket, content, recordId, appId);
            const round = await this.session.createRound(recordId, domains, appId, content);
            logger.info(`[channel] created round ${round.record_id!} with domains=${domains}`);
            await this.session.assignTurnsToRound(recordId, round.record_id!, appId);
          } else if (nonPendingActive.includes(roundStatus)) {
            logger.info(`[channel] revert round ${currentRound.record_id} (${roundStatus}) for new reply`);
            await this.session.transitionRound(currentRound.record_id, this.cfg.roundStatuses.pending);
            await this.session.releaseRound(currentRound.record_id);
            if (roundStatus === this.cfg.roundStatuses.executing && this.coordinator) {
              await this.coordinator.dispatchCancelToExecutor(currentRound.record_id);
            }
            // Assign the new user turn to the reverted round so the coordinator
            // picks it up when it dispatches this round to an executor.
            await this.session.assignTurnsToRound(recordId, currentRound.record_id, appId);
          } else if (terminal.includes(roundStatus)) {
            logger.info(`[channel] prev round ${currentRound.record_id} done, creating new round`);
            const domains = await this.runIntent(ticket, content, recordId, appId);
            const round = await this.session.createRound(recordId, domains, appId, content);
            logger.info(`[channel] created round ${round.record_id!} with domains=${domains}`);
            await this.session.assignTurnsToRound(recordId, round.record_id!, appId);
          }
        } else {
          const domains = await this.runIntent(ticket, content, recordId, appId);
          const round = await this.session.createRound(recordId, domains, appId, content);
          logger.info(`[channel] created round ${round.record_id!} with domains=${domains}`);
          await this.session.assignTurnsToRound(recordId, round.record_id!, appId);
        }
      }
      return;
    }

    if (status === this.cfg.statuses.closed) {
      await this.session.promoteToPending(recordId, content);
      if (this.cfg.roundsTableId) {
        const domains = await this.runIntent(ticket, content, recordId, appId);
        try {
          const round = await this.session.createRound(recordId, domains, appId, content);
          logger.info(`[channel] created round ${round.record_id!} for reopened ticket ${recordId}`);
          if (round.record_id) {
            await this.session.assignTurnsToRound(recordId, round.record_id, appId);
          }
        } catch (err) {
          logger.error('[channel] createRound failed:', err);
        }
      }
      return;
    }

    if (status === this.cfg.statuses.closed) {
      await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
        [this.cfg.fields.ticket.status]: this.cfg.statuses.active,
        [this.cfg.fields.ticket.retryCount]: 0,
        [this.cfg.fields.ticket.owner]: '',
        [this.cfg.fields.ticket.ownerLeaseAt]: 0,
      });
      if (this.cfg.roundsTableId) {
        const domains = await this.runIntent(ticket, content, recordId, appId);
        try {
          const round = await this.session.createRound(recordId, domains, appId, content);
          logger.info(`[channel] created round ${round.record_id!} for reactivated ticket ${recordId}`);
          if (round.record_id) {
            await this.session.assignTurnsToRound(recordId, round.record_id, appId);
          }
        } catch (err) {
          logger.error('[channel] createRound failed:', err);
        }
      }
      return;
    }
  }

  /** Run intent recognition or use domain override if operator has a bound domain. */
  private async runIntent(ticket: BitableRecord, content: string, recordId: string, appId?: string): Promise<string[] | undefined> {
    // If operator has a bound domain, skip intent and use it directly
    if (appId) {
      const oc = this.operatorClients.get(appId);
      if (oc?.domain) {
        logger.info(`[channel] domain override for operator ${appId}: "${oc.domain}"`);
        return [oc.domain];
      }
    }

    // Check for explicit #domain tag first
    const { parseDomainTag } = await import('../lib/messaging/intent.js');
    const loadedDomains = await this.loadDomains();
    const tagResult = parseDomainTag(content, loadedDomains);
    if (tagResult) {
      logger.info(`[channel] domain tag override: ${tagResult.tag}`);
      return [tagResult.tag];
    }
    if (!this.cfg.intent) return ['general'];
    const { processMessage } = await import('../lib/messaging/intent.js');
    const turns = await this.session.getTurns(recordId);
    const conversation = turns.map(t => `[${t.fields[this.cfg.fields.turn.role]}]\n${t.fields[this.cfg.fields.turn.content]}`).join('\n');
    const result = await processMessage(content, loadedDomains, conversation, this.cfg.intent);
    logger.info(`[channel] intent: domains=${result.domains} isComplete=${result.isComplete}`);
    return result.domains.length > 0 ? result.domains : ['general'];
  }

  /** Handle /cancel command — cancel the current Round for the user's ticket. */
  private async handleCancel(senderId: string, messageId: string, appId?: string): Promise<void> {
    try {
      const tickets = await this.session.searchTicketsBySender(senderId);
      const activeTickets = tickets.filter(t => {
        const status = String(t.fields[this.cfg.fields.ticket.status] ?? '');
        return status !== this.cfg.statuses.closed;
      });
      if (activeTickets.length === 0) {
        await this.reply(messageId, 'No active ticket found to cancel.', true, appId);
        return;
      }
      const ticket = activeTickets[activeTickets.length - 1];
      const round = await this.session.getCurrentRound(ticket.record_id!);
      if (round && round.record_id) {
        const ok = await this.session.transitionRound(round.record_id, this.cfg.roundStatuses.cancelled);
        if (ok) {
          await this.reply(messageId, '✅ Processing cancelled.', true, appId);
          logger.info(`[channel] cancelled round ${round.record_id} for ticket ${ticket.record_id!}`);
          if (this.coordinator) {
            await this.coordinator.dispatchCancelToExecutor(round.record_id);
          }
        } else {
          await this.reply(messageId, 'Could not cancel — round may have already completed.', true, appId);
        }
      } else {
        await this.reply(messageId, 'No active processing round to cancel.', true, appId);
      }
    } catch (err) {
      logger.error('[channel] handleCancel error:', err);
      await this.reply(messageId, 'Error processing cancel command.', true, appId);
    }
  }

  private async processDraft(
    ticket: BitableRecord,
    content: string,
    messageId: string,
    _chatId: string,
    appId?: string,
    domain?: string,
  ): Promise<void> {
    let domains: string[] = ['general'];
    let summary = content;
    const loadedDomains = await this.loadDomains();

    // If operator has a bound domain, skip intent entirely
    if (domain) {
      domains = [domain];
      logger.info(`[channel] processDraft domain override: "${domain}"`);
    } else if (this.cfg.intent) {
      const { processMessage } = await import('../lib/messaging/intent.js');
      const turns = await this.session.getTurns(ticket.record_id!);
      const conversation = turns.map(t => `[${t.fields[this.cfg.fields.turn.role]}]\n${t.fields[this.cfg.fields.turn.content]}`).join('\n');
      const result = await processMessage(content, loadedDomains, conversation, this.cfg.intent);
      domains = result.domains;
      summary = result.summary || content;
      logger.info(`[channel] intent: domains=${result.domains} isComplete=${result.isComplete} summary=${result.summary.slice(0,40)}`);

      if (!result.isComplete) {
        const question = result.missingFields.length > 0
          ? `Please provide: ${result.missingFields.join(', ')}`
          : (this.cfg.messages?.clarifyQuestion || 'Could you please provide more details?');
        await this.reply(messageId, question, true, appId);
        logger.info(`[channel] clarification asked for ticket ${ticket.record_id!}: missing=${result.missingFields}`);
        return;
      }
    }

    const { parseDomainTag } = await import('../lib/messaging/intent.js');
    const tagResult = parseDomainTag(summary || content, loadedDomains);
    if (tagResult) {
      domains = [tagResult.tag];
      summary = tagResult.cleaned;
      logger.info(`[channel] domain tag override: ${tagResult.tag}`);
    }

    await this.session.promoteToPending(ticket.record_id!, summary);
    logger.info(`[channel] ticket ${ticket.record_id!} promoted to pending`);

    if (this.cfg.roundsTableId && ticket.record_id) {
      try {
        const round = await this.session.createRound(ticket.record_id, domains.length > 0 ? domains : undefined, appId, content);
        logger.info(`[channel] created round ${round.record_id!} for ticket ${ticket.record_id} with domains=${domains}`);
      } catch (err) {
        logger.error('[channel] createRound failed:', err);
      }
    }

    if (this.coordinator && ticket.record_id) {
      const updated = await this.session.getTicket(ticket.record_id);
      if (updated) await this.coordinator.tryRoute(updated);
    }
  }

  // -----------------------------------------------------------------------
  // Turn delivery — send ACKs, answers, and errors via IM
  // -----------------------------------------------------------------------

  private async deliverTurns(): Promise<void> {
    try {
      const turns = await this.session.searchNotifiableTurns();
      if (turns.length === 0) return;

      logger.info(`[channel] deliverTurns: ${turns.length} turns to deliver`);
      for (const turn of turns) {
        if (!this.running) break;
        const turnRecordId = turn.record_id;
        if (!turnRecordId) continue;
        if (this.deliveredTurnIds.has(turnRecordId)) continue;

        const claimed = await this.session.claimTurnDelivery(turnRecordId);
        if (!claimed) {
          continue;
        }

        const content = extractText(turn.fields[this.cfg.fields.turn.content]);
        const rootMsgId = extractText(turn.fields[this.cfg.fields.turn.rootMsgId]);
        const status = String(turn.fields[this.cfg.fields.turn.status] ?? '');
        const turnAppId = this.getAppIdFromTurn(turn);

        if (!content || !rootMsgId) {
          logger.info(`[channel] skip turn ${turnRecordId} (missing content/rootMsgId)`);
          continue;
        }

        const human = extractUserIds(turn.fields[this.cfg.fields.turn.human]);
        let finalContent = content;
        if (human) {
          const parts = human.split(',').map(s => s.trim()).filter(Boolean);
          const mentions = parts.map(p =>
            p.startsWith('ou_') ? `<at id=${p}></at>` : p,
          ).join(' ');
          finalContent = formatMessage(this.cfg.messages?.ccFormat || '{content}\n\ncc {mentions}', { content, mentions });
        }

        try {
          await this.reply(rootMsgId, finalContent, true, turnAppId);
          this.deliveredTurnIds.add(turnRecordId);
          await this.session.markTurnNotified(turnRecordId);
          logger.info(`[channel] delivered ${status} turn ${turnRecordId} via appId=${turnAppId || 'primary'}`);
        } catch (err) {
          logger.error(`[channel] deliver turn failed ${turnRecordId}:`, err);
        }
      }
    } catch (err) {
      logger.error('[channel] deliverTurns error:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Approval card delivery (Round-driven mode)
  // -----------------------------------------------------------------------

  /** Poll pending_approval Rounds and send approval cards via IM. */
  private async deliverApprovalCards(): Promise<void> {
    if (!this.cfg.roundsTableId) return;
    try {
      const rounds = await this.session.searchRoundsByStatus(this.cfg.roundStatuses.pendingApproval);
      for (const round of rounds) {
        if (!round.record_id) continue;
        const ticketId = String(round.fields[this.cfg.fields.round.ticketRecordId] ?? '');
        if (!ticketId) continue;
        const ticket = await this.session.getTicket(ticketId);
        if (!ticket) continue;

        const rootMsgId = extractText(ticket.fields[this.cfg.fields.ticket.rootMsgId]);
        const summary = extractText(ticket.fields[this.cfg.fields.ticket.summary]);
        if (!rootMsgId) continue;

        const cardDedupKey = `approval_card_${round.record_id}`;
        const existing = await this.bitable.searchRecords(this.cfg.turnsTableId, {
          conjunction: 'and',
          conditions: [
            { field_name: this.cfg.fields.turn.dedupKey, operator: 'is', value: [cardDedupKey] },
          ],
        });
        if (existing.length > 0) continue;

        // Determine which operator's client to use from round's appId
        const roundAppId = extractText(round.fields[this.cfg.fields.round.appId]) || undefined;
        const imClient = this.getClient(roundAppId);

        const reviewer = round.fields[this.cfg.fields.round.reviewer];
        const reviewerMention = reviewer ? extractUserIds(reviewer).split(',').map(id => `<at id=${id.trim()}></at>`).join(' ') : '';
        const card: Record<string, any> = {
          schema: '2.0',
          body: {
            elements: [
              { tag: 'markdown', content: `⏳ **Approval Required**\n${summary}\n\n${reviewerMention ? `Reviewer: ${reviewerMention}` : ''}` },
              { tag: 'hr' },
              {
                tag: 'action',
                actions: [
                  { tag: 'button', text: { tag: 'plain_text', content: '✅ Approve' }, value: { round_id: round.record_id, action: 'approve' }, type: 'primary' },
                  { tag: 'button', text: { tag: 'plain_text', content: '❌ Reject' }, value: { round_id: round.record_id, action: 'reject' }, type: 'danger' },
                ],
              },
            ],
          },
        };

        try {
          await imClient.im.v1.message.reply({
            path: { message_id: rootMsgId },
            data: { msg_type: 'interactive', content: JSON.stringify(card), reply_in_thread: true } as any,
          });
          await this.bitable.createRecord(this.cfg.turnsTableId, {
            [this.cfg.fields.turn.ticketRecordId]: ticketId,
            [this.cfg.fields.turn.rootMsgId]: rootMsgId,
            [this.cfg.fields.turn.role]: 'system',
            [this.cfg.fields.turn.content]: `Approval card sent for round ${round.record_id}`,
            [this.cfg.fields.turn.dedupKey]: cardDedupKey,
            [this.cfg.fields.turn.createdAt]: Date.now(),
          });
          logger.info(`[channel] approval card sent for round ${round.record_id}`);
        } catch (err) {
          logger.error(`[channel] approval card failed for round ${round.record_id!}:`, err);
        }
      }
    } catch (err) {
      logger.error('[channel] deliverApprovalCards error:', err);
    }
  }

  /** Handle card action callback (approve/reject). */
  private async onCardAction(raw: any): Promise<void> {
    const action = raw.event?.action;
    if (!action?.value?.round_id) return;
    const roundId = action.value.round_id;
    const decision = action.value.action;
    if (!roundId || !decision) return;

    logger.info(`[channel] card action: ${decision} round=${roundId}`);
    try {
      if (decision === 'approve') {
        await this.session.transitionRound(roundId, this.cfg.roundStatuses.approved);
      } else if (decision === 'reject') {
        await this.session.transitionRound(roundId, this.cfg.roundStatuses.rejected);
      }
    } catch (err) {
      logger.error(`[channel] card action failed round=${roundId}:`, err);
    }
  }

  // -----------------------------------------------------------------------
  // Draft TTL cleanup
  // -----------------------------------------------------------------------

  private async cleanupStaleDrafts(maxAgeMs: number): Promise<void> {
    try {
      const drafts = await this.bitable.searchRecords(this.cfg.ticketsTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.cfg.fields.ticket.status, operator: 'is', value: [this.cfg.statuses.draft] },
        ],
      });

      const cutoff = Date.now() - maxAgeMs;
      const tf = this.cfg.fields.ticket;
      let closed = 0;

      for (const d of drafts) {
        const createdAt = Number(d.fields[tf.createdAt] ?? 0) || Date.now();
        if (createdAt < cutoff) {
          await this.bitable.updateRecord(this.cfg.ticketsTableId, d.record_id!, {
            [tf.status]: this.cfg.statuses.closed,
          });
          closed++;
        }
      }

      if (closed > 0) logger.info(`[channel] closed ${closed} stale draft(s)`);

      if (this.deliveredTurnIds.size > 10_000) {
        this.deliveredTurnIds.clear();
        logger.info('[channel] cleared deliveredTurnIds set');
      }
    } catch (err) {
      logger.error('[channel] cleanupStaleDrafts error:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Capabilities classification
  // -----------------------------------------------------------------------

  /** Load enabled capabilities from Domains table (cached). */
  private async loadDomains(): Promise<import('../lib/messaging/intent.js').Domain[]> {
    if (this.cachedDomains) return this.cachedDomains;
    if (!this.cfg.domainsTableId) return [];
    try {
      const records = await this.bitable.searchRecords(this.cfg.domainsTableId, {
        conjunction: 'and',
        conditions: [{ field_name: 'enabled', operator: 'is', value: [true] }],
      });
      this.cachedDomains = records
        .map(r => ({
          domain: extractText(r.fields['domain'] ?? r.fields['capability']),
          description: extractText(r.fields['description']),
        }))
        .filter(d => d.domain.length > 0) as unknown as import('../lib/messaging/intent.js').Domain[];
      setTimeout(() => { this.cachedDomains = null; }, 60_000);
      return this.cachedDomains;
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Human participant management
  // -----------------------------------------------------------------------

  /** Ensure a human Roster record exists for the given sender (by open_id).
   *  Uses cross-app union_id as the primary identifier for Person field writes
   *  — the channel app's BitableClient can't resolve other operator apps' open_ids,
   *  but union_id works across all apps in the same developer account. */
  private async ensureHumanRoster(senderId: string, unionId?: string): Promise<void> {
    const primaryId = unionId || senderId;
    const userIdType = unionId ? 'union_id' : undefined;

    try {
      const existing = await this.bitable.searchRecords(this.cfg.rosterTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.cfg.fields.roster.kind, operator: 'is', value: ['human'] },
        ],
      });
      // Search by union_id (primary) or open_id (legacy)
      const found = existing.find((r) => {
        const ids = extractUserIds(r.fields[this.cfg.fields.roster.human]);
        return ids.includes(primaryId) || ids.includes(senderId);
      });
      if (found) return;
    } catch { /* best effort */ }

    const identity = `human_${primaryId}`;
    const fields: Record<string, unknown> = {
      [this.cfg.fields.roster.identity]: identity,
      [this.cfg.fields.roster.nickname]: `user_${primaryId.slice(0, 8)}`,
      [this.cfg.fields.roster.kind]: 'human',
      [this.cfg.fields.roster.enabled]: true,
    };

    try {
      fields[this.cfg.fields.roster.human] = [{ id: primaryId }];
      await this.bitable.createRecord(this.cfg.rosterTableId, fields, userIdType);
      logger.info(`[channel] created human roster: ${identity}`);
    } catch (err: any) {
      if (String(err?.code ?? err) === '1254066' || String(err?.message ?? '').includes('UserFieldConvFail')) {
        delete fields[this.cfg.fields.roster.human];
        try {
          await this.bitable.createRecord(this.cfg.rosterTableId, fields);
          logger.info(`[channel] created human roster ${identity} (without Person field)`);
        } catch (retryErr) {
          logger.info('[channel] ensureHumanRoster failed:', retryErr);
        }
      } else {
        logger.info('[channel] ensureHumanRoster failed:', err);
      }
    }
  }

  /** Notify human roster participants when tickets are pending. */
  private async notifyHumans(): Promise<void> {
    try {
      const tickets = await this.bitable.searchRecords(this.cfg.ticketsTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.cfg.fields.ticket.status, operator: 'is', value: [this.cfg.statuses.active] },
        ],
      });

      for (const ticket of tickets) {
        if (!ticket.record_id) continue;

        const rootMsgId = extractText(ticket.fields[this.cfg.fields.ticket.rootMsgId]);
        const senderId = extractText(ticket.fields[this.cfg.fields.ticket.senderId]);
        const summary = extractText(ticket.fields[this.cfg.fields.ticket.summary]);

        const roster = await this.bitable.searchRecords(this.cfg.rosterTableId, {
          conjunction: 'and',
          conditions: [
            { field_name: this.cfg.fields.roster.kind, operator: 'is', value: ['human'] },
            { field_name: this.cfg.fields.roster.enabled, operator: 'is', value: [true] },
          ],
        });

        if (roster.length === 0) continue;

        let atMentions = '';
        if (senderId) {
          atMentions = `<at id=${senderId}></at>`;
        } else {
          const ids: string[] = [];
          for (const h of roster) {
            const openIds = extractUserIds(h.fields[this.cfg.fields.roster.human]);
            for (const id of openIds.split(',')) {
              const trimmed = id.trim();
              if (trimmed) ids.push(`<at id=${trimmed}></at>`);
            }
          }
          atMentions = ids.join(' ');
        }

        const text = formatMessage(this.cfg.messages?.humanNotification || '📋 New task pending {mentions}\n{summary}', {
          mentions: atMentions || '',
          summary,
        });
        if (rootMsgId) {
          await this.reply(rootMsgId, text, true);
        }
        logger.info(`[channel] notified humans for ticket ${ticket.record_id}`);
      }
    } catch (err) {
      logger.error('[channel] notifyHumans error:', err);
    }
  }

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

  /** Get the appId from a turn record, with fallback to parsing from dedupKey.
   *  The appId field may be empty if the Turns table doesn't have an app_id
   *  column (pre-multi-operator setup). In that case, parse from the dedupKey
   *  which has the format "appId:messageId". */
  private getAppIdFromTurn(turn: BitableRecord): string | undefined {
    const fieldVal = extractText(turn.fields[this.cfg.fields.turn.appId]);
    if (fieldVal) return fieldVal;
    // Fallback: parse appId prefix from dedupKey (format: "appId:messageId")
    const dedupKey = extractText(turn.fields[this.cfg.fields.turn.dedupKey]);
    if (dedupKey) {
      const colonIdx = dedupKey.indexOf(':');
      if (colonIdx > 0) return dedupKey.slice(0, colonIdx);
    }
    return undefined;
  }

  private cleanup(): void {
    if (this.draftCleanupTimer) clearInterval(this.draftCleanupTimer);
    for (const [, oc] of this.operatorClients) {
      try { oc.wsClient.close({ force: true }); } catch { /* ignore */ }
    }
    this.operatorClients.clear();
  }
}

// ---------------------------------------------------------------------------
// Utilities (unchanged from original)
// ---------------------------------------------------------------------------

/**
 * Convert Feishu post (rich text) message content to Markdown.
 *
 * Post structure (standard format):
 *   { title, content: [[{tag, text, ...}, ...], ...] }
 * Or wrapped in language key:
 *   { zh_cn: { title, content: [[...]] } }
 *
 * There is no native list/ordered tag — list appearance is simulated with
 * "- " or "1. " prefixes in text content. Each outer array element is one
 * paragraph. Inline elements: text, a (link), at (mention), img.
 *
 * Reference: https://open.feishu.cn/document/ukTMukTMukTM/uMDMxEjLzATMx4yMwETM
 */
function extractPostText(data: Record<string, any>): string {
  // Resolve language wrapper if present
  const section = data.content ? data : (data.zh_cn ?? data.en_us ?? Object.values(data)[0]);
  if (!section?.content) return '';

  const lines: string[] = [];

  for (const paragraph of section.content) {
    if (!Array.isArray(paragraph) || paragraph.length === 0) {
      lines.push('');
      continue;
    }

    // Separate inline elements with newlines — Feishu flattens lists into
    // separate text elements within one paragraph, so each element was
    // originally on its own line. Join with \n to restore readability.
    const parts = paragraph.map((inline: any) => convertInline(inline));
    lines.push(parts.filter(Boolean).join('\n'));
  }

  return lines.join('\n\n').trim();
}

/** Convert a single post inline element to Markdown text.
 *
 * Note: When receiving post messages, Feishu already converts markdown syntax
 * into element+style format (e.g. **bold** becomes style:["bold"]). Lists and
 * blockquotes are flattened to plain text. The md tag is write-only and never
 * appears in received messages.
 */
function convertInline(inline: Record<string, any>): string {
  const tag = inline.tag;

  if (tag === 'text') {
    let text = inline.text ?? '';
    const styles: string[] = inline.style ?? [];
    if (styles.includes('bold')) text = `**${text}**`;
    if (styles.includes('italic')) text = `*${text}*`;
    if (styles.includes('code')) text = `\`${text}\``;
    if (styles.includes('strikethrough')) text = `~~${text}~~`;
    return text;
  }

  if (tag === 'a') {
    const href = inline.href ?? '';
    const text = inline.text ?? href;
    return href ? `[${text}](${href})` : text;
  }

  if (tag === 'at') {
    const name = inline.user_name ?? '';
    return name ? `@${name}` : '@user';
  }

  if (tag === 'img') {
    return inline.image_key ? `![image](${inline.image_key})` : '';
  }

  return '';
}

/**
 * Extract plain text/markdown from Feishu interactive (card) message content.
 *
 * JSON 2.0: { body: { elements: [{ tag: "markdown", content: "..." }] } }
 * Legacy:   { elements: [{ tag: "div", text: { tag: "lark_md", content } }] }
 * Rich-text component (tag: "rich_text"): { elements: [{ tag: "text_run", text: "..." }] }
 */
function extractCardText(data: Record<string, any>): string {
  // Locate the elements array — differs between JSON 2.0 and legacy format
  const elements: any[] = data.body?.elements ?? data.elements ?? [];
  if (elements.length === 0) return '';

  const parts: string[] = [];

  for (const el of elements) {
    if (el.tag === 'markdown') {
      // Direct markdown content
      if (el.content) parts.push(el.content);
    } else if (el.tag === 'div' && el.text) {
      // Legacy div container with lark_md or plain_text
      if (el.text.content) parts.push(el.text.content);
    } else if (el.tag === 'rich_text' && el.elements) {
      // Rich-text component with fine-grained elements
      let line = '';
      for (const re of el.elements) {
        line += convertRichTextElement(re);
      }
      if (line) parts.push(line);
    } else if (el.tag === 'note' && el.elements) {
      // Card footer note — text_run, link, mention
      let line = '';
      for (const ne of el.elements) line += convertRichTextElement(ne);
      if (line) parts.push(line);
    } else if (el.tag === 'hr') {
      parts.push('---');
    }
  }

  return parts.join('\n\n').trim();
}

/** Convert a single rich-text element (card component) to markdown. */
function convertRichTextElement(el: Record<string, any>): string {
  if (el.tag === 'text_run') {
    let text = el.text ?? '';
    const style = el.text_element_style ?? {};
    if (style.bold) text = `**${text}**`;
    if (style.italic) text = `*${text}*`;
    if (style.strikethrough) text = `~~${text}~~`;
    if (style.code) text = `\`${text}\``;
    if (style.underline) text = `<u>${text}</u>`;
    return text;
  }

  if (el.tag === 'link') {
    const url = el.url ?? '';
    const text = el.text ?? url;
    return url ? `[${text}](${url})` : text;
  }

  if (el.tag === 'mention') {
    return `@${el.user_name ?? el.user_id ?? 'user'}`;
  }

  if (el.tag === 'emoji') {
    return el.emoji ?? '';
  }

  return '';
}

/**
 * Parse a Feishu message body.content string into readable text/markdown,
 * handling text, post, and interactive (card) message types.
 */
function parseMessageContent(msgType: string, content: string): string {
  if (msgType === 'text') {
    try { return (JSON.parse(content).text ?? content).replace(/@_user_\d+/g, '').trim(); } catch { return content; }
  }
  if (msgType === 'post') {
    try { return extractPostText(JSON.parse(content)); } catch { return ''; }
  }
  if (msgType === 'interactive') {
    try { return extractCardText(JSON.parse(content)); } catch { return ''; }
  }
  return '';
}


/**
 * Extract a short display string from Bitable event field_value arrays.
 * Each item: { field_id, field_value, field_identity_value? }
 * Returns "field_id=val, ..." truncated to 120 chars.
 */
function extractFieldValues(items: any[]): string {
  return items.map((v: any) => {
    const id = (v.field_id || '').slice(0, 6);
    const val = typeof v.field_value === 'string'
      ? v.field_value.slice(0, 40)
      : v.field_value !== undefined ? String(v.field_value).slice(0, 40) : '';
    return `${id}=${val}`;
  }).join(',').slice(0, 120) || '-';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
