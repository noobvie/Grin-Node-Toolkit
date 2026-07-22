'use strict';

const crypto = require('crypto');
const net = require('net');

// Address-as-identity ownership gate (v2 — IP or password, hashed at rest).
//
// The pool has no miner accounts — the grin address IS the identity. For self-service money
// actions (Tor payout, slatepack create/finalize, cancel) we need a cheap proof that the
// requester actually controls the rig mining under that address, WITHOUT introducing
// registration. Proof = EITHER of:
//   · one of the address's last-2 distinct mining source IPs (IPv4 or IPv6), or
//   · the rig's stratum password (as typed into the miner's Pool1 config).
//
// This is an anti-griefing / anti-spam gate, NOT strong authentication: both payout rails are
// independently theft-proof (Tor pays only to the address's own wallet; a slatepack is
// age-encrypted to the address). The gate exists so a stranger reading the public leaderboard
// cannot trigger payouts for other people's addresses (each one burns a pool-paid network fee,
// consumes a hot-wallet output, and force-moves coins the owner didn't ask to move).
//
// Storage (data minimisation, operator decision 2026-07-17): proofs are stored as salted
// scrypt hashes (`v1$<salt>$<hash>`), never plaintext — the DB holds no raw mining IPs and no
// raw passwords. The legacy plaintext last_ip/prev_ip values from older deploys are upgraded
// in place by migrateOwnerProofHashes() at startup (and verify handles both forms meanwhile).
// Column names last_ip/prev_ip are kept for schema continuity even though they now hold hashes.
//
// Capture lives at the stratum layer, on a session's FIRST ACCEPTED SHARE (not at login —
// login is unauthenticated, so recording there let anyone poison an address's proof window
// with a bare TCP connect; a recorded proof requires actual PoW). The real miner IP is the
// socket address for direct miners, or the PROXY-protocol v2 header value for miners arriving
// via a regional gateway (Model C). Both IP and password keep a last-2 window so an ISP
// re-lease or a rig-side password change never locks the owner out.
//
// Trivial passwords (`x`, `123`, factory defaults…) are never captured and never verify —
// otherwise every rig shipping the same default would share one skeleton key. Those addresses
// simply keep using IP proof.

// ─── IP canonicalisation (IPv4 + IPv6) ──────────────────────────────────────
// One stable text form per address so capture (socket/PROXY value) and verify (user-typed)
// always hash/compare identically: strips brackets/zone-id, lowercases, drops the
// ::ffff: IPv4-mapped prefix, removes leading zeros (IPv4 octets and IPv6 groups), and
// expands `::` so equal IPv6 addresses can't differ by compression style.
function canonicalizeIp(raw) {
  if (!raw) return '';
  let ip = String(raw).trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);

  if (net.isIPv4(ip)) {
    return ip.split('.').map(o => String(parseInt(o, 10))).join('.');
  }
  if (net.isIPv6(ip)) {
    // Fold an embedded IPv4 tail (e.g. ::1.2.3.4, 64:ff9b::1.2.3.4) into two hex groups.
    if (ip.includes('.')) {
      const lastColon = ip.lastIndexOf(':');
      const oct = ip.slice(lastColon + 1).split('.').map(o => parseInt(o, 10));
      ip = ip.slice(0, lastColon + 1) +
        (((oct[0] << 8) | oct[1]) >>> 0).toString(16) + ':' +
        (((oct[2] << 8) | oct[3]) >>> 0).toString(16);
    }
    const parts = ip.split('::');
    const left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
    const right = (parts.length > 1 && parts[1]) ? parts[1].split(':').filter(Boolean) : [];
    const fill = Math.max(8 - left.length - right.length, 0);
    const groups = left.concat(new Array(fill).fill('0'), right);
    return groups.map(g => parseInt(g, 16).toString(16)).join(':');
  }
  return ip; // not an IP — caller treats it as a password candidate
}

// Backwards-compatible name (older call sites normalise req.ip for audit logging).
const normalizeIp = canonicalizeIp;

