'use strict';

// In-memory limiters for the games service (design §19.5 step 2). Two shapes:
//
//   createTokenBuckets  — "at most N now, refilling at R per second", per key. The map is
//     bounded by LRU eviction: losing a bucket only grants that key a fresh (full) bucket,
//     which a quiet key would have had anyway, so evicting is safe.
//
//   createFailureBackoff — "after T failures, lock for a while; each further lockout is
//     twice as long". Two traps from the pool's audit (memory reference_express_throttle_traps)
//     shape it:
//       - the record is KEPT when a lockout expires. Deleting it there makes `lockCount`
//         always 1, so the escalation ladder is unreachable. The sweep drops a record only
//         once it is unlocked AND its last failure is older than the memory window.
//       - the map is NEVER trimmed by evicting a live lockout: a memory bound would then be
//         a ban bypass under exactly the flood that fills it. On overflow the oldest UNLOCKED
//         record goes; if every record is a live lockout, the new failure is not recorded
//         (the pool's own per-IP and per-pair throttles, keyed on the real IP, still apply).
//
// Both are per-process and forgotten on restart. That is acceptable here because they sit
// IN FRONT of the pool's throttles, which are the real brute-force stop (§19.2) — these
// exist so a flood is refused before it costs the pool a call.

function createTokenBuckets({ capacity, refillPerSec, maxKeys = 50000, clock = () => Date.now() }) {
  if (!(capacity >= 1) || !(refillPerSec > 0)) throw new Error('token buckets: bad capacity/refill');
  const map = new Map();   // key → { tokens, at }  (insertion order = LRU order)

  function state(key) {
    const t = clock();
    let b = map.get(key);
    if (b) {
      map.delete(key);
      b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / 1000) * refillPerSec);
      b.at = t;
    } else {
      b = { tokens: capacity, at: t };
    }
    map.set(key, b);
    while (map.size > maxKeys) map.delete(map.keys().next().value);
    return b;
  }

  // → { ok, retryAfter } — takes one token when available.
  function take(key) {
    const b = state(key);
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true, retryAfter: 0 }; }
    return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / refillPerSec)) };
  }

  // → { ok, retryAfter } without taking.
  function peek(key) {
    const b = state(key);
    return b.tokens >= 1 ? { ok: true, retryAfter: 0 } : { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / refillPerSec)) };
  }

  return { take, peek, size: () => map.size };
}

function createFailureBackoff({
  threshold, baseLockSec, maxLockSec, memorySec = 24 * 3600, maxKeys = 100000, clock = () => Date.now(),
}) {
  if (!(threshold >= 1) || !(baseLockSec > 0) || !(maxLockSec >= baseLockSec)) throw new Error('failure backoff: bad params');
  const map = new Map();   // key → { count, lockCount, lockedUntil (ms), lastFailAt (ms) }
  const nowMs = () => clock();

  function check(key) {
    const r = map.get(key);
    const t = nowMs();
    if (r && r.lockedUntil > t) return { locked: true, retryAfter: Math.ceil((r.lockedUntil - t) / 1000) };
    return { locked: false, retryAfter: 0 };
  }

  function makeRoom() {
    if (map.size < maxKeys) return true;
    const t = nowMs();
    for (const [k, r] of map) {
      if (!(r.lockedUntil > t)) { map.delete(k); return true; }
    }
    return false;
  }

  // Records one failure. → { locked, retryAfter, lockCount }
  function fail(key) {
    const t = nowMs();
    let r = map.get(key);
    if (!r) {
      if (!makeRoom()) return { locked: false, retryAfter: 0, lockCount: 0, unrecorded: true };
      r = { count: 0, lockCount: 0, lockedUntil: 0, lastFailAt: 0 };
      map.set(key, r);
    }
    r.lastFailAt = t;
    if (r.lockedUntil > t) return { locked: true, retryAfter: Math.ceil((r.lockedUntil - t) / 1000), lockCount: r.lockCount };
    r.count += 1;
    if (r.count >= threshold) {
      r.count = 0;
      r.lockCount += 1;
      const secs = Math.min(maxLockSec, baseLockSec * 2 ** Math.min(r.lockCount - 1, 30));
      r.lockedUntil = t + secs * 1000;
      return { locked: true, retryAfter: secs, lockCount: r.lockCount };
    }
    return { locked: false, retryAfter: 0, lockCount: r.lockCount };
  }

  // A success resets the running count, NOT the escalation: an attacker who succeeds on
  // their own address must not wash the lockout history of an IP they are brute-forcing
  // from. The escalation decays only through the memory window.
  function success(key) {
    const r = map.get(key);
    if (r) r.count = 0;
  }

  function sweep() {
    const t = nowMs();
    let dropped = 0;
    for (const [k, r] of map) {
      if (!(r.lockedUntil > t) && t - r.lastFailAt > memorySec * 1000) { map.delete(k); dropped++; }
    }
    return dropped;
  }

  return { check, fail, success, sweep, size: () => map.size, _peek: (k) => map.get(k) };
}

module.exports = { createTokenBuckets, createFailureBackoff };
