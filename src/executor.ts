import { logger } from './log.js';
import { Config, BitableRecord, TokenProvider } from './types.js';
import { BitableClient } from './bitable.js';
import { Session, extractText, extractUserIds, RETRY_OWNER_PREFIX } from './protocol.js';
import { ClaudeProcessor } from './processor.js';
import { UserTokenProvider } from './auth.js';
import { formatMessage } from './messages.js';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Executor — polls for pending tickets matching its capabilities, runs
// Claude, writes the result, and marks as done.
//
// Never sends Feishu IM messages — that's the Channel's responsibility.
//
// Authentication: prefers OAuth PKCE (UserTokenProvider) if stored tokens
// exist. Falls back to appSecret for legacy setups.
// ---------------------------------------------------------------------------

export class Executor {
  private bitable: BitableClient;
  private session: Session;
  private processor: ClaudeProcessor;
  private running = true;

  constructor(private cfg: Config) {
    const identity = cfg.clientId || cfg.identity;
    // Push mode: no Bitable API calls needed
    if (cfg.executor?.mode === 'push') {
      this.bitable = null as any;
      this.session = null as any;
    } else {
      const tokenProvider = UserTokenProvider.fromStore(cfg.appId) ?? undefined;
      this.bitable = new BitableClient(cfg, tokenProvider);
      this.session = new Session(identity, cfg.nickname, cfg, this.bitable);
    }
    this.processor = new ClaudeProcessor(cfg);
  }

  async run(): Promise<void> {
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());

    // ── Push mode: connect to Channel via WebSocket ──────────────────
    if (this.cfg.executor?.mode === 'push') {
      if (!this.cfg.executor?.coordinatorUrl) {
        logger.error('Push mode requires coordinatorUrl. Set it in config or start Channel with pushListenPort first.');
        process.exit(1);
      }
      console.log(`[executor] push mode, connecting to ${this.cfg.executor.coordinatorUrl}`);
      await this.pushLoop();
      return;
    }

    // ── Self-check ──────────────────────────────────────────────────
    const description = await this.selfCheck();
    if (description) console.log(`[executor] self-check: ${description.slice(0, 60)}...`);

    // ── Pull mode: register and poll Bitable ─────────────────────────
    await this.session.register();
    // Write HITL + description to Roster after register
    const recs = await this.bitable.searchRecords(this.cfg.rosterTableId, {
      conjunction: 'and',
      conditions: [{ field_name: this.cfg.fields.roster.identity, operator: 'is', value: [this.cfg.clientId || this.cfg.identity] }],
    });
    if (recs.length > 0 && recs[0].record_id) {
      const rosterUpdate: Record<string, unknown> = {
        [this.cfg.fields.roster.hitl]: this.cfg.executor?.hitl || 'off',
        [this.cfg.fields.roster.hitlPolicy]: this.cfg.executor?.hitlPolicy || 'default',
      };
      if (description) rosterUpdate[this.cfg.fields.roster.description] = description;
      await this.bitable.updateRecord(this.cfg.rosterTableId, recs[0].record_id, rosterUpdate);
    }
    const caps = this.cfg.executor?.roles ?? [];
    console.log(`[executor] started identity=${this.cfg.identity} nickname=${this.session.nickname}`);
    if (caps.length > 0) {
      console.log(`[executor] roles: ${caps.join(', ')}`);
    }

    await this.coordinationLoop();

