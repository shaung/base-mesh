import { logger } from './log.js';
// Feishu API helper — wraps fetch with consistent error logging.

export async function feishuFetch(
  url: string,
  init: RequestInit & { logLabel?: string },
): Promise<Record<string, unknown>> {
  const label = init.logLabel || url.split('/').pop() || 'api';
  delete init.logLabel;
  try {
    const resp = await fetch(url, init);
    const raw = await resp.text();
    if (resp.ok) {
      try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
    }
    // Error: print full response
    logger.error(`[api] ${label} HTTP ${resp.status}:`, raw.slice(0, 1000));
    return {};
  } catch (err: any) {
    logger.error(`[api] ${label} network error:`, err.message);
    return {};
  }
}
