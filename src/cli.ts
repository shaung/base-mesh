#!/usr/bin/env node
import { loadConfig, validateConfig, profilePath, readProfile, saveProfile } from './config.js';
import { setLogLevel, logger } from './log.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a flag value from argv. Returns the value after --flag or -f. */
function getFlag(flag: string): string | null {
  const args = process.argv;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) {
      return args[i + 1];
    }
    if (flag.length === 2 && args[i].startsWith(flag) && !args[i].startsWith(flag + '=')) {
      const val = args[i].slice(2);
      if (val) return val;
      if (i + 1 < args.length) return args[i + 1];
    }
    if (args[i].startsWith(flag + '=')) {
      return args[i].slice(flag.length + 1);
    }
  }
  return null;
}

/** Parse CLI args. Returns profile name and positional args. Also counts -v flags. */
function parseArgs(): { profile: string; positional: string[]; verbosity: number } {
  const positional: string[] = [];
  let profile = 'default';
  let verbosity = 0;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-p' || args[i] === '--profile') {
      if (args[i + 1]) profile = args[++i];
    } else if (args[i] === '-v') {
      verbosity++;
    } else if (args[i] === '-vv') {
      verbosity += 2;
    } else if (args[i].startsWith('-v') && args[i].length > 2) {
      verbosity += args[i].length - 1; // -vvv → 3
    } else {
      positional.push(args[i]);
    }
  }
  return { profile, positional, verbosity };
}

/**
 * Auto-login for join mode (OAuth PKCE, no appSecret).
 * Returns true if login was performed.
 */
async function ensureLogin(cfg: ReturnType<typeof loadConfig>, profile: string): Promise<boolean> {
  const { UserTokenProvider, loadStoredTokens } = await import('./auth.js');
  if (UserTokenProvider.fromStore(cfg.appId)) return false;

  if (!cfg.appId) {
    logger.error('Config must include appId. Run `bitable-mesh setup` first.');
    process.exit(1);
  }

  console.log('No access token found. Starting automatic login...\n');
  await UserTokenProvider.login(cfg.appId, cfg.openApiDomain);

  // Save ownerOpenId to profile if available
  const stored = loadStoredTokens(cfg.appId);
  if (stored?.userId) {
    const raw = readProfile(profile) || {};
    raw.ownerOpenId = stored.userId;
    saveProfile(profile, raw);
    console.log(`✓ ownerOpenId saved to profile "${profile}"`);
  }
  console.log('✓ Login complete.\n');
  return true;
}

