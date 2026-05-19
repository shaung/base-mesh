import { logger } from './log.js';
// Operator — Feishu IM interaction. Receives user messages via WebSocket,
// writes Turns, delivers replies to IM. Does NOT handle executor coordination.

import { spawn } from 'node:child_process';
import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { Config, BitableRecord, CompletenessCheckResult } from './types.js';
import { BitableClient } from './bitable.js';
import { Session, extractText, extractUserIds } from './protocol.js';
import { getDomainConfig } from './domain.js';
import { formatMessage } from './messages.js';

const DEFAULT_EMOJI = 'OnIt';
const COMPLETENESS_PROMPT = 'Analyze the support ticket below. Determine if enough info is provided.\nRespond in JSON: {"isComplete":true/false,"summary":"...","missingFields":[...],"forRoles":[...]}';

export class Operator {
  private wsClient: WSClient | null = null;
  private bitable: BitableClient;
  private session: Session;
  private client: Client;
  private running = true;
  private draftCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private deliveredTurnIds = new Set<string>();

  constructor(private cfg: Config) {
    this.bitable = new BitableClient(cfg);
    this.session = new Session(cfg.clientId || cfg.identity, cfg.nickname, cfg, this.bitable);
    const dc = getDomainConfig(cfg.openApiDomain);
    this.client = new Client({ appId: cfg.appId, appSecret: cfg.appSecret || 'unused', domain: dc.sdkBaseUrl });
  }

  async run(): Promise<void> {
    process.on('SIGTERM', () => { this.stop(); process.exit(0); });
    process.on('SIGINT', () => { this.stop(); process.exit(0); });
    console.log(`[operator] started identity=${this.cfg.clientId || this.cfg.identity}`);

    await this.connectWebSocket();

    const ttlMs = (this.cfg.operator?.draftTTLMinutes ?? 60) * 60 * 1000;
    this.draftCleanupTimer = setInterval(() => this.cleanupStaleDrafts(ttlMs), ttlMs);

    while (this.running) {
      await sleep((this.cfg.operator?.pollIntervalSeconds ?? 3) * 1000);
      try { await this.deliverTurns(); } catch { /* */ }
    }
    this.cleanup();
    console.log('[operator] stopped');
    process.exit(0);
  }

  stop(): void {
    this.running = false;
    if (this.draftCleanupTimer) clearInterval(this.draftCleanupTimer);
    if (this.wsClient) { try { this.wsClient.close({ force: true }); } catch { /* */ } }
  }

  // -- WebSocket -----------------------------------------------------------
  private async connectWebSocket(): Promise<void> {
    if (!this.cfg.appSecret) { console.log('[operator] appSecret required for IM'); return; }
    try {
      const dc = getDomainConfig(this.cfg.openApiDomain);
      this.wsClient = new WSClient({
        appId: this.cfg.appId, appSecret: this.cfg.appSecret, domain: dc.sdkBaseUrl, autoReconnect: true,
        onReady: () => console.log('[operator] WS connected'),
        onError: (err: any) => logger.error(`[operator] WS error: ${err.message}`),
      });
      const dispatcher = new EventDispatcher({});
      dispatcher.register({ 'im.message.receive_v1': async (data: any) => { await this.onBotMessage(data); } });
      await this.wsClient.start({ eventDispatcher: dispatcher });
    } catch (err: any) { console.warn(`[operator] WS init failed: ${err.message}`); }
  }

