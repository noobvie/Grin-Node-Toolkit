'use strict';

// Guest accounts (design §19.17.3, D24/D26/D32) — players who do not mine.
//
//   GET  /play/api/signup/challenge                          a proof-of-work challenge
//   POST /play/api/signup         { name, password, challenge, nonce }   → guest + session cookie
//   POST /play/api/login/guest    { name, password }         → session cookie
//   POST /play/api/account/password { current, next }        revokes every OTHER session
//   POST /play/api/account/delete   { password, confirm:'DELETE' }
//   admin: POST guests/:gid/delete { reason? }  (step-up: not in FAST_WRITES; gid = 'g.<16>')
//   job:   guest_idle (hourly) — deletes guests idle for guest_idle_days, prunes the sign-up log
//
// Why guest login is its OWN route and not a `kind` on /play/api/login: login.js's body schema
// is exact-key ({address, proof}), and a `kind` switch would make every key conditional — the
// strict check would become a per-kind table, in the one handler that talks to the pool. A
// separate handler keeps both schemas exact. And because nginx matches `^~ /play/api/login` as
// a PREFIX, /play/api/login/guest gets the login zone (20 r/m) and the 4 KB body cap with no
// nginx change.
//
// The rules this module owns:
//   - The id is 'g:' + 16 base32 (80 random bits), stored in the players.address column like an
//     address, so every games table works unchanged — and NO code path sends it to the pool
//     (pool-link.js refuses one; the activity sync, moderators and mining events skip them).
//   - The login name is the sign-up name. It is never disclosed AS a login name: only /me, to
//     its owner, returns it. The only place the login namespace can be probed is sign-up, which
//     costs a PoW and counts against the per-IP limit — so a nickname's uniqueness check never
//     looks at login names (names.js), or a rename would answer "someone logs in as that".
//   - Login says one thing for an unknown name and a wrong password (`login_failed`), and an
//     unknown name runs a dummy scrypt so the two take the same time. A ban is answered only
//     AFTER the password (the reverse of the miner order, §19.5 step 3): before it, "banned"
//     would tell anyone the name exists.
//   - The per-name limit counts FAILURES only and lets an IP whose /24 (/48) had a session for
//     that guest in the last 30 days through (Part 4 #3): a stranger cannot arm it into a
//     permanent lockout of the owner.
//   - Every scrypt — sign-up, login, password change, delete — goes through ONE global cap
//     (≤ 4 in flight, ≤ 64 waiting, then 429 busy): 16 MB each keeps the worst case at 64 MB
//     under the unit's MemoryMax.
//   - The proof-of-work is stateless (an HMAC under a per-process key) and single-use (an
//     in-memory used set, pruned at expiry). A restart drops the used set AND the key, so a
//     token from before it cannot be replayed after it.
//   - Deleting a guest deletes the guests row (the login name is free at once), revokes every
//     session, removes the live nickname, cancels its open seeks/challenges (refunded), and
//     KEEPS the players row marked deleted_at, so history reads "deleted guest" (names.label).

const crypto = require('node:crypto');
const { HttpError } = require('./http');
const { isUnusableClientIp } = require('./pool-link');
const { createTokenBuckets, createFailureBackoff } = require('./ratelimit');
const { ipCoarse, CHAT_MIN_AGE_FLOOR } = require('./sessions');
const { isGuestId, playerParam } = require('./mask');
const rule = require('./name-rule');

const DAY = 86400;

// ── Proof-of-work (§19.17.3) ────────────────────────────────────────────────────────────
const POW_BITS_FLOOR = 14;            // a module constant: signup_pow_bits can raise it, never remove it
const POW_BITS_MAX = 26;
const POW_TTL_S = 300;
const POW_USED_MAX = 50000;           // full → sign-up answers busy (fail closed), never forgets a use
const CHALLENGE_MAX = 200;
const NONCE_RE = /^[0-9A-Za-z]{1,32}$/;

