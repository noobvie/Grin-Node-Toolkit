'use strict';

// Pool side of the games platform link (design §19.3). EVERYTHING the pool does because of
// the games lives in this file; index.js only creates it, mounts it and reads publicFlag().
//
// The games service (`grin-games`, user grinplay, play/server/) is a separate process with
// its own DB, and it never opens pool.db (§19.1 D5). It reaches the pool through exactly
// three internal routes, and the pool reaches it through one admin proxy and one probe:
//
//   POST /internal/games/verify-proof   games → pool   one ownership proof, on the REAL client IP
//   GET  /internal/games/activity       games → pool   active miner-minutes in a ≤ 1 h window
//   GET  /internal/games/config         games → pool   the `games` settings section
//   ALL  /api/admin/games/*             admin → pool → games /internal/admin/*
//   GET  /play/api/health               pool → games   every 60 s, 1 s timeout, never awaited
//
// ⚠ THE HARD CONSTRAINT (§19 preamble): nothing here may slow down, restart or endanger
// mining. The stratum server shares this process and its ONE synchronous DB connection, so:
//   - nothing in this file runs on the share, block, reward or payout paths;
//   - the only pool.db reads are one indexed range query (activity), one account-page-sized
//     proof check (verify-proof) and a settings read (config) — all on request, none timed;
//   - the probe is an async HTTP GET on an unref'd timer, and no request handler awaits it;
//   - a wrong secret costs one comparison: the secret is checked BEFORE the body is read,
//     before any DB read and before any scrypt (§19.13 #12).
//
// /internal/* has three independent guards, because any one alone is a typo from open:
//   1. nginx never proxies it (the vhost proxies /api/… and a few exact files) and Part 3's
//      vhost adds `location ^~ /internal/ { return 404; }`;
//   2. this file answers 404 to anything that carries a forwarding header or arrives on a
//      non-loopback socket — a request that came through nginx always has X-Forwarded-For;
//   3. the link secret (X-Games-Link, timingSafeEqual).
//
// The internal middleware is mounted in index.js BEFORE express.json(), so a body is never
// parsed for an unauthenticated caller and the verify body cap is ours (2 KB), not
// express.json()'s 100 KB. It is also outside every rate limiter (§19.1 D7): all games calls
// arrive from 127.0.0.1, so a per-IP bucket would be one bucket for every player. The pool's
// own proof throttles still apply — keyed on the client_ip the games service forwards.

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { RESERVED_ADDRESSES } = require('./incentives');
const PoolSettings = require('./pool-settings');

const GAMES_MODES = PoolSettings.GAMES_MODES;
// The same shape check /api/account applies (index.js setupRoutes). The network prefix is
// checked separately: a tgrin1 address on a mainnet pool is well-formed and still wrong.
const GRIN_ADDR_RE = /^t?grin1[ac-hj-np-z02-9]{58}$/;

const LINK_MIN_BYTES = 32;            // §19.3: shorter = "not configured"
const LINK_MAX_BYTES = 4096;          // a link file this big is not ours; never read it
const LINK_STAT_MEMO_MS = 1000;       // re-stat at most once a second (rotation = mv, see §19.3)
const VERIFY_BODY_MAX = 2048;         // §19.3: verify-proof JSON ≤ 2 KB
const PROOF_MAX = 256;                // §19.3: proof is 1–256 chars
const ACTIVITY_WINDOW_MAX_S = 3600;   // §19.3: 0 < to − from ≤ 3600
const ACTIVITY_LOOKBACK_MAX_S = 7 * 86400;
const PROXY_BODY_MAX = 64 * 1024;     // §19.3: admin proxy JSON ≤ 64 KB
const PROXY_RESPONSE_MAX = 2 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 2000;
const PROBE_INTERVAL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 1000;
const PROBE_BODY_MAX = 4096;
const ADMIN_USER_MAX = 64;
// Global caps on the two routes that cost this process real work (§19.13 #12, Part 11
// review). The games service's own limiters are what an HONEST caller meets first; these are
// for a games process that is not honest — a compromised grinplay holds the secret and can
// forge client_ip, so the per-IP proof throttles would see a fresh IP on every call. So they
// key on nothing a caller controls, and sit far above honest use:
//   verify-proof  ≤ 4 in flight (one scrypt each — libuv's default pool is 4 threads) and
//                 120 a minute;
//   activity      60 per 5 min — an honest sync makes ≤ 24 calls per 5-min tick.
// Over a cap → 429 `busy`: the games service reads it as "pool unavailable" (login 503, the
// sync retries next tick).
const VERIFY_INFLIGHT_MAX = 4;
const VERIFY_PER_MIN = 120;
const ACTIVITY_PER_5MIN = 60;