  // -- Message handler -----------------------------------------------------
  private async onBotMessage(raw: any): Promise<void> {
    const data = raw.event ?? raw;
    const msg = data.message;
    if (!msg || data.sender?.sender_type !== 'user') return;
    if (msg.chat_type === 'group' && (!msg.mentions || msg.mentions.length === 0)) return;
    if (msg.chat_type !== 'p2p' && msg.chat_type !== 'group') return;

    let content: string;
    if (msg.message_type === 'text') {
      try { content = JSON.parse(msg.content).text ?? msg.content; } catch { content = msg.content; }
      content = content.replace(/@_user_\d+/g, '').trim();
    } else { return; }
    if (!content) return;

    const messageId = msg.message_id; if (!messageId) return;
    const senderId = data.sender.sender_id?.open_id ?? 'unknown';
    const chatId = msg.chat_id;
    const rootId = msg.root_id;

    // Acknowledge
    const mode = this.cfg.operator?.reactionMode ?? 'emoji';
    const ackMsg = this.cfg.messages?.ackReceived || '✅ Received';
    if (mode !== 'card') { try { await this.react(messageId, DEFAULT_EMOJI); } catch { if (mode === 'both') await this.reply(messageId, ackMsg, false); } }
    if (mode === 'card') { try { await this.reply(messageId, ackMsg, false); } catch { /* */ } }

    // Dedup
    try {
      const existing = await this.bitable.searchRecords(this.cfg.turnsTableId, {
        conjunction: 'and', conditions: [{ field_name: this.cfg.fields.turn.dedupKey, operator: 'is', value: [messageId] }],
      });
      if (existing.length > 0) return;
    } catch { /* */ }

    if (rootId) {
      const ticket = await this.session.findByThreadRoot(rootId);
      if (ticket?.record_id) { await this.handleThreadReply(ticket, content, messageId, senderId); return; }
    }

    await this.ensureHumanRoster(senderId);
    const { capability, cleanedContent } = await this.classifyRoles(content);
    try {
      const ticket = await this.session.createTicket(cleanedContent || content, { rootMsgId: messageId, chatId, senderId });
      (ticket as any).__capability = capability;
      await this.bitable.createRecord(this.cfg.turnsTableId, {
        [this.cfg.fields.turn.ticketRecordId]: ticket.record_id, [this.cfg.fields.turn.rootMsgId]: messageId,
        [this.cfg.fields.turn.role]: 'user', [this.cfg.fields.turn.content]: content,
        [this.cfg.fields.turn.dedupKey]: messageId, [this.cfg.fields.turn.agentIdentity]: senderId,
        [this.cfg.fields.turn.createdAt]: Date.now(),
      });
      await this.processDraft(ticket, content, messageId, chatId);
    } catch (err) { logger.error('[operator] failed to create ticket:', err); }
  }

