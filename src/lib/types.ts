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
  result: string;
  approvers: string;
  lastOwner: string;
  /** Business domain, e.g. "tech_support" */
  domain: string;
  /** Latest Round record_id for this ticket (Round-driven mode). */
  lastRoundId: string;
  metadata: string;
  createdAt: string;
  updatedAt: string;
}

export interface TurnFieldMapping {
  ticketRecordId: string;
  roundId: string;
  rootMsgId: string;
  role: string;
  content: string;
  /** A2A-compatible Part array as JSON string */
  parts: string;
  /** Feishu attachment field for binary file storage */
  attachments: string;
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
  /** Bot appId that produced this turn (multi-operator). */
  appId: string;
}

export interface RoundFieldMapping {
  ticketRecordId: string;
  /** JSON array of required ability labels, e.g. ["tech_support.api"] */
  domains: string;
  status: string;
  executor: string;
  reviewer: string;
  reviewComment: string;
  supplementPrompt: string;
  result: string;
  /** A2A-compatible Artifact array as JSON string */
  artifacts: string;
  /** Full user input sent to the executor (conversation text). */
  input: string;
  createdAt: string;
  updatedAt: string;
  /** Bot appId that owns this round (multi-operator). */
  appId: string;
}

export interface RosterFieldMapping {
  identity: string;
  nickname: string;
  kind: string;
  /** JSON metadata (hostname, user, pid, etc.) */
  metadata: string;
  lastSeenAt: string;
  registeredAt: string;
  domains: string;
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
  round: RoundFieldMapping;
}

// ---- Status mappings ----------------------------------------------------

export interface StatusMapping {
  draft: string;
  active: string;
  closed: string;
  /** Legacy — may be used by Channel for re-activation. */
  failed?: string;
}

// ---- Round status mappings ------------------------------------------------

export interface RoundStatusMapping {
  pending: string;
  pendingApproval: string;
  approved: string;
  rejected: string;
  executing: string;
  done: string;
  failed: string;
  cancelled: string;
}

/** Canonical Round state transitions: key is current status, value is allowed next statuses.
 *  Keys match RoundStatusMapping property names (camelCase). */
