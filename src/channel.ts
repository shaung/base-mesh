import { logger } from './log.js';
import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { Config, BitableRecord, Part } from './types.js';
import { parsePostToParts } from './message-parser.js';
import { BitableClient } from './bitable.js';
import { Session } from './protocol.js';
import { extractText, extractUserIds } from './text.js';
import { getDomainConfig } from './domain.js';
import { formatMessage } from './messages.js';
import { Coordinator } from './coordinator.js';

const DEFAULT_EMOJI = 'OneSecond';

// ---------------------------------------------------------------------------
// Channel — Feishu IM communication only.
//
// Responsibilities:
//   1. Receive user DMs via WebSocket
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
  private wsClient: WSClient | null = null;
  private bitable: BitableClient;
  private session: Session;
  private client: Client;
  private coordinator: Coordinator | null = null;
  private running = true;
  private draftCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private deliveredTurnIds = new Set<string>();
  private deliveryInFlight = new Set<string>();
  private lite: boolean;
  private cachedDomains: import('./intent.js').Domain[] | null = null;

  constructor(private cfg: Config, lite = false) {
    this.lite = lite;
    this.bitable = new BitableClient(cfg);
    this.session = new Session('channel', 'Channel', cfg, this.bitable);
    const dc = getDomainConfig(cfg.openApiDomain);
    this.client = new Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret || 'unused',
      domain: dc.sdkBaseUrl,
      loggerLevel: 2, // warn
    });
  }

  async run(): Promise<void> {
    const { enableFileLogging } = await import('./log.js');
    enableFileLogging();

    process.on('SIGTERM', () => { this.stop(); process.exit(0); });
    process.on('SIGINT', () => { this.stop(); process.exit(0); });

    const label = this.lite ? 'channel-lite' : 'channel';
    console.log(`[${label}] started`);

    // Load runtime config from Configs Bitable table if configured
    const { enrichConfigFromBitable } = await import('./config.js');
    await enrichConfigFromBitable(this.cfg);

    // Start coordinator (push executor WS server) unless in lite mode
    if (!this.lite) {
      this.coordinator = new Coordinator(this.cfg);
      this.coordinator.start();
    }

    await this.subscribeBitableEvents();
    await this.connectWebSocket();

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
    console.log('[channel] stopped');
    process.exit(0);
  }

  stop(): void {
    this.running = false;
    if (this.draftCleanupTimer) clearInterval(this.draftCleanupTimer);
    if (this.coordinator) this.coordinator.stop();
    if (this.wsClient) {
      try { this.wsClient.close({ force: true }); } catch { /* ignore */ }
      this.wsClient = null;
    }
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
      console.log(`[channel] bitable event: ${tableId.slice(0,8)}/${recordId.slice(0,8)} ${action?.action}`);
    }

    // Dispatch by table
    if (tableId === this.cfg.ticketsTableId) {
      // Round-driven mode: routing is triggered by new user Turns, not ticket
      // status changes. Log only for debugging.
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
      // Turn changed — deliver to IM if notifiable. Routing is driven by
      // Round events (Round created by handleThreadReply after Turn is written).
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
    let finalContent = content;
    if (human) {
      const parts = human.split(',').filter(Boolean);
      const mentions = parts.map(p => p.startsWith('ou_') ? `<at id=${p}></at>` : p).join(' ');
      finalContent = formatMessage(this.cfg.messages?.ccFormat || '{content}\n\ncc {mentions}', { content, mentions });
    }
    try {
      await this.reply(rootMsgId, finalContent, true);
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
      if (body.code === 0) console.log('[channel] subscribed to bitable events');
      else console.warn(`[channel] subscribe failed (HTTP ${resp.status}):`, rawBody.slice(0, 500));
    } catch (err: any) {
      console.warn(`[channel] subscribe failed: ${err.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // WebSocket
  // -----------------------------------------------------------------------

  private async connectWebSocket(): Promise<void> {
    if (!this.cfg.appSecret) {
      console.log('[channel] appSecret required for WebSocket event subscription.');
      return;
    }

    try {
      const dc = getDomainConfig(this.cfg.openApiDomain);
      this.wsClient = new WSClient({
        appId: this.cfg.appId,
        appSecret: this.cfg.appSecret,
        domain: dc.sdkBaseUrl,
        loggerLevel: 2, // warn
        autoReconnect: true,
        onReady: () => console.log('[channel] WS connected'),
        onError: (err) => logger.error(`[channel] WS error: ${err.message}`),
        onReconnecting: () => console.log('[channel] WS reconnecting...'),
        onReconnected: () => console.log('[channel] WS reconnected'),
      });

      const dispatcher = new EventDispatcher({});
      dispatcher.register({
        'im.message.receive_v1': async (data: any) => {
          try { await this.onBotMessage(data); } catch (err) { logger.error('[channel] onBotMessage crashed:', err); }
        },
        'drive.file.bitable_record_changed_v1': async (data: any) => { await this.onBitableEvent(data); },
        'card.action.trigger': async (data: any) => {
          try { await this.onCardAction(data); } catch (err) { logger.error('[channel] onCardAction crashed:', err); }
        },
      });

      await this.wsClient.start({ eventDispatcher: dispatcher });
    } catch (err: any) {
      console.warn(`[channel] WS init failed: ${err.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Message handler
  // -----------------------------------------------------------------------

  private async onBotMessage(raw: any): Promise<void> {
    const data = raw.event ?? raw;
    const msg = data.message;
    console.log(`[channel] IM event type=${msg?.message_type} chat=${msg?.chat_type}`);

    if (!msg) {
      console.log(`[channel] no message in event, raw=${JSON.stringify(raw).slice(0, 500)}`);
      return;
    }

    // Only messages from real users
    if (data.sender?.sender_type !== 'user') return;

    if (msg.chat_type !== 'p2p' && msg.chat_type !== 'group') return;

    // Check if the bot itself was @mentioned (mention_type='bot' in Feishu).
    // When the app has "receive all messages" event subscription, non-@mentioned
    // group messages also arrive — those are used for context accumulation.
    const botMentioned = Array.isArray(msg.mentions) && msg.mentions.some(
      (m: any) => m?.mentioned_type === 'bot',
    );

    // /reload — only respond to @mentioned /reload
    const contentRaw = String(msg.content ?? '');
    let textContent = '';
    try { textContent = JSON.parse(contentRaw).text ?? contentRaw; } catch { textContent = contentRaw; }
    if (botMentioned && textContent.trim().toLowerCase() === '/reload') {
      if (!this.cfg.configsTableId) {
        await this.reply(msg.message_id, '⚠️ No configs table configured.', true);
      } else {
        try {
          const { enrichConfigFromBitable } = await import('./config.js');
          await enrichConfigFromBitable(this.cfg);
          await this.reply(msg.message_id, '✅ Configs reloaded from Bitable.', true);
        } catch (err: any) {
          await this.reply(msg.message_id, `⚠️ Reload failed: ${err.message}`, true);
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
        console.log(`[channel] post raw=${msg.content}`);
        content = extractPostText(parsed);
        // Also parse structured parts for the turn record
        const parsedParts = parsePostToParts(msg.content);
        parts = parsedParts.parts;
        if (!parts.length) console.log(`[channel] parsePostToParts returned empty parts, raw=${msg.content.slice(0, 300)}`);
        if (!content) console.log(`[channel] post content empty, raw=${JSON.stringify(parsed).slice(0, 300)}`);
      } catch (err) {
        console.log(`[channel] post parse failed raw=${String(msg.content).slice(0, 300)} err=${(err as Error).message}`);
        content = '';
      }
    } else if (msg.message_type === 'interactive') {
      try {
        content = extractCardText(JSON.parse(msg.content));
      } catch (err) {
        console.log(`[channel] interactive parse failed raw=${String(msg.content).slice(0, 300)} err=${(err as Error).message}`);
        content = '';
      }
    } else if (msg.message_type === 'text') {
      try { content = JSON.parse(msg.content).text ?? msg.content; } catch { content = msg.content; }
      // Strip mention markers (@_user_N) from group chat messages
      content = content.replace(/@_user_\d+/g, '').trim();
      if (content) parts.push({ kind: 'text', text: content });
    } else {
      return; // unsupported message type
    }
    if (!content) return;

    const messageId = msg.message_id;
    if (!messageId) return;

    const senderId = data.sender.sender_id?.open_id ?? 'unknown';
    const chatId = msg.chat_id;
    const rootId = msg.root_id;

    // If this message is a reply to another message, fetch the parent's text
    // and prepend it as a quote so the executor has full context.
    // Skip when parent is just the thread root (same as root_id) — that's
    // every message in the thread and quoting it is just noise.
    if (msg.parent_id && msg.parent_id !== rootId) {
      try {
        const parentText = await this.fetchMessageText(msg.parent_id);
        if (parentText) {
          content = `> ${parentText.replace(/\n/g, '\n> ')}\n\n${content}`;
        }
      } catch (err) {
        console.log(`[channel] fetch parent message failed id=${msg.parent_id} err=${(err as Error).message}`);
      }
    }

    console.log(`[channel] DM from ${senderId}: ${content.slice(0, 80)}`);

    // Acknowledge receipt — only when bot is @mentioned
    if (botMentioned) {
      const mode = this.cfg.operator?.reactionMode ?? 'emoji';
      const ackMsg = this.cfg.messages?.ackReceived || '✅ Received';
      if (mode !== 'card') {
        try { await this.react(messageId, DEFAULT_EMOJI); } catch {
          if (mode === 'both') await this.reply(messageId, ackMsg, false);
        }
      }
      if (mode === 'card') {
        try { await this.reply(messageId, ackMsg, false); } catch { /* best effort */ }
      }
    }

    // Dedup
    try {
      const existing = await this.bitable.searchRecords(this.cfg.turnsTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.cfg.fields.turn.dedupKey, operator: 'is', value: [messageId] },
        ],
      });
      if (existing.length > 0) {
        console.log(`[channel] dedup: message ${messageId.slice(0, 16)} already processed, skipping`);
        return;
      }
    } catch { /* best effort */ }

    // --- /cancel command ────────────────────────────────────────────

    if (this.cfg.roundsTableId && content.trim() === '/cancel') {
      await this.handleCancel(senderId, messageId);
      return;
    }

    // --- Thread reply ────────────────────────────────────────────────

    if (rootId) {
      console.log(`[channel] thread reply lookup rootId=${rootId.slice(0,20)}... botMentioned=${botMentioned}`);
      let ticket = await this.session.findByThreadRoot(rootId);
      if (!ticket || !ticket.record_id) {
        // rootId lookup may fail if ticket was created before the rootMsgId
        // fix. Fall back to finding the most recent ticket in this chat.
        console.log(`[channel] thread root not found, fallback by chat_id=${chatId.slice(0,20)}...`);
        const recent = await this.bitable.searchRecords(this.cfg.ticketsTableId, {
          conjunction: 'and',
          conditions: [
            { field_name: this.cfg.fields.ticket.chatId, operator: 'is', value: [chatId] },
          ],
        });
        // Sort by updatedAt descending, take the most recent
        recent.sort((a, b) => Number(b.fields[this.cfg.fields.ticket.updatedAt] ?? 0) - Number(a.fields[this.cfg.fields.ticket.updatedAt] ?? 0));
        ticket = recent[0] ?? null;
        if (ticket) console.log(`[channel] fallback found ticket ${ticket.record_id}`);
        else console.log('[channel] no ticket found for this chat');
      }
      if (ticket?.record_id) {
        console.log(`[channel] thread reply → ticket ${ticket.record_id} mentioned=${botMentioned}`);
        await this.handleThreadReply(ticket, content, messageId, senderId, parts, botMentioned);
        return;
      }
    }

    // --- New conversation ────────────────────────────────────────────

    // In group chat, non-@mentioned messages don't start new tickets
    // (they're only used for context accumulation in existing threads).
    if (!botMentioned && msg.chat_type === 'group') {
      console.log(`[channel] skip new conversation: non-mentioned group msg rootId=${(rootId || '').slice(0,20)}`);
      return;
    }

    // Ensure sender has a Roster record (human participant)
    await this.ensureHumanRoster(senderId);

    try {
      const ticket = await this.session.createTicket(content, {
        // Use thread root_id if available so subsequent thread replies
        // (including non-@mentioned ones) can find this ticket via findByThreadRoot.
        rootMsgId: rootId || messageId,
        chatId,
        senderId,
      });

      // Resolve IM images to Drive file_tokens BEFORE writing the Turn,
      // so the stored parts and attachments already have real persistent tokens.
      let resolvedParts = parts;
      let attachmentTokens: string[] = [];
      if (msg.message_type === 'post' && parts.some(p => p.kind === 'file')) {
        const { resolveImageParts } = await import('./a2a.js');
        const result = await resolveImageParts(parts, this.cfg, messageId);
        resolvedParts = result.parts;
        attachmentTokens = result.attachmentTokens;
      }

      const turnFields: Record<string, unknown> = {
        [this.cfg.fields.turn.ticketRecordId]: ticket.record_id,
        [this.cfg.fields.turn.rootMsgId]: messageId,
        [this.cfg.fields.turn.role]: 'user',
        [this.cfg.fields.turn.content]: content,
        [this.cfg.fields.turn.dedupKey]: messageId,
        [this.cfg.fields.turn.agentIdentity]: senderId,
        [this.cfg.fields.turn.createdAt]: Date.now(),
      };
      if (resolvedParts.length > 0) turnFields[this.cfg.fields.turn.parts] = JSON.stringify(resolvedParts);
      if (attachmentTokens.length > 0) turnFields[this.cfg.fields.turn.attachments] = attachmentTokens.map(t => ({ file_token: t }));
      const turnRecord = await this.bitable.createRecord(this.cfg.turnsTableId, turnFields);

      await this.processDraft(ticket, content, messageId, chatId);

      // Assign the initial Turn to the newly created Round (Round-driven mode)
      if (this.cfg.roundsTableId && ticket.record_id) {
        const currentRound = await this.session.getCurrentRound(ticket.record_id);
        if (currentRound?.record_id) {
          await this.session.assignTurnsToRound(ticket.record_id, currentRound.record_id);
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
  ): Promise<void> {
    const recordId = ticket.record_id!;
    const status = String(ticket.fields[this.cfg.fields.ticket.status] ?? '');
    const chatId = String(ticket.fields[this.cfg.fields.ticket.chatId] ?? '');

    // New turns are NOT associated with any existing round. When the bot
    // is @mentioned later, processDraft creates a fresh round that pulls
    // in all accumulated turns via assignTurnsToRound.

    // Resolve IM images to Drive file_tokens BEFORE writing the Turn
    let resolvedReplyParts = parts;
    let replyAttachTokens: string[] = [];
    if (parts.some(p => p.kind === 'file')) {
      const { resolveImageParts } = await import('./a2a.js');
      const result = await resolveImageParts(parts, this.cfg, messageId);
      resolvedReplyParts = result.parts;
      replyAttachTokens = result.attachmentTokens;
    }

    // Append the user turn with round_id association
    const rootMsgId = extractText(ticket.fields[this.cfg.fields.ticket.rootMsgId]);
    const replyFields: Record<string, unknown> = {
      [this.cfg.fields.turn.ticketRecordId]: recordId,
      [this.cfg.fields.turn.rootMsgId]: rootMsgId,
      [this.cfg.fields.turn.role]: 'user',
      [this.cfg.fields.turn.content]: content,
      [this.cfg.fields.turn.dedupKey]: messageId,
      [this.cfg.fields.turn.agentIdentity]: senderId,
      [this.cfg.fields.turn.createdAt]: Date.now(),
    };
    if (resolvedReplyParts.length > 0) replyFields[this.cfg.fields.turn.parts] = JSON.stringify(resolvedReplyParts);
    if (replyAttachTokens.length > 0) replyFields[this.cfg.fields.turn.attachments] = replyAttachTokens.map(t => ({ file_token: t }));
    const turnRecord = await this.bitable.createRecord(this.cfg.turnsTableId, replyFields);

    // Draft → re-evaluate completeness (only when bot is @mentioned)
    if (mentioned && status === this.cfg.statuses.draft) {
      await this.processDraft(ticket, content, messageId, chatId);
      // Assign turns to the Round created by processDraft (draft has no Round yet)
      if (this.cfg.roundsTableId && recordId) {
        const round = await this.session.getCurrentRound(recordId);
        if (round?.record_id) {
          await this.session.assignTurnsToRound(recordId, round.record_id);
        }
      }
      return;
    }

    console.log(`[channel] thread reply: ticket=${recordId.slice(0,12)} status=${status} mentioned=${mentioned}`);
    // Only @mentioned messages should trigger round lifecycle changes
    if (!mentioned) return;

    // Pending/assigned — check whether current Round is still active
    if (status === this.cfg.statuses.active) {
      if (this.cfg.roundsTableId) {
        const currentRound = await this.session.getCurrentRound(recordId);
        if (currentRound?.record_id) {
          const roundStatus = String(currentRound.fields[this.cfg.fields.round.status] ?? '');
          const terminal = [this.cfg.roundStatuses.done, this.cfg.roundStatuses.failed, this.cfg.roundStatuses.cancelled];
          const nonPendingActive = [this.cfg.roundStatuses.pendingApproval, this.cfg.roundStatuses.approved, this.cfg.roundStatuses.executing];
          if (roundStatus === this.cfg.roundStatuses.pending) {
            // Pending round was never assigned — cancel and create a new one
            console.log(`[channel] pending round ${currentRound.record_id}, cancelling and creating new round`);
            await this.session.transitionRound(currentRound.record_id, this.cfg.roundStatuses.cancelled);
            const domains = await this.runIntent(ticket, content, recordId);
            const round = await this.session.createRound(recordId, domains);
            console.log(`[channel] created round ${round.record_id!} with domains=${domains}`);
            await this.session.assignTurnsToRound(recordId, round.record_id!);
          } else if (nonPendingActive.includes(roundStatus)) {
            // Round still active — revert, executor will pick up
            console.log(`[channel] revert round ${currentRound.record_id} (${roundStatus}) for new reply`);
            await this.session.transitionRound(currentRound.record_id, this.cfg.roundStatuses.pending);
            await this.session.releaseRound(currentRound.record_id);
            if (roundStatus === this.cfg.roundStatuses.executing && this.coordinator) {
              await this.coordinator.dispatchCancelToExecutor(currentRound.record_id);
            }
          } else if (terminal.includes(roundStatus)) {
            // Previous Round is terminal — create a new one
            console.log(`[channel] prev round ${currentRound.record_id} done, creating new round`);
            const domains = await this.runIntent(ticket, content, recordId);
            const round = await this.session.createRound(recordId, domains);
            console.log(`[channel] created round ${round.record_id!} with domains=${domains}`);
            await this.session.assignTurnsToRound(recordId, round.record_id!);
          }
        } else {
          // No active Round at all — create one
          const domains = await this.runIntent(ticket, content, recordId);
          const round = await this.session.createRound(recordId, domains);
          console.log(`[channel] created round ${round.record_id!} with domains=${domains}`);
          await this.session.assignTurnsToRound(recordId, round.record_id!);
        }
      }
      return;
    }

    // Done — reopen with intent re-evaluation
    if (status === this.cfg.statuses.closed) {
      await this.session.promoteToPending(recordId, content);
      if (this.cfg.roundsTableId) {
        const domains = await this.runIntent(ticket, content, recordId);
        try {
          const round = await this.session.createRound(recordId, domains);
          console.log(`[channel] created round ${round.record_id!} for reopened ticket ${recordId}`);
          if (round.record_id) {
            await this.session.assignTurnsToRound(recordId, round.record_id);
          }
        } catch (err) {
          logger.error('[channel] createRound failed:', err);
        }
      }
      // silently reopened
      return;
    }

    // Failed — reactivate with intent re-evaluation
    if (status === this.cfg.statuses.closed) {
      await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
        [this.cfg.fields.ticket.status]: this.cfg.statuses.active,
        [this.cfg.fields.ticket.retryCount]: 0,
        [this.cfg.fields.ticket.owner]: '',
        [this.cfg.fields.ticket.ownerLeaseAt]: 0,
      });
      if (this.cfg.roundsTableId) {
        const domains = await this.runIntent(ticket, content, recordId);
        try {
          const round = await this.session.createRound(recordId, domains);
          console.log(`[channel] created round ${round.record_id!} for reactivated ticket ${recordId}`);
          if (round.record_id) {
            await this.session.assignTurnsToRound(recordId, round.record_id);
          }
        } catch (err) {
          logger.error('[channel] createRound failed:', err);
        }
      }
      // silently reactivated
      return;
    }
  }

  /** Run intent recognition + #domain tag override, returns abilities array. */
  private async runIntent(ticket: BitableRecord, content: string, recordId: string): Promise<string[] | undefined> {
    // Check for explicit #domain tag first (e.g. "#developer fix the bug")
    const { parseDomainTag } = await import('./intent.js');
    const loadedDomains = await this.loadDomains();
    const tagResult = parseDomainTag(content, loadedDomains);
    if (tagResult) {
      console.log(`[channel] domain tag override: ${tagResult.tag}`);
      return [tagResult.tag];
    }
    if (!this.cfg.intent) return ['general'];
    const { processMessage } = await import('./intent.js');
    const turns = await this.session.getTurns(recordId);
    const conversation = turns.map(t => `[${t.fields[this.cfg.fields.turn.role]}]\n${t.fields[this.cfg.fields.turn.content]}`).join('\n');
    const result = await processMessage(content, loadedDomains, conversation, this.cfg.intent);
    console.log(`[channel] intent: domains=${result.domains} isComplete=${result.isComplete}`);
    return result.domains.length > 0 ? result.domains : ['general'];
  }

  /** Handle /cancel command — cancel the current Round for the user's ticket. */
  private async handleCancel(senderId: string, messageId: string): Promise<void> {
    try {
      // Find an active ticket for this sender across all non-terminal statuses.
      // The ticket may have been promoted from draft → pending/assigned, so we
      // cannot restrict the search to draft status only.
      const tickets = await this.session.searchTicketsBySender(senderId);
      const terminalStatuses = [this.cfg.statuses.closed, this.cfg.statuses.closed, this.cfg.statuses.closed];
      const activeTickets = tickets.filter(t => {
        const status = String(t.fields[this.cfg.fields.ticket.status] ?? '');
        return !terminalStatuses.includes(status);
      });
      if (activeTickets.length === 0) {
        await this.reply(messageId, 'No active ticket found to cancel.', true);
        return;
      }
      const ticket = activeTickets[activeTickets.length - 1];
      const round = await this.session.getCurrentRound(ticket.record_id!);
      if (round && round.record_id) {
        const ok = await this.session.transitionRound(round.record_id, this.cfg.roundStatuses.cancelled);
        if (ok) {
          await this.reply(messageId, '✅ Processing cancelled.', true);
          console.log(`[channel] cancelled round ${round.record_id} for ticket ${ticket.record_id!}`);
          // Propagate cancel to push executor if running
          if (this.coordinator) {
            await this.coordinator.dispatchCancelToExecutor(round.record_id);
          }
        } else {
          await this.reply(messageId, 'Could not cancel — round may have already completed.', true);
        }
      } else {
        await this.reply(messageId, 'No active processing round to cancel.', true);
      }
    } catch (err) {
      logger.error('[channel] handleCancel error:', err);
      await this.reply(messageId, 'Error processing cancel command.', true);
    }
  }

  private async processDraft(
    ticket: BitableRecord,
    content: string,
    messageId: string,
    _chatId: string,
  ): Promise<void> {
    let domains: string[] = ['general'];
    let summary = content;
    const loadedDomains = await this.loadDomains();

    if (this.cfg.intent) {
      const { processMessage } = await import('./intent.js');
      const turns = await this.session.getTurns(ticket.record_id!);
      const conversation = turns.map(t => `[${t.fields[this.cfg.fields.turn.role]}]\n${t.fields[this.cfg.fields.turn.content]}`).join('\n');
      const result = await processMessage(content, loadedDomains, conversation, this.cfg.intent);
      domains = result.domains;
      summary = result.summary || content;
      console.log(`[channel] intent: domains=${result.domains} isComplete=${result.isComplete} summary=${result.summary.slice(0,40)}`);

      if (!result.isComplete) {
        const question = result.missingFields.length > 0
          ? `Please provide: ${result.missingFields.join(', ')}`
          : (this.cfg.messages?.clarifyQuestion || 'Could you please provide more details?');
        await this.reply(messageId, question, true);
        console.log(`[channel] clarification asked for ticket ${ticket.record_id!}: missing=${result.missingFields}`);
        return;
      }
    }

    // Check for explicit #domain tag override (e.g. "#developer fix the bug").
    // Tags take precedence over LLM intent result.
    const { parseDomainTag } = await import('./intent.js');
    const tagResult = parseDomainTag(summary || content, loadedDomains);
    if (tagResult) {
      domains = [tagResult.tag];
      summary = tagResult.cleaned;
      console.log(`[channel] domain tag override: ${tagResult.tag}`);
    }

    await this.session.promoteToPending(ticket.record_id!, summary);
    console.log(`[channel] ticket ${ticket.record_id!} promoted to pending`);

    // In Round-driven mode, create a Round with abilities
    if (this.cfg.roundsTableId && ticket.record_id) {
      try {
        const round = await this.session.createRound(ticket.record_id, domains.length > 0 ? domains : undefined);
        console.log(`[channel] created round ${round.record_id!} for ticket ${ticket.record_id} with domains=${domains}`);
      } catch (err) {
        logger.error('[channel] createRound failed:', err);
      }
    }

    // Try routing to push executor
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

      console.log(`[channel] deliverTurns: ${turns.length} turns to deliver`);
      for (const turn of turns) {
        if (!this.running) break;
        const turnRecordId = turn.record_id;
        if (!turnRecordId) continue;
        if (this.deliveredTurnIds.has(turnRecordId)) continue;

        // Multi-process safety: claim the turn before delivering.  The claim
        // writes deliveryOwner + deliveryLeaseAt using WSR (write-sleep-read).
        // Only the winning Channel process proceeds with IM delivery.
        const claimed = await this.session.claimTurnDelivery(turnRecordId);
        if (!claimed) {
          continue;
        }

        const content = extractText(turn.fields[this.cfg.fields.turn.content]);
        const rootMsgId = extractText(turn.fields[this.cfg.fields.turn.rootMsgId]);
        const status = String(turn.fields[this.cfg.fields.turn.status] ?? '');

        if (!content || !rootMsgId) {
          console.log(`[channel] skip turn ${turnRecordId} (missing content/rootMsgId)`);
          continue;
        }

        // Append human CC mention if the turn carries reviewer/owner people.
        // This may be either a direct Person field or a Lookup-wrapped Person
        // field depending on how the user's Bitable schema is configured.
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
          await this.reply(rootMsgId, finalContent, true);
          this.deliveredTurnIds.add(turnRecordId);
          await this.session.markTurnNotified(turnRecordId);
          console.log(`[channel] delivered ${status} turn ${turnRecordId}`);
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

        // Check if we already sent a card (avoid duplicates)
        const cardDedupKey = `approval_card_${round.record_id}`;
        const existing = await this.bitable.searchRecords(this.cfg.turnsTableId, {
          conjunction: 'and',
          conditions: [
            { field_name: this.cfg.fields.turn.dedupKey, operator: 'is', value: [cardDedupKey] },
          ],
        });
        if (existing.length > 0) continue;

        // Send approval card
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
          await this.client.im.v1.message.reply({
            path: { message_id: rootMsgId },
            data: { msg_type: 'interactive', content: JSON.stringify(card), reply_in_thread: true } as any,
          });
          // Record the card as a turn for dedup
          await this.bitable.createRecord(this.cfg.turnsTableId, {
            [this.cfg.fields.turn.ticketRecordId]: ticketId,
            [this.cfg.fields.turn.rootMsgId]: rootMsgId,
            [this.cfg.fields.turn.role]: 'system',
            [this.cfg.fields.turn.content]: `Approval card sent for round ${round.record_id}`,
            [this.cfg.fields.turn.dedupKey]: cardDedupKey,
            [this.cfg.fields.turn.createdAt]: Date.now(),
          });
          console.log(`[channel] approval card sent for round ${round.record_id}`);
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
    const decision = action.value.action; // 'approve' | 'reject'
    if (!roundId || !decision) return;

    console.log(`[channel] card action: ${decision} round=${roundId}`);
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

      if (closed > 0) console.log(`[channel] closed ${closed} stale draft(s)`);

      // Prevent unbounded growth of the delivered-turn dedup set
      if (this.deliveredTurnIds.size > 10_000) {
        this.deliveredTurnIds.clear();
        console.log('[channel] cleared deliveredTurnIds set');
      }
    } catch (err) {
      logger.error('[channel] cleanupStaleDrafts error:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Capabilities classification
  // -----------------------------------------------------------------------

  /** Classify user message to a capability.
   *
   *  Method 1 (command): if message starts with `/tech_support`, etc.
   *    The prefix is stripped from the returned content.
   *
   *  Method 2 (keyword): fetch the capabilities whitelist table, match
   *    keywords from each row's description field against the message.
   *
   *  Falls back to undefined if no match. */
  /** Load enabled capabilities from Roles table (cached). */
  private async loadDomains(): Promise<import('./intent.js').Domain[]> {
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
        .filter(d => d.domain.length > 0) as unknown as import('./intent.js').Domain[];
      // Refresh cache every 60s
      setTimeout(() => { this.cachedDomains = null; }, 60_000);
      return this.cachedDomains;
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Human participant management
  // -----------------------------------------------------------------------

  /** Ensure a human Roster record exists for the given sender_id (open_id).
   *  Creates one with kind=human if not found. */
  private async ensureHumanRoster(senderId: string): Promise<void> {
    try {
      // Search for existing human record — filter by kind and human field
      const existing = await this.bitable.searchRecords(this.cfg.rosterTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.cfg.fields.roster.kind, operator: 'is', value: ['human'] },
        ],
      });
      // The human field (Person type) stores [{id: "ou_xxx", ...}].
      // We can't search Person fields with 'is' directly, so filter in code.
      const found = existing.find((r) => {
        const human = extractUserIds(r.fields[this.cfg.fields.roster.human]);
        return human.includes(senderId);
      });
      if (found) return;
    } catch { /* best effort */ }

    // Create a new human Roster record
    try {
      const identity = `human_${senderId}`;
      await this.bitable.createRecord(this.cfg.rosterTableId, {
        [this.cfg.fields.roster.identity]: identity,
        [this.cfg.fields.roster.nickname]: `user_${senderId.slice(0, 8)}`,
        [this.cfg.fields.roster.kind]: 'human',
        [this.cfg.fields.roster.human]: [{ id: senderId }],
        [this.cfg.fields.roster.enabled]: true,
      });
      console.log(`[channel] created human roster: ${identity}`);
    } catch (err) {
      console.log('[channel] ensureHumanRoster failed:', err);
    }
  }

  /** Notify human roster participants when tickets are pending. */
  private async notifyHumans(): Promise<void> {
    try {
      // Only notify humans for tickets pending direct human assignment
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

        // Find matching humans from Roster
        const roster = await this.bitable.searchRecords(this.cfg.rosterTableId, {
          conjunction: 'and',
          conditions: [
            { field_name: this.cfg.fields.roster.kind, operator: 'is', value: ['human'] },
            { field_name: this.cfg.fields.roster.enabled, operator: 'is', value: [true] },
          ],
        });

        if (roster.length === 0) continue;

        // Build @mention string
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
        console.log(`[channel] notified humans for ticket ${ticket.record_id}`);
      }
    } catch (err) {
      logger.error('[channel] notifyHumans error:', err);
    }
  }

  // -----------------------------------------------------------------------
  // IM helpers
  // -----------------------------------------------------------------------

  private async react(messageId: string, emojiType: string): Promise<void> {
    await this.client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
  }

  /** Reply to a message, optionally in thread mode, using Card JSON 2.0 markdown. */
  private async reply(messageId: string, text: string, replyInThread?: boolean): Promise<void> {
    if (!text.trim()) return;

    const card = {
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: text },
        ],
      },
    };

    try {
      await this.client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
          reply_in_thread: replyInThread,
        } as any,
      });
    } catch (err: any) {
      // Card may fail if markdown content has too many tables (Feishu limit).
      // Fall back to plain text. SDK error is at err.response.data.code.
      const apiCode = err?.response?.data?.code ?? err?.code;
      const isTableLimit = apiCode === 230099 || String(err?.message ?? err).includes('card table number over limit');
      if (isTableLimit) {
        await this.client.im.v1.message.reply({
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

  /** Fetch a message by ID and extract its text content for context quoting. */
  private async fetchMessageText(messageId: string): Promise<string> {
    const resp: any = await this.client.im.v1.message.get({
      path: { message_id: messageId },
    });
    const msg = resp?.data?.items?.[0];
    if (!msg?.msg_type || !msg?.body?.content) return '';
    return parseMessageContent(msg.msg_type, msg.body.content);
  }

  private cleanup(): void {
    if (this.draftCleanupTimer) clearInterval(this.draftCleanupTimer);
    if (this.wsClient) {
      try { this.wsClient.close({ force: true }); } catch { /* ignore */ }
      this.wsClient = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
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
