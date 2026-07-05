import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

let currentLevel: number = LEVELS.info;

const LOG_DIR = join(homedir(), '.bam', 'logs');
const LOG_FILE = join(LOG_DIR, 'app.log');

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

export function setLogLevel(verbosity: number): void {
  if (verbosity >= 2) currentLevel = LEVELS.debug;
  else currentLevel = LEVELS.info;
}

// Keep a reference to the original console.log before enableFileLogging overrides it
let _consoleLog = console.log.bind(console);

function log(level: Level, ...args: unknown[]): void {
  if (LEVELS[level] < currentLevel) return;
  const msg = `[${new Date().toISOString()}] [${level}] ${args.join(' ')}`;
  try { ensureLogDir(); appendFileSync(LOG_FILE, msg + '\n'); } catch {}
  _consoleLog(msg);
}

export const logger = {
  debug: (...args: unknown[]) => log('debug', ...args),
  info: (...args: unknown[]) => log('info', ...args),
  warn: (...args: unknown[]) => log('warn', ...args),
  error: (...args: unknown[]) => log('error', ...args),
};

/** Redirect console.log/warn/error to append to log file.
 *  Call once at startup. The original console methods are preserved for
 *  stdout output — the redirect adds file logging on top. */
export function enableFileLogging(): void {
  ensureLogDir();
  const ts = () => new Date().toISOString();
  _consoleLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.log = (...args: unknown[]) => {
    try { appendFileSync(LOG_FILE, `[${ts()}] [log] ${args.join(' ')}\n`); } catch {}
    _consoleLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    try { appendFileSync(LOG_FILE, `[${ts()}] [warn] ${args.join(' ')}\n`); } catch {}
    origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    try { appendFileSync(LOG_FILE, `[${ts()}] [error] ${args.join(' ')}\n`); } catch {}
    origError(...args);
  };
}
