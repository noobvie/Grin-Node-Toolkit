'use strict';

// Games → pool client for the three internal routes (design §19.3). The pool side is
// back-end-pool/lib/games-link.js — read it for the exact shapes; nothing is imported from
// it (the services deploy separately).
//
//   verifyProof(address, proof, clientIp)  POST /internal/games/verify-proof
//   activity(from, to)                     GET  /internal/games/activity
//   config()                               GET  /internal/games/config
//
// Rules the pool side depends on (§19.15 Part 2):
//   - Direct to the pool's loopback listener (config.poolInternalUrl), never via nginx.
//   - NO X-Forwarded-For and NO X-Real-IP header. The pool answers 404 to either, before
//     it looks at the secret: a forwarding header means "this came through a proxy".
//   - The link secret file is trimmed (a trailing newline is not part of it), must be
//     32 B–4 KB, and is re-stat'ed at most once a second, re-read when its mtime or size
//     changes — so a rotation (temp file + mv, §19.3) is picked up without a restart.
//   - A proof RESULT is HTTP 200 either way ({ok:true,…} or {ok:false, reason}); a failed
//     CALL carries `error`. This module turns the second kind into a PoolLinkError, so a
//     caller can always tell "the proof failed" from "the call failed".
//
// Never log or echo the secret or a proof: errors carry codes, never values.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');

const TIMEOUT_MS = 2000;
const RESPONSE_MAX = 1024 * 1024;
const LINK_MIN_BYTES = 32;
const LINK_MAX_BYTES = 4096;
const STAT_MEMO_MS = 1000;
const GRIN_ADDR_RE = /^t?grin1[ac-hj-np-z02-9]{58}$/;
const MODES = ['off', 'preview', 'on'];
// names.blocked_words as the pool sends it: matching forms, an optional * / = prefix (§19.17.5).
const BLOCKED_MAX = 500;
const BLOCKED_ENTRY_RE = /^[*=]?[a-z0-9]{1,32}$/;
const POOL_NAME_MAX = 64;

