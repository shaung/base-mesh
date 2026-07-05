// ---------------------------------------------------------------------------
// Domain helpers — maps the configured open API host to account host and
// SDK base URL.
// ---------------------------------------------------------------------------

export interface DomainConfig {
  /** Open API host, e.g. open.feishu.cn */
  open: string;
  /** OAuth account host, derived from the open host */
  accounts: string;
  /** Full URL for the Lark SDK domain parameter */
  sdkBaseUrl: string;
}

const DEFAULT_OPEN_HOST = 'open.feishu.cn';

export function getDomainConfig(openHost?: string): DomainConfig {
  const host = openHost || DEFAULT_OPEN_HOST;
  const accounts = host.replace(/^open\./, 'accounts.');
  return {
    open: host,
    accounts,
    sdkBaseUrl: `https://${host}`,
  };
}
