import { logger } from '../lib/log.js';
import { Config, Part, FilePart, BitableRecord, S3Config, RoundStatusMapping } from '../lib/types.js';
import { Session } from '../lib/bitable/protocol.js';
import { extractText } from '../lib/messaging/text.js';
import { BitableClient } from '../lib/bitable/client.js';
import { getDomainConfig } from '../lib/bitable/domain.js';

// =============================================================================
// A2A Protocol implementation
//
// Implements the Agent-to-Agent (A2A) protocol for external agent interop:
//   - A2A Server: receives tasks from external agents via HTTP
//   - A2A Client: sends tasks to external agents
//   - S3 Upload: temporary cloud storage for file sharing with external agents
// =============================================================================

// ---- A2A types ------------------------------------------------------------

/** A2A Task status values. */
export type A2ATaskStatus =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled';

/** An A2A Message containing one or more Parts, with a role. */
export interface A2AMessage {
  role: 'user' | 'agent';
  parts: Part[];
}

/** An output artifact produced during task execution. */
export interface A2AArtifact {
  name: string;
  mime_type?: string;
  /** URI where the artifact can be retrieved. */
  uri: string;
  metadata?: Record<string, unknown>;
}

/** A2A Task — the core unit of work in the A2A protocol. */
export interface A2ATask {
  /** Task ID (maps to Round.id in BAM). */
  id: string;
  /** Current task status. */
  status: A2ATaskStatus;
  /** Conversation messages. */
  messages?: A2AMessage[];
  /** Output artifacts produced during execution. */
  artifacts?: A2AArtifact[];
  /** Arbitrary metadata. */
  metadata?: Record<string, unknown>;
}

/** Agent discovery card (served at /.well-known/agent.json). */
export interface AgentCard {
  name: string;
  description: string;
  /** Base URL of the A2A endpoint. */
  url: string;
  /** Protocol version. */
  version: string;
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
    requiresInput?: boolean;
  };
  authentication?: {
    schemes: string[];
    credentials?: string;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
}

/** Request body for POST /a2a/tasks. */
export interface A2ACreateTaskRequest {
  /** Optional client-provided task ID (generated if omitted). */
  id?: string;
  /** Initial message to start the task. */
  message?: A2AMessage;
  /** Existing conversation messages for context (continuation). */
  messages?: A2AMessage[];
  /** Optional metadata. */
  metadata?: Record<string, unknown>;
}

/** Response from POST /a2a/tasks. */
export interface A2ACreateTaskResponse {
  id: string;
  status: A2ATaskStatus;
  /** Echo back the accepted message if provided. */
  message?: A2AMessage;
  /** Additional info (e.g. "task accepted for processing"). */
  metadata?: Record<string, unknown>;
}

// ---- Status mapping --------------------------------------------------------

/** Map a Round status value to A2A Task status using the configured status map. */
export function roundStatusToA2A(
  roundStatus: string,
  rs: RoundStatusMapping,
): A2ATaskStatus {
  const m: Record<string, A2ATaskStatus> = {
    [rs.pending]: 'submitted',
    [rs.pendingApproval]: 'input-required',
    [rs.approved]: 'submitted',
    [rs.executing]: 'working',
    [rs.done]: 'completed',
    [rs.failed]: 'failed',
    [rs.cancelled]: 'canceled',
  };
  return m[roundStatus] ?? 'failed';
}

// ---- Agent Card builder ----------------------------------------------------

/** Build the Agent Card for external discovery. */
export function buildAgentCard(cfg: Config): AgentCard {
  const baseUrl = cfg.coordinator?.a2a?.baseUrl
    || `http://localhost:${cfg.coordinator?.port || 8080}`;
  return {
    name: cfg.nickname || 'BAM Coordinator',
    description: cfg.executor?.prompt?.slice(0, 200)
      || 'Multi-agent collaboration framework on Feishu Bitable',
    url: baseUrl,
    version: '0.0.3',
    capabilities: {
      pushNotifications: true,
      requiresInput: true,
    },
    defaultInputModes: ['text', 'file'],
    defaultOutputModes: ['text', 'file'],
    authentication: cfg.coordinator?.a2a?.apiToken
      ? { schemes: ['bearer'], credentials: cfg.coordinator.a2a.apiToken }
      : undefined,
  };
}

