'use strict';

// /internal/admin/* — the games side of the admin proxy (design §19.3, §19.11, D11).
//
// The games service contains NO admin authentication: the operator signs in to the POOL's
// admin panel (JWT + IP allowlist + 2FA), and the pool forwards to these routes with the
// link secret, the admin's name and whether step-up was done. What this module checks is
// that the request really came from that proxy, in this order, all BEFORE a body is read
// (the router's `guard` hook):
//   1. no X-Forwarded-For / X-Real-IP, and a loopback peer — the proxy connects straight to
//      127.0.0.1 and sends neither; nginx always adds them, so a request that reached us
//      through any proxy location gets 404 before the secret is looked at (the pool's third
//      guard, §19.15 Part 2 #3, mirrored);
//   2. the link secret (X-Games-Link), compared inside pool-link.js — 503 when this side has
//      no secret file, 401 for a missing or wrong one (the same answer);
//   3. X-Admin-User: printable ASCII, 1–64 chars — it is written to mod_actions;
//   4. X-Admin-Stepup: 1 on every step-up path. The POOL is the enforcer (it asks for the
//      password before proxying); this is defence in depth, so the rule is the pool's own,
//      copied: every write is step-up unless it is one of the six FAST writes below.
//
// These routes are registered on the router directly, never through app.js publicRoute():
// they must work while the games are `off`, so the operator can prepare before opening.
//
// Every WRITE records one mod_actions row (§19.3) with the admin's name, via audit().

const { HttpError, normaliseIp, isLoopback } = require('./http');

const PREFIX = '/internal/admin/';

// ⚠ Must stay identical to back-end-pool/lib/games-link.js FAST_WRITES (test-events.js
// compares the two). Paths are relative to /internal/admin/; `[^/]+` is one segment.
const FAST_WRITES = [
  ['POST', /^chat\/messages\/[^/]+\/delete$/],   // delete one message
  ['POST', /^players\/[^/]+\/mute$/],            // mute
  ['POST', /^chat\/held\/[^/]+\/approve$/],      // approve a held message
  ['POST', /^chat\/post$/],                      // operator post
  ['POST', /^events$/],                          // event create
  ['POST', /^events\/[^/]+$/],                   // event update
];

function requiresStepUp(method, relPath) {
  if (method === 'GET') return false;
  return !FAST_WRITES.some(([m, re]) => m === method && re.test(relPath));
}

const ADMIN_USER_RE = /^[\x20-\x7e]{1,64}$/;
const DETAILS_MAX = 2048;

function createAdmin({ router, poolLink, db, now = () => Math.floor(Date.now() / 1000) }) {
  const insertAction = db.raw.prepare(
    'INSERT INTO mod_actions (admin_user, action, target, details_json, created_at) VALUES (?, ?, ?, ?, ?)');

  function guard(ctx) {
    const h = ctx.req.headers;
    const peer = normaliseIp(ctx.req.socket && ctx.req.socket.remoteAddress) || '';
    if (h['x-forwarded-for'] !== undefined || h['x-real-ip'] !== undefined || !isLoopback(peer)) {
      throw new HttpError(404, 'not_found');
    }
    const verdict = poolLink.checkSecret(h['x-games-link']);
    if (verdict === 'not_configured') throw new HttpError(503, 'link_not_configured');
    if (verdict !== 'ok') throw new HttpError(401, 'unauthorised');
    const user = typeof h['x-admin-user'] === 'string' ? h['x-admin-user'].trim() : '';
    if (!ADMIN_USER_RE.test(user)) throw new HttpError(400, 'bad_request', { field: 'admin_user' });
    const rel = ctx.path.slice(PREFIX.length);
    const stepUp = h['x-admin-stepup'] === '1';
    if (requiresStepUp(ctx.method, rel) && !stepUp) throw new HttpError(403, 'step_up_required');
    ctx.admin = { user, stepUp };
  }

  // add('POST', 'events/:id/cancel', handler, opts) — the pattern is relative to /internal/admin/.
  function add(method, rel, handler, opts = {}) {
    router.add(method, PREFIX + rel, handler, { ...opts, guard });
  }

  // One mod_actions row. Inside the caller's transaction when there is one, so an action
  // that rolls back leaves no record of having happened.
  function audit(ctx, action, target, details) {
    let d = details === undefined ? null : JSON.stringify(details);
    if (d !== null && d.length > DETAILS_MAX) d = JSON.stringify({ truncated: true });
    insertAction.run(ctx.admin.user, action, target || null, d, now());
  }

  return { add, audit, requiresStepUp };
}

module.exports = { createAdmin, requiresStepUp, FAST_WRITES, PREFIX };