export const ROUND_TRANSITIONS: Record<string, string[]> = {
  pending: ['pendingApproval', 'executing', 'cancelled'],
  pendingApproval: ['approved', 'rejected', 'cancelled', 'pending'],
  approved: ['executing', 'cancelled', 'pending'],
  rejected: [],
  executing: ['done', 'failed', 'pending', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

// ---- A2A Part types ------------------------------------------------------

/** Plain text content part. */
export interface TextPart {
  kind: 'text';
  text: string;
}

/** File attachment part (image, document, etc.). */
export interface FilePart {
  kind: 'file';
  /** Feishu attachment field token, from uploading to the attachments field. */
  file_token: string;
  /** Coordinator proxy URL for downloading this file without Feishu credentials. */
  file_uri: string;
  /** File name, e.g. "screenshot.png". */
  name?: string;
  /** MIME type, e.g. "image/png". */
  mime_type?: string;
  /** File size in bytes. */
  size?: number;
}

/** Structured data part. */
export interface DataPart {
  kind: 'data';
  data: Record<string, unknown>;
}

/** Union of all A2A-compatible Part types stored in Turn.parts. */
export type Part = TextPart | FilePart | DataPart;

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
  unionId?: string;        // tenant/developer-wide union_id
  userName?: string;       // display name from OAuth response
  openApiDomain?: string;  // the open API host when this token was created
}

// ---- Multi-operator support --------------------------------------------

/** Configuration for a single operator (bot account). */
export interface BotConfig {
  /** Operator identifier, e.g. "default", "tech-support-bot". */
  name: string;
  /** Lark appId for this operator. */
  appId: string;
  /** Lark appSecret for this operator. */
  appSecret?: string;
  /** Optional bound domain. If set, skip intent recognition. */
  domain?: string;
}

// ---- Config -------------------------------------------------------------

export interface OperatorConfig {
  draftTTLMinutes: number;
  pollIntervalSeconds: number;
  /** Message received acknowledgment: 'emoji' (default), 'card', 'both'. */
  reactionMode?: 'emoji' | 'card' | 'both';
}

export interface S3Config {
  /** S3 region. */
  region?: string;
  /** S3 bucket name. */
  bucket?: string;
  /** Access key ID. */
  accessKeyId?: string;
  /** Secret access key. */
  secretAccessKey?: string;
  /** Pre-signed URL expiry in seconds. Default 3600. */
  presignExpiresSeconds?: number;
  /** Endpoint URL (for S3-compatible storage like MinIO). */
  endpoint?: string;
  /** Force path-style addressing (needed for MinIO). */
  forcePathStyle?: boolean;
}

export interface A2AServerConfig {
  /** Enable A2A Server endpoints (default false). */
  enabled?: boolean;
  /** Base URL exposed to external agents, e.g. "http://public-host:8080". */
  baseUrl?: string;
  /** API token required from external A2A clients (empty = no auth). */
  apiToken?: string;
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
  /** Enable file proxy endpoint GET /files/{file_token} (default true). */
  fileProxyEnabled?: boolean;
  /** Enable streaming output (typewriter card effect via CardKit). */
  streamOutput?: boolean;
  /** When streaming, also output thinking process as quote blocks. */
  streamThinking?: boolean;
  /** A2A Server configuration for external agent interop. */
  a2a?: A2AServerConfig;
  /** S3 configuration for external file sharing. */
  s3?: S3Config;
}

export interface ChannelConfig {
  draftTTLMinutes: number;
  pollIntervalSeconds: number;
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

/** Per-backend configuration (maps to Kekkai's BackendConfig). */
export interface BackendConfig {
  command?: string;
  model?: string;
  timeout?: number;
  args?: string[];
  env?: Record<string, string>;
}

/** Per-domain execution configuration. All fields optional — missing
 *  values are inherited from the Executor's default_domain config.
 *  New-style: domain.backend + domain.backends.<name> for Kekkai.
 *  Legacy Claude-specific fields kept for backward compat, converted
 *  to CLI args by resolveDomainConfig(). */
export interface DomainConfig {
  /** Default backend name for this domain (e.g. "claude", "codex"). */
  backend?: string;
  /** Per-backend configuration, keyed by backend name. */
  backends?: Record<string, BackendConfig>;
  systemPrompt?: string;
  securityPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  args?: string[];
  command?: string;
  permissionMode?: string;
  timeout?: number;
  maxRetries?: number;
  model?: string;
  /** Effort level: low | medium | high | xhigh | max */
  effort?: string;
  /** Comma-separated fallback model(s) */
  fallbackModel?: string;
  /** Max API budget in USD */
  maxBudgetUsd?: number;
  settings?: Record<string, unknown>;
}

export interface ExecutorConfig {
  domains: string[];
  roleDef?: RoleDef[];
  defaultDomain?: DomainConfig;
  prompt?: string;
  coordinatorUrl?: string;
  auth?: 'user' | 'app';
  approvalTimeoutMinutes?: number;
  selfCheck?: boolean;
  hitl?: string;
  hitlPolicy?: string;
  sessionDir?: string;
  httpDownloadTimeout?: number;
}

export interface Config {
  appId: string;
  appSecret?: string;        // optional — PKCE mode doesn't need it
  openApiDomain?: string;    // e.g. "open.feishu.cn" or "open.larksuite.com"
  /** Multi-operator bot configurations. First entry is the "default" operator. */
  operators?: BotConfig[];
  /** Bitable app token. Empty string in agent mode. */
  appToken: string;
  /** Tickets table ID. Empty string in agent mode. */
  ticketsTableId: string;
  /** Turns table ID. Empty string in agent mode. */
  turnsTableId: string;
  /** Roster table ID. Empty string in agent mode. */
  rosterTableId: string;
  /** Optional — Round table for Round-driven state machine mode. */
  roundsTableId?: string;
  /** Optional — Domains table for intent classification. */
  domainsTableId?: string;
  /** Optional — Configs table for channel/operator/messages/coordinator config. */
  configsTableId?: string;
  /** Optional — intent recognition config for LLM-based ability classification. */
  intent?: {
    provider: 'anthropic' | 'openai' | 'deepseek';
    apiKey: string;
    model?: string;
    /** Optional system prompt override for processMessage. */
    systemPrompt?: string;
  };
  /** Per-domain config overrides (from TOML [domain.xxx] sections). */
  domains?: Record<string, DomainConfig>;
  /** Optional — owner's Feishu open_id, used for IM notifications. */
  ownerOpenId?: string;
  /** Optional — owner's union_id, used for Person field writes (cross-app resolvable). */
  ownerUnionId?: string;
  fields: FieldMapping;
  statuses: StatusMapping;
  /** Round state machine status mapping. Required when roundsTableId is set. */
  roundStatuses: RoundStatusMapping;
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
  maxRetries: number;
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
  /** Fallback when no executor matches the required abilities. */
  fallbackNoExecutor?: string;
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
  /** Current Round context (Round-driven mode). */
  round?: BitableRecord;
  /** Supplement prompt from reviewer (Round-driven HITL mode). */
  roundSupplementPrompt?: string;
  /** Round record_id for session traceability (Claude --session-id). */
  roundId?: string;
  /** Required ability labels from the current Round, e.g. ["tech_support.api"].
   *  Used to select the matching AbilityConfig for prompt/tool overrides. */
  domains?: string[];
  /** Downloaded attachments: file_token → local file path, for multimodal model input. */
  downloadedAttachments?: Record<string, string>;
  /** Optional callback for streaming output chunks. Called with each chunk
   *  of content as it becomes available from Kekkai.stream(). */
  onStream?: (content: string, type?: StreamContentType) => void;
}

export interface ProcessResult {
  answer: string;
  newSummary: string;
  newKeyfacts: Record<string, string>;
  /** A2A structured output parts (text, file references, data). */
  parts?: Part[];
  reassignTo?: { roles?: string[]; kind?: string };
  /** Set to true when processing was retried without streaming (e.g. session resume failed). */
  retried?: boolean;
  /** Execution duration in milliseconds. */
  durationMs?: number;
  /** Token usage breakdown from the backend. */
  tokenUsage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export interface Processor {
  process(ctx: ProcessContext): Promise<ProcessResult | null>;
}

export type StreamContentType = 'message' | 'thinking';

export interface CompletenessCheckResult {
  isComplete: boolean;
  summary: string;
  missingFields: string[];
}

