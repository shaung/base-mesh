import { logger } from './log.js';
// Coordinator — push mode central node. Manages executor registration,
// routes tasks, proxies Bitable writes, sends one-time IM notifications.
// In Round-driven mode (cfg.roundsTableId), also drives the Round state machine.

import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Client } from '@larksuiteoapi/node-sdk';
import { Config, BitableRecord, Part, RoundStatusMapping } from './types.js';
import { BitableClient } from './bitable.js';
import { Session } from './protocol.js';
import { extractText, extractUserIds } from './text.js';
import { createSession, validateSession } from './sessions.js';
import { getDomainConfig } from './domain.js';
import { formatMessage } from './messages.js';
import { routeA2ARequest, verifyA2AAuth } from './a2a.js';

interface PushExecutor { ws: WebSocket; identity: string; domains: string[]; activeTicketId?: string; lastHeartbeat: number; }

export class Coordinator {
  private wss: WebSocketServer | null = null;
  private executors = new Map<string, PushExecutor>();
  private bitable: BitableClient;
  private session: Session;
  private client: Client;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private roundPollTimer: ReturnType<typeof setInterval> | null = null;
  private inflightRounds = new Map<string, Promise<void>>();
  /** Streaming card state per ticket (cardId + sequence). */
  private streamingCards = new Map<string, { cardId: string; seq: number }>();
  /** Buffered content for cards being created (key → pending updates). */
  private streamBuffer = new Map<string, Array<{ content: string; type: string }>>();
  /** Accumulated thinking content per card key (for final result update). */
  private streamThinkingAccumulated = new Map<string, string>();
  /** Accumulated answer content per card key (for final result update). */
  private streamAnswerAccumulated = new Map<string, string>();
  constructor(private cfg: Config) {
    this.bitable = new BitableClient(cfg);
    this.session = new Session('channel', 'Channel', cfg, this.bitable);
    const dc = getDomainConfig(cfg.openApiDomain);
    this.client = new Client({ appId: cfg.appId, appSecret: cfg.appSecret || 'unused', domain: dc.sdkBaseUrl, loggerLevel: 2 });
  }

  private running = true;

  start() {
    const port = this.cfg.coordinator?.port || 0;
    if (!port) { console.log('[coordinator] port not configured, skipping'); return; }

    const fileProxyEnabled = this.cfg.coordinator?.fileProxyEnabled !== false;
    const a2aEnabled = this.cfg.coordinator?.a2a?.enabled === true;
    const server = createServer(async (req, res) => {
      // A2A protocol endpoints
      if (a2aEnabled && (req.url?.startsWith('/a2a/') || req.url === '/.well-known/agent.json')) {
        if (!verifyA2AAuth(req, this.cfg)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const handled = await routeA2ARequest(req, res, this.session, this.cfg);
        if (handled) return;
      }
      if (fileProxyEnabled && req.url?.startsWith('/files/') && req.method === 'GET') {
        await this.handleFileProxy(req, res);
      } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else if (!a2aEnabled || (!req.url?.startsWith('/a2a/') && req.url !== '/.well-known/agent.json')) {
        res.writeHead(404); res.end();
      }
    });
    this.wss = new WebSocketServer({ server });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    server.listen(port, () => console.log(`[coordinator] listening on :${port}`));

    const interval = (this.cfg.coordinator?.heartbeatSeconds ?? 60) * 1000;
    this.heartbeatTimer = setInterval(() => this.heartbeatAll(), interval);

    // Start Round state machine if Round table is configured
    this.startRoundCoordination();
  }

  stop() {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.roundPollTimer) clearInterval(this.roundPollTimer);
    this.wss?.close();
    for (const [, ex] of this.executors) { try { ex.ws.close(); } catch { /* */ } }
  }