// ONE statement (§19.3). INDEXED BY pins the plan instead of trusting the planner: nothing on
// this box runs ANALYZE, and without stats SQLite may prefer idx_hashrate_address because it
// already yields GROUP BY grin_address order — a whole-index walk of a table that grows by one
// row per active miner per minute (memory project_pool_db_capacity). With INDEXED BY the plan
// is a SEARCH on recorded_at, and a missing index is a loud "no query solution" error rather
// than a silent full scan on the process that serves stratum.
const ACTIVITY_SQL =
  'SELECT grin_address, COUNT(*) AS minutes, SUM(window_seconds) AS seconds ' +
  'FROM hashrate_history INDEXED BY idx_hashrate_time ' +
  'WHERE recorded_at > ? AND recorded_at <= ? AND hashrate_gps > 0 ' +
  `AND grin_address NOT IN (${RESERVED_ADDRESSES.map(() => '?').join(', ')}) ` +
  'GROUP BY grin_address';

// Admin proxy: which writes may go through on a plain admin session (§19.11). The list is of
// the FAST ones, not the dangerous ones, so a games admin route added later without updating
// this file defaults to step-up (fail closed) instead of silently skipping it. GET is never
// step-up. Paths are relative to /internal/admin/ and are already charset-checked when this
// runs, so `[^/]+` cannot contain an encoded byte or a dot-segment.
const FAST_WRITES = [
  ['POST', /^chat\/messages\/[^/]+\/delete$/],   // delete one message
  ['POST', /^players\/[^/]+\/mute$/],            // mute
  ['POST', /^chat\/held\/[^/]+\/approve$/],      // approve a held message
  ['POST', /^chat\/post$/],                      // operator post
  ['POST', /^events$/],                          // event create
  ['POST', /^events\/[^/]+$/],                   // event update
];
const PROXY_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
// One segment = the games router's `:param` charset (play/server/lib/http.js), never starting
// with a dot, so `..` and `.x` cannot appear. No `%` at all: the games service matches the raw
// path without decoding, and so does this check, so an encoded slash or dot has nowhere to go.
const PROXY_PATH_RE = /^[A-Za-z0-9_~-][A-Za-z0-9_.~-]*(\/[A-Za-z0-9_~-][A-Za-z0-9_.~-]*)*$/;
const PROXY_QUERY_RE = /^[A-Za-z0-9_.~%=&+-]*$/;

function requiresStepUp(method, relPath) {
  if (method === 'GET') return false;
  return !FAST_WRITES.some(([m, re]) => m === method && re.test(relPath));
}

function isLoopbackIp(ip) {
  const s = String(ip || '').toLowerCase();
  if (s === '::1') return true;
  const v4 = s.startsWith('::ffff:') ? s.slice(7) : s;
  return net.isIPv4(v4) && v4.startsWith('127.');
}

// A client_ip the pool will not throttle on: loopback or unspecified. If the games service
// ever forwards one, its nginx X-Real-IP plumbing is broken and every player would share one
// throttle bucket (D7) — refuse loudly instead of degrading silently.
function isUnusableClientIp(ip) {
  const s = String(ip).toLowerCase();
  return isLoopbackIp(s) || s === '::' || s === '0.0.0.0' || s === '::ffff:0.0.0.0';
}

function sameSecret(given, expected) {
  if (typeof given !== 'string' || given === '') return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);   // same work on the length-mismatch path
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, obj, extraHeaders) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(body);
}

const fail = (res, status, error, field) =>
  sendJson(res, status, field ? { ok: false, error, field } : { ok: false, error });

