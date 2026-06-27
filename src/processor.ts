import { Kekkai } from '@typooo/kekkai';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './log.js';
import { Config, DomainConfig, Processor, ProcessContext, ProcessResult, Part } from './types.js';
import { extractText } from './text.js';
import { FLD } from './fields.js';

// ---------------------------------------------------------------------------
// Output schema for structured output
// ---------------------------------------------------------------------------

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['answer'],
  additionalProperties: false,
  properties: {
    answer: {
      type: 'string',
      description: 'Your final response to the user. Write in the same language the user used.',
    },
    newSummary: {
      type: 'string',
      description: 'Updated ticket summary. Leave empty string if no update needed.',
    },
    newKeyfacts: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Key-value pairs of structured facts extracted from the conversation.',
    },
    reassignTo: {
      type: 'object',
      description: 'If the ticket should be transferred to another role, specify here.',
      properties: {
        roles: { type: 'array', items: { type: 'string' }, description: 'Target role(s)' },
        kind: { type: 'string', description: 'Ticket kind/category' },
      },
      additionalProperties: false,
    },
    parts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind'],
        oneOf: [
          { properties: { kind: { const: 'text' }, text: { type: 'string' } } },
          { properties: { kind: { const: 'file' }, file_token: { type: 'string' }, file_uri: { type: 'string' }, name: { type: 'string' } } },
          { properties: { kind: { const: 'data' }, data: { type: 'object' } } },
        ],
      },
      description: 'Structured content parts.',
    },
  },
};

// ---------------------------------------------------------------------------
// Config resolution — universal fields only, no backend-specific flags.
// Backend-specific args (--allowed-tools, --effort, etc.) belong in the
// domain's backends.<name>.args TOML config.
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  prompt: string;
  /** Base CLI args from defaultDomain (backend-agnostic). */
  args: string[];
  timeout: number;
  model?: string;
  toolRestrictions: string;
}

