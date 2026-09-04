'use strict';

const crypto = require('crypto');
const net = require('net');
const geoip = require('./geoip');

// Address-as-identity ownership gate (v2 — IP or password, hashed at rest).
//
// The pool has no miner accounts — the grin address IS the identity. For self-service money
// actions we need a cheap proof that the
// requester actually controls the rig mining under that address, WITHOUT introducing
// registration. It gates every self-service money action — Tor payout, slatepack create and
// finalize, and the Goblin/Nostr destination register/remove (which demands BOTH proofs, see
// index.js requireBothProofs). Proof = EITHER of:
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
// ⚠ PoW is a COST, not an identity. Anyone may mine to anyone's address, so "requires an
// accepted share" narrows who can write to a proof window — it does not restrict it to the
// owner. The 2026-08-26 audit (§J3) found three consequences and the three answers now in
// this file; none of them should be removed without re-reading that section:
//   · §J3-1 — both legs are written by ONE call on ONE share, so the AND-gate on the Goblin
//     destination was never two factors. verifyOwnerProof therefore reports WHICH slot matched
//     and HOW OLD it is, and index.js requireBothProofs refuses a leg younger than the
//     destination cooldown. Age is the only thing that separates the owner from a stranger who
//     mined here for ten seconds.
//   · §J3-4 — two hostile sessions evicted both window slots, permanently for a miner who had
//     stopped mining. Hence the write-once ANCHOR slot (below), plus a caller-supplied
//     mayDisplace flag so rotation costs sustained work while first capture stays cheap.
//   · §J3-3 — the failed-attempt lockout was address-keyed, so a stranger's failures locked the
//     owner out of their own money. Denial is now keyed to the (address, origin) pair.
//
// The ANCHOR is the address's first-ever proof of each kind. It is never rotated, so a miner
// always retains a route to their own wallet; and it is deliberately REFUSED by
// requireBothProofs, because an unrevocable credential must not be able to change where money
// goes — only to move money to the address's own wallet. Pre-existing accounts are anchored to
// the value they already hold by backfillProofAnchors() at startup, which must run before the
// stratum listener accepts a share.
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

// ─── Network-prefix coarsening (for the audit log) ──────────────────────────
// The proof windows above store scrypt hashes, so the DB holds no raw mining IP — but the
// audit trail used to write the requester's FULL IP next to the grin address, re-creating
// exactly the (address, IP, time) linkage the hashing removed, and with no expiry.
//
// Hashing the audit IP too would destroy the log's purpose: incident response needs
// "group these events by origin", and a per-row salted hash makes every row unlinkable
// (a shared salt would just be a reversible 2^32 lookup for IPv4 — see network_peers).
// So coarsen instead: keep the routing prefix, drop the host part.
//   IPv4 → /24   (the ISP/NAT block; ~256 hosts)
//   IPv6 → /48   (the standard end-site allocation — /64 is often ONE subscriber, so it
//                 identifies a household about as well as the full address does)
// Abuse patterns (a sweep from one block, a farm fumbling proofs) stay visible; pinning
// the event to one subscriber line does not. Returns null for anything that isn't an IP,
// so a malformed value is stored as NULL rather than as opaque junk.
function coarsenIp(raw) {
  const ip = canonicalizeIp(raw);
  if (!ip) return null;
  if (net.isIPv4(ip)) {
    return ip.split('.').slice(0, 3).join('.') + '.0/24';
  }
  if (net.isIPv6(ip)) {
    // canonicalizeIp already expanded `::`, so there are always 8 groups here.
    return ip.split(':').slice(0, 3).join(':') + '::/48';
  }
  return null;
}

