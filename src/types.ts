// ---------------------------------------------------------------------------
// Configurable field / status mappings
// No field names or status values are hardcoded here — those come from
// the user's config file so the package adapts to any Bitable schema.
// ---------------------------------------------------------------------------

// ---- Field mappings -----------------------------------------------------

export interface TicketFieldMapping {
  status: string;
  owner: string;
  ownerLeaseAt: string;
  retryCount: string;
  summary: string;
  keyfacts: string;
  rootMsgId: string;
  chatId: string;
  senderId: string;
  forRoles: string;
  forKind: string;
  result: string;
  approvers: string;
  lastOwner: string;
  metadata: string;
  createdAt: string;
  updatedAt: string;
}

export interface TurnFieldMapping {
  ticketRecordId: string;
  rootMsgId: string;
  role: string;
  content: string;
  status: string;
  dedupKey: string;
  agentIdentity: string;
  human: string;
  deliveryOwner: string;
  deliveryLeaseAt: string;
  createdAt: string;
  notified: string;
  metadata: string;
  updatedAt: string;
}

export interface RosterFieldMapping {
  identity: string;
  nickname: string;
  kind: string;
  systemType: string;
  channelType: string;
  hostname: string;
  user: string;
  pid: string;
  lastSeenAt: string;
  registeredAt: string;
  roles: string;
  human: string;
  enabled: string;
  description: string;
  hitl: string;
  hitlPolicy: string;
  createdAt: string;
  updatedAt: string;
}

export interface FieldMapping {
  ticket: TicketFieldMapping;
  turn: TurnFieldMapping;
  roster: RosterFieldMapping;
}

// ---- Status mappings ----------------------------------------------------

export interface StatusMapping {
  draft: string;
  pending: string;
  assigned: string;
  pendingApproval: string;
  done: string;
  failed: string;
  closed: string;
}

// ---- Auth ----------------------------------------------------------------

/** What kind of credentials are available */
export type AuthMode = 'oauth' | 'app_secret' | 'none';

export interface TokenProvider {
  getToken(): Promise<string>;
}

export interface StoredTokens {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;      // epoch ms
  scope?: string;
  userId?: string;         // open_id from OAuth response
  userName?: string;       // display name from OAuth response
  openApiDomain?: string;  // the open API host when this token was created
}

// ---- Config -------------------------------------------------------------

export interface OperatorConfig {
  useLLM: boolean;
  draftTTLMinutes: number;
  pollIntervalSeconds: number;
  llmArgs?: string[];
  /** Role mapping method. */
  rolesMapping?: 'command' | 'keyword';
  /** Message received acknowledgment: 'emoji' (default), 'card', 'both'. */
  reactionMode?: 'emoji' | 'card' | 'both';
}

export interface CoordinatorConfig {
  /** WebSocket listen port for push executors. */
  port?: number;
  /** Poll interval for pending tickets (seconds). Default 5. */
  pollIntervalSeconds?: number;
  /** Heartbeat interval for push executor liveness (seconds). */
  heartbeatSeconds?: number;
  /** Session token validity (days). */
  sessionTTLDays?: number;
  /** Default HITL policy. */
  defaultHitlPolicy?: string;
  /** Global prompt sent to push executors. */
  globalPrompt?: string;
}

export interface ChannelConfig {
  useLLM: boolean;
  draftTTLMinutes: number;
  pollIntervalSeconds: number;
  llmArgs?: string[];
  /** Role mapping method. 'command'=slash command, 'keyword'=keyword match. */
  rolesMapping?: 'command' | 'keyword';
  /** Listen port for push executor WebSocket connections (0=disabled). */
  coordinatorPort?: number;
  /** Heartbeat interval for push executor liveness (seconds). */
  pushHeartbeatSeconds?: number;
  /** Session token validity (days). */
  pushSessionTTLDays?: number;
  /** Message received acknowledgment: 'emoji' (default), 'card', 'both'. */
  reactionMode?: 'emoji' | 'card' | 'both';
  /** Framework prompt sent to push executors (safety rules + JSON output schema). */
  globalPrompt?: string;
  /** Global HITL policy: always | auto | off. Default 'off'. */
  defaultHitlPolicy?: string;
}

export interface RoleDef {
  name: string;
  command?: string;
  env?: Record<string, string>;
  prompt?: string;
}

export interface ExecutorConfig {
  roles: string[];
  skipApproval?: boolean;
  approvalTimeoutMinutes?: number;
  postReview?: boolean;
  /** Per-role command/env/prompt overrides. Fall back to global defaults. */
  roleDef?: RoleDef[];
  /** 'pull' (default, polls Bitable) or 'push' (WebSocket to Channel). */
  mode?: 'pull' | 'push';
  /** Channel WebSocket URL for push mode. */
  coordinatorUrl?: string;
  /** Push mode auth: 'user' (OAuth PKCE) or 'app' (app_secret). Default 'user'. */
  auth?: 'user' | 'app';
  /** Executor-specific system prompt. Falls back to Config.prompt. */
  prompt?: string;
  /** Run Claude self-check on startup to generate capability description. */
  selfCheck?: boolean;
  /** HITL preference: off | auto | always. Default 'off'. */
  hitl?: string;
  hitlPolicy?: string;
}

