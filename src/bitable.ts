import { Client, withUserAccessToken } from '@larksuiteoapi/node-sdk';
import { Config, BitableRecord, TokenProvider } from './types.js';
import { getDomainConfig } from './domain.js';
import { logger } from './log.js';

// ---------------------------------------------------------------------------
// Bitable HTTP client — wraps the official Lark SDK.
// Supports dual auth: app_secret mode (SDK built-in) and OAuth PKCE mode
// (via TokenProvider + withUserAccessToken).
// ---------------------------------------------------------------------------

export class BitableError extends Error {
  constructor(msg: string, public code = 0) {
    super(msg);
  }
}

interface FilterCondition {
  field_name: string;
  operator: string;
  value: unknown[];
}

interface SearchFilter {
  conjunction: string;
  conditions: FilterCondition[];
}

export class BitableClient {
  private client: Client;
  private tokenProvider?: TokenProvider;

  constructor(
    private cfg: Pick<Config, 'appId' | 'appSecret' | 'appToken' | 'openApiDomain'>,
    tokenProvider?: TokenProvider,
  ) {
    this.tokenProvider = tokenProvider;
    const dc = getDomainConfig(cfg.openApiDomain);
    // In PKCE mode the SDK needs a truthy appSecret placeholder. It's never
    // used because every request passes an override via withUserAccessToken.
    // No-op logger to suppress the SDK's internal defaultLogger, which prints
    // Axios error response bodies as unreadable character-indexed objects
    // (Buffer → Object.assign({}, buffer) → {'0': '<', '1': '!', ...}).
    // The SDK re-throws errors after logging them, so our own error handling
    // (logger.error in callers, withRetry) still produces meaningful output.
    const silentLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} };
    this.client = new Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret || 'unused',
      domain: dc.sdkBaseUrl,
      logger: silentLogger,
    });
  }

  /** Returns the request options modifier needed for PKCE mode */
  private async authOptions() {
    if (this.tokenProvider) {
      const token = await this.tokenProvider.getToken();
      return withUserAccessToken(token);
    }
    return undefined;
  }

  /** Wrap a Feishu API call with retry on transient failures.
   *  Retries on: rate-limit (1663), server error (502), or SDK token fetch failure
   *  (TypeError: destructure of undefined). Exponential backoff: 1s, 2s, 4s, 8s. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const maxRetries = 4;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        const shouldRetry = attempt < maxRetries && (
          (err instanceof BitableError && err.code === 1663) ||
          (err instanceof TypeError && err.message?.includes('tenant_access_token'))
        );
        if (shouldRetry) {
          const delay = Math.pow(2, attempt) * 1000;
          console.log(`[bitable] retry ${attempt + 1}/${maxRetries} after ${delay}ms:`, (err as Error).message);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  // -- CRUD ---------------------------------------------------------------

  async createRecord<T = Record<string, unknown>>(tableId: string, fields: T, userIdType?: string): Promise<BitableRecord<T>> {
    return this.withRetry(async () => {
      const params: Record<string, string> = {};
      if (userIdType) params.user_id_type = userIdType;
      const resp = await this.client.bitable.appTableRecord.create({
        path: { app_token: this.cfg.appToken, table_id: tableId },
        data: { fields: fields as any },
        params,
      }, await this.authOptions());
      if (resp.code !== 0 || !resp.data?.record) {
        logger.error(`[bitable] createRecord FAILED: ${JSON.stringify(resp)}`);
        throw new BitableError(`createRecord failed: ${JSON.stringify(resp)}`, resp.code ?? 0);
      }
      return { record_id: resp.data.record.record_id!, fields: resp.data.record.fields as unknown as T };
    });
  }

  async updateRecord<T = Record<string, unknown>>(tableId: string, recordId: string, fields: Partial<T>, userIdType?: string): Promise<BitableRecord<T>> {
    return this.withRetry(async () => {
      const params: Record<string, string> = {};
      if (userIdType) params.user_id_type = userIdType;
      const resp = await this.client.bitable.appTableRecord.update({
        path: { app_token: this.cfg.appToken, table_id: tableId, record_id: recordId },
        data: { fields: fields as any },
        params,
      }, await this.authOptions());
      if (resp.code !== 0 || !resp.data?.record) {
        logger.error(`[bitable] updateRecord FAILED: ${JSON.stringify(resp)}`);
        throw new BitableError(`updateRecord failed: ${JSON.stringify(resp)}`, resp.code ?? 0);
      }
      return { record_id: resp.data.record.record_id!, fields: resp.data.record.fields as unknown as T };
    });
  }

  async getRecord<T = Record<string, unknown>>(tableId: string, recordId: string): Promise<BitableRecord<T>> {
    return this.withRetry(async () => {
      const resp = await this.client.bitable.appTableRecord.get({
        path: { app_token: this.cfg.appToken, table_id: tableId, record_id: recordId },
      }, await this.authOptions());
      if (resp.code !== 0 || !resp.data?.record) {
        if (resp.code === 0) throw new BitableError('getRecord: empty record', 0);
        throw new BitableError(`getRecord failed: ${JSON.stringify(resp)}`, resp.code);
      }
      return { record_id: resp.data.record.record_id!, fields: resp.data.record.fields as unknown as T };
    });
  }

  async listRecords<T = Record<string, unknown>>(tableId: string, params?: Record<string, string>): Promise<BitableRecord<T>[]> {
    const records: BitableRecord<T>[] = [];
    let pageToken: string | null = null;

    while (true) {
      const resp = await this.client.bitable.appTableRecord.list({
        path: { app_token: this.cfg.appToken, table_id: tableId },
        params: { ...params, page_token: pageToken ?? undefined } as any,
      }, await this.authOptions());
      if (resp.code !== 0) {
        throw new BitableError(`listRecords failed: ${JSON.stringify(resp)}`, resp.code);
      }
      const items = (resp.data?.items ?? []) as any[];
      for (const item of items) {
        records.push({ record_id: item.record_id, fields: item.fields as T });
      }
      if (!resp.data?.has_more) break;
      pageToken = resp.data.page_token ?? null;
    }
    return records;
  }

  async searchRecords<T = Record<string, unknown>>(tableId: string, filter: SearchFilter): Promise<BitableRecord<T>[]> {
    const records: BitableRecord<T>[] = [];
    let pageToken: string | null = null;

    for (let i = 0; i < 20; i++) {
      const resp = await this.client.bitable.appTableRecord.search({
        path: { app_token: this.cfg.appToken, table_id: tableId },
        params: { page_token: pageToken ?? undefined } as any,
        data: {
          filter: filter as any,
        },
      }, await this.authOptions());
      if (resp.code !== 0) {
        throw new BitableError(`searchRecords failed: ${JSON.stringify(resp)}`, resp.code);
      }
      const items = (resp.data?.items ?? []) as any[];
      for (const item of items) {
        records.push({ record_id: item.record_id, fields: item.fields as T });
      }
      if (!resp.data?.has_more) break;
      pageToken = resp.data.page_token ?? null;
    }
    return records;
  }
}
