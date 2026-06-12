import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './log.js';
import { spawn } from 'node:child_process';
import { Config, DomainConfig, ProcessContext, ProcessResult, Processor, Part, FilePart } from './types.js';
import { extractText } from './text.js';
import { FLD } from './fields.js';

// ---------------------------------------------------------------------------
// Claude Code subprocess processor
// Uses --output-format stream-json for real-time structured event logging.
// ---------------------------------------------------------------------------

const FENCE_PREFIX_RE = /^```(?:json)?\s*\n?/i;
const FENCE_SUFFIX_RE = /\n?```\s*$/;

export class ClaudeProcessor implements Processor {
  private systemPrompt: string;
  private activeProc: ReturnType<typeof spawn> | null = null;

  constructor(cfg: Config) {
    const basePrompt = cfg.executor?.defaultDomain?.systemPrompt || cfg.executor?.prompt || '';
    this.systemPrompt = basePrompt || 'You are a technical support agent.';
  }

  /** Resolve effective config: global → default_domain → [domain.xxx] overrides. */
  private resolveDomainConfig(ctx: ProcessContext): {
    prompt: string;
    claudeArgs: string[];
    claudeTimeout: number;
    toolRestrictions: string;
  } {
    const cfg = ctx.config;
    const def = cfg.executor?.defaultDomain;
    const domMap = cfg.domains;
    const domList = ctx.domains || [];

    let prompt = this.systemPrompt;
    let claudeArgs = def?.args ?? ['--dangerously-skip-permissions'];
    let claudeTimeout = def?.timeout ?? 600;
    let allowedTools: string[] | undefined;
    let disallowedTools: string[] | undefined;
    let model: string | undefined;
    let effort: string | undefined;
    let fallbackModel: string | undefined;
    let maxBudgetUsd: number | undefined;
    let domainPrompt: string | undefined;
    let domainSecurity: string | undefined;

    // Helper: apply a DomainConfig, only setting values that are explicitly provided
    const apply = (dc: DomainConfig, isDomainSpecific = false) => {
      if (isDomainSpecific) {
        // Domain-specific config overrides — only set if explicitly provided
        if (dc.systemPrompt) domainPrompt = dc.systemPrompt;
        if (dc.securityPrompt) domainSecurity = dc.securityPrompt;
      } else {
        // default_domain — set as fallback if not already set by domain-specific
        if (dc.systemPrompt && domainPrompt === undefined) domainPrompt = dc.systemPrompt;
        if (dc.securityPrompt && domainSecurity === undefined) domainSecurity = dc.securityPrompt;
      }
      if (dc.args) claudeArgs = dc.args;
      if (dc.timeout !== undefined) claudeTimeout = dc.timeout;
      if (dc.allowedTools) allowedTools = dc.allowedTools;
      if (dc.disallowedTools) disallowedTools = dc.disallowedTools;
      if (dc.model) model = dc.model;
      if (dc.effort) effort = dc.effort;
      if (dc.fallbackModel) fallbackModel = dc.fallbackModel;
      if (dc.maxBudgetUsd !== undefined) maxBudgetUsd = dc.maxBudgetUsd;
    };

    // Apply default_domain first (lower priority)
    if (def) apply(def, false);
    // Apply domain-specific config (higher priority — overrides)
    if (domMap && domList.length > 0) {
      for (const d of domList) { if (domMap[d]) apply(domMap[d], true); }
    }

    // Build single --append-system-prompt from domain prompt + security
    const appendParts: string[] = [];
    if (domainPrompt) appendParts.push(domainPrompt);
    if (domainSecurity) appendParts.push(`## Security Guidelines\n${domainSecurity}`);
    const appendSystemPrompt = appendParts.length > 0 ? appendParts.join('\n\n') : undefined;

    if (allowedTools?.length) claudeArgs = [...claudeArgs, '--allowed-tools', ...allowedTools];
    if (disallowedTools?.length) claudeArgs = [...claudeArgs, '--disallowed-tools', ...disallowedTools];
    if (model) claudeArgs = [...claudeArgs, '--model', model];
    if (effort) claudeArgs = [...claudeArgs, '--effort', effort];
    if (fallbackModel) claudeArgs = [...claudeArgs, '--fallback-model', fallbackModel];
    if (maxBudgetUsd !== undefined) claudeArgs = [...claudeArgs, '--max-budget-usd', String(maxBudgetUsd)];
    if (appendSystemPrompt) claudeArgs = [...claudeArgs, '--append-system-prompt', appendSystemPrompt];

    return { prompt, claudeArgs, claudeTimeout, toolRestrictions: '' };
  }

  abort(): void {
    if (this.activeProc) {
      try { this.activeProc.kill('SIGKILL'); } catch { /* already dead */ }
      this.activeProc = null;
    }
  }

