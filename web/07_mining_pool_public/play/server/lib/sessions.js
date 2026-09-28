'use strict';

// Games sessions (design §19.5, D8, D9).
//
// A miner has no pool session: every pool money action takes a per-request proof. The games
// need one, so after ONE proof verified by the pool this service issues its own:
//   - token = 32 random bytes, base64url, sent once in the cookie and NEVER stored — the DB
//     holds hex sha256(token), so a copy of grinium-games.db logs nobody in;
//   - cookie `grin_play=<token>; Path=/play/; HttpOnly; Secure; SameSite=Strict; Max-Age=14 d`;
//   - expiry is a HARD 14 days from creation; activity never extends it;
//   - last_seen is written at most once per 5 min, not on every request;
//   - at most 20 live sessions per address: the 21st login revokes the oldest.
//
// Chat gate (D9). A stranger who mines a few shares to your address joins your proof set
// (§17): harmless for payouts (the money is yours), impersonation in chat. So posting needs
// an AGED proof: chat_ok_after = login + max(0, minAge − proof age), minAge = max(the 1 h
// FLOOR below, the chat_min_proof_age setting). The floor is a module constant, so no
// setting can remove it — two controls must not share one number. An evicted ANCHOR
// (unrevocable) never gets chat (NULL = never), nor does an IP proof when the operator
// requires the password for chat.

const crypto = require('node:crypto');
const net = require('node:net');
const { serializeCookie } = require('./http');

const COOKIE_NAME = 'grin_play';
const COOKIE_PATH = '/play/';
const SESSION_TTL_S = 14 * 86400;
const TOUCH_EVERY_S = 5 * 60;
const MAX_LIVE_PER_ADDRESS = 20;
const CHAT_MIN_AGE_FLOOR = 3600;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;   // 32 bytes, base64url, no padding
// Dead sessions (expired or revoked) are kept this long, then dropped. It equals the
// knownIp() window on purpose: that check reads these rows, and a shorter purge would
// quietly shrink its 30 days to whatever the purge left.
const KNOWN_IP_WINDOW_S = 30 * 86400;
const PURGE_DEAD_AFTER_S = KNOWN_IP_WINDOW_S;

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// /24 for IPv4, /48 for IPv6 — display only (§19.4), never an identity.
function ipCoarse(ip) {
  if (net.isIPv4(ip)) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  if (net.isIPv6(ip)) {
    // Expand '::' so the first three groups are real groups.
    const [head, tail = ''] = ip.toLowerCase().split('::');
    const h = head ? head.split(':') : [];
    const tl = tail ? tail.split(':') : [];
    const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - tl.length)).fill('0'), ...tl] : h;
    return `${groups.slice(0, 3).map((g) => (g || '0').replace(/^0+(?=.)/, '')).join(':')}::/48`;
  }
  return null;
}

// A coarse "Firefox on Windows" from the User-Agent. The raw UA is never stored: it is
// attacker-chosen text, and a fingerprint.
function uaHint(ua) {
  if (typeof ua !== 'string' || ua === '') return null;
  const s = ua.slice(0, 512);
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
      : /Firefox\//.test(s) ? 'Firefox'
        : /Chrome\//.test(s) ? 'Chrome'
          : /Safari\//.test(s) ? 'Safari'
            : /curl\//i.test(s) ? 'curl' : 'Other';
  const os = /Android/.test(s) ? 'Android'
    : /iPhone|iPad|iPod/.test(s) ? 'iOS'
      : /Windows/.test(s) ? 'Windows'
        : /Mac OS X|Macintosh/.test(s) ? 'macOS'
          : /Linux|X11/.test(s) ? 'Linux' : 'other';
  return `${browser} on ${os}`;
}