// ─── Password usability ─────────────────────────────────────────────────────
// A password only counts as proof if it can plausibly be a secret. Factory defaults and
// vardiff-style directives are excluded at BOTH capture and verify time.
const TRIVIAL_PASSWORDS = new Set([
  'x', '123', '1234', '12345', '123456', 'password', 'pass', 'pwd',
  'worker', 'miner', 'default', 'admin', 'test', 'grin', 'asic', 'anything'
]);

// Operator-added banned passwords (admin → Access, access.extra_banned_passwords) —
// additions-only ON TOP of the hardcoded seed above; the seed + structural rules always
// apply so an admin edit can never turn `x` into a valid proof. Cached briefly so the hot
// paths (share capture, gate verify) don't hit pool_config on every call. Because the
// submitted value is re-checked at VERIFY time, adding an entry immediately stops it
// working as proof even for accounts that captured it earlier.
let _extraBanned = { at: 0, set: new Set() };
function extraBannedSet(db) {
  if (!db) return _extraBanned.set;
  const now = Date.now();
  if (now - _extraBanned.at > 60000) {
    let set = new Set();
    try {
      const row = db.prepare(
        "SELECT value FROM pool_config WHERE section = 'access' AND key = 'extra_banned_passwords'"
      ).get();
      if (row && row.value) {
        const arr = JSON.parse(row.value);
        if (Array.isArray(arr)) set = new Set(arr.map((p) => String(p).toLowerCase()));
      }
    } catch (e) { /* missing table/row or corrupt json → seed list only */ }
    _extraBanned = { at: now, set };
  }
  return _extraBanned.set;
}

function isUsablePassword(pass, db) {
  if (typeof pass !== 'string') return false;
  const p = pass.trim();
  if (p.length < 4 || p.length > 128) return false;
  if (TRIVIAL_PASSWORDS.has(p.toLowerCase())) return false;
  if (extraBannedSet(db).has(p.toLowerCase())) return false;
  if (/^d=/i.test(p)) return false; // difficulty-request convention, not a secret
  return true;
}

// ─── Salted scrypt hashing (v1$<saltB64>$<hashB64>) ─────────────────────────
// scrypt (memory-hard, 16 MB) so a leaked DB can't be brute-forced on GPUs — relevant for
// IPv4 proofs (2^32 space) and low-entropy rig passwords. Hashing happens off the hot path:
// once per session (first accepted share) and on user-triggered verifies.
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

function hashProof(value) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(String(value), salt, KEYLEN, SCRYPT_OPTS, (err, dk) => {
      if (err) return reject(err);
      resolve(`v1$${salt.toString('base64')}$${dk.toString('base64')}`);
    });
  });
}

function verifyHashedProof(value, stored) {
  return new Promise((resolve) => {
    if (!stored || typeof stored !== 'string' || !stored.startsWith('v1$')) return resolve(false);
    const parts = stored.split('$');
    if (parts.length !== 3) return resolve(false);
    let salt, expected;
    try {
      salt = Buffer.from(parts[1], 'base64');
      expected = Buffer.from(parts[2], 'base64');
    } catch (e) { return resolve(false); }
    if (expected.length !== KEYLEN) return resolve(false);
    crypto.scrypt(String(value), salt, KEYLEN, SCRYPT_OPTS, (err, dk) => {
      if (err) return resolve(false);
      resolve(crypto.timingSafeEqual(dk, expected));
    });
  });
}

// Does a canonical IP match a stored slot? Handles both hashed (v1$…) and legacy plaintext
// values (pre-migration DBs).
async function matchesStoredIp(canonicalIp, stored) {
  if (!stored) return false;
  if (stored.startsWith('v1$')) return verifyHashedProof(canonicalIp, stored);
  return canonicalizeIp(stored) === canonicalIp;
}