// ─── Password usability ─────────────────────────────────────────────────────
// A password only counts as proof if it can plausibly be a secret. Factory defaults and
// vardiff-style directives are excluded at BOTH capture and verify time.
const TRIVIAL_PASSWORDS = new Set([
  'x', '123', '1234', '12345', '123456', '12345678', 'password', 'password1',
  'pass', 'pwd', 'qwerty', 'abc123', 'letmein', 'root', 'user',
  'worker', 'miner', 'mining', 'default', 'admin', 'admin123', 'test', 'grin',
  'grinpool', 'pool', 'solo', 'stratum', 'asic', 'anything',
  // Per-vendor factory defaults seen in the wild (add more via admin → Access).
  'ipollo', 'antminer', 'bitmain', 'innosilicon', 'goldshell', 'obelisk'
]);

// Single repeated character (`xxxx`, `0000`, `aaaa`, `1111`, …) is THE most common ASIC
// firmware default — `x` padded to satisfy a "min length" field. The seed list can't
// enumerate every length, so this is a structural rule instead.
const REPEATED_CHAR_RE = /^(.)\1*$/;

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

// Min 8: this is a withdrawal credential, and a 4-char secret is grindable offline if the DB
// ever leaks (scrypt makes that expensive, not safe). Max 128 only bounds the input to the
// 16 MB KDF below — never lower it, a short ceiling just caps entropy for no benefit.
const PASS_MIN = 8;
const PASS_MAX = 128;

// WHY a password can't serve as proof — null when it is usable. Single source of truth for
// both the boolean gate and the reason surfaced to the miner: telling someone their 130-char
// password is "too common" (the old catch-all) leaves them no way to work out the real problem.
function passwordRejectReason(pass, db) {
  if (typeof pass !== 'string') return 'password_invalid';
  const p = pass.trim();
  if (p.length < PASS_MIN) return 'password_too_short';
  if (p.length > PASS_MAX) return 'password_too_long';
  if (TRIVIAL_PASSWORDS.has(p.toLowerCase())) return 'trivial_password';
  if (REPEATED_CHAR_RE.test(p)) return 'trivial_password';
  if (extraBannedSet(db).has(p.toLowerCase())) return 'trivial_password';
  if (/^d=/i.test(p)) return 'trivial_password'; // difficulty-request convention, not a secret
  return null;
}

