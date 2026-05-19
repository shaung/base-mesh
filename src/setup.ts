import { logger } from './log.js';
import { Client } from '@larksuiteoapi/node-sdk';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
  rolesWhitelistTableId?: string;
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

    return { appToken: match[1], openApiDomain };
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
    const url = `https://${dc.open}/open-apis/bitable/v1/apps/${appToken}/tables?page_size=50${pageToken ? `&page_token=${pageToken}` : ''}`;
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

export async function createBitableMesh(opts: SetupOptions): Promise<SetupResult> {
  const client = createClient(opts);

  let appToken: string;
  let appUrl: string | undefined;

  if (opts.existingAppToken) {
    appToken = opts.existingAppToken;
    console.log(`  Using existing bitable: ${appToken}`);
  } else {
    const appName = opts.appName ?? 'bitable-mesh';
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
      { name: 'pending', color: 1 },
      { name: 'assigned', color: 2 },
      { name: 'pending_approval', color: 6 },
      { name: 'done', color: 3 },
      { name: 'failed', color: 4 },
      { name: 'closed', color: 5 },
    ]}},
    { field_name: 'owner', type: FT.Text },
    { field_name: 'owner_lease_at', type: FT.Number },
    { field_name: 'retry_count', type: FT.Number },
    { field_name: 'summary', type: FT.Text },
    { field_name: 'keyfacts', type: FT.Text },
    { field_name: 'chat_id', type: FT.Text },
    { field_name: 'sender_id', type: FT.Text },
    { field_name: 'for_roles', type: FT.MultiSelect, property: { options: [{ name: 'general', color: 0 }] } },
    { field_name: 'for_kind', type: FT.SingleSelect, property: { options: [{ name: 'human', color: 0 }, { name: 'agent', color: 1 }] } },
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
    { field_name: 'role', type: FT.Text },
    { field_name: 'content', type: FT.Text },
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
    { field_name: 'system_type', type: FT.Text },
    { field_name: 'channel_type', type: FT.Text },
    { field_name: 'hostname', type: FT.Text },
    { field_name: 'user', type: FT.Text },
    { field_name: 'pid', type: FT.Text },
    { field_name: 'description', type: FT.Text },
    { field_name: 'last_seen_at', type: FT.Number },
    { field_name: 'registered_at', type: FT.Number },
    { field_name: 'roles', type: FT.MultiSelect, property: { options: [{ name: 'general', color: 0 }] } },
    { field_name: 'enabled', type: FT.Checkbox },
    { field_name: 'hitl', type: FT.SingleSelect, property: { options: [{ name: 'off', color: 0 }, { name: 'auto', color: 1 }, { name: 'always', color: 2 }] } },
    { field_name: 'hitl_policy', type: FT.SingleSelect, property: { options: [{ name: 'default', color: 0 }, { name: 'off', color: 1 }, { name: 'auto', color: 2 }, { name: 'always', color: 3 }] } },
    { field_name: 'human', type: FT.Person, property: { multiple: true } },
    { field_name: 'created_at', type: FT.CreatedTime },
    { field_name: 'updated_at', type: FT.ModifiedTime },
  ]);
  console.log(`  ✓ Roster: ${rosterTableId}`);

  const rolesWhitelistTableId = await createTable(client, appToken, 'Roles', [
    { field_name: 'capability', type: FT.Text },
    { field_name: 'display_name', type: FT.Text },
    { field_name: 'description', type: FT.Text },
    { field_name: 'keywords', type: FT.Text },
    { field_name: 'prompt', type: FT.Text },
    { field_name: 'enabled', type: FT.Checkbox },
    { field_name: 'created_at', type: FT.CreatedTime },
    { field_name: 'updated_at', type: FT.ModifiedTime },
  ]);
  console.log(`  ✓ Roles: ${rolesWhitelistTableId}`);

  if (opts.ownerOpenId) {
    try {
      await client.bitable.v1.appRole.create({
        path: { app_token: appToken },
        data: {
          role_name: 'editor',
          member_list: [
            { member_type: 'open_id', member_id: opts.ownerOpenId },
          ],
        },
      } as any);
      console.log(`  ✓ Granted edit access to ${opts.ownerOpenId}`);
    } catch (err: any) {
      console.log(`  ⚠ Could not auto-grant access to ${opts.ownerOpenId}: ${err.message ?? JSON.stringify(err)}`);
      console.log(`    Please manually add them as collaborator in the Bitable sharing settings.`);
    }
  }

  return { appToken, appUrl, ticketsTableId, turnsTableId, rosterTableId, rolesWhitelistTableId };
}

// ---------------------------------------------------------------------------
// Build a complete config object from template + discovered IDs
// ---------------------------------------------------------------------------

