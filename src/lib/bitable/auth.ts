// ---------------------------------------------------------------------------
// Grant — grant full_access to a Bitable base via Drive permission API.
// Supports email, open_id, union_id, and phone (phone is resolved to open_id first).
// ---------------------------------------------------------------------------

export interface GrantOptions {
  appId: string;
  appSecret: string;
  openApiDomain?: string;
  appToken: string;
  memberType: 'email' | 'openid' | 'unionid';
  memberId: string;
}

/** Grant full_access to a Bitable base via Drive permission API.
 *  Returns true on success, false on failure. */
export async function grantBitableAccess(opts: GrantOptions): Promise<boolean> {
  try {
    const { getDomainConfig } = await import('../../lib/bitable/domain.js');
    const dc = getDomainConfig(String(opts.openApiDomain || 'open.larksuite.com'));
    const tokenResp = await fetch(`${dc.sdkBaseUrl}/open-apis/auth/v3/app_access_token/internal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: opts.appId, app_secret: opts.appSecret }),
    });
    const tokenData = await tokenResp.json() as Record<string, unknown>;
    const token = tokenData.app_access_token as string;
    if (!token) return false;
    const resp = await fetch(`${dc.sdkBaseUrl}/open-apis/drive/v1/permissions/${opts.appToken}/members?type=bitable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ member_type: opts.memberType, member_id: opts.memberId, perm: 'full_access' }),
    });
    const body = await resp.json() as Record<string, unknown>;
    return body.code === 0;
  } catch { return false; }
}

/** Resolve phone number to open_id via Feishu contact API.
 *  Returns open_id or null if not found. */
export async function resolvePhoneToOpenId(
  phone: string,
  appId: string,
  appSecret: string,
  openApiDomain?: string,
): Promise<string | null> {
  try {
    const { getDomainConfig } = await import('../../lib/bitable/domain.js');
    const dc = getDomainConfig(String(openApiDomain || 'open.larksuite.com'));
    const tokenResp = await fetch(`${dc.sdkBaseUrl}/open-apis/auth/v3/app_access_token/internal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const tokenData = await tokenResp.json() as Record<string, unknown>;
    const token = tokenData.app_access_token as string;
    if (!token) return null;
    const userResp = await fetch(`${dc.sdkBaseUrl}/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mobiles: [phone] }),
    });
    const userData: any = await userResp.json();
    return userData?.data?.user_list?.[0]?.user_id ?? null;
  } catch { return null; }
}
