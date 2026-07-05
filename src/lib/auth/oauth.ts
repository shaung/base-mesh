import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { StoredTokens, TokenProvider } from '../../lib/types.js';
import { getDomainConfig } from '../../lib/bitable/domain.js';

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

function configDir(): string {
  const env = process.env.XDG_CONFIG_HOME;
  const base = env ? env : join(homedir(), '.config');
  return join(base, 'bam');
}

function tokensPath(): string {
  return join(configDir(), 'tokens.json');
}

function loadTokensFile(): Record<string, StoredTokens> {
  try {
    const raw = readFileSync(tokensPath(), 'utf-8');
    return JSON.parse(raw) as Record<string, StoredTokens>;
  } catch {
    return {};
  }
}

function saveTokensFile(map: Record<string, StoredTokens>): void {
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(tokensPath(), JSON.stringify(map, null, 2));
  chmodSync(tokensPath(), 0o600);
}

export function loadStoredTokens(appId: string): StoredTokens | null {
  return loadTokensFile()[appId] ?? null;
}

export function saveStoredTokens(appId: string, tokens: StoredTokens): void {
  const map = loadTokensFile();
  map[appId] = tokens;
  saveTokensFile(map);
}

export function clearStoredTokens(appId: string): void {
  const map = loadTokensFile();
  delete map[appId];
  saveTokensFile(map);
}

// ---------------------------------------------------------------------------
// Token state machine (for UserTokenProvider)
// ---------------------------------------------------------------------------

type TokenState = 'valid' | 'expired' | 'needs_re_login';

function tokenState(tokens: StoredTokens): TokenState {
  if (Date.now() < tokens.expiresAt - 300_000) return 'valid';
  if (tokens.refreshToken) return 'expired';
  return 'needs_re_login';
}

// ---------------------------------------------------------------------------
// UserTokenProvider — manages a user_access_token obtained via OAuth PKCE
// ---------------------------------------------------------------------------

export class UserTokenProvider implements TokenProvider {
  private tokens: StoredTokens;
  private appId: string;
  private dc: ReturnType<typeof getDomainConfig>;

  private constructor(appId: string, tokens: StoredTokens) {
    this.appId = appId;
    this.tokens = tokens;
    this.dc = getDomainConfig(tokens.openApiDomain);
  }

  /** Restore from stored tokens; returns null if nothing stored or tokens incomplete */
  static fromStore(appId: string): UserTokenProvider | null {
    const stored = loadStoredTokens(appId);
    if (!stored || !stored.accessToken) return null;
    return new UserTokenProvider(appId, stored);
  }

  // -- TokenProvider interface ----------------------------------------------

  async getToken(): Promise<string> {
    const state = tokenState(this.tokens);
    if (state === 'valid') return this.tokens.accessToken;
    if (state === 'expired') {
      await this.refresh();
      return this.tokens.accessToken;
    }
    throw new Error('No refresh token available. Run `bam login` to re-authorize.');
  }

  // -- Refresh --------------------------------------------------------------

