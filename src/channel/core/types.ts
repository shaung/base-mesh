// ---------------------------------------------------------------------------
// Adapter interfaces — abstract away deployment environment (Node.js vs Worker)
// ---------------------------------------------------------------------------

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
  batchCreateRecords?(tableId: string, records: Array<Record<string, unknown>>): Promise<TicketRecord[]>;
}

// ---- Feishu IM operations -------------------------------------------------

export interface FeishuAdapter {
  reply(messageId: string, content: string, replyInThread?: boolean, msgType?: 'interactive' | 'text'): Promise<void>;
  react(messageId: string, emojiType: string): Promise<void>;
  removeReaction(messageId: string, emojiType: string): Promise<void>;
  fetchMessageText(messageId: string): Promise<string>;
  sendMessage(chatId: string, content: string): Promise<void>;
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
  getAvailableExecutors(domains?: string[]): ExecutorInfo[];
  dispatchTask(executorId: string, payload: unknown): boolean;
  dispatchCancel(executorId: string, roundId: string): boolean;
  broadcast(message: string): number;
}

// ---- Session adapter — wraps Session operations used by Coordinator --------

export interface SessionAdapter {
  getTicket(ticketId: string): Promise<TicketRecord | null>;
  getTurns(ticketId: string): Promise<TurnRecord[]>;
  getRound(roundId: string): Promise<RoundRecord | null>;
  getCurrentRound(ticketId: string): Promise<RoundRecord | null>;

  claimRound(round: RoundRecord, identity: string): Promise<boolean>;
  releaseRound(roundId: string): Promise<void>;
  claim(ticket: TicketRecord): Promise<boolean>;
  release(ticketId: string, newStatus: string): Promise<void>;

  transitionRound(roundId: string, newStatus: string): Promise<boolean>;
  setRoundResult(roundId: string, answer: string): Promise<void>;

  appendTurn(
    ticketId: string, role: string, content: string, dedupKey: string,
    agentIdentity: string, status: string, rootMsgId?: string,
    roundId?: string, parts?: unknown[], notified?: number, appId?: string,
  ): Promise<string | undefined>;

  writeResult(ticketId: string, answer: string, newSummary?: string): Promise<void>;

  searchRoundsByStatus(status: string): Promise<RoundRecord[]>;
  searchStuckRounds(stuckTimeoutMs: number): Promise<RoundRecord[]>;

  /** Search roster table with arbitrary filter conditions. */
  searchRoster(filter: {
    conjunction: string;
    conditions: Array<{ field_name: string; operator: string; value: unknown[] }>;
  }): Promise<RosterRecord[]>;

  /** Get a roster record by identity. */
  getRosterByIdentity(identity: string): Promise<Record<string, unknown> | null>;

  registerRoster(identity: string, fields: Record<string, unknown>): Promise<void>;

  /** Search tickets by sender ID (for /cancel command). */
  searchTicketsBySender(senderId: string): Promise<TicketRecord[]>;
}

// ---- Streaming card management -------------------------------------------

export interface StreamCardState {
  cardId: string;
  seq: number;
  appId?: string;
}

// ---- Executor result payload (from executor WS message) -------------------

export interface ExecutorResultPayload {
  ticket_id: string;
  round_id?: string;
  answer: string;
  root_msg_id: string;
  parts?: unknown[];
  reassignTo?: { roles?: string[]; kind?: string };
  streamed?: boolean;
  newSummary?: string;
  duration_ms?: number;
  token_usage?: { input?: number; output?: number };
}

// ---- Streaming update/end payload ----------------------------------------

export interface StreamUpdatePayload {
  ticket_id: string;
  round_id?: string;
  content: string;
  content_type: string;
  root_msg_id: string;
}

export interface StreamEndPayload {
  ticket_id: string;
  round_id?: string;
  content: string;
  duration_ms?: number;
  token_usage?: { input?: number; output?: number };
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

// ---- Message event types (for CoreOperator) -------------------------------

/** A mention in a Lark message. */
export interface MessageMention {
  mentioned_type: string;
  id: { open_id: string; union_id?: string };
  name?: string;
}

/** Parsed message event received from Lark IM. */
export interface IncomingMessage {
  message_id: string;
  message_type: 'text' | 'post' | 'interactive';
  content: string;
  chat_type: 'p2p' | 'group';
  chat_id: string;
  root_id?: string;
  parent_id?: string;
  mentions?: MessageMention[];
}

/** Sender info from a Lark event. */
export interface MessageSender {
  sender_type: 'user' | 'bot';
  sender_id: { open_id: string; union_id?: string };
}

/** Parsed incoming message event, ready for CoreOperator processing. */
export interface ParsedMessageEvent {
  content: string;
  parts: unknown[];
  message: IncomingMessage;
  sender: MessageSender;
  appId?: string;
  botMentioned: boolean;
  domain?: string;
}

/** Result of intent recognition. */
export interface IntentResult {
  domains: string[];
  isComplete: boolean;
  summary: string;
  missingFields: string[];
}

/** Card action callback data. */
export interface CardActionData {
  round_id: string;
  action: 'approve' | 'reject';
}

/** Domain descriptor from Domains table. */
export interface DomainDescriptor {
  domain: string;
  description: string;
}
