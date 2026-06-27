import { logger } from './log.js';
import { Config, BitableRecord, Part, FilePart, ProcessContext } from './types.js';
import { extractText } from './text.js';
import { FLD } from './fields.js';
import { KekkaiProcessor } from './processor.js';
import { spawn } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startDashboard } from './dashboard.js';

// ---------------------------------------------------------------------------
// Executor — push-mode only. Connects to Channel via WebSocket, receives
// tasks, runs AI backend via KekkaiProcessor, reports results.
// ---------------------------------------------------------------------------

export class Executor {
  private processor: KekkaiProcessor;
  private running = true;

  constructor(private cfg: Config) {
    this.processor = new KekkaiProcessor(cfg);
  }

  async run(): Promise<void> {
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());

    if (!this.cfg.executor?.coordinatorUrl) {
      logger.error('coordinatorUrl required. Set it in config or start Channel first.');
      process.exit(1);
    }

    const sessionDir = this.cfg.executor?.sessionDir;
    if (sessionDir) {
      startDashboard(sessionDir, 3456);
    }

    console.log(`[executor] connecting to ${this.cfg.executor.coordinatorUrl}`);
    await this.pushLoop();
  }

  /** Run Claude self-check to generate a capability description (≤500 chars). */
  private async selfCheck(): Promise<string> {
    if (!this.cfg.executor?.selfCheck) return '';
    const prompt = `Describe your capabilities as a support agent in under 500 characters. Include your expertise domains, available tools, and response style. Output only the description text, no JSON, no markdown.`;
    const dd = this.cfg.executor?.defaultDomain;
    const aiCmd = dd?.command ?? 'claude';
    const args = dd?.args ?? [];
    return new Promise((resolve) => {
      const proc = spawn(aiCmd, ['-p', prompt, '--max-tokens', '200', ...args], {
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
    setTimeout(() => process.exit(0), 5000);
  }

  // -----------------------------------------------------------------------
  // Push mode — WebSocket client to Channel
  // -----------------------------------------------------------------------

  private async pushLoop(): Promise<void> {
    const { readExecutorToken, writeExecutorToken } = await import('./sessions.js');

    const wsUrl = this.cfg.executor?.coordinatorUrl || '';
    const identity = this.cfg.clientId || this.cfg.identity;
    const domainsList = this.cfg.executor?.domains ?? [];
    console.log(`[executor] configured domains: ${JSON.stringify(domainsList)}`);
    const description = await this.selfCheck();
    if (description) console.log(`[executor] self-check: ${description.slice(0, 60)}...`);
    let sessionToken = readExecutorToken();
    let storedAppId = '';
    let storedDomain = '';

    let currentWs: WebSocket | null = null;

    const connect = () => {
      const ws = new WebSocket(wsUrl);
      currentWs = ws;
      ws.on('open', () => {
        console.log('[executor] connected to Channel');
        if (sessionToken) {
          ws.send(JSON.stringify({ type: 'reauth', session_token: sessionToken, identity, domains: domainsList, description, hitl: this.cfg.executor?.hitl || 'off', hitlPolicy: this.cfg.executor?.hitlPolicy || 'default' }));
        } else {
          const oauthToken = process.env.BITABLE_OAUTH_TOKEN || '';
          if (oauthToken) {
            ws.send(JSON.stringify({ type: 'auth_token', token: oauthToken, identity, domains: domainsList, description, hitl: this.cfg.executor?.hitl || 'off', hitlPolicy: this.cfg.executor?.hitlPolicy || 'default' }));
          } else {
            ws.send(JSON.stringify({ type: 'auth', identity }));
          }
        }
      });

      ws.on('message', async (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (msg.type === 'auth_ok') {
            sessionToken = msg.session_token as string;
            writeExecutorToken(sessionToken);
            console.log('[executor] authenticated');
            return;
          }
          if (msg.type === 'reauth_ok') { console.log('[executor] reauthenticated'); return; }
          if (msg.type === 'auth_required') {
            storedAppId = msg.appId as string || '';
            storedDomain = msg.openApiDomain as string || '';
            console.log(`[executor] auth required, starting OAuth login for appId=${storedAppId}`);
            try {
              const { UserTokenProvider, loadStoredTokens } = await import('./auth.js');
              let provider = UserTokenProvider.fromStore(storedAppId);
              if (!provider) {
                provider = await UserTokenProvider.login(storedAppId, storedDomain);
              }
              const token = await provider.getToken();
              ws.send(JSON.stringify({ type: 'auth_token', token, identity, domains: domainsList, description, hitl: this.cfg.executor?.hitl || 'off', hitlPolicy: this.cfg.executor?.hitlPolicy || 'default' }));
            } catch (err: any) {
              logger.error('[executor] OAuth login failed:', err.message);
            }
            return;
          }
          if (msg.type === 'error') { logger.error('[executor] error:', msg.message); sessionToken = null; return; }
          if (msg.type === 'cancel') {
            const roundId = (msg.round_id as string) || '';
            console.log(`[executor] received cancel${roundId ? ` for round ${roundId}` : ''}`);
            this.processor.abort();
            return;
          }
          if (msg.type === 'task' && this.running) {
            const ticket = msg.ticket as BitableRecord;
            const recordId = ticket.record_id as string;
            if (!recordId) return;
            console.log(`[executor] received task ${recordId}`);
            const rootMsgId = extractText(ticket.fields[FLD.rootMsgId]);
            const turns = (msg.turns as any[])?.map((t: any) => ({ record_id: t.record_id, fields: t.fields || {} })) || [];
            const globalPrompt = (msg.globalPrompt as string) || '';
            const round = msg.round as { record_id?: string; supplementPrompt?: string; fields?: Record<string, unknown> } | undefined;
            const currentRoundId = round?.record_id || '';
            const supplementPrompt = round?.supplementPrompt || '';
            const roundFields = round?.fields;
            const domainsRaw = roundFields ? String(roundFields[FLD.domains] ?? '') : '';
            const domainsList: string[] = domainsRaw ? (() => { try { const p = JSON.parse(domainsRaw); return Array.isArray(p) ? p.map(String) : []; } catch { return []; } })() : [];
            let streamOutput = false;
            let streamThinking = false;
            try {
              streamOutput = (msg.stream_output as boolean) === true && !!rootMsgId;
              streamThinking = (msg.stream_thinking as boolean) === true;
              const downloadedAttachments = await this.downloadAttachments(turns);
              const ctx: ProcessContext = {
                ticket, turns, config: this.cfg, globalPrompt,
                roundSupplementPrompt: supplementPrompt,
                roundId: currentRoundId || undefined,
                domains: domainsList.length > 0 ? domainsList : undefined,
                downloadedAttachments,
                onStream: streamOutput ? (content: string, type?: string) => {
                  try { currentWs?.send(JSON.stringify({ type: 'stream_update', ticket_id: recordId, round_id: currentRoundId, root_msg_id: rootMsgId, content, content_type: type === 'thinking' && streamThinking ? 'thinking' : 'message' })); } catch {}
                } : undefined,
              };
              console.log(`[executor] prompt: global=${!!globalPrompt} system=${!!this.cfg.executor?.prompt} turns=${turns.length}${currentRoundId ? ` round=${currentRoundId}` : ''}`);
              console.log(`[executor] processing ticket=${recordId} streamOutput=${streamOutput}`);
              const result = await this.processor.process(ctx);
              console.log(`[executor] done ticket=${recordId} answer=${(result?.answer || '').slice(0, 60)}`);
              const finalAnswer = result?.answer || '(processing error)';
              // Send stream_end to close the typewriter card (with error content if failed)
              if (streamOutput) {
                try { currentWs?.send(JSON.stringify({ type: 'stream_end', ticket_id: recordId, round_id: currentRoundId, content: finalAnswer, duration_ms: result?.durationMs, token_usage: result?.tokenUsage })); } catch {}
              }
              this.cleanupAttachments(downloadedAttachments);
              currentWs?.send(JSON.stringify({
                type: 'result', ticket_id: recordId,
                round_id: currentRoundId,
                answer: finalAnswer,
                newSummary: result?.newSummary || '',
                root_msg_id: rootMsgId,
                // Only mark streamed when streaming was actually active
                // (not on retry where onStream was undefined, not on error where no stream was sent)
                streamed: streamOutput && !!result?.answer && !result?.retried,
                reassignTo: result?.reassignTo,
                parts: result?.parts ?? [],
              }));
            } catch (err) {
              logger.error(`[executor] push task error ticket=${recordId}:`, err instanceof Error ? err.message : err);
              const errorMsg = `(processing error): ${err instanceof Error ? err.message : String(err)}`;
              if (streamOutput) {
                try { currentWs?.send(JSON.stringify({ type: 'stream_end', ticket_id: recordId, round_id: currentRoundId, content: errorMsg })); } catch {}
              }
              currentWs?.send(JSON.stringify({ type: 'result', ticket_id: recordId, round_id: currentRoundId, answer: errorMsg, newSummary: '', root_msg_id: rootMsgId, parts: [], streamed: false }));
            }
          }
        } catch { /* malformed */ }
      });

      const heartbeatTimer = setInterval(() => {
        try { currentWs?.send('ping'); } catch { clearInterval(heartbeatTimer); }
      }, 30_000);

      ws.on('close', () => {
        clearInterval(heartbeatTimer);
        if (this.running) {
          console.log('[executor] disconnected, reconnecting in 5s');
          setTimeout(connect, 5000);
        }
      });
      ws.on('error', () => { clearInterval(heartbeatTimer); });
    };

    connect();
    await new Promise(() => {});
  }

  // -----------------------------------------------------------------------
  // Attachment download
  // -----------------------------------------------------------------------

  private async downloadAttachments(turns: BitableRecord[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};

    for (const turn of turns) {
      const partsRaw = extractText(turn.fields[FLD.parts]);
      if (!partsRaw) continue;

      try {
        const parts: Part[] = JSON.parse(partsRaw);
        for (const part of parts) {
          if (part.kind !== 'file') continue;
          const fp = part as FilePart;
          if (!fp.file_uri || !fp.file_token) continue;

          const url = fp.file_uri.startsWith('http')
            ? fp.file_uri
            : (this.cfg.executor?.coordinatorUrl
              ? this.cfg.executor.coordinatorUrl.replace(/^ws/, 'http').replace(/\/ws.*$/, '') + fp.file_uri
              : fp.file_uri);

          try {
            const timeout = (this.cfg.executor?.httpDownloadTimeout ?? 30) * 1000;
            const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
            if (response.ok) {
              const buffer = Buffer.from(await response.arrayBuffer());
              const attachDir = join(tmpdir(), 'bam-attachments');
              mkdirSync(attachDir, { recursive: true });
              const localPath = join(attachDir, `${fp.file_token}_${fp.name || 'file'}`);
              writeFileSync(localPath, buffer);
              result[fp.file_token] = localPath;
              console.log(`[executor] downloaded attachment ${fp.file_token} → ${localPath}`);
            } else {
              logger.error(`[executor] download attachment failed ${fp.file_token}: HTTP ${response.status}`);
            }
          } catch (err: any) {
            logger.error(`[executor] download attachment error ${fp.file_token}: ${err.message}`);
          }
        }
      } catch { /* skip malformed parts */ }
    }

    return result;
  }

  private cleanupAttachments(attachments: Record<string, string>): void {
    for (const path of Object.values(attachments)) {
      try { unlinkSync(path); } catch { /* already gone */ }
    }
  }
}
