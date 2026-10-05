'use strict';

// Minimal HTTP layer on node:http — router, capped JSON bodies, cookies, client IP,
// uniform JSON errors (design §19.3, §19.5). Zero dependencies (D2).
//
// Rules this module enforces for every route, so no handler has to remember them:
//   - Paths match EXACTLY, on the raw request path. Nothing is percent-decoded and no dot
//     segment is resolved: WHATWG URL parsing would turn `/play/api/x/%2e%2e/y` into
//     `/play/api/y`, which is how an encoded `..` moves a request between prefixes (§19.3).
//     A `:param` segment accepts [A-Za-z0-9_.~-] only, never starting with a dot.
//   - Every non-GET request must carry a JSON body with `Content-Type: application/json`,
//     read under a hard byte cap (16 KB unless the route says otherwise). The content-type
//     rule is also CSRF layer 2 (§19.5): a cross-site form cannot send it without a
//     preflight, and nothing here answers one.
//   - Errors are `{ ok:false, error:'<code>', message }`, where the message comes from a
//     fixed table. Request input is never echoed into a response.
//   - A handler that throws answers 500 JSON; the process stays up.

const crypto = require('node:crypto');
const net = require('node:net');

const DEFAULT_BODY_LIMIT = 16 * 1024;
const SLOW_REQUEST_MS = 1000;

const MESSAGES = {
  bad_request: 'Bad request.',
  bad_json: 'Request body is not valid JSON.',
  unauthorised: 'Not authorised.',
  forbidden: 'Forbidden.',
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  conflict: 'Conflict.',
  payload_too_large: 'Request body too large.',
  unsupported_media_type: 'Content-Type must be application/json.',
  too_many_requests: 'Too many requests.',
  internal: 'Internal error.',
  db_unavailable: 'Database unavailable.',
  shutting_down: 'Service is restarting.',
  cross_origin: 'Cross-site request refused.',
  login_failed: 'Login failed.',
  banned: 'This account is banned from the games.',
  pool_unavailable: 'The pool is unreachable. Try again in a minute.',
  // The visible word is "tickets" (operator, C0); the code keeps `plays`.
  no_plays: 'No tickets left. Miners earn them from mining minutes; a guest account gets new ones at 00:00 UTC.',
  unknown_game: 'That game is not available.',
  mode_unavailable: 'That game mode is not available yet.',
  active_match: 'You already have a game against the bot in progress. Finish or resign it first.',
  not_your_match: 'You are not playing in this match.',
  not_your_turn: 'It is not your turn.',
  not_active: 'This match is not in progress.',
  stale: 'The board has changed since you loaded it. Reload the match.',
  timeout: 'The move time ran out, so the match has ended.',
  illegal_move: 'That move is not legal.',
  game_error: 'The game hit an internal error. The match is unchanged.',
  link_not_configured: 'The games link is not configured.',
  step_up_required: 'This action needs a fresh admin sign-in.',
  not_editable: 'This event can no longer be changed.',
  not_ended: 'The event window has not ended yet.',
  not_cancellable: 'This event is already final.',
  chat_off: 'Chat is closed.',
  chat_refused: 'You cannot post in chat yet.',
  duplicate: 'You just sent that message.',
  not_reportable: 'That message cannot be reported.',
  not_moderator: 'This address is not a chat moderator.',
  mod_refused: 'Moderator actions are not available from this session.',
  mod_protected: 'Moderators cannot act on that message.',
  too_many_moderators: 'The moderator list is full.',
  no_points: 'Not enough points.',
  self_match: 'You cannot play against your own address.',
  too_many_open: 'You already have the most open seeks and challenges allowed. Cancel one first.',
  too_many_matches: 'You already have the most games in progress allowed. Finish one first.',
  opponent_busy: 'That player already has the most games in progress allowed.',
  not_invited: 'This challenge is for another address.',
  not_open: 'This game is no longer waiting for an opponent.',
  expired: 'This seek or challenge has expired. The ticket was refunded.',
  no_draw_offer: 'There is no draw offer to answer.',
  too_late: 'A game can only be aborted before each side has moved once.',
  not_voidable: 'This match cannot be voided.',
};

// Headers on every JSON response. nosniff + no-store are the contract (§19.3, §19.12: a
// Cloudflare-cached session answer would be served to the next visitor). The CSP makes a
// JSON body opened as a document inert.
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