function resolveDomainConfig(ctx: ProcessContext): ResolvedConfig {
  const cfg = ctx.config;
  const def = cfg.executor?.defaultDomain;
  const domMap = cfg.domains;
  const domList = ctx.domains || [];

  const basePrompt = cfg.executor?.defaultDomain?.systemPrompt || cfg.executor?.prompt || '';
  const systemPrompt = basePrompt || 'You are a technical support agent.';
  let prompt = systemPrompt;
  let args = def?.args ?? [];
  let timeout = def?.timeout ?? 600;
  let model: string | undefined;
  let domainPrompt: string | undefined;
  let domainSecurity: string | undefined;

  const apply = (dc: DomainConfig, isDomainSpecific = false) => {
    if (isDomainSpecific) {
      if (dc.systemPrompt) domainPrompt = dc.systemPrompt;
      if (dc.securityPrompt) domainSecurity = dc.securityPrompt;
    } else {
      if (dc.systemPrompt && domainPrompt === undefined) domainPrompt = dc.systemPrompt;
      if (dc.securityPrompt && domainSecurity === undefined) domainSecurity = dc.securityPrompt;
    }
    if (dc.args) args = dc.args;
    if (dc.timeout !== undefined) timeout = dc.timeout;
    if (dc.model) model = dc.model;
  };

  if (def) apply(def, false);
  if (domMap && domList.length > 0) {
    for (const d of domList) { if (domMap[d]) apply(domMap[d], true); }
  }

  // Merge domain prompt + security into a single system prompt string
  // (used by buildPrompt, not as CLI args).
  const appendParts: string[] = [];
  if (domainPrompt) appendParts.push(domainPrompt);
  if (domainSecurity) appendParts.push(`## Security Guidelines\n${domainSecurity}`);
  const mergedSystemPrompt = appendParts.length > 0 ? [...prompt.split('\n## ')[0] ? [appendParts.join('\n\n')] : []] : [];

  return { prompt, args, timeout, model, toolRestrictions: '' };
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildPrompt(ctx: ProcessContext, overridePrompt?: string, toolRestrictions?: string): string {
  const { ticket, turns, config } = ctx;
  const fields = ticket.fields;
  let keyfacts: Record<string, string> = {};
  try { keyfacts = JSON.parse(String(fields[FLD.keyfacts] ?? '{}')); } catch { /* ignore */ }

  const conversation = turns.map((t) => {
    const role = extractText(t.fields[FLD.role]);
    const partsRaw = extractText(t.fields[FLD.parts]);
    if (partsRaw) {
      try {
        const parts: Part[] = JSON.parse(partsRaw);
        const text = parts.map((p) => {
          switch (p.kind) {
            case 'text': return p.text;
            case 'file': return `[attachment: ${p.name ?? 'file'}](${p.file_uri})`;
            case 'data': return `[data: ${JSON.stringify(p.data)}]`;
            default: return '';
          }
        }).join('\n');
        return `[${role}]\n${text}`;
      } catch { /* fall through */ }
    }
    return `[${role}]\n${extractText(t.fields[FLD.content])}`;
  });

  let lastAgentIdx = -1;
  for (let i = 0; i < turns.length; i++) {
    if (extractText(turns[i].fields[FLD.role]) === 'agent') lastAgentIdx = i;
  }
  const unanswered = turns.filter((t, i) => i > lastAgentIdx && extractText(t.fields[FLD.role]) === 'user');
  const unansweredText = unanswered.length
    ? `The following user message(s) have not yet been answered. Your reply MUST address these messages:\n${
        unanswered.map((t) => {
          const partsRaw = extractText(t.fields[FLD.parts]);
          if (partsRaw) {
            try {
              const parts: Part[] = JSON.parse(partsRaw);
              return '- ' + parts.map(p => p.kind === 'text' ? p.text : '[attachment]').join(' ');
            } catch { /* fallthrough */ }
          }
          return `- ${extractText(t.fields[FLD.content])}`;
        }).join('\n')
      }`
    : '(all messages have been addressed)';

  let attachmentsBlock = '';
  const dlAttachments = ctx.downloadedAttachments;
  if (dlAttachments && Object.keys(dlAttachments).length > 0) {
    const lines = Object.entries(dlAttachments).map(([token, path]) => `- ${path} (file_token: ${token})`);
    attachmentsBlock = `## Attachments (available on disk)\n${lines.join('\n')}\n\nUse the file paths above to read file content or view images. They were extracted from user messages.`;
  }

  const sysPrompt = ctx.config.executor?.defaultDomain?.systemPrompt || ctx.config.executor?.prompt || 'You are a technical support agent.';
  return [
    ctx.globalPrompt ? `## Rules & Output Schema (from Channel)\n${ctx.globalPrompt}` : '',
    '## Agent Instructions',
    overridePrompt || sysPrompt,
    toolRestrictions || '',
    '',
    '## Ticket Context',
    `Summary: ${extractText(fields[FLD.summary])}`,
    '(Note: summary is a rough approximation for reference. Base your reply on the conversation content below.)',
    `Key Facts: ${JSON.stringify(keyfacts, null, 2)}`,
    '',
    '### Conversation',
    conversation.length ? conversation.join('\n\n') : '(no conversation history)',
    '',
    '### Unanswered User Messages',
    unansweredText,
    attachmentsBlock ? '\n' + attachmentsBlock : '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Output parser
// ---------------------------------------------------------------------------

const FENCE_PREFIX_RE = /^```(?:json)?\s*\n?/i;
const FENCE_SUFFIX_RE = /\n?```\s*$/;

function parseSubAgentOutput(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const outer = JSON.parse(raw);
    if (typeof outer === 'object' && outer !== null && typeof outer.result === 'string') return parseInner(outer.result);
    if (typeof outer === 'object' && outer !== null) return outer;
  } catch { /* fall through */ }
  return parseInner(raw);
}

function normalizeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const keyMap: Record<string, string> = { new_summary: 'newSummary', new_keyfacts: 'newKeyfacts' };
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) result[keyMap[k] ?? k] = v;
  return result;
}

function parseInner(text: string): Record<string, unknown> | null {
  let cleaned = text.trim();
  cleaned = cleaned.replace(FENCE_PREFIX_RE, '').replace(FENCE_SUFFIX_RE, '').trim();
  try { return normalizeKeys(JSON.parse(cleaned)); } catch { /* try extraction */ }
  // Try extracting content between { and } as last resort
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}') + 1;
  if (start >= 0 && end > start) {
    const candidate = cleaned.slice(start, end);
    try { return normalizeKeys(JSON.parse(candidate)); } catch { /* try regex */ }
  }
  return extractFields(cleaned);
}

function extractFields(text: string): Record<string, unknown> | null {
  const answer = extractJsonField(text, 'answer');
  const summary = extractJsonField(text, 'newSummary') || extractJsonField(text, 'new_summary') || extractJsonField(text, 'summary');
  if (!answer) return null;
  const result: Record<string, unknown> = { answer };
  if (summary) result.newSummary = summary;
  return result;
}

