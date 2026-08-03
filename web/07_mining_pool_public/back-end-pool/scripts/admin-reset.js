#!/usr/bin/env node
/**
 * admin-reset.js — break-glass admin account recovery for the GRINIUM public pool.
 *
 * Restores the operator's own access to the admin panel when the web login can't be used:
 * lost authenticator with the recovery codes gone, forgotten password, or a source address
 * locked out. Installed by Script 07 as /usr/local/bin/grin-pool-admin-reset-<net>.
 *
 * WHY THIS IS NOT A BACKDOOR
 * It requires a root shell on the pool server, and root can already read pool.db, edit it
 * with sqlite3, or read jwt_secret out of the config and mint itself a token. The capability
 * is inherent to owning the box; this tool only makes it correct, safe and *logged* instead
 * of hand-written UPDATE statements typed during an outage. For the same reason it must NEVER
 * grow an HTTP interface — a "reset admin 2FA" endpoint, however authenticated, WOULD be a
 * backdoor. Keep it local, keep it root-only.
 *
 * This is also the prerequisite for access.require_admin_totp: mandatory 2FA without a
 * recovery path means one lost phone can stop miner payouts indefinitely.
 *
 * Deliberately does NOT call initDb(): that runs createSchema() → migrateAdminAuditLog(),
 * which DROPS admin_audit_log when its columns don't match the canonical set. A recovery tool
 * must never be able to destroy the audit trail. It opens the existing DB and touches only
 * the rows it was asked to.
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');

// Dependencies are loaded LAZILY, not at import time, so `--help` always works. An operator
// following the "confirm this command exists before enabling mandatory 2FA" advice must get
// the usage text, not a module-resolution error — the latter reads like the tool is broken.
// better-sqlite3 is a native module built in place on the pool box; it only resolves when run
// from the installed app dir, which the Script 07 wrapper guarantees.
let Database, bcrypt, totp;
function loadDeps() {
  if (Database) return;
  try {
    Database = require('better-sqlite3');
    bcrypt = require('bcryptjs');
    totp = require('../lib/totp');
  } catch (e) {
    const err = new Error(
      `cannot load dependencies (${e.message.split('\n')[0]})\n` +
      '       Run it through the installed wrapper (grin-pool-admin-reset-<net>), which\n' +
      '       execs node from the pool app dir where node_modules lives.'
    );
    err.exitCode = 2;
    throw err;
  }
}

const BCRYPT_ROUNDS = 12;   // matches AuthManager's floor (security audit: >= 12)
const PASS_MIN = 8;         // matches AuthManager.registerAdmin / changePassword

// ─── tiny arg parser ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [], flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user' || a === '-u') { out.user = argv[++i]; }
    else if (a === '--conf' || a === '-c') { out.conf = argv[++i]; }
    else if (a === '--db') { out.db = argv[++i]; }
    else if (a.startsWith('--')) { out.flags.add(a.slice(2)); }
    else { out._.push(a); }
  }
  return out;
}

function usage() {
  console.log(`
grin-pool-admin-reset — break-glass admin recovery (root, on the pool server only)

  --list                      Show admin accounts: 2FA state, unused recovery codes,
                              consecutive failed logins, active/disabled.
  --user <name> --clear-2fa   Turn TOTP off and delete that account's recovery codes.
                              Use when the authenticator AND the recovery codes are gone.
  --user <name> --set-password
                              Set a new password (prompted, never passed on the command
                              line). Add --password-stdin to read it from a pipe.
  --user <name> --new-recovery-codes
                              Issue 10 fresh one-time codes (replaces the old set).
                              Requires 2FA to still be enabled on the account.
  --user <name> --unlock      Clear the failed-login counter and re-enable the account.

  --conf <file>   pool config to read db_path from (default: $GRIN_POOL_CONF)
  --db <file>     use this pool.db directly, bypassing the config
  --yes           skip the confirmation prompt (for scripted recovery)
  --help

Every action writes an admin_audit_log row (action 'admin_cli_reset'), visible afterwards
on the admin panel's Login Activity table.

Changing a password or clearing 2FA also REVOKES that account's existing sessions, so a
stolen cookie can't outlive the recovery.

No service restart is needed: the pool re-reads these columns per request.

Not handled here: per-source login lockouts and temporary IP auto-bans are held in the
running service's memory, not the database. Lift those on the admin panel (Users ->
Login Security), or restart the pool service to clear all of them at once.
`.trim());
}

// ─── config / db resolution ─────────────────────────────────────────────────────
function resolveDbPath(args) {
  if (args.db) return args.db;

  const confPath = args.conf || process.env.GRIN_POOL_CONF;
  if (!confPath) {
    throw new Error('no config given — pass --conf <file> or --db <file>, or set GRIN_POOL_CONF');
  }
  if (!fs.existsSync(confPath)) {
    throw new Error(`config not found: ${confPath}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(confPath, 'utf-8'));
  } catch (e) {
    throw new Error(`config is not valid JSON: ${confPath} (${e.message})`);
  }
  if (!cfg.db_path) throw new Error(`config has no db_path: ${confPath}`);
  return cfg.db_path;
}

function openDb(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`database not found: ${dbPath}\n` +
      '       Has the pool ever been started? The DB is created on first run.');
  }
  // Not readonly — we write. WAL means this is safe alongside the running service.
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!t) {
    db.close();
    throw new Error(`${dbPath} has no users table — wrong database, or the pool never started.`);
  }
  return db;
}

// ─── prompts ────────────────────────────────────────────────────────────────────
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a); });
  });
}

// Read a passphrase without echoing it. Never accepted as an argv value: the whole point of
// the toolkit's stdin-passphrase rule is to keep secrets out of `ps aux` / /proc/<pid>/cmdline.
function askHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('stdin is not a terminal — use --password-stdin to pipe the password'));
      return;
    }
    process.stdout.write(question);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Suppress echo by swallowing the output writes for this prompt.
    const iface = rl;
    iface._writeToOutput = function (s) {
      // Let control sequences (newline on submit) through; hide the typed characters.
      if (s === '\r\n' || s === '\n' || s === '\r') process.stdout.write('\n');
    };
    iface.question('', (answer) => { iface.close(); resolve(answer); });
  });
}

function readStdinAll() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

async function confirm(args, what) {
  if (args.flags.has('yes')) return true;
  const a = await ask(`${what}\nType 'yes' to continue: `);
  return a.trim().toLowerCase() === 'yes';
}

// ─── audit ──────────────────────────────────────────────────────────────────────
// admin_id is the TARGET user (the account acted on) so the row survives the audit-IP
// coarsening migration and joins to a username in the panel. ip is NULL — this ran on the
// console, there is no request address, and inventing one would be a lie in the audit trail.
function audit(db, userId, op, details) {
  try {
    db.prepare(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
       VALUES (?, 'admin_cli_reset', 'auth', 'login', ?, NULL)`
    ).run(userId, JSON.stringify({ op, via: 'cli', ...(details || {}) }));
  } catch (e) {
    // Never fail the recovery because the audit write failed — but say so loudly.
    console.error(`warning: audit row not written (${e.message})`);
  }
}

// Invalidate every issued refresh token for the account (same mechanism as
// AuthManager.revokeUserTokens). A recovery that left a hijacked session alive would defeat
// its own purpose.
function revokeSessions(db, userId) {
  db.prepare('UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000), userId);
}

function findUser(db, name) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(name);
  if (!u) throw new Error(`no such user: ${name}   (run --list to see admin accounts)`);
  return u;
}

// ─── actions ────────────────────────────────────────────────────────────────────
function actionList(db) {
  const rows = db.prepare(
    `SELECT id, username, is_admin, is_active, totp_enabled, failed_login_attempts, locked_until
       FROM users ORDER BY is_admin DESC, username ASC`
  ).all();
  if (rows.length === 0) {
    console.log('No user accounts exist yet — create the first admin via Script 07 option 7.');
    return;
  }
  const codeCount = db.prepare(
    'SELECT COUNT(*) AS c FROM admin_recovery_codes WHERE user_id = ? AND used_at IS NULL'
  );
  const pad = (s, n) => String(s).padEnd(n);
  console.log('');
  console.log(`  ${pad('ID', 4)}${pad('USERNAME', 20)}${pad('ADMIN', 7)}${pad('ACTIVE', 8)}${pad('2FA', 6)}${pad('CODES', 7)}FAILED`);
  console.log(`  ${'-'.repeat(60)}`);
  for (const r of rows) {
    let codes = '-';
    try { codes = r.totp_enabled ? String(codeCount.get(r.id).c) : '-'; } catch (e) { codes = '?'; }
    console.log(`  ${pad(r.id, 4)}${pad(r.username, 20)}${pad(r.is_admin ? 'yes' : 'no', 7)}` +
                `${pad(r.is_active ? 'yes' : 'NO', 8)}${pad(r.totp_enabled ? 'on' : 'off', 6)}` +
                `${pad(codes, 7)}${r.failed_login_attempts || 0}`);
  }
  console.log('');
  console.log('  CODES  = unused one-time recovery codes left (2FA accounts only)');
  console.log('  FAILED = consecutive failed logins for the account (a signal, not a lock:');
  console.log('           lockouts are per source address and held in the service\'s memory)');
  console.log('');
}

async function actionClear2fa(db, args) {
  const u = findUser(db, args.user);
  if (!u.totp_enabled && !u.totp_pending_secret) {
    console.log(`2FA is already off for '${u.username}' — nothing to do.`);
    return;
  }
  if (!await confirm(args, `Turn OFF 2FA for '${u.username}' and delete its recovery codes?`)) {
    console.log('Cancelled.');
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_pending_secret = NULL,
                        updated_at = ? WHERE id = ?`
    ).run(now, u.id);
    db.prepare('DELETE FROM admin_recovery_codes WHERE user_id = ?').run(u.id);
    revokeSessions(db, u.id);
  });
  tx();
  audit(db, u.id, 'clear_2fa', { username: u.username });
  console.log(`\n2FA disabled for '${u.username}'. Recovery codes deleted. Sessions revoked.`);
  console.log('Log in with username + password only, then re-enroll 2FA from the admin panel.');
  console.log("If this pool requires 2FA, re-enroll before money actions will work again.\n");
}

async function actionUnlock(db, args) {
  const u = findUser(db, args.user);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'UPDATE users SET failed_login_attempts = 0, locked_until = 0, is_active = 1, updated_at = ? WHERE id = ?'
  ).run(now, u.id);
  audit(db, u.id, 'unlock', { username: u.username, was_active: !!u.is_active });
  console.log(`\nCleared the failed-login counter for '${u.username}' and ensured the account is enabled.`);
  console.log('Note: per-source login lockouts and IP auto-bans live in the running service\'s');
  console.log('memory, not in the DB. If a specific address is still refused, lift it on the');
  console.log('admin panel (Login Security) or restart the pool service to clear all of them.\n');
}

async function actionSetPassword(db, args) {
  const u = findUser(db, args.user);
  let pass;
  if (args.flags.has('password-stdin')) {
    pass = (await readStdinAll()).split('\n')[0].replace(/\r$/, '');
  } else {
    pass = await askHidden(`New password for '${u.username}': `);
    const again = await askHidden('Confirm: ');
    if (pass !== again) throw new Error('passwords do not match');
  }
  if (!pass || pass.length < PASS_MIN) {
    throw new Error(`password must be at least ${PASS_MIN} characters`);
  }
  const hash = await bcrypt.hash(pass, BCRYPT_ROUNDS);
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, failed_login_attempts = 0, locked_until = 0, updated_at = ? WHERE id = ?')
      .run(hash, now, u.id);
    revokeSessions(db, u.id);
  });
  tx();
  audit(db, u.id, 'set_password', { username: u.username });
  console.log(`\nPassword updated for '${u.username}'. Existing sessions revoked.`);
  if (u.totp_enabled) console.log('2FA is still ON for this account — you will also need a TOTP or recovery code.');
  console.log('');
}

async function actionNewRecoveryCodes(db, args) {
  const u = findUser(db, args.user);
  if (!u.totp_enabled) {
    throw new Error(`2FA is not enabled for '${u.username}' — recovery codes only apply to 2FA accounts.\n` +
      '       Enroll 2FA in the admin panel (it issues a fresh set), or use --clear-2fa.');
  }
  if (!await confirm(args, `Replace all recovery codes for '${u.username}'? The old ones stop working.`)) {
    console.log('Cancelled.');
    return;
  }
  // Same shape as AuthManager.generateRecoveryCodes: 10 chars of base32, stored uppercase
  // without the separator, bcrypt-hashed; displayed once as XXXXX-XXXXX.
  const codes = [];
  const ins = db.prepare('INSERT INTO admin_recovery_codes (user_id, code_hash) VALUES (?, ?)');
  db.prepare('DELETE FROM admin_recovery_codes WHERE user_id = ?').run(u.id);
  for (let i = 0; i < 10; i++) {
    const raw = totp.base32Encode(crypto.randomBytes(7)).slice(0, 10);
    ins.run(u.id, await bcrypt.hash(raw, BCRYPT_ROUNDS));
    codes.push(raw.slice(0, 5) + '-' + raw.slice(5));
  }
  audit(db, u.id, 'new_recovery_codes', { username: u.username, count: codes.length });
  console.log(`\nNew recovery codes for '${u.username}' — shown ONCE, only hashes are stored.`);
  console.log('Print them or write them down now, and keep them OFF this server.\n');
  for (const c of codes) console.log(`    ${c}`);
  console.log('');
}

// ─── main ───────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.has('help') || (args.flags.size === 0 && !args.user)) {
    usage();
    process.exit(args.flags.has('help') ? 0 : 1);
  }

  // Root-only. This is not the security boundary (root could edit the DB regardless) — it
  // stops a non-root user from getting a confusing half-failure on a file they can't write.
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    console.error('error: must be run as root (try: sudo grin-pool-admin-reset-<net> ...)');
    process.exit(2);
  }

  loadDeps();
  const dbPath = resolveDbPath(args);
  const db = openDb(dbPath);
  console.error(`# database: ${dbPath}`);

  try {
    if (args.flags.has('list')) { actionList(db); return; }

    if (!args.user) throw new Error('this action needs --user <name>   (see --list)');

    if (args.flags.has('clear-2fa'))            { await actionClear2fa(db, args); return; }
    if (args.flags.has('set-password'))         { await actionSetPassword(db, args); return; }
    if (args.flags.has('new-recovery-codes'))   { await actionNewRecoveryCodes(db, args); return; }
    if (args.flags.has('unlock'))               { await actionUnlock(db, args); return; }

    throw new Error('no action given — one of --clear-2fa, --set-password, --new-recovery-codes, --unlock');
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(e.exitCode || 1);
});