class HttpError extends Error {
  // extra: extra response fields chosen by the CALL SITE (e.g. { field:'address' }) —
  // codes and names, never request values.
  // headers: response headers the error needs (e.g. Retry-After on a 429).
  constructor(status, code, extra, headers) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
    this.headers = headers || null;
  }
}

function sendJson(res, status, body, headers) {
  if (res.headersSent) { res.destroy(); return; }
  const payload = JSON.stringify(body);
  res.statusCode = status;
  for (const [k, v] of Object.entries(JSON_HEADERS)) res.setHeader(k, v);
  if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

function sendError(res, err, headers) {
  const status = err.status;
  const body = { ok: false, error: err.code, message: MESSAGES[err.code] || MESSAGES.bad_request };
  if (err.extra) for (const [k, v] of Object.entries(err.extra)) if (!(k in body)) body[k] = v;
  sendJson(res, status, body, headers);
}

// ── Numbers ───────────────────────────────────────────────────────────────────────────
// Every numeric request parameter goes through this. parseInt('12abc') is 12,
// Number('1e3') is 1000, Math.min/max propagate NaN, and a negative LIMIT is "no limit"
// in SQLite — so: digits only, a safe integer, inside [min, max], or null.
function parseIntStrict(v, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^-?(0|[1-9][0-9]{0,15})$/.test(v)) n = Number(v);
  else return null;
  if (!Number.isSafeInteger(n) || n < min || n > max) return null;
  return n;
}

// ── Client IP ─────────────────────────────────────────────────────────────────────────
// nginx is the only way in, and it sets X-Real-IP to the real client. So the header is
// believed ONLY when the socket peer is loopback (i.e. it came through nginx on this box);
// from any other peer the socket address wins, whatever the header says. A loopback peer
// with no usable header is a local caller (the pool's health probe, an operator's curl).
function normaliseIp(a) {
  if (typeof a !== 'string') return null;
  if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) return a.slice(7);
  return net.isIP(a) ? a : null;
}

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1';
}

function clientIp(req) {
  const peer = normaliseIp(req.socket && req.socket.remoteAddress) || '';
  if (isLoopback(peer)) {
    const h = req.headers['x-real-ip'];
    if (typeof h === 'string') {
      const v = normaliseIp(h.trim());
      if (v) return v;
    }
  }
  return peer;
}

// ── Same-origin check (CSRF layer 3, §19.5) ───────────────────────────────────────────
// Layers 1 and 2 are SameSite=Strict and the JSON content type. This one refuses a POST
// whose Origin names another site, or that the browser itself labels cross-site
// (Sec-Fetch-Site). An absent Origin passes: non-browser callers (curl, the pool's admin
// proxy) send none, and a browser always sends one on a cross-origin POST.
// The expected origin is built from the Host header nginx forwards (`proxy_set_header Host
// $host`) — the name the browser asked for — and the scheme from X-Forwarded-Proto, both
// believed only from a loopback peer; anything else is https.
function sameOriginOk(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string' || origin === 'null') return false;
  const host = req.headers.host;
  if (typeof host !== 'string' || !/^[A-Za-z0-9.:[\]-]{1,255}$/.test(host)) return false;
  const peer = normaliseIp(req.socket && req.socket.remoteAddress) || '';
  const xfp = isLoopback(peer) ? req.headers['x-forwarded-proto'] : undefined;
  const scheme = xfp === 'http' ? 'http' : 'https';
  return origin.toLowerCase() === `${scheme}://${host.toLowerCase()}`;
}

// ── Cookies ───────────────────────────────────────────────────────────────────────────
const COOKIE_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const COOKIE_VALUE_RE = /^[!#$%&'()*+\-./0-9:<=>?@A-Z[\]^_`a-z{|}~]{0,4096}$/;

// A name sent twice is AMBIGUOUS and maps to null: a sibling subdomain can toss a second
// cookie of the same name onto this host, and "first one wins" would then let it pick
// which session the request runs as. Null means "no session", never "the attacker's".
function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header === '') return out;
  let count = 0;
  for (const part of header.split(';')) {
    if (++count > 64) break;
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!COOKIE_NAME_RE.test(name) || !COOKIE_VALUE_RE.test(value)) continue;
    out[name] = name in out ? null : value;
  }
  return out;
}