// ---- A2A Server handlers ---------------------------------------------------

/** Handle POST /a2a/tasks — create a task from an external A2A request.
 *  Returns the created task info. */
export async function handleA2ACreateTask(
  session: Session,
  cfg: Config,
  appToken: string,
  turnsTableId: string,
  body: A2ACreateTaskRequest,
): Promise<A2ACreateTaskResponse> {
  const message = body.message;
  const messages = body.messages ?? (message ? [message] : []);

  if (messages.length === 0) {
    return { id: '', status: 'failed', metadata: { error: 'No messages provided' } };
  }

  // Build content text from messages for the Ticket summary
  const textParts = messages.flatMap(m =>
    m.parts.filter((p): p is { kind: 'text'; text: string } => p.kind === 'text'),
  );
  const summary = textParts.map(p => p.text).join(' ').slice(0, 300) || 'A2A external task';

  // Create a Ticket for this A2A request
  const ticket = await session.createTicket(summary, {
    rootMsgId: `a2a_${body.id || Date.now()}`,
    chatId: '',
    senderId: 'a2a_external',
  });
  const recordId = ticket.record_id;
  if (!recordId) {
    return { id: '', status: 'failed', metadata: { error: 'Failed to create ticket' } };
  }

  // Write each incoming message as a Turn
  for (const msg of messages) {
    const textContent = msg.parts
      .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
      .map(p => p.text)
      .join(' ');
    const dedupKey = `${recordId}_a2a_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const fields: Record<string, unknown> = {
      [cfg.fields.turn.ticketRecordId]: recordId,
      [cfg.fields.turn.rootMsgId]: `a2a_${body.id || Date.now()}`,
      [cfg.fields.turn.role]: msg.role,
      [cfg.fields.turn.content]: textContent || '[A2A external message]',
      [cfg.fields.turn.dedupKey]: dedupKey,
      [cfg.fields.turn.agentIdentity]: 'a2a_external',
      [cfg.fields.turn.createdAt]: Date.now(),
    };

    if (msg.parts.length > 0) {
      // For FileParts from external agents: try to pull the file if needed
      const resolvedParts = await resolveExternalFileParts(msg.parts, cfg, appToken, turnsTableId, recordId);
      fields[cfg.fields.turn.parts] = JSON.stringify(resolvedParts);
    }

    const { BitableClient } = await import('../lib/bitable/client.js');
    const bitable = new BitableClient(cfg);
    await bitable.createRecord(turnsTableId, fields);
  }

  // Create a Round for processing
  let roundId = '';
  if (cfg.roundsTableId) {
    try {
      const round = await session.createRound(recordId);
      roundId = round.record_id ?? '';
      console.log(`[a2a] created round ${roundId} for A2A task`);
    } catch (err) {
      logger.error('[a2a] createRound failed:', err);
    }
  }

  return {
    id: roundId || recordId,
    status: roundId ? 'submitted' : 'working',
    message,
    metadata: {
      ticketId: recordId,
      roundId,
      note: 'Task accepted for processing',
    },
  };
}

/** Handle GET /a2a/tasks/:id — return current task status. */
export async function handleA2AGetTask(
  session: Session,
  cfg: Config,
  taskId: string,
): Promise<A2ATask | null> {
  // Try Round first (Round-driven mode)
  if (cfg.roundsTableId) {
    try {
      const round = await session.getRound(taskId);
      if (round?.record_id) {
        return buildA2ATaskFromRound(round, session, cfg, taskId);
      }
    } catch {
      // Round not found — try as ticket ID
    }
  }

  // Fall back to Ticket
  try {
    const ticket = await session.getTicket(taskId);
    if (!ticket?.record_id) return null;

    const ticketStatus = String(ticket.fields[cfg.fields.ticket.status] ?? '');
    const statusMap: Record<string, A2ATaskStatus> = {
      [cfg.statuses.draft]: 'submitted',
      [cfg.statuses.active]: 'working',
      [cfg.statuses.closed]: 'completed',
    };

    const turns = await session.getTurns(taskId);
    const messages: A2AMessage[] = turns.map(t => ({
      role: (extractText(t.fields[cfg.fields.turn.role]) as 'user' | 'agent') || 'user',
      parts: parsePartsFromTurn(t, cfg),
    }));

    return {
      id: taskId,
      status: statusMap[ticketStatus] ?? 'failed',
      messages,
    };
  } catch {
    return null;
  }
}

/** Handle POST /a2a/tasks/:id/cancel — cancel a task. */
export async function handleA2ACancelTask(
  session: Session,
  cfg: Config,
  taskId: string,
): Promise<{ id: string; status: A2ATaskStatus } | null> {
  if (cfg.roundsTableId) {
    try {
      const ok = await session.transitionRound(taskId, cfg.roundStatuses.cancelled);
      if (ok) {
        return { id: taskId, status: 'canceled' };
      }
    } catch {
      // Fall through to ticket-level cancel
    }
  }

  // Ticket-level cancel
  try {
    const ticket = await session.getTicket(taskId);
    if (ticket?.record_id) {
      const { BitableClient } = await import('../lib/bitable/client.js');
      const bitable = new BitableClient(cfg);
      await bitable.updateRecord(cfg.ticketsTableId, taskId, {
        [cfg.fields.ticket.status]: cfg.statuses.closed,
      });
      return { id: taskId, status: 'canceled' };
    }
  } catch {
    // not found
  }
  return null;
}

/** Build an A2A Task from a Round record. */
async function buildA2ATaskFromRound(
  round: BitableRecord,
  session: Session,
  cfg: Config,
  taskId: string,
): Promise<A2ATask> {
  const roundStatus = String(round.fields[cfg.fields.round.status] ?? '');
  const ticketId = String(round.fields[cfg.fields.round.ticketRecordId] ?? '');

  let messages: A2AMessage[] | undefined;
  let artifacts: A2AArtifact[] | undefined;

  if (ticketId) {
    try {
      const turns = await session.getTurns(ticketId);
      messages = turns.map(t => ({
        role: (extractText(t.fields[cfg.fields.turn.role]) as 'user' | 'agent') || 'user',
        parts: parsePartsFromTurn(t, cfg),
      }));
    } catch { /* turns unavailable */ }
  }

  // Parse artifacts from Round.artifacts field
  const artifactsRaw = round.fields[cfg.fields.round.artifacts] as string | undefined;
  if (artifactsRaw) {
    try {
      artifacts = JSON.parse(artifactsRaw) as A2AArtifact[];
    } catch { /* malformed artifacts */ }
  }

  return {
    id: taskId,
    status: roundStatusToA2A(roundStatus, cfg.roundStatuses),
    messages,
    artifacts,
  };
}

/** Parse parts from a Turn record, checking `parts` JSON first then `content`. */
function parsePartsFromTurn(turn: BitableRecord, cfg: Config): Part[] {
  const partsRaw = extractText(turn.fields[cfg.fields.turn.parts]);
  if (partsRaw) {
    try {
      return JSON.parse(partsRaw) as Part[];
    } catch { /* malformed */ }
  }
  // Fall back to content
  const content = extractText(turn.fields[cfg.fields.turn.content]);
  return content ? [{ kind: 'text', text: content }] : [];
}

/** Resolve external file parts: download external URIs and upload to Bitable. */
async function resolveExternalFileParts(
  parts: Part[],
  cfg: Config,
  appToken: string,
  turnsTableId: string,
  recordId: string,
): Promise<Part[]> {
  const resolved: Part[] = [];
  const dc = getDomainConfig(cfg.openApiDomain);
  const tenantToken = await getTenantAccessToken(cfg, dc.sdkBaseUrl);

  for (const part of parts) {
    if (part.kind === 'file') {
      const fp = part;
      // If file_uri is an external URL (not our proxy), download and re-upload
      if (fp.file_uri && !fp.file_uri.startsWith('/files/') && !fp.file_uri.includes('/files/') && tenantToken) {
        try {
          const resp = await fetch(fp.file_uri, {
            signal: AbortSignal.timeout(30_000),
          });
          if (resp.ok) {
            const buffer = Buffer.from(await resp.arrayBuffer());
            const fileToken = await uploadAttachment(
              buffer, fp.name || 'file', tenantToken, dc.sdkBaseUrl, appToken,
            );
            if (fileToken) {
              resolved.push({
                kind: 'file',
                file_token: fileToken,
                file_uri: `/files/${fileToken}`,
                name: fp.name,
                mime_type: fp.mime_type,
                size: fp.size,
              });
              continue;
            }
          }
        } catch (err) {
          logger.error(`[a2a] failed to resolve external file ${fp.file_uri}:`, err);
        }
      }
      // Keep original file part if resolution fails or already internal
      resolved.push(fp);
    } else {
      resolved.push(part);
    }
  }

  return resolved;
}

/** Upload a buffer to the Bitable attachment field and return file_token. */
async function uploadAttachment(
  buffer: Buffer,
  fileName: string,
  tenantToken: string,
  baseDomain: string,
  appToken: string,
): Promise<string | null> {
  const base = baseDomain.replace(/^https?:\/\//, '');
  // Upload to Feishu Drive first, then reference the file_token in Bitable
  const uploadUrl = `https://${base}/open-apis/drive/v1/medias/upload_all`;
  try {
    const formData = new FormData();
    formData.append('file_name', fileName);
    formData.append('parent_type', 'bitable_file');
    formData.append('parent_node', `${appToken}`);
    formData.append('size', String(buffer.byteLength));
    formData.append('file', new Blob([buffer as any], { type: 'application/octet-stream' }), fileName);
    const resp = await fetch(uploadUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenantToken}` },
      body: formData,
    });
    const rawText = await resp.text();
    console.log(`[a2a] uploadAttachment: HTTP ${resp.status} body=${rawText.slice(0, 200)}`);
    let result: Record<string, any>;
    try {
      result = JSON.parse(rawText) as Record<string, any>;
    } catch {
      console.log(`[a2a] uploadAttachment: non-JSON response, full body=${rawText.slice(0, 500)}`);
      return null;
    }
    if (result.code !== 0) {
      const msg = (result.msg || result.error?.message || '').slice(0, 100);
      logger.error(`[a2a] upload attachment failed: ${JSON.stringify(result).slice(0, 200)}`);
      console.log(`[a2a] uploadAttachment: FAILED (code=${result.code} msg=${msg})`);
      return null;
    }
    const fileToken = (result.data?.file_token as string) || null;
    console.log(`[a2a] uploadAttachment: ok token=${fileToken ?? '?'}`);
    return fileToken;
  } catch (err) {
    logger.error('[a2a] upload attachment error:', err);
    console.log(`[a2a] uploadAttachment: fetch error: ${(err as Error).message}`);
    return null;
  }
}

/** Get tenant_access_token using app credentials. */
async function getTenantAccessToken(
  cfg: Config,
  baseDomain: string,
): Promise<string | null> {
  try {
    const base = baseDomain.replace(/^https?:\/\//, '');
    const resp = await fetch(`https://${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    });
    const data = await resp.json() as Record<string, unknown>;
    const token = (data.tenant_access_token as string) || null;
    if (!token) console.log(`[a2a] getTenantAccessToken: FAILED (code=${data.code} msg=${(data as any).msg})`);
    return token;
  } catch (err) {
    logger.error('[a2a] getTenantAccessToken failed:', err);
    console.log(`[a2a] getTenantAccessToken: fetch error: ${(err as Error).message}`);
    return null;
  }
}

// ---- A2A Client ------------------------------------------------------------

/** Send a task to an external A2A agent.
 *  Returns the A2A task response from the remote server. */
export async function sendToExternalAgent(
  baseUrl: string,
  task: A2ATask,
  apiToken?: string,
): Promise<A2ACreateTaskResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;

  const url = `${baseUrl.replace(/\/+$/, '')}/a2a/tasks`;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: task.id,
      messages: task.messages,
      metadata: task.metadata,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => 'unknown error');
    throw new Error(`A2A client error ${resp.status} from ${url}: ${errText.slice(0, 200)}`);
  }

  return (await resp.json()) as A2ACreateTaskResponse;
}

