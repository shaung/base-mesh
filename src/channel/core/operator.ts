// ---------------------------------------------------------------------------
// CoreOperator — pure message processing logic for Lark IM events.
//
// Deployment-agnostic: receives parsed messages via ParsedMessageEvent,
// processes them through the full lifecycle (ticket → draft → pending → round),
// handles thread replies, intent recognition, turn delivery, and card actions.
//
// Uses SessionAdapter, FeishuAdapter, and BitableAdapter interfaces —
// no dependency on @larksuiteoapi/node-sdk or WebSocket transport.
// ---------------------------------------------------------------------------

import type {
  SessionAdapter,
  FeishuAdapter,
  BitableAdapter,
  TicketRecord,
  TurnRecord,
  ParsedMessageEvent,
  IntentResult,
  CardActionData,
  DomainDescriptor,
  Logger,
} from './types.js';
import type { Config } from '../../lib/types.js';

// =============================================================================
// CoreOperator
// =============================================================================

export class CoreOperator {
  /** Cached domains from Domains table (60s TTL). */
  private cachedDomains: DomainDescriptor[] | null = null;
  /** Dedup for turn delivery. */
  private deliveredTurnIds = new Set<string>();
  /** In-flight delivery dedup. */
  private deliveryInFlight = new Set<string>();

  constructor(
    private session: SessionAdapter,
    private feishu: FeishuAdapter,
    private bitable: BitableAdapter,
    private cfg: Config,
    private log: Logger,
  ) {
    // Invalidate domain cache every 60s
    setTimeout(() => { this.cachedDomains = null; }, 60_000);
  }

  // ===========================================================================
  // Main message entry point
  // ===========================================================================