// ── Passwords + scrypt (the pool's v1 format and parameters, copied — D5) ───────────────
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;             // code points
const PASSWORD_RAW_MAX = 1024;        // UTF-16 units, before anything is counted
const SCRYPT_OPTS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const KEYLEN = 32;
const SCRYPT_IN_FLIGHT = 4;
const SCRYPT_QUEUE_MAX = 64;
const BODY_LIMIT = 4096;
const NAME_INPUT_MAX = 40;
const REASON_MAX = 200;
const IDLE_BATCH = 500;
const DELETE_CONFIRM = 'DELETE';

// A small common list — enough to refuse the passwords every guesser tries first. No
// composition rules (§19.17.3): length is what matters, and rules only make people write
// "Password1!".
const COMMON_PASSWORDS = new Set([
  '0123456789', '1234567890', '0987654321', '9876543210', '12345678910', '1234567890a', '123456789a',
  'password12', 'password123', 'password1234', 'passw0rd12', 'password!!', 'password01', 'p@ssword123',
  'qwertyuiop', 'qwertyuiop1', 'qwerty1234', 'qwerty12345', '1q2w3e4r5t', '1qaz2wsx3edc', 'asdfghjkl1',
  'asdfghjkl;', 'zxcvbnm123', 'abcdefghij', 'abc1234567', 'abcd123456', 'iloveyou12', 'iloveyou123',
  'letmein123', 'welcome123', 'administrator', 'changeme123', 'trustno1234', 'football123', 'baseball123',
  'sunshine123', 'monkey12345', 'dragon12345', 'grinpassword', 'mimblewimble', 'grin123456', 'bitcoin123',
]);

const PASSWORD_HINTS = Object.freeze({
  too_short: `Use at least ${PASSWORD_MIN} characters.`,
  too_long: `Use at most ${PASSWORD_MAX} characters.`,
  charset: 'A password cannot contain control or invisible formatting characters.',
  same_as_name: 'Your password cannot be your name.',
  common: 'That password is too common. Pick something longer or less predictable.',
  unchanged: 'The new password is the same as the current one.',
});

// The per-name and per-IP shapes copy auth.js (Part 4 #3); keyed on the matching form of the
// name typed, so `Alice` and `ALICE` share one budget.
const LIMITS = Object.freeze({
  challengeBucket: { capacity: 20, refillPerSec: 20 / 3600 },            // per IP
  signupAttempts: { capacity: 6, refillPerSec: 6 / 3600 },               // per /24 (/48): tighter than nginx's 6 r/m
  loginIpBucket: { capacity: 10, refillPerSec: 1 / 60 },                 // per IP
  loginIpFail: { threshold: 10, baseLockSec: 300, maxLockSec: 6 * 3600 },
  loginPairFail: { threshold: 5, baseLockSec: 300, maxLockSec: 6 * 3600 },
  loginNameFail: { capacity: 20, refillPerSec: 1 / 180 },                // failures per name
  accountFail: { threshold: 5, baseLockSec: 300, maxLockSec: 6 * 3600 }, // wrong current password, per guest
});

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function newGuestId() {
  const b = crypto.randomBytes(10);   // 80 bits = 16 base32 characters exactly
  let bits = 0;
  let v = 0;
  let s = '';
  for (const byte of b) {
    v = (v << 8) | byte;
    bits += 8;
    while (bits >= 5) { s += B32[(v >>> (bits - 5)) & 31]; bits -= 5; }
    v &= (1 << bits) - 1;
  }
  return `g:${s}`;
}

