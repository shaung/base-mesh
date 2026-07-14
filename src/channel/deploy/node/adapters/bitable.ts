// ---------------------------------------------------------------------------
// NodeBitableAdapter — wraps BitableClient to implement BitableAdapter
// ---------------------------------------------------------------------------

import { BitableClient } from '../../../../lib/bitable/client.js';
import type { BitableAdapter, TicketRecord } from '../../../core/types.js';

export class NodeBitableAdapter implements BitableAdapter {
  constructor(private client: BitableClient) {}

  async getRecord(tableId: string, recordId: string): Promise<TicketRecord | null> {
    const r = await this.client.getRecord(tableId, recordId);
    return r ? { record_id: r.record_id, fields: r.fields as Record<string, unknown> } as TicketRecord : null;
  }

  async createRecord(tableId: string, fields: Record<string, unknown>, userIdType?: string): Promise<TicketRecord> {
    const r = await this.client.createRecord(tableId, fields, userIdType);
    return { record_id: r.record_id, fields: r.fields as Record<string, unknown> } as TicketRecord;
  }

  async updateRecord(tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void> {
    await this.client.updateRecord(tableId, recordId, fields);
  }

  async searchRecords(tableId: string, filter: {
    conjunction: string;
    conditions: Array<{ field_name: string; operator: string; value: unknown[] }>;
  }): Promise<TicketRecord[]> {
    const records = await this.client.searchRecords(tableId, filter);
    return records.map(r => ({ record_id: r.record_id, fields: r.fields as Record<string, unknown> } as TicketRecord));
  }
}