function isUsablePassword(pass, db) {
  return passwordRejectReason(pass, db) === null;
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
// THREE counters share one Map, distinguished by key shape. Only two of them can REFUSE:
//   · per-PAIR (`<addr>|<canonical ip>`) — bounds guesses against one address from one
//     origin. FAIL_MAX_PAIR = 8. This is the lock that actually stops brute force, and it is
//     the only address-scoped one that denies.
//   · per-IP (`ip:<canonical>`) — bounds TOTAL failed guesses from one source IP across ALL
//     addresses. Without it, an attacker walking the public leaderboard gets a fresh budget
//     per address (and each guess forces a 16 MB scrypt — a CPU/mem-exhaustion lever).
//   · per-ADDRESS (bare grin address) — counts only. Never denies. See below.
//
// WHY THE ADDRESS COUNTER NO LONGER DENIES (audit §J3-3). It used to, and that made the
// anti-brute-force lock a griefing weapon aimed at the very people it protects: the eight
// failures that armed it did not have to come from the person being locked out, so ~9
// requests per 10-minute window from ONE address — under every rate bucket, from a target
// list read straight off the public leaderboard — permanently denied a miner access to their
// own balance, with no miner-facing appeal (the public cancel was removed in §E.1). Denial
// is now keyed to the (address, origin) pair, so a stranger's failures can never refuse the
// owner's attempt.
//
// The trade, stated so it is not rediscovered as a regression: an attacker with N source IPs
// now gets 8 guesses per IP against one address instead of 8 in total. The per-IP cap of 20
// still bounds each origin, so a dictionary run needs roughly one fresh IP per 20 guesses —
// a real botnet — and what it buys is griefing, not theft (Tor pays the address's own onion,
// a slatepack is encrypted to it, and the one rail that can redirect money now demands two
// aged legs, §J3-1). Certain harm to every miner was the worse side of that trade.
//
// The address counter is kept because "many origins failing on one address" is exactly the
// signal an operator wants. Over the threshold it (a) makes every attempt on that address pay
// ATTACK_DELAY_MS and (b) is surfaced by underAttack() for alerting. A delay does not cap a
// parallel attacker's throughput and is not pretended to — it costs the real owner one slow
// page-load and takes the cheapest sequential scripting off the table.
const FAIL_WINDOW_MS = 10 * 60 * 1000; // 10 min
const FAIL_MAX_PAIR = 8;               // failed proofs per window per (address, source IP)
const FAIL_MAX_IP = 20;                // failed proofs per window per source IP, all addresses
const ADDR_ALERT_MAX = 8;              // failed proofs per window per address → under-attack mode
const LOCKOUT_MS = 5 * 60 * 1000;      // 5 min lockout once a window is exhausted
const ATTACK_DELAY_MS = 2000;          // per-attempt delay while an address is under attack
const _fails = new Map();              // key -> { count, first, lockedUntil }

// Bounded, self-sweeping (audit §J3-6). Entries used to be created on every failure and
// removed ONLY by a later success, with no expiry pass and no ceiling — so every key an
// attacker touched once and abandoned stayed for the life of the process. Sweeping happens
// opportunistically on write rather than on a timer: this module is required by one-shot
// scripts and test harnesses, and a module-level setInterval would keep those processes alive.
const FAILS_SWEEP_MS = 60 * 1000;      // at most one sweep per minute
const FAILS_MAX_KEYS = 20000;          // hard ceiling; oldest UNLOCKED entries evicted first
let _failsSweptAt = 0;

function _sweepFails(force) {
  const now = Date.now();
  if (!force && (now - _failsSweptAt) < FAILS_SWEEP_MS && _fails.size < FAILS_MAX_KEYS) return;
  _failsSweptAt = now;
  for (const [k, s] of _fails) {
    const expired = (now - s.first) > FAIL_WINDOW_MS;
    const unlocked = !s.lockedUntil || now >= s.lockedUntil;
    if (expired && unlocked) _fails.delete(k);
  }
  // Still over the ceiling → evict oldest-inserted entries, but NEVER one that is currently
  // locked out: eviction would otherwise be the throttle bypass.
  if (_fails.size > FAILS_MAX_KEYS) {
    for (const [k, s] of _fails) {
      if (_fails.size <= FAILS_MAX_KEYS) break;
      if (!s.lockedUntil || now >= s.lockedUntil) _fails.delete(k);
    }
  }
}

function _throttleState(key) {
  const now = Date.now();
  let s = _fails.get(key);
  if (!s || (now - s.first) > FAIL_WINDOW_MS) {
    s = { count: 0, first: now, lockedUntil: 0 };
    _sweepFails(false);
    _fails.set(key, s);
  }
  return s;
}

function isLockedOut(key) {
  const s = _fails.get(key);
  return !!(s && s.lockedUntil && Date.now() < s.lockedUntil);
}

// Is this address seeing failures from enough origins to look like a targeted campaign?
// Never refuses anything — read by verifyOwnerProof (to add a delay) and by callers that
// want to alert. Exported so AlertMonitor can surface it without duplicating the threshold.
function underAttack(grinAddress) {
  const s = _fails.get(grinAddress);
  if (!s) return false;
  if ((Date.now() - s.first) > FAIL_WINDOW_MS) return false;
  return s.count >= ADDR_ALERT_MAX;
}

function _registerFail(key, max) {
  const s = _throttleState(key);
  s.count += 1;
  if (max && s.count >= max) s.lockedUntil = Date.now() + LOCKOUT_MS;
}

function _clearFails(key) {
  _fails.delete(key);
}

// The under-attack delay is bounded so it cannot become its own resource lever: an attacker
// who puts many addresses into that mode would otherwise have every honest request park a
// pending handler. Over the ceiling the delay is SKIPPED rather than converted into a refusal
// — refusing is precisely the §J3-3 behaviour being removed, and a slow gate that fails open
// to "not slow" is better than a fast one that fails closed on the owner.
const ATTACK_DELAY_MAX_INFLIGHT = 64;
let _delayInflight = 0;
async function _attackDelay() {
  if (_delayInflight >= ATTACK_DELAY_MAX_INFLIGHT) return;
  _delayInflight += 1;
  try {
    await new Promise((r) => setTimeout(r, ATTACK_DELAY_MS));
  } finally {
    _delayInflight -= 1;
  }
}

// ─── Evidence capture (called on a session's first accepted share) ──────────
// Records BOTH proofs for an address: source IP (always, when valid) and stratum password
// (only when usable). Each keeps a last-2 distinct window: on change, last → prev. Async
// (scrypt) — the stratum caller fires and forgets. Returns true if anything was written.
async function recordOwnerEvidence(db, grinAddress, rawIp, rawPass, opts) {
  // mayDisplace=false → write into EMPTY slots only. The caller (stratum-server) sets it from
  // how much accepted work this session has done, so one share can establish a proof for an
  // address that has none but cannot push out a proof somebody else's rig recorded (§J3-4).
  // Defaults true so existing callers and tests keep the original behaviour.
  const mayDisplace = !(opts && opts.mayDisplace === false);
  if (!grinAddress) return false;
  try {
    const row = db.prepare(
      `SELECT last_ip, prev_ip, last_pass_hash, prev_pass_hash, pass_proof_state,
              last_ip_at, last_pass_at, anchor_ip, anchor_pass_hash, anchor_set_at
       FROM miner_accounts WHERE grin_address = ?`
    ).get(grinAddress);
    if (!row) return false; // account not created yet — caller ensures existence first

    const sets = [];
    const vals = [];
    const now = Math.floor(Date.now() / 1000);
    let displaced = null;        // which windows this capture pushed an existing value out of
    let anchorStamped = false;   // `row` is a snapshot, so both branches would re-add the stamp

    const ip = canonicalizeIp(rawIp);
    if (ip && ip !== 'unknown' && net.isIP(ip)) {
      if (!(await matchesStoredIp(ip, row.last_ip)) && (mayDisplace || !row.last_ip)) {
        const h = await hashProof(ip);
        // Timestamps travel with the value (§J3-1): the AND-gate judges a leg by the age of
        // the slot that matched, so a rotation must carry last_ip_at down to prev_ip_at
        // rather than leaving prev's age describing a value that has moved on.
        sets.push('prev_ip = ?', 'prev_ip_at = ?', 'last_ip = ?', 'last_ip_at = ?');
        vals.push(row.last_ip || null, row.last_ip_at || null, h, now);
        if (row.last_ip) displaced = displaced ? 'ip+password' : 'ip';
        // Write-once anchor (§J3-4). Set only on a true first capture; accounts that already
        // held a value are anchored to it by backfillProofAnchors() at startup, so a hostile
        // session can never become the anchor of an established address.
        if (!row.anchor_ip && !row.last_ip) {
          sets.push('anchor_ip = ?', 'anchor_set_at = ?');
          vals.push(h, now);
          anchorStamped = true;
        }
      }
    }

    const pass = typeof rawPass === 'string' ? rawPass.trim() : '';
    // Diagnostic state for THIS login's password — persisted so the account page can tell the
    // miner why their password isn't working, instead of them finding out on withdrawal day.
    // 'none' (rig sent nothing) is deliberately distinct from a reject code: "you set no
    // password" and "your password was refused" need different fixes.
    const passState = pass ? (passwordRejectReason(pass, db) || 'ok') : 'none';
    if (passState !== row.pass_proof_state) {
      sets.push('pass_proof_state = ?');
      vals.push(passState);
    }

    if (isUsablePassword(pass, db)) {
      if (!(await verifyHashedProof(pass, row.last_pass_hash)) && (mayDisplace || !row.last_pass_hash)) {
        const h = await hashProof(pass);
        sets.push('prev_pass_hash = ?', 'prev_pass_at = ?', 'last_pass_hash = ?', 'last_pass_at = ?');
        vals.push(row.last_pass_hash || null, row.last_pass_at || null, h, now);
        if (row.last_pass_hash) displaced = displaced ? 'ip+password' : 'password';
        if (!row.anchor_pass_hash && !row.last_pass_hash) {
          sets.push('anchor_pass_hash = ?');
          vals.push(h);
          if (!anchorStamped && !row.anchor_set_at) { sets.push('anchor_set_at = ?'); vals.push(now); anchorStamped = true; }
        }
      }
    } else if (pass) {
      // Also log the REASON (never the value) so the operator can answer "why won't my
      // password work?" from the service log without asking the miner to reveal it.
      console.warn(`[owner-proof] password not captured for ${grinAddress}: ${passState}`);
    }

    if (sets.length === 0) return false; // both unchanged: skip the write
    db.prepare(
      `UPDATE miner_accounts SET ${sets.join(', ')}, updated_at = unixepoch() WHERE grin_address = ?`
    ).run(...vals, grinAddress);

    // A capture that DISPLACES an existing value is the one event a miner would want to know
    // about — it is what a hostile session looks like from the inside (§J3-4), and until now
    // it happened in complete silence. Audited, never blocking; the account page reads the
    // resulting last_ip_at/last_pass_at to show "ownership evidence last changed on …".
    if (displaced) {
      auditOwnerProof(db, {
        action: 'evidence_displaced', grinAddress, ip: rawIp, ok: true,
        details: { window: displaced, anchor_intact: !!(row.anchor_ip || row.anchor_pass_hash) }
      });
    }
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
async function verifyOwnerProof(db, grinAddress, submitted, clientIp, opts) {
  const allowAnchor = !(opts && opts.allowAnchor === false);
  const cip = clientIp ? canonicalizeIp(clientIp) : null;
  const ipKey = cip ? `ip:${cip}` : null;
  const pairKey = cip ? `${grinAddress}|${cip}` : null;
  // Only the pair lock and the per-IP lock refuse. The bare-address counter never does —
  // see the throttle block above (§J3-3): a stranger's failures must not deny the owner.
  if ((pairKey && isLockedOut(pairKey)) || (ipKey && isLockedOut(ipKey))) {
    return { ok: false, reason: 'too_many_attempts' };
  }
  const raw = typeof submitted === 'string' ? submitted.trim() : '';
  if (!raw) return { ok: false, reason: 'proof_required' };

  let row;
  try {
    row = db.prepare(
      `SELECT last_ip, prev_ip, last_pass_hash, prev_pass_hash,
              last_ip_at, prev_ip_at, last_pass_at, prev_pass_at,
              anchor_ip, anchor_pass_hash, anchor_set_at
       FROM miner_accounts WHERE grin_address = ?`
    ).get(grinAddress);
  } catch (e) {
    return { ok: false, reason: 'lookup_failed' };
  }
  if (!row) return { ok: false, reason: 'account_not_found' };
  if (!row.last_ip && !row.prev_ip && !row.last_pass_hash && !row.prev_pass_hash &&
      !row.anchor_ip && !row.anchor_pass_hash) {
    return { ok: false, reason: 'no_recorded_proof' };
  }

  // Under-attack mode costs every attempt on this address a fixed delay, the owner's included.
  // It is applied BEFORE the KDF so it also throttles the scrypt work, and it never refuses.
  if (underAttack(grinAddress)) await _attackDelay();

  const nowS = Math.floor(Date.now() / 1000);
  const age = (t) => (t ? Math.max(0, nowS - t) : null);
  const clearAll = () => {
    if (pairKey) _clearFails(pairKey);
    if (ipKey) _clearFails(ipKey);
    _clearFails(grinAddress);
  };
  const failAll = () => {
    if (pairKey) _registerFail(pairKey, FAIL_MAX_PAIR);
    if (ipKey) _registerFail(ipKey, FAIL_MAX_IP);
    // Counts only — 0 means "never lock this key". Skipped when there is no client IP, which
    // is the admin verify-owner tool (index.js /api/admin/dormancy/verify-owner): this counter
    // exists to spot failures arriving from MANY origins, which is meaningless without an
    // origin, and an operator checking a proof from a support e-mail must not be able to slow
    // the miner they are trying to help.
    if (cip) _registerFail(grinAddress, 0);
  };
  const hit = (method, slot, at) => {
    clearAll();
    return { ok: true, reason: 'match', method, slot, age_seconds: age(at) };
  };

  const ip = canonicalizeIp(raw);
  if (net.isIP(ip)) {
    if (await matchesStoredIp(ip, row.last_ip)) return hit('ip', 'last', row.last_ip_at);
    if (await matchesStoredIp(ip, row.prev_ip)) return hit('ip', 'prev', row.prev_ip_at);
    // Anchor last: it is the weakest slot (unrevocable), so a live window value must win the
    // slot label when both match, or an active miner would be needlessly barred from §J3-1's
    // destination gate.
    if (allowAnchor && await matchesStoredIp(ip, row.anchor_ip)) {
      return hit('ip', 'anchor', row.anchor_set_at);
    }
  }
  if (isUsablePassword(raw, db)) {
    if (await verifyHashedProof(raw, row.last_pass_hash)) return hit('password', 'last', row.last_pass_at);
    if (await verifyHashedProof(raw, row.prev_pass_hash)) return hit('password', 'prev', row.prev_pass_at);
    if (allowAnchor && await verifyHashedProof(raw, row.anchor_pass_hash)) {
      return hit('password', 'anchor', row.anchor_set_at);
    }
  } else if (!net.isIP(ip)) {
    // Not an IP, and unusable as a password — so it was never captured and can never match.
    // Report WHY (too short / too long / too common), and deliberately do NOT count it toward
    // the lockout: it is rejected before any scrypt call, so it costs nothing and deters no
    // attacker, while counting it would lock out an honest miner retrying a rejected password.
    return { ok: false, reason: passwordRejectReason(raw, db) };
  }

  failAll();
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

// ─── One-time startup backfill: anchor the proof each existing account already holds ────────
// The anchor slot (§J3-4) is write-once at first capture, which leaves every PRE-EXISTING
// account anchorless — and if the anchor were instead filled by whatever arrives next, the
// first hostile session after an upgrade would become the permanent proof of somebody else's
// address. So seed it from the value the account already holds, before any capture can run.
//
// Synchronous on purpose (this is a column copy, not a KDF — the values are already hashed),
// and it must run BEFORE the stratum listener accepts a share. Idempotent: the WHERE clause
// skips rows that already have an anchor. anchor_set_at is backdated to the slot's own
// capture time when one is known, so a backfilled anchor is not treated as freshly written.
function backfillProofAnchors(db) {
  try {
    const info = db.prepare('SELECT COUNT(*) AS c FROM miner_accounts').get();
    if (!info || !info.c) return 0;
    const res = db.prepare(
      `UPDATE miner_accounts
          SET anchor_ip = COALESCE(anchor_ip, last_ip),
              anchor_pass_hash = COALESCE(anchor_pass_hash, last_pass_hash),
              anchor_set_at = COALESCE(anchor_set_at, last_ip_at, last_pass_at, created_at)
        WHERE (anchor_ip IS NULL AND last_ip IS NOT NULL)
           OR (anchor_pass_hash IS NULL AND last_pass_hash IS NOT NULL)`
    ).run();
    const n = res.changes || 0;
    if (n > 0) console.log(`[owner-proof] anchored ${n} existing account(s) to their current proof`);
    return n;
  } catch (e) {
    console.error(`[owner-proof] anchor backfill failed: ${e.message}`);
    return 0;
  }
}

// Audit an ownership-gated attempt to admin_audit_log (admin_id NULL — actor is a miner address,
// not an admin user). Best-effort; never throws into the request path.
//
// The IP is stored COARSENED to its network prefix (see coarsenIp) — these rows pair a real
// person's address with their origin and are retained for months, so the full host address
// buys nothing the prefix doesn't. Note the one admin-initiated caller (`admin_verify`) is
// coarsened too; its actor is already identified by `details.by`, so no attribution is lost.
// The throttle in verifyOwnerProof still keys on the FULL in-memory IP — coarsening here does
// not widen the per-IP lockout to a whole /24.
//
// The origin COUNTRY is resolved here from the full IP and folded into `details.geo` — this is
// the only place the full address still exists, and a /24 is too coarse to geolocate reliably
// after the fact. Stored in the details JSON rather than a new column on purpose: db.js's
// migrateAdminAuditLog() DROPS the table when its columns don't match the canonical set, so
// adding one would delete every existing audit row on the next deploy. Resolves to null on a
// private/loopback address or when geoip-lite isn't installed.
function auditOwnerProof(db, { action, grinAddress, ip, ok, details }) {
  try {
    const d = { ...(details || {}) };
    try {
      const geo = geoip.lookupCountry(canonicalizeIp(ip));
      if (geo && geo.cc) d.geo = geo.cc;
    } catch (_) { /* geo is a nice-to-have; never block the audit write */ }
    db.prepare(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
       VALUES (NULL, ?, 'miner', ?, ?, ?)`
    ).run(
      `owner_proof:${action}:${ok ? 'ok' : 'deny'}`,
      grinAddress || null,
      JSON.stringify(d),
      coarsenIp(ip)
    );
  } catch (e) {
    console.error(`[owner-proof] audit write failed: ${e.message}`);
  }
}

// ─── One-time startup migration: coarsen historical miner audit IPs ─────────
// Existing deploys already hold full IPs on miner rows; switching the writer alone would
// leave those on disk until they aged out of retention. Rewrite them in place.
// Synchronous (no KDF — this is truncation, not hashing) and fast enough to run inline.
// Idempotent: already-coarsened values contain '/' and are excluded by the WHERE clause.
//
// Scoped by target_type = 'miner' — the rows auditOwnerProof writes — NOT by
// `admin_id IS NULL`. That was the original test and it was wrong: a FAILED admin login also
// has admin_id NULL (a bad username has no user row to attribute to), so the migration was
// silently truncating exactly the auth rows an operator needs at full precision, one restart
// after they were written. Two different reasons those rows must keep the host address:
//   * there is no miner identity in an auth row, so there is no (address, IP) linkage to
//     break — the whole point of coarsening miner rows;
//   * the operator's response to a brute-force attempt is to blackhole the source, and you
//     cannot ufw-deny a /24 you were handed instead of the address that attacked you.
// Auth-row IPs are operator security data. Miner rows stay coarsened.
function migrateAuditLogIps(db) {
  try {
    const rows = db.prepare(
      `SELECT id, ip FROM admin_audit_log
       WHERE target_type = 'miner' AND ip IS NOT NULL AND ip <> '' AND ip NOT LIKE '%/%'`
    ).all();
    if (rows.length === 0) return 0;
    const upd = db.prepare('UPDATE admin_audit_log SET ip = ? WHERE id = ?');
    const tx = db.transaction(() => {
      for (const r of rows) upd.run(coarsenIp(r.ip), r.id);
    });
    tx();
    console.log(`[owner-proof] coarsened ${rows.length} historical audit IP(s) to network prefixes`);
    return rows.length;
  } catch (e) {
    console.error(`[owner-proof] audit IP migration failed: ${e.message}`);
    return 0;
  }
}

module.exports = {
  canonicalizeIp,
  normalizeIp,
  coarsenIp,
  migrateAuditLogIps,
  isUsablePassword,
  passwordRejectReason,
  PASS_MIN,
  PASS_MAX,
  recordOwnerEvidence,
  verifyOwnerProof,
  migrateOwnerProofHashes,
  backfillProofAnchors,
  auditOwnerProof,
  isLockedOut,
  underAttack,
  _sweepFails,
  FAIL_MAX_PAIR,
  FAIL_MAX_IP,
  ADDR_ALERT_MAX
};