/** Poll an external A2A task until completion or timeout. */
export async function pollExternalTask(
  baseUrl: string,
  taskId: string,
  timeoutMs: number,
  apiToken?: string,
): Promise<A2ATask> {
  const deadline = Date.now() + timeoutMs;
  const headers: Record<string, string> = {};
  if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;

  const url = `${baseUrl.replace(/\/+$/, '')}/a2a/tasks/${taskId}`;

  while (Date.now() < deadline) {
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`A2A poll error ${resp.status} from ${url}`);
    }
    const task = (await resp.json()) as A2ATask;

    if (!['submitted', 'working'].includes(task.status)) {
      return task;
    }

    await sleep(2000);
  }

  throw new Error(`A2A task ${taskId} timed out after ${timeoutMs}ms`);
}

/** Send a cancel request to an external agent. */
export async function cancelExternalTask(
  baseUrl: string,
  taskId: string,
  apiToken?: string,
): Promise<boolean> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;

  const url = `${baseUrl.replace(/\/+$/, '')}/a2a/tasks/${taskId}/cancel`;
  try {
    const resp = await fetch(url, { method: 'POST', headers });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Convert internal Round+Turns to an A2A Task for external dispatch. */
export async function buildA2ATaskFromRoundAndTurns(
  round: BitableRecord,
  turns: BitableRecord[],
  cfg: Config,
): Promise<A2ATask> {
  const roundId = round.record_id ?? '';
  const roundStatus = String(round.fields[cfg.fields.round.status] ?? '');

  const messages: A2AMessage[] = turns.map(t => ({
    role: (extractText(t.fields[cfg.fields.turn.role]) as 'user' | 'agent') || 'user',
    parts: parsePartsFromTurn(t, cfg),
  }));

  let artifacts: A2AArtifact[] | undefined;
  const artifactsRaw = round.fields[cfg.fields.round.artifacts] as string | undefined;
  if (artifactsRaw) {
    try {
      artifacts = JSON.parse(artifactsRaw) as A2AArtifact[];
    } catch { /* */ }
  }

  return {
    id: roundId,
    status: roundStatusToA2A(roundStatus, cfg.roundStatuses),
    messages,
    artifacts,
    metadata: {
      executor: String(round.fields[cfg.fields.round.executor] ?? ''),
      reviewer: String(round.fields[cfg.fields.round.reviewer] ?? ''),
    },
  };
}

// ---- A2A Server route builder ----------------------------------------------

/** Parse the request body from an IncomingMessage. */
export function parseBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(body ? JSON.parse(body) : {});
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

/** Route an incoming A2A HTTP request. Returns false if the path was not handled. */
export async function routeA2ARequest(
  req: any,
  res: any,
  session: Session,
  cfg: Config,
): Promise<boolean> {
  const url = req.url ?? '';
  const method = req.method ?? 'GET';

  try {
    // POST /a2a/tasks — create a new task
    if (method === 'POST' && url === '/a2a/tasks') {
      const body = await parseBody(req);
      const result = await handleA2ACreateTask(
        session, cfg, cfg.appToken, cfg.turnsTableId, body,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return true;
    }

    // POST /a2a/tasks/:id/cancel — cancel a task
    const cancelMatch = url.match(/^\/a2a\/tasks\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelMatch) {
      const taskId = cancelMatch[1];
      const result = await handleA2ACancelTask(session, cfg, taskId);
      if (result) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
      }
      return true;
    }

    // GET /a2a/tasks/:id — get task status
    const getMatch = url.match(/^\/a2a\/tasks\/([^/]+)$/);
    if (method === 'GET' && getMatch) {
      const taskId = getMatch[1];
      const task = await handleA2AGetTask(session, cfg, taskId);
      if (task) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(task));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
      }
      return true;
    }

    // GET /.well-known/agent.json — Agent Card
    if (method === 'GET' && url === '/.well-known/agent.json') {
      const card = buildAgentCard(cfg);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(card));
      return true;
    }

    return false;
  } catch (err: any) {
    logger.error('[a2a] route error:', err.message);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
    return true;
  }
}