function createSessions({ db, settings, now = () => Math.floor(Date.now() / 1000) }) {
  const raw = db.raw;
  const stmts = {
    insert: raw.prepare(
      'INSERT INTO sessions (token_hash, address, created_at, expires_at, last_seen, ip_coarse, ua_hint, proof_kind, proof_slot, chat_ok_after) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    live: raw.prepare(
      'SELECT token_hash FROM sessions WHERE address = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at ASC, token_hash ASC'),
    get: raw.prepare(
      'SELECT s.token_hash, s.address, s.created_at, s.expires_at, s.last_seen, s.ip_coarse, s.proof_kind, s.proof_slot, ' +
      's.chat_ok_after, s.revoked_at, p.banned_until, p.muted_until ' +
      'FROM sessions s JOIN players p ON p.address = s.address WHERE s.token_hash = ?'),
    touch: raw.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?'),
    revoke: raw.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL'),
    revokeAll: raw.prepare('UPDATE sessions SET revoked_at = ? WHERE address = ? AND revoked_at IS NULL'),
    list: raw.prepare(
      'SELECT token_hash, created_at, last_seen, ip_coarse, ua_hint FROM sessions ' +
      'WHERE address = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT ?'),
    knownIp: raw.prepare(
      'SELECT 1 AS x FROM sessions WHERE address = ? AND ip_coarse = ? AND created_at > ? LIMIT 1'),
    purgeExpired: raw.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    purgeRevoked: raw.prepare('DELETE FROM sessions WHERE revoked_at IS NOT NULL AND revoked_at < ?'),
    upsertPlayer: raw.prepare(
      'INSERT INTO players (address, first_seen, last_seen) VALUES (?, ?, ?) ' +
      'ON CONFLICT(address) DO UPDATE SET last_seen = excluded.last_seen'),
  };

  // D9, §19.5 step 5. → unix seconds, or null = never.
  function chatOkAfter(proof, t) {
    if (proof.slot === 'anchor') return null;
    if (settings.get('chat_requires_password') && proof.method !== 'password') return null;
    const minAge = Math.max(CHAT_MIN_AGE_FLOOR, settings.get('chat_min_proof_age'));
    // age null = an old row (it predates the timestamps) → treated as old, so no wait.
    const age = proof.age_seconds === null ? Infinity : proof.age_seconds;
    return t + Math.max(0, minAge - age);
  }

  // create(address, proof, { ip, ua }) → { token, cookie, session }. One transaction: the
  // player upsert, the over-cap revocations and the insert land together.
  function create(address, proof, { ip, ua } = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = sha256hex(token);
    const t = now();
    db.transaction(() => {
      stmts.upsertPlayer.run(address, t, t);
      const live = stmts.live.all(address, t);
      for (let i = 0; i <= live.length - MAX_LIVE_PER_ADDRESS; i++) stmts.revoke.run(t, live[i].token_hash);
      stmts.insert.run(hash, address, t, t + SESSION_TTL_S, t, ip ? ipCoarse(ip) : null, uaHint(ua),
        proof.method, proof.slot, chatOkAfter(proof, t));
    });
    return { token, hash, expiresAt: t + SESSION_TTL_S };
  }

  // The session for a cookie value, or null. Revoked, expired and banned all read as null.
  // A duplicated cookie name parses as null upstream (http.js parseCookies), which lands here.
  function lookup(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const hash = sha256hex(token);
    const s = stmts.get.get(hash);
    const t = now();
    if (!s || s.revoked_at !== null || !(s.expires_at > t)) return null;
    if (s.banned_until !== null && s.banned_until > t) return null;
    if (t - s.last_seen >= TOUCH_EVERY_S) { stmts.touch.run(t, hash); s.last_seen = t; }
    return s;
  }

  const revoke = (hash) => stmts.revoke.run(now(), hash).changes;
  const revokeAll = (address) => stmts.revokeAll.run(now(), address).changes;

  function list(address, currentHash) {
    return stmts.list.all(address, now(), MAX_LIVE_PER_ADDRESS).map((r) => ({
      created_at: r.created_at,
      last_seen: r.last_seen,
      ip_coarse: r.ip_coarse,
      ua_hint: r.ua_hint,
      current: r.token_hash === currentHash,
    }));
  }

  const liveCount = (address) => stmts.live.all(address, now()).length;

  // Has this address logged in from this IP's /24 (/48) in the last 30 days? Lets a
  // returning player past the per-address failure limit (see app.js login).
  function knownIp(address, ip) {
    const c = ipCoarse(ip);
    if (!c) return false;
    return !!stmts.knownIp.get(address, c, now() - KNOWN_IP_WINDOW_S);
  }

  function purge() {
    const t = now();
    return stmts.purgeExpired.run(t - PURGE_DEAD_AFTER_S).changes
      + stmts.purgeRevoked.run(t - PURGE_DEAD_AFTER_S).changes;
  }

  const cookie = (token) => serializeCookie(COOKIE_NAME, token, { maxAge: SESSION_TTL_S, path: COOKIE_PATH });
  const clearCookie = () => serializeCookie(COOKIE_NAME, '', { maxAge: 0, path: COOKIE_PATH });

  return { create, lookup, revoke, revokeAll, list, liveCount, knownIp, purge, chatOkAfter, cookie, clearCookie, sha256hex };
}

module.exports = {
  createSessions, ipCoarse, uaHint, sha256hex,
  COOKIE_NAME, COOKIE_PATH, SESSION_TTL_S, TOUCH_EVERY_S, MAX_LIVE_PER_ADDRESS, CHAT_MIN_AGE_FLOOR,
};