function buildConfig(
  fields: { appId: string; appSecret?: string; openApiDomain?: string; ownerOpenId?: string; execMode?: string; execAuth?: string },
  result: SetupResult,
): Record<string, unknown> {
  return {
    appId: fields.appId,
    ...(fields.appSecret ? { appSecret: fields.appSecret } : {}),
    openApiDomain: fields.openApiDomain || 'open.larksuite.com',
    appToken: result.appToken,
    ticketsTableId: result.ticketsTableId,
    turnsTableId: result.turnsTableId,
    rosterTableId: result.rosterTableId,
    ...(fields.ownerOpenId ? { ownerOpenId: fields.ownerOpenId } : {}),
    ...(result.rolesWhitelistTableId ? { rolesWhitelistTableId: result.rolesWhitelistTableId } : {}),
    channel: { useLLM: false, draftTTLMinutes: 60, pollIntervalSeconds: 3, rolesMapping: 'keyword' },
    executor: {
      roles: [], skipApproval: false, approvalTimeoutMinutes: 30, postReview: false,
      ...(fields.execMode ? { mode: fields.execMode } : {}),
      ...(fields.execAuth ? { auth: fields.execAuth } : {}),
      hitl: 'off',
      hitlPolicy: 'default',
    },
    prompt: 'You are a technical support agent. Answer user questions professionally.',
    messages: {
      taskDone: '✅ Done processing',
      taskAssigned: '🤖 {identity} started processing',
      humanNotification: '📋 New task pending {mentions}\n{summary}',
      ackReceived: '✅ Received',
      clarifyQuestion: 'Could you please describe the issue in more detail? If you have any relevant order numbers or error messages, please also provide them, and I\'ll help investigate.',
      ticketReactivated: 'Ticket reactivated, queued for processing',
      ccFormat: '{content}\n\ncc {mentions}',
      errorFallback: 'Analysis could not be completed ({reason}), handing off to human; ticket re-queued, another online agent may pick it up.',
      retryFallback: 'Analysis could not be completed ({reason}), will auto-retry ({retryCount}/{maxRetries}).',
      exhaustedFallback: 'Analysis could not be completed ({reason}), all retries exhausted. Reply to this message to reactivate the ticket.',
      ackTemplate: 'Received, checking{ackHints}. Will reply shortly. ({nickname})',
      approvalWait: '⏳ Awaiting approval from {mentions}',
      approvalDenied: '⏳ Ticket not approved ({reason}), escalated to human processing',
      reviewWait: '📋 Answer pending review, reviewers notified',
      reviewRetry: '📋 Answer regenerated, pending re-review',
      reviewTimeout: '⏳ Review timed out, escalated to human processing',
      reviewRejected: '⏳ Review rejected again, escalated to human processing',
      reassignFallback: 'Transferring...',
      emptyAnswerFallback: '(no answer)',
    },
  };
}

// ---------------------------------------------------------------------------
// Interactive setup wizard
// ---------------------------------------------------------------------------