// ─── In-memory failed-attempt throttle ──────────────────────────────────────
// Single-process Central API. Slows proof brute-forcing on top of the HTTP rate-limiter.
//
// TWO independent counters share the same Map, distinguished by key prefix:
//   · per-ADDRESS (bare grin address) — bounds guesses against ONE address. FAIL_MAX = 8.
//   · per-IP (`ip:<canonical>`) — bounds TOTAL failed guesses from one source IP across ALL
//     addresses. Without it, an attacker walking the public leaderboard gets a fresh 8-guess
//     budget per address (and each guess forces a 16 MB scrypt — a CPU/mem-exhaustion lever).
//     FAIL_MAX_IP is looser (a NAT/farm may host several miners that each fumble their proof)
//     but still caps a distributed sweep from one origin. A single-address user hits their
//     address lock (8) long before the IP lock, so this adds no false-positive for normal use.
const FAIL_WINDOW_MS = 10 * 60 * 1000; // 10 min
const FAIL_MAX = 8;                    // failed proofs per window per ADDRESS before lockout
const FAIL_MAX_IP = 20;                // failed proofs per window per source IP before lockout
const LOCKOUT_MS = 5 * 60 * 1000;      // 5 min lockout once a window is exhausted
const _fails = new Map();              // key -> { count, first, lockedUntil }  (key = addr | `ip:<ip>`)

function _throttleState(key) {
  const now = Date.now();
  let s = _fails.get(key);
  if (!s || (now - s.first) > FAIL_WINDOW_MS) {
    s = { count: 0, first: now, lockedUntil: 0 };
    _fails.set(key, s);
  }
  return s;
}

function isLockedOut(key) {
  const s = _fails.get(key);
  return !!(s && s.lockedUntil && Date.now() < s.lockedUntil);
}

function _registerFail(key, max) {
  const s = _throttleState(key);
  s.count += 1;
  if (s.count >= max) s.lockedUntil = Date.now() + LOCKOUT_MS;
}

function _clearFails(key) {
  _fails.delete(key);
}

// ─── Evidence capture (called on a session's first accepted share) ──────────
// Records BOTH proofs for an address: source IP (always, when valid) and stratum password
// (only when usable). Each keeps a last-2 distinct window: on change, last → prev. Async
// (scrypt) — the stratum caller fires and forgets. Returns true if anything was written.
async function recordOwnerEvidence(db, grinAddress, rawIp, rawPass) {
  if (!grinAddress) return false;
  try {
    const row = db.prepare(
      'SELECT last_ip, prev_ip, last_pass_hash, prev_pass_hash FROM miner_accounts WHERE grin_address = ?'
    ).get(grinAddress);
    if (!row) return false; // account not created yet — caller ensures existence first

    const sets = [];
    const vals = [];

    const ip = canonicalizeIp(rawIp);
    if (ip && ip !== 'unknown' && net.isIP(ip)) {
      if (!(await matchesStoredIp(ip, row.last_ip))) {
        sets.push('prev_ip = ?', 'last_ip = ?');
        vals.push(row.last_ip || null, await hashProof(ip));
      }
    }

    const pass = typeof rawPass === 'string' ? rawPass.trim() : '';
    if (isUsablePassword(pass, db)) {
      if (!(await verifyHashedProof(pass, row.last_pass_hash))) {
        sets.push('prev_pass_hash = ?', 'last_pass_hash = ?');
        vals.push(row.last_pass_hash || null, await hashProof(pass));
      }
    }

    if (sets.length === 0) return false; // both unchanged: skip the write
    db.prepare(
      `UPDATE miner_accounts SET ${sets.join(', ')}, updated_at = unixepoch() WHERE grin_address = ?`
    ).run(...vals, grinAddress);
    return true;
  } catch (e) {
    console.error(`[owner-proof] recordOwnerEvidence failed for ${grinAddress}: ${e.message}`);
    return false;
  }
}

