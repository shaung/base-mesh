import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Domain, IntentConfig } from './intent.js';

// Import functions under test
import {
  validateDomains,
  parseDomainTag,
  intersectDomains,
  formatDomainsForPrompt,
  recognize,
  processMessage,
  callLLM,
} from './intent.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KNOWN_DOMAINS: Domain[] = [
  { domain: 'general', description: 'General inquiries' },
  { domain: 'tech_support', description: 'Technical support' },
  { domain: 'billing', description: 'Billing and payments' },
];

const BASE_CONFIG: IntentConfig = {
  provider: 'deepseek',
  apiKey: 'test-key',
  model: 'test-model',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mock global fetch to return a specific JSON body. */
function mockFetch(responseBody: unknown, ok = true) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(responseBody),
    text: () => Promise.resolve(JSON.stringify(responseBody)),
  } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateDomains', () => {
  it('filters LLM result against known domains', () => {
    const result = validateDomains(['tech_support', 'nonexistent'], KNOWN_DOMAINS);
    expect(result).toEqual(['tech_support']);
  });

  it('falls back to ["general"] when no labels match known domains', () => {
    const result = validateDomains(['bogus_label'], KNOWN_DOMAINS);
    expect(result).toEqual(['general']);
  });

  it('falls back to ["general"] when raw is not an array', () => {
    expect(validateDomains(null, KNOWN_DOMAINS)).toEqual(['general']);
    expect(validateDomains('string', KNOWN_DOMAINS)).toEqual(['general']);
    expect(validateDomains(123, KNOWN_DOMAINS)).toEqual(['general']);
    expect(validateDomains(undefined, KNOWN_DOMAINS)).toEqual(['general']);
    expect(validateDomains({}, KNOWN_DOMAINS)).toEqual(['general']);
  });

  it('falls back to ["general"] when raw is empty array', () => {
    const result = validateDomains([], KNOWN_DOMAINS);
    expect(result).toEqual(['general']);
  });

  it('preserves only valid labels when some match', () => {
    const result = validateDomains(['general', 'tech_support', 'fraud'], KNOWN_DOMAINS);
    expect(result).toEqual(['general', 'tech_support']);
  });
});

describe('parseDomainTag', () => {
  it('parses tag at start of message', () => {
    const result = parseDomainTag('#tech_support my laptop is broken', KNOWN_DOMAINS);
    expect(result).toEqual({ tag: 'tech_support', cleaned: 'my laptop is broken' });
  });

  it('parses tag at end of message', () => {
    const result = parseDomainTag('my laptop is broken #tech_support', KNOWN_DOMAINS);
    expect(result).toEqual({ tag: 'tech_support', cleaned: 'my laptop is broken' });
  });

  it('returns null for unknown tag', () => {
    const result = parseDomainTag('#fraud someone stole my account', KNOWN_DOMAINS);
    expect(result).toBeNull();
  });

  it('returns null when no tag present', () => {
    const result = parseDomainTag('my laptop is broken', KNOWN_DOMAINS);
    expect(result).toBeNull();
  });

  it('uses tag as cleaned when message is only the tag', () => {
    const result = parseDomainTag('#tech_support', KNOWN_DOMAINS);
    expect(result).toEqual({ tag: 'tech_support', cleaned: 'tech_support' });
  });

  it('handles dot-separated domain labels', () => {
    const customDomains: Domain[] = [
      { domain: 'finance.reimburse', description: 'Reimbursement' },
    ];
    const result = parseDomainTag('#finance.reimburse I need a refund', customDomains);
    expect(result).toEqual({ tag: 'finance.reimburse', cleaned: 'I need a refund' });
  });
});

describe('intersectDomains', () => {
  it('returns first matching domain', () => {
    const result = intersectDomains(['tech_support', 'billing'], KNOWN_DOMAINS);
    expect(result).toEqual(['tech_support']);
  });

  it('returns undefined when no match', () => {
    const result = intersectDomains(['fraud'], KNOWN_DOMAINS);
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    const result = intersectDomains([], KNOWN_DOMAINS);
    expect(result).toBeUndefined();
  });
});

describe('formatDomainsForPrompt', () => {
  it('formats domains with description', () => {
    const result = formatDomainsForPrompt(KNOWN_DOMAINS);
    expect(result).toBe([
      '- general: General inquiries',
      '- tech_support: Technical support',
      '- billing: Billing and payments',
    ].join('\n'));
  });

  it('returns fallback for empty domains', () => {
    const result = formatDomainsForPrompt([]);
    expect(result).toBe('No domains configured.');
  });
});

