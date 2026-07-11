// ---------------------------------------------------------------------------
// Bitable adapter for Cloudflare Workers
//
// Implements the BitableAdapter interface using Lark Open API fetch()
// calls instead of @larksuiteoapi/node-sdk (which requires Node.js).
//
// Subrequest limit: Workers allow 50 subrequests per fetch() invocation.
// This adapter batches operations to stay within that limit.
// ---------------------------------------------------------------------------

import type { Env } from '../index.js';
import type { BitableAdapter, TicketRecord } from '../../../core/types.js';

/** Base URL for Lark Open API. */
function baseUrl(env: Env): string {
  return `https://${env.OPEN_API_DOMAIN || 'open.larksuite.com'}`;
}

/** Get an app_access_token using internal app credentials. */
async function getAppToken(env: Env): Promise<string | null> {
  try {
    const resp = await fetch(`${baseUrl(env)}/open-apis/auth/v3/app_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: env.LARK_APP_ID,
        app_secret: env.LARK_APP_SECRET,
      }),
    });
    const data = await resp.json() as Record<string, unknown>;
    return (data.app_access_token as string) || null;
  } catch (err) {
    console.error('[worker-bitable] getAppToken failed:', err);
    return null;
  }
}

// ---- Adapter ---------------------------------------------------------------

export class WorkerBitableAdapter implements BitableAdapter {
  private tokenPromise: Promise<string | null> | null = null;

  constructor(private env: Env) {}

  /** Get (or refresh) the app access token. */
  private async getToken(): Promise<string | null> {
    if (!this.tokenPromise) {
      this.tokenPromise = getAppToken(this.env);
      // Cache token for 55 minutes (tokens expire in 60 min)
      setTimeout(() => { this.tokenPromise = null; }, 55 * 60 * 1000);
    }
    return this.tokenPromise;
  }

  /** Build auth headers. */
  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    if (!token) throw new Error('No app_access_token available');
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  /** Construct the Bitable API base path for a specific table. */
  private tablePath(tableId: string): string {
    return `${baseUrl(this.env)}/open-apis/bitable/v1/apps/${this.env.BITABLE_APP_TOKEN}/tables/${tableId}`;
  }

  // ── Record operations ──────────────────────────────────────────────────

  async getRecord(tableId: string, recordId: string): Promise<TicketRecord | null> {
    const hdrs = await this.headers();
    const resp = await fetch(`${this.tablePath(tableId)}/records/${recordId}`, {
      headers: hdrs,
    });
    const data = await resp.json() as Record<string, unknown>;
    if ((data as any).code !== 0) {
      console.warn(`[worker-bitable] getRecord failed: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }
    const record = (data as any).data?.record;
    if (!record) return null;
    return {
      record_id: record.record_id as string,
      fields: record.fields as Record<string, unknown>,
    };
  }

  async createRecord(
    tableId: string,
    fields: Record<string, unknown>,
    _userIdType?: string,
  ): Promise<TicketRecord> {
    const hdrs = await this.headers();
    const params: Record<string, string> = {};
    if (_userIdType) params['user_id_type'] = _userIdType;
    const qs = Object.keys(params).length > 0 ? `?${new URLSearchParams(params)}` : '';

    const url = `${this.tablePath(tableId)}/records${qs}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ fields }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`createRecord HTTP ${resp.status} table="${tableId}" url="${url}": ${body.slice(0, 300)}`);
    }
    const data = await resp.json() as Record<string, unknown>;
    if ((data as any).code !== 0) {
      const errMsg = JSON.stringify(data).slice(0, 300);
      throw new Error(`Bitable createRecord failed code=${(data as any).code} table="${tableId}": ${errMsg}`);
    }
    const record = (data as any).data?.record;
    return {
      record_id: record?.record_id as string,
      fields: record?.fields as Record<string, unknown> ?? fields,
    };
  }

  async updateRecord(
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const hdrs = await this.headers();
    const resp = await fetch(`${this.tablePath(tableId)}/records/${recordId}`, {
      method: 'PUT',
      headers: hdrs,
      body: JSON.stringify({ fields }),
    });
    const data = await resp.json() as Record<string, unknown>;
    if ((data as any).code !== 0) {
      console.error(`[worker-bitable] updateRecord failed: ${JSON.stringify(data).slice(0, 200)}`);
    }
  }

  async searchRecords(
    tableId: string,
    filter: {
      conjunction: string;
      conditions: Array<{ field_name: string; operator: string; value: unknown[] }>;
    },
  ): Promise<TicketRecord[]> {
    const hdrs = await this.headers();

    // Bitable list API supports filtering via query params
    const params = new URLSearchParams({ page_size: '500' });
    if (filter.conditions.length > 0) {
      // Use the field_name-based filter via list API with filtering
      // The Bitable API's search endpoint is available since a certain version
      params.set('filter', JSON.stringify({
        conjunction: filter.conjunction,
        conditions: filter.conditions,
      }));
    }

    // Try searchRecords endpoint first (more efficient)
    const searchResp = await fetch(
      `${this.tablePath(tableId)}/records/search`,
      {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify(filter),
      },
    );

    if (searchResp.ok) {
      const data = await searchResp.json() as Record<string, unknown>;
      if ((data as any).code === 0) {
        const items = (data as any).data?.items ?? [];
        return items.map((r: any) => ({
          record_id: r.record_id as string,
          fields: r.fields as Record<string, unknown>,
        }));
      }
    }

    // Fallback: list all records and filter client-side
    const records: TicketRecord[] = [];
    let pageToken: string | null = null;

    for (let page = 0; page < 10; page++) {
      if (pageToken) params.set('page_token', pageToken);
      else params.delete('page_token');

      const resp = await fetch(`${this.tablePath(tableId)}/records?${params}`, {
        headers: hdrs,
      });
      const data = await resp.json() as Record<string, unknown>;
      if ((data as any).code !== 0) break;

      const items = (data as any).data?.items ?? [];
      for (const item of items) {
        const record = {
          record_id: item.record_id as string,
          fields: item.fields as Record<string, unknown>,
        };

        // Apply client-side filtering
        if (this.matchesFilter(record, filter)) {
          records.push(record);
        }
      }

      pageToken = (data as any).data?.page_token as string | null;
      if (!pageToken) break;
    }

    return records;
  }

  /** Client-side filter matching (fallback when search endpoint unavailable). */
  private matchesFilter(
    record: TicketRecord,
    filter: { conjunction: string; conditions: Array<{ field_name: string; operator: string; value: unknown[] }> },
  ): boolean {
    if (filter.conditions.length === 0) return true;

    const results = filter.conditions.map(c => {
      const fieldVal = record.fields[c.field_name];
      switch (c.operator) {
        case 'is':
          return c.value.some(v => String(fieldVal) === String(v));
        case 'isNot':
          return !c.value.some(v => String(fieldVal) === String(v));
        case 'contains':
          return c.value.some(v => String(fieldVal).includes(String(v)));
        case 'greater':
          return Number(fieldVal) > Number(c.value[0]);
        case 'less':
          return Number(fieldVal) < Number(c.value[0]);
        case 'isEmpty':
          return fieldVal === undefined || fieldVal === null || fieldVal === '';
        case 'isNotEmpty':
          return fieldVal !== undefined && fieldVal !== null && fieldVal !== '';
        default:
          return true;
      }
    });

    return filter.conjunction === 'and'
      ? results.every(Boolean)
      : results.some(Boolean);
  }
}
