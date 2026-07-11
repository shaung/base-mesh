// ---------------------------------------------------------------------------
// Structured logger with readable console output
//
// Format per level:
//   info:    ▶ [hh:mm:ss] module       action       key=val key=val
//   success: ✓ [hh:mm:ss] module       action       key=val
//   warn:    ⚠ [hh:mm:ss] module       action       key=val
//   error:   ✘ [hh:mm:ss] module       action       error="message"
//   debug:   · [hh:mm:ss] module       action       key=val
// ---------------------------------------------------------------------------

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

function pad(s: string, n: number): string {
  return s + ' '.repeat(Math.max(1, n - s.length));
}

function fmt(module: string, action: string, data?: Record<string, unknown>): string {
  const kv = data
    ? Object.entries(data)
        .map(([k, v]) => {
          if (v == null) return `${k}=null`;
          if (typeof v === 'string') return `${k}=${v}`;
          if (typeof v === 'number' || typeof v === 'boolean') return `${k}=${v}`;
          return `${k}=${JSON.stringify(v)}`;
        })
        .join(' ')
    : '';
  const modulePad = pad(module, 18).slice(0, 18);
  const actionPad = pad(action, 22).slice(0, 22);
  return `${ts()} ${modulePad} ${actionPad} ${kv}`;
}

export const log = {
  info: (m: string, a: string, d?: Record<string, unknown>) =>
    console.log(' ▶', fmt(m, a, d)),

  success: (m: string, a: string, d?: Record<string, unknown>) =>
    console.log(' ✓', fmt(m, a, d)),

  warn: (m: string, a: string, d?: Record<string, unknown>) =>
    console.warn(' ⚠', fmt(m, a, d)),

  error: (m: string, a: string, d?: Record<string, unknown>, err?: unknown) => {
    const data = err ? { ...d, error: err instanceof Error ? err.message : String(err) } : d;
    console.error(' ✘', fmt(m, a, data));
  },

  debug: (m: string, a: string, d?: Record<string, unknown>) =>
    console.debug(' ·', fmt(m, a, d)),
};
