// Auth-hardening regression tests — audit §J2 (auth, session & 2FA).
//
// Every case here is a bug that was demonstrated against this code, and every one of them ends
// at the same place: an admin session someone should not have, or one that outlives the moment
// it should have died. That is the freshAdmin tier, which is to say the money routes. So they
// get a test rather than a comment, alongside test-money-path.js and test-admin-guards.js.
//
// Runs against a throwaway SQLite file in the OS temp dir — never the pool DB, and never a
// listening server. Run: node scripts/test-auth-hardening.js
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP = path.resolve(__dirname, '..');
const dbFile = path.join(os.tmpdir(), `pool-authtest-${Date.now()}.sqlite`);

const { initDb, getDb, createSchema, closeDb } = require(path.join(APP, 'lib/db.js'));
initDb(dbFile);
const db = getDb();
createSchema();

const AuthManager = require(path.join(APP, 'lib/auth.js'));
const totp = require(path.join(APP, 'lib/totp.js'));
const Captcha = require(path.join(APP, 'lib/captcha.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

const cleanup = () => {
  try { closeDb(); } catch (_) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbFile + suffix); } catch (_) {}
  }
};

// bcrypt_rounds 4 keeps the suite quick. It does NOT weaken what is under test: every case
// here turns on ordering and bookkeeping, and hash() still yields the event loop at cost 4,
// so the registration race below interleaves exactly as it did at cost 12.
const auth = new AuthManager({ jwt_secret: 'test-secret-not-a-real-one', bcrypt_rounds: 4 });

const IP_A = '198.51.100.7';
const IP_B = '203.0.113.9';