  buildPrompt(ctx: ProcessContext, overridePrompt?: string, toolRestrictions?: string): string {
    const { ticket, turns, config } = ctx;
    const fields = ticket.fields;
    let keyfacts: Record<string, string> = {};
    try {
      keyfacts = JSON.parse(String(fields[FLD.keyfacts] ?? '{}'));
    } catch { /* ignore */ }

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
      ? `The following user message(s) have not yet been answered. Your aiCommand output MUST reply directly to these messages:\n${
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
      const lines = Object.entries(dlAttachments).map(
        ([token, path]) => `- ${path} (file_token: ${token})`,
      );
      attachmentsBlock = `## Attachments (available on disk)\n${lines.join('\n')}\n\nUse the file paths above to read file content or view images. They were extracted from user messages.`;
    }

    return [
      ctx.globalPrompt ? `## Rules & Output Schema (from Channel)\n${ctx.globalPrompt}` : '',
      '## Agent Instructions',
      overridePrompt || this.systemPrompt,
      toolRestrictions || '',
      '',
      '## Ticket Context',
      `Summary: ${extractText(fields[FLD.summary])}`,
      '(Note: summary is a rough approximation generated by the previous agent turn, for reference only. Base your reply on the actual conversation content below, not on this summary.)',
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

  async process(ctx: ProcessContext): Promise<ProcessResult | null> {
    // Resolve per-ability config: defaults + ability-specific overrides
    const resolved = this.resolveDomainConfig(ctx);
    const prompt = this.buildPrompt(ctx, resolved.prompt, resolved.toolRestrictions);
    const cfg = ctx.config;
    const claudeArgs = resolved.claudeArgs;
    const claudeTimeout = resolved.claudeTimeout;

    const dlAttachments = ctx.downloadedAttachments;
    if (dlAttachments) {
      for (const path of Object.values(dlAttachments)) {
        console.log(`[processor] attachment: ${path}`);
      }
    }

    const ticketId = String(ctx.ticket.record_id ?? 'unknown');
    const roundId = ctx.roundId || 'unknown';
    const sessionDir = cfg.executor?.sessionDir;

    // Per-ticket stable UUID for session reuse via --resume.
    // First round creates a new session (no --resume). Subsequent rounds
    // resume the session ID that Claude wrote to session.uuid.
    let resumeUuid: string | null = null;
    if (sessionDir) {
      const ticketDir = join(sessionDir, ticketId);
      if (!existsSync(ticketDir)) mkdirSync(ticketDir, { recursive: true });
      const uuidFile = join(ticketDir, 'session.uuid');
      if (existsSync(uuidFile)) {
        resumeUuid = readFileSync(uuidFile, 'utf-8').trim();
      }
    }

    // Session log path for dashboard
    let sessionLogPath: string | null = null;
    if (sessionDir) {
      const ticketDir = join(sessionDir, ticketId);
      sessionLogPath = join(ticketDir, `${roundId}.jsonl`);
    }
    const logLine = (obj: Record<string, unknown>) => {
      if (!sessionLogPath) return;
      try { appendFileSync(sessionLogPath, JSON.stringify({ ...obj, timestamp: new Date().toISOString() }) + '\n'); } catch { /* */ }
    };

    const startTime = Date.now();
    const userTurns = ctx.turns
      .filter(t => extractText(t.fields[FLD.role]) === 'user')
      .slice(-5)
      .map(t => ({ role: 'user', content: extractText(t.fields[FLD.content]).slice(0, 300) }));
    logLine({ type: 'execution-start', ticketId, roundId, promptLength: prompt.length, prompt, userTurns, resumeUuid });

    return new Promise((resolve) => {
      // --output-format stream-json for real-time structured event streaming
      const dd = cfg.executor?.defaultDomain;
      const promptFlag = dd?.promptFlag ?? '-p';
      const aiCmd = dd?.command ?? 'claude';
      const cliArgs: string[] = [promptFlag, prompt, '--output-format', 'stream-json', '--verbose'];
      if (resumeUuid) cliArgs.push('--resume', resumeUuid);
      cliArgs.push(...claudeArgs);

      const proc = spawn(aiCmd, cliArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: claudeTimeout * 1000,
      });
      this.activeProc = proc;

      let lastAnswer = '';
      let lastSummary = '';
      let lastResult: ProcessResult | null = null;
      let stderrBuf = '';

      // Pipe stderr to parent + session log (captures exit code 1 details)
      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        process.stderr.write(chunk);
        stderrBuf += text;
        // Log stderr lines >20 chars to session for debugging (skip trivial progress chars)
        for (const line of text.split('\n').filter((l: string) => l.trim().length > 20)) {
          logLine({ type: 'stderr', text: line.trim() });
        }
      });

      let buf = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        // Process complete lines only
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            logLine(ev);
            // Save Claude's session_id for --resume on subsequent rounds
            if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
              if (sessionDir) {
                const uuidFile = join(sessionDir, ticketId, 'session.uuid');
                try { writeFileSync(uuidFile, ev.session_id, 'utf-8'); } catch { /* */ }
              }
            }
            // Capture final result
            if (ev.type === 'result') {
              const resultText = ev.result || ev.structured_output || '';
              if (resultText) {
                const parsed = parseSubAgentOutput(typeof resultText === 'string' ? resultText : JSON.stringify(resultText));
                if (parsed && (parsed.answer || parsed.newSummary)) {
                  lastAnswer = (parsed.answer as string) || '';
                  lastSummary = (parsed.newSummary as string) || (parsed.new_summary as string) || '';
                  lastResult = {
                    answer: lastAnswer,
                    newSummary: lastSummary,
                    newKeyfacts: (parsed.newKeyfacts as Record<string, string>) || (parsed.new_keyfacts as Record<string, string>) || {},
                  };
                  if (parsed.reassignTo && typeof parsed.reassignTo === 'object') {
                    const rt = parsed.reassignTo as Record<string, unknown>;
                    lastResult.reassignTo = {};
                    if (Array.isArray(rt.roles)) lastResult.reassignTo!.roles = rt.roles as string[];
                    if (typeof rt.kind === 'string') lastResult.reassignTo!.kind = rt.kind as string;
                  }
                } else {
                  // Claude didn't follow JSON schema — use raw output, no summary/keyfacts update
                  const raw = typeof resultText === 'string' ? resultText : JSON.stringify(resultText);
                  lastAnswer = raw;
                  lastResult = { answer: raw, newSummary: undefined as unknown as string, newKeyfacts: undefined as unknown as Record<string, string> };
                }
              }
            }
          } catch { /* skip unparseable lines */ }
        }
      });

      proc.on('close', (code) => {
        this.activeProc = null;
        const elapsedMs = Date.now() - startTime;
        // Include stderr in execution-end for post-mortem error analysis
        const stderrTail = stderrBuf.length > 0 ? stderrBuf.slice(-2000) : undefined;
        logLine({ type: 'execution-end', exitCode: code, elapsedMs, stderrTail });

        if (code !== 0) {
          logger.error(`[processor] claude exited ${code}`);
          logLine({ type: 'error', message: `exit code ${code}` });
          resolve(null);
          return;
        }

        if (lastResult) {
          logLine({ type: 'result', parsed: true, answer: lastAnswer, summary: lastSummary });
        } else {
          logLine({ type: 'result', parsed: false });
          lastResult = { answer: '', newSummary: '', newKeyfacts: {} };
        }

        resolve(lastResult);
      });

      proc.on('error', (err) => {
        logger.error(`[processor] spawn failed: ${err.message}`);
        this.activeProc = null;
        logLine({ type: 'error', message: `spawn failed: ${err.message}` });
        resolve(null);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Output parser
// ---------------------------------------------------------------------------

function parseSubAgentOutput(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const outer = JSON.parse(raw);
    if (typeof outer === 'object' && outer !== null && typeof outer.result === 'string') {
      return parseInner(outer.result);
    }
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
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}') + 1;
  if (start >= 0 && end > start) {
    const candidate = cleaned.slice(start, end);
    try { return normalizeKeys(JSON.parse(candidate)); } catch { /* try loose */ }
    try { return normalizeKeys(JSON.parse(looseJsonClean(candidate))); } catch { /* try regex */ }
  }
  return extractFields(cleaned);
}

function looseJsonClean(text: string): string {
  const inString = (i: number): boolean => {
    let escaped = false;
    for (let j = i - 1; j >= 0; j--) {
      if (text[j] === '\\') escaped = !escaped;
      else return escaped;
    }
    return false;
  };
  let result = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && !inString(i)) {
      if (inQuotes) {
        // Inside a string value, found an unescaped double quote.
        // Check whether it's the structural closing quote (followed by , or } after optional whitespace)
        // or an unescaped content quote that needs escaping.
        const lookahead = text.slice(i + 1).trimStart();
        if (lookahead[0] === ',' || lookahead[0] === '}' || lookahead[0] === ']') {
          // Structural — end the string
          inQuotes = false;
          result += '"';
        } else {
          // Content quote — escape it so JSON.parse won't choke
          result += '\\"';
        }
      } else {
        // Opening quote
        inQuotes = true;
        result += '"';
      }
      continue;
    }
    if (inQuotes && (ch === '\n' || ch === '\r')) {
      result += ch === '\n' ? '\\n' : '\\r';
    } else {
      result += ch;
    }
  }
  return result;
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
  // Try strict regex first (handles properly escaped JSON)
  const strictRe = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 's');
  let match = text.match(strictRe);
  if (match) return match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  // Fallback: allow unescaped quotes inside the value by anchoring on the
  // structural closing quote (followed by optional whitespace then , or })
  // A content " that is NOT immediately followed by , or } (after ws) is treated
  // as part of the value rather than the closing delimiter.
  const lenientRe = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.|"(?!\\s*[,}]))*)"\\s*[,}]`, 's');
  match = text.match(lenientRe);
  if (match) return match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  return null;
}