  /** Process an incoming IM message: parse, create ticket/turn/round. */
  async handleMessage(event: ParsedMessageEvent): Promise<void> {
    const { content, parts, message, sender, appId, botMentioned, domain } = event;
    const messageId = message.message_id;
    const chatId = message.chat_id;
    const rootId = message.root_id;
    const senderId = sender.sender_id?.open_id ?? 'unknown';
    const senderUnionId = sender.sender_id?.union_id;

    if (!content || !messageId) return;

    this.log.info(`[core-operator] message from ${senderId}: ${content.slice(0, 60)} (op=${appId || 'primary'})`);

    // Ensure human roster record exists
    await this.ensureHumanRoster(senderId, senderUnionId);

    // Thread reply path
    if (rootId) {
      await this.handleThreadReply(event);
      return;
    }

    // New conversation — create ticket and turn
    try {
      const dedupKey = appId ? `${appId}:${messageId}` : messageId;

      // Dedup check
      const existing = await this.bitable.searchRecords(this.cfg.turnsTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.cfg.fields.turn.dedupKey, operator: 'is', value: [dedupKey] },
        ],
      });
      if (existing.length > 0) {
        this.log.info(`[core-operator] dedup: ${dedupKey.slice(0, 30)} already processed`);
        return;
      }

      // Create ticket
      const ticket = await this.createTicketDirect(content, messageId, chatId, senderId);

      const recordId = ticket.record_id;
      if (!recordId) return;

      // Create user turn
      const turnFields: Record<string, unknown> = {
        [this.cfg.fields.turn.ticketRecordId]: recordId,
        [this.cfg.fields.turn.rootMsgId]: messageId,
        [this.cfg.fields.turn.role]: 'user',
        [this.cfg.fields.turn.content]: content,
        [this.cfg.fields.turn.dedupKey]: dedupKey,
        [this.cfg.fields.turn.agentIdentity]: senderId,
        [this.cfg.fields.turn.appId]: appId || this.cfg.appId,
        [this.cfg.fields.turn.createdAt]: Date.now(),
      };
      if (parts.length > 0) turnFields[this.cfg.fields.turn.parts] = JSON.stringify(parts);

      await this.bitable.createRecord(this.cfg.turnsTableId, turnFields);

      // Process draft: intent → promote → create round
      await this.processDraft(ticket, content, messageId, chatId, appId, domain);
    } catch (err) {
      this.log.error('[core-operator] failed to handle message:', err);
    }
  }

  /** Fallback ticket creation when SessionAdapter doesn't expose createTicket. */
  private async createTicketDirect(
    _summary: string,
    rootMsgId: string,
    chatId: string,
    senderId: string,
  ): Promise<TicketRecord> {
    return this.bitable.createRecord(this.cfg.ticketsTableId, {
      [this.cfg.fields.ticket.status]: this.cfg.statuses.draft,
      [this.cfg.fields.ticket.summary]: _summary,
      [this.cfg.fields.ticket.rootMsgId]: rootMsgId,
      [this.cfg.fields.ticket.chatId]: chatId,
      [this.cfg.fields.ticket.senderId]: senderId,
      [this.cfg.fields.ticket.createdAt]: Date.now(),
    });
  }

  // ===========================================================================
  // Thread reply handling
  // ===========================================================================

  /** Handle a reply within an existing thread. */
  async handleThreadReply(event: ParsedMessageEvent): Promise<void> {
    const { content, parts, message, sender, appId, botMentioned } = event;
    const messageId = message.message_id;
    const rootId = message.root_id;
    const senderId = sender.sender_id?.open_id ?? 'unknown';
    const chatId = message.chat_id;

    if (!rootId || !messageId || !content) return;

    // Find ticket by thread root
    let ticket: TicketRecord | null = null;
    if (typeof (this.session as any).findByThreadRoot === 'function') {
      ticket = await (this.session as any).findByThreadRoot(rootId);
    }

    if (!ticket || !ticket.record_id) {
      // Fallback: search by chat_id
      const recent = await this.bitable.searchRecords(this.cfg.ticketsTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.cfg.fields.ticket.chatId, operator: 'is', value: [chatId] },
        ],
      });
      recent.sort((a, b) =>
        Number(b.fields[this.cfg.fields.ticket.updatedAt] ?? 0) -
        Number(a.fields[this.cfg.fields.ticket.updatedAt] ?? 0),
      );
      ticket = recent[0] ?? null;
    }

    if (!ticket?.record_id) {
      this.log.info('[core-operator] thread reply: no ticket found for root');
      return;
    }

    const recordId = ticket.record_id;
    const status = String(ticket.fields[this.cfg.fields.ticket.status] ?? '');

    // Create user turn
    const dedupKey = appId ? `${appId}:${messageId}` : messageId;
    const rootMsgId = String(ticket.fields[this.cfg.fields.ticket.rootMsgId] ?? rootId);

    const turnFields: Record<string, unknown> = {
      [this.cfg.fields.turn.ticketRecordId]: recordId,
      [this.cfg.fields.turn.rootMsgId]: rootMsgId,
      [this.cfg.fields.turn.role]: 'user',
      [this.cfg.fields.turn.content]: content,
      [this.cfg.fields.turn.dedupKey]: dedupKey,
      [this.cfg.fields.turn.agentIdentity]: senderId,
      [this.cfg.fields.turn.appId]: appId || this.cfg.appId,
      [this.cfg.fields.turn.createdAt]: Date.now(),
    };
    if (parts.length > 0) turnFields[this.cfg.fields.turn.parts] = JSON.stringify(parts);

    await this.bitable.createRecord(this.cfg.turnsTableId, turnFields);

    // Route based on ticket status
    if (status === this.cfg.statuses.draft && botMentioned) {
      await this.processDraft(ticket, content, messageId, chatId, appId);
      return;
    }

    if (status === this.cfg.statuses.active && botMentioned && this.cfg.roundsTableId) {
      // Handle active ticket with round
      const currentRound = await this.session.getCurrentRound(recordId);
      if (currentRound?.record_id) {
        const roundStatus = String(currentRound.fields[this.cfg.fields.round.status] ?? '');
        const terminal = [this.cfg.roundStatuses.done, this.cfg.roundStatuses.failed, this.cfg.roundStatuses.cancelled];
        const nonPendingActive = [this.cfg.roundStatuses.pendingApproval, this.cfg.roundStatuses.approved, this.cfg.roundStatuses.executing];

        if (roundStatus === this.cfg.roundStatuses.pending) {
          // Cancel pending round, create new one
          await this.session.transitionRound(currentRound.record_id, this.cfg.roundStatuses.cancelled);
          const intent = await this.runIntent(ticket, content, recordId, appId);
          const round = await this.createRound(recordId, intent.domains, appId, content);
          if (round.record_id) await this.assignTurnsToRound(recordId, round.record_id, appId);
        } else if (nonPendingActive.includes(roundStatus)) {
          // Revert active round
          await this.session.transitionRound(currentRound.record_id, this.cfg.roundStatuses.pending);
          await this.session.releaseRound(currentRound.record_id);
          await this.assignTurnsToRound(recordId, currentRound.record_id, appId);
        } else if (terminal.includes(roundStatus)) {
          // Terminal round — create new
          const intent = await this.runIntent(ticket, content, recordId, appId);
          const round = await this.createRound(recordId, intent.domains, appId, content);
          if (round.record_id) await this.assignTurnsToRound(recordId, round.record_id, appId);
        }
      } else {
        const intent = await this.runIntent(ticket, content, recordId, appId);
        const round = await this.createRound(recordId, intent.domains, appId, content);
        if (round.record_id) await this.assignTurnsToRound(recordId, round.record_id, appId);
      }
    }

    if (status === this.cfg.statuses.closed && botMentioned) {
      // Reopen closed ticket
      await this.reopenTicket(recordId);
      const intent = await this.runIntent(ticket, content, recordId, appId);
      const round = await this.createRound(recordId, intent.domains, appId, content);
      if (round.record_id) await this.assignTurnsToRound(recordId, round.record_id, appId);
    }
  }

  // ===========================================================================
  // Draft processing
  // ===========================================================================

  /** Process a draft: intent recognition, promote to pending, create round. */
  async processDraft(
    ticket: TicketRecord,
    content: string,
    _messageId: string,
    _chatId: string,
    appId?: string,
    domain?: string,
  ): Promise<void> {
    let domains: string[] = ['general'];
    let summary = content;

    if (domain) {
      domains = [domain];
      this.log.info(`[core-operator] processDraft domain override: "${domain}"`);
    } else if (this.cfg.intent) {
      const result = await this.runIntent(ticket, content, ticket.record_id!, appId);
      domains = result.domains;
      summary = result.summary || content;
      this.log.info(`[core-operator] intent: domains=${result.domains}`);

      if (!result.isComplete) {
        // Missing fields — ask user for clarification
        const question = result.missingFields.length > 0
          ? `Please provide: ${result.missingFields.join(', ')}`
          : (this.cfg.messages?.clarifyQuestion || 'Could you please provide more details?');
        const rootMsgId = String(ticket.fields[this.cfg.fields.ticket.rootMsgId] ?? '');
        if (rootMsgId) {
          await this.feishu.reply(rootMsgId, question, true);
        }
        return;
      }
    }

    // Promote ticket to pending
    await this.promoteToPending(ticket.record_id!, summary);
    this.log.info(`[core-operator] ticket ${ticket.record_id!} promoted to pending`);

    // Create round
    if (this.cfg.roundsTableId && ticket.record_id) {
      try {
        const round = await this.createRound(ticket.record_id, domains, appId, content);
        this.log.info(`[core-operator] created round ${round.record_id!} for ticket ${ticket.record_id}`);
      } catch (err) {
        this.log.error('[core-operator] createRound failed:', err);
      }
    }
  }

  // ===========================================================================
  // Intent recognition
  // ===========================================================================

  /** Run intent recognition on message content. Returns domains + completeness. */
  async runIntent(
    _ticket: TicketRecord,
    content: string,
    recordId: string,
    _appId?: string,
  ): Promise<IntentResult> {
    // Check for #domain tag first
    const { parseDomainTag } = await import('../../lib/messaging/intent.js');
    const loadedDomains = await this.loadDomains();
    const tagResult = parseDomainTag(content, loadedDomains);
    if (tagResult) {
      this.log.info(`[core-operator] domain tag override: ${tagResult.tag}`);
      return { domains: [tagResult.tag], isComplete: true, summary: tagResult.cleaned, missingFields: [] };
    }

    if (!this.cfg.intent) {
      return { domains: ['general'], isComplete: true, summary: content, missingFields: [] };
    }

    const { processMessage } = await import('../../lib/messaging/intent.js');
    const turns = await this.session.getTurns(recordId);
    const conversation = turns.map(t =>
      `[${t.fields[this.cfg.fields.turn.role]}]\n${t.fields[this.cfg.fields.turn.content]}`,
    ).join('\n');
    const result = await processMessage(content, loadedDomains, conversation, this.cfg.intent);
    this.log.info(`[core-operator] intent: domains=${result.domains} isComplete=${result.isComplete}`);

    return {
      domains: result.domains.length > 0 ? result.domains : ['general'],
      isComplete: result.isComplete,
      summary: result.summary || content,
      missingFields: result.missingFields || [],
    };
  }

  /** Load enabled domains from Domains table (cached 60s). */
  private async loadDomains(): Promise<DomainDescriptor[]> {
    if (this.cachedDomains) return this.cachedDomains;
    if (!this.cfg.domainsTableId) return [];
    try {
      const records = await this.bitable.searchRecords(this.cfg.domainsTableId, {
        conjunction: 'and',
        conditions: [{ field_name: 'enabled', operator: 'is', value: [true] }],
      });
      const domains: DomainDescriptor[] = records
        .map(r => ({
          domain: String(r.fields['domain'] ?? r.fields['capability'] ?? ''),
          description: String(r.fields['description'] ?? ''),
        }))
        .filter(d => d.domain.length > 0);
      this.cachedDomains = domains;
      setTimeout(() => { this.cachedDomains = null; }, 60_000);
      return domains;
    } catch {
      return [];
    }
  }

  // ===========================================================================
  // Turn delivery
  // ===========================================================================

  /** Poll for notifiable turns and deliver via IM. */
  async deliverTurns(): Promise<void> {
    try {
      const turns = await this.searchNotifiableTurns();
      if (turns.length === 0) return;

      this.log.info(`[core-operator] deliverTurns: ${turns.length} turns to deliver`);
      for (const turn of turns) {
        const turnRecordId = turn.record_id;
        if (!turnRecordId) continue;
        if (this.deliveredTurnIds.has(turnRecordId)) continue;

        const content = String(turn.fields[this.cfg.fields.turn.content] ?? '');
        const rootMsgId = String(turn.fields[this.cfg.fields.turn.rootMsgId] ?? '');

        if (!content || !rootMsgId) {
          this.log.info(`[core-operator] skip turn ${turnRecordId} (missing content/rootMsgId)`);
          continue;
        }

        try {
          await this.feishu.reply(rootMsgId, content, true);
          this.deliveredTurnIds.add(turnRecordId);
          await this.markTurnNotified(turnRecordId);
          this.log.info(`[core-operator] delivered turn ${turnRecordId}`);
        } catch (err) {
          this.log.error(`[core-operator] deliver turn failed ${turnRecordId}:`, err);
        }
      }
    } catch (err) {
      this.log.error('[core-operator] deliverTurns error:', err);
    }
  }

  // ===========================================================================
  // Approval cards
  // ===========================================================================

  /** Poll pending_approval Rounds and send approval cards via IM. */
  async deliverApprovalCards(): Promise<void> {
    if (!this.cfg.roundsTableId) return;
    try {
      const rounds = await this.session.searchRoundsByStatus(this.cfg.roundStatuses.pendingApproval);
      for (const round of rounds) {
        if (!round.record_id) continue;
        const ticketId = String(round.fields[this.cfg.fields.round.ticketRecordId] ?? '');
        if (!ticketId) continue;
        const ticket = await this.session.getTicket(ticketId);
        if (!ticket) continue;

        const rootMsgId = String(ticket.fields[this.cfg.fields.ticket.rootMsgId] ?? '');
        const summary = String(ticket.fields[this.cfg.fields.ticket.summary] ?? '');
        if (!rootMsgId) continue;

        // Send approval card
        const cardDedupKey = `approval_card_${round.record_id}`;
        const card = {
          schema: '2.0',
          body: {
            elements: [
              { tag: 'markdown', content: `⏳ **Approval Required**\n${summary}` },
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
          // Send via Lark reply
          await this.feishu.reply(rootMsgId, JSON.stringify(card), true);
          // Record the card was sent
          await this.bitable.createRecord(this.cfg.turnsTableId, {
            [this.cfg.fields.turn.ticketRecordId]: ticketId,
            [this.cfg.fields.turn.rootMsgId]: rootMsgId,
            [this.cfg.fields.turn.role]: 'system',
            [this.cfg.fields.turn.content]: `Approval card sent for round ${round.record_id}`,
            [this.cfg.fields.turn.dedupKey]: cardDedupKey,
            [this.cfg.fields.turn.createdAt]: Date.now(),
          });
          this.log.info(`[core-operator] approval card sent for round ${round.record_id}`);
        } catch (err) {
          this.log.error(`[core-operator] approval card failed for round ${round.record_id!}:`, err);
        }
      }
    } catch (err) {
      this.log.error('[core-operator] deliverApprovalCards error:', err);
    }
  }

  /** Handle card action callback (approve/reject). */
  async handleCardAction(data: CardActionData): Promise<void> {
    const { round_id: roundId, action } = data;
    if (!roundId || !action) return;

    this.log.info(`[core-operator] card action: ${action} round=${roundId}`);
    try {
      if (action === 'approve') {
        await this.session.transitionRound(roundId, this.cfg.roundStatuses.approved);
      } else if (action === 'reject') {
        await this.session.transitionRound(roundId, this.cfg.roundStatuses.rejected);
      }
    } catch (err) {
      this.log.error(`[core-operator] card action failed round=${roundId}:`, err);
    }
  }

  /** Handle /cancel command — cancel active round. */
  async handleCancel(senderId: string, messageId: string, appId?: string): Promise<void> {
    try {
      const tickets = await this.session.searchTicketsBySender(senderId);
      const activeTickets = tickets.filter(t => {
        const status = String(t.fields[this.cfg.fields.ticket.status] ?? '');
        return status !== this.cfg.statuses.closed;
      });
      if (activeTickets.length === 0) {
        await this.feishu.reply(messageId, 'No active ticket found to cancel.', true);
        return;
      }
      const ticket = activeTickets[activeTickets.length - 1];
      const round = await this.session.getCurrentRound(ticket.record_id!);
      if (round?.record_id) {
        const ok = await this.session.transitionRound(round.record_id, this.cfg.roundStatuses.cancelled);
        if (ok) {
          await this.feishu.reply(messageId, '✅ Processing cancelled.', true);
          this.log.info(`[core-operator] cancelled round ${round.record_id} for ticket ${ticket.record_id!}`);
        } else {
          await this.feishu.reply(messageId, 'Could not cancel — round may have already completed.', true);
        }
      } else {
        await this.feishu.reply(messageId, 'No active processing round to cancel.', true);
      }
    } catch (err) {
      this.log.error('[core-operator] handleCancel error:', err);
      await this.feishu.reply(messageId, 'Error processing cancel command.', true);
    }
  }

  // ===========================================================================
  // Internal helpers
  // ===========================================================================

  /** Ensure a human Roster record exists. */
  private async ensureHumanRoster(senderId: string, unionId?: string): Promise<void> {
    const primaryId = unionId || senderId;
    try {
      const existing = await this.session.searchRoster({
        conjunction: 'and',
        conditions: [
          { field_name: this.cfg.fields.roster.kind, operator: 'is', value: ['human'] },
        ],
      });
      const found = existing.some(r => {
        const f = r.fields[this.cfg.fields.roster.human];
        if (!f) return false;
        const ids = String(f);
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
      await this.bitable.createRecord(this.cfg.rosterTableId, fields);
      this.log.info(`[core-operator] created human roster: ${identity}`);
    } catch (err) {
      this.log.info('[core-operator] ensureHumanRoster failed:', err);
    }
  }

  /** Promote a draft ticket to pending. */
  private async promoteToPending(recordId: string, summary: string): Promise<void> {
    try {
      await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
        [this.cfg.fields.ticket.status]: this.cfg.statuses.active,
        [this.cfg.fields.ticket.summary]: summary,
      });
    } catch { /* */ }
  }

  /** Create a round for a ticket. */
  private async createRound(
    ticketRecordId: string,
    domains?: string[],
    appId?: string,
    input?: string,
  ): Promise<TicketRecord> {
    const fields: Record<string, unknown> = {
      [this.cfg.fields.round.ticketRecordId]: ticketRecordId,
      [this.cfg.fields.round.status]: this.cfg.roundStatuses.pending,
      [this.cfg.fields.round.createdAt]: Date.now(),
      [this.cfg.fields.round.updatedAt]: Date.now(),
    };
    if (domains && domains.length > 0) {
      fields[this.cfg.fields.round.domains] = JSON.stringify(domains);
    }
    if (appId) fields[this.cfg.fields.round.appId] = appId;
    if (input) fields[this.cfg.fields.round.input] = input;

    return this.bitable.createRecord(this.cfg.roundsTableId!, fields);
  }

  /** Assign turns to a round (update turn records with round_id). */
  private async assignTurnsToRound(ticketRecordId: string, roundId: string, appId?: string): Promise<void> {
    try {
      const turns = await this.bitable.searchRecords(this.cfg.turnsTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.cfg.fields.turn.ticketRecordId, operator: 'is', value: [ticketRecordId] },
        ],
      });
      for (const turn of turns) {
        if (!turn.record_id) continue;
        const currentRoundId = String(turn.fields[this.cfg.fields.turn.roundId] ?? '');
        if (currentRoundId) continue; // already assigned
        const turnAppId = String(turn.fields[this.cfg.fields.turn.appId] ?? '');
        if (appId && turnAppId && turnAppId !== appId) continue; // wrong operator
        await this.bitable.updateRecord(this.cfg.turnsTableId, turn.record_id, {
          [this.cfg.fields.turn.roundId]: roundId,
        });
      }
    } catch { /* */ }
  }

  /** Reopen a closed ticket. */
  private async reopenTicket(recordId: string): Promise<void> {
    try {
      await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
        [this.cfg.fields.ticket.status]: this.cfg.statuses.active,
        [this.cfg.fields.ticket.retryCount]: 0,
        [this.cfg.fields.ticket.owner]: '',
        [this.cfg.fields.ticket.ownerLeaseAt]: 0,
      });
    } catch { /* */ }
  }

  /** Search for turns that need IM delivery. */
  private async searchNotifiableTurns(): Promise<TurnRecord[]> {
    try {
      const records = await this.bitable.searchRecords(this.cfg.turnsTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.cfg.fields.turn.notified, operator: 'is', value: [0] },
          { field_name: this.cfg.fields.turn.role, operator: 'is', value: ['agent'] },
        ],
      });
      return records;
    } catch {
      return [];
    }
  }

  /** Mark a turn as notified (delivered via IM). */
  private async markTurnNotified(turnRecordId: string): Promise<void> {
    try {
      await this.bitable.updateRecord(this.cfg.turnsTableId, turnRecordId, {
        [this.cfg.fields.turn.notified]: 1,
      });
    } catch { /* */ }
  }
}
