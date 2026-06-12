// ---------------------------------------------------------------------------
// Intent recognition — reads enabled capabilities from the Roles table and
// uses an LLM (via HTTP API) to classify user messages into ability labels.
//
// Designed as a stateless utility: Channel/Operator passes in the message
// and capabilities list, gets back structured intent.
//
// Supports Anthropic and OpenAI APIs via native fetch() — no @langchain/zod.
// ---------------------------------------------------------------------------

export interface Domain {
  /** Unique label, e.g. "tech_support" or "finance.reimburse" */
  domain: string;
  /** Human-readable description for LLM context */
  description: string;
}

export interface IntentResult {
  /** Matched ability labels, at least one entry (fallback: ["general"]) */
  domains: string[];
  /** Whether the user's message lacks enough detail */
  needsMoreInfo: boolean;
}

/** Combined result from a single LLM call covering both intent and completeness. */
export interface ProcessedMessage {
  /** Matched ability labels */
  domains: string[];
  /** Whether the user provided enough information */
  isComplete: boolean;
  /** Concise issue summary */
  summary: string;
  /** Missing info fields (when isComplete=false) */
  missingFields: string[];
}

export interface IntentConfig {
  provider: 'anthropic' | 'openai' | 'deepseek';
  apiKey: string;
  model?: string;
  /** Optional system prompt override for processMessage. */
  systemPrompt?: string;
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an intent classifier for a multi-agent support system. Given a list of available capabilities and a user message, determine the best-matching capability labels.

Rules:
- Output ONLY valid JSON, no markdown, no explanation.
- Match the most specific capability that fits the user's request.
- If the message is ambiguous or incomplete, set needsMoreInfo=true.
- At least one ability is required unless the user's intent is completely unclear (then use ["general"]).

Format:
{
  "domains": ["ability_label_1"],
  "needsMoreInfo": false
}`;

async function callAnthropic(
  apiKey: string,
  model: string,
  domainsStr: string,
  message: string,
): Promise<unknown> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Available capabilities:\n${domainsStr}\n\nUser message: ${message}`,
        },
      ],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Anthropic API ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = await resp.json() as { content: { text: string }[] };
  const text = json.content?.[0]?.text ?? '';
  return JSON.parse(text);
}

