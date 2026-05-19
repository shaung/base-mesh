// Device-code OAuth flow — user scans QR code to create a new bot app.
// Uses /oauth/v1/app/registration (same endpoint as openclaw-lark-tools).
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';

interface DeviceAuthResult {
  appId: string;
  appSecret: string;
  domain: 'lark' | 'feishu';
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
