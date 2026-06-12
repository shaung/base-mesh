import { logger } from './log.js';
import { Client } from '@larksuiteoapi/node-sdk';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { input, select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { getDomainConfig } from './domain.js';
import { UserTokenProvider, loadStoredTokens } from './auth.js';

// ---------------------------------------------------------------------------
// Bitable field type constants
// ---------------------------------------------------------------------------

const FT = {
  Text: 1,
  Number: 2,
  SingleSelect: 3,
  MultiSelect: 4,
  Checkbox: 7,
  Person: 11,
  Attachment: 17,
  CreatedTime: 1001,
  ModifiedTime: 1002,
} as const;

interface FieldDef {
  field_name: string;
  type: number;
  property?: Record<string, unknown>;
}

export interface SetupResult {
  appToken: string;
  appUrl?: string;
  ticketsTableId: string;
  turnsTableId: string;
  rosterTableId: string;
  roundsTableId?: string;
  domainsTableId?: string;
  configsTableId?: string;
}

export interface SetupOptions {
  appId: string;
  appSecret: string;
  openApiDomain?: string;
  appName?: string;
  /** Feishu open_id to grant edit permission and register as Roster.human. */
  ownerOpenId?: string;
  /** If provided, skip base creation and use this existing token. */
  existingAppToken?: string;
}

// ---------------------------------------------------------------------------
// Interactive prompt helpers (zero dependencies)
// ---------------------------------------------------------------------------

async function promptInput(message: string, def?: string): Promise<string> {
  return input({ message, default: def });
}

async function promptList(message: string, choices: Array<{ name: string; value: any }>): Promise<any> {
  return select({ message, choices } as any);
}

async function promptConfirm(message: string, def = true): Promise<boolean> {
  return confirm({ message, default: def });
}

// ---------------------------------------------------------------------------
// Parse a Feishu/Lark Bitable URL to extract app_token and detect domain
// ---------------------------------------------------------------------------

interface ParsedBitableUrl {
  appToken: string;
  openApiDomain?: string;
  configsTableId?: string;
}

function parseBitableUrl(url: string): ParsedBitableUrl | null {
  try {
    const parsed = new URL(url.trim());
    const match = parsed.pathname.match(/\/base\/([a-zA-Z0-9]+)/);
    if (!match) return null;

    let openApiDomain: string | undefined;
    const host = parsed.hostname;
    if (host.includes('larksuite.com')) openApiDomain = 'open.larksuite.com';
    else if (host.includes('feishu.cn') || host.endsWith('.feishu.cn')) openApiDomain = 'open.feishu.cn';
    // For unrecognized hosts, leave undefined (user will confirm domain)

    const configsTableId = parsed.searchParams.get('table') || undefined;

    return { appToken: match[1], openApiDomain, configsTableId };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Load .env into process.env (mirrors config.ts logic)
// ---------------------------------------------------------------------------

function loadEnvFile(path: string): void {
  try {
    const content = readFileSync(path, 'utf-8');
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch { /* .env is optional at this point */ }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load .env from project root
for (const dir of [ROOT, process.cwd()]) {
  const p = join(dir, '.env');
  if (existsSync(p)) { loadEnvFile(p); break; }
}

// ---------------------------------------------------------------------------
// Create a Lark SDK Client from credentials
// ---------------------------------------------------------------------------

function createClient(opts: { appId: string; appSecret: string; openApiDomain?: string }): Client {
  const dc = getDomainConfig(opts.openApiDomain);
  return new Client({ appId: opts.appId, appSecret: opts.appSecret, domain: dc.sdkBaseUrl });
}

// ---------------------------------------------------------------------------
// List all tables in a Bitable base
// ---------------------------------------------------------------------------

interface TableInfo {
  table_id: string;
  name?: string;
}

async function listTables(client: Client, appToken: string): Promise<TableInfo[]> {
  const tables: TableInfo[] = [];
  let pageToken: string | null = null;

  for (let i = 0; i < 20; i++) {
    const resp = await client.bitable.appTable.list({
      path: { app_token: appToken },
      params: { page_token: pageToken ?? undefined, page_size: 50 } as any,
    });
    if (resp.code !== 0) {
      throw new Error(`List tables failed: ${JSON.stringify(resp)}`);
    }
    const items = (resp.data?.items ?? []) as any[];
    for (const item of items) {
      tables.push({ table_id: item.table_id, name: item.name });
    }
    if (!resp.data?.has_more) break;
    pageToken = (resp.data?.page_token as string) ?? null;
  }
  return tables;
}

// ---------------------------------------------------------------------------
// List all tables using user token (no appSecret needed)
// ---------------------------------------------------------------------------

async function listTablesWithUserToken(appId: string, appToken: string, openApiDomain: string): Promise<TableInfo[]> {
  const provider = UserTokenProvider.fromStore(appId);
  if (!provider) {
    throw new Error('Not logged in. Run setup with login or provide appSecret.');
  }

  const token = await provider.getToken();
  const dc = getDomainConfig(openApiDomain);

  const tables: TableInfo[] = [];
  let pageToken: string | null = null;

  for (let i = 0; i < 20; i++) {
    const url = `${dc.sdkBaseUrl}/open-apis/bitable/v1/apps/${appToken}/tables?page_size=50${pageToken ? `&page_token=${pageToken}` : ''}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await resp.json() as any;
    if (body.code !== 0) {
      throw new Error(`List tables failed: ${JSON.stringify(body)}`);
    }
    const items = body.data?.items ?? [];
    for (const item of items) {
      tables.push({ table_id: item.table_id, name: item.name });
    }
    if (!body.data?.has_more) break;
    pageToken = body.data?.page_token ?? null;
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Create a single table with fields
// ---------------------------------------------------------------------------

async function createTable(
  client: Client,
  appToken: string,
  name: string,
  fields: FieldDef[],
): Promise<string> {
  const resp = await client.bitable.appTable.create({
    path: { app_token: appToken },
    data: { table: { name, fields: fields as any } },
  });
  if (resp.code !== 0) {
    throw new Error(`Create table "${name}" failed: ${JSON.stringify(resp)}`);
  }
  const tableId = (resp.data as any)?.table_id;
  if (!tableId) {
    throw new Error(`No table_id in response for "${name}": ${JSON.stringify(resp)}`);
  }
  return tableId;
}

// ---------------------------------------------------------------------------
// Programmatic Bitable creation (headless / imported use)
// ---------------------------------------------------------------------------

export async function createBaseMesh(opts: SetupOptions): Promise<SetupResult> {
  const client = createClient(opts);

  let appToken: string;
  let appUrl: string | undefined;

  if (opts.existingAppToken) {
    appToken = opts.existingAppToken;
    console.log(`  Using existing bitable: ${appToken}`);
  } else {
    const appName = opts.appName ?? 'base-mesh';
    console.log(`  Creating bitable "${appName}"...`);
    const appResp = await client.bitable.app.create({
      data: { name: appName },
    });
    if (appResp.code !== 0 || !appResp.data?.app?.app_token) {
      throw new Error(`Create bitable app failed: ${JSON.stringify(appResp)}`);
    }
    appToken = appResp.data.app.app_token;
    appUrl = appResp.data.app.url;
    console.log(`  ✓ app_token: ${appToken}`);
    if (appUrl) console.log(`  ✓ url: ${appUrl}`);
  }

  console.log('  Creating tables...');
  const ticketsTableId = await createTable(client, appToken, 'Tickets', [
    { field_name: 'root_msg_id', type: FT.Text },
    { field_name: 'status', type: FT.SingleSelect, property: { options: [
      { name: 'draft', color: 0 },
      { name: 'active', color: 1 },
      { name: 'closed', color: 5 },
    ]}},
    { field_name: 'owner', type: FT.Text },
    { field_name: 'owner_lease_at', type: FT.Number },
    { field_name: 'retry_count', type: FT.Number },
    { field_name: 'summary', type: FT.Text },
    { field_name: 'keyfacts', type: FT.Text },
    { field_name: 'domain', type: FT.Text },
    { field_name: 'last_owner', type: FT.Text },
    { field_name: 'last_round_id', type: FT.Text },
    { field_name: 'chat_id', type: FT.Text },
    { field_name: 'sender_id', type: FT.Text },
    { field_name: 'result', type: FT.Text },
    { field_name: 'metadata', type: FT.Text },
    { field_name: 'approvers', type: FT.Person, property: { multiple: true } },
    { field_name: 'created_at', type: FT.CreatedTime },
    { field_name: 'updated_at', type: FT.ModifiedTime },
  ]);
  console.log(`  ✓ Tickets: ${ticketsTableId}`);

  const turnsTableId = await createTable(client, appToken, 'Turns', [
    { field_name: 'root_msg_id', type: FT.Text },
    { field_name: 'ticket_record_id', type: FT.Text },
    { field_name: 'round_id', type: FT.Text },
    { field_name: 'role', type: FT.Text },
    { field_name: 'content', type: FT.Text },
    { field_name: 'parts', type: FT.Text },
    { field_name: 'attachments', type: FT.Attachment },
    { field_name: 'turn_status', type: FT.SingleSelect, property: { options: [
      { name: 'processing', color: 0 },
      { name: 'answered', color: 1 },
      { name: 'error', color: 2 },
      { name: 'pending_review', color: 6 },
      { name: 'approved', color: 3 },
      { name: 'rejected', color: 4 },
    ]}},
    { field_name: 'dedup_key', type: FT.Text },
    { field_name: 'agent_identity', type: FT.Text },
    { field_name: 'human', type: FT.Person, property: { multiple: true } },
    { field_name: 'delivery_owner', type: FT.Text },
    { field_name: 'delivery_lease_at', type: FT.Number },
    { field_name: 'created_at', type: FT.CreatedTime },
    { field_name: 'notified', type: FT.Number },
    { field_name: 'metadata', type: FT.Text },
    { field_name: 'updated_at', type: FT.ModifiedTime },
  ]);
  console.log(`  ✓ Turns: ${turnsTableId}`);

  const rosterTableId = await createTable(client, appToken, 'Roster', [
    { field_name: 'identity', type: FT.Text },
    { field_name: 'nickname', type: FT.Text },
    { field_name: 'kind', type: FT.SingleSelect, property: { options: [{ name: 'human', color: 0 }, { name: 'agent', color: 1 }, { name: 'system', color: 2 }] } },
    { field_name: 'metadata', type: FT.Text },
    { field_name: 'description', type: FT.Text },
    { field_name: 'last_seen_at', type: FT.Number },
    { field_name: 'registered_at', type: FT.Number },
    { field_name: 'domains', type: FT.MultiSelect, property: { options: [{ name: 'general', color: 0 }] } },
    { field_name: 'enabled', type: FT.Checkbox },
    { field_name: 'hitl', type: FT.SingleSelect, property: { options: [{ name: 'off', color: 0 }, { name: 'auto', color: 1 }, { name: 'always', color: 2 }] } },
    { field_name: 'hitl_policy', type: FT.SingleSelect, property: { options: [{ name: 'default', color: 0 }, { name: 'off', color: 1 }, { name: 'auto', color: 2 }, { name: 'always', color: 3 }] } },
    { field_name: 'human', type: FT.Person, property: { multiple: true } },
    { field_name: 'created_at', type: FT.CreatedTime },
    { field_name: 'updated_at', type: FT.ModifiedTime },
  ]);
  console.log(`  ✓ Roster: ${rosterTableId}`);

  const roundsTableId = await createTable(client, appToken, 'Rounds', [
    { field_name: 'ticket_record_id', type: FT.Text },
    { field_name: 'domains', type: FT.Text },
    { field_name: 'round_status', type: FT.SingleSelect, property: { options: [
      { name: 'pending', color: 0 },
      { name: 'pending_approval', color: 6 },
      { name: 'approved', color: 3 },
      { name: 'rejected', color: 4 },
      { name: 'executing', color: 2 },
      { name: 'done', color: 3 },
      { name: 'failed', color: 4 },
      { name: 'cancelled', color: 5 },
    ]}},
    { field_name: 'executor', type: FT.Text },
    { field_name: 'reviewer', type: FT.Person, property: { multiple: false } },
    { field_name: 'review_comment', type: FT.Text },
    { field_name: 'supplement_prompt', type: FT.Text },
    { field_name: 'result', type: FT.Text },
    { field_name: 'artifacts', type: FT.Text },
    { field_name: 'created_at', type: FT.CreatedTime },
    { field_name: 'updated_at', type: FT.ModifiedTime },
  ]);
  console.log(`  ✓ Rounds: ${roundsTableId}`);

  const domainsTableId = await createTable(client, appToken, 'Domains', [
    { field_name: 'domain', type: FT.Text },
    { field_name: 'display_name', type: FT.Text },
    { field_name: 'description', type: FT.Text },
    { field_name: 'prompt', type: FT.Text },
    { field_name: 'enabled', type: FT.Checkbox },
    { field_name: 'created_at', type: FT.CreatedTime },
    { field_name: 'updated_at', type: FT.ModifiedTime },
  ]);
  console.log(`  ✓ Domains: ${domainsTableId}`);

  const configsTableId = await createTable(client, appToken, 'Configs', [
    { field_name: 'section', type: FT.SingleSelect, property: { options: [
      { name: 'channel', color: 0 },
      { name: 'operator', color: 1 },
      { name: 'messages', color: 2 },
      { name: 'coordinator', color: 3 },
    ]}},
    { field_name: 'key', type: FT.Text },
    { field_name: 'value', type: FT.Text },
    { field_name: 'default', type: FT.Text },
    { field_name: 'type', type: FT.SingleSelect, property: { options: [
      { name: 'string', color: 0 },
      { name: 'number', color: 1 },
      { name: 'boolean', color: 2 },
    ]}},
    { field_name: 'description', type: FT.Text },
    { field_name: 'created_at', type: FT.CreatedTime },
    { field_name: 'updated_at', type: FT.ModifiedTime },
  ]);
  console.log(`  ✓ Configs: ${configsTableId}`);

  // Remove the auto-created default blank table
  const knownTableIds = new Set([ticketsTableId, turnsTableId, rosterTableId, roundsTableId, configsTableId]);
  try {
    const allTables = await listTables(client, appToken);
    for (const t of allTables) {
      if (!knownTableIds.has(t.table_id)) {
        await client.bitable.appTable.delete({ path: { app_token: appToken, table_id: t.table_id } } as any);
        console.log(`  🗑 Removed default table: ${t.name ?? t.table_id}`);
      }
    }
  } catch { /* best effort */ }

  // Seed default config rows
  const configDefaults = [
    // channel — table IDs (value filled from created table IDs)
    { section: 'channel', key: 'tickets_table_id', value: ticketsTableId, default: '', type: 'string', description: 'Tickets table ID' },
    { section: 'channel', key: 'turns_table_id', value: turnsTableId, default: '', type: 'string', description: 'Turns table ID' },
    { section: 'channel', key: 'roster_table_id', value: rosterTableId, default: '', type: 'string', description: 'Roster table ID' },
    { section: 'channel', key: 'rounds_table_id', value: roundsTableId, default: '', type: 'string', description: 'Rounds table ID' },
    { section: 'channel', key: 'domains_table_id', value: domainsTableId, default: '', type: 'string', description: 'Domains table ID' },
    { section: 'channel', key: 'draft_ttl_minutes', default: '60', type: 'number', description: 'Draft ticket TTL in minutes' },
    { section: 'channel', key: 'poll_interval_seconds', default: '3', type: 'number', description: 'Poll interval for new turns' },
    { section: 'channel', key: 'reaction_mode', default: 'emoji', type: 'string', description: 'Ack mode: emoji, card, or both' },
    { section: 'channel', key: 'default_hitl_policy', default: 'off', type: 'string', description: 'Default HITL policy' },
    // operator.intent (intent recognition — disabled by default, user enables in Configs table)
    { section: 'operator.intent', key: 'enabled', default: 'false', type: 'boolean', description: 'Enable LLM-based intent recognition' },
    { section: 'operator.intent', key: 'provider', default: '', type: 'string', description: 'LLM provider: deepseek, openai, anthropic' },
    { section: 'operator.intent', key: 'api_key_env', default: 'BAM_INTENT_API_KEY', type: 'string', description: 'Env var name holding the LLM API key' },
    { section: 'operator.intent', key: 'model', default: '', type: 'string', description: 'LLM model name' },
    { section: 'operator.intent', key: 'system_prompt', default: '', type: 'string', description: 'Optional system prompt override' },
    // messages
    { section: 'messages', key: 'task_done', default: '✅ Done processing', type: 'string', description: '' },
    { section: 'messages', key: 'task_assigned', default: '🤖 {identity} started processing', type: 'string', description: '' },
    { section: 'messages', key: 'human_notification', default: '📋 New task pending {mentions}\n{summary}', type: 'string', description: '' },
    { section: 'messages', key: 'ack_received', default: '✅ Received', type: 'string', description: '' },
    { section: 'messages', key: 'clarify_question', default: 'Could you please describe the issue in more detail? If you have any relevant order numbers or error messages, please also provide them, and I\'ll help investigate.', type: 'string', description: '' },
    { section: 'messages', key: 'ticket_reactivated', default: 'Ticket reactivated, queued for processing', type: 'string', description: '' },
    { section: 'messages', key: 'cc_format', default: '{content}\n\ncc {mentions}', type: 'string', description: '' },
    { section: 'messages', key: 'error_fallback', default: 'Analysis could not be completed ({reason}), handing off to human; ticket re-queued, another online agent may pick it up.', type: 'string', description: '' },
    { section: 'messages', key: 'retry_fallback', default: 'Analysis could not be completed ({reason}), will auto-retry ({retryCount}/{maxRetries}).', type: 'string', description: '' },
    { section: 'messages', key: 'exhausted_fallback', default: 'Analysis could not be completed ({reason}), all retries exhausted. Reply to this message to reactivate the ticket.', type: 'string', description: '' },
    { section: 'messages', key: 'ack_template', default: 'Received, checking{ackHints}. Will reply shortly. ({nickname})', type: 'string', description: '' },
    { section: 'messages', key: 'approval_wait', default: '⏳ Awaiting approval from {mentions}', type: 'string', description: '' },
    { section: 'messages', key: 'approval_denied', default: '⏳ Ticket not approved ({reason}), escalated to human processing', type: 'string', description: '' },
    { section: 'messages', key: 'review_wait', default: '📋 Answer pending review, reviewers notified', type: 'string', description: '' },
    { section: 'messages', key: 'review_retry', default: '📋 Answer regenerated, pending re-review', type: 'string', description: '' },
    { section: 'messages', key: 'review_timeout', default: '⏳ Review timed out, escalated to human processing', type: 'string', description: '' },
    { section: 'messages', key: 'review_rejected', default: '⏳ Review rejected again, escalated to human processing', type: 'string', description: '' },
    { section: 'messages', key: 'reassign_fallback', default: 'Transferring...', type: 'string', description: '' },
    { section: 'messages', key: 'empty_answer_fallback', default: '(no answer)', type: 'string', description: '' },
    // coordinator
    { section: 'coordinator', key: 'port', default: '8765', type: 'number', description: 'WS listen port (0 = disabled)' },
    { section: 'coordinator', key: 'poll_interval_seconds', default: '30', type: 'number', description: '' },
    { section: 'coordinator', key: 'file_proxy_enabled', default: 'true', type: 'boolean', description: '' },
    { section: 'coordinator', key: 'heartbeat_seconds', default: '60', type: 'number', description: '' },
    { section: 'coordinator', key: 'session_ttl_days', default: '30', type: 'number', description: '' },
    { section: 'coordinator', key: 'default_hitl_policy', default: 'off', type: 'string', description: '' },
    { section: 'coordinator', key: 'global_prompt', default: 'You are a support agent in an async collaboration system.', type: 'string', description: '' },
    // coordinator.a2a
    { section: 'coordinator.a2a', key: 'enabled', default: 'false', type: 'boolean', description: '' },
    { section: 'coordinator.a2a', key: 'base_url', default: '', type: 'string', description: '' },
    { section: 'coordinator.a2a', key: 'api_token', default: '', type: 'string', description: '' },
    // coordinator.s3
    { section: 'coordinator.s3', key: 'region', default: '', type: 'string', description: '' },
    { section: 'coordinator.s3', key: 'bucket', default: '', type: 'string', description: '' },
    { section: 'coordinator.s3', key: 'access_key_id', default: '', type: 'string', description: '' },
    { section: 'coordinator.s3', key: 'secret_access_key', default: '', type: 'string', description: '' },
    { section: 'coordinator.s3', key: 'presign_expires_seconds', default: '3600', type: 'number', description: '' },
    { section: 'coordinator.s3', key: 'endpoint', default: '', type: 'string', description: '' },
    { section: 'coordinator.s3', key: 'force_path_style', default: 'false', type: 'boolean', description: '' },
  ];
  for (const row of configDefaults) {
    try {
      const fields: Record<string, unknown> = { section: row.section, key: row.key, default: row.default, type: row.type, description: row.description };
      if ('value' in row && row.value) fields.value = row.value;
      await client.bitable.appTableRecord.create({
        path: { app_token: appToken, table_id: configsTableId },
        data: { fields },
      } as any);
    } catch (err: any) {
      console.log(`  ⚠ Failed to seed config "${row.section}.${row.key}": ${err.message}`);
    }
  }

  if (opts.ownerOpenId) {
    const { grantBitableAccess } = await import('./bitable-auth.js');
    const ok = await grantBitableAccess({
      appId: opts.appId, appSecret: opts.appSecret, openApiDomain: opts.openApiDomain,
      appToken, memberType: 'openid', memberId: opts.ownerOpenId,
    });
    if (ok) console.log(`  ✓ Granted edit access to ${opts.ownerOpenId}`);
    else console.log(`  ⚠ Could not auto-grant access to ${opts.ownerOpenId}`);
  }

  return { appToken, appUrl, ticketsTableId, turnsTableId, rosterTableId, domainsTableId, configsTableId };
}

// ---------------------------------------------------------------------------
// Build a complete config object from template + discovered IDs
// ---------------------------------------------------------------------------

function buildConfig(
  fields: { appId: string; appSecret?: string; openApiDomain?: string; ownerOpenId?: string },
  result: SetupResult,
): Record<string, unknown> {
  return {
    channel: {
      appId: fields.appId,
      ...(fields.appSecret ? { appSecret: fields.appSecret } : {}),
      openApiDomain: fields.openApiDomain || 'open.larksuite.com',
      appToken: result.appToken,
      ...(fields.ownerOpenId ? { ownerOpenId: fields.ownerOpenId } : {}),
      ...(result.configsTableId ? { configsTableId: result.configsTableId } : {}),
    },
    executor: {
      domains: [], approvalTimeoutMinutes: 30,
      auth: 'user',
      hitl: 'off',
      hitlPolicy: 'default',
      sessionDir: `${homedir()}/.bam/claude/sessions`,
      prompt: 'You are a technical support agent. Answer user questions professionally.',
    },
  };
}

// ---------------------------------------------------------------------------
// Interactive setup wizard
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Interactive setup wizard — dispatcher
// ---------------------------------------------------------------------------

export async function interactiveSetup(profile = 'default', mode?: 'channel' | 'agent'): Promise<void> {
  // If mode not specified, prompt user to choose
  if (!mode) {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════════╗');
    console.log('  ║               bam Setup Wizard                      ║');
    console.log('  ╚══════════════════════════════════════════════════════╝');
    console.log('');
    mode = await promptList('Are you setting up a Channel (server) or an Agent (client)?', [
      { name: 'Channel — server that connects to Feishu IM and manages Bitable', value: 'channel' },
      { name: 'Agent — client that connects to a Channel and processes tickets', value: 'agent' },
    ]);
    // Re-dispatch with chosen mode
    return interactiveSetup(profile, mode);
  }

  if (mode === 'channel') {
    return setupChannel(profile);
  } else {
    return setupAgent(profile);
  }
}

// ---------------------------------------------------------------------------
// Channel setup — full Feishu + Bitable + Intent configuration
// ---------------------------------------------------------------------------

async function setupChannel(profile = 'default'): Promise<void> {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║              bam — Channel Setup                     ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');

  // Load existing profile for defaults
  const { readProfile: readExistingProfile } = await import('./config.js');
  let existingProfile: Record<string, unknown> = {};
  try { existingProfile = readExistingProfile(profile) || {}; } catch { /* ok */ }
  const def = (key: string, fallback = ''): string => {
    const ch = existingProfile.channel as Record<string, unknown> | undefined;
    return String(ch?.[key] ?? '').trim() || fallback;
  };

  // =========================================================================
  // Step 1: Server domain
  // =========================================================================

  console.log(chalk.bold('\nStep 1: Lark / Feishu Server'));
  const domainChoice = await promptList('Which server does your account belong to?', [
    { name: 'International — Lark (larksuite.com)', value: 'open.larksuite.com' },
    { name: 'Chinese — 飞书 (feishu.cn)', value: 'open.feishu.cn' },
    { name: 'Custom — specify manually', value: 'custom' },
  ]);
  let openApiDomain = domainChoice === 'custom'
    ? await promptInput('Enter Open API domain (e.g., open.larksuite.com)', 'open.larksuite.com')
    : domainChoice;
  console.log(chalk.cyan(`  → Server: ${openApiDomain}`));

  // =========================================================================
  // Step 2: Credentials
  // =========================================================================

  console.log(chalk.bold('\nStep 2: Feishu App Credentials'));
  let appId = def('appId');
  let appSecret = def('appSecret');

  if (appId) {
    console.log(chalk.gray(`  Existing profile has appId: ${appId}`));
    if (await promptConfirm('Use a DIFFERENT app instead?', false)) appId = '';
  }

  if (!appId) {
    const credentialMode = await promptList(
      'How would you like to provide app credentials?',
      [
        { name: 'Use an existing Lark/Feishu bot app (enter appId + appSecret)', value: 'manual' },
        { name: 'Create a NEW bot app via QR code', value: 'qr' },
      ],
    );

    if (credentialMode === 'qr') {
      const spinner = ora('Waiting for QR authorization...').start();
      try {
        const { createAppViaQR } = await import('./device-auth.js');
        const result = await createAppViaQR({ openApiDomain });
        appId = result.appId;
        appSecret = result.appSecret;
        if (result.domain === 'lark') openApiDomain = 'open.larksuite.com';
        spinner.succeed(chalk.green(`App created: ${appId}`));
      } catch (err: any) {
        spinner.warn(chalk.yellow(`QR failed: ${err.message}`));
        appId = await promptInput('appId (required)');
        if (!appId) { logger.error(chalk.red('Error: appId is required.')); return; }
        appSecret = await promptInput('appSecret (required)');
        if (!appSecret) { logger.error(chalk.red('Error: appSecret is required for channel mode.')); return; }
      }
    }

    if (credentialMode === 'manual') {
      appId = await promptInput('appId (required)');
      if (!appId) { logger.error(chalk.red('Error: appId is required.')); return; }
      appSecret = await promptInput('appSecret (required)');
      if (!appSecret) { logger.error(chalk.red('Error: appSecret is required for channel mode.')); return; }
    }
  }

  if (appSecret) console.log(chalk.gray(`  appSecret: ${maskMiddle(appSecret)}`));

  // =========================================================================
  // Step 3: OAuth PKCE Login
  // =========================================================================

  console.log('\nStep 3: Authorize Your Identity');
  console.log('  OAuth login gives you access to your existing Bitables');
  console.log('  and records your identity (open_id) in the profile.\n');

  let ownerOpenId = process.env.OWNER_OPEN_ID || undefined;

  const existingTokens = loadStoredTokens(appId);
  if (existingTokens?.userId) {
    ownerOpenId = existingTokens.userId;
    console.log(`  ✓ Already authorized as ${ownerOpenId}`);
  } else {
    const doLogin = await promptInput('  Authorize via browser now? [y/N]: ');
    if (doLogin.toLowerCase() === 'y') {
      try {
        await UserTokenProvider.login(appId, openApiDomain);
        const stored = loadStoredTokens(appId);
        if (stored?.userId) {
          ownerOpenId = stored.userId;
          console.log(`  ✓ Authorized as ${ownerOpenId}`);
        }
      } catch (err: any) {
        console.log(`  ⚠ Authorization failed: ${err.message}`);
        console.log('  Continuing without identity. Table listing with appSecret may still work.\n');
      }
    }
  }

  // =========================================================================
  // Step 4: Bitable mode
  // =========================================================================

  let result: SetupResult;

  console.log('\nStep 4: Bitable Configuration');
  const bitableMode = await promptList(
    'How would you like to set up the bitable?',
    [{ name: 'Create a new Bitable base automatically', value: 'new' }, { name: 'Use an existing Bitable base', value: 'existing' }],
  );

  if (bitableMode === 'new') {
    // -- Create new ---------------------------------------------------------
    if (!appSecret) {
      logger.error('\n  Error: appSecret is required to create a new Bitable base.');
      logger.error('  Please re-run setup and provide appSecret, or choose "Use an existing Bitable base".');
      return;
    }
    console.log('');
    const meshName = await promptInput('  Name for the new base [base-mesh]: ');
    result = await createBaseMesh({
      appId, appSecret, openApiDomain, appName: meshName || 'base-mesh',
      ownerOpenId: ownerOpenId,
    });
    console.log('\n  ✓ Bitable is ready!');
  } else {
    // -- Use existing -------------------------------------------------------
    console.log('');
    const url = await promptInput('  Paste your Bitable URL:\n  > ');
    const parsed = parseBitableUrl(url);
    if (!parsed) {
      logger.error('  Error: Could not parse URL. Expected format:');
      logger.error('    https://<org>.larksuite.com/base/<app_token>');
      return;
    }

    // Detect or confirm domain from URL
    if (parsed.openApiDomain && parsed.openApiDomain !== openApiDomain) {
      console.log(`\n  Note: URL suggests "${parsed.openApiDomain}" but you selected "${openApiDomain}".`);
      const override = await promptInput(`  Use "${parsed.openApiDomain}" instead? [Y/n]: `);
      if (override.toLowerCase() !== 'n') openApiDomain = parsed.openApiDomain;
    }
    console.log(`  ✓ app_token: ${parsed.appToken}`);

    // List tables
    console.log('\n  Fetching tables...');
    let tables: TableInfo[];
    if (appSecret) {
      const client = createClient({ appId, appSecret, openApiDomain });
      try {
        tables = await listTables(client, parsed.appToken);
      } catch (err: any) {
        logger.error(`  Error: ${err.message}`);
        logger.error('  Make sure the app has access to this base and the URL is correct.');
        return;
      }
    } else {
      // No appSecret — use user token (OAuth PKCE)
      const provider = UserTokenProvider.fromStore(appId);
      if (!provider) {
        logger.error('  Error: No appSecret and no OAuth login found.');
        logger.error('  Please re-run setup and provide appSecret, or complete the authorization step.');
        return;
      }
      try {
        tables = await listTablesWithUserToken(appId, parsed.appToken, openApiDomain);
      } catch (err: any) {
        logger.error(`  Error: ${err.message}`);
        logger.error('  Make sure you have access to this base. The user token from OAuth login');
        logger.error('  grants access to bases you can view in the Feishu/Lark client.');
        return;
      }
    }

    if (tables.length === 0) {
      logger.error('  Error: No tables found in this base.');
      return;
    }

    console.log(`  Found ${tables.length} table(s):\n`);
    for (let i = 0; i < tables.length; i++) {
      console.log(`    ${i + 1}) ${tables[i].name ?? '(unnamed)'}  (${tables[i].table_id})`);
    }

    // Auto-map tables by name (match case-insensitive)
    const nameToKey: Record<string, string> = {
      tickets: 'ticketsTableId', turns: 'turnsTableId', roster: 'rosterTableId',
      rounds: 'roundsTableId', domains: 'domainsTableId',
    };
    const roleMap: Record<string, string> = {};
    if (parsed.configsTableId) roleMap.configsTableId = parsed.configsTableId;
    for (const t of tables) {
      const tblName = (t.name ?? '').trim().toLowerCase();
      if (nameToKey[tblName]) roleMap[nameToKey[tblName]] = t.table_id;
    }
    // Warn about missing essential tables
    for (const [name, key] of Object.entries(nameToKey)) {
      if (!roleMap[key] && !['roundsTableId', 'domainsTableId'].includes(key)) {
        console.log(`  ⚠ Table "${name}" not found in this base.`);
      }
    }

    result = {
      appToken: parsed.appToken,
      appUrl: url,
      ticketsTableId: roleMap.ticketsTableId,
      turnsTableId: roleMap.turnsTableId,
      rosterTableId: roleMap.rosterTableId,
      configsTableId: parsed.configsTableId,
    };
  }

  // =========================================================================
  // Step 5: Save profile
  // =========================================================================

  console.log('\nStep 5: Save Profile');
  const base = buildConfig({ appId, appSecret, openApiDomain, ownerOpenId }, result);
  const config: Record<string, unknown> = {
    ...existingProfile,
    ...base,
    // Overwrite [channel] with current values — prevents stale data from old runs
    channel: {
      appId, ...(appSecret ? { appSecret } : {}),
      openApiDomain: openApiDomain || 'open.larksuite.com',
      appToken: result.appToken,
      configsTableId: result.configsTableId,
      ...(ownerOpenId ? { ownerOpenId } : {}),
    },
    executor: { ...((base.executor ?? {}) as object), ...((existingProfile.executor ?? {}) as object) },
  };
  const { saveProfile, profilePath } = await import('./config.js');
  saveProfile(profile, config);
  const savedPath = profilePath(profile);
  console.log(`  ✓ Profile saved to ${savedPath}`);
  console.log('');

  // Summary
  const appUrl = result.appUrl ?? `${openApiDomain === 'open.larksuite.com' ? 'https://bytedance.larksuite.com' : 'https://bytedance.feishu.cn'}/base/${result.appToken}`;
  const configsUrl = `${appUrl}?table=${result.configsTableId}`;
  console.log('  ── Channel setup complete ──');
  console.log(`  app_token:    ${result.appToken}`);
  console.log(`  tickets:      ${result.ticketsTableId}`);
  console.log(`  turns:        ${result.turnsTableId}`);
  console.log(`  roster:       ${result.rosterTableId}`);
  console.log('');
  console.log('  Configs table (edit runtime settings):');
  console.log(`    ${configsUrl}`);
  console.log('    Configure coordinator port, intent LLM, messages, and more here.');
  console.log('');
  console.log(`  To start the Channel:\n    npx tsx src/cli.ts channel -p ${profile}`);
  console.log('');
  console.log(`  Open in browser:\n    ${appUrl}`);
  console.log('');

  // Notify owner via Lark IM
  if (ownerOpenId && appSecret) {
    try {
      const { getDomainConfig } = await import('./domain.js');
      const dc = getDomainConfig(openApiDomain || 'open.larksuite.com');
      const tokenResp = await fetch(`${dc.sdkBaseUrl}/open-apis/auth/v3/app_access_token/internal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const tokenData = await tokenResp.json() as Record<string, unknown>;
      const token = tokenData.app_access_token as string;
      if (token) {
        const card = {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: '✅ bam setup complete' } },
          elements: [
            result.configsTableId ? { tag: 'markdown', content: `**Configs table:** [Open](${configsUrl})` } : null,
            { tag: 'markdown', content: `Start channel: \`bam channel -p ${profile}\`` },
          ].filter(Boolean),
        };
        await fetch(`${dc.sdkBaseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ receive_id: ownerOpenId, msg_type: 'interactive', content: JSON.stringify(card) }),
        });
      }
    } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Agent setup — minimal configuration (no Feishu/Bitable)
// ---------------------------------------------------------------------------

async function setupAgent(profile = 'default'): Promise<void> {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║              bam — Agent Setup                       ║');
  console.log('  ║     Connects to a Channel to process tickets        ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');

  // Load existing profile for defaults
  const { readProfile: readExistingProfile } = await import('./config.js');
  let existingProfile: Record<string, unknown> = {};
  try { existingProfile = readExistingProfile(profile) || {}; } catch { /* ok */ }
  const existingExecutor = existingProfile.executor as Record<string, unknown> | undefined;
  const def = (key: string, fallback = ''): string => {
    // Check executor sub-config first, then top-level
    const val = existingExecutor?.[key] ?? existingProfile[key];
    return String(val ?? '').trim() || fallback;
  };

  // =========================================================================
  // Step 1: Channel connection
  // =========================================================================

  console.log(chalk.bold('\nStep 1: Channel Connection'));
  console.log('  Enter the WebSocket URL of the Channel server to connect to.');
  console.log('  The Channel operator will provide this address.\n');
  let coordinatorUrl = def('coordinatorUrl') || def('coordinator_url');
  coordinatorUrl = await promptInput('  Coordinator WebSocket URL (e.g., ws://192.168.1.100:8765):', coordinatorUrl || 'ws://localhost:8765');
  if (!coordinatorUrl.trim()) {
    logger.error(chalk.red('\n  Error: Coordinator URL is required.'));
    return;
  }
  console.log(chalk.cyan(`  → ${coordinatorUrl}`));

  // =========================================================================
  // Step 2: Agent Identity
  // =========================================================================

  console.log(chalk.bold('\nStep 2: Agent Identity'));
  const { hostname } = await import('node:os');
  const defaultIdentity = `${process.env.USER ?? 'agent'}@${hostname()}`;
  let identity = def('clientId') || def('identity');
  identity = await promptInput('  Agent identity (used for registration on Channel):', identity || defaultIdentity);
  if (!identity.trim()) identity = defaultIdentity;
  console.log(chalk.cyan(`  → Identity: ${identity}`));

  // =========================================================================
  // Step 3: Domains
  // =========================================================================

  console.log(chalk.bold('\nStep 3: Capability Domains'));
  console.log('  List the domains you want this agent to handle.');
  console.log('  Comma-separated, e.g.: tech_support, billing, api\n');
  let domainsStr = def('domains', 'general');
  if (Array.isArray(existingExecutor?.domains)) {
    domainsStr = (existingExecutor.domains as string[]).join(', ');
  }
  domainsStr = await promptInput('  Domains:', domainsStr);
  const domains = domainsStr.split(',').map(s => s.trim()).filter(Boolean);
  console.log(chalk.cyan(`  → Domains: ${domains.join(', ') || 'general'}`));

  // =========================================================================
  // Step 4: Claude Configuration
  // =========================================================================

  console.log(chalk.bold('\nStep 4: Claude Configuration'));
  const sessionDir = await promptInput(
    '  Session storage directory:',
    def('sessionDir') || join(homedir(), '.bam', 'claude', 'sessions'),
  );
  const prompt = await promptInput(
    '  System prompt for Claude (press Enter for default):',
    def('prompt') || 'You are a technical support agent. Answer user questions professionally.',
  );
  const selfCheck = await promptConfirm('  Run self-check on startup to describe agent capabilities?', def('selfCheck') === 'true');

  // =========================================================================
  // Step 5: Save profile
  // =========================================================================

  console.log('\nStep 5: Save Profile');

  // Load existing profile so we only update agent-related sections
  let config: Record<string, unknown> = {};
  try { const r = readExistingProfile(profile); if (r) config = r; } catch { /* ok */ }
  Object.assign(config, {
    identity,
    clientId: identity,
    executor: {
      coordinatorUrl: coordinatorUrl.trim(),
      domains,
      prompt: prompt.trim() || 'You are a technical support agent. Answer user questions professionally.',
      sessionDir: sessionDir.trim() || join(homedir(), '.bam', 'claude', 'sessions'),
      selfCheck: selfCheck || undefined,
      auth: 'user',
      hitl: 'off',
      hitlPolicy: 'default',
    },
  });

  // Ensure session directory exists
  if (typeof config.executor === 'object' && config.executor !== null) {
    const sd = (config.executor as Record<string, unknown>).sessionDir as string | undefined;
    if (sd && !existsSync(sd)) {
      mkdirSync(sd, { recursive: true });
      console.log(`  ✓ Created session directory: ${sd}`);
    }
  }

  const { saveProfile, profilePath } = await import('./config.js');
  saveProfile(profile, config);
  const savedPath = profilePath(profile);
  console.log(`  ✓ Profile saved to ${savedPath}`);
  console.log('');

  console.log('  ── Agent setup complete ──');
  console.log(`  coordinatorUrl: ${coordinatorUrl}`);
  console.log(`  identity:       ${identity}`);
  console.log(`  domains:        ${domains.join(', ') || 'general'}`);
  console.log('');
  console.log(`  To start the Agent:\n    npx tsx src/cli.ts join -p ${profile}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Utility — mask a string for display
// ---------------------------------------------------------------------------

function maskMiddle(s: string): string {
  if (s.length <= 8) return s.slice(0, 4) + '…' + s.slice(-2);
  return s.slice(0, 6) + '…' + s.slice(-4);
}
