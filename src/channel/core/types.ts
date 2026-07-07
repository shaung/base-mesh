// ---------------------------------------------------------------------------
// Adapter interfaces — abstract away deployment environment (Node.js vs Worker)
// ---------------------------------------------------------------------------

import type { Part } from '../../lib/types.js';

// ---- Records ---------------------------------------------------------------

export interface TicketRecord {
  record_id?: string;
  fields: Record<string, unknown>;
}

export interface TurnRecord {
  record_id?: string;
  fields: Record<string, unknown>;
}

export interface RoundRecord {
  record_id?: string;
  fields: Record<string, unknown>;
}

export interface RosterRecord {
  record_id?: string;
  fields: Record<string, unknown>;
}

// ---- Bitable operations ----------------------------------------------------

export interface BitableAdapter {
  getRecord(tableId: string, recordId: string): Promise<TicketRecord | null>;
  createRecord(tableId: string, fields: Record<string, unknown>, userIdType?: string): Promise<TicketRecord>;
  updateRecord(tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void>;
  searchRecords(tableId: string, filter: {
    conjunction: string;
    conditions: Array<{ field_name: string; operator: string; value: unknown[] }>;
  }): Promise<TicketRecord[]>;

  /** Batch create records (for Workers — reduces subrequest count). */
  batchCreateRecords?(tableId: string, records: Array<Record<string, unknown>>): Promise<TicketRecord[]>;
}

// ---- Feishu IM operations -------------------------------------------------

export interface FeishuAdapter {
  reply(
    messageId: string,
    content: string,
    replyInThread?: boolean,
    msgType?: 'interactive' | 'text',
  ): Promise<void>;

  react(messageId: string, emojiType: string): Promise<void>;
  removeReaction(messageId: string, emojiType: string): Promise<void>;
  fetchMessageText(messageId: string): Promise<string>;
  sendMessage(chatId: string, content: string): Promise<void>;

  /** Get tenant access token. */
  getTenantToken(): Promise<string | null>;
}

// ---- Executor pool interface ----------------------------------------------

export interface ExecutorInfo {
  identity: string;
  domains: string[];
  connected: boolean;
  lastHeartbeat: number;
  activeTicketId?: string;
}

export interface ExecutorPoolInterface {
  registerExecutor(identity: string, domains: string[], ws: any): void;
  unregisterExecutor(identity: string): void;
  getAvailableExecutors(domains?: string[]): ExecutorInfo[];
  dispatchTask(executorId: string, payload: unknown): boolean;
  broadcastTask(payload: unknown): number;
  dispatchCancel(executorId: string, roundId: string): boolean;

  /** Send a message to all connected executors. */
  broadcast(message: string): number;
}

// ---- Scheduler — abstract timers (setInterval vs DO alarms) ---------------

export interface Scheduler {
  setInterval(callback: () => void | Promise<void>, ms: number): { clear(): void };
  setTimeout(callback: () => void | Promise<void>, ms: number): { clear(): void };
}

// ---- Logger ----------------------------------------------------------------

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

// ---- Environment info ------------------------------------------------------

export interface ChannelEnv {
  mode: 'node' | 'worker';
  workerUrl?: string;
  appId: string;
}
