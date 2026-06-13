// Device-code OAuth flow — user scans QR code to create a new bot app.
// Uses /oauth/v1/app/registration (same endpoint as openclaw-lark-tools).
import { saveStoredTokens } from './auth.js';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';

interface DeviceAuthResult {
  appId: string;
  appSecret: string;
  domain: 'lark' | 'feishu';
}

/** Send a probe request to the Feishu/Lark Open platform to trigger
 *  server-side scope provisioning and release submission for a newly
 *  created app (archetype=PersonalAgent).  This is the same mechanism
 *  lark-cli uses after config init --new. */
export async function sendProbe(
  appId: string,
  appSecret: string,
  openApiDomain: string,
): Promise<void> {
  // 1. Get tenant_access_token
  const tokenResp = await fetch(
    `https://${openApiDomain}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
  );
  const tokenData = (await tokenResp.json()) as Record<string, unknown>;
  const token = tokenData.tenant_access_token as string;
  if (!token) return;

  // 2. Fire probe (best-effort, ignore failures)
  const probeResp = await fetch(
    `https://${openApiDomain}/open-apis/application/v6/larksuite_cli_app/probe`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: 'bam/0.0.2' }),
    },
  );
  if (!probeResp.ok) {
    // Ignore — probe is best-effort
    const text = await probeResp.text().catch(() => '');
    if (text) console.debug('[probe]', probeResp.status, text.slice(0, 200));
  }
}

const REG_PATH = '/oauth/v1/app/registration';

async function post(base: string, data: Record<string, string>): Promise<Record<string, unknown>> {
  const resp = await fetch(`${base}${REG_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data).toString(),
  });
  return resp.json() as Promise<Record<string, unknown>>;
}

export async function createAppViaQR(opts: { openApiDomain?: string } = {}): Promise<DeviceAuthResult> {
  const accountsBase = opts.openApiDomain === 'open.larksuite.com'
    ? 'https://accounts.larksuite.com' : 'https://accounts.feishu.cn';

  // 1. Init
  const init = await post(accountsBase, { action: 'init' });

  // 2. Begin registration
  const begin = await post(accountsBase, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  });

  const deviceCode = begin.device_code as string;
  const verifyUri = begin.verification_uri_complete as string;
  const interval = (begin.interval as number) || 5;
  const expireIn = (begin.expire_in as number) || 600;

  // 3. Show QR URL
  const qr = new URL(verifyUri);
  qr.searchParams.set('from', 'bam-setup');
  console.log(chalk.cyan('\n  Scan QR with Feishu/Lark to create bot app:\n'));
  qrcode.generate(qr.toString(), { small: true });

  // 4. Poll
  const deadline = Date.now() + expireIn * 1000;
  let cur = interval;
  let switched = false;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, cur * 1000));
    const data = await post(accountsBase, { action: 'poll', device_code: deviceCode });

    if (data.user_info && !switched) {
      const brand = (data.user_info as any)?.tenant_brand;
      if (brand === 'lark' && opts.openApiDomain !== 'open.larksuite.com') {
        console.log(chalk.yellow('  Detected Lark, switching...'));
        return createAppViaQR({ openApiDomain: 'open.larksuite.com' });
      }
      switched = true;
    }

    if (data.client_id && data.client_secret) {
      console.log(chalk.green(`  ✓ Created: ${data.client_id}\n`));
      return { appId: data.client_id as string, appSecret: data.client_secret as string, domain: 'feishu' };
    }

    const err = data.error as string;
    if (!err || err === 'authorization_pending') continue;
    if (err === 'slow_down') { cur += 5; continue; }
    if (err === 'access_denied') throw new Error('Authorization denied');
    if (err === 'expired_token') throw new Error('Session expired');
    throw new Error(`Device auth error: ${err}`);
  }

  throw new Error('Timed out');
}

// ---------------------------------------------------------------------------
// Device Grant login — used by channel setup (has appSecret).
// Unlike PKCE, no local HTTP server needed. Shows URL → user authorizes →
// poll for token → store it.
// ---------------------------------------------------------------------------

const DEVICE_AUTH_PATH = '/oauth/v1/device_authorization';
const TOKEN_PATH = '/open-apis/authen/v2/oauth/token';

/** Perform device grant login. Shows a URL, polls until user authorizes,
 *  stores the resulting user_access_token via saveStoredTokens(). */
export async function deviceGrantLogin(
  appId: string,
  appSecret: string,
  openApiDomain: string,
): Promise<string | undefined> {
  const accountsBase = openApiDomain === 'open.larksuite.com'
    ? 'https://accounts.larksuite.com' : 'https://accounts.feishu.cn';
  const apiBase = `https://${openApiDomain}`;
  const basicAuth = btoa(`${appId}:${appSecret}`);

  // 1. Request device authorization
  const authResp = await fetch(`${accountsBase}${DEVICE_AUTH_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      client_id: appId,
      scope: 'drive:drive offline_access',
    }),
  });

  if (!authResp.ok) {
    const text = await authResp.text().catch(() => '');
    throw new Error(`Device authorization failed (${authResp.status}): ${text.slice(0, 200)}`);
  }

  const authData = (await authResp.json()) as Record<string, unknown>;
  const deviceCode = authData.device_code as string;
  const verifyUri = authData.verification_uri_complete as string;
  const expiresIn = (authData.expires_in as number) || 240;
  let interval = (authData.interval as number) || 5;

  if (!deviceCode || !verifyUri) {
    throw new Error(`Device authorization returned incomplete data: ${JSON.stringify(authData).slice(0, 300)}`);
  }

  // 2. Show URL
  console.log(chalk.cyan('\n  Open this URL in your browser to authorize:\n'));
  console.log(`    ${verifyUri}\n`);
  console.log(chalk.dim('  Waiting for authorization...\n'));

  // 3. Poll for token
  const deadline = Date.now() + (expiresIn - 10) * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval * 1000));

    const tokenResp = await fetch(`${apiBase}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: appId,
        client_secret: appSecret,
      }),
    });

    const tokenData = (await tokenResp.json()) as Record<string, unknown>;
    if (tokenData.access_token) {
      // 4. Get user info
      let userId: string | undefined;
      let userName: string | undefined;
      try {
        const userResp = await fetch(`${apiBase}/open-apis/authen/v1/user_info`, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (userResp.ok) {
          const userData = (await userResp.json()) as Record<string, unknown>;
          const d = userData.data as Record<string, unknown> ?? userData;
          userId = (d.open_id ?? d.user_id) as string | undefined;
          userName = (d.name) as string | undefined;
        }
      } catch { /* best-effort */ }

      // 5. Store token
      saveStoredTokens(appId, {
        accessToken: tokenData.access_token as string,
        refreshToken: (tokenData.refresh_token as string) ?? '',
        expiresAt: Date.now() + ((tokenData.expires_in as number) ?? 7200) * 1000,
        scope: tokenData.scope as string,
        userId,
        userName,
        openApiDomain,
      });

      console.log(chalk.green(`  ✓ Authorized${userId ? ` as ${userId}` : ''}\n`));
      return userId;
    }

    const err = tokenData.error as string;
    if (!err || err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval = Math.min(interval + 5, 60); continue; }
    if (err === 'access_denied') throw new Error('Authorization denied');
    if (err === 'expired_token') throw new Error('Session expired, please try again');
    throw new Error(`Authorization failed: ${err}`);
  }

  throw new Error('Authorization timed out');
}
