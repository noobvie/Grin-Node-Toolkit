'use strict';

// Login, logout, the caller's own account view (design §19.5, D7–D9).
//
//   POST /play/api/login        { address, proof }  → session cookie
//   POST /play/api/logout       {}                  → revoke this session
//   POST /play/api/logout-all   {}                  → revoke every session of the address
//   GET  /play/api/me                               → the caller's own summary
//   GET  /play/api/sessions                         → the caller's live sessions
//
// Login order (§19.5), each step before anything that costs more:
//   1. shape-check the body (address: GRIN_ADDR_RE + this network's prefix; proof 1–256 chars)
//   2. per-IP token bucket, per-IP and per-(address, IP) failure lockouts, the per-address
//      failure budget — all BEFORE the pool is called, so a flood costs the pool nothing
//   3. a banned address is refused before the pool call too
//   4. ONE pool verify, with the player's REAL IP (D7) — the pool's own per-IP and per-pair
//      throttles are the real brute-force stop, and they only work on the real IP
//   5. on success: a session (sessions.js); on failure: the account page's own wording for
//      the reason, so login reveals nothing the account page does not already show
//
// Why the per-address limit counts FAILURES only and lets a known IP through: a limit on
// every attempt at an address is a switch any stranger can flip to lock the owner out
// (the pool's §J3-3 lesson — a stranger's failures must not deny the owner). So only a
// failed proof spends the address's budget, and when it is spent a player who has logged
// in from the same /24 (/48) in the last 30 days still gets through; a first-time player
// waits for it to refill.

const { HttpError } = require('./http');
const { PoolLinkError, isUnusableClientIp, GRIN_ADDR_RE } = require('./pool-link');
const { createTokenBuckets, createFailureBackoff } = require('./ratelimit');
const { maskAddr, isGuestId } = require('./mask');
const { CHAT_MIN_AGE_FLOOR } = require('./sessions');
const { NO_TICKETS } = require('./tickets');
const { publicBadges } = require('./badges');
const { utcDay } = require('./plays');

const DAY = 86400;

const LOGIN_BODY_LIMIT = 4096;   // §19.5; nginx caps the same location at 4k
const PROOF_MAX = 256;

// The account page's words for each verifyOwnerProof reason (public_html/account-settings.html
// PROOF_REASONS), as sentences. A reason not listed here is shown as no_match.
const LOGIN_REASONS = Object.freeze({
  no_match: 'That proof did not match this address\'s records. Use a recent mining IP (log in from the rig\'s network) or the password your rig logs in with.',
  trivial_password: 'That password is too common to count as proof. Use your mining IP instead.',
  password_too_short: 'A rig password must be at least 8 characters to count as proof. Use your mining IP instead.',
  password_too_long: 'A rig password longer than 128 characters cannot be used as proof.',
  password_charset: 'A rig password with accented or non-Latin characters is never recorded as proof. Use your mining IP instead.',
  password_invalid: 'That proof could not be read. Enter a mining IP or your rig password.',
  too_many_attempts: 'Too many failed attempts. Wait 5 minutes, then try again.',
  no_recorded_proof: 'Nothing is on record for this address yet. Mine at least one accepted share first.',
  proof_required: 'Enter your ownership proof: a recent mining IP or your rig password.',
  account_not_found: 'There is no mining account for this address.',
});

// Only a wrong guess counts toward the lockouts, exactly as in the pool: every other reason
// is decided before any scrypt, costs nothing and deters no attacker, and counting it would
// lock out an honest miner retrying a rejected password.
const COUNTED_REASONS = new Set(['no_match']);

const LIMITS = Object.freeze({
  ipBucket: { capacity: 10, refillPerSec: 1 / 60 },                       // attempts per IP
  ipFail: { threshold: 10, baseLockSec: 300, maxLockSec: 6 * 3600 },      // pool: 20 / 10 min
  pairFail: { threshold: 5, baseLockSec: 300, maxLockSec: 6 * 3600 },     // pool: 8 / 10 min
  addrFail: { capacity: 20, refillPerSec: 1 / 180 },                      // failures per address
});