    console.log('[executor] stopped');
    process.exit(0);
  }

  /** Run Claude self-check to generate a capability description (≤500 chars). */
  private async selfCheck(): Promise<string> {
    if (!this.cfg.executor?.selfCheck) return '';
    const prompt = `Describe your capabilities as a support agent in under 500 characters. Include your expertise domains, available tools, and response style. Output only the description text, no JSON, no markdown.`;
    return new Promise((resolve) => {
      const proc = spawn(this.cfg.aiCommand, [this.cfg.aiPromptFlag, prompt, '--max-tokens', '200', ...this.cfg.claudeArgs], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      let stdout = '';
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.on('close', () => resolve(stdout.trim().slice(0, 500)));
      proc.on('error', () => resolve(''));
    });
  }

  stop(): void {
    this.running = false;
    this.processor.abort();
    // Force exit after 5s if still alive (Claude child process tree)
    setTimeout(() => process.exit(0), 5000);
  }

  // -----------------------------------------------------------------------
  // Push mode — WebSocket client to Channel
  // -----------------------------------------------------------------------

  private async pushLoop(): Promise<void> {
    const { readExecutorToken, writeExecutorToken } = await import('./sessions.js');

    const wsUrl = this.cfg.executor?.coordinatorUrl || '';
    const identity = this.cfg.clientId || this.cfg.identity;
    const roles = this.cfg.executor?.roles ?? [];
    const description = await this.selfCheck();
    if (description) console.log(`[executor] self-check: ${description.slice(0, 60)}...`);
    let sessionToken = readExecutorToken();

    // Fetch app access token if auth mode is 'app'
    const authType = this.cfg.executor?.auth === 'app' ? 'app_secret' : 'oauth';
    let appToken = '';
    if (authType === 'app_secret' && this.cfg.appSecret) {
      try {
        const domain = this.cfg.openApiDomain || 'open.feishu.cn';
        const resp = await fetch(`https://${domain}/open-apis/auth/v3/app_access_token/internal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: this.cfg.appId, app_secret: this.cfg.appSecret }),
        });
        const data = await resp.json() as Record<string, unknown>;
        appToken = (data.app_access_token as string) || (data as any).tenant_access_token || '';
        if (appToken) console.log('[executor] app token obtained');
        else logger.error('[executor] app token response:', JSON.stringify(data).slice(0, 200));
      } catch (err: any) { logger.error('[executor] app token fetch failed:', err.message); }
    } else if (authType === 'app_secret' && !this.cfg.appSecret) {
      logger.error('[executor] app auth requires appSecret in config');
      process.exit(1);
    }

    let currentWs: WebSocket | null = null;

    const connect = () => {
      const ws = new WebSocket(wsUrl);
      currentWs = ws;
      ws.on('open', () => {
        console.log('[executor] push connected to Channel');
        if (sessionToken) {
          ws.send(JSON.stringify({ type: 'reauth', session_token: sessionToken, identity, roles, description, hitl: this.cfg.executor?.hitl || 'off', hitlPolicy: this.cfg.executor?.hitlPolicy || 'default' }));
        } else {
          const token = appToken || process.env.BITABLE_OAUTH_TOKEN || '';
          ws.send(JSON.stringify({ type: 'auth', auth_type: authType, token, identity, roles, description, hitl: this.cfg.executor?.hitl || 'off', hitlPolicy: this.cfg.executor?.hitlPolicy || 'default' }));
        }
      });

      ws.on('message', async (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (msg.type === 'auth_ok') {
            sessionToken = msg.session_token as string;
            writeExecutorToken(sessionToken);
            console.log('[executor] push authenticated');
            return;
          }
          if (msg.type === 'reauth_ok') { console.log('[executor] push reauthenticated'); return; }
          if (msg.type === 'error') { logger.error('[executor] push error:', msg.message); sessionToken = null; return; }
          if (msg.type === 'task' && this.running) {
            const ticket = msg.ticket as BitableRecord;
            const recordId = ticket.record_id as string;
            if (!recordId) return;
            console.log(`[executor] push received task ${recordId.slice(0, 12)}`);
            const rootMsgId = extractText(ticket.fields[this.cfg.fields.ticket.rootMsgId]);
            const turns = (msg.turns as any[])?.map((t: any) => ({ record_id: t.record_id, fields: t.fields || {} })) || [];
            const globalPrompt = (msg.globalPrompt as string) || '';
            try {
              const ctx = { ticket, turns, config: this.cfg, globalPrompt };
              console.log(`[executor] prompt: global=${!!globalPrompt} system=${!!this.cfg.executor?.prompt} turns=${turns.length}`);
              console.log(`[executor] running claude for ticket=${recordId.slice(0, 12)}`);
              const result = await this.processor.process(ctx);
              console.log(`[executor] claude done ticket=${recordId.slice(0, 12)} answer=${(result?.answer || '').slice(0, 60)}`);
              currentWs?.send(JSON.stringify({
                type: 'result', ticket_id: recordId,
                answer: result?.answer || '处理异常',
                newSummary: result?.newSummary || '',
                root_msg_id: rootMsgId,
                reassignTo: result?.reassignTo,
              }));
            } catch (err) {
              logger.error(`[executor] push task error ticket=${recordId.slice(0, 12)}:`, err instanceof Error ? err.message : err);
              currentWs?.send(JSON.stringify({ type: 'result', ticket_id: recordId, answer: `处理异常: ${err instanceof Error ? err.message : String(err)}`, newSummary: '', root_msg_id: rootMsgId }));
            }
          }
        } catch { /* malformed */ }
      });

      // Heartbeat every 30s to keep connection alive
      const heartbeatTimer = setInterval(() => {
        try { currentWs?.send('ping'); } catch { clearInterval(heartbeatTimer); }
      }, 30_000);

      ws.on('close', () => {
        clearInterval(heartbeatTimer);
        if (this.running) {
          console.log('[executor] push disconnected, reconnecting in 5s');
          setTimeout(connect, 5000);
        }
      });
      ws.on('error', () => { clearInterval(heartbeatTimer); /* handled by close */ });
    };

    connect();
    // Keep alive forever
    await new Promise(() => {});
  }

  // -----------------------------------------------------------------------
  // Coordination loop
  // -----------------------------------------------------------------------

  private async coordinationLoop(): Promise<void> {
    const active: Promise<void>[] = [];
    const inFlight = new Set<string>();
    let lastHeartbeat = 0;

    while (this.running) {
      try {
        const now = Date.now();
        if (now - lastHeartbeat > this.cfg.heartbeatIntervalSeconds * 1000) {
          await this.session.heartbeat();
          lastHeartbeat = now;
        }

        if (active.length >= this.cfg.maxConcurrency) {
          await sleep(5000);
          continue;
        }

        const tickets = await this.session.searchPending();

        const claimable = tickets.filter((t) => this.isRoleMatch(t) && this.session.isClaimable(t) && !this.isOwnRetry(t));
        if (claimable.length > 0) {
          console.log(`[executor] scan: ${claimable.length} claimable tickets`);
        }

        // Affinity sorting: tickets where lastOwner matches this executor go first
        const affinity: BitableRecord[] = [];
        const nonAffinity: BitableRecord[] = [];
        for (const t of claimable) {
          const lastOwner = String(t.fields[this.cfg.fields.ticket.lastOwner] ?? '');
          if (lastOwner.endsWith(`#${this.cfg.identity}`)) {
            affinity.push(t);
          } else {
            nonAffinity.push(t);
          }
        }
        shuffleArray(affinity);
        shuffleArray(nonAffinity);
        const orderedClaimable = [...affinity, ...nonAffinity];

        let claimedAny = false;

        for (const ticket of orderedClaimable) {
          if (active.length >= this.cfg.maxConcurrency) break;
          if (!this.running) break;

          const recordId = ticket.record_id;
          if (!recordId) continue;
          // Prevent re-claiming due to Bitable eventual consistency
          if (inFlight.has(recordId)) continue;

          const won = await this.session.claim(ticket);
          if (!won) continue;

          inFlight.add(recordId);
          const promise = this.processTicket(ticket, recordId).finally(() => {
            const idx = active.indexOf(promise);
            if (idx >= 0) active.splice(idx, 1);
            inFlight.delete(recordId);
          });
          active.push(promise);
          claimedAny = true;
        }

        if (!claimedAny) {
          await sleep(this.cfg.peakInterval);
        }
      } catch (err) {
        logger.error('[executor] coordination loop error:', err);
        await sleep(this.cfg.errorRetrySeconds * 1000);
      }
    }

    await Promise.all(active);
  }

  // -----------------------------------------------------------------------
  // Capability matching
  // -----------------------------------------------------------------------

  /** Returns true if this executor previously failed this ticket (owner starts
   *  with RETRY: and ends with our identity). We skip these to let other
   *  executors retry instead of failing again on the same node. */
  private isOwnRetry(ticket: BitableRecord): boolean {
    const owner = String(ticket.fields[this.cfg.fields.ticket.owner] ?? '');
    return owner.startsWith(RETRY_OWNER_PREFIX) && owner.endsWith(`#${this.cfg.identity}`);
  }

  /** Returns true if this executor can take the ticket (role + kind match). */
  private isRoleMatch(ticket: BitableRecord): boolean {
    // for_kind = "human" means only humans should take this — agent skips
    const forKind = String(ticket.fields[this.cfg.fields.ticket.forKind] ?? '');
    if (forKind === 'human') return false;

    // Check roles: intersection required between ticket.forRoles and executor.roles
    // MultiSelect field returns string array directly
    const raw = ticket.fields[this.cfg.fields.ticket.forRoles];
    const required: string[] = Array.isArray(raw) ? raw as string[] : [];
    if (required.length === 0) return true; // no requirements = anyone can take it

    const myRoles = this.cfg.executor?.roles ?? [];
    return required.some((c) => myRoles.includes(c));
  }

  // -----------------------------------------------------------------------
  // Ticket processing
  // -----------------------------------------------------------------------

  private async processTicket(ticket: BitableRecord, recordId: string): Promise<void> {
    const claimId = `${recordId}_${Date.now()}`;
    const rootMsgId = extractText(ticket.fields[this.cfg.fields.ticket.rootMsgId]);
    const ownerValue = `${this.session.nickname}#${this.cfg.identity}`;
    this.session.logToFile(`ticket=${recordId} started claim_id=${claimId}`);

    try {
      // 1. Fetch turns
      const turns = await this.session.getTurns(recordId);

      // 2. Check if approval is needed (has approvers configured in Roster)
      let needsApproval = !this.cfg.executor?.skipApproval;
      let approvalAtMentions = '';

      if (needsApproval) {
        await this.session.setPendingApproval(recordId);
        // Read back the ticket to check if approvers were actually written
        const updated = await this.session.getTicket(recordId);
        const approvers = updated?.fields[this.cfg.fields.ticket.approvers];
        const openIds = extractUserIds(approvers);
        if (!openIds) {
          // No approvers configured — skip approval, restore status
          this.session.logToFile(`ticket=${recordId} no_approvers`);
          await this.session.setTicketStatus(recordId, this.cfg.statuses.assigned);
          needsApproval = false;
        } else {
          // Build @mention string for the approval message
          const ids = openIds.split(',').map((s: string) => s.trim()).filter(Boolean);
          approvalAtMentions = ids.map((id: string) => `<at id=${id}></at>`).join(' ');
        }
      }

      if (needsApproval) {
        this.session.logToFile(`ticket=${recordId} waiting_approval`);
        await this.session.appendTurn(recordId, 'agent',
          formatMessage(this.cfg.messages?.approvalWait || '⏳ Awaiting approval from {mentions}', { mentions: approvalAtMentions }),
          `${recordId}_approval_wait`, undefined, 'processing', rootMsgId);

        const timeoutMs = (this.cfg.executor?.approvalTimeoutMinutes ?? 30) * 60 * 1000;
        const approval = await this.session.pollApproval(recordId, timeoutMs);

        if (approval !== 'approved') {
          const reason = approval === 'timeout' ? 'timeout' : 'rejected';
          console.log(`[executor] approval ${reason}, releasing ticket=${recordId.slice(0, 12)}`);
          this.session.logToFile(`ticket=${recordId} ${approval === 'timeout' ? 'approval_timeout' : 'approval_rejected'}`);
          await this.session.release(recordId, this.cfg.statuses.pending);
          await this.session.appendTurn(recordId, 'agent',
            formatMessage(this.cfg.messages?.approvalDenied || '⏳ Ticket not approved ({reason}), escalated to human processing', { reason }),
            `${recordId}_rejected`, undefined, 'error', rootMsgId);
          return;
        }

        console.log(`[executor] approval granted ticket=${recordId.slice(0, 12)}`);
        this.session.logToFile(`ticket=${recordId} approval_granted`);

        // Refresh turns after approval (new user messages may have arrived)
        const freshTurns = await this.session.getTurns(recordId);
        Object.assign(turns, freshTurns);
      } else {
        // No approval needed — write ACK
        try {
          const unanswered = this.session.findUnansweredTurns(turns);
          const ackText = this.session.buildAckText(unanswered);
          await this.session.appendTurn(recordId, 'agent', ackText, `${recordId}_ack`, undefined, 'processing', rootMsgId);
          this.session.logToFile(`ticket=${recordId} wrote_ack`);
        } catch (err) {
          logger.error(`[executor] write ack failed ${recordId.slice(0, 12)}:`, err);
        }
      }

      // 3. Run Claude
      const ctx = { ticket, turns, config: this.cfg };
      const result = await this.processor.process(ctx);

      if (!result) {
        this.session.logToFile(`ticket=${recordId} error:no_result`);
        await this.session.releaseWithRetry(recordId, 'parse', '输出格式异常无法解析', rootMsgId);
        return;
      }

      // 3b. Check for reassignTo (transfer to another agent/human)
      if (result.reassignTo) {
        const rt = result.reassignTo;
        this.session.logToFile(`ticket=${recordId} reassign roles=${JSON.stringify(rt.roles)} kind=${rt.kind || ''}`);
        // Write answer turn then release for the next participant
        const answer = result.answer || this.cfg.messages?.reassignFallback || 'Transferring...';
        try {
          await this.session.appendTurn(recordId, 'agent', answer, claimId, undefined, 'processing', rootMsgId);
        } catch (err) {
          logger.error(`[executor] write reassign turn failed ${recordId.slice(0, 12)}:`, err);
        }
        await this.session.release(recordId, this.cfg.statuses.pending, {
          forRoles: rt.roles,
          forKind: rt.kind as 'human' | 'agent' | undefined,
        });
        console.log(`[executor] reassigned ${recordId.slice(0, 12)}`);
        return;
      }

      // 4. Write answer turn (with optional post-answer review)
      const answer = result.answer || this.cfg.messages?.emptyAnswerFallback || '(no answer)';
      const needsReview = this.cfg.executor?.postReview;
      const turnStatus = needsReview ? 'pending_review' : 'answered';
      try {
        await this.session.appendTurn(recordId, 'agent', answer, claimId, undefined, turnStatus, rootMsgId);
        this.session.logToFile(`ticket=${recordId} wrote_answer${needsReview ? '_pending_review' : ''}`);
      } catch (err) {
        logger.error(`[executor] write answer failed ${recordId.slice(0, 12)}:`, err);
        this.session.logToFile(`ticket=${recordId} error:write_answer`);
      }

      // 4b. Post-answer review: wait for review result
      if (needsReview) {
        this.session.logToFile(`ticket=${recordId} waiting_review`);
        await this.session.appendTurn(recordId, 'agent',
          this.cfg.messages?.reviewWait || '📋 Answer pending review, reviewers notified',
          `${recordId}_review_wait`, undefined, 'processing', rootMsgId);

        const timeoutMs = (this.cfg.executor?.approvalTimeoutMinutes ?? 30) * 60 * 1000;
        const review = await this.session.pollReview(recordId, timeoutMs);

        if (review === 'approved') {
          console.log(`[executor] review approved ticket=${recordId.slice(0, 12)}`);
          this.session.logToFile(`ticket=${recordId} review_approved`);
        } else if (review === 'rejected') {
          console.log(`[executor] review rejected, re-running Claude ticket=${recordId.slice(0, 12)}`);
          this.session.logToFile(`ticket=${recordId} review_rejected`);
          // Re-run Claude. The retry answer also goes through review if postReview is set.
          const retryCtx = { ticket, turns: await this.session.getTurns(recordId), config: this.cfg };
          const retryResult = await this.processor.process(retryCtx);
          if (!retryResult) {
            await this.session.releaseWithRetry(recordId, 'review_retry', '审核后重试仍异常', rootMsgId);
            console.log(`[executor] completed ${recordId.slice(0, 12)}`);
            return;
          }
          const retryAnswer = retryResult.answer || this.cfg.messages?.emptyAnswerFallback || '(no answer)';
          const retryTurnStatus = needsReview ? 'pending_review' : 'answered';
          try {
            await this.session.appendTurn(recordId, 'agent', retryAnswer, `${claimId}_retry`, undefined, retryTurnStatus, rootMsgId);
            this.session.logToFile(`ticket=${recordId} wrote_retry_answer${needsReview ? '_pending_review' : ''}`);
          } catch (err) {
            logger.error(`[executor] write retry answer failed ${recordId.slice(0, 12)}:`, err);
          }
          // Second review round
          if (needsReview) {
            await this.session.appendTurn(recordId, 'agent',
              this.cfg.messages?.reviewRetry || '📋 Answer regenerated, pending re-review',
              `${recordId}_review_retry_wait`, undefined, 'processing', rootMsgId);
            const retryReview = await this.session.pollReview(recordId, timeoutMs);
            if (retryReview !== 'approved') {
              await this.session.release(recordId, this.cfg.statuses.pending);
              await this.session.appendTurn(recordId, 'agent',
                retryReview === 'timeout'
                  ? (this.cfg.messages?.reviewTimeout || '⏳ Review timed out, escalated to human processing')
                  : (this.cfg.messages?.reviewRejected || '⏳ Review rejected again, escalated to human processing'),
                `${recordId}_review_rejected_final`, undefined, 'error', rootMsgId);
              console.log(`[executor] completed ${recordId.slice(0, 12)}`);
              return;
            }
          }
          // Approved on retry — write result
          try {
            await this.session.writeResult(recordId, retryAnswer, retryResult.newSummary, ownerValue);
            this.session.logToFile(`ticket=${recordId} result written (retry)`);
          } catch (err) {
            logger.error(`[executor] writeResult (retry) failed ${recordId.slice(0, 12)}:`, err);
          }
          console.log(`[executor] completed ${recordId.slice(0, 12)}`);
          return;
        } else {
          // timeout
          console.log(`[executor] review timeout, releasing ticket=${recordId.slice(0, 12)}`);
          this.session.logToFile(`ticket=${recordId} review_timeout`);
          await this.session.release(recordId, this.cfg.statuses.pending);
          await this.session.appendTurn(recordId, 'agent',
            this.cfg.messages?.reviewTimeout || '⏳ Review timed out, escalated to human processing',
            `${recordId}_review_timeout`, undefined, 'error', rootMsgId);
          console.log(`[executor] completed ${recordId.slice(0, 12)}`);
          return;
        }
      }

      // 5. Write result and mark done (Channel will notify the user)
      try {
        await this.session.writeResult(recordId, answer, result.newSummary, ownerValue);
        this.session.logToFile(`ticket=${recordId} result written`);
      } catch (err) {
        logger.error(`[executor] writeResult failed ${recordId.slice(0, 12)}:`, err);
        this.session.logToFile(`ticket=${recordId} error:writeResult`);
      }

      console.log(`[executor] completed ${recordId.slice(0, 12)}`);
    } catch (err) {
      logger.error(`[executor] unhandled error ${recordId.slice(0, 12)}:`, err);
      this.session.logToFile(`ticket=${recordId} error:unhandled`);
      await this.session.releaseWithRetry(recordId, 'unhandled', '未知错误', rootMsgId);
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