// Codes:
//   link_not_configured  our secret file is missing/short, or the pool says the same of its own
//   link_down            no answer: refused, reset, timed out
//   link_unauthorised    the pool refused the secret (a rotation in flight gets one of these)
//   link_rejected        the pool refused the request shape (400) — a bug on this side; `field` says which
//   pool_error           any other non-200 (500, 503 settings_unavailable, …)
//   bad_response         an answer that is not the documented shape
//   not_pool_address     the CALLER passed something that is not a pool address — a guest id
//                        ('g:…', §19.17.3) above all. Refused before anything is sent: a guest
//                        never reaches the pool (D32, §19.13 #29). A bug on this side, never input.
class PoolLinkError extends Error {
  constructor(code, extra) {
    super(code);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

function createPoolLink({ config: cfg, clock = () => Date.now(), timeoutMs = TIMEOUT_MS }) {
  const u = new URL(cfg.poolInternalUrl);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port);
  const expectPrefix = cfg.net === 'mainnet' ? 'grin1' : 'tgrin1';
  let memo = { at: -Infinity, mtimeMs: -1, size: -1, value: null };

  function secret() {
    const t = clock();
    if (t - memo.at < STAT_MEMO_MS) return memo.value;
    memo.at = t;
    let st;
    try { st = fs.statSync(cfg.linkSecretFile); } catch { memo.value = null; memo.mtimeMs = -1; memo.size = -1; return null; }
    if (st.mtimeMs === memo.mtimeMs && st.size === memo.size) return memo.value;
    memo.mtimeMs = st.mtimeMs;
    memo.size = st.size;
    memo.value = null;
    if (!st.isFile() || st.size > LINK_MAX_BYTES) return null;
    let v;
    try { v = fs.readFileSync(cfg.linkSecretFile, 'utf8').trim(); } catch { return null; }
    memo.value = Buffer.byteLength(v, 'utf8') >= LINK_MIN_BYTES ? v : null;
    return memo.value;
  }

  // → Promise<{ status, json }>. Rejects only with a PoolLinkError.
  function call(method, path, body) {
    const s = secret();
    if (!s) return Promise.reject(new PoolLinkError('link_not_configured'));
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Accept: 'application/json', 'X-Games-Link': s };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let req;
      const done = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(hard);
        if (err) reject(err); else resolve(value);
      };
      // http.request's `timeout` is an IDLE timeout; this bounds the whole exchange.
      const hard = setTimeout(() => { if (req) req.destroy(); done(new PoolLinkError('link_down', { why: 'timeout' })); }, timeoutMs);
      hard.unref();
      try {
        req = http.request({ host, port, method, path, headers, agent: false }, (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size > RESPONSE_MAX) { req.destroy(); done(new PoolLinkError('bad_response', { why: 'too_large' })); return; }
            chunks.push(c);
          });
          res.on('error', () => done(new PoolLinkError('link_down', { why: 'reset' })));
          res.on('end', () => {
            let json = null;
            try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
            done(null, { status: res.statusCode, json });
          });
        });
        req.on('error', (e) => done(new PoolLinkError('link_down', { why: e && e.code ? String(e.code) : 'error' })));
        req.end(payload || undefined);
      } catch {
        done(new PoolLinkError('link_down', { why: 'request' }));
      }
    });
  }

  // Non-200 → the matching PoolLinkError. A 200 whose body is not an object → bad_response.
  function expectOk({ status, json }) {
    const obj = json !== null && typeof json === 'object' && !Array.isArray(json) ? json : null;
    if (status === 200) {
      if (!obj) throw new PoolLinkError('bad_response', { why: 'not_json' });
      return obj;
    }
    const err = obj && typeof obj.error === 'string' ? obj.error : null;
    if (status === 401) throw new PoolLinkError('link_unauthorised');
    if (status === 503 && err === 'link_not_configured') throw new PoolLinkError('link_not_configured', { side: 'pool' });
    if (status === 400) {
      const field = obj && typeof obj.field === 'string' && /^[a-z_]{1,32}$/.test(obj.field) ? obj.field : null;
      throw new PoolLinkError('link_rejected', { field });
    }
    // 404 from the pool means it saw a forwarding header or no such route: either way the
    // link is misconfigured, not the proof.
    throw new PoolLinkError('pool_error', { status: Number.isInteger(status) ? status : 0 });
  }

  // → { ok:true, method, slot, age_seconds } | { ok:false, reason }
  async function verifyProof(address, proof, clientIp) {
    if (typeof address !== 'string' || !GRIN_ADDR_RE.test(address) || !address.startsWith(expectPrefix)) {
      throw new PoolLinkError('not_pool_address');
    }
    const obj = expectOk(await call('POST', '/internal/games/verify-proof', { address, proof, client_ip: clientIp }));
    if (obj.ok === true) {
      if (obj.method !== 'ip' && obj.method !== 'password') throw new PoolLinkError('bad_response', { why: 'method' });
      if (obj.slot !== 'set' && obj.slot !== 'anchor') throw new PoolLinkError('bad_response', { why: 'slot' });
      const age = obj.age_seconds;
      if (age !== null && !(Number.isSafeInteger(age) && age >= 0)) throw new PoolLinkError('bad_response', { why: 'age' });
      return { ok: true, method: obj.method, slot: obj.slot, age_seconds: age };
    }
    if (obj.ok === false && typeof obj.reason === 'string' && /^[a-z_]{1,40}$/.test(obj.reason)) {
      return { ok: false, reason: obj.reason };
    }
    throw new PoolLinkError('bad_response', { why: 'verify_shape' });
  }

  // → { from, to, rows:[{ address, seconds, minutes }] }. Rows the pool should never send
  // (a malformed address, the other network's prefix, a negative count) are dropped and
  // counted in `dropped`, not credited.
  async function activity(from, to) {
    const q = `from=${encodeURIComponent(String(from))}&to=${encodeURIComponent(String(to))}`;
    const obj = expectOk(await call('GET', `/internal/games/activity?${q}`));
    if (obj.ok !== true || obj.from !== from || obj.to !== to || !Array.isArray(obj.rows)) {
      throw new PoolLinkError('bad_response', { why: 'activity_shape' });
    }
    const rows = [];
    let dropped = 0;
    const seen = new Set();
    for (const r of obj.rows) {
      const good = r && typeof r === 'object'
        && typeof r.address === 'string' && GRIN_ADDR_RE.test(r.address) && r.address.startsWith(expectPrefix)
        && Number.isSafeInteger(r.seconds) && r.seconds >= 0
        && Number.isSafeInteger(r.minutes) && r.minutes >= 0
        && !seen.has(r.address);
      if (!good) { dropped++; continue; }
      seen.add(r.address);
      rows.push({ address: r.address, seconds: r.seconds, minutes: r.minutes });
    }
    return { from, to, rows, dropped };
  }

  // → { mode, chat_enabled, blocked_words?, pool_name? }. A pool answering for the OTHER
  // network is not our pool. The two name fields (§19.17.5, C3) are optional: a pool built
  // before C3 sends neither, and a malformed one is DROPPED (the caller keeps its last copy)
  // rather than failing the fetch — the mode must never go stale over a word list.
  async function config() {
    const obj = expectOk(await call('GET', '/internal/games/config'));
    if (obj.ok !== true || !MODES.includes(obj.mode) || typeof obj.chat_enabled !== 'boolean') {
      throw new PoolLinkError('bad_response', { why: 'config_shape' });
    }
    if (obj.net !== cfg.net) throw new PoolLinkError('bad_response', { why: 'wrong_network' });
    const out = { mode: obj.mode, chat_enabled: obj.chat_enabled };
    if (Array.isArray(obj.blocked_words) && obj.blocked_words.length <= BLOCKED_MAX) {
      out.blocked_words = obj.blocked_words.filter((w) => typeof w === 'string' && BLOCKED_ENTRY_RE.test(w));
    }
    if (typeof obj.pool_name === 'string' && obj.pool_name.length <= POOL_NAME_MAX) out.pool_name = obj.pool_name;
    return out;
  }

  // The pool → games direction (the admin proxy, §19.3) is authenticated with the SAME file.
  // → 'ok' | 'wrong' | 'not_configured'. The secret never leaves this module: callers get a
  // verdict, not the value. A missing header and a wrong one are the same answer, and the
  // length-mismatch path does the same work as a compare.
  function checkSecret(given) {
    const s = secret();
    if (!s) return 'not_configured';
    if (typeof given !== 'string' || given === '') return 'wrong';
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(s, 'utf8');
    if (a.length !== b.length) { crypto.timingSafeEqual(b, b); return 'wrong'; }
    return crypto.timingSafeEqual(a, b) ? 'ok' : 'wrong';
  }

  return { verifyProof, activity, config, checkSecret, secretConfigured: () => secret() !== null };
}

// A client IP the pool will refuse (loopback / unspecified): if one reaches login, nginx's
// X-Real-IP plumbing is broken and every player would share one throttle bucket (D7).
function isUnusableClientIp(ip) {
  const s = String(ip || '').toLowerCase();
  if (!net.isIP(s)) return true;
  if (s === '::1' || s === '::' || s === '0.0.0.0') return true;
  return net.isIPv4(s) && s.startsWith('127.');
}

module.exports = { createPoolLink, PoolLinkError, isUnusableClientIp, GRIN_ADDR_RE };