// Reads a JSON object body with a hard cap. Resolves the object, or null after it has already
// answered (413/415/400). Never used before the secret check.
function readJsonBody(req, res, max) {
  return new Promise((resolve) => {
    const ctype = String(req.headers['content-type'] || '');
    if (!/^application\/json\s*(;|$)/i.test(ctype)) {
      fail(res, 415, 'unsupported_media_type');
      return resolve(null);
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined && !(Number(declared) <= max)) {
      sendJson(res, 413, { ok: false, error: 'payload_too_large' }, { Connection: 'close' });
      req.resume();
      return resolve(null);
    }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > max) {
        over = true;
        sendJson(res, 413, { ok: false, error: 'payload_too_large' }, { Connection: 'close' });
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => { if (!over) { over = true; resolve(null); } });
    req.on('end', () => {
      if (over) return;
      let obj;
      try { obj = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { obj = undefined; }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        fail(res, 400, 'bad_request', 'body');
        return resolve(null);
      }
      resolve(obj);
    });
  });
}

// '123' → 123; anything else (absent, repeated, signed, decimal, 1e3, 0x10, too long) → null.
function strictInt(values) {
  if (!Array.isArray(values) || values.length !== 1) return null;
  const s = values[0];
  if (!/^(0|[1-9][0-9]{0,11})$/.test(s)) return null;
  return Number(s);
}