// ─── Verify (one field: IP or password) ─────────────────────────────────────
// The account page has a single proof input. If it parses as an IP, try the IP window; a
// usable-password-shaped value is also tried against the password window (both paths run when
// applicable, so a password that happens to look odd still gets its chance). Honours BOTH the
// per-address and (when clientIp is supplied) the per-IP throttle. Returns { ok, reason, method? }.
// clientIp is optional — omitting it preserves the original address-only behaviour, so any caller
// that doesn't have a request IP handy is unaffected.
async function verifyOwnerProof(db, grinAddress, submitted, clientIp) {
  const ipKey = clientIp ? `ip:${canonicalizeIp(clientIp)}` : null;
  if (isLockedOut(grinAddress) || (ipKey && isLockedOut(ipKey))) {
    return { ok: false, reason: 'too_many_attempts' };
  }
  const raw = typeof submitted === 'string' ? submitted.trim() : '';
  if (!raw) return { ok: false, reason: 'proof_required' };

  let row;
  try {
    row = db.prepare(
      'SELECT last_ip, prev_ip, last_pass_hash, prev_pass_hash FROM miner_accounts WHERE grin_address = ?'
    ).get(grinAddress);
  } catch (e) {
    return { ok: false, reason: 'lookup_failed' };
  }
  if (!row) return { ok: false, reason: 'account_not_found' };
  if (!row.last_ip && !row.prev_ip && !row.last_pass_hash && !row.prev_pass_hash) {
    return { ok: false, reason: 'no_recorded_proof' };
  }

  const clearBoth = () => { _clearFails(grinAddress); if (ipKey) _clearFails(ipKey); };
  const failBoth = () => { _registerFail(grinAddress, FAIL_MAX); if (ipKey) _registerFail(ipKey, FAIL_MAX_IP); };

  const ip = canonicalizeIp(raw);
  if (net.isIP(ip)) {
    if (await matchesStoredIp(ip, row.last_ip) || await matchesStoredIp(ip, row.prev_ip)) {
      clearBoth();
      return { ok: true, reason: 'match', method: 'ip' };
    }
  }
  if (isUsablePassword(raw, db)) {
    if (await verifyHashedProof(raw, row.last_pass_hash) || await verifyHashedProof(raw, row.prev_pass_hash)) {
      clearBoth();
      return { ok: true, reason: 'match', method: 'password' };
    }
  } else if (!net.isIP(ip)) {
    // Not an IP and too trivial to ever be captured — tell the miner why it can never work.
    failBoth();
    return { ok: false, reason: 'trivial_password' };
  }

  failBoth();
  return { ok: false, reason: 'no_match' };
}

// ─── One-time startup migration: plaintext last_ip/prev_ip → v1$ hashes ─────
// Runs in the background (async scrypt, sequential) so startup isn't blocked; verify accepts
// both forms while it runs. Idempotent: hashed values are skipped by the WHERE clause.
async function migrateOwnerProofHashes(db) {
  try {
    const rows = db.prepare(
      `SELECT grin_address, last_ip, prev_ip FROM miner_accounts
       WHERE (last_ip IS NOT NULL AND last_ip NOT LIKE 'v1$%')
          OR (prev_ip IS NOT NULL AND prev_ip NOT LIKE 'v1$%')`
    ).all();
    for (const r of rows) {
      const li = (r.last_ip && !r.last_ip.startsWith('v1$'))
        ? await hashProof(canonicalizeIp(r.last_ip)) : r.last_ip;
      const pi = (r.prev_ip && !r.prev_ip.startsWith('v1$'))
        ? await hashProof(canonicalizeIp(r.prev_ip)) : r.prev_ip;
      db.prepare(
        'UPDATE miner_accounts SET last_ip = ?, prev_ip = ?, updated_at = unixepoch() WHERE grin_address = ?'
      ).run(li, pi, r.grin_address);
    }
    if (rows.length > 0) {
      console.log(`[owner-proof] migrated ${rows.length} account(s) from plaintext IPs to salted hashes`);
    }
  } catch (e) {
    console.error(`[owner-proof] hash migration failed: ${e.message}`);
  }
}

// Audit an ownership-gated attempt to admin_audit_log (admin_id NULL — actor is a miner address,
// not an admin user). Best-effort; never throws into the request path.
function auditOwnerProof(db, { action, grinAddress, ip, ok, details }) {
  try {
    db.prepare(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
       VALUES (NULL, ?, 'miner', ?, ?, ?)`
    ).run(
      `owner_proof:${action}:${ok ? 'ok' : 'deny'}`,
      grinAddress || null,
      JSON.stringify(details || {}),
      canonicalizeIp(ip) || null
    );
  } catch (e) {
    console.error(`[owner-proof] audit write failed: ${e.message}`);
  }
}

module.exports = {
  canonicalizeIp,
  normalizeIp,
  isUsablePassword,
  recordOwnerEvidence,
  verifyOwnerProof,
  migrateOwnerProofHashes,
  auditOwnerProof,
  isLockedOut
};