  private async refresh(): Promise<void> {
    const resp = await fetch(`${this.dc.sdkBaseUrl}/open-apis/authen/v1/oidc/refresh_access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: this.appId,
        refresh_token: this.tokens.refreshToken,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status === 400 || resp.status === 401) {
        clearStoredTokens(this.appId);
        throw new Error('Session expired. Run `bam login` to re-authorize.');
      }
      throw new Error(`Token refresh failed (${resp.status}): ${text}`);
    }

    const body = await resp.json() as any;
    const data = body.data ?? body;
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? this.tokens.refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
      scope: data.scope,
      userId: data.open_id || this.tokens.userId,
      userName: data.name || this.tokens.userName,
      openApiDomain: this.tokens.openApiDomain,
    };
    saveStoredTokens(this.appId, this.tokens);
  }

  // -- Login (PKCE flow) ----------------------------------------------------

  /**
   * Interactive OAuth PKCE login.
   *
   * 1. Start a local HTTP server on a fixed port (21721, +1 if busy)
   * 2. Open browser to the OAuth authorize page with PKCE challenge
   * 3. User authorizes → browser redirects to localhost
   * 4. Exchange auth code (+ code_verifier) for tokens (NO app_secret)
   * 5. Store tokens, return UserTokenProvider
   *
   * The redirect URI must match what's configured in the app →
   * Redirect URLs settings. Add: http://localhost:21721/callback
   */
  static async login(appId: string, openApiDomain?: string): Promise<UserTokenProvider> {
    const dc = getDomainConfig(openApiDomain);
    const verifier = base64url(randomBytes(64));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(32));

    const tokens = await new Promise<StoredTokens>((resolve, reject) => {
      const server = createServer((req, res) => {
        if (!req.url?.startsWith('/callback')) {
          res.writeHead(404);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');

        if (!code || returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>Authorization failed</h1><p>Invalid state or missing code. Close this tab and try again.</p>');
          reject(new Error('OAuth callback validation failed'));
          return;
        }

        // Respond immediately so the user sees success
        res.writeHead(200, { 'Content-Type': 'text/html', 'Connection': 'close' });
        res.end('<h1>Authorized!</h1><p>You can close this tab and return to the terminal.</p>');

        // Shutdown server, then exchange code
        server.close(() => {
          exchangeCode(appId, code, verifier, CALLBACK_URI, dc)
            .then(resolve, reject);
        });
        server.closeAllConnections?.();
      });

      // Try fixed port first, fallback +1 if busy
      tryListen(server, LOGIN_PORT, (port) => {
        const authorizeUrl =
          `https://${dc.accounts}/open-apis/authen/v1/authorize` +
          `?client_id=${encodeURIComponent(appId)}` +
          `&redirect_uri=${encodeURIComponent(`http://localhost:${port}/callback`)}` +
          `&response_type=code` +
          `&scope=${encodeURIComponent('bitable:app offline_access')}` +
          `&code_challenge=${encodeURIComponent(challenge)}` +
          `&code_challenge_method=S256` +
          `&state=${encodeURIComponent(state)}`;

        console.log(`\nOpening browser for authorization...`);
        console.log(`If the browser doesn't open, visit this URL:\n  ${authorizeUrl}\n`);
        openBrowser(authorizeUrl);
      }, reject);
    });

    return new UserTokenProvider(appId, tokens);
  }
}

// ---------------------------------------------------------------------------
// PKCE token exchange  (POST to OIDC token endpoint, NO client_secret)
// ---------------------------------------------------------------------------

async function exchangeCode(
  appId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  dc: ReturnType<typeof getDomainConfig>,
): Promise<StoredTokens> {
  const resp = await fetch(`${dc.sdkBaseUrl}/open-apis/authen/v1/oidc/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: appId,
      app_id: appId,
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  const body = await resp.json() as any;
  // Feishu API wraps responses in { code, data }. Unwrap if needed.
  const data = body.data ?? body;
  if (!data.access_token) {
    throw new Error(`Token exchange returned no access_token. Raw: ${JSON.stringify(data).slice(0, 500)}`);
  }

  let userId = data.open_id || undefined;
  let unionId = data.union_id || undefined;
  let userName = data.name || undefined;

  // If the token response didn't include user info, fetch it separately
  if (!userId && data.access_token) {
    try {
      const userResp = await fetch(`${dc.sdkBaseUrl}/open-apis/authen/v1/user_info`, {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (userResp.ok) {
        const userData = await userResp.json() as any;
        userId = userData.data?.open_id || userData.open_id || undefined;
        unionId = userData.data?.union_id || userData.union_id || undefined;
        userName = userData.data?.name || userData.name || undefined;
      }
    } catch { /* user_info is best-effort */ }
  }

  const tokens: StoredTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
    scope: data.scope,
    userId,
    unionId,
    userName,
    openApiDomain: dc.open,
  };

  saveStoredTokens(appId, tokens);
  return tokens;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOGIN_PORT = 21721;
/** Must match what's configured in the app → Redirect URLs settings */
const CALLBACK_URI = `http://localhost:${LOGIN_PORT}/callback`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function openBrowser(url: string): void {
  const cmd = platform() === 'darwin' ? 'open'
    : platform() === 'win32' ? 'start'
    : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
}

/** Try ports from LOGIN_PORT upward until one works */
function tryListen(
  server: ReturnType<typeof createServer>,
  startPort: number,
  onListening: (port: number) => void,
  onError: (err: Error) => void,
  maxAttempts = 5,
): void {
  let attempts = 0;
  function attempt(port: number) {
    if (attempts >= maxAttempts) {
      onError(new Error(`Could not find a free port after ${maxAttempts} attempts`));
      return;
    }
    attempts++;
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        attempt(port + 1);
      } else {
        onError(err);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      onListening(port);
    });
  }
  attempt(startPort);
}
