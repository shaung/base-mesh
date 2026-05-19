import { logger } from './log.js';
import { spawn } from 'node:child_process';
import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { Config } from './types.js';
import { getDomainConfig } from './domain.js';

// ---------------------------------------------------------------------------
// Direct Mode — stateless WS listener → Claude → IM reply.
//
// No tables, no tickets, no persistence.  Single-user mode: each message
// is answered by Claude directly without any lifecycle management.
// ---------------------------------------------------------------------------

export class DirectMode {
  private wsClient: WSClient | null = null;
  private client: Client;
  private running = true;

  constructor(private cfg: Config) {
    const dc = getDomainConfig(cfg.openApiDomain);
    this.client = new Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret || 'unused',
      domain: dc.sdkBaseUrl,
    });
  }

  async run(): Promise<void> {
    process.on('SIGTERM', () => { this.stop(); process.exit(0); });
    process.on('SIGINT', () => { this.stop(); process.exit(0); });

    console.log(`[direct] started identity=${this.cfg.identity} nickname=${this.cfg.nickname}`);

    await this.connectWebSocket();

    while (this.running) {
      await sleep(60_000);
    }

    this.cleanup();
    console.log('[direct] stopped');
    process.exit(0);
  }

  stop(): void {
    this.running = false;
    if (this.wsClient) {
      try { this.wsClient.close({ force: true }); } catch { /* ignore */ }
      this.wsClient = null;
    }
  }

  // -----------------------------------------------------------------------
  // WebSocket
  // -----------------------------------------------------------------------

  private async connectWebSocket(): Promise<void> {
    if (!this.cfg.appSecret) {
      console.log('[direct] appSecret required for WebSocket event subscription.');
      return;
    }

    try {
      const dc = getDomainConfig(this.cfg.openApiDomain);
      this.wsClient = new WSClient({
        appId: this.cfg.appId,
        appSecret: this.cfg.appSecret,
        domain: dc.sdkBaseUrl,
        autoReconnect: true,
        onReady: () => console.log('[direct] WS connected'),
        onError: (err) => logger.error(`[direct] WS error: ${err.message}`),
        onReconnecting: () => console.log('[direct] WS reconnecting...'),
        onReconnected: () => console.log('[direct] WS reconnected'),
      });

      const dispatcher = new EventDispatcher({});
      dispatcher.register({
        'im.message.receive_v1': async (data) => { await this.onBotMessage(data); },
      });

      await this.wsClient.start({ eventDispatcher: dispatcher });
    } catch (err: any) {
      console.warn(`[direct] WS init failed: ${err.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Handler
  // -----------------------------------------------------------------------

  private async onBotMessage(raw: any): Promise<void> {
    const data = raw.event ?? raw;
    const msg = data.message;
    if (!msg) return;

    // Only p2p text from real users
    if (msg.chat_type !== 'p2p') return;
    if (data.sender?.sender_type !== 'user') return;
    if (msg.message_type !== 'text') return;

    // Parse text
    let content: string;
    try { content = JSON.parse(msg.content).text ?? msg.content; } catch { content = msg.content; }
    if (!content) return;

    const messageId = msg.message_id;
    const chatId = msg.chat_id;
    if (!messageId || !chatId) return;

    console.log(`[direct] DM: ${content.slice(0, 80)}`);

    // React with processing emoji
    try { await this.react(messageId); } catch { /* best effort */ }

    // Run Claude
    const answer = await this.runClaude(content);
    if (!answer) return;

    // Reply via IM
    try {
      await this.sendMessage(chatId, answer, messageId);
      console.log(`[direct] replied to ${messageId.slice(0, 12)}`);
    } catch (err) {
      logger.error(`[direct] reply failed:`, err);
    }
  }

  // -----------------------------------------------------------------------
  // Claude
  // -----------------------------------------------------------------------

  private runClaude(prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      const proc = spawn('claude', ['-p', prompt, ...this.cfg.claudeArgs], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: this.cfg.claudeTimeout * 1000,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          logger.error(`[direct] claude exited ${code}: ${stderr.slice(0, 200)}`);
          resolve(null);
          return;
        }
        resolve(stdout.trim());
      });

      proc.on('error', (err) => {
        logger.error(`[direct] spawn failed: ${err.message}`);
        resolve(null);
      });
    });
  }

  // -----------------------------------------------------------------------
  // IM helpers
  // -----------------------------------------------------------------------

  private async react(messageId: string): Promise<void> {
    await this.client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: 'OnIt' } },
    });
  }

  private async sendMessage(chatId: string, text: string, rootId?: string): Promise<void> {
    const data: Record<string, any> = {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    };
    if (rootId) data.root_id = rootId;

    await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: data as any,
    });
  }

  private cleanup(): void {
    if (this.wsClient) {
      try { this.wsClient.close({ force: true }); } catch { /* ignore */ }
      this.wsClient = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