function leadingZeroBits(buf) {
  let n = 0;
  for (const byte of buf) {
    if (byte === 0) { n += 8; continue; }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

// The stateless PoW. The token is `v1.<b64url(ip_coarse)>.<exp>.<bits>.<rand>.<mac>`; ip_coarse
// is base64url-wrapped because an IPv4 /24 is full of dots. mac = HMAC-SHA256(key, everything
// before it). The client finds a nonce with sha256(token + ':' + nonce) starting with `bits`
// zero bits. Verifying is one HMAC + one SHA-256, whatever the client sends.
function createPow({ clock = () => Date.now(), key = crypto.randomBytes(32), usedMax = POW_USED_MAX } = {}) {
  const used = new Map();    // mac → exp (seconds), in insertion order
  const nowS = () => Math.floor(clock() / 1000);
  const mac = (s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest('base64url');

  function issue(coarse, bits) {
    const exp = nowS() + POW_TTL_S;
    const body = `v1.${Buffer.from(coarse, 'utf8').toString('base64url')}.${exp}.${bits}.${crypto.randomBytes(16).toString('hex')}`;
    return { challenge: `${body}.${mac(body)}`, bits, expires_at: exp };
  }

  function prune(t) {
    for (const [k, exp] of used) if (exp <= t) used.delete(k);
  }

  // → null when the token is good (and it is now used), else the refusal reason:
  //   'invalid' (malformed, forged, under the floor), 'expired', 'ip_changed', 'used', 'insufficient', 'busy'.
  function verify(token, nonce, coarse) {
    if (typeof token !== 'string' || token.length > CHALLENGE_MAX || typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return 'invalid';
    const parts = token.split('.');
    if (parts.length !== 6 || parts[0] !== 'v1') return 'invalid';
    const [, ipPart, expPart, bitsPart, rand, given] = parts;
    if (!/^[0-9]{1,12}$/.test(expPart) || !/^[0-9]{1,2}$/.test(bitsPart) || !/^[0-9a-f]{32}$/.test(rand) || !/^[A-Za-z0-9_-]{43}$/.test(given)) return 'invalid';
    const want = Buffer.from(mac(parts.slice(0, 5).join('.')), 'utf8');
    const got = Buffer.from(given, 'utf8');
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return 'invalid';
    // Signed by this process from here on.
    const t = nowS();
    const exp = Number(expPart);
    const bits = Number(bitsPart);
    if (bits < POW_BITS_FLOOR || bits > POW_BITS_MAX) return 'invalid';
    if (exp <= t) return 'expired';
    if (Buffer.from(ipPart, 'base64url').toString('utf8') !== coarse) return 'ip_changed';
    if (used.has(given)) return 'used';
    const h = crypto.createHash('sha256').update(`${token}:${nonce}`, 'utf8').digest();
    if (leadingZeroBits(h) < bits) return 'insufficient';
    prune(t);
    if (used.size >= usedMax) return 'busy';
    used.set(given, exp);
    return null;
  }

  return { issue, verify, prune: () => prune(nowS()), size: () => used.size };
}

// One cap on every scrypt this module runs. → run(fn) resolves with fn()'s value; a full
// queue rejects with 429 busy before fn is ever called.
function createScryptCap({ inFlight = SCRYPT_IN_FLIGHT, queueMax = SCRYPT_QUEUE_MAX } = {}) {
  let active = 0;
  const queue = [];
  const next = () => { active--; const go = queue.shift(); if (go) go(); };
  function run(fn) {
    if (active >= inFlight && queue.length >= queueMax) {
      return Promise.reject(new HttpError(429, 'busy', { retry_after: 5 }, { 'Retry-After': '5' }));
    }
    return new Promise((resolve, reject) => {
      const go = () => {
        active++;
        Promise.resolve().then(fn).then(resolve, reject).finally(next);
      };
      if (active < inFlight) go(); else queue.push(go);
    });
  }
  return { run, stats: () => ({ active, queued: queue.length }) };
}

function hashPassword(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, KEYLEN, SCRYPT_OPTS, (err, dk) => {
      if (err) return reject(err);
      resolve(`v1$${salt.toString('base64')}$${dk.toString('base64')}`);
    });
  });
}

function verifyPassword(pw, stored) {
  return new Promise((resolve) => {
    const parts = typeof stored === 'string' ? stored.split('$') : [];
    if (parts.length !== 3 || parts[0] !== 'v1') return resolve(false);
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    if (expected.length !== KEYLEN) return resolve(false);
    crypto.scrypt(pw, salt, KEYLEN, SCRYPT_OPTS, (err, dk) => {
      if (err) return resolve(false);
      resolve(crypto.timingSafeEqual(dk, expected));
    });
  });
}

// → null, or the PASSWORD_HINTS key. NFC first, so the same password typed on two keyboards is
// the same password.
function passwordProblem(pw, norm) {
  if ([...pw].length < PASSWORD_MIN) return 'too_short';
  if ([...pw].length > PASSWORD_MAX) return 'too_long';
  if (/[\p{Cc}\p{Cf}]/u.test(pw)) return 'charset';
  const low = pw.toLowerCase();
  if (low === norm || rule.matchForm(pw) === norm) return 'same_as_name';
  if (COMMON_PASSWORDS.has(low) || /^(.)\1+$/u.test(pw)) return 'common';
  return null;
}

function createGuests({
  config, db, sessions, settings, auth, names, admin, matches = null, log,
  clock = () => Date.now(), now = () => Math.floor(clock() / 1000), pow = null, scryptCap = null,
}) {
  const raw = db.raw;
  const prefix = config.net === 'mainnet' ? 'grin1' : 'tgrin1';
  const P = pow || createPow({ clock });
  const cap = scryptCap || createScryptCap();
  const challengeBucket = createTokenBuckets({ ...LIMITS.challengeBucket, clock });
  const signupAttempts = createTokenBuckets({ ...LIMITS.signupAttempts, clock });
  const loginIpBucket = createTokenBuckets({ ...LIMITS.loginIpBucket, clock });
  const loginIpFail = createFailureBackoff({ ...LIMITS.loginIpFail, clock });
  const loginPairFail = createFailureBackoff({ ...LIMITS.loginPairFail, clock });
  const loginNameFail = createTokenBuckets({ ...LIMITS.loginNameFail, clock });
  const accountFail = createFailureBackoff({ ...LIMITS.accountFail, clock });

  const stmts = {
    byNorm: raw.prepare('SELECT id, login_name, login_norm, pass_hash, created_at, last_login_at FROM guests WHERE login_norm = ?'),
    byId: raw.prepare('SELECT id, login_name, login_norm, pass_hash, created_at, last_login_at FROM guests WHERE id = ?'),
    loginTaken: raw.prepare('SELECT 1 AS x FROM guests WHERE login_norm = ?'),
    signupsSince: raw.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS first FROM guest_signups WHERE ip_coarse = ? AND created_at > ?'),
    insertPlayer: raw.prepare("INSERT INTO players (address, first_seen, last_seen, kind) VALUES (?, ?, ?, 'guest')"),
    insertGuest: raw.prepare('INSERT INTO guests (id, login_name, login_norm, pass_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)'),
    insertSignup: raw.prepare('INSERT INTO guest_signups (ip_coarse, created_at) VALUES (?, ?)'),
    touchLogin: raw.prepare('UPDATE guests SET last_login_at = ? WHERE id = ?'),
    setHash: raw.prepare('UPDATE guests SET pass_hash = ? WHERE id = ? AND pass_hash = ?'),
    revokeOthers: raw.prepare('UPDATE sessions SET revoked_at = ? WHERE address = ? AND token_hash != ? AND revoked_at IS NULL'),
    del: raw.prepare('DELETE FROM guests WHERE id = ?'),
    markDeleted: raw.prepare('UPDATE players SET deleted_at = ? WHERE address = ? AND deleted_at IS NULL'),
    ban: raw.prepare('SELECT banned_until FROM players WHERE address = ?'),
    idle: raw.prepare('SELECT id FROM guests WHERE last_login_at < ? ORDER BY last_login_at ASC LIMIT ?'),
    liveSession: raw.prepare('SELECT 1 AS x FROM sessions WHERE address = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1'),
    pruneSignups: raw.prepare('DELETE FROM guest_signups WHERE created_at <= ?'),
  };

  const bad = (field) => new HttpError(400, 'bad_request', { field });
  const tooMany = (retryAfter, extra = {}) => new HttpError(429, 'too_many_requests', { retry_after: retryAfter, ...extra }, { 'Retry-After': String(retryAfter) });
  const loginFailed = () => new HttpError(401, 'login_failed', { reason: 'guest_credentials', hint: 'That name and password do not match a guest account.' });

  function onlyKeys(b, keys) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body');
    for (const k of Object.keys(b)) if (!keys.includes(k)) throw bad('body');
    return b;
  }
  const str = (v, field, max) => {
    if (typeof v !== 'string' || v === '' || v.length > max) throw bad(field);
    return v;
  };
  function usableIp(ctx) {
    if (isUnusableClientIp(ctx.ip)) {
      log.warn(`[guests] no usable client IP (peer is loopback without X-Real-IP?) id=${ctx.requestId}`);
      throw bad('client_ip');
    }
    return ctx.ip;
  }
  const powBits = () => Math.max(POW_BITS_FLOOR, settings.get('signup_pow_bits'));
  const weak = (code) => new HttpError(400, 'password_weak', { reason: code, hint: PASSWORD_HINTS[code] });

  // The scrypt every refused login pays, so an unknown name takes as long as a wrong password.
  let dummyHash = null;
  const dummy = () => (dummyHash || (dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'))));
  // Computed now, off the request path, so the FIRST unknown-name login is not the one slow one.
  dummy().catch((e) => log.warn(`[guests] dummy hash: ${e && e.message}`));

  function requireGuest(ctx) {
    const s = auth.requireSession(ctx);
    if (s.kind !== 'guest' || !isGuestId(s.address)) throw new HttpError(403, 'not_guest');
    return s;
  }

  // ── Sign-up ─────────────────────────────────────────────────────────────────────────
  function challenge(ctx) {
    if (!settings.get('guest_signup_enabled')) throw new HttpError(403, 'signup_closed');
    const ip = usableIp(ctx);
    const take = challengeBucket.take(ip);
    if (!take.ok) throw tooMany(take.retryAfter);
    return { ok: true, ...P.issue(ipCoarse(ip), powBits()), algorithm: 'sha256', format: "sha256(challenge + ':' + nonce) has `bits` leading zero bits; nonce = 1–32 of [0-9A-Za-z]" };
  }

  // The per-/24 success limit, from the sign-up log (it survives a restart). → retry-after, or 0.
  function signupLimit(coarse, t) {
    const r = stmts.signupsSince.get(coarse, t - DAY);
    if (r.n < settings.get('guest_signups_per_ip')) return 0;
    return Math.max(1, r.first + DAY - t);
  }

  async function signup(ctx) {
    // 1. the switch (the mode gate is publicRoute's)
    if (!settings.get('guest_signup_enabled')) throw new HttpError(403, 'signup_closed');
    // 2. body caps (the route's bodyLimit is the byte cap), exact keys, string lengths
    const b = onlyKeys(ctx.body, ['name', 'password', 'challenge', 'nonce']);
    const nameIn = str(b.name, 'name', NAME_INPUT_MAX);
    const pwIn = str(b.password, 'password', PASSWORD_RAW_MAX);
    str(b.challenge, 'challenge', CHALLENGE_MAX);
    str(b.nonce, 'nonce', 32);
    const ip = usableIp(ctx);
    const coarse = ipCoarse(ip);
    // 3. the proof-of-work — it is spent here, whatever happens next: a refused name costs a
    //    new one, which is what makes sign-up a poor oracle for the login namespace.
    const pw = P.verify(b.challenge, b.nonce, coarse);
    if (pw === 'busy') throw new HttpError(429, 'busy', { retry_after: 30 }, { 'Retry-After': '30' });
    if (pw !== null) throw new HttpError(400, 'pow_failed', { reason: pw });
    // 4. the attempt bucket, then the success limit
    const att = signupAttempts.take(coarse);
    if (!att.ok) throw tooMany(att.retryAfter);
    let t = now();
    const wait = signupLimit(coarse, t);
    if (wait) throw tooMany(wait, { reason: 'signup_limit' });
    // 5. the name: the rule, banned, taken — by a live nickname OR a login name
    const v = names.checkSignupName(nameIn);
    if (stmts.loginTaken.get(v.norm)) throw new HttpError(409, 'name_unavailable');
    // 6. the password
    const password = pwIn.normalize('NFC');
    const problem = passwordProblem(password, v.norm);
    if (problem) throw weak(problem);
    // 7–8. the global cap, then scrypt
    const hash = await cap.run(() => hashPassword(password));
    // 9. one transaction. Everything checked before the await is checked again inside it: two
    //    sign-ups from one /24, or for one name, may both have been waiting on scrypt.
    t = now();
    const id = newGuestId();
    let token;
    try {
      token = db.transaction(() => {
        if (signupLimit(coarse, t)) throw tooMany(signupLimit(coarse, t), { reason: 'signup_limit' });
        if (stmts.loginTaken.get(v.norm) || !names.availableForSignup(v.norm)) throw new HttpError(409, 'name_unavailable');
        stmts.insertPlayer.run(id, t, t);
        stmts.insertGuest.run(id, v.name, v.norm, hash, t, t);
        stmts.insertSignup.run(coarse, t);
        names.setSignupName(id, v.name, v.norm, t);
        return sessions.create(id, { method: 'guest', slot: 'set', created_at: t }, { ip, ua: ctx.req.headers['user-agent'] }).token;
      });
    } catch (e) {
      // The unique indexes (login_norm, uq_nick_norm) are the guarantee under a race.
      if (e && !(e instanceof HttpError) && /UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'name_unavailable');
      throw e;
    }
    names.invalidate();
    const s = sessions.lookup(token);
    ctx.json(200, { ok: true, me: auth.me(s) }, { 'Set-Cookie': sessions.cookie(token) });
  }

  // ── Guest login ─────────────────────────────────────────────────────────────────────
  async function login(ctx) {
    const b = onlyKeys(ctx.body, ['name', 'password']);
    const nameIn = str(b.name, 'name', NAME_INPUT_MAX);
    const pwIn = str(b.password, 'password', PASSWORD_RAW_MAX);
    const ip = usableIp(ctx);
    const norm = rule.matchForm(nameIn.trim());
    if (!/^[a-z0-9]{1,40}$/.test(norm)) throw bad('name');   // a shape only — says nothing about existence

    const pairKey = `${norm}|${ip}`;
    let lock = loginIpFail.check(ip);
    if (!lock.locked) lock = loginPairFail.check(pairKey);
    if (lock.locked) throw tooMany(lock.retryAfter);
    const bucket = loginIpBucket.take(ip);
    if (!bucket.ok) throw tooMany(bucket.retryAfter);
    // The per-name budget is RESERVED here, before the scrypt await, and given back below unless
    // the attempt ends as a wrong password — so it still counts failures only. A peek here and a
    // take after the await (the miner login's shape, which has the pool's throttle behind it)
    // let every request of a parallel burst pass on the same token: R2 measured 60 of 60
    // concurrent guesses evaluated against a budget of 20, again each time one token refilled.
    // Guest login has no pool behind it, so this budget is the brute-force stop (R2-1).
    const budget = loginNameFail.take(norm);
    const reserved = budget.ok;
    if (!reserved) {
      const g = stmts.byNorm.get(norm);
      if (!g || !sessions.knownIp(g.id, ip)) throw tooMany(budget.retryAfter);
    }

    let counted = false;
    let g;
    try {
      const password = pwIn.normalize('NFC');
      const row = stmts.byNorm.get(norm);
      const good = await cap.run(async () => verifyPassword(password, row ? row.pass_hash : await dummy()));
      // Re-read: the account may have been deleted while scrypt ran.
      g = good && row ? stmts.byNorm.get(norm) : null;
      if (!g || g.id !== row.id) {
        loginIpFail.fail(ip);
        loginPairFail.fail(pairKey);
        if (!reserved) loginNameFail.take(norm);   // the known-/24 owner path held no token
        counted = true;
        throw loginFailed();
      }
    } finally {
      // Right password, a busy scrypt cap, an error: not a failure — the token goes back.
      if (reserved && !counted) loginNameFail.refund(norm);
    }
    // Only now, with the password proven: the ban.
    const ban = stmts.ban.get(g.id);
    if (ban && ban.banned_until !== null && ban.banned_until > now()) throw new HttpError(403, 'banned');
    loginIpFail.success(ip);
    loginPairFail.success(pairKey);
    const t = now();
    const token = db.transaction(() => {
      stmts.touchLogin.run(t, g.id);
      return sessions.create(g.id, { method: 'guest', slot: 'set', created_at: g.created_at }, { ip, ua: ctx.req.headers['user-agent'] }).token;
    });
    const s = sessions.lookup(token);
    ctx.json(200, { ok: true, me: auth.me(s) }, { 'Set-Cookie': sessions.cookie(token) });
  }

  // ── The account ─────────────────────────────────────────────────────────────────────
  // The current password, checked under the per-guest lockout: a stolen session cookie must not
  // become an unlimited guesser for the password behind it.
  // One check per account at a time (R2-1): the lockout records a failure only after the scrypt
  // await, so N parallel requests would all pass check() first and N guesses would land per
  // lockout window. Only a holder of the account's session can reach this, so single-flight
  // cannot be used by a stranger to block the owner.
  const checking = new Set();
  async function checkCurrent(s, password) {
    const lock = accountFail.check(s.address);
    if (lock.locked) throw tooMany(lock.retryAfter);
    if (checking.has(s.address)) throw tooMany(2);
    checking.add(s.address);
    try {
      const row = stmts.byId.get(s.address);
      if (!row) throw new HttpError(401, 'unauthorised');
      const good = await cap.run(() => verifyPassword(password.normalize('NFC'), row.pass_hash));
      if (!good) {
        accountFail.fail(s.address);
        throw new HttpError(401, 'wrong_password');
      }
      accountFail.success(s.address);
      return row;
    } finally {
      checking.delete(s.address);
    }
  }

  async function changePassword(ctx) {
    const s = requireGuest(ctx);
    const b = onlyKeys(ctx.body, ['current', 'next']);
    const current = str(b.current, 'current', PASSWORD_RAW_MAX);
    const nextIn = str(b.next, 'next', PASSWORD_RAW_MAX);
    const row = await checkCurrent(s, current);
    const next = nextIn.normalize('NFC');
    if (next === current.normalize('NFC')) throw weak('unchanged');
    const problem = passwordProblem(next, row.login_norm);
    if (problem) throw weak(problem);
    const hash = await cap.run(() => hashPassword(next));
    const t = now();
    const revoked = db.transaction(() => {
      // Compare-and-set on the old hash: two changes racing cannot both win.
      if (stmts.setHash.run(hash, s.address, row.pass_hash).changes !== 1) throw new HttpError(409, 'conflict');
      return stmts.revokeOthers.run(t, s.address, s.token_hash).changes;
    });
    return { ok: true, revoked };
  }

  // Deletes one guest account. → true when there was one to delete. `by` is the admin's name,
  // 'self' or 'system'. Runs its own transaction (a SAVEPOINT inside a caller's).
  function deleteGuest(id, by, reason, t = now()) {
    if (!isGuestId(id)) return false;
    const done = db.transaction(() => {
      if (stmts.del.run(id).changes !== 1) return false;
      sessions.revokeAll(id);
      names.removeLiveOf(id, by, 'account_deleted');
      stmts.markDeleted.run(t, id);
      if (matches) matches.closeOpenOf(id, t);
      return true;
    });
    if (done) names.invalidate();
    if (done && reason !== 'self') log.info(`[guests] deleted a guest account (${reason}, by ${by})`);
    return done;
  }

  async function deleteOwn(ctx) {
    const s = requireGuest(ctx);
    const b = onlyKeys(ctx.body, ['password', 'confirm']);
    const password = str(b.password, 'password', PASSWORD_RAW_MAX);
    if (b.confirm !== DELETE_CONFIRM) throw bad('confirm');
    await checkCurrent(s, password);
    const deleted = deleteGuest(s.address, 'self', 'self');
    ctx.json(200, { ok: true, deleted }, { 'Set-Cookie': sessions.clearCookie() });
  }

  // ── Operator ────────────────────────────────────────────────────────────────────────
  function adminDelete(ctx) {
    const id = playerParam(ctx.params.gid, prefix);
    if (!id || !isGuestId(id)) throw new HttpError(404, 'not_found');
    const b = onlyKeys(ctx.body, ['reason']);
    let reason = null;
    if (b.reason !== undefined && b.reason !== null && b.reason !== '') {
      if (typeof b.reason !== 'string' || [...b.reason].length > REASON_MAX) throw bad('reason');
      reason = b.reason.trim();
    }
    const deleted = db.transaction(() => {
      const d = deleteGuest(id, ctx.admin.user, 'admin');
      if (d) admin.audit(ctx, 'guest_delete', id, { reason });
      return d;
    });
    if (!deleted) throw new HttpError(404, 'not_found');
    return { ok: true, deleted };
  }

  // The operator's view of one guest (moderation.js playerView). Never the login name (#29).
  function adminFor(id) {
    const g = stmts.byId.get(id);
    return g ? { created_at: g.created_at, last_login_at: g.last_login_at } : null;
  }

  // What /me adds for a guest — the ONLY response that carries a login name.
  function meFor(s) {
    const g = stmts.byId.get(s.address);
    if (!g) return null;
    const t = now();
    return {
      login_name: g.login_name,
      created_at: g.created_at,
      daily_tickets: settings.get('guest_daily_plays'),
      resets_at: (Math.floor(t / DAY) + 1) * DAY,
      chat_from: g.created_at + Math.max(CHAT_MIN_AGE_FLOOR, settings.get('guest_chat_min_age')),
    };
  }

  // ── Jobs ────────────────────────────────────────────────────────────────────────────
  // Hourly: guests with no login for guest_idle_days and no live session are deleted (so names
  // are not squatted forever), and the sign-up log keeps only what the 24 h count reads.
  function idleSweep(t = now()) {
    const cutoff = t - settings.get('guest_idle_days') * DAY;
    let deleted = 0;
    for (const { id } of stmts.idle.all(cutoff, IDLE_BATCH)) {
      if (stmts.liveSession.get(id, t)) continue;
      if (deleteGuest(id, 'system', 'idle', t)) deleted++;
    }
    const pruned = stmts.pruneSignups.run(t - DAY).changes;
    P.prune();
    return { deleted, pruned };
  }

  function sweep() {
    return loginIpFail.sweep() + loginPairFail.sweep() + accountFail.sweep();
  }

  if (admin) admin.add('POST', 'guests/:gid/delete', adminDelete, { bodyLimit: 1024 });

  return {
    deleteGuest, adminFor, meFor, idleSweep, sweep, requireGuest,
    routes: [
      ['GET', '/play/api/signup/challenge', challenge],
      ['POST', '/play/api/signup', signup, { bodyLimit: BODY_LIMIT }],
      ['POST', '/play/api/login/guest', login, { bodyLimit: BODY_LIMIT }],
      ['POST', '/play/api/account/password', changePassword, { bodyLimit: BODY_LIMIT }],
      ['POST', '/play/api/account/delete', deleteOwn, { bodyLimit: BODY_LIMIT }],
    ],
    _internal: { pow: P, cap, limiters: { challengeBucket, signupAttempts, loginIpBucket, loginIpFail, loginPairFail, loginNameFail, accountFail }, dummy },
  };
}

module.exports = {
  createGuests, createPow, createScryptCap, hashPassword, verifyPassword, passwordProblem, newGuestId, leadingZeroBits,
  POW_BITS_FLOOR, POW_TTL_S, POW_USED_MAX, PASSWORD_MIN, PASSWORD_MAX, SCRYPT_OPTS, SCRYPT_IN_FLIGHT, SCRYPT_QUEUE_MAX,
  COMMON_PASSWORDS, LIMITS, DELETE_CONFIRM,
};