/** Call an OpenAI-compatible chat completions API (used by OpenAI, DeepSeek, etc.). */
async function callChatCompletions(
  apiKey: string,
  model: string,
  baseUrl: string,
  domainsStr: string,
  message: string,
): Promise<unknown> {
  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Available capabilities:\n${domainsStr}\n\nUser message: ${message}` },
      ],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`ChatCompletions API ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = await resp.json() as { choices: { message: { content: string } }[] };
  const text = json.choices?.[0]?.message?.content ?? '';
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Call the configured LLM with an arbitrary system prompt and user message,
 *  parse the response as JSON. Returns null on any failure. */
export async function callLLM(
  systemPrompt: string,
  userMessage: string,
  config: IntentConfig,
): Promise<unknown | null> {
  try {
    if (config.provider === 'anthropic') {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.model ?? 'claude-3-5-haiku-latest', max_tokens: 512, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] }),
      });
      if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error(`Anthropic ${resp.status}: ${t.slice(0, 200)}`); }
      const json = await resp.json() as { content: { text: string }[] };
      return JSON.parse(json.content?.[0]?.text ?? '');
    }
    const baseUrl = config.provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com';
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model ?? '', max_tokens: 512, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }] }),
    });
    if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error(`ChatCompletions ${resp.status}: ${t.slice(0, 200)}`); }
    const json = await resp.json() as { choices: { message: { content: string } }[] };
    return JSON.parse(json.choices?.[0]?.message?.content ?? '');
  } catch (err) {
    console.warn('[intent] callLLM failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Filter LLM-returned domain labels against the configured known-domains set.
 *  Unknown/hallucinated labels are dropped. Falls back to ['general'] if nothing
 *  matches. */
export function validateDomains(raw: unknown, knownDomains: Domain[]): string[] {
  if (!Array.isArray(raw)) return ['general'];
  const known = new Set(knownDomains.map(d => d.domain));
  const valid = raw.map(String).filter(d => known.has(d));
  return valid.length > 0 ? valid : ['general'];
}

/** Call the configured LLM and return structured intent. On any failure
 *  (network, parse, empty result) returns a safe fallback. */
export async function recognize(
  message: string,
  domains: Domain[],
  config: IntentConfig,
): Promise<IntentResult> {
  try {
    const domainsStr = domains
      .map(d => `- ${d.domain}: ${d.description}`)
      .join('\n');
    console.log('[intent] recognize domains:\n' + domainsStr + '\n---\nmessage:', message);

    let raw: unknown;
    if (config.provider === 'anthropic') {
      raw = await callAnthropic(config.apiKey, config.model ?? 'claude-3-5-haiku-latest', domainsStr, message);
    } else if (config.provider === 'deepseek') {
      raw = await callChatCompletions(config.apiKey, config.model ?? '', 'https://api.deepseek.com', domainsStr, message);
    } else {
      raw = await callChatCompletions(config.apiKey, config.model ?? 'gpt-4o-mini', 'https://api.openai.com', domainsStr, message);
    }

    const obj = raw as Record<string, unknown>;
    const domainResult = obj.domains;
    if (!Array.isArray(domainResult) || domainResult.length === 0) {
      return { domains: ['general'], needsMoreInfo: false };
    }
    return {
      domains: validateDomains(domainResult, domains),
      needsMoreInfo: Boolean(obj.needsMoreInfo),
    };
  } catch (err) {
    console.warn('[intent] LLM recognition failed, falling back to general:', err instanceof Error ? err.message : err);
    return { domains: ['general'], needsMoreInfo: false };
  }
}

const COMBINED_PROMPT = `You are an assistant for a multi-agent support system. Determine the best-matching capability labels and whether the user has provided enough information.

Respond in JSON only. Rules:
- abilities: select the most specific matching capability labels (at least one, use ["general"] if unsure)
- isComplete: true by default, only false if the message clearly lacks critical information (no desc of the issue at all)
- summary: a concise summary of the issue, max 20 words
- missingFields: list of what's missing in the user's language (only when isComplete=false), e.g. ["location", "order number"]

{"domains":["label"],"isComplete":true,"summary":"","missingFields":[]}`;

/** Single call combining intent recognition and completeness check.
 *  Returns safe defaults on any failure. */
export async function processMessage(
  message: string,
  domains: Domain[],
  conversation: string,
  config: IntentConfig,
): Promise<ProcessedMessage> {
  const domainsStr = domains.length > 0
    ? domains.map(d => `- ${d.domain}: ${d.description}`).join('\n')
    : 'No domains configured.';
  const userMessage = `User message: ${message}\n\nAvailable domains:\n${domainsStr}\n\nConversation:\n${conversation || '(new conversation)'}`;
  console.log('[intent] processMessage domains:\n' + domainsStr + '\n---');
  const systemPrompt = config.systemPrompt || COMBINED_PROMPT;
  const result = await callLLM(systemPrompt, userMessage, config);
  if (!result) return { domains: ['general'], isComplete: true, summary: message, missingFields: [] };
  const r = result as Record<string, unknown>;
  console.log('[intent] LLM response:', JSON.stringify(r));
  
  const domainsResult = r.domains;
  return {
    domains: validateDomains(domainsResult, domains),
    isComplete: r.isComplete !== false,
    summary: String(r.summary ?? message),
    missingFields: Array.isArray(r.missingFields) ? r.missingFields as string[] : [],
  };
}

/** Parse an explicit #domain tag from the start or end of a message.
 *  Returns the tag text (without #) or null. Only matches if it exists in
 *  the known domains list. */
export function parseDomainTag(
  message: string,
  knownDomains: Domain[],
): { tag: string; cleaned: string } | null {
  const trimmed = message.trim();
  const known = new Set(knownDomains.map(d => d.domain));

  // Try start: "#tech_support my message"
  const startMatch = trimmed.match(/^#([a-z][a-z0-9_.-]*)\s*(.*)/si);
  if (startMatch && known.has(startMatch[1])) {
    return { tag: startMatch[1], cleaned: startMatch[2].trim() || startMatch[1] };
  }

  // Try end: "my message #tech_support"
  const endMatch = trimmed.match(/(.*)\s+#([a-z][a-z0-9_.-]*)$/si);
  if (endMatch && known.has(endMatch[2])) {
    return { tag: endMatch[2], cleaned: endMatch[1].trim() || endMatch[2] };
  }

  return null;
}

/** Intersect resolved domain labels with known domains. If the resolved set
 *  is empty or no intersection, return undefined (caller defaults to general). */
export function intersectDomains(
  resolved: string[],
  knownDomains: Domain[],
): string[] | undefined {
  const known = new Set(knownDomains.map(d => d.domain));
  const matched = resolved.filter(d => known.has(d));
  return matched.length > 0 ? [matched[0]] : undefined;
}

/** Build a human-readable domains string for LLM context inclusion. */
export function formatDomainsForPrompt(domains: Domain[]): string {
  if (domains.length === 0) return 'No domains configured.';
  return domains.map(d => `- ${d.domain}: ${d.description}`).join('\n');
}