/** Check if profile exists; prompt to run setup if not. */
async function ensureSetup(profile: string): Promise<string> {
  const path = profilePath(profile);
  const { existsSync } = await import('node:fs');
  if (existsSync(path)) return profile;

  const { stdin, stdout } = await import('node:process');
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`Profile "${profile}" not found. Run interactive setup? [Y/n]: `, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    });
  });

  if (answer === 'n') {
    logger.error(`Cannot proceed without profile. Run \`bitable-mesh setup -p ${profile}\` to create it.`);
    process.exit(1);
  }

  const { interactiveSetup } = await import('./setup.js');
  await interactiveSetup(profile);
  return profile;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const { profile, positional, verbosity } = parseArgs();
  setLogLevel(verbosity);
  const cmd = positional[0];

  // `bitable-mesh login` — interactive OAuth PKCE flow
  if (cmd === 'login') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    if (!cfg.appId) {
      logger.error('Config must include appId. Run `bitable-mesh setup` first.');
      process.exit(1);
    }
    console.log('Starting Feishu OAuth authorization (PKCE mode)...\n');
    const { UserTokenProvider, loadStoredTokens } = await import('./auth.js');
    await UserTokenProvider.login(cfg.appId, cfg.openApiDomain);

    const stored = loadStoredTokens(cfg.appId);
    if (stored?.userId) {
      const raw = readProfile(profile) || {};
      raw.ownerOpenId = stored.userId;
      saveProfile(profile, raw);
      console.log(`✓ ownerOpenId saved to profile "${profile}"`);
    }

    const host = cfg.openApiDomain ?? 'open.feishu.cn';
    const name = stored?.userName ?? stored?.userId ?? '';
    console.log(`✓ Authorization successful (${host}) ${name ? `— logged in as ${name}` : ''}`);
    return;
  }

  // `bitable-mesh setup [channel|executor]` — interactive guided setup wizard
  if (cmd === 'setup') {
    const { interactiveSetup } = await import('./setup.js');
    const scene = (positional[1] as 'channel' | 'executor' | undefined) || 'all';
    await interactiveSetup(profile, scene);
    return;
  }
  if (cmd === 'setup-channel') {
    const { interactiveSetup } = await import('./setup.js');
    await interactiveSetup(profile, 'channel');
    return;
  }
  if (cmd === 'setup-executor') {
    const { interactiveSetup } = await import('./setup.js');
    await interactiveSetup(profile, 'executor');
    return;
  }
  if (cmd === 'setup-operator') {
    const { interactiveSetup } = await import('./setup.js');
    await interactiveSetup(profile, 'operator');
    return;
  }

  // `bitable-mesh operator` — deprecated, use `channel --lite`
  if (cmd === 'operator') {
    console.warn('[deprecated] Use `channel --lite` instead.');
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    validateConfig(cfg);
    const { Channel } = await import('./channel.js');
    await new Channel(cfg, true).run();
    return;
  }

  // `bitable-mesh coordinator` — deprecated, use `channel`
  if (cmd === 'coordinator') {
    console.warn('[deprecated] Use `channel` instead.');
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    validateConfig(cfg);
    const { Coordinator } = await import('./coordinator.js');
    new Coordinator(cfg).start();
    await new Promise(() => {});
  }

  // `bitable-mesh channel [--lite]` — IM + coordinator (or IM only with --lite)
  if (cmd === 'channel') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    validateConfig(cfg);

    const lite = process.argv.includes('--lite');
    const { Channel } = await import('./channel.js');
    await new Channel(cfg, lite).run();
    return;
  }

  // `bitable-mesh operator` — DEPRECATED
  if (cmd === 'operator') {
    console.warn('[deprecated] `operator` command is deprecated. Use `channel` instead.');
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    validateConfig(cfg);

    const { Channel } = await import('./channel.js');
    const channel = new Channel(cfg);
    await channel.run();
    return;
  }

  // `bitable-mesh join` — process tickets and write results
  if (cmd === 'join') {
    await ensureSetup(profile);
    let cfg = loadConfig(profile);

    // --auth flag
    const authFlag = getFlag('--auth');
    if (authFlag === 'user' || authFlag === 'app') {
      cfg.executor = cfg.executor || { roles: [] };
      cfg.executor.auth = authFlag;
    }

    // --skip-approval flag
    if (process.argv.includes('--skip-approval')) {
      cfg.executor = cfg.executor || { roles: [] };
      cfg.executor.skipApproval = true;
    }

    // Auto-login for OAuth PKCE mode. Skip for app auth.
    if (cfg.executor?.auth !== 'app') {
      const loggedIn = await ensureLogin(cfg, profile);
      if (loggedIn) cfg = loadConfig(profile);
    }

    validateConfig(cfg);

    const { Executor } = await import('./executor.js');
    const executor = new Executor(cfg);
    await executor.run();
    return;
  }

  // `bitable-mesh direct` — stateless WS→Claude→reply mode
  if (cmd === 'direct') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    validateConfig(cfg);

    const { DirectMode } = await import('./direct.js');
    const direct = new DirectMode(cfg);
    await direct.run();
    return;
  }

  // ── 0.0.2 CLI: ticket / roster / produce / claim / complete ────────

  // `bitable-mesh ticket create` — create a new ticket
  if (cmd === 'ticket' && positional[1] === 'create') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    const { Session } = await import('./protocol.js');
    const { BitableClient } = await import('./bitable.js');
    const bitable = new BitableClient(cfg);
    const session = new Session(cfg.identity, cfg.nickname, cfg, bitable);
    await session.register();

    const summary = getFlag('--summary') || getFlag('-s') || positional.slice(2).join(' ') || '';
    if (!summary) { logger.error('Usage: bam ticket create --summary <text> [--for-roles <json>] [--for-kind <kind>]'); process.exit(1); }

    const ticket = await session.createTicket(summary);
    console.log(ticket.record_id);

    // Optionally set for_roles / for_kind
    const forRoles = getFlag('--for-roles');
    const forKind = getFlag('--for-kind');
    if (forRoles || forKind) {
      const update: Record<string, unknown> = {};
      if (forRoles) update[cfg.fields.ticket.forRoles] = JSON.parse(forRoles);
      if (forKind) update[cfg.fields.ticket.forKind] = forKind;
      await bitable.updateRecord(cfg.ticketsTableId, ticket.record_id!, update);
    }
    return;
  }

  // `bitable-mesh ticket reassign` — release and set for_roles/for_kind
  if (cmd === 'ticket' && positional[1] === 'reassign') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    const { Session } = await import('./protocol.js');
    const { BitableClient } = await import('./bitable.js');
    const bitable = new BitableClient(cfg);
    const session = new Session(cfg.identity, cfg.nickname, cfg, bitable);
    await session.register();

    const id = getFlag('--id');
    if (!id) { logger.error('Usage: bam ticket reassign --id <id> [--for-roles <json>] [--for-kind <kind>]'); process.exit(1); }

    const forRoles = getFlag('--for-roles');
    const forKind = getFlag('--for-kind');
    await session.release(id, cfg.statuses.pending, {
      forRoles: forRoles ? JSON.parse(forRoles) : undefined,
      forKind: forKind || undefined,
    });
    console.log(`✓ ticket ${id.slice(0, 12)} reassigned`);
    return;
  }

  // `bitable-mesh produce <summary>` — shorthand for ticket create
  if (cmd === 'produce') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    const { Session } = await import('./protocol.js');
    const { BitableClient } = await import('./bitable.js');
    const bitable = new BitableClient(cfg);
    const session = new Session(cfg.identity, cfg.nickname, cfg, bitable);
    await session.register();

    const summary = getFlag('--summary') || positional.slice(1).join(' ') || '';
    if (!summary) { logger.error('Usage: bam produce <summary> [--for-roles <json>]'); process.exit(1); }

    const ticket = await session.createTicket(summary);
    const forRolesRaw = getFlag('--for-roles');
    const capabilities = forRolesRaw ? JSON.parse(forRolesRaw) : undefined;
    await session.promoteToPending(ticket.record_id!, summary, capabilities);
    console.log(ticket.record_id);
    return;
  }

  // `bitable-mesh claim <id>` — claim a ticket
  if (cmd === 'claim') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    const { Session } = await import('./protocol.js');
    const { BitableClient } = await import('./bitable.js');
    const bitable = new BitableClient(cfg);
    const session = new Session(cfg.identity, cfg.nickname, cfg, bitable);
    await session.register();

    const ticketId = positional[1];
    if (!ticketId) { logger.error('Usage: bam claim <ticket-id>'); process.exit(1); }

    const ticket = await session.getTicket(ticketId);
    if (!ticket) { logger.error('Ticket not found'); process.exit(1); }
    const won = await session.claim(ticket);
    console.log(won ? 'claimed' : 'contested');
    process.exit(won ? 0 : 1);
  }

  // `bitable-mesh complete <id>` — write result and mark done
  if (cmd === 'complete') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    const { Session } = await import('./protocol.js');
    const { BitableClient } = await import('./bitable.js');
    const bitable = new BitableClient(cfg);
    const session = new Session(cfg.identity, cfg.nickname, cfg, bitable);
    await session.register();

    const ticketId = positional[1];
    const result = getFlag('--result') || 'done';
    if (!ticketId) { logger.error('Usage: bam complete <ticket-id> [--result <text>]'); process.exit(1); }

    await session.writeResult(ticketId, result);
    console.log('done');
    return;
  }

  // `bitable-mesh bitable grant-phone` — grant access by phone number
  if (cmd === 'bitable' && positional[1] === 'grant-phone') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    const appToken = getFlag('--app-token') || cfg.appToken;
    const phone = getFlag('--phone') || positional[2] || '';
    if (!appToken || !phone) {
      logger.error('Usage: bam bitable grant-phone --app-token <token> --phone <phone>');
      process.exit(1);
    }

    const { getDomainConfig } = await import('./domain.js');
    const dc = getDomainConfig(cfg.openApiDomain);
    const tokenResp = await fetch(`https://${dc.open}/open-apis/auth/v3/app_access_token/internal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    });
    const tokenData = await tokenResp.json() as Record<string, unknown>;
    const token = tokenData.app_access_token as string;
    if (!token) { logger.error('Failed to get app token:', JSON.stringify(tokenData)); process.exit(1); }

    // Lookup user by phone
    const userResp = await fetch(`https://${dc.open}/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mobiles: [phone] }),
    });
    const userRaw = await userResp.text();
    let userData: Record<string, unknown> = {};
    try { userData = JSON.parse(userRaw); } catch { /* */ }
    const userList = (userData.data as any)?.user_list || [];
    if (userList.length === 0) {
      logger.error(`User lookup failed (HTTP ${userResp.status}): ${userRaw.slice(0, 1000)}`);
      process.exit(1);
    }
    const openId = userList[0].user_id;
    console.log(`Found user: ${openId}`);

    // Grant full access
    const resp = await fetch(`https://${dc.open}/open-apis/drive/v1/permissions/${appToken}/members?type=bitable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ member_type: 'openid', member_id: openId, perm: 'full_access' }),
    });
    const rawText = await resp.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawText); } catch { /* */ }
    if (body.code === 0) {
      console.log(`✓ Full access granted to ${openId} (${phone})`);
    } else {
      logger.error(`Grant failed (HTTP ${resp.status}): ${rawText.slice(0, 1000)}`);
    }
    return;
  }

  // `bitable-mesh bitable grant` — grant edit access to a Bitable base
  if (cmd === 'bitable' && positional[1] === 'grant') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    if (!cfg.appId || !cfg.appSecret) {
      logger.error('appId and appSecret required.');
      process.exit(1);
    }
    const appToken = getFlag('--app-token') || positional[2] || '';
    const email = getFlag('--email') || positional[3] || '';
    if (!appToken || !email) {
      logger.error('Usage: bam bitable grant --app-token <token> --email <email>');
      process.exit(1);
    }

    const { getDomainConfig } = await import('./domain.js');
    const dc = getDomainConfig(cfg.openApiDomain);
    const tokenResp = await fetch(`https://${dc.open}/open-apis/auth/v3/app_access_token/internal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    });
    const tokenData = await tokenResp.json() as Record<string, unknown>;
    if (!tokenData.app_access_token) {
      logger.error('Failed to get app access token:', JSON.stringify(tokenData));
      process.exit(1);
    }

    // Add collaborator via Drive permission API
    const resp = await fetch(`https://${dc.open}/open-apis/drive/v1/permissions/${appToken}/members?type=bitable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenData.app_access_token}` },
      body: JSON.stringify({ member_type: 'email', member_id: email, perm: 'full_access' }),
    });
    const rawText = await resp.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawText); } catch { /* not JSON */ }
    if (body.code === 0) {
      console.log(`✓ Edit access granted to ${email}`);
    } else {
      logger.error(`Grant failed (HTTP ${resp.status}):`, rawText.slice(0, 2000));
      process.exit(1);
    }
    return;
  }

  // `bitable-mesh bitable new` — create a new Bitable base
  if (cmd === 'bitable' && positional[1] === 'new') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    if (!cfg.appId || !cfg.appSecret) {
      logger.error('appId and appSecret required. Run `bam setup channel` first.');
      process.exit(1);
    }

    const name = getFlag('--name') || positional[2] || 'bitable-mesh';
    const email = getFlag('--email') || getFlag('-e') || '';

    const { getDomainConfig } = await import('./domain.js');
    const dc = getDomainConfig(cfg.openApiDomain);

    // Get app access token
    const tokenResp = await fetch(`https://${dc.open}/open-apis/auth/v3/app_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    });
    const tokenData = await tokenResp.json() as Record<string, unknown>;
    const token = tokenData.app_access_token as string;
    if (!token) { logger.error('Failed to get app access token'); process.exit(1); }

    // Create the Bitable app
    const createResp = await fetch(`https://${dc.open}/open-apis/bitable/v1/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name }),
    });
    const createData = await createResp.json() as Record<string, unknown>;
    if (createData.code !== 0) {
      logger.error('Failed to create Bitable:', JSON.stringify(createData));
      process.exit(1);
    }
    const appData = createData.data as Record<string, unknown>;
    const appToken = (appData.app as Record<string, unknown>).app_token as string;
    const appUrl = ((appData as any).app?.url as string) || `https://${dc.open.replace('open.', 'bytedance.')}/base/${appToken}`;
    console.log(`✓ Created: ${appUrl}`);

    // Create tables via setup.ts
    const { createBitableMesh } = await import('./setup.js');
    const mesh = await createBitableMesh({
      appId: cfg.appId, appSecret: cfg.appSecret!, openApiDomain: cfg.openApiDomain,
      appName: name, existingAppToken: appToken,
    });
    console.log(`✓ Tables created: Tickets, Turns, Roster, Roles`);

    // Update profile
    const { readProfile, saveProfile: saveProf } = await import('./config.js');
    const existing = readProfile(profile) || {};
    existing.appToken = appToken as string;
    existing.ticketsTableId = mesh.ticketsTableId;
    existing.turnsTableId = mesh.turnsTableId;
    existing.rosterTableId = mesh.rosterTableId;
    existing.rolesWhitelistTableId = mesh.rolesWhitelistTableId || '';
    saveProf(profile, existing);
    console.log(`✓ Profile "${profile}" updated`);

    // Grant edit permission
    if (email) {
      try {
        const resp = await fetch(`https://${dc.open}/open-apis/drive/v1/permissions/${appToken}/members?type=bitable`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ member_type: 'email', member_id: email, perm: 'full_access' }),
        });
        const rawText = await resp.text();
        let grantBody: Record<string, unknown> = {};
        try { grantBody = JSON.parse(rawText); } catch { /* */ }
        if (grantBody.code === 0) {
          console.log(`✓ Edit access granted to ${email}`);
        } else {
          console.log(`⚠ Could not grant access (HTTP ${resp.status}): ${rawText.slice(0, 500)}`);
        }
      } catch (err: any) {
        console.log(`⚠ Could not grant access: ${err.message}`);
      }
    }

    return;
  }

  // Default — print help
  if (cmd) {
    logger.error(`Unknown command: ${cmd}`);
  }
  console.log('Usage: bitable-mesh [--profile <name>] <command>');
  console.log('  -p, --profile <name>  Use profile (default: "default")');
  console.log('');
  console.log('Daemon commands:');
  console.log('  join       — process tickets (auto-login)');
  console.log('  channel [--lite]  — IM + coordinator (--lite for IM only)');
  console.log('  direct     — stateless WS→Claude→reply');
  console.log('');
  console.log('Ticket commands:');
  console.log('  produce <summary>  — create ticket, set to pending');
  console.log('  claim <id>         — claim a pending ticket');
  console.log('  complete <id>      — write result and mark done');
  console.log('  ticket create      — create a draft ticket');
  console.log('  ticket reassign    — release and set for_roles/for_kind');
  console.log('');
  console.log('Other:');
  console.log('  bitable new   — create a new Bitable base');
  console.log('  bitable grant — grant edit access to a Bitable base');
  console.log('  login        — OAuth PKCE authorization');
  console.log('  setup        — interactive configuration wizard');
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/cli.ts') || process.argv[1].endsWith('/cli.js')
  || process.argv[1].endsWith('/bitable-mesh.js')
);
if (isMain) {
  main().catch((err) => {
    logger.error(err);
    process.exit(1);
  });
}