/** Verify A2A request authorization. Returns true if authorized. */
export function verifyA2AAuth(req: any, cfg: Config): boolean {
  const apiToken = cfg.coordinator?.a2a?.apiToken;
  if (!apiToken) return true; // no auth configured
  const auth = req.headers?.['authorization'] as string | undefined;
  if (!auth) return false;
  return auth === `Bearer ${apiToken}` || auth === apiToken;
}

// ---- S3 Upload utility -----------------------------------------------------

/** Upload a buffer to S3-compatible storage and return a URL.
 *  If S3 is not configured or the SDK is unavailable, returns null. */
export async function uploadToS3(
  buffer: Buffer,
  fileName: string,
  s3Config?: S3Config,
): Promise<string | null> {
  if (!s3Config?.bucket || !s3Config?.region) {
    logger.warn('[a2a] S3 not configured — external file sharing unavailable');
    return null;
  }

  try {
    const s3 = await importS3();
    if (!s3) {
      logger.warn('[a2a] @aws-sdk/client-s3 not installed — S3 upload unavailable');
      return null;
    }

    const { S3Client, PutObjectCommand } = s3;
    const client = new S3Client({
      region: s3Config.region,
      credentials: {
        accessKeyId: s3Config.accessKeyId ?? '',
        secretAccessKey: s3Config.secretAccessKey ?? '',
      },
      endpoint: s3Config.endpoint || undefined,
      forcePathStyle: s3Config.forcePathStyle || undefined,
    });

    const key = `a2a-files/${Date.now()}_${fileName}`;
    await client.send(new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
      Body: buffer,
    }));

    const region = s3Config.region;
    const bucket = s3Config.bucket;
    const url = s3Config.endpoint
      ? `${s3Config.endpoint.replace(/\/+$/, '')}/${bucket}/${key}`
      : `https://${bucket}.s3.${region}.amazonaws.com/${key}`;

    console.log(`[a2a] uploaded to S3: ${url}`);
    return url;
  } catch (err) {
    logger.error('[a2a] S3 upload failed:', err);
    return null;
  }
}