describe('callLLM', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns parsed JSON on success', async () => {
    mockFetch({
      choices: [{ message: { content: '{"domains":["tech_support"],"isComplete":true}' } }],
    });
    const result = await callLLM('system prompt', 'user message', { provider: 'deepseek', apiKey: 'key' });
    expect(result).toEqual({ domains: ['tech_support'], isComplete: true });
  });

  it('returns null on fetch error', async () => {
    mockFetch({}, false);
    const result = await callLLM('system', 'user', { provider: 'openai', apiKey: 'key' });
    expect(result).toBeNull();
  });

  it('returns null on JSON parse error', async () => {
    mockFetch({ content: [{ text: 'not json' }] }, true);
    const result = await callLLM('system', 'user', { provider: 'anthropic', apiKey: 'key' });
    expect(result).toBeNull();
  });
});

describe('recognize', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns validated domains from LLM response', async () => {
    mockFetch({
      choices: [{ message: { content: '{"domains":["tech_support"],"needsMoreInfo":false}' } }],
    });
    const result = await recognize('my computer is broken', KNOWN_DOMAINS, BASE_CONFIG);
    expect(result).toEqual({ domains: ['tech_support'], needsMoreInfo: false });
  });

  it('filters hallucinated domains', async () => {
    mockFetch({
      choices: [{ message: { content: '{"domains":["fraud_label"],"needsMoreInfo":false}' } }],
    });
    const result = await recognize('my computer is broken', KNOWN_DOMAINS, BASE_CONFIG);
    expect(result).toEqual({ domains: ['general'], needsMoreInfo: false });
  });

  it('falls to general when LLM returns empty domains', async () => {
    mockFetch({
      choices: [{ message: { content: '{"domains":[],"needsMoreInfo":true}' } }],
    });
    const result = await recognize('my computer is broken', KNOWN_DOMAINS, BASE_CONFIG);
    expect(result).toEqual({ domains: ['general'], needsMoreInfo: false });
  });

  it('falls to general on API error', async () => {
    mockFetch({}, false);
    const result = await recognize('my computer is broken', KNOWN_DOMAINS, BASE_CONFIG);
    expect(result).toEqual({ domains: ['general'], needsMoreInfo: false });
  });
});

describe('processMessage', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns validated domains and completeness info', async () => {
    mockFetch({
      choices: [{ message: { content: JSON.stringify({
        domains: ['tech_support'],
        isComplete: true,
        summary: 'Computer not turning on',
        missingFields: [],
      }) } }],
    });
    const result = await processMessage('my computer is broken', KNOWN_DOMAINS, 'previous chat', BASE_CONFIG);
    expect(result).toEqual({
      domains: ['tech_support'],
      isComplete: true,
      summary: 'Computer not turning on',
      missingFields: [],
    });
  });

  it('filters hallucinated domains', async () => {
    mockFetch({
      choices: [{ message: { content: JSON.stringify({
        domains: ['nonexistent_domain'],
        isComplete: true,
        summary: 'Test',
        missingFields: [],
      }) } }],
    });
    const result = await processMessage('test', KNOWN_DOMAINS, '', BASE_CONFIG);
    expect(result.domains).toEqual(['general']);
  });

  it('returns fallback defaults when LLM returns null', async () => {
    mockFetch({ choices: [{ message: { content: 'invalid json {' } }] });
    const result = await processMessage('test', KNOWN_DOMAINS, '', BASE_CONFIG);
    expect(result).toEqual({
      domains: ['general'],
      isComplete: true,
      summary: 'test',
      missingFields: [],
    });
  });

  it('uses config.systemPrompt when provided', async () => {
    let capturedSystemPrompt = '';
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      const body = JSON.parse(opts.body as string);
      capturedSystemPrompt = body.messages[0].content;
      return {
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '{"domains":["general"],"isComplete":true,"summary":"","missingFields":[]}' } }],
        }),
      };
    });
    await processMessage('test', KNOWN_DOMAINS, '', { ...BASE_CONFIG, systemPrompt: 'Custom prompt' });
    expect(capturedSystemPrompt).toContain('Custom prompt');
  });

  it('passes empty conversation as new conversation', async () => {
    let capturedUserMessage = '';
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      const body = JSON.parse(opts.body as string);
      capturedUserMessage = body.messages[1].content;
      return {
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '{"domains":["general"],"isComplete":true,"summary":"","missingFields":[]}' } }],
        }),
      };
    });
    await processMessage('test', KNOWN_DOMAINS, '', BASE_CONFIG);
    expect(capturedUserMessage).toContain('(new conversation)');
  });

  it('includes conversation history in prompt', async () => {
    let capturedUserMessage = '';
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      const body = JSON.parse(opts.body as string);
      capturedUserMessage = body.messages[1].content;
      return {
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '{"domains":["general"],"isComplete":true,"summary":"","missingFields":[]}' } }],
        }),
      };
    });
    await processMessage('my computer is broken', KNOWN_DOMAINS, 'User: hello\nAgent: hi', BASE_CONFIG);
    expect(capturedUserMessage).toContain('User: hello');
    expect(capturedUserMessage).toContain('my computer is broken');
    expect(capturedUserMessage).toContain('tech_support');
  });
});