function extractJsonField(text: string, field: string): string | null {
  const strictRe = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 's');
  let match = text.match(strictRe);
  if (match) return match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  const lenientRe = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.|"(?!\\s*[,}]))*)"\\s*[,}]`, 's');
  match = text.match(lenientRe);
  if (match) return match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  return null;
}

// ---------------------------------------------------------------------------
// KekkaiProcessor — implements Processor using Kekkai backend runner
// ---------------------------------------------------------------------------

export class KekkaiProcessor implements Processor {
  private abortController = new AbortController();
  private retrying = false;

  constructor(cfg: Config) {
    this.initKekkai(cfg);
  }

  private initKekkai(cfg: Config): void {
    const domainNames = cfg.executor?.domains ?? Object.keys(cfg.domains ?? {});
    for (const name of domainNames) {
      if (Kekkai.has(name)) continue;
      const dc = cfg.domains?.[name] ?? cfg.executor?.defaultDomain ?? {};
      const backends: Record<string, { command?: string; args?: string[] }> = {};
      for (const [bk, bv] of Object.entries(dc.backends ?? {})) {
        backends[bk] = { command: bv.command, args: bv.args };
      }
      // Legacy flat field — create backend entry matching the command
      if (Object.keys(backends).length === 0 && dc.command) {
        const backendName = dc.command === 'claude' ? 'claude' : 'raw';
        backends[backendName] = { command: dc.command, args: dc.args };
      }
      if (Object.keys(backends).length === 0) {
        backends.claude = { command: 'claude', args: dc.args };
      }
      const defaultBackend = dc.backend || Object.keys(backends)[0];
      const bc = dc.backends?.[defaultBackend];
      Kekkai.create(name, {
        defaultBackend,
        backends,
        timeouts: { wall: (bc?.timeout ?? dc.timeout ?? 600) * 1000 },
      });
    }
  }

  abort(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  async process(ctx: ProcessContext): Promise<ProcessResult | null> {
    const resolved = resolveDomainConfig(ctx);
    const prompt = buildPrompt(ctx, resolved.prompt, resolved.toolRestrictions);
    const cfg = ctx.config;
    const ticketId = String(ctx.ticket.record_id ?? 'unknown');
    const roundId = ctx.roundId || 'unknown';
    const sessionDir = cfg.executor?.sessionDir;

    // Session UUID for multi-turn resume
    let resumeUuid: string | null = null;
    if (sessionDir) {
      const ticketDir = join(sessionDir, ticketId);
      if (!existsSync(ticketDir)) mkdirSync(ticketDir, { recursive: true });
      const uuidFile = join(ticketDir, 'session.uuid');
      if (existsSync(uuidFile)) resumeUuid = readFileSync(uuidFile, 'utf-8').trim();
    }

    // Session log for dashboard
    let sessionLogPath: string | null = null;
    if (sessionDir) {
      const ticketDir = join(sessionDir, ticketId);
      sessionLogPath = join(ticketDir, `${roundId}.jsonl`);
    }
    const logLine = (obj: Record<string, unknown>) => {
      if (!sessionLogPath) return;
      try { appendFileSync(sessionLogPath, JSON.stringify({ ...obj, timestamp: new Date().toISOString() }) + '\n'); } catch { /* */ }
    };

    const userTurns = ctx.turns
      .filter(t => extractText(t.fields[FLD.role]) === 'user')
      .slice(-5)
      .map(t => ({ role: 'user', content: extractText(t.fields[FLD.content]).slice(0, 300) }));
    logLine({ type: 'execution-start', ticketId, roundId, promptLength: prompt.length, prompt, userTurns, resumeUuid });

    const startTime = Date.now();
    const domainName = ctx.domains?.[0] || 'general';

    try {
      logLine({ type: '@typooo/kekkai-start', domain: domainName });
      console.log(`[processor] calling Kekkai.stream domain=${domainName} resume=${!!resumeUuid}`);
      const events: import('@typooo/kekkai').RuntimeEvent[] = [];
      for await (const ev of Kekkai.stream(domainName, {
        agentId: roundId || ticketId,
        prompt,
        signal: this.abortController.signal,
        schema: OUTPUT_SCHEMA,
        resumeSessionId: resumeUuid ?? undefined,
        resumeOrRestart: true,
        overrides: {
          args: resolved.args,
          model: resolved.model,
          permissions: { profile: 'full' },
        },
      })) {
        events.push(ev);
        logLine(ev as any);
        if (ev.type === 'message') {
          ctx.onStream?.((ev as any).content ?? '', 'message');
          console.log(`[processor]  message: ${(ev as any).content?.slice(0, 200)}`);
        } else if (ev.type === 'thinking') {
          ctx.onStream?.((ev as any).content ?? '', 'thinking');
          console.log(`[processor]  thinking: ${(ev as any).content?.slice(0, 100)}`);
        } else if (ev.type === 'tool_use') {
          console.log(`[processor]  tool_use: ${(ev as any).tool}`);
        } else if (ev.type === 'tool_result') {
          console.log(`[processor]  tool_result: ${(ev as any).tool}`);
        } else if (ev.type === 'error') {
          console.log(`[processor]  error: ${(ev as any).message}`);
        } else if (ev.type === 'status') {
          // skip console log
        } else if (ev.type === 'run_end') {
          console.log(`[processor]  run_end: status=${(ev as any).status} outputLen=${((ev as any).output ?? '').length} hasStructured=${!!(ev as any).structured}`);
        } else {
          console.log(`[processor]  ${ev.type}`);
        }
      }

      // Rebuild RunResult from events (same as Kekkai.run())
      const runEnd = events.filter(e => e.type === 'run_end')[0] as any;
      const sessionId = events.find((e: any) => e.type === 'status' && e.sessionId) as any;
      const result: import('@typooo/kekkai').RunResult = {
        runId: runEnd?.runId ?? '',
        agentId: '',
        backend: runEnd?.backend ?? '',
        status: runEnd?.status ?? 'failed',
        output: runEnd?.output ?? '',
        durationMs: runEnd?.durationMs ?? 0,
        error: runEnd?.error,
        sessionId: sessionId?.sessionId,
      };

      // Resume fallback: if session resume failed, delete stale UUID and retry
      if (resumeUuid && result.status === 'failed' && !this.retrying && sessionDir) {
        this.retrying = true;
        console.log(`[processor] session resume failed, retrying without resumeSessionId`);
        const uuidFile = join(sessionDir, ticketId, 'session.uuid');
        try { unlinkSync(uuidFile); } catch {}
        const retryResult = await this.process({ ...ctx, onStream: undefined });
        if (retryResult) retryResult.retried = true;
        return retryResult;
      }

      // Schema validation (same as Kekkai.run())
      if (OUTPUT_SCHEMA && result.output && result.status === 'completed') {
        const { tryParseLooseJson, validateSchema } = await import('@typooo/kekkai');
        const parsed = tryParseLooseJson(result.output);
        if (parsed === null) {
          result.error = 'Output is not valid JSON';
        } else {
          const validationError = validateSchema(OUTPUT_SCHEMA, parsed);
          if (validationError) {
            result.error = validationError;
          } else {
            result.structured = parsed;
          }
        }
      }

      console.log(`[processor] result: status=${result.status} outputLen=${result.output?.length ?? 0} hasStructured=${!!result.structured} error=${result.error ?? ''}`);

      // Save session UUID for next round
      if (result.sessionId && sessionDir) {
        const ticketDir = join(sessionDir, ticketId);
        if (!existsSync(ticketDir)) mkdirSync(ticketDir, { recursive: true });
        writeFileSync(join(ticketDir, 'session.uuid'), result.sessionId, 'utf-8');
      }

      console.log(`[processor] @typooo/kekkai result: status=${result.status} outputLen=${result.output?.length ?? 0} hasStructured=${!!result.structured} error=${result.error ?? ''}`);
      logLine({ type: '@typooo/kekkai-end', status: result.status, outputLen: result.output?.length, hasStructured: !!result.structured, durationMs: result.durationMs, error: result.error });

      // Parse structured output or fall back to legacy parser
      let processResult: ProcessResult;
      if (result.structured) {
        const s = result.structured as Record<string, unknown>;
        processResult = {
          answer: (s.answer as string) || '',
          newSummary: (s.newSummary as string) || '',
          newKeyfacts: (s.newKeyfacts as Record<string, string>) || {},
          reassignTo: s.reassignTo as { roles?: string[]; kind?: string } | undefined,
          parts: s.parts as Part[] | undefined,
        };
      } else if (result.output) {
        const parsed = parseSubAgentOutput(result.output);
        processResult = parsed ? {
          answer: (parsed.answer as string) || '',
          newSummary: (parsed.newSummary as string) || '',
          newKeyfacts: (parsed.newKeyfacts as Record<string, string>) || {},
        } : { answer: result.output, newSummary: '', newKeyfacts: {} };
      } else {
        processResult = { answer: '', newSummary: '', newKeyfacts: {} };
      }

      // Extract token usage and duration from events
      const usageEvents = events.filter((e: any) => e.type === 'usage');
      if (usageEvents.length > 0) {
        const total = usageEvents.reduce((acc: any, ev: any) => ({
          input: (acc.input || 0) + (ev.inputTokens || 0),
          output: (acc.output || 0) + (ev.outputTokens || 0),
          cacheRead: (acc.cacheRead || 0) + (ev.cacheReadTokens || 0),
          cacheWrite: (acc.cacheWrite || 0) + (ev.cacheWriteTokens || 0),
        }), {});
        if (total.input || total.output) {
          processResult.tokenUsage = {
            input: total.input,
            output: total.output,
            cacheRead: total.cacheRead,
            cacheWrite: total.cacheWrite,
          };
        }
      }
      processResult.durationMs = result.durationMs;

      logLine({ type: 'result', answer: processResult.answer.slice(0, 200) });
      this.retrying = false;
      return processResult;
    } catch (err: any) {
      logger.error('[processor] Kekkai run failed:', err.message);
      logLine({ type: 'error', message: err.message });
      this.retrying = false;
      return null;
    }
  }
}