function serializeCookie(name, value, { maxAge, path = '/', httpOnly = true, secure = true, sameSite = 'Strict' } = {}) {
  if (!COOKIE_NAME_RE.test(name)) throw new Error('serializeCookie: bad name');
  if (!COOKIE_VALUE_RE.test(value)) throw new Error('serializeCookie: bad value');
  if (!/^\/[A-Za-z0-9/_.~-]*$/.test(path)) throw new Error('serializeCookie: bad path');
  let s = `${name}=${value}; Path=${path}`;
  if (maxAge !== undefined) {
    if (!Number.isSafeInteger(maxAge) || maxAge < 0) throw new Error('serializeCookie: bad maxAge');
    s += `; Max-Age=${maxAge}`;
  }
  if (httpOnly) s += '; HttpOnly';
  if (secure) s += '; Secure';
  if (sameSite) {
    if (!['Strict', 'Lax'].includes(sameSite)) throw new Error('serializeCookie: bad sameSite');
    s += `; SameSite=${sameSite}`;
  }
  return s;
}

// ── JSON body ─────────────────────────────────────────────────────────────────────────
const JSON_TYPE_RE = /^application\/json[ \t]*(;[ \t]*charset[ \t]*=[ \t]*"?utf-8"?[ \t]*)?$/i;

function readJson(req, { limit = DEFAULT_BODY_LIMIT } = {}) {
  if (!JSON_TYPE_RE.test(req.headers['content-type'] || '')) {
    return Promise.reject(new HttpError(415, 'unsupported_media_type'));
  }
  const cl = req.headers['content-length'];
  if (cl !== undefined) {
    if (!/^[0-9]{1,15}$/.test(cl)) return Promise.reject(new HttpError(400, 'bad_request'));
    // Refuse before reading a byte when the client already says it is too big.
    if (Number(cl) > limit) return Promise.reject(new HttpError(413, 'payload_too_large', null));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onError);
    };
    const finish = (err, value) => {
      if (done) return;
      done = true;
      cleanup();
      if (err) reject(err); else resolve(value);
    };
    function onData(chunk) {
      size += chunk.length;
      if (size > limit) {
        // Stop BUFFERING, but let the rest drain into nothing: closing a socket that still
        // has unread input makes the kernel send a reset, which can destroy the 413 before
        // the client reads it. Draining is bounded — nginx's client_max_body_size caps what
        // reaches us, and requestTimeout caps a local caller. The 413 carries
        // Connection: close, so the leftover is never parsed as a next request.
        finish(new HttpError(413, 'payload_too_large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
      } catch {
        finish(new HttpError(400, 'bad_json'));
        return;
      }
      if (text.trim() === '') { finish(new HttpError(400, 'bad_json')); return; }
      let value;
      try { value = JSON.parse(text); } catch { finish(new HttpError(400, 'bad_json')); return; }
      finish(null, value);
    }
    function onError() { finish(new HttpError(400, 'bad_request')); }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onError);
  });
}

// ── Router ────────────────────────────────────────────────────────────────────────────
const PARAM_RE = /^[A-Za-z0-9_~-][A-Za-z0-9_.~-]{0,127}$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function createRouter() {
  const routes = [];

  // add('GET', '/play/api/matches/:id', handler, { bodyLimit, guard })
  // guard(ctx): runs BEFORE the body is read (the admin routes check the link secret there,
  // so a caller without it never gets a body parsed). It throws an HttpError to refuse.
  function add(method, pattern, handler, opts = {}) {
    if (!METHODS.has(method)) throw new Error(`router: unsupported method ${method}`);
    if (typeof pattern !== 'string' || !pattern.startsWith('/')) throw new Error('router: pattern must start with /');
    if (typeof handler !== 'function') throw new Error('router: handler must be a function');
    const segs = pattern.split('/').slice(1).map((s) => (s.startsWith(':') ? { param: s.slice(1) } : { lit: s }));
    for (const s of segs) {
      if (s.param !== undefined && !/^[a-z_][a-z0-9_]*$/i.test(s.param)) throw new Error(`router: bad param name in ${pattern}`);
    }
    if (routes.some((r) => r.method === method && r.pattern === pattern)) throw new Error(`router: duplicate ${method} ${pattern}`);
    if (opts.guard !== undefined && typeof opts.guard !== 'function') throw new Error('router: guard must be a function');
    routes.push({ method, pattern, segs, handler, bodyLimit: opts.bodyLimit || DEFAULT_BODY_LIMIT, guard: opts.guard || null });
  }

  function matchPath(route, parts) {
    if (route.segs.length !== parts.length) return null;
    const params = Object.create(null);
    for (let i = 0; i < parts.length; i++) {
      const s = route.segs[i];
      if (s.lit !== undefined) {
        if (s.lit !== parts[i]) return null;
      } else {
        if (!PARAM_RE.test(parts[i])) return null;
        params[s.param] = parts[i];
      }
    }
    return params;
  }

  // → { route, params } | { allowed: [...] } (path exists, method does not) | null
  function match(method, pathname) {
    const parts = pathname.split('/').slice(1);
    const want = method === 'HEAD' ? 'GET' : method;
    const allowed = [];
    for (const r of routes) {
      const params = matchPath(r, parts);
      if (!params) continue;
      if (r.method === want) return { route: r, params };
      allowed.push(r.method);
    }
    return allowed.length ? { allowed } : null;
  }

  return { add, match, routes };
}