/** Upload a file from a URI to S3 for external sharing.
 *  Downloads from the URI, then uploads to S3, returning the public URL. */
export async function uploadFileToS3ForSharing(
  fileUri: string,
  fileName: string,
  s3Config?: S3Config,
): Promise<string | null> {
  if (!s3Config?.bucket) return null;

  try {
    const resp = await fetch(fileUri, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) {
      logger.error(`[a2a] failed to fetch file for S3 upload: ${resp.status}`);
      return null;
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    return uploadToS3(buffer, fileName, s3Config);
  } catch (err) {
    logger.error('[a2a] uploadFileToS3ForSharing failed:', err);
    return null;
  }
}

// ---- Dynamic import helpers ------------------------------------------------

/** Dynamic import of @aws-sdk/client-s3. Returns null if unavailable. */
async function importS3(): Promise<{ S3Client: any; PutObjectCommand: any } | null> {
  try {
    // @ts-ignore - @aws-sdk/client-s3 is optional, installed only when S3 sharing is needed
    const mod = await import('@aws-sdk/client-s3');
    return {
      S3Client: mod.S3Client,
      PutObjectCommand: mod.PutObjectCommand,
    };
  } catch {
    return null;
  }
}

// =============================================================================
// Attachment utilities — resolve Feishu IM images to Drive file_tokens
// =============================================================================

/** Resolve Feishu IM image_keys in FileParts to real Drive file_tokens.
 *  Downloads each image from Feishu IM and uploads to Drive, returning a new
 *  parts array with resolved file_tokens. Unresolved images are left as-is.
 *  Caller writes the returned parts directly when creating the Turn. */
export async function resolveImageParts(
  parts: Part[],
  cfg: Config,
  messageId?: string,
): Promise<{ parts: Part[]; attachmentTokens: string[] }> {
  const unresolvedIndices: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.kind === 'file' && p.file_token && p.file_token.startsWith('img_v3_')) {
      unresolvedIndices.push(i);
    }
  }
  if (unresolvedIndices.length === 0) return { parts, attachmentTokens: [] };
  console.log(`[a2a] resolveImageParts: ${unresolvedIndices.length} image(s) to resolve`);

  const dc = getDomainConfig(cfg.openApiDomain);
  let imgToken = await getTenantAccessToken(cfg, dc.sdkBaseUrl);
  if (!imgToken) {
    try {
      const appResp = await fetch(`${dc.sdkBaseUrl}/open-apis/auth/v3/app_access_token/internal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
      });
      const appData = await appResp.json() as Record<string, unknown>;
      imgToken = (appData.app_access_token as string) || (appData as any).tenant_access_token || '';
    } catch { /* */ }
  }
  if (!imgToken) {
    console.log('[a2a] resolveImageParts: no token available');
    return { parts, attachmentTokens: [] };
  }
  console.log('[a2a] resolveImageParts: token obtained');

  const resolved = [...parts];
  const attachmentTokens: string[] = [];

  for (const idx of unresolvedIndices) {
    const fp = resolved[idx] as FilePart;
    console.log(`[a2a] resolveImageParts: [${idx}] downloading ${fp.file_token.slice(0, 24)}...`);
    try {
      const imgUrl = messageId
        ? `${dc.sdkBaseUrl}/open-apis/im/v1/messages/${messageId}/resources/${fp.file_token}?type=image`
        : `${dc.sdkBaseUrl}/open-apis/im/v1/images/${fp.file_token}`;
      const imgResp = await fetch(imgUrl, {
        headers: { Authorization: `Bearer ${imgToken}` },
      });
      if (!imgResp.ok) {
        const errText = await imgResp.text().catch(() => '');
        console.log(`[a2a] resolveImageParts: [${idx}] download FAILED (HTTP ${imgResp.status}) body=${errText.slice(0, 150)}`);
        continue;
      }
      const imageBuffer = Buffer.from(await imgResp.arrayBuffer());
      if (imageBuffer.length === 0) {
        console.log(`[a2a] resolveImageParts: [${idx}] download EMPTY`);
        continue;
      }
      console.log(`[a2a] resolveImageParts: [${idx}] downloaded ${imageBuffer.length} bytes`);

      const fileToken = await uploadAttachment(
        imageBuffer, fp.name || 'image.png', imgToken, dc.sdkBaseUrl, cfg.appToken,
      );
      if (fileToken) {
        console.log(`[a2a] resolveImageParts: [${idx}] uploaded → ${fileToken}`);
        attachmentTokens.push(fileToken);
        resolved[idx] = {
          kind: 'file', file_token: fileToken, file_uri: `/files/${fileToken}`,
          name: fp.name || 'image.png', mime_type: fp.mime_type || 'image/png', size: imageBuffer.length,
        };
      } else {
        console.log(`[a2a] resolveImageParts: [${idx}] upload FAILED`);
      }
    } catch (err) {
      console.log(`[a2a] resolveImageParts: [${idx}] error: ${(err as Error).message}`);
    }
  }
  return { parts: resolved, attachmentTokens };
}

/** @deprecated Use resolveImageParts + write attachments when creating the Turn. */
export async function resolvePostMessageImages(
  parts: Part[],
  cfg: Config,
  _appToken: string,
  _tableId: string,
  _recordId: string,
  messageId?: string,
): Promise<void> {
  await resolveImageParts(parts, cfg, messageId);
}

// ---- Utility ---------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
