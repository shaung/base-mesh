#!/usr/bin/env node
import { loadConfig, validateConfig, profilePath, readProfile, saveProfile } from '../lib/config.js';
import { setLogLevel, logger } from '../lib/log.js';

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
  const { UserTokenProvider, loadStoredTokens } = await import('../lib/auth/oauth.js');
  if (UserTokenProvider.fromStore(cfg.appId)) return false;

  if (!cfg.appId) {
    logger.error('Config must include appId. Run `bam setup` first.');
    process.exit(1);
  }

  console.log('No access token found. Starting automatic login...\n');
  await UserTokenProvider.login(cfg.appId, cfg.openApiDomain);

  // Save ownerOpenId to profile if available
  const stored = loadStoredTokens(cfg.appId);
  if (stored?.userId) {
    const raw = readProfile(profile) || {};
    raw.ownerOpenId = stored.userId;
    if (stored.unionId) raw.ownerUnionId = stored.unionId;
    saveProfile(profile, raw);
    console.log(`✓ ownerOpenId saved to profile "${profile}"`);
    if (stored.unionId) console.log(`✓ ownerUnionId saved to profile "${profile}"`);
  }
  console.log('✓ Login complete.\n');
  return true;
}

/** Check if profile exists; prompt to run setup if not.
 *  @param modeHint — if set, setup will default to this mode when creating a new profile. */