export async function interactiveSetup(profile = 'default', scene: 'all' | 'channel' | 'executor' | 'operator' = 'all'): Promise<void> {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║              bitable-mesh Setup Wizard               ║');
  const sceneLabel = scene === 'channel' ? 'Channel' : scene === 'executor' ? 'Executor' : scene === 'operator' ? 'Operator' : 'All';
  console.log(`  ║              Scene: ${sceneLabel.padEnd(34)}║`);
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');

  // Load existing profile for defaults
  const { readProfile: readExistingProfile } = await import('./config.js');
  let existingProfile: Record<string, unknown> = {};
  try { existingProfile = readExistingProfile(profile) || {}; } catch { /* ok */ }
  const def = (key: string, fallback = ''): string =>
    String(existingProfile[key] || '').trim() || fallback;

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
    if (await promptConfirm('Create a NEW bot app instead?', false)) appId = '';
  }

  if (!appId) {
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
    }
  }

  if (appSecret) console.log(chalk.gray(`  appSecret: ${maskMiddle(appSecret)}`));
  if (scene === 'operator' || scene === 'channel' || scene === 'all') {
    const input = await promptInput('appSecret', appSecret ? maskMiddle(appSecret) : undefined);
    if (input && input !== maskMiddle(appSecret)) appSecret = input;
  }

  if (!appSecret && (scene === 'operator' || scene === 'channel' || scene === 'all')) {
    const input = await promptInput('appSecret (optional, press Enter to skip)');
    if (input.trim()) appSecret = input.trim();
  }

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
    const doLogin = await promptInput('  Authorize via browser now? [Y/n]: ');
    if (doLogin.toLowerCase() !== 'n') {
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

  if (scene === 'executor' && def('appToken') && def('ticketsTableId')) {
    console.log('\nStep 4: Bitable Configuration (reusing existing)');
    console.log(`  appToken: ${def('appToken')}`);
    result = {
      appToken: def('appToken'),
      ticketsTableId: def('ticketsTableId'),
      turnsTableId: def('turnsTableId'),
      rosterTableId: def('rosterTableId'),
      rolesWhitelistTableId: def('rolesWhitelistTableId') || undefined,
    };
  } else {
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
    const meshName = await promptInput('  Name for the new base [bitable-mesh]: ');
    result = await createBitableMesh({
      appId, appSecret, openApiDomain, appName: meshName || 'bitable-mesh',
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

    // Map tables to roles
    console.log('\n  Which table should be used for each role?\n');
    const roleMap: Record<string, string> = {};
    const roles = ['Tickets (task tickets)', 'Turns (conversation turns)', 'Roster (agent registry)'];
    const configKeys = ['ticketsTableId', 'turnsTableId', 'rosterTableId'];
    const usedIndices = new Set<number>();

    for (let r = 0; r < roles.length; r++) {
      const available = tables
        .map((t, i) => ({ ...t, i }))
        .filter((t) => !usedIndices.has(t.i));
      if (available.length === 0) {
        logger.error('  Error: Not enough tables to assign all roles.');
        return;
      }

      console.log(`  For ${roles[r]}:`);
      for (let j = 0; j < available.length; j++) {
        // Show original index for reference
        const label = available[j].name ?? '(unnamed)';
        console.log(`    ${j + 1}) ${label}`);
      }
      const pick = await promptInput(`  Choice [1]: `);
      const pickIdx = (parseInt(pick, 10) || 1) - 1;
      const clampedIdx = Math.max(0, Math.min(pickIdx, available.length - 1));
      const chosen = available[clampedIdx];
      roleMap[configKeys[r]] = chosen.table_id;
      usedIndices.add(chosen.i);
      console.log(`  → ${roles[r]} ← ${chosen.name ?? chosen.table_id}\n`);
    }

    result = {
      appToken: parsed.appToken,
      appUrl: url,
      ticketsTableId: roleMap.ticketsTableId,
      turnsTableId: roleMap.turnsTableId,
      rosterTableId: roleMap.rosterTableId,
    };
  }
  } // end of bitable else block

  // =========================================================================
  // Step 5: Channel / Executor config
  // =========================================================================

  let execMode: string | undefined;
  let execAuth: string | undefined;

  if (scene === 'executor' || scene === 'all') {
    console.log('\nStep 5: Executor Configuration');
    console.log('  Push mode: executor connects to Channel via WebSocket (zero Bitable API).');
    console.log('  Pull mode: executor polls Bitable directly.');
    console.log('');
    execMode = await promptList('Executor mode:', [
      { name: 'push (default)', value: 'push' }, { name: 'pull', value: 'pull' },
    ]);

    if (execMode === 'push') {
      execAuth = await promptList('Push auth method:', [
        { name: 'user (OAuth PKCE)', value: 'user' }, { name: 'app (app secret)', value: 'app' },
      ]);
    }
  }

  if (scene === 'channel' || scene === 'all') {
    console.log('\nStep 5b: Channel Configuration');
    const pushPort = await promptInput(`  Push listen port [${def('coordinatorPort') || '0 (disabled)'}]: `);
    if (pushPort.trim()) existingProfile['coordinatorPort'] = pushPort.trim();
  }

  // =========================================================================
  // Step 6: Save profile
  // =========================================================================

  console.log('\nStep 6: Save Profile');
  const config = { ...existingProfile, ...buildConfig({ appId, appSecret, openApiDomain, ownerOpenId, execMode, execAuth }, result) };
  const { saveProfile, profilePath } = await import('./config.js');
  saveProfile(profile, config);
  const savedPath = profilePath(profile);
  console.log(`  ✓ Profile saved to ${savedPath}`);
  console.log('');

  // Summary
  const appUrl = result.appUrl ?? `${openApiDomain === 'open.larksuite.com' ? 'https://bytedance.larksuite.com' : 'https://bytedance.feishu.cn'}/base/${result.appToken}`;
  console.log('  ── Setup complete ──');
  console.log(`  app_token:    ${result.appToken}`);
  console.log(`  tickets:      ${result.ticketsTableId}`);
  console.log(`  turns:        ${result.turnsTableId}`);
  console.log(`  roster:       ${result.rosterTableId}`);
  console.log('');
  console.log(`  To start the daemon:\n    npx tsx src/cli.ts join -p ${profile}`);
  console.log('');
  console.log(`  Open in browser:\n    ${appUrl}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Utility — mask a string for display
// ---------------------------------------------------------------------------

function maskMiddle(s: string): string {
  if (s.length <= 8) return s.slice(0, 4) + '…' + s.slice(-2);
  return s.slice(0, 6) + '…' + s.slice(-4);
}