(async () => {

// ═══ J2-2 — first-admin registration is atomic ══════════════════════════════
console.log('\n[J2-2] concurrent first-admin registration');
{
  // Both calls are STARTED before either is awaited — that is the whole point. The old code
  // read "0 admins" in index.js, then awaited a ~300 ms hash, and the second request read the
  // same 0 while the first was still hashing. Different usernames, so UNIQUE never fired.
  const [a, b] = await Promise.all([
    auth.registerAdmin('operator', 'correct-horse-battery', { firstAdminOnly: true }),
    auth.registerAdmin('attacker', 'attacker-password-11', { firstAdminOnly: true }),
  ]);
  const admins = db.prepare('SELECT username FROM users WHERE is_admin = 1').all().map(r => r.username);
  ok('exactly one admin exists after two concurrent registrations', admins.length === 1,
     `-> got ${JSON.stringify(admins)}`);
  ok('exactly one call succeeded', (a.success ? 1 : 0) + (b.success ? 1 : 0) === 1);
  const loser = a.success ? b : a;
  ok('the losing call is refused as closed', /closed/i.test(loser.error || ''), `-> ${loser.error}`);
}

const opId = db.prepare('SELECT id FROM users WHERE is_admin = 1').get().id;
const opName = db.prepare('SELECT username FROM users WHERE id = ?').get(opId).username;
const opPass = opName === 'operator' ? 'correct-horse-battery' : 'attacker-password-11';

// ═══ J2-1 — step-up counts failures and can be locked ═══════════════════════
console.log('\n[J2-1] step-up (/api/admin/reauth) failure counting');
{
  auth.lockouts.clear();
  for (let i = 0; i < 5; i++) await auth.stepUp(opId, 'wrong-password', 0, { ip: IP_A });
  ok('failed step-ups arm the (username, IP) lockout', auth.lockoutRemaining(opName, IP_A) > 0,
     `-> remaining ${auth.lockoutRemaining(opName, IP_A)}s`);

  // Locked means locked even for the RIGHT password — otherwise the lock is only a speed bump
  // for an attacker who has just guessed it.
  const whileLocked = await auth.stepUp(opId, opPass, 0, { ip: IP_A });
  ok('a locked source is refused even with the correct password',
     whileLocked.success === false && whileLocked.locked === true);
  ok('the refusal carries retry_after_seconds', (whileLocked.retry_after_seconds || 0) > 0);

  // The key is the PAIR: another address must still be able to get in, or this becomes the
  // remote operator lockout that auth.js's constructor note exists to prevent.
  const other = await auth.stepUp(opId, opPass, 0, { ip: IP_B });
  ok('a different IP is unaffected by the lock', other.success === true);
  auth.lockouts.clear();

  const good = await auth.stepUp(opId, opPass, 0, { ip: IP_A });
  ok('a correct password still mints a fresh token', good.success === true && !!good.access_token);
}

// ═══ J2-5 — TOTP codes are single-use ═══════════════════════════════════════
console.log('\n[J2-5] TOTP replay');
{
  const secret = totp.generateSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_last_counter = 0 WHERE id = ?')
    .run(secret, opId);

  const counter = Math.floor(Date.now() / 1000 / totp.PERIOD);
  const code = totp.hotp(secret, counter);

  ok('a fresh code is accepted', (await auth.verifyTotpOrRecovery(opId, code)) === true);
  ok('the SAME code is refused on second use', (await auth.verifyTotpOrRecovery(opId, code)) === false);
  ok('the spent step is recorded',
     db.prepare('SELECT totp_last_counter AS c FROM users WHERE id = ?').get(opId).c === counter);

  // A code from the PREVIOUS step is inside window ±1 but is not newer, so it must also fail —
  // otherwise an observed code is simply replayable one step down.
  ok('a code from the previous step is refused',
     (await auth.verifyTotpOrRecovery(opId, totp.hotp(secret, counter - 1))) === false);

  // Drift the other way still works: single-use is orthogonal to the ±1 window.
  ok('a code from the next step is accepted',
     (await auth.verifyTotpOrRecovery(opId, totp.hotp(secret, counter + 1))) === true);
}

// ═══ J2-1 (2FA half) — step-up demands a code when the pool mandates one ════
console.log('\n[J2-1] step-up second factor');
{
  auth.lockouts.clear();
  const noCode = await auth.stepUp(opId, opPass, 0, { ip: IP_B, requireCode: true });
  ok('a correct password alone is refused when a code is required',
     noCode.success === false && noCode.totp_code_required === true);

  const badCode = await auth.stepUp(opId, opPass, 0, { ip: IP_B, requireCode: true, code: '000000' });
  ok('a wrong code is refused', badCode.success === false);
  ok('a wrong code counts against the pair lock', auth.lockouts.size === 1);

  auth.lockouts.clear();
  const secret = db.prepare('SELECT totp_secret AS s FROM users WHERE id = ?').get(opId).s;
  // Rewind the spent-step marker: the block above deliberately consumed the current step and
  // the next one, and the replay guard is global to the account (that is the point of it). A
  // code two steps ahead would be outside the ±1 window, so the only way to test the SUCCESS
  // path here is to present this scenario with nothing yet spent.
  db.prepare('UPDATE users SET totp_last_counter = 0 WHERE id = ?').run(opId);
  const live = totp.hotp(secret, Math.floor(Date.now() / 1000 / totp.PERIOD));
  const good = await auth.stepUp(opId, opPass, 0, { ip: IP_B, requireCode: true, code: live });
  ok('password + a live code mints the token', good.success === true && !!good.access_token);
  ok('the step-up code is consumed too (no replay into login)',
     (await auth.verifyTotpOrRecovery(opId, live)) === false);

  // The J2-1 + J2-5 interaction: on a mandatory-2FA pool a freshAdmin route carries a code in
  // its body AND the step-up in front of it asks for one, so the operator naturally uses the
  // same code twice and the second use is a replay BY DESIGN. It must not report as "incorrect"
  // — that reads as a broken authenticator on, of all screens, "disable 2FA".
  const replayed = await auth.stepUp(opId, opPass, 0, { ip: IP_B, requireCode: true, code: live });
  ok('a replayed step-up code is flagged as a replay, not as wrong', replayed.code_replay === true);
  ok('and says so in words the operator can act on', /already been used/i.test(replayed.error || ''),
     `-> ${replayed.error}`);

  const detail = {};
  await auth.verifyTotpOrRecovery(opId, live, detail);
  ok('the detail out-param reports the replay', detail.replay === true);
  const wrongDetail = {};
  await auth.verifyTotpOrRecovery(opId, '000000', wrongDetail);
  ok('a genuinely wrong code is NOT flagged as a replay', !wrongDetail.replay);

  const dis = await auth.disable2fa(opId, live);
  ok('disable2fa reports a replay the same way', dis.code_replay === true && !dis.success);
}

// ═══ J2-3 — the 2FA guess budget follows the token, not the IP ══════════════
console.log('\n[J2-3] twofa_token budget');
{
  const token = auth.generate2faToken(opId);
  const seen = auth.verify2faToken(token);
  ok('the token resolves to { userId, jti }', !!seen && seen.userId === opId && !!seen.jti);

  // Fan the SAME token out: the budget is shared, so extra hosts buy nothing.
  let burned = false;
  for (let i = 0; i < auth.twofaMaxAttempts; i++) burned = auth.record2faFailure(seen.jti);
  ok('the token burns out after twofaMaxAttempts wrong codes', burned === true);
  ok('a burned token no longer verifies', auth.verify2faToken(token) === null);

  const t2 = auth.generate2faToken(opId);
  const s2 = auth.verify2faToken(t2);
  auth.consume2faToken(s2.jti);
  ok('a token is dead after a successful use', auth.verify2faToken(t2) === null);

  // A JWT that never had server-side state (the old shape) must not be honoured.
  const jwt = require('jsonwebtoken');
  const legacy = jwt.sign({ user_id: opId, type: '2fa' }, 'test-secret-not-a-real-one', { expiresIn: 300 });
  ok('a jti-less 2fa token is refused', auth.verify2faToken(legacy) === null);
}

// ═══ J2-7 — a disabled account is indistinguishable from a wrong password ═══
console.log('\n[J2-7] disabled account');
{
  auth.lockouts.clear();
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(opId);
  const disabled = await auth.login(opName, opPass, IP_A);
  auth.lockouts.clear();
  const unknown = await auth.login('no-such-admin', 'whatever-1234', IP_A);

  ok('a disabled account returns the generic error',
     disabled.success === false && disabled.error === unknown.error, `-> ${disabled.error}`);

  auth.lockouts.clear();
  await auth.login(opName, opPass, IP_A);
  ok('an attempt against a disabled account arms the lockout', auth.lockouts.size === 1);
  db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(opId);
  auth.lockouts.clear();
}

// ═══ J2-1 — change-password arms the same lockout ═══════════════════════════
console.log('\n[J2-1] change-password failure counting');
{
  auth.lockouts.clear();
  const bad = await auth.changePassword(opId, 'not-the-password', 'a-new-password-9', IP_A);
  ok('a wrong old_password fails', bad.success === false);
  ok('and arms the (username, IP) lockout', auth.lockouts.size === 1);

  for (let i = 0; i < 5; i++) await auth.changePassword(opId, 'nope-nope-nope', 'x'.repeat(12), IP_A);
  const locked = await auth.changePassword(opId, opPass, 'a-new-password-9', IP_A);
  ok('a locked source cannot change the password even with the right one', locked.success === false);
  auth.lockouts.clear();
}

// ═══ J2-4 — one client cannot evict another's captcha ═══════════════════════
console.log('\n[J2-4] captcha store eviction');
{
  const c = new Captcha({ maxPerIp: 5, max: 5000 });
  const mine = c.issue('192.0.2.10');            // the operator, holding one challenge

  for (let i = 0; i < 500; i++) c.issue(IP_A);   // an anonymous flood from one source

  ok("the operator's challenge survives a 500-request flood", c.store.has(mine.id));
  ok('the flooding source is capped at maxPerIp', (c.byIp.get(IP_A) || []).length <= 5);
  ok('the store did not grow without bound', c.store.size <= 6);

  // Single-use is preserved.
  const one = c.issue('192.0.2.11');
  const answer = c.store.get(one.id).answer;
  ok('a correct answer verifies once', c.verify(one.id, answer) === true);
  ok('and cannot be replayed', c.verify(one.id, answer) === false);
}

// ═══ Wiring checks — the guards actually applied in index.js ════════════════
console.log('\n[wiring] index.js + rate-limiter');
{
  const src = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');
  const rl = fs.readFileSync(path.join(APP, 'lib/rate-limiter.js'), 'utf8');

  ok('a `stepup` bucket exists', /\bstepup:\s*\d+/.test(rl));
  ok('reauth runs on the stepup bucket, not `admin`',
     /'\/api\/admin\/reauth',\s*\n\s*rateLimiter\.middleware\('stepup'\)/.test(src));
  ok('reauth still runs the admin IP filter and requireAdmin',
     /'\/api\/admin\/reauth',[\s\S]{0,300}ipFilter\.middleware\('admin'\)[\s\S]{0,200}requireAdmin\(authManager\)/.test(src));
  ok('reauth records a failed attempt against the auto-ban',
     /reauth[\s\S]{0,4000}recordAdminLoginFailure\(req\.ip/.test(src));
  ok('change-password runs on the stepup bucket',
     /'\/api\/auth\/change-password',\s*\n\s*rateLimiter\.middleware\('stepup'\)/.test(src));
  ok('change-password is on requireAdmin, not requireAuth',
     /'\/api\/auth\/change-password',[\s\S]{0,600}requireAdmin\(authManager\)/.test(src) &&
     !/requireAuth\(authManager\)/.test(src));
  ok('registration asks for the atomic first-admin gate',
     /registerAdmin\(username,\s*password,\s*\{\s*firstAdminOnly:\s*true\s*\}\)/.test(src));
  ok('the captcha route passes the client IP', /loginCaptcha\.issue\(req\.ip\)/.test(src));
  // Script 07's installer branches on the status code: 403 prints "an admin already exists",
  // 400 prints "username >= 3, password >= 8". A closed-pool refusal from the ATOMIC gate must
  // not arrive as 400, or the operator is told to fix a password that was never the problem.
  ok('a closed-registration refusal keeps its 403',
     /registration closed/i.test(src) && /closed \? 403 : 400/.test(src));
  ok('both 2FA management routes feed the shared code counter',
     (src.match(/recordAdminLoginFailure\(req\.ip,\s*'2fa'\)/g) || []).length >= 2);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed`
                       : `\nFAILURES — ${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail === 0 ? 0 : 1);

})().catch(err => { console.error(err); cleanup(); process.exit(1); });