async function ensureSetup(profile: string, modeHint?: 'channel' | 'agent'): Promise<string> {
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
    logger.error(`Cannot proceed without profile. Run \`bam setup -p ${profile}\` to create it.`);
    process.exit(1);
  }

  const { interactiveSetup } = await import('../cli/setup.js');
  await interactiveSetup(profile, modeHint);
  return profile;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const { profile, positional, verbosity } = parseArgs();
  setLogLevel(verbosity);
  const cmd = positional[0];

  // `bam login` — interactive OAuth PKCE flow
  if (cmd === 'login') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    if (!cfg.appId) {
      logger.error('Config must include appId. Run `bam setup` first.');
      process.exit(1);
    }
    console.log('Starting Feishu OAuth authorization (PKCE mode)...\n');
    const { UserTokenProvider, loadStoredTokens } = await import('../lib/auth/oauth.js');
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

  // `bam setup [channel|agent]` — interactive guided setup wizard
  if (cmd === 'setup') {
    const { interactiveSetup, setupOperator } = await import('../cli/setup.js');
    // If subcommand given, pass it as mode
    const sub = positional[1];
    if (sub === 'operator') {
      await setupOperator(profile);
    } else if (sub === 'channel' || sub === 'agent') {
      await interactiveSetup(profile, sub);
    } else if (sub === 'executor') {
      console.warn('[deprecated] Use `setup agent` instead.');
      await interactiveSetup(profile, 'agent');
    } else {
      // No subcommand — prompt user to choose mode
      await interactiveSetup(profile);
    }
    return;
  }
  if (cmd === 'setup-channel') {
    const { interactiveSetup } = await import('../cli/setup.js');
    await interactiveSetup(profile, 'channel');
    return;
  }
  if (cmd === 'setup-agent') {
    const { interactiveSetup } = await import('../cli/setup.js');
    await interactiveSetup(profile, 'agent');
    return;
  }

  // `bam operator` — deprecated, use `channel --lite`
  if (cmd === 'operator') {
    console.warn('[deprecated] Use `channel --lite` instead.');
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    validateConfig(cfg);
    const { Channel } = await import('../channel/deploy/node/channel.js');
    await new Channel(cfg, true).run();
    return;
  }

  // `bam coordinator` — deprecated, use `channel`
  if (cmd === 'coordinator') {
    console.warn('[deprecated] Use `channel` instead.');
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    validateConfig(cfg);
    const mod = await import('../channel/deploy/node/coordinator.js');
    const Coordinator = mod.NodeCoordinator;
    new Coordinator(cfg).start();
    await new Promise(() => {});
  }

  // `bam channel [--lite]` — IM + coordinator (or IM only with --lite)
  if (cmd === 'channel') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    // Load table IDs and runtime config from Bitable before validation
    const { enrichConfigFromBitable } = await import('../lib/config.js');
    await enrichConfigFromBitable(cfg);
    validateConfig(cfg);

    const lite = process.argv.includes('--lite');
    const { Channel } = await import('../channel/deploy/node/channel.js');
    await new Channel(cfg, lite).run();
    return;
  }

  // `bam operator` — DEPRECATED
  if (cmd === 'operator') {
    console.warn('[deprecated] `operator` command is deprecated. Use `channel` instead.');
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    validateConfig(cfg);

    const { Channel } = await import('../channel/deploy/node/channel.js');
    const channel = new Channel(cfg);
    await channel.run();
    return;
  }

  // `bam join` — process tickets and write results
  if (cmd === 'join') {
    await ensureSetup(profile, 'agent');
    let cfg = loadConfig(profile);

    // Auto-login if OAuth credentials are available
    if (cfg.appId) {
      const loggedIn = await ensureLogin(cfg, profile);
      if (loggedIn) cfg = loadConfig(profile);
    }

    validateConfig(cfg, 'agent');

    const { Executor } = await import('../executor/executor.js');
    const executor = new Executor(cfg);
    executor.setProfile(profile);
    await executor.run();
    return;
  }

  // ── 0.0.2 CLI: ticket / roster / produce / claim / complete ────────

  // `bam ticket create` — create a new ticket
  if (cmd === 'ticket' && positional[1] === 'create') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    const { Session } = await import('../lib/bitable/protocol.js');
    const { BitableClient } = await import('../lib/bitable/client.js');
    const bitable = new BitableClient(cfg);
    const session = new Session(cfg.identity, cfg.nickname, cfg, bitable);
    await session.register();

    const summary = getFlag('--summary') || getFlag('-s') || positional.slice(2).join(' ') || '';
    if (!summary) { logger.error('Usage: bam ticket create --summary <text> [--domains <json>] [--for-kind <kind>]'); process.exit(1); }

    const ticket = await session.createTicket(summary);
    console.log(ticket.record_id);


    return;
  }

  // `bam ticket reassign` — release and set for_roles/for_kind
  if (cmd === 'ticket' && positional[1] === 'reassign') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    const { Session } = await import('../lib/bitable/protocol.js');
    const { BitableClient } = await import('../lib/bitable/client.js');
    const bitable = new BitableClient(cfg);
    const session = new Session(cfg.identity, cfg.nickname, cfg, bitable);
    await session.register();

    const id = getFlag('--id');
    if (!id) { logger.error('Usage: bam ticket reassign --id <id>'); process.exit(1); }

    await session.release(id, cfg.statuses.active);
    console.log(`✓ ticket ${id} reassigned`);
    return;
  }

  // `bam produce <summary>` — shorthand for ticket create
  if (cmd === 'produce') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    const { Session } = await import('../lib/bitable/protocol.js');
    const { BitableClient } = await import('../lib/bitable/client.js');
    const bitable = new BitableClient(cfg);
    const session = new Session(cfg.identity, cfg.nickname, cfg, bitable);
    await session.register();

    const summary = getFlag('--summary') || positional.slice(1).join(' ') || '';
    if (!summary) { logger.error('Usage: bam produce <summary>'); process.exit(1); }

    const ticket = await session.createTicket(summary);
    await session.promoteToPending(ticket.record_id!, summary);
    console.log(ticket.record_id);
    return;
  }

  // `bam claim <id>` — claim a ticket
  if (cmd === 'claim') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    const { Session } = await import('../lib/bitable/protocol.js');
    const { BitableClient } = await import('../lib/bitable/client.js');
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

  // `bam complete <id>` — write result and mark done
  if (cmd === 'complete') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    const { Session } = await import('../lib/bitable/protocol.js');
    const { BitableClient } = await import('../lib/bitable/client.js');
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

  // `bam bitable grant` — grant edit access by email, phone, or open_id
  if (cmd === 'bitable' && positional[1] === 'grant') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    if (!cfg.appId || !cfg.appSecret) {
      logger.error('appId and appSecret required.');
      process.exit(1);
    }
    const appToken = getFlag('--app-token') || positional[2] || '';
    const email = getFlag('--email') || '';
    const phone = getFlag('--phone') || '';
    const openId = getFlag('--open-id') || '';
    if (!appToken || (!email && !phone && !openId)) {
      logger.error('Usage: bam bitable grant --app-token <token> --email <email>');
      logger.error('       bam bitable grant --app-token <token> --phone <phone>');
      logger.error('       bam bitable grant --app-token <token> --open-id <open_id>');
      process.exit(1);
    }

    const { grantBitableAccess, resolvePhoneToOpenId } = await import('../lib/bitable/auth.js');

    if (phone) {
      const openId = await resolvePhoneToOpenId(phone, cfg.appId, cfg.appSecret, cfg.openApiDomain);
      if (!openId) { logger.error(`User not found for phone ${phone}`); process.exit(1); }
      const ok = await grantBitableAccess({
        appId: cfg.appId, appSecret: cfg.appSecret, openApiDomain: cfg.openApiDomain,
        appToken, memberType: 'openid', memberId: openId,
      });
      if (ok) console.log(`✓ Edit access granted to ${phone}`);
      else { logger.error('Grant failed'); process.exit(1); }
    } else if (openId) {
      const ok = await grantBitableAccess({
        appId: cfg.appId, appSecret: cfg.appSecret, openApiDomain: cfg.openApiDomain,
        appToken, memberType: 'openid', memberId: openId,
      });
      if (ok) console.log(`✓ Edit access granted to ${openId}`);
      else { logger.error('Grant failed'); process.exit(1); }
    } else {
      const ok = await grantBitableAccess({
        appId: cfg.appId, appSecret: cfg.appSecret, openApiDomain: cfg.openApiDomain,
        appToken, memberType: 'email', memberId: email,
      });
      if (ok) console.log(`✓ Edit access granted to ${email}`);
      else { logger.error('Grant failed'); process.exit(1); }
    }
    return;
  }

  // `bam bitable new` — create a new Bitable base
  if (cmd === 'bitable' && positional[1] === 'new') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    if (!cfg.appId || !cfg.appSecret) {
      logger.error('appId and appSecret required. Run `bam setup channel` first.');
      process.exit(1);
    }

    const name = getFlag('--name') || positional[2] || 'bam';
    const email = getFlag('--email') || getFlag('-e') || '';

    const { getDomainConfig } = await import('../lib/bitable/domain.js');
    const dc = getDomainConfig(cfg.openApiDomain);

    // Get app access token
    const tokenResp = await fetch(`${dc.sdkBaseUrl}/open-apis/auth/v3/app_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    });
    const tokenData = await tokenResp.json() as Record<string, unknown>;
    const token = tokenData.app_access_token as string;
    if (!token) { logger.error('Failed to get app access token'); process.exit(1); }

    // Create the Bitable app
    const createResp = await fetch(`${dc.sdkBaseUrl}/open-apis/bitable/v1/apps`, {
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
    const { createBaseMesh } = await import('../cli/setup.js');
    const mesh = await createBaseMesh({
      appId: cfg.appId, appSecret: cfg.appSecret!, openApiDomain: cfg.openApiDomain,
      appName: name, existingAppToken: appToken,
    });
    console.log(`✓ Tables created: Tickets, Turns, Roster, Roles`);

    // Update profile
    const { readProfile, saveProfile: saveProf } = await import('../lib/config.js');
    const existing = readProfile(profile) || {};
    existing.appToken = appToken as string;
    existing.ticketsTableId = mesh.ticketsTableId;
    existing.turnsTableId = mesh.turnsTableId;
    existing.rosterTableId = mesh.rosterTableId;
    existing.domainsTableId = mesh.domainsTableId || '';
    saveProf(profile, existing);
    console.log(`✓ Profile "${profile}" updated`);

    // Grant edit permission
    if (email) {
      const { grantBitableAccess } = await import('../lib/bitable/auth.js');
      const ok = await grantBitableAccess({
        appId: cfg.appId, appSecret: cfg.appSecret, openApiDomain: cfg.openApiDomain,
        appToken, memberType: 'email', memberId: email,
      });
      if (ok) console.log(`✓ Edit access granted to ${email}`);
      else console.log(`⚠ Could not grant access to ${email}`);
    }

    return;
  }

  // Default — print help
  if (cmd) {
    logger.error(`Unknown command: ${cmd}`);
  }
  console.log('Usage: bam [--profile <name>] <command>');
  console.log('  -p, --profile <name>  Use profile (default: "default")');
  console.log('');
  console.log('Daemon commands:');
  console.log('  join              — start Agent (connect to Channel, process tickets)');
  console.log('  channel [--lite]  — start Channel server (IM + coordinator)');
  console.log('');
  console.log('Setup commands:');
  console.log('  setup             — interactive config wizard (prompts for mode)');
  console.log('  setup channel     — configure as Channel server (Feishu + Bitable)');
  console.log('  setup agent       — configure as Agent client (connect to Channel)');
  console.log('  setup operator    — add a multi-operator bot account');
  console.log('');
  console.log('Auth commands:');
  console.log('  login             — OAuth PKCE authorization');
  console.log('');
  console.log('Ticket commands:');
  console.log('  produce <summary>  — create ticket, set to pending');
  console.log('  claim <id>         — claim a pending ticket');
  console.log('  complete <id>      — write result and mark done');
  console.log('  ticket create      — create a draft ticket');
  console.log('  ticket reassign    — release and re-queue ticket');
  console.log('');
  console.log('Other:');
  console.log('  bitable new   — create a new Bitable base');
  console.log('  bitable grant — grant edit access to a Bitable base');
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/cli.ts') || process.argv[1].endsWith('/cli.js')
  || process.argv[1].endsWith('/bam.js')
);
if (isMain) {
  main().catch((err) => {
    logger.error(err);
    process.exit(1);
  });
}