function createGamesLink(opts = {}) {
  const now = opts.now || (() => Date.now());
  let deps = null;              // set by attach()
  let linkCfg = null;           // { port, file } once attach() has validated them
  let activityStmt = null;
  let secretMemo = { at: 0, mtimeMs: -1, size: -1, value: null };
  let probeTimer = null;
  let probe = { healthy: false, checked_at: null, reason: 'not_checked', schema: null, uptime_s: null };

  // A token bucket on the injected clock: `capacity` calls, refilled evenly over `windowMs`.
  function makeBucket(capacity, windowMs) {
    let tokens = capacity;
    let at = null;
    return () => {
      const t = now();
      if (at !== null && t > at) tokens = Math.min(capacity, tokens + ((t - at) * capacity) / windowMs);
      at = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };
  }
  const verifyBucket = makeBucket(VERIFY_PER_MIN, 60 * 1000);
  const activityBucket = makeBucket(ACTIVITY_PER_5MIN, 5 * 60 * 1000);
  let verifyInflight = 0;
  let busyLoggedAt = -Infinity;
  function busy(res, what) {
    const t = now();
    if (t - busyLoggedAt >= 60 * 1000) {
      busyLoggedAt = t;
      console.error(`[games-link] ${what} over its global cap — refused (429). An honest games service never gets here.`);
    }
    return fail(res, 429, 'busy');
  }

  const net_ = () => (deps && deps.config && deps.config.network === 'mainnet' ? 'mainnet' : 'testnet');
  const gamesPort = () => (linkCfg ? linkCfg.port : null);
  const linkFile = () => (linkCfg ? linkCfg.file : null);

  // The link secret, re-read when the file's mtime or size changes (§19.3 rotation: write a temp
  // file, mv it over — both sides pick it up on their next call, nothing restarts). Missing,
  // unreadable, oversized or short → null = "not configured". Surrounding whitespace (the
  // trailing newline an editor or `echo` adds) is not part of the secret; the games side
  // (Part 4, pool-link.js) must trim the same way.
  function linkSecret() {
    if (!linkCfg) return null;
    const t = now();
    if (t - secretMemo.at < LINK_STAT_MEMO_MS) return secretMemo.value;
    secretMemo.at = t;
    let st;
    try { st = fs.statSync(linkFile()); } catch (e) { secretMemo.value = null; secretMemo.mtimeMs = -1; return null; }
    if (st.mtimeMs === secretMemo.mtimeMs && st.size === secretMemo.size) return secretMemo.value;
    secretMemo.mtimeMs = st.mtimeMs;
    secretMemo.size = st.size;
    secretMemo.value = null;
    if (!st.isFile() || st.size > LINK_MAX_BYTES) return null;
    let v;
    try { v = fs.readFileSync(linkFile(), 'utf8').trim(); } catch (e) { return null; }
    secretMemo.value = Buffer.byteLength(v, 'utf8') >= LINK_MIN_BYTES ? v : null;
    return secretMemo.value;
  }

  // The `games` settings section, typed. A value that is not exactly an allowed mode reads as
  // 'off'; chat is on only for a real boolean true or the exact string 'true' — a quoted
  // "false" is truthy in JS and must never switch anything on (memory
  // project_config_loader_type_traps). Throws when the section cannot be read.
  function gamesSettings() {
    const s = deps.poolSettings.getSection('games');
    return {
      mode: GAMES_MODES.includes(s.mode) ? s.mode : 'off',
      chat_enabled: s.chat_enabled === true || s.chat_enabled === 'true',
    };
  }

  // What the public branding payload says (D12): the configured mode while the games service
  // answers its health check, else 'off' — so a stopped or crashed games service hides the nav
  // link without anyone touching a setting. Never throws; any failure reads as off.
  function publicFlag() {
    try {
      if (!deps || !probe.healthy) return { mode: 'off', chat: false };
      const g = gamesSettings();
      return { mode: g.mode, chat: g.mode !== 'off' && g.chat_enabled };
    } catch (e) {
      return { mode: 'off', chat: false };
    }
  }

  // ── Health probe (pool → games) ────────────────────────────────────────────
  // Healthy = HTTP 200, {ok:true}, and the SAME network as this pool: a testnet games service
  // answering on the mainnet port is not this pool's games service.
  function probeOnce() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (healthy, reason, j) => {
        if (settled) return;
        settled = true;
        clearTimeout(hard);
        const was = probe.healthy;
        probe = {
          healthy,
          checked_at: Math.floor(now() / 1000),
          reason,
          schema: healthy && Number.isInteger(j.schema) ? j.schema : null,
          uptime_s: healthy && Number.isInteger(j.uptime_s) ? j.uptime_s : null,
        };
        if (was !== healthy && deps && typeof deps.onHealthChange === 'function') {
          try { deps.onHealthChange(healthy); } catch (e) { /* a cache flush must not break the probe */ }
        }
        resolve(probe);
      };
      let req;
      // `timeout` on http.request is an IDLE timeout; this one bounds the whole exchange.
      const hard = setTimeout(() => { if (req) req.destroy(); done(false, 'timeout'); }, PROBE_TIMEOUT_MS);
      if (hard.unref) hard.unref();
      try {
        req = http.request({
          host: '127.0.0.1', port: gamesPort(), path: '/play/api/health', method: 'GET',
          agent: false, headers: { Accept: 'application/json' },
        }, (r) => {
          const chunks = [];
          let size = 0;
          r.on('data', (c) => {
            size += c.length;
            if (size > PROBE_BODY_MAX) { req.destroy(); done(false, 'bad_response'); return; }
            chunks.push(c);
          });
          r.on('error', () => done(false, 'unreachable'));
          r.on('end', () => {
            let j = null;
            try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { j = null; }
            if (r.statusCode !== 200 || !j || j.ok !== true) return done(false, 'unhealthy');
            if (j.net !== net_()) return done(false, 'wrong_network');
            done(true, 'ok', j);
          });
        });
        req.on('error', () => done(false, 'unreachable'));
        req.end();
      } catch (e) {
        done(false, 'unreachable');
      }
    });
  }

  // ── /internal/games/* handlers ─────────────────────────────────────────────
  async function handleVerify(req, res) {
    const body = await readJsonBody(req, res, VERIFY_BODY_MAX);
    if (!body) return;
    for (const k of Object.keys(body)) {
      if (k !== 'address' && k !== 'proof' && k !== 'client_ip') return fail(res, 400, 'bad_request', k);
    }
    const { address, proof, client_ip: clientIp } = body;
    const prefix = net_() === 'mainnet' ? 'grin1' : 'tgrin1';
    if (typeof address !== 'string' || !GRIN_ADDR_RE.test(address) || !address.startsWith(prefix)) {
      return fail(res, 400, 'bad_request', 'address');
    }
    if (typeof proof !== 'string' || proof.length < 1 || proof.length > PROOF_MAX) {
      return fail(res, 400, 'bad_request', 'proof');
    }
    // Required, and never replaced by req.ip — that is always 127.0.0.1 here (D7).
    if (typeof clientIp !== 'string' || !net.isIP(clientIp) || isUnusableClientIp(clientIp)) {
      return fail(res, 400, 'bad_request', 'client_ip');
    }
    if (verifyInflight >= VERIFY_INFLIGHT_MAX || !verifyBucket()) return busy(res, 'verify-proof');
    let r;
    verifyInflight++;
    try {
      r = await deps.verifyOwnerProof(deps.db, address, proof, clientIp);
    } catch (e) {
      console.error(`[games-link] verify-proof failed: ${e && e.message}`);
      return fail(res, 500, 'internal');
    } finally {
      verifyInflight--;
    }
    const ok = !!(r && r.ok);
    deps.auditOwnerProof(deps.db, {
      action: 'games_login', grinAddress: address, ip: clientIp, ok,
      details: ok ? { proof_method: r.method, slot: r.slot } : { reason: r && r.reason },
    });
    // 200 either way: the call worked, the proof did or did not. `reason` is verifyOwnerProof's
    // own word (incl. too_many_attempts), which the account page already shows for the same
    // input. Nothing else from the proof machinery — no hash, salt, row or the proof — leaves.
    if (ok) {
      return sendJson(res, 200, {
        ok: true,
        method: r.method === 'password' ? 'password' : 'ip',
        slot: r.slot === 'anchor' ? 'anchor' : 'set',
        age_seconds: Number.isInteger(r.age_seconds) ? r.age_seconds : null,
      });
    }
    return sendJson(res, 200, { ok: false, reason: String((r && r.reason) || 'no_match') });
  }

  function handleActivity(req, res, query) {
    const params = new URLSearchParams(query);
    for (const k of params.keys()) {
      if (k !== 'from' && k !== 'to') return fail(res, 400, 'bad_request', k);
    }
    const from = strictInt(params.getAll('from'));
    const to = strictInt(params.getAll('to'));
    const nowS = Math.floor(now() / 1000);
    if (from === null) return fail(res, 400, 'bad_request', 'from');
    if (to === null) return fail(res, 400, 'bad_request', 'to');
    if (!(to > from) || to - from > ACTIVITY_WINDOW_MAX_S) return fail(res, 400, 'bad_request', 'window');
    if (to > nowS) return fail(res, 400, 'bad_request', 'to');
    if (from < nowS - ACTIVITY_LOOKBACK_MAX_S) return fail(res, 400, 'bad_request', 'from');
    if (!activityBucket()) return busy(res, 'activity');
    let rows;
    try {
      if (!activityStmt) activityStmt = deps.db.prepare(ACTIVITY_SQL);
      rows = activityStmt.all(from, to, ...RESERVED_ADDRESSES);
    } catch (e) {
      console.error(`[games-link] activity query failed: ${e && e.message}`);
      return fail(res, 500, 'internal');
    }
    // Full addresses: this route is internal and secret-guarded, not a public list (§19.3).
    return sendJson(res, 200, {
      ok: true, from, to,
      rows: rows.map((r) => ({ address: r.grin_address, minutes: r.minutes, seconds: r.seconds })),
    });
  }

  function handleConfig(req, res) {
    let g;
    // 503, not a guessed 'off': the games service keeps its last known mode for ≤ 10 min when
    // it cannot learn the current one (§19.2), which a fake 'off' here would defeat.
    try { g = gamesSettings(); } catch (e) { return fail(res, 503, 'settings_unavailable'); }
    return sendJson(res, 200, { ok: true, mode: g.mode, chat_enabled: g.chat_enabled, net: net_() });
  }

  // Mounted with app.use() ahead of express.json(). Anything outside /internal passes through
  // untouched; everything inside is answered here and never reaches another pool route.
  function internal(req, res, next) {
    const url = String(req.url || '');
    if (!(url === '/internal' || url.startsWith('/internal/') || url.startsWith('/internal?'))) return next();

    // Guard 2 (header): nothing that came through nginx, nothing off-box.
    if (req.headers['x-forwarded-for'] !== undefined || req.headers['x-real-ip'] !== undefined ||
        !isLoopbackIp(req.socket && req.socket.remoteAddress)) {
      return fail(res, 404, 'not_found');
    }
    // Guard 3: the secret, before the body, any DB read or any scrypt.
    const secret = linkSecret();
    if (!secret) return fail(res, 503, 'link_not_configured');
    if (!sameSecret(req.headers['x-games-link'], secret)) return fail(res, 401, 'unauthorised');

    const q = url.indexOf('?');
    const p = q < 0 ? url : url.slice(0, q);
    const query = q < 0 ? '' : url.slice(q + 1);
    const route = `${req.method} ${p}`;
    try {
      if (route === 'POST /internal/games/verify-proof') {
        handleVerify(req, res).catch(() => fail(res, 500, 'internal'));
        return;
      }
      if (route === 'GET /internal/games/activity') return handleActivity(req, res, query);
      if (route === 'GET /internal/games/config') return handleConfig(req, res);
    } catch (e) {
      console.error(`[games-link] ${route} failed: ${e && e.message}`);
      return fail(res, 500, 'internal');
    }
    return fail(res, 404, 'not_found');
  }

  // ── Admin proxy (admin → pool → games) ─────────────────────────────────────
  function proxyAdmin(req, res, stepUpRefused) {
    const method = req.method;
    if (!PROXY_METHODS.has(method)) return res.status(405).json({ error: 'method_not_allowed' });
    const raw = String(req.originalUrl || '');
    const prefix = '/api/admin/games/';
    if (!raw.startsWith(prefix)) return res.status(404).json({ error: 'not_found' });
    const rest = raw.slice(prefix.length);
    const q = rest.indexOf('?');
    const relPath = q < 0 ? rest : rest.slice(0, q);
    const query = q < 0 ? '' : rest.slice(q + 1);
    if (relPath.length > 256 || !PROXY_PATH_RE.test(relPath)) return res.status(400).json({ error: 'bad_path' });
    if (query.length > 1024 || !PROXY_QUERY_RE.test(query)) return res.status(400).json({ error: 'bad_query' });

    // Step-up is enforced HERE, before anything is sent to games (§19.3, §19.11). The games
    // side re-checks X-Admin-Stepup, but that is defence in depth; this is the enforcer.
    const stepUp = requiresStepUp(method, relPath);
    if (stepUp && stepUpRefused(req, res)) return;

    const secret = linkSecret();
    if (!secret) return res.status(503).json({ error: 'link_not_configured' });

    let payload = null;
    if (method !== 'GET') {
      if (Number(req.headers['content-length'] || 0) > PROXY_BODY_MAX) {
        return res.status(413).json({ error: 'payload_too_large' });
      }
      payload = JSON.stringify(req.body && typeof req.body === 'object' ? req.body : {});
      if (Buffer.byteLength(payload) > PROXY_BODY_MAX) return res.status(413).json({ error: 'payload_too_large' });
    }

    const user = req.user || {};
    const uname = typeof user.username === 'string' ? user.username.trim() : '';
    const adminUser = /^[\x20-\x7e]+$/.test(uname) && uname.length <= ADMIN_USER_MAX
      ? uname : `user#${Number.parseInt(user.user_id, 10) || 0}`;
    const requestId = crypto.randomBytes(12).toString('hex');
    const headers = {
      Accept: 'application/json',
      'X-Games-Link': secret,
      'X-Admin-User': adminUser,
      'X-Admin-Stepup': stepUp ? '1' : '0',
      'X-Request-Id': requestId,
    };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    let settled = false;
    const finish = (status, bodyText) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      if (stepUp) {
        // One pool audit row per step-up action (§19.3) — method + path + outcome, no body.
        try {
          deps.db.prepare(
            `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
             VALUES (?, 'games_admin', 'games', ?, ?, ?)`
          ).run(Number.isInteger(user.user_id) ? user.user_id : null, relPath,
            JSON.stringify({ method, path: relPath, status, request_id: requestId }), req.ip || null);
        } catch (e) { console.error(`[games-link] audit write failed: ${e && e.message}`); }
      }
      if (res.headersSent) return;
      res.setHeader('Cache-Control', 'no-store');
      res.status(status).type('application/json').send(bodyText);
    };
    const offline = () => finish(503, JSON.stringify({ error: 'games_offline' }));

    let up;
    const hard = setTimeout(() => { if (up) up.destroy(); offline(); }, PROXY_TIMEOUT_MS);
    if (hard.unref) hard.unref();
    try {
      up = http.request({
        host: '127.0.0.1', port: gamesPort(), method, agent: false, headers,
        path: `/internal/admin/${relPath}${query ? `?${query}` : ''}`,
      }, (r) => {
        const chunks = [];
        let size = 0;
        r.on('data', (c) => {
          size += c.length;
          if (size > PROXY_RESPONSE_MAX) { up.destroy(); finish(502, JSON.stringify({ error: 'games_bad_response' })); return; }
          chunks.push(c);
        });
        r.on('error', offline);
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try { JSON.parse(text); } catch (e) { return finish(502, JSON.stringify({ error: 'games_bad_response' })); }
          finish(r.statusCode, text);
        });
      });
      up.on('error', offline);
      up.end(payload === null ? undefined : payload);
    } catch (e) {
      offline();
    }
  }

  function status() {
    let g = { mode: 'off', chat_enabled: false };
    let settingsReadable = true;
    try { g = gamesSettings(); } catch (e) { settingsReadable = false; }
    return {
      mode: g.mode,
      chat_enabled: g.chat_enabled,
      settings_readable: settingsReadable,
      public_mode: publicFlag().mode,
      net: net_(),
      games_port: gamesPort(),
      link_file: linkFile(),
      link_configured: !!linkSecret(),
      probe: { ...probe },
    };
  }

  return {
    internal,
    publicFlag,
    status,
    probeOnce,
    // Phase 2 of setup, once the pool's DB, config and settings exist (index.js initializePool).
    // Starts the probe: one immediate run, then every 60 s on an unref'd timer.
    attach(d) {
      deps = d;
      // games_port / games_link_secret_file come from pool.json (lib/config.js supplies the
      // per-network defaults). A bad value DISABLES the link — it must never stop the pool
      // from booting, because nothing about the games may endanger mining.
      const port = Number(d.config.games_port);
      const file = d.config.games_link_secret_file;
      linkCfg = (Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== Number(d.config.port) &&
                 typeof file === 'string' && path.isAbsolute(file) && !file.includes('\0'))
        ? { port, file } : null;
      if (!linkCfg) {
        console.error('[games-link] games_port / games_link_secret_file in the pool config is invalid — ' +
          'the games link is disabled (mining is unaffected)');
        return;
      }
      if (d.startProbe !== false) {
        probeOnce();
        probeTimer = setInterval(probeOnce, PROBE_INTERVAL_MS);
        if (probeTimer.unref) probeTimer.unref();
      }
    },
    // /api/admin/games-link = the probe + switch state for the Settings → Games page (pool-owned,
    // no proxy). /api/admin/games/* = the proxy. Both behind secureAdmin (JWT + IP allowlist).
    mountAdmin(app, { secureAdmin, stepUpRefused }) {
      app.get('/api/admin/games-link', secureAdmin, (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ success: true, data: status() });
      });
      app.all('/api/admin/games/*', secureAdmin, (req, res) => proxyAdmin(req, res, stepUpRefused));
    },
    stop() { if (probeTimer) clearInterval(probeTimer); probeTimer = null; },
  };
}

module.exports = {
  createGamesLink,
  requiresStepUp,
  ACTIVITY_SQL,
  FAST_WRITES,
  GAMES_MODES,
  LINK_MIN_BYTES,
  VERIFY_BODY_MAX,
  ACTIVITY_WINDOW_MAX_S,
  PROXY_BODY_MAX,
  VERIFY_INFLIGHT_MAX,
  VERIFY_PER_MIN,
  ACTIVITY_PER_5MIN,
};