export interface Config {
  appId: string;
  appSecret?: string;        // optional — PKCE mode doesn't need it
  openApiDomain?: string;    // e.g. "open.feishu.cn" or "open.larksuite.com"
  appToken: string;
  ticketsTableId: string;
  turnsTableId: string;
  rosterTableId: string;
  /** Optional — roles whitelist table for keyword-based classification. */
  rolesWhitelistTableId?: string;
  /** Optional — owner's Feishu open_id, written to Roster.human on register. */
  ownerOpenId?: string;
  fields: FieldMapping;
  statuses: StatusMapping;
  identity: string;
  nickname: string;
  /** Explicit executor ID, defaults to user@hostname. */
  clientId: string;
  peakInterval: number;
  offPeakInterval: number;
  nightInterval: number;
  heartbeatIntervalSeconds: number;
  errorRetrySeconds: number;
  leaseDuration: number;
  claudeTimeout: number;
  claudeArgs: string[];
  aiCommand: string;
  /** Flag prefix for passing prompt text. Default '-p'. */
  aiPromptFlag: string;
  maxRetries: number;
  /** System prompt content (embedded in config, not a file path). */
  prompt: string;
  maxConcurrency: number;
  /** Operator sub-config (IM interaction). */
  operator?: OperatorConfig;
  /** Coordinator sub-config (push mode central node). */
  coordinator?: CoordinatorConfig;
  /** Channel sub-config (deprecated, use operator + coordinator). */
  channel?: ChannelConfig;
  /** Executor sub-config */
  executor?: ExecutorConfig;
  /** Configurable IM message templates. Placeholders: {identity}, {summary}, {mentions}, {content}. */
  messages?: MessagesConfig;
}

export interface MessagesConfig {
  /** Notify user when executor completes processing. Placeholders: none. */
  taskDone?: string;
  /** Notify user when an executor is assigned. Placeholders: {identity}. */
  taskAssigned?: string;
  /** Notify humans about pending tickets. Placeholders: {mentions}, {summary}. */
  humanNotification?: string;
  /** Acknowledgment when user sends a message. Placeholders: none. */
  ackReceived?: string;
  /** Ask user for more details. Placeholders: none. */
  clarifyQuestion?: string;
  /** Notify user that their failed ticket was reactivated. Placeholders: none. */
  ticketReactivated?: string;
  /** CC forwarding format. Placeholders: {content}, {mentions}. */
  ccFormat?: string;
  /** Error fallback — processing failed, hand off to human. Placeholders: {reason}. */
  errorFallback?: string;
  /** Retry notification — will auto-retry. Placeholders: {reason}, {retryCount}, {maxRetries}. */
  retryFallback?: string;
  /** Exhausted retries — user should re-activate. Placeholders: {reason}. */
  exhaustedFallback?: string;
  /** Auto-ack template when executor starts. Placeholders: {ackHints}, {nickname}. */
  ackTemplate?: string;
  /** Approval required. Placeholders: {mentions}. */
  approvalWait?: string;
  /** Approval denied. Placeholders: {reason}. */
  approvalDenied?: string;
  /** Review pending. Placeholders: none. */
  reviewWait?: string;
  /** Answer regenerated for re-review. Placeholders: none. */
  reviewRetry?: string;
  /** Review timed out, escalated. Placeholders: none. */
  reviewTimeout?: string;
  /** Review rejected escalated. Placeholders: none. */
  reviewRejected?: string;
  /** Fallback when reassigning. Placeholders: none. */
  reassignFallback?: string;
  /** Fallback when answer is empty. Placeholders: none. */
  emptyAnswerFallback?: string;
}

// ---- Bitable record -----------------------------------------------------

export interface BitableRecord<T = Record<string, unknown>> {
  record_id: string;
  fields: T;
}

// ---- Process ------------------------------------------------------------

export interface ProcessContext {
  ticket: BitableRecord;
  turns: BitableRecord[];
  config: Config;
  /** Global prompt from Channel (safety rules + output schema). */
  globalPrompt?: string;
}

export interface ProcessResult {
  answer: string;
  newSummary: string;
  newKeyfacts: Record<string, string>;
  reassignTo?: { roles?: string[]; kind?: string };
}

export interface CompletenessCheckResult {
  isComplete: boolean;
  summary: string;
  missingFields: string[];
  forRoles: string[];
}

export interface Processor {
  process(ctx: ProcessContext): Promise<ProcessResult | null>;
}
