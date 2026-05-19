import { logger } from './log.js';
import { Config, BitableRecord, TokenProvider } from './types.js';
import { BitableClient } from './bitable.js';
import { Session, RETRY_OWNER_PREFIX } from './protocol.js';
import { ClaudeProcessor } from './processor.js';
import { UserTokenProvider } from './auth.js';

// ---------------------------------------------------------------------------
// Main polling loop — matches production prototype patterns
// ---------------------------------------------------------------------------

export class Listener {
  private bitable: BitableClient;
  private session: Session;
  private processor: ClaudeProcessor;
  private running = true;
  private lastHeartbeat = 0;

  constructor(private cfg: Config) {
    // Auto-detect auth mode: PKCE if stored token exists, else app_secret
    let tokenProvider: TokenProvider | undefined;
    if (!cfg.appSecret) {
      tokenProvider = UserTokenProvider.fromStore(cfg.appId) ?? undefined;
      if (!tokenProvider) {
        logger.error('No credentials found. Run `bitable-mesh login` to authorize, or set BITABLE_APP_SECRET in .env');
        process.exit(1);
      }
    }
    this.bitable = new BitableClient(cfg, tokenProvider);
    this.session = new Session(cfg.identity, cfg.nickname, cfg, this.bitable);
    this.processor = new ClaudeProcessor(cfg);
  }

  async run(): Promise<void> {
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());

    await this.session.register();
    console.log(`[listener] started identity=${this.cfg.identity} nickname=${this.cfg.nickname} max_concurrent=${this.cfg.maxConcurrency}`);

    const active: Promise<void>[] = [];

    while (this.running) {
      try {
        // Heartbeat every 60s
        const now = Date.now();
        if (now - this.lastHeartbeat > 60_000) {
          await this.session.heartbeat();
          this.lastHeartbeat = now;
        }

        // Concurrency gate
        if (active.length >= this.cfg.maxConcurrency) {
          await sleep(5000);
          continue;
        }

        // Search
        const tickets = await this.session.searchClaimable();
        console.log(`[listener] scan: ${tickets.length} awaiting_agent tickets`);

        const claimable = tickets.filter((t) => this.session.isClaimable(t) && !this.isOwnRetry(t));

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

          // Try to claim
          const won = await this.session.claim(ticket);
          if (!won) continue;

          // Submit to background processing
          const promise = this.processTicket(ticket, recordId).finally(() => {
            const idx = active.indexOf(promise);
            if (idx >= 0) active.splice(idx, 1);
          });
          active.push(promise);
          claimedAny = true;
        }

        if (!claimedAny) {
          await sleep(this.cfg.peakInterval);
        }
      } catch (err) {
        logger.error('[listener] main loop error:', err);
        await sleep(30_000);
      }
    }

    // Wait for active tasks on shutdown
    await Promise.all(active);
    console.log('[listener] stopped');
  }

  stop(): void {
    this.running = false;
  }

  /** Skip tickets we previously failed so other executors can retry them. */
  private isOwnRetry(ticket: BitableRecord): boolean {
    const owner = String(ticket.fields[this.cfg.fields.ticket.owner] ?? '');
    return owner.startsWith(RETRY_OWNER_PREFIX) && owner.endsWith(`#${this.cfg.identity}`);
  }

  private async processTicket(ticket: BitableRecord, recordId: string): Promise<void> {
    const claimId = `${recordId}_${Date.now()}`;
    this.session.logToFile(`ticket=${recordId} started claim_id=${claimId}`);

    try {
      // 1. Fetch turns (for ack hints and prompt)
      const turns = await this.session.getTurns(recordId);

      // 2. Write ack with keyword extraction
      try {
        const unanswered = this.session.findUnansweredTurns(turns);
        const ackText = this.session.buildAckText(unanswered);
        await this.session.appendTurn(recordId, 'agent', ackText, `${claimId}_ack`);
        this.session.logToFile(`ticket=${recordId} wrote_ack`);
      } catch (err) {
        logger.error(`[ticket] write ack failed ${recordId.slice(0, 12)}:`, err);
        this.session.logToFile(`ticket=${recordId} error:write_ack`);
      }

      // 3. Run Claude subprocess
      const ctx = { ticket, turns, config: this.cfg };
      const result = await this.processor.process(ctx);

      if (!result) {
        this.session.logToFile(`ticket=${recordId} error:no_result`);
        await this.session.releaseWithRetry(recordId, 'parse', '输出格式异常无法解析');
        return;
      }

      // 4. Write answer
      try {
        const answer = result.answer || '(无回答)';
        await this.session.appendTurn(recordId, 'agent', answer, claimId);
        this.session.logToFile(`ticket=${recordId} wrote_answer`);
      } catch (err) {
        logger.error(`[ticket] write answer failed ${recordId.slice(0, 12)}:`, err);
        this.session.logToFile(`ticket=${recordId} error:write_answer`);
      }

      // 5. Finalize ticket (update summary/keyfacts, release, set status)
      try {
        await this.session.finalize(recordId, {
          newSummary: result.newSummary,
          newKeyfacts: result.newKeyfacts,
        });
        this.session.logToFile(`ticket=${recordId} finalized`);
      } catch (err) {
        logger.error(`[ticket] finalize failed ${recordId.slice(0, 12)}:`, err);
        this.session.logToFile(`ticket=${recordId} error:finalize`);
      }

      console.log(`[ticket] completed ${recordId.slice(0, 12)}`);
    } catch (err) {
      logger.error(`[ticket] unhandled error ${recordId.slice(0, 12)}:`, err);
      this.session.logToFile(`ticket=${recordId} error:unhandled`);
      await this.session.releaseWithRetry(recordId, 'unhandled', '未知错误');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