// ── Request handler ───────────────────────────────────────────────────────────────────
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Split the raw request target WITHOUT a URL parser (see the header: no decoding, no dot
// segments). Only origin-form (`/path?query`) is accepted.
function splitTarget(target) {
  if (typeof target !== 'string' || !target.startsWith('/')) return null;
  const q = target.indexOf('?');
  const pathname = q === -1 ? target : target.slice(0, q);
  const search = q === -1 ? '' : target.slice(q + 1);
  if (pathname.includes('#')) return null;
  return { pathname, search };
}

function createRequestHandler({ router, log, isShuttingDown = () => false }) {
  return function handle(req, res) {
    const started = Date.now();
    const incoming = req.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && REQUEST_ID_RE.test(incoming)
      ? incoming : crypto.randomBytes(8).toString('hex');
    res.setHeader('X-Request-Id', requestId);

    const fail = (err, headers) => sendError(res, err, headers);

    if (isShuttingDown()) {
      fail(new HttpError(503, 'shutting_down'), { Connection: 'close' });
      return;
    }

    const target = splitTarget(req.url);
    if (!target) { fail(new HttpError(404, 'not_found')); return; }
    const m = router.match(req.method, target.pathname);
    if (!m) { fail(new HttpError(404, 'not_found')); return; }
    if (!m.route) {
      const allow = [...new Set(m.allowed.flatMap((x) => (x === 'GET' ? ['GET', 'HEAD'] : [x])))].join(', ');
      fail(new HttpError(405, 'method_not_allowed'), { Allow: allow });
      return;
    }

    const ctx = {
      req,
      res,
      requestId,
      method: req.method,
      path: target.pathname,
      params: m.params,
      query: new URLSearchParams(target.search),
      ip: clientIp(req),
      cookies: parseCookies(req.headers.cookie),
      body: undefined,
      log,
      json: (status, body, headers) => sendJson(res, status, body, headers),
    };

    (async () => {
      if (m.route.guard) await m.route.guard(ctx);
      if (m.route.method !== 'GET') ctx.body = await readJson(req, { limit: m.route.bodyLimit });
      const result = await m.route.handler(ctx);
      if (res.writableEnded || res.headersSent) return;
      if (result === undefined) throw new Error(`handler for ${m.route.method} ${m.route.pattern} returned nothing`);
      sendJson(res, 200, result);
    })().then(() => {
      const ms = Date.now() - started;
      if (ms > SLOW_REQUEST_MS) log.warn(`[http] slow ${m.route.method} ${m.route.pattern} ${ms}ms id=${requestId}`);
    }, (err) => {
      if (err instanceof HttpError) {
        // A body we stopped reading must not be parsed as the next request.
        fail(err, { ...(err.headers || {}), ...(err.status === 413 ? { Connection: 'close' } : {}) });
        return;
      }
      log.error(`[http] ${m.route.method} ${m.route.pattern} id=${requestId} failed: ${err && err.stack ? err.stack : err}`);
      fail(new HttpError(500, 'internal'));
    }).catch(() => {
      // The error path itself failed (e.g. an unserialisable response). index.js exits on
      // an unhandled rejection, so this last resort drops the one connection instead.
      try { res.destroy(); } catch { /* nothing left to do */ }
    });
  };
}

module.exports = {
  DEFAULT_BODY_LIMIT,
  MESSAGES,
  HttpError,
  sendJson,
  sendError,
  parseIntStrict,
  clientIp,
  isLoopback,
  normaliseIp,
  sameOriginOk,
  parseCookies,
  serializeCookie,
  readJson,
  createRouter,
  createRequestHandler,
};
