'use strict';

// Address-as-identity ownership gate.
//
// The pool has no miner accounts — the grin address IS the identity. For sensitive
// self-service actions (set min_payout, request a slatepack payout) we need a cheap proof
// that the requester actually controls the rig mining under that address, WITHOUT introducing
// passwords/registration. Proof = one of the address's last-2 distinct mining source IPs.
//
// This is an anti-griefing / anti-spam gate, NOT strong authentication: shared NAT / CGNAT /
// mining-farm co-tenants share a public IP and could pass it. That is acceptable because the
// only money-moving action it gates (slatepack payout) is independently protected by the
// slatepack being age-encrypted to the owner's address — a non-owner who passes the gate gets
// an undecryptable blob. min_payout is griefing-only risk.
//
// Source-IP capture lives at the stratum layer. The real miner IP is the socket address for
// direct miners, or the PROXY-protocol v2 header value for miners arriving via a regional
// gateway (Model C) — both resolved in stratum-server before calling recordSourceIp() here.

// Strip the IPv4-mapped-IPv6 prefix Express/Node attaches (e.g. "::ffff:1.2.3.4" → "1.2.3.4").
function normalizeIp(ip) {
  if (!ip) return '';
  return String(ip).replace(/^::ffff:/, '').trim();
}

// In-memory failed-attempt throttle (single-process Central API). Slows IP brute-forcing on top
// of the HTTP rate-limiter. Keyed by grin_address.
const FAIL_WINDOW_MS = 10 * 60 * 1000; // 10 min
const FAIL_MAX = 8;                    // failed proofs allowed per window before a short lockout
const LOCKOUT_MS = 5 * 60 * 1000;      // 5 min lockout once the window is exhausted
const _fails = new Map();              // addr -> { count, first, lockedUntil }

function _throttleState(addr) {
  const now = Date.now();
  let s = _fails.get(addr);
  if (!s || (now - s.first) > FAIL_WINDOW_MS) {
    s = { count: 0, first: now, lockedUntil: 0 };
    _fails.set(addr, s);
  }
  return s;
}

function isLockedOut(addr) {
  const s = _fails.get(addr);
  return !!(s && s.lockedUntil && Date.now() < s.lockedUntil);
}

function _registerFail(addr) {
  const s = _throttleState(addr);
  s.count += 1;
  if (s.count >= FAIL_MAX) s.lockedUntil = Date.now() + LOCKOUT_MS;
}

function _clearFails(addr) {
  _fails.delete(addr);
}

// Record the source IP seen for an address (called on stratum auth and on hub share ingestion).
// Maintains a last-2 distinct-IP window: when the IP changes, shift last_ip → prev_ip. Cheap
// no-op when unchanged. `db` is the sqlite-compat handle. Returns true if a row was updated.
function recordSourceIp(db, grinAddress, rawIp) {
  const ip = normalizeIp(rawIp);
  if (!grinAddress || !ip || ip === 'unknown') return false;
  try {
    const row = db.prepare('SELECT last_ip, prev_ip FROM miner_accounts WHERE grin_address = ?').get(grinAddress);
    if (!row) return false;            // account not created yet — caller ensures existence first
    if (row.last_ip === ip) return false; // unchanged: skip the write
    db.prepare(
      `UPDATE miner_accounts SET prev_ip = ?, last_ip = ?, updated_at = unixepoch() WHERE grin_address = ?`
    ).run(row.last_ip || null, ip, grinAddress);
    return true;
  } catch (e) {
    console.error(`[owner-proof] recordSourceIp failed for ${grinAddress}: ${e.message}`);
    return false;
  }
}

// Verify a submitted IP matches one of the address's last-2 mining IPs. Honours the in-memory
// throttle. Returns { ok, reason }.
function verifyIpProof(db, grinAddress, submittedIp) {
  if (isLockedOut(grinAddress)) {
    return { ok: false, reason: 'too_many_attempts' };
  }
  const ip = normalizeIp(submittedIp);
  if (!ip) return { ok: false, reason: 'ip_required' };

  let row;
  try {
    row = db.prepare('SELECT last_ip, prev_ip FROM miner_accounts WHERE grin_address = ?').get(grinAddress);
  } catch (e) {
    return { ok: false, reason: 'lookup_failed' };
  }
  if (!row) return { ok: false, reason: 'account_not_found' };
  if (!row.last_ip && !row.prev_ip) return { ok: false, reason: 'no_recorded_ip' };

  if (ip === row.last_ip || ip === row.prev_ip) {
    _clearFails(grinAddress);
    return { ok: true, reason: 'match' };
  }
  _registerFail(grinAddress);
  return { ok: false, reason: 'ip_mismatch' };
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
      normalizeIp(ip) || null
    );
  } catch (e) {
    console.error(`[owner-proof] audit write failed: ${e.message}`);
  }
}

module.exports = { normalizeIp, recordSourceIp, verifyIpProof, auditOwnerProof, isLockedOut };