  // -- Thread / Draft / Delivery -------------------------------------------
  private async handleThreadReply(ticket: BitableRecord, content: string, messageId: string, senderId: string) {
    const recordId = ticket.record_id!;
    const status = String(ticket.fields[this.cfg.fields.ticket.status] ?? '');
    const rootMsgId = extractText(ticket.fields[this.cfg.fields.ticket.rootMsgId]);
    await this.bitable.createRecord(this.cfg.turnsTableId, {
      [this.cfg.fields.turn.ticketRecordId]: recordId, [this.cfg.fields.turn.rootMsgId]: rootMsgId,
      [this.cfg.fields.turn.role]: 'user', [this.cfg.fields.turn.content]: content,
      [this.cfg.fields.turn.dedupKey]: messageId, [this.cfg.fields.turn.agentIdentity]: senderId,
      [this.cfg.fields.turn.createdAt]: Date.now(),
    });
    if (status === this.cfg.statuses.draft) { await this.processDraft(ticket, content, messageId, String(ticket.fields[this.cfg.fields.ticket.chatId])); }
    else if (status === this.cfg.statuses.done) { await this.session.promoteToPending(recordId, content); }
    else if (status === this.cfg.statuses.failed) {
      await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
        [this.cfg.fields.ticket.status]: this.cfg.statuses.pending, [this.cfg.fields.ticket.retryCount]: 0,
        [this.cfg.fields.ticket.owner]: '', [this.cfg.fields.ticket.ownerLeaseAt]: 0,
      });
      await this.reply(messageId, this.cfg.messages?.ticketReactivated || 'Ticket reactivated, queued for processing', true);
    }
  }

  private async processDraft(ticket: BitableRecord, content: string, messageId: string, _chatId: string) {
    const classifiedCap = (ticket as any).__capability as string | undefined;
    if (this.cfg.operator?.useLLM) {
      const result = await this.checkCompleteness(ticket);
      if (result?.isComplete) {
        const caps = [...(classifiedCap ? [classifiedCap] : []), ...(result.forRoles || [])];
        await this.session.promoteToPending(ticket.record_id!, result.summary || content, caps.length > 0 ? caps : undefined);
        console.log(`[operator] ticket ${ticket.record_id!.slice(0, 12)} promoted to pending`);
      } else { await this.reply(messageId, this.cfg.messages?.clarifyQuestion || 'Could you please describe the issue in more detail? If you have any relevant order numbers or error messages, please also provide them, and I\'ll help investigate.', true); }
    } else {
      const caps = classifiedCap ? [classifiedCap] : undefined;
      await this.session.promoteToPending(ticket.record_id!, content, caps);
      console.log(`[operator] ticket ${ticket.record_id!.slice(0, 12)} promoted to pending`);
    }
  }

  private async deliverTurns() {
    try {
      const turns = await this.session.searchNotifiableTurns();
      for (const turn of turns) {
        if (!turn.record_id || this.deliveredTurnIds.has(turn.record_id)) continue;
        const claimed = await this.session.claimTurnDelivery(turn.record_id);
        if (!claimed) continue;
        const content = extractText(turn.fields[this.cfg.fields.turn.content]);
        const rootMsgId = extractText(turn.fields[this.cfg.fields.turn.rootMsgId]);
        if (!content || !rootMsgId) continue;
        const human = extractUserIds(turn.fields[this.cfg.fields.turn.human]);
        let finalContent = content;
        if (human) {
          const parts = human.split(',').filter(Boolean);
          const mentions = parts.map(p => p.startsWith('ou_') ? `<at id=${p}></at>` : p).join(' ');
          finalContent = formatMessage(this.cfg.messages?.ccFormat || '{content}\n\ncc {mentions}', { content, mentions });
        }
        try { await this.reply(rootMsgId, finalContent, true); this.deliveredTurnIds.add(turn.record_id); await this.session.markTurnNotified(turn.record_id); } catch { /* */ }
      }
    } catch { /* */ }
    if (this.deliveredTurnIds.size > 10_000) this.deliveredTurnIds.clear();
  }

  private async cleanupStaleDrafts(maxAgeMs: number) {
    try {
      const drafts = await this.bitable.searchRecords(this.cfg.ticketsTableId, {
        conjunction: 'and', conditions: [{ field_name: this.cfg.fields.ticket.status, operator: 'is', value: [this.cfg.statuses.draft] }],
      });
      const cutoff = Date.now() - maxAgeMs;
      for (const d of drafts) {
        const createdAt = Number(d.fields[this.cfg.fields.ticket.createdAt] ?? 0) || Date.now();
        if (createdAt < cutoff) { await this.bitable.updateRecord(this.cfg.ticketsTableId, d.record_id!, { [this.cfg.fields.ticket.status]: this.cfg.statuses.closed }); }
      }
    } catch { /* */ }
  }

  // -- Classify / Completeness / HumanRoster -------------------------------
  private async classifyRoles(content: string): Promise<{ capability?: string; cleanedContent: string }> {
    const method = this.cfg.operator?.rolesMapping ?? 'keyword';
    const cmdMatch = content.match(/^\/([a-z][a-z0-9_]*)\s*(.*)/s);
    if (cmdMatch) return { capability: cmdMatch[1], cleanedContent: cmdMatch[2] || content };
    if (method === 'keyword' && this.cfg.rolesWhitelistTableId) {
      try {
        const whitelist = await this.bitable.searchRecords(this.cfg.rolesWhitelistTableId, {
          conjunction: 'and', conditions: [{ field_name: 'enabled', operator: 'is', value: [true] }],
        });
        const lower = content.toLowerCase(); let bestScore = 0; let bestCap: string | undefined;
        for (const row of whitelist) {
          const cap = extractText(row.fields['role']); const keywords = extractText(row.fields['keywords'] ?? '');
          if (!cap) continue;
          const score = keywords.split(/[,，]/).filter(Boolean).filter(k => lower.includes(k.trim().toLowerCase())).length;
          if (score > bestScore) { bestScore = score; bestCap = cap; }
        }
        if (bestCap) return { capability: bestCap, cleanedContent: content };
        if (whitelist.find(r => extractText(r.fields['role']) === 'general')) return { capability: 'general', cleanedContent: content };
      } catch { /* */ }
    }
    return { cleanedContent: content };
  }

  private async checkCompleteness(ticket: BitableRecord): Promise<CompletenessCheckResult | null> {
    try {
      const turns = await this.session.getTurns(ticket.record_id!);
      const prompt = [COMPLETENESS_PROMPT, '', `Summary: ${String(ticket.fields[this.cfg.fields.ticket.summary] ?? '')}`,
        'Conversation:', ...turns.map(t => `[${t.fields[this.cfg.fields.turn.role]}]\n${t.fields[this.cfg.fields.turn.content]}`)].join('\n');
      const args = this.cfg.operator?.llmArgs ?? this.cfg.claudeArgs;
      return new Promise((resolve) => {
        const proc = spawn(this.cfg.aiCommand, [this.cfg.aiPromptFlag, prompt, ...args], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
        let stdout = '';
        proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.on('close', (code) => {
          if (code !== 0) { resolve(null); return; }
          try { const r = JSON.parse(stdout.trim()); resolve({ isComplete: Boolean(r.isComplete), summary: String(r.summary ?? ''), missingFields: Array.isArray(r.missingFields) ? r.missingFields : [], forRoles: Array.isArray(r.forRoles) ? r.forRoles : [] }); } catch { resolve(null); }
        });
        proc.on('error', () => resolve(null));
      });
    } catch { return null; }
  }

  private async ensureHumanRoster(senderId: string) {
    try {
      const existing = await this.bitable.searchRecords(this.cfg.rosterTableId, {
        conjunction: 'and', conditions: [{ field_name: this.cfg.fields.roster.kind, operator: 'is', value: ['human'] }],
      });
      if (existing.find(r => extractUserIds(r.fields[this.cfg.fields.roster.human]).includes(senderId))) return;
    } catch { /* */ }
    try {
      await this.bitable.createRecord(this.cfg.rosterTableId, {
        [this.cfg.fields.roster.identity]: `human_${senderId}`, [this.cfg.fields.roster.nickname]: `user_${senderId.slice(0, 8)}`,
        [this.cfg.fields.roster.kind]: 'human', [this.cfg.fields.roster.human]: [{ id: senderId }], [this.cfg.fields.roster.enabled]: true,
      });
    } catch { /* */ }
  }

  // -- IM helpers -----------------------------------------------------------
  private async react(messageId: string, emojiType: string) {
    await this.client.im.v1.messageReaction.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: emojiType } } });
  }

  private async reply(messageId: string, text: string, replyInThread?: boolean) {
    if (!text.trim()) return;
    const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: text }] } };
    await this.client.im.v1.message.reply({ path: { message_id: messageId }, data: { msg_type: 'interactive', content: JSON.stringify(card), reply_in_thread: replyInThread } as any });
  }

  private cleanup() {
    if (this.draftCleanupTimer) clearInterval(this.draftCleanupTimer);
    if (this.wsClient) { try { this.wsClient.close({ force: true }); } catch { /* */ } }
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