function createAuth({ config, db, sessions, settings, poolLink, mode, log, tickets = NO_TICKETS, clock = () => Date.now() }) {
  const nowS = () => Math.floor(clock() / 1000);
  const prefix = config.net === 'mainnet' ? 'grin1' : 'tgrin1';
  const ipBucket = createTokenBuckets({ ...LIMITS.ipBucket, clock });
  const ipFail = createFailureBackoff({ ...LIMITS.ipFail, clock });
  const pairFail = createFailureBackoff({ ...LIMITS.pairFail, clock });
  const addrFail = createTokenBuckets({ ...LIMITS.addrFail, clock });
  const bannedStmt = db.raw.prepare('SELECT banned_until FROM players WHERE address = ?');
  const playerStmt = db.raw.prepare('SELECT plays, points, badges_json FROM players WHERE address = ?');
  // §19.10 recent-mining gate: one PK range read on activity_daily (address, day).
  const minedStmt = db.raw.prepare('SELECT COALESCE(SUM(seconds), 0) AS s FROM activity_daily WHERE address = ? AND day >= ?');
  const isModStmt = db.raw.prepare('SELECT 1 AS x FROM moderators WHERE address = ?');
  const namesRef = { current: null };
  const guestsRef = { current: null };

  const tooMany = (retryAfter) => new HttpError(429, 'too_many_requests', { retry_after: retryAfter }, { 'Retry-After': String(retryAfter) });

  // The session for this request, or a 401.
  function requireSession(ctx) {
    const s = sessions.lookup(ctx.cookies.grin_play);
    if (!s) throw new HttpError(401, 'unauthorised');
    return s;
  }

  // ignoreChatSwitch: the same bar with the pool's chat switch treated as on — used by the
  // nicknames (§19.17.5), which are shown on the boards whether chat is open or not.
  //
  // A GUEST (D26, §19.17.3) is gated by its own switch and the ACCOUNT's age, recomputed here
  // from guests.created_at (not the session's stored chat_ok_after), so raising
  // guest_chat_min_age mid-flood closes chat to guest sessions already open. The recent-mining
  // gate is not applied — a guest can never pass it — and a guest session counts as a password
  // session for chat_requires_password (it was opened with a password).
  function chatStatus(s, { ignoreChatSwitch = false } = {}) {
    const t = nowS();
    const m = mode.get();
    const enabled = m.mode !== 'off' && (ignoreChatSwitch || m.chat_enabled === true);
    let reason = null;
    let availableAt = null;
    if (!enabled) reason = 'chat_off';
    else if (s.muted_until !== null && s.muted_until > t) { reason = 'muted'; availableAt = s.muted_until; }
    else if (s.proof_kind === 'guest') {
      const okAt = s.guest_created_at + Math.max(CHAT_MIN_AGE_FLOOR, settings.get('guest_chat_min_age'));
      if (!settings.get('chat_guests_enabled')) reason = 'guests_off';
      else if (!(okAt <= t)) { reason = 'account_too_new'; availableAt = okAt; }
      return { enabled, can_post: enabled && reason === null, available_at: availableAt, reason };
    }
    else if (s.chat_ok_after === null) reason = s.proof_slot === 'anchor' ? 'anchor_proof' : 'password_required';
    // chat_ok_after is fixed at login; the password-only switch is re-read here so an
    // operator who turns it on mid-incident closes chat to IP-proof sessions already open.
    else if (settings.get('chat_requires_password') && s.proof_kind !== 'password') reason = 'password_required';
    // The recent-mining gate (§19.10) comes before the proof wait: it is the one the
    // player can act on, and the page should say so first.
    let mining = null;
    if (enabled && reason === null) {
      const need = settings.get('chat_min_minutes');
      if (need > 0) {
        const days = settings.get('chat_recent_days');
        const have = Math.floor(minedStmt.get(s.address, utcDay(t - (days - 1) * DAY)).s / 60);
        if (have < need) { reason = 'no_recent_mining'; mining = { have_minutes: have, need_minutes: need, days }; }
      }
    }
    if (enabled && reason === null && s.chat_ok_after > t) { reason = 'proof_too_new'; availableAt = s.chat_ok_after; }
    return { enabled, can_post: enabled && reason === null, available_at: availableAt, reason, ...(mining ? { mining } : {}) };
  }

  // D21: a moderator appointed by the operator acts from /play/ with their own session.
  // null = not a moderator. A moderator acts only when they could post (aged, non-anchor,
  // not muted, recently mining — the same bar) and, with mod_requires_password on (the
  // default), from a session opened with the rig PASSWORD: an IP proof can be a CGNAT
  // neighbour (§19.13 #7), and moderation power should not come with the neighbourhood.
  function modStatus(s) {
    if (!isModStmt.get(s.address)) return null;
    const c = chatStatus(s);
    let reason = c.reason;
    if (reason === null && settings.get('mod_requires_password') && s.proof_kind !== 'password') reason = 'mod_password_required';
    return { can_act: reason === null, reason };
  }

  function me(s) {
    // A guest's tickets are SET to the daily number at the first /me of a UTC day (§19.17.4).
    if (isGuestId(s.address)) tickets.topUp(s.address);
    const p = playerStmt.get(s.address) || { plays: 0, points: 0, badges_json: '[]' };
    const guest = isGuestId(s.address) && guestsRef.current ? guestsRef.current.meFor(s) : null;
    return {
      kind: isGuestId(s.address) ? 'guest' : 'miner',
      address: s.address,                    // the caller's own (a guest's id); this is not a list
      address_masked: maskAddr(s.address),
      // The ONLY response that carries a guest's login name (§19.13 #29).
      ...(guest ? { guest } : {}),
      plays: p.plays,
      points: p.points,
      badges: publicBadges(p.badges_json),   // event badges (§19.9): server-side ids + our labels
      chat: chatStatus(s),
      moderator: modStatus(s),
      sessions: sessions.liveCount(s.address),
      // §19.17.5: the caller's own nickname state. Set by app.js once names exists (names
      // needs this module's chatStatus, so it is built after it).
      ...(namesRef.current ? { nickname: namesRef.current.meView(s) } : {}),
    };
  }

  async function login(ctx) {
    const b = ctx.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'bad_request', { field: 'body' });
    for (const k of Object.keys(b)) {
      if (k !== 'address' && k !== 'proof') throw new HttpError(400, 'bad_request', { field: 'body' });
    }
    const address = b.address;
    if (typeof address !== 'string' || !GRIN_ADDR_RE.test(address) || !address.startsWith(prefix)) {
      throw new HttpError(400, 'bad_request', { field: 'address' });
    }
    const proof = b.proof;
    if (typeof proof !== 'string' || proof.trim() === '' || proof.length > PROOF_MAX) {
      throw new HttpError(400, 'bad_request', { field: 'proof' });
    }
    const ip = ctx.ip;
    if (isUnusableClientIp(ip)) {
      // nginx's X-Real-IP did not reach us: the pool would refuse this, and if it did not,
      // every player would share one throttle bucket (D7).
      log.warn(`[login] no usable client IP (peer is loopback without X-Real-IP?) id=${ctx.requestId}`);
      throw new HttpError(400, 'bad_request', { field: 'client_ip' });
    }

    const pairKey = `${address}|${ip}`;
    let lock = ipFail.check(ip);
    if (!lock.locked) lock = pairFail.check(pairKey);
    if (lock.locked) throw tooMany(lock.retryAfter);
    const bucket = ipBucket.take(ip);
    if (!bucket.ok) throw tooMany(bucket.retryAfter);
    const budget = addrFail.peek(address);
    if (!budget.ok && !sessions.knownIp(address, ip)) throw tooMany(budget.retryAfter);

    const ban = bannedStmt.get(address);
    if (ban && ban.banned_until !== null && ban.banned_until > nowS()) throw new HttpError(403, 'banned');

    let r;
    try {
      r = await poolLink.verifyProof(address, proof, ip);
    } catch (e) {
      if (e instanceof PoolLinkError) {
        log.warn(`[login] pool link: ${e.code}${e.field ? ` field=${e.field}` : ''} id=${ctx.requestId}`);
        throw new HttpError(503, 'pool_unavailable');
      }
      throw e;
    }

    if (!r.ok) {
      if (COUNTED_REASONS.has(r.reason)) {
        ipFail.fail(ip);
        pairFail.fail(pairKey);
        addrFail.take(address);
      }
      if (r.reason === 'lookup_failed') throw new HttpError(503, 'pool_unavailable');
      const reason = Object.prototype.hasOwnProperty.call(LOGIN_REASONS, r.reason) ? r.reason : 'no_match';
      if (reason === 'too_many_attempts') throw new HttpError(429, 'too_many_requests', { reason, hint: LOGIN_REASONS[reason] });
      throw new HttpError(401, 'login_failed', { reason, hint: LOGIN_REASONS[reason] });
    }

    // A ban may have landed while the pool was answering.
    const ban2 = bannedStmt.get(address);
    if (ban2 && ban2.banned_until !== null && ban2.banned_until > nowS()) throw new HttpError(403, 'banned');

    ipFail.success(ip);
    pairFail.success(pairKey);
    const { token } = sessions.create(address, r, { ip, ua: ctx.req.headers['user-agent'] });
    const s = sessions.lookup(token);
    ctx.json(200, { ok: true, me: me(s) }, { 'Set-Cookie': sessions.cookie(token) });
  }

  function logout(ctx) {
    const s = sessions.lookup(ctx.cookies.grin_play);
    if (s) sessions.revoke(s.token_hash);
    // 200 whether or not there was a session: logging out is idempotent.
    ctx.json(200, { ok: true }, { 'Set-Cookie': sessions.clearCookie() });
  }

  function logoutAll(ctx) {
    const s = requireSession(ctx);
    const revoked = sessions.revokeAll(s.address);
    ctx.json(200, { ok: true, revoked }, { 'Set-Cookie': sessions.clearCookie() });
  }

  function getMe(ctx) {
    return { ok: true, ...me(requireSession(ctx)) };
  }

  function getSessions(ctx) {
    const s = requireSession(ctx);
    return { ok: true, sessions: sessions.list(s.address, s.token_hash) };
  }

  function sweep() {
    return ipFail.sweep() + pairFail.sweep();
  }

  return {
    requireSession, me, chatStatus, modStatus, sweep,
    setNames: (n) => { namesRef.current = n; },
    setGuests: (g) => { guestsRef.current = g; },
    routes: [
      ['POST', '/play/api/login', login, { bodyLimit: LOGIN_BODY_LIMIT }],
      ['POST', '/play/api/logout', logout],
      ['POST', '/play/api/logout-all', logoutAll],
      ['GET', '/play/api/me', getMe],
      ['GET', '/play/api/sessions', getSessions],
    ],
    _limiters: { ipBucket, ipFail, pairFail, addrFail },
  };
}

module.exports = { createAuth, LOGIN_REASONS, COUNTED_REASONS, LIMITS };