  // -- Push executor connection ---------------------------------------------
  private async handleConnection(ws: WebSocket, _req: any) {
    let identity = ""; let domains: string[] = [];

    ws.on('message', async (raw) => {
      const text = raw.toString().trim();
      if (text === 'ping') return; // executor heartbeat
      try {
        const msg = JSON.parse(text) as Record<string, unknown>;
        const type = msg.type as string;

        if (type === 'auth') {
          identity = msg.identity as string || '';
          console.log(`[coordinator] auth requested for ${identity}, sending app credentials`);
          ws.send(JSON.stringify({
            type: 'auth_required',
            appId: this.cfg.appId,
            openApiDomain: this.cfg.openApiDomain || 'open.feishu.cn',
          }));
          return;
        }

        if (type === 'auth_token') {
          const token = msg.token as string;
          identity = msg.identity as string || '';
          domains = Array.isArray(msg.domains) ? msg.domains as string[] : [];
          if (!token) { ws.send(JSON.stringify({ type: 'error', message: 'token required' })); ws.close(); return; }
          let valid = false;
          try {
            const resp = await fetch(`https://${this.cfg.openApiDomain || 'open.feishu.cn'}/open-apis/authen/v1/user_info`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            valid = ((await resp.json()) as any).code === 0;
          } catch { /* invalid */ }
          if (!valid) { ws.send(JSON.stringify({ type: 'error', message: 'auth failed' })); ws.close(); return; }
          const sessionToken = createSession(identity, domains, this.cfg.coordinator?.sessionTTLDays ?? 30, this.cfg.appSecret || 'default-secret');
          this.executors.set(identity, { ws, identity, domains, lastHeartbeat: Date.now() });
          try {
            await this.upsertRoster(identity, domains, msg);
            console.log(`[coordinator] roster upserted for ${identity}`);
          } catch (err: any) {
            logger.error(`[coordinator] roster upsert failed: ${err.message}`, err);
          }
          console.log(`[coordinator] push executor connected: ${identity} domains=[${domains}]`);
          ws.send(JSON.stringify({ type: 'auth_ok', session_token: sessionToken }));
          this.tryAssignPendingToExecutor(identity, domains).catch(() => {});
          return;
        }

        if (type === 'reauth') {
          const entry = validateSession(msg.session_token as string, this.cfg.appSecret || 'default-secret');
          if (!entry) { ws.send(JSON.stringify({ type: 'error', message: 'session expired' })); ws.close(); return; }
          identity = entry.identity;
          domains = Array.isArray(msg.domains) ? msg.domains as string[] : (entry.domains || []);
          this.executors.set(identity, { ws, identity, domains, lastHeartbeat: Date.now() });
          try {
            await this.upsertRoster(identity, domains, msg);
            console.log(`[coordinator] roster upserted (reauth) for ${identity}`);
          } catch (err: any) {
            logger.error(`[coordinator] roster upsert failed: ${err.message}`, err);
          }
          ws.send(JSON.stringify({ type: 'reauth_ok' }));
          return;
        }

        // ── Streaming output ──────────────────────────────────
        if (type === 'stream_update' && this.cfg.coordinator?.streamOutput) {
          const ticketId = msg.ticket_id as string;
          const roundId = msg.round_id as string || '';
          const cardKey = roundId || ticketId;
          const content = msg.content as string || '';
          const rootMsgId = msg.root_msg_id as string;
          const contentType = msg.content_type as string || 'message';
          if (!this.streamingCards.has(cardKey) && rootMsgId) {
            // Buffer content and set placeholder so stream_end can find us
            const buf = this.streamBuffer.get(cardKey) || [];
            buf.push({ content, type: contentType });
            this.streamBuffer.set(cardKey, buf);
            if (buf.length > 1) return;
            this.streamingCards.set(cardKey, { cardId: '', seq: 0 });
            try {
              const cardSpec = {
                schema: '2.0',
                config: { streaming_mode: true, summary: { content: '[Generating...]' }, streaming_config: { print_frequency_ms: { default: 70 }, print_step: { default: 1 }, print_strategy: 'fast' } },
                body: { elements: [
                  { tag: 'markdown', element_id: 'stream_thinking', content: '', text_size: 'text_size_note' },
                  { tag: 'markdown', element_id: 'stream_answer', content: '...' },
                  { tag: 'markdown', element_id: 'stream_stats', content: '', text_size: 'body' },
                ] },
              };
              const cardResp = await this.client.cardkit.v1.card.create({ data: { type: 'card_json', data: JSON.stringify(cardSpec) } }) as any;
              const cardId = cardResp?.data?.card_id;
              if (!cardId) { this.streamingCards.delete(cardKey); this.streamBuffer.delete(cardKey); return; }
              const sendResp = await this.client.im.v1.message.reply({ path: { message_id: rootMsgId }, data: { msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: cardId } }), reply_in_thread: true } as any }) as any;
              if (!sendResp?.data?.message_id) { this.streamingCards.delete(cardKey); this.streamBuffer.delete(cardKey); return; }
              // Update placeholder with real cardId
              const st = this.streamingCards.get(cardKey);
              if (st) st.cardId = cardId;
              console.log(`[coordinator] stream: created card ${cardId} for ${roundId ? `round ${roundId}` : `ticket ${ticketId}`}`);
              // Flush buffered content to respective elements
              const pending = this.streamBuffer.get(cardKey) || [];
              this.streamBuffer.delete(cardKey);
              let thinkingFull = '';
              let answerFull = '';
              for (const chunk of pending) {
                if (chunk.type === 'thinking') {
                  const sep = thinkingFull ? '\n' : '';
                  thinkingFull += sep + '> ' + chunk.content.replace(/\n/g, '\n> ');
                } else {
                  const sep = answerFull ? '\n' : '';
                  answerFull += sep + chunk.content;
                }
              }
              const st2 = this.streamingCards.get(cardKey);
              if (thinkingFull && st2) {
                st2.seq++;
                try { await this.client.cardkit.v1.cardElement.content({ path: { card_id: cardId, element_id: 'stream_thinking' }, data: { content: thinkingFull, sequence: st2.seq, uuid: `t_${cardId}_${st2.seq}` } }); } catch {}
              }
              if (answerFull && st2) {
                st2.seq++;
                try { await this.client.cardkit.v1.cardElement.content({ path: { card_id: cardId, element_id: 'stream_answer' }, data: { content: answerFull, sequence: st2.seq, uuid: `a_${cardId}_${st2.seq}` } }); } catch {}
              }
              this.streamThinkingAccumulated.set(cardKey, thinkingFull);
              this.streamAnswerAccumulated.set(cardKey, answerFull);
            } catch { this.streamBuffer.delete(cardKey); return; }
            return;
          }
          const s = this.streamingCards.get(cardKey);
          if (s) {
            if (contentType === 'thinking') {
              const display = '> ' + content.replace(/\n/g, '\n> ');
              const prev = this.streamThinkingAccumulated.get(cardKey) || '';
              const sep = prev && !prev.endsWith('\n') ? '\n' : '';
              const full = prev + sep + display;
              this.streamThinkingAccumulated.set(cardKey, full);
              s.seq++;
              try { await this.client.cardkit.v1.cardElement.content({ path: { card_id: s.cardId, element_id: 'stream_thinking' }, data: { content: full, sequence: s.seq, uuid: `st_${s.cardId}_${s.seq}` } }); } catch {}
            } else {
              const prev = this.streamAnswerAccumulated.get(cardKey) || '';
              const sep = prev && !prev.endsWith('\n') ? '\n' : '';
              const full = prev + sep + content;
              this.streamAnswerAccumulated.set(cardKey, full);
              s.seq++;
              try { await this.client.cardkit.v1.cardElement.content({ path: { card_id: s.cardId, element_id: 'stream_answer' }, data: { content: full, sequence: s.seq, uuid: `sa_${s.cardId}_${s.seq}` } }); } catch {}
            }
          }
          return;
        }

        if (type === 'stream_end' && this.cfg.coordinator?.streamOutput) {
          const ticketId = msg.ticket_id as string;
          const roundId = msg.round_id as string || '';
          const cardKey = roundId || ticketId;
          const content = msg.content as string || '';
          const durationMs = msg.duration_ms as number | undefined;
          const tokenUsage = msg.token_usage as { input?: number; output?: number } | undefined;
          const s = this.streamingCards.get(cardKey);
          if (s && !s.cardId && this.streamBuffer.has(cardKey)) {
            // Card creation still in progress — add end content to buffer
            this.streamBuffer.get(cardKey)!.push({ content, type: 'message' });
            return;
          }
          if (s && s.cardId) {
            // Finalize both elements, then close streaming mode.
            const thinkingContent = this.streamThinkingAccumulated.get(cardKey) || '';
            const answerContent = this.streamAnswerAccumulated.get(cardKey) || content;
            if (thinkingContent) {
              s.seq++;
              try { await this.client.cardkit.v1.cardElement.content({ path: { card_id: s.cardId, element_id: 'stream_thinking' }, data: { content: thinkingContent, sequence: s.seq, uuid: `ft_${s.cardId}_${s.seq}` } }); } catch { /* best-effort */ }
            }
            if (answerContent) {
              s.seq++;
              try { await this.client.cardkit.v1.cardElement.content({ path: { card_id: s.cardId, element_id: 'stream_answer' }, data: { content: answerContent, sequence: s.seq, uuid: `fa_${s.cardId}_${s.seq}` } }); } catch { /* best-effort */ }
            }
            // Append stats line (token usage + duration) in a separate element
            const statsParts: string[] = [];
            if (tokenUsage) {
              const total = (tokenUsage.input || 0) + (tokenUsage.output || 0);
              if (total > 0) statsParts.push(`⚡ ${total.toLocaleString()} tokens`);
            }
            if (durationMs && durationMs > 100) {
              statsParts.push(`${(durationMs / 1000).toFixed(1)}s`);
            }
            if (statsParts.length > 0) {
              s.seq++;
              const statsText = `— *${statsParts.join(' · ')}* —`;
              try { await this.client.cardkit.v1.cardElement.content({ path: { card_id: s.cardId, element_id: 'stream_stats' }, data: { content: statsText, sequence: s.seq, uuid: `ss_${s.cardId}_${s.seq}` } }); } catch { /* best-effort */ }
            }
            try {
              const settingsData = {
                path: { card_id: s.cardId },
                data: {
                  settings: JSON.stringify({
                    config: { streaming_mode: false, summary: { content: (answerContent || thinkingContent).slice(0, 50) || '[Done]' } },
                  }),
                  sequence: ++s.seq,
                  uuid: `c_${s.cardId}_${s.seq}`,
                },
              };
              await this.client.cardkit.v1.card.settings(settingsData);
            } catch { /* best-effort */ }
            this.streamingCards.delete(cardKey);
            this.streamThinkingAccumulated.delete(cardKey);
            this.streamAnswerAccumulated.delete(cardKey);
          }
          this.streamBuffer.delete(cardKey);
          // Fall through to type: 'result' for Bitable writes
        }

        if (type === 'result') {
          const ticketId = msg.ticket_id as string;
          const roundId = msg.round_id as string | undefined;
          const answer = msg.answer as string || '';
          const rootMsgId = msg.root_msg_id as string || '';
          const reassignTo = msg.reassignTo as { roles?: string[]; kind?: string } | undefined;
          const parts = Array.isArray(msg.parts) ? msg.parts as Part[] : undefined;

          console.log(`[coordinator] result from ${identity} ticket=${ticketId} answer=${answer.slice(0, 60)}${parts ? ` parts=${parts.length}` : ''}`);
          console.log(`[coordinator] writing agent turn for ticket=${ticketId}`);
          try {
            const turnId = await this.session.appendTurn(ticketId, 'agent', answer, `${ticketId}_${Date.now()}`, identity, 'answered', rootMsgId, roundId, parts, 1);
            console.log(`[coordinator] agent turn written ticket=${ticketId} turnId=${turnId}`);
            if (answer && rootMsgId && !msg.streamed) {
              try {
                await this.notifyIM(rootMsgId, answer);
              } catch (imErr) {
                logger.error(`[coordinator] direct IM delivery failed ticket=${ticketId}:`, imErr instanceof Error ? imErr.message : imErr);
                if (turnId) try { await this.bitable.updateRecord(this.cfg.turnsTableId, turnId, { [this.cfg.fields.turn.notified]: 0 }); } catch { /* */ }
              }
            }
          } catch (err: any) {
            logger.error(`[coordinator] appendTurn failed: ${err.message}`, err);
          }

          // Record lastOwner as push executor identity for future affinity routing
          try {
            await this.bitable.updateRecord(this.cfg.ticketsTableId, ticketId, {
              [this.cfg.fields.ticket.lastOwner]: identity,
            });
          } catch { /* best effort */ }

          // V0.0.2: Update ticket status FIRST, then Round, to prevent race:
          // a delayed ticket event arriving after Round→done but before
          // ticket→done would see pending and create a duplicate Round.
          const needsReassign = reassignTo && reassignTo.roles && reassignTo.roles.length > 0;
          if (needsReassign) {
            console.log(`[coordinator] reassigning ticket=${ticketId} to roles=${reassignTo!.roles}`);
            await this.session.release(ticketId, this.cfg.statuses.active);
          } else {
            console.log(`[coordinator] writeResult ticket=${ticketId}`);
            try {
              await this.session.writeResult(ticketId, answer, (msg.newSummary as string) || '');
              console.log(`[coordinator] writeResult done ticket=${ticketId}`);
            } catch (err: any) {
              logger.error(`[coordinator] writeResult failed: ${err.message}`, err);
            }
          }

          // Update Round status AFTER ticket status to close the gap
          if (roundId && this.cfg.roundsTableId) {
            try {
              await this.session.setRoundResult(roundId, answer);
              if (needsReassign) {
                await this.session.transitionRound(roundId, this.cfg.roundStatuses.pending);
              } else {
                // Only transition executing→done. If round is still pending
                // (no executor claimed it, or was reverted by recovery), the
                // result is stale — skip the done transition.
                const currentRound = await this.session.getRound(roundId);
                const rStatus = String(currentRound?.fields?.[this.cfg.fields.round.status] ?? '');
                if (rStatus === this.cfg.roundStatuses.executing) {
                  await this.session.transitionRound(roundId, this.cfg.roundStatuses.done);
                }
              }
            } catch (err: any) {
              logger.error(`[coordinator] round result update failed: ${err.message}`, err);
            }
        }

          // Remove OneSecond emoji from the latest user turn
          try {
            const resultTurns = await this.session.getTurns(ticketId);
            const latestId = latestTurnMessageId(resultTurns, this.cfg.fields.turn.role, this.cfg.fields.turn.dedupKey);
            if (latestId) await this.removeReaction(latestId, 'OneSecond');
          } catch { /* */ }

          const ex = this.executors.get(identity);
          if (ex) ex.activeTicketId = undefined;
          ws.send(JSON.stringify({ type: 'ack' }));
          return;
        }
      } catch (err) { logger.error('[coordinator] message error:', err); }
    });

    ws.on('close', () => console.log(`[coordinator] push executor disconnected: ${identity}`));
    ws.on('error', () => { /* */ });
  }

  // -- Task routing ---------------------------------------------------------
  async tryRoute(ticket: BitableRecord): Promise<boolean> {
    const recordId = ticket.record_id; if (!recordId) { console.log('[coordinator] tryRoute: no record_id'); return false; }
    const status = String(ticket.fields[this.cfg.fields.ticket.status] ?? '');
    console.log(`[coordinator] tryRoute ticket=${recordId.slice(0,12)} status=${status} roundMode=${!!this.cfg.roundsTableId} executors=${this.executors.size}`);

    // In Round-driven mode, tryRoute NEVER creates Rounds. Rounds are created
    // by handleThreadReply (Channel). The Round creation event drives processing
    // via processRound. tryRoute only nudges existing active Rounds.
    if (this.cfg.roundsTableId) {
      const currentRound = await this.session.getCurrentRound(recordId);
      console.log(`[coordinator] tryRoute roundMode: currentRound=${currentRound?.record_id?.slice(0,12) || 'none'}`);
      if (currentRound) {
        await this.processRound(currentRound.record_id!);
      }
      return true;
    }
    // Non-round path (legacy): use empty domains, match any executor
    console.log(`[coordinator] tryRoute legacy (no round mode) executorCount=${this.executors.size}`);

    const rawLastOwner = String(ticket.fields[this.cfg.fields.ticket.lastOwner] ?? '');
    const lastOwnerIdentity = rawLastOwner.includes('#') ? rawLastOwner.split('#').pop()! : rawLastOwner;
    if (lastOwnerIdentity) {
      const ex = this.executors.get(lastOwnerIdentity);
      if (ex && !ex.activeTicketId) {
        const won = await this.session.claim(ticket);
        if (won) {
          await this.dispatchTask(ex, ticket, recordId);
          return true;
        }
      }
    }
    for (const [, ex] of this.executors) {
      if (ex.activeTicketId) continue;
      if (ex.identity === lastOwnerIdentity) continue;
      const won = await this.session.claim(ticket);
      if (!won) continue;
      await this.dispatchTask(ex, ticket, recordId);
      return true;
    }
    return false;
  }

  /** Send task to a push executor over WebSocket and notify via IM. */
  private async dispatchTask(ex: PushExecutor, ticket: BitableRecord, recordId: string): Promise<void> {
    ex.activeTicketId = recordId;
    const turns = await this.session.getTurns(recordId);
    ex.ws.send(JSON.stringify({
      type: 'task', ticket: { record_id: recordId, fields: ticket.fields },
      turns: turns.map(t => ({ record_id: t.record_id, fields: t.fields })),
      globalPrompt: this.cfg.coordinator?.globalPrompt || '',
      stream_output: this.cfg.coordinator?.streamOutput === true,
      stream_thinking: this.cfg.coordinator?.streamThinking === true,
    }));

    // React to the latest user turn message, not the thread root
    const latestMsgId = latestTurnMessageId(turns, this.cfg.fields.turn.role, this.cfg.fields.turn.dedupKey);
    if (latestMsgId) {
      try { await this.removeReaction(latestMsgId, 'OneSecond'); } catch { /* */ }
      try { await this.reactToMessage(latestMsgId, 'OnIt'); } catch { /* */ }
}
    console.log(`[coordinator] ticket ${recordId} assigned to ${ex.identity}`);
  }

  canHandle(_ticket: BitableRecord): boolean {
    for (const [, ex] of this.executors) {
      if (ex.activeTicketId) continue;
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Round state machine (Round-driven mode only)
  // ---------------------------------------------------------------------------

  /** Process a single Round by record_id (called from Bitable event). */
  async processRound(roundId: string): Promise<void> {
    if (!this.cfg.roundsTableId) return;
    // Dedup concurrent calls: if another processRound is already running for this
    // round, wait for it to finish and skip. Prevents double-dispatch from ticket
    // event + round creation event both reading 'pending' via eventual consistency.
    const existing = this.inflightRounds.get(roundId);
    if (existing) {
      await existing;
      return;
    }
    const promise = this.executeProcessRound(roundId);
    this.inflightRounds.set(roundId, promise);
    try {
      await promise;
    } finally {
      this.inflightRounds.delete(roundId);
    }
  }

  private async executeProcessRound(roundId: string): Promise<void> {
    const round = await this.session.getRound(roundId);
    if (!round) return;
    const status = String(round.fields[this.cfg.fields.round.status] ?? '');
    switch (status) {
      case this.cfg.roundStatuses.pending:
        await this.processPendingRound(round); break;
      case this.cfg.roundStatuses.pendingApproval:
        await this.processPendingApprovalRound(round); break;
      case this.cfg.roundStatuses.approved:
        await this.processApprovedRound(round); break;
      case this.cfg.roundStatuses.executing:
        await this.processStuckRound(round); break;
    }
  }

  /** Start polling loop for Round state machine. No-op if round mode not active. */
  private startRoundCoordination(): void {
    if (!this.cfg.roundsTableId) {
      console.log('[coordinator] round mode not enabled (no roundsTableId)');
      return;
    }
    console.log('[coordinator] round state machine started');
    const interval = (this.cfg.coordinator?.pollIntervalSeconds ?? 10) * 1000;
    this.roundPollTimer = setInterval(() => {
      this.roundCoordinationCycle().catch((err) =>
        logger.error('[coordinator] round cycle error:', err),
      );
    }, interval);
    // Trigger first cycle immediately
    this.roundCoordinationCycle().catch((err) =>
      logger.error('[coordinator] round cycle error:', err),
    );
  }

  /** Main Round coordination cycle: process Rounds in each state. */
  private async roundCoordinationCycle(): Promise<void> {
    if (!this.cfg.roundsTableId || !this.running) return;

    try {
      // 1. Stuck round detection (executing with expired lease)
      const stuckTimeout = (this.cfg.coordinator?.heartbeatSeconds ?? 60) * 2000;
      const stuck = await this.session.searchStuckRounds(stuckTimeout);
      for (const r of stuck) {
        await this.processStuckRound(r);
      }

      // 2. Process pending Rounds → HITL decision
      const pending = await this.session.searchRoundsByStatus(this.cfg.roundStatuses.pending);
      for (const r of pending) {
        await this.processPendingRound(r);
      }

      // 3. Process pending_approval Rounds → check for timeout override
      const pendingApproval = await this.session.searchRoundsByStatus(this.cfg.roundStatuses.pendingApproval);
      for (const r of pendingApproval) {
        await this.processPendingApprovalRound(r);
      }

      // 4. Process approved Rounds → assign executor
      const approved = await this.session.searchRoundsByStatus(this.cfg.roundStatuses.approved);
      for (const r of approved) {
        await this.processApprovedRound(r);
      }
    } catch (err) {
      logger.error('[coordinator] roundCoordinationCycle error:', err);
    }
  }

  /** Process a pending Round: decide HITL vs direct execution. */
  private async processPendingRound(round: BitableRecord): Promise<void> {
    const roundId = round.record_id;
    if (!roundId) return;

    // Get parent ticket for role context
    const ticketId = String(round.fields[this.cfg.fields.round.ticketRecordId] ?? '');
    if (!ticketId) return;
    const ticket = await this.session.getTicket(ticketId);
    if (!ticket) return;

    // Read required domains from Round
    const domains = parseDomains(round.fields[this.cfg.fields.round.domains]);

    // Check if any matching executor requires HITL
    const needsApproval = await this.checkHitlRequired(domains);

    if (needsApproval) {
      console.log(`[coordinator] round ${roundId} → pending_approval`);
      const ok = await this.session.transitionRound(roundId, this.cfg.roundStatuses.pendingApproval);
      if (!ok) {
        console.log(`[coordinator] round ${roundId} transition to pending_approval failed`);
      }
    } else {
      console.log(`[coordinator] round ${roundId} → executing (direct)`);
      await this.assignRoundToExecutor(round, ticket);
    }
  }

  /** Process a pending_approval Round: check for timeout. Card callbacks handle approve/reject. */
  private async processPendingApprovalRound(round: BitableRecord): Promise<void> {
    const roundId = round.record_id;
    if (!roundId) return;

    // Check timeout: if created too long ago and still pending_approval, re-queue
    const createdAt = Number(round.fields[this.cfg.fields.round.createdAt] ?? 0);
    const timeoutMs = (this.cfg.executor?.approvalTimeoutMinutes ?? 30) * 60 * 1000;
    if (createdAt > 0 && Date.now() - createdAt > timeoutMs) {
      console.log(`[coordinator] round ${roundId} approval timeout, reverting to pending`);
      await this.session.transitionRound(roundId, this.cfg.roundStatuses.pending);
    }
  }

  /** Process an approved Round: assign an executor. */
  private async processApprovedRound(round: BitableRecord): Promise<void> {
    const roundId = round.record_id;
    if (!roundId) return;

    const ticketId = String(round.fields[this.cfg.fields.round.ticketRecordId] ?? '');
    if (!ticketId) return;
    const ticket = await this.session.getTicket(ticketId);
    if (!ticket) return;

    console.log(`[coordinator] round ${roundId} approved, assigning executor`);
    await this.assignRoundToExecutor(round, ticket);
  }

  /** Check if HITL approval is needed based on executor Roster configurations. */
  private async checkHitlRequired(domains: string[]): Promise<boolean> {
    try {
      const agents = await this.bitable.searchRecords(this.cfg.rosterTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.cfg.fields.roster.kind, operator: 'is', value: ['agent'] },
          { field_name: this.cfg.fields.roster.enabled, operator: 'is', value: [true] },
        ],
      });

      const { PrefixMatcher } = await import('./matcher.js');
      const matcher = new PrefixMatcher();

      for (const agent of agents) {
        const agentDomainList: string[] = Array.isArray(agent.fields[this.cfg.fields.roster.domains])
          ? agent.fields[this.cfg.fields.roster.domains] as string[] : [];
        // Skip if agent doesn't match required domains
        if (domains.length > 0 && !matcher.matches(domains, agentDomainList)) continue;

        const hitl = String(agent.fields[this.cfg.fields.roster.hitl] ?? 'off');
        const hitlPolicy = String(agent.fields[this.cfg.fields.roster.hitlPolicy] ?? 'default');
        if (hitl === 'always' || (hitl === 'auto' && hitlPolicy === 'always')) {
          return true;
        }
      }
    } catch (err) {
      logger.error('[coordinator] checkHitlRequired error:', err);
    }
    return false;
  }

  /** Assign a Round to a push executor. Falls back to fallback message if none match. */
  private async assignRoundToExecutor(round: BitableRecord, ticket: BitableRecord): Promise<void> {
    const roundId = round.record_id;
    const recordId = ticket.record_id;
    if (!roundId || !recordId) return;

    const domains = parseDomains(round.fields[this.cfg.fields.round.domains]);

    const { PrefixMatcher } = await import('./matcher.js');
    const matcher = new PrefixMatcher();

    // Phase 1: Try affinity — assign to last known owner
    const rawLastOwner = String(ticket.fields[this.cfg.fields.ticket.lastOwner] ?? '');
    const lastOwnerIdentity = rawLastOwner.includes('#') ? rawLastOwner.split('#').pop()! : rawLastOwner;
    if (lastOwnerIdentity) {
      const ex = this.executors.get(lastOwnerIdentity);
      if (ex && !ex.activeTicketId) {
        if (domains.length === 0 || matcher.matches(domains, ex.domains)) {
          const won = await this.session.claimRound(round, ex.identity);
          if (won) {
            await this.dispatchRoundToExecutor(ex, round, ticket);
            return;
          }
        }
      }
    }

    // Phase 2: Any available push executor
    for (const [, ex] of this.executors) {
      if (ex.activeTicketId) continue;
      if (domains.length > 0 && !matcher.matches(domains, ex.domains)) continue;
      if (ex.identity === lastOwnerIdentity) continue;
      const won = await this.session.claimRound(round, ex.identity);
      if (!won) continue;
      await this.dispatchRoundToExecutor(ex, round, ticket);
      return;
    }

    // No executor available — leave round pending for later assignment
    console.log(`[coordinator] no executor for round ${roundId} with domains=${domains}, waiting`);
  }

  /** After a new executor connects, try assigning it to any pending round. */
  private async tryAssignPendingToExecutor(identity: string, domains: string[]): Promise<void> {
    if (!this.cfg.roundsTableId) return;
    const ex = this.executors.get(identity);
    if (!ex || ex.activeTicketId) return;
    const pending = await this.session.searchRoundsByStatus(this.cfg.roundStatuses.pending);
    const { PrefixMatcher } = await import('./matcher.js');
    const matcher = new PrefixMatcher();
    for (const round of pending) {
      const domains = parseDomains(round.fields[this.cfg.fields.round.domains]);
      if (domains.length > 0 && !matcher.matches(domains, ex.domains)) continue;
      const won = await this.session.claimRound(round, ex.identity);
      if (!won) continue;
      const ticketId = String(round.fields[this.cfg.fields.round.ticketRecordId] ?? '');
      if (!ticketId) continue;
      const ticket = await this.session.getTicket(ticketId);
      if (!ticket) continue;
      await this.dispatchRoundToExecutor(ex, round, ticket);
      console.log(`[coordinator] assigned pending round ${round.record_id!} to ${identity}`);
      return;
    }
  }

  /** Dispatch a Round task to a push executor via WebSocket. */
  private async dispatchRoundToExecutor(ex: PushExecutor, round: BitableRecord, ticket: BitableRecord): Promise<void> {
    const recordId = ticket.record_id;
    if (!recordId) return;

    ex.activeTicketId = recordId;
    // Transition Round to executing
    await this.session.transitionRound(round.record_id!, this.cfg.roundStatuses.executing);

    const turns = await this.session.getTurns(recordId);
    const supplementPrompt = String(round.fields[this.cfg.fields.round.supplementPrompt] ?? '');

    ex.ws.send(JSON.stringify({
      type: 'task',
      ticket: { record_id: recordId, fields: ticket.fields },
      turns: turns.map(t => ({ record_id: t.record_id, fields: t.fields })),
      globalPrompt: this.cfg.coordinator?.globalPrompt || '',
      stream_output: this.cfg.coordinator?.streamOutput === true,
      stream_thinking: this.cfg.coordinator?.streamThinking === true,
      round: {
        record_id: round.record_id,
        fields: round.fields,
        supplementPrompt,
      },
    }));

    // React to the latest user turn message, not the thread root
    const latestMsgId = latestTurnMessageId(turns, this.cfg.fields.turn.role, this.cfg.fields.turn.dedupKey);
    if (latestMsgId) {
      try { await this.removeReaction(latestMsgId, 'OneSecond'); } catch { /* */ }
      try { await this.reactToMessage(latestMsgId, 'OnIt'); } catch { /* */ }
}
    console.log(`[coordinator] round ${round.record_id!} dispatched to ${ex.identity}`);
  }

  /** Send cancel to a push executor assigned to this Round. Returns true if sent. */
  async dispatchCancelToExecutor(roundId: string): Promise<boolean> {
    try {
      const round = await this.session.getRound(roundId);
      if (!round) return false;
      const executorField = String(round.fields[this.cfg.fields.round.executor] ?? '');
      if (!executorField) return false;
      const identity = executorField.includes('#') ? executorField.split('#').pop()! : executorField;
      const ex = this.executors.get(identity);
      if (!ex || !ex.ws) return false;
      ex.ws.send(JSON.stringify({ type: 'cancel', round_id: roundId }));
      console.log(`[coordinator] sent cancel to ${identity} for round ${roundId}`);
      return true;
    } catch (err) {
      logger.error(`[coordinator] dispatchCancelToExecutor failed:`, err);
      return false;
    }
  }

  /** Process a stuck Round (executing with expired lease).
   *  Only reverts if the assigned executor is no longer connected AND the
   *  round has been executing longer than the stuck timeout. */
  private async processStuckRound(round: BitableRecord): Promise<void> {
    const roundId = round.record_id;
    if (!roundId) return;

    // Don't revert rounds that haven't been executing long enough
    const stuckTimeout = (this.cfg.coordinator?.heartbeatSeconds ?? 60) * 2000;
    const updatedAt = Number(round.fields[this.cfg.fields.round.updatedAt] ?? 0);
    if (updatedAt > 0 && Date.now() - updatedAt < stuckTimeout) {
      return;
    }

    // Check if the executor assigned to this Round is still connected
    const executorField = String(round.fields[this.cfg.fields.round.executor] ?? '');
    const identity = executorField.includes('#') ? executorField.split('#').pop()! : executorField;
    if (identity && this.executors.has(identity)) {
      console.log(`[coordinator] round ${roundId} executor ${identity} still connected, skip stuck check`);
      return;
    }
    // Round is executing but no executor found — re-read to guard against
    // Feishu eventual consistency (executor field may not have propagated yet
    // when a record_edited event triggers this path moments after claimRound).
    if (!identity && roundId) {
      const fresh = await this.session.getRound(roundId);
      if (fresh) {
        const freshField = String(fresh.fields[this.cfg.fields.round.executor] ?? '');
        const freshIdentity = freshField.includes('#') ? freshField.split('#').pop()! : freshField;
        if (freshIdentity && this.executors.has(freshIdentity)) {
          console.log(`[coordinator] round ${roundId} re-read: executor ${freshIdentity} present, skip stuck check`);
          return;
        }
      }
    }
    console.log(`[coordinator] stuck round ${roundId}, reverting to pending`);
    // Clear the executor's activeTicketId so the round can be re-dispatched
    // when a fresh assignRoundToExecutor cycle runs.
    if (identity) {
      const ex = this.executors.get(identity);
      if (ex) ex.activeTicketId = undefined;
    }
    try {
      await this.session.releaseRound(roundId);
    } catch (err) {
      logger.error(`[coordinator] processStuckRound failed ${roundId}:`, err);
    }
  }

  // -- File proxy (proxies file downloads from Feishu API without executor credentials) --

  /** Handle GET /files/{file_token} — proxy download from Feishu Drive API. */
  private async handleFileProxy(req: any, res: any): Promise<void> {
    const fileToken = req.url.replace('/files/', '').split('?')[0];
    if (!fileToken) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing file_token');
      return;
    }

    try {
      const tenantToken = await this.getTenantAccessToken();
      if (!tenantToken) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Failed to obtain tenant token');
        return;
      }

      const dc = getDomainConfig(this.cfg.openApiDomain);
      const downloadUrl = `${dc.sdkBaseUrl}/open-apis/drive/v1/medias/${fileToken}/download`;

      const proxyResp = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${tenantToken}` },
      });

      if (!proxyResp.ok) {
        const errText = await proxyResp.text().catch(() => 'unknown error');
        logger.error(`[coordinator] file proxy download failed: ${proxyResp.status} ${errText.slice(0, 200)}`);
        res.writeHead(proxyResp.status, { 'Content-Type': 'text/plain' });
        res.end(`Download failed: ${proxyResp.status}`);
        return;
      }

      const contentType = proxyResp.headers.get('content-type') || 'application/octet-stream';
      const contentLength = proxyResp.headers.get('content-length');
      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      };
      if (contentLength) headers['Content-Length'] = contentLength;

      res.writeHead(200, headers);
      const buffer = Buffer.from(await proxyResp.arrayBuffer());
      res.end(buffer);
    } catch (err) {
      logger.error('[coordinator] file proxy error:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Proxy error');
    }
  }

  /** Get tenant_access_token using app credentials. */
  private async getTenantAccessToken(): Promise<string | null> {
    try {
      const dc = getDomainConfig(this.cfg.openApiDomain);
      const resp = await fetch(`${dc.sdkBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.cfg.appId, app_secret: this.cfg.appSecret }),
      });
      const data = await resp.json() as Record<string, unknown>;
      return (data.tenant_access_token as string) || null;
    } catch (err) {
      logger.error('[coordinator] getTenantAccessToken failed:', err);
      return null;
    }
  }

  // -- Human notifications --------------------------------------------------
  async notifyHumans() {
    try {
      const tickets = await this.bitable.searchRecords(this.cfg.ticketsTableId, {
        conjunction: 'and', conditions: [
          { field_name: this.cfg.fields.ticket.status, operator: 'is', value: [this.cfg.statuses.active] },
        ],
      });
      for (const ticket of tickets) {
        const rootMsgId = extractText(ticket.fields[this.cfg.fields.ticket.rootMsgId]);
        const senderId = extractText(ticket.fields[this.cfg.fields.ticket.senderId]);
        const summary = extractText(ticket.fields[this.cfg.fields.ticket.summary]);

        const roster = await this.bitable.searchRecords(this.cfg.rosterTableId, {
          conjunction: 'and', conditions: [
            { field_name: this.cfg.fields.roster.kind, operator: 'is', value: ['human'] },
            { field_name: this.cfg.fields.roster.enabled, operator: 'is', value: [true] },
          ],
        });
        if (roster.length === 0) continue;

        let atMentions = '';
        if (senderId) { atMentions = `<at id=${senderId}></at>`; } else {
          const ids = roster.flatMap(h => extractUserIds(h.fields[this.cfg.fields.roster.human]).split(',').filter(Boolean));
          atMentions = ids.map(id => `<at id=${id.trim()}></at>`).join(' ');
        }
        if (rootMsgId) {
          const notification = formatMessage(this.cfg.messages?.humanNotification || '📋 New task pending {mentions}\n{summary}', {
            mentions: atMentions, summary,
          });
          await this.notifyIM(rootMsgId, notification);
        }
      }
    } catch { /* */ }
  }

  // -- IM helpers ------------------------------------------------------------
  private async reactToMessage(messageId: string, emojiType: string) {
    if (!this.cfg.appSecret) return;
    await this.client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
  }

  /** Find and remove a reaction by emoji type. Silently handles not-found. */
  private async removeReaction(messageId: string, emojiType: string) {
    if (!this.cfg.appSecret) return;
    try {
      const list = await this.client.im.v1.messageReaction.list({ path: { message_id: messageId } }) as any;
      const items = list?.data?.items || [];
      for (const r of items) {
        if (r.reaction_type?.emoji_type === emojiType && r.reaction_id) {
          await this.client.im.v1.messageReaction.delete({ path: { message_id: messageId, reaction_id: r.reaction_id } });
          return;
        }
      }
    } catch { /* ignore */ }
  }

  // -- One-time IM notification (not recorded as Turn) ----------------------
  private async notifyIM(rootMsgId: string, text: string) {
    if (!text.trim() || !this.cfg.appSecret) return;
    const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: text }] } };
    try {
      await this.client.im.v1.message.reply({
        path: { message_id: rootMsgId },
        data: { msg_type: 'interactive', content: JSON.stringify(card), reply_in_thread: true } as any,
      });
    } catch (err: any) {
      // Card may fail if markdown has too many tables — fall back to plain text
      const apiCode = err?.response?.data?.code ?? err?.code;
      if (apiCode === 230099 || String(err?.message ?? err).includes('card table number over limit')) {
        await this.client.im.v1.message.reply({
          path: { message_id: rootMsgId },
          data: { msg_type: 'text', content: JSON.stringify({ text }), reply_in_thread: true } as any,
        });
      } else {
        throw err;
      }
    }
  }

  // -- Roster & heartbeat ---------------------------------------------------
  private async upsertRoster(identity: string, domains: string[] | undefined, msg: Record<string, unknown>) {
    const safeDomains = Array.isArray(domains) ? domains : [];
    console.log(`[coordinator] upsertRoster identity=${identity} domains=${safeDomains}`);
    const recs = await this.bitable.searchRecords(this.cfg.rosterTableId, {
      conjunction: 'and', conditions: [{ field_name: this.cfg.fields.roster.identity, operator: 'is', value: [identity] }],
    });
    console.log(`[coordinator] roster search result: ${recs.length} records`);
    const fields = {
      [this.cfg.fields.roster.kind]: 'agent', [this.cfg.fields.roster.domains]: safeDomains.length > 0 ? safeDomains : ['general'],
      [this.cfg.fields.roster.enabled]: true, [this.cfg.fields.roster.description]: (msg.description as string) || '',
      [this.cfg.fields.roster.hitl]: (msg.hitl as string) || 'off', [this.cfg.fields.roster.hitlPolicy]: (msg.hitlPolicy as string) || 'default',
      [this.cfg.fields.roster.lastSeenAt]: Date.now(),
    };
    if (recs.length > 0 && recs[0].record_id) {
      await this.bitable.updateRecord(this.cfg.rosterTableId, recs[0].record_id, fields);
    } else {
      await this.bitable.createRecord(this.cfg.rosterTableId, { [this.cfg.fields.roster.identity]: identity, ...fields, [this.cfg.fields.roster.registeredAt]: Date.now() });
    }
  }

  private async heartbeatAll() {
    const nowMs = Date.now();
    for (const [identity] of this.executors) {
      try {
        const records = await this.bitable.searchRecords(this.cfg.rosterTableId, {
          conjunction: 'and', conditions: [{ field_name: this.cfg.fields.roster.identity, operator: 'is', value: [identity] }],
        });
        if (records.length > 0 && records[0].record_id) {
          await this.bitable.updateRecord(this.cfg.rosterTableId, records[0].record_id, { [this.cfg.fields.roster.lastSeenAt]: nowMs });
        }
      } catch { /* */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the JSON `required_domains` field from a Round record. Returns empty
 *  array if unset, malformed, or any parse error. */
function parseDomains(v: unknown): string[] {
  if (!v) return [];
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Find the latest user turn's message ID (dedupKey) from the turns list.
 *  Reacts to the most recent user message rather than the thread root. */
function latestTurnMessageId(turns: BitableRecord[], roleField: string, dedupKeyField: string): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const role = extractText(turns[i].fields[roleField]);
    if (role === 'user') {
      return extractText(turns[i].fields[dedupKeyField]);
    }
  }
  return '';
}
