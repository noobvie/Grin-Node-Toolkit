'use strict';

const crypto = require('crypto');
const net = require('net');
const geoip = require('./geoip');

// Address-as-identity ownership gate — a SET of proofs per address (design §17).
//
// The pool has no miner accounts — the grin address IS the identity. For self-service money
// actions we need a cheap proof that the requester actually controls a rig mining under that
// address, WITHOUT introducing registration. It gates every self-service money action — Tor
// payout, slatepack create and finalize, the payment-proof reveal, and the Goblin/Nostr
// destination register/remove (which demands BOTH proofs, see index.js requireBothProofs).
// Proof = EITHER of:
//   · one of the address's recent mining source IPs (IPv4 or IPv6), or
//   · one of the rig passwords its miners send (as typed into the miner's Pool1 config).
//
// This is an anti-griefing / anti-spam gate, NOT strong authentication: both payout rails are
// independently theft-proof (Tor pays only to the address's own wallet; a slatepack is
// age-encrypted to it). The gate exists so a stranger reading the public leaderboard cannot
// trigger payouts for other people's addresses (each one burns a pool-paid network fee,
// consumes a hot-wallet output, and force-moves coins the owner didn't ask to move).
//
// ── THE SET (design §17.2, replaced the 2-slot window on 2026-09-22) ──────────────────
// Each (address, kind) owns up to PROOF_SET_MAX = 10 LIVE rows in `miner_proofs`. A value
// already in the set refreshes its `last_seen_at`; a new one is inserted, evicting the
// least-recently-SEEN live row when the set is full. `first_seen_at` never moves while a row is
// live; the one write that restarts it is an evicted anchor returning (see _captureProof).
//
// The window it replaced held two slots and compared a capture against the newer one only, so
// two facilities whose rigs reconnected in turn rotated it on EVERY reconnect. Each rotation
// re-stamped the age the §J3-1 gate reads (refusing the owner's own destination change as
// `proof_too_recent`) and lit an "evidence changed" warning for honest churn. The page's
// "use the same password on every rig" was a workaround for the slot count, not a security
// property; with ten slots per kind, different passwords on different sites all work.
//
// ── STORAGE ─────────────────────────────────────────────────────────────
// Data minimisation (operator decision 2026-07-17): rows hold scrypt hashes, never a raw
// mining IP and never a raw password. ONE SALT PER ADDRESS (`miner_accounts.proof_salt`), so
// a verify costs ONE scrypt whatever the set size — that is what makes a set of ten as cheap
// as a window of two, and it is the whole reason the cap could be raised. Rows read
// `v2$<hashB64>`; digests are compared with crypto.timingSafeEqual.
//   → An offline attacker holding the DB can precompute per ADDRESS instead of per row: at
//     most a ×10 saving on a 2^32 × 16 MB job, still unshareable across addresses. Accepted
//     (§17.4) — do not "fix" it by re-salting per row without re-reading that trade.
// Legacy `v1$<salt>$<hash>` rows carried over by migrateProofSet() cost one scrypt each until
// they are evicted; a capture that MATCHES one has the plaintext in hand and rewrites it as
// v2 in place, so a migrated account converges on the one-scrypt cost by itself.
//
// ── CAPTURE ─────────────────────────────────────────────────────────────
// Capture lives at the stratum layer, on a session's ACCEPTED shares (never at login — login
// is unauthenticated, so recording there let a bare TCP connect write to an address's proofs;
// a recorded proof requires actual PoW). The real miner IP is the socket address for direct
// miners, or the PROXY-protocol v2 header value for miners arriving via a regional gateway
// (Model C).
//
// ⚠ PoW is a COST, not an identity. Anyone may mine to anyone's address, so "requires an
// accepted share" narrows who can write to an address's proofs — it does not restrict it to
// the owner. The 2026-08-26 audit (§J3) found three consequences, and all three answers are
// still here; none should be removed without re-reading that section:
//   · §J3-1 — both legs are written by ONE call on ONE share, so the AND-gate on the Goblin
//     destination was never two factors. verifyOwnerProof therefore reports WHICH KIND of row
//     matched and HOW OLD it is, and index.js requireBothProofs refuses a leg younger than the
//     destination cooldown. AGE is the only thing that separates the owner from a stranger who
//     mined here for ten seconds — which is why a refresh never touches `first_seen_at`. A
//     path that moved it FORWARD on a live row would defeat that gate exactly as window
//     rotation did; one that kept an OLD stamp on a returning value would hand the gate an
//     aged leg nobody earned (the re-activated anchor, below).
//   · §J3-4 — hostile sessions evicted both window slots, permanently for a miner who had
//     stopped mining. Hence the ANCHOR (below) and the caller-supplied mayDisplace flag: an
//     insert into a NON-EMPTY set costs sustained work, while first capture stays cheap.
//   · §J3-3 — the failed-attempt lockout was address-keyed, so a stranger's failures locked
//     the owner out of their own money. Denial is now keyed to the (address, origin) pair.
//
// The ANCHOR is the address's first-ever value of each kind, flagged `is_anchor` on its own
// row. It is never DELETED — when it is the LRU pick of a full set it is flagged `evicted_at`
// instead — so a miner who has stopped mining always retains a route to their own wallet. An
// evicted anchor verifies with `slot: 'anchor'` and is deliberately REFUSED by
// requireBothProofs: an unrevocable credential must not be able to change where money goes,
// only to move money to the address's own wallet. A LIVE anchor is an ordinary set member.
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
// The proof set stores scrypt hashes, so the DB holds no raw mining IP — but the
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

// Straight digit runs (`12345678`, `87654321`, `01234567`, …): the connect page asks for a
// numeric PIN, and a keyboard row is the first thing typed when a form demands 8+ digits.
// Structural like the rule above — the seed list can't enumerate every length either.
function isDigitRun(p) {
  if (!/^[0-9]{2,}$/.test(p)) return false;
  let asc = true, desc = true;
  for (let i = 1; i < p.length; i++) {
    const d = p.charCodeAt(i) - p.charCodeAt(i - 1);
    if (d !== 1) asc = false;
    if (d !== -1) desc = false;
  }
  return asc || desc;
}

// Printable ASCII only (0x20–0x7E). Not a strength rule — a sanity rule for the OTHER end of
// the wire: ASIC firmware builds the stratum login from a web-form field, and a non-Latin
// character in that field arrives here however the firmware happened to encode it (a Latin-1
// store decodes to U+FFFD; so does a UTF-8 sequence split across TCP chunks, since the
// stratum reader decodes per chunk). The pool would hash that garbage and record the state
// as `ok`, and the miner would find out on withdrawal day, when the value they type into the
// account page — correct UTF-8 over HTTPS — can never match. Refusing it with its own reason
// turns that silent mismatch into a chip on the account page at the first share. Digits and
// letters pass every firmware, shell and encoding untouched, which is why the connect page
// asks for a PIN.
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/;

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
  if (!PRINTABLE_ASCII_RE.test(p)) return 'password_charset';
  if (TRIVIAL_PASSWORDS.has(p.toLowerCase())) return 'trivial_password';
  if (REPEATED_CHAR_RE.test(p)) return 'trivial_password';
  if (isDigitRun(p)) return 'trivial_password';
  if (extraBannedSet(db).has(p.toLowerCase())) return 'trivial_password';
  if (/^d=/i.test(p)) return 'trivial_password'; // difficulty-request convention, not a secret
  return null;
}

function isUsablePassword(pass, db) {
  return passwordRejectReason(pass, db) === null;
}

// ─── Salted scrypt hashing ──────────────────────────────────────────────────
// scrypt (memory-hard, 16 MB) so a leaked DB can't be brute-forced on GPUs — relevant for
// IPv4 proofs (2^32 space) and low-entropy rig passwords. Hashing happens off the hot path:
// at most twice per stratum session (accepted share 1 and PROOF_MIN_SHARES) and on
// user-triggered verifies. The parameters are shared by both forms — changing them
// invalidates every stored hash, so they are not a dial.
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

// v2 — the current form. `v2$<hashB64>`, scrypt under the ADDRESS's salt, so the digest is a
// pure function of (value, address) and one KDF call serves a whole set (§17.2 #3).
function hashProofV2(value, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(value), Buffer.from(String(salt), 'base64'), KEYLEN, SCRYPT_OPTS, (err, dk) => {
      if (err) return reject(err);
      resolve(`v2$${dk.toString('base64')}`);
    });
  });
}

// Synchronous v2 — migrateProofSet() only, for the pre-v1 PLAINTEXT values a very old deploy
// may still hold. That migration is one-time, bounded by the number of such accounts, and must
// finish before the stratum listener accepts a share, so it cannot be async.
function hashProofV2Sync(value, salt) {
  return `v2$${crypto.scryptSync(String(value), Buffer.from(String(salt), 'base64'), KEYLEN, SCRYPT_OPTS).toString('base64')}`;
}

// v1 — legacy per-row salt (`v1$<saltB64>$<hashB64>`). No production path writes one any
// more: migrateProofSet() carries EXISTING v1 values across as-is and they must keep verifying
// until a matching capture rewrites them or the LRU evicts them. Exported so the regression
// suite can build a legacy row through the same code that parses one, rather than hand-rolling
// the format and testing its own idea of it.
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

// Constant-time equality of two `v2$…` strings (§17.2 #3). timingSafeEqual THROWS on a length
// mismatch, so the lengths are checked first — a digest of the wrong length is corruption, not
// a secret, and rejecting it early leaks nothing.
function sameDigest(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!a.startsWith('v2$') || !b.startsWith('v2$')) return false;
  let x, y;
  try {
    x = Buffer.from(a.slice(3), 'base64');
    y = Buffer.from(b.slice(3), 'base64');
  } catch (e) { return false; }
  if (x.length !== KEYLEN || y.length !== KEYLEN) return false;
  return crypto.timingSafeEqual(x, y);
}

// ─── The proof set ──────────────────────────────────────────────────────────
// Live rows per (address, kind). A module constant, NOT an admin setting: the only reason the
// old window was two deep was scrypt cost, and the per-address salt removed that. A dial here
// would make "how many of your rigs can prove ownership" an operator guess, and the account
// page quotes the number to the miner — it is a product fact, not a tuning knob.
const PROOF_SET_MAX = 10;

// A row is LIVE unless it carries an eviction stamp. Only an anchor row is ever non-live.
// 0 is a legitimate stamp (a migrated anchor with no known timestamp), so this tests for
// NULL rather than for falsiness.
const isLiveProof = (r) => !!r && (r.evicted_at === null || r.evicted_at === undefined);

// One salt per ADDRESS (§17.2 #3), minted lazily on its first v2 hash.
//
// ⚠ The UPDATE is CONDITIONAL and the value is RE-READ. Two rigs' first accepted shares for a
// brand-new address can land together; without `WHERE proof_salt IS NULL` both would mint a
// salt, and the row hashed under the loser's salt could never be matched again. The first
// writer wins and the loser adopts its salt. NEVER return the value you just generated.
// Returns null when the account row is missing or the DB errors — callers then decline to
// write, rather than storing a proof that nobody can reproduce.
function getOrCreateSalt(db, grinAddress) {
  try {
    db.prepare(
      'UPDATE miner_accounts SET proof_salt = ? WHERE grin_address = ? AND proof_salt IS NULL'
    ).run(crypto.randomBytes(16).toString('base64'), grinAddress);
    const row = db.prepare('SELECT proof_salt FROM miner_accounts WHERE grin_address = ?').get(grinAddress);
    return (row && row.proof_salt) || null;
  } catch (e) {
    console.error(`[owner-proof] proof salt unavailable for ${grinAddress}: ${e.message}`);
    return null;
  }
}

// Every proof row for one (address, kind): LIVE first, least-recently-seen first inside each
// group, `id` breaking ties so migrated rows carrying no timestamps still evict oldest-first
// (the migration inserts anchor → prev → last). ONE read serves the match test, the live count
// and the eviction pick, so those three can never disagree with each other.
function _proofRows(db, grinAddress, kind) {
  return db.prepare(
    `SELECT id, hash, first_seen_at, last_seen_at, is_anchor, evicted_at
       FROM miner_proofs WHERE grin_address = ? AND kind = ?
      ORDER BY (evicted_at IS NULL) DESC, last_seen_at ASC, id ASC`
  ).all(grinAddress, kind);
}

// Which row holds `value`? ONE scrypt for the whole set (the v2 digest, precomputed by the
// caller so one submission can be tested against BOTH kinds for a single KDF call), plus one
// per legacy v1 row. Returns the row or null. Reads only — never writes.
async function _matchProofRow(rows, value, v2) {
  if (v2) {
    for (const r of rows) if (sameDigest(r.hash, v2)) return r;
  }
  for (const r of rows) {
    if (typeof r.hash === 'string' && r.hash.startsWith('v1$') &&
        await verifyHashedProof(value, r.hash)) return r;
  }
  return null;
}

// Make room for `headroom` more LIVE rows (default 1); returns how many were evicted. Pass 0
// to merely TRIM a set back to the cap without freeing a slot — over-evicting would throw
// away an owner's working proof for nothing.
//
// Evicts `live - PROOF_SET_MAX + 1`, not just one (§17.2 #5). _captureProof decides after its
// last await, so it cannot overshoot on its own; the excess form is defensive, so a set pushed
// over the cap any other way (a hand-edited DB, a future caller) is trimmed back on the next
// insert instead of staying over it permanently. An ANCHOR row is flagged, never deleted
// (§J3-4) — a miner who has stopped mining must keep a route to their own wallet.
function _makeRoom(db, rows, now, headroom) {
  const live = rows.filter(isLiveProof);
  const excess = live.length - PROOF_SET_MAX + (headroom === undefined ? 1 : headroom);
  if (excess <= 0) return 0;
  let n = 0;
  for (const r of live.slice(0, excess)) { // rows arrive least-recently-seen first
    if (r.is_anchor) db.prepare('UPDATE miner_proofs SET evicted_at = ? WHERE id = ?').run(now, r.id);
    else db.prepare('DELETE FROM miner_proofs WHERE id = ?').run(r.id);
    n++;
  }
  return n;
}

// A capture that matched a v1 row has the plaintext in hand, so re-hash it under the address
// salt: that row stops costing its own scrypt on every future verify, and a migrated account
// converges on the one-KDF cost with no sweep. Best-effort — an account carrying two v1 rows
// for one value (two legacy slots, two per-row salts) would hit the UNIQUE constraint on the
// second rewrite, and the last_seen_at refresh that matters has already happened.
function _upgradeV1Row(db, row, v2) {
  if (!v2 || typeof row.hash !== 'string' || !row.hash.startsWith('v1$')) return;
  try {
    db.prepare('UPDATE miner_proofs SET hash = ? WHERE id = ?').run(v2, row.id);
  } catch (e) { /* a v2 row for this value already exists — leave the v1 row to age out */ }
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

// ─── Evidence capture (called from the stratum accepted-share path) ─────────
// Records BOTH kinds for an address: source IP (always, when valid) and stratum password
// (only when usable). Async (scrypt) — the stratum caller fires and forgets. Returns true if
// anything was written.
//
// Per kind, exactly one of three things happens (§17.2 #5):
//   · the value is already a LIVE row  → refresh last_seen_at. No insert, no audit row. This
//     is the normal case for every rig that reconnects, and it is what makes honest churn
//     silent where the old window wrote an audit row and an alarm for it.
//   · the set is EMPTY                 → insert; the row becomes the anchor. Always allowed:
//     a brand-new address has nothing to protect, and gating first capture would strand a rig
//     that reconnects too often to ever reach PROOF_MIN_SHARES.
//   · anything else (a new value, or re-activating the evicted anchor) → an INSERT into a
//     non-empty set. Needs mayDisplace, evicts the LRU live row when the set is full, and
//     writes the `evidence_added` audit row. That is the hostile signature.
async function recordOwnerEvidence(db, grinAddress, rawIp, rawPass, opts) {
  // mayDisplace=false → refresh-or-first-capture only. The caller (stratum-server) sets it
  // from how much accepted work THIS SESSION has done, so one share can establish a proof for
  // an address that has none but cannot add one beside somebody else's rig (§J3-4).
  // Defaults true so existing callers and tests keep the original behaviour.
  const mayDisplace = !(opts && opts.mayDisplace === false);
  if (!grinAddress) return false;
  try {
    const acct = db.prepare(
      'SELECT pass_proof_state FROM miner_accounts WHERE grin_address = ?'
    ).get(grinAddress);
    if (!acct) return false; // account not created yet — caller ensures existence first

    const now = Math.floor(Date.now() / 1000);
    let wrote = false;

    const ip = canonicalizeIp(rawIp);
    if (ip && ip !== 'unknown' && net.isIP(ip)) {
      if (await _captureProof(db, grinAddress, 'ip', ip, now, mayDisplace, rawIp)) wrote = true;
    }

    const pass = typeof rawPass === 'string' ? rawPass.trim() : '';
    // Diagnostic state for THIS login's password — persisted so the account page can tell the
    // miner why their password isn't working, instead of them finding out on withdrawal day.
    // 'none' (rig sent nothing) is deliberately distinct from a reject code: "you set no
    // password" and "your password was refused" need different fixes. Not a proof: it says
    // nothing about which passwords are on record, and §17 does not change it.
    const passState = pass ? (passwordRejectReason(pass, db) || 'ok') : 'none';
    if (passState !== acct.pass_proof_state) {
      db.prepare(
        'UPDATE miner_accounts SET pass_proof_state = ?, updated_at = unixepoch() WHERE grin_address = ?'
      ).run(passState, grinAddress);
      wrote = true;
    }

    if (isUsablePassword(pass, db)) {
      if (await _captureProof(db, grinAddress, 'pass', pass, now, mayDisplace, rawIp)) wrote = true;
    } else if (pass) {
      // Also log the REASON (never the value) so the operator can answer "why won't my
      // password work?" from the service log without asking the miner to reveal it.
      console.warn(`[owner-proof] password not captured for ${grinAddress}: ${passState}`);
    }

    return wrote;
  } catch (e) {
    console.error(`[owner-proof] recordOwnerEvidence failed for ${grinAddress}: ${e.message}`);
    return false;
  }
}

// One kind of one capture. Returns true if a row was written.
//
// ⚠ ORDER MATTERS. The KDF is the only await, and everything that DECIDES (live count, cap,
// anchor, LRU pick) reads the table AFTER it. An earlier draft hashed against a snapshot taken
// before the await and then wrote against it; two captures landing together could each see an
// empty set and each claim the anchor. The rows are therefore read twice: once to find out
// which v1 hashes need testing, and again — with no await after it — to decide and write.
async function _captureProof(db, grinAddress, kind, value, now, mayDisplace, auditIp) {
  const salt = getOrCreateSalt(db, grinAddress);
  if (!salt) return false; // no salt → any row written now could never be matched again

  const v2 = await hashProofV2(value, salt);
  const pre = _proofRows(db, grinAddress, kind);
  const preMatch = await _matchProofRow(pre, value, v2);

  // From here down: synchronous. Re-read so the counts and the LRU pick describe the table as
  // it is now. Locate the match by the pre-read's hash string OR by our own v2 digest: while
  // this capture awaited the v1 checks above, a capture of the SAME value could have inserted
  // it, or rewritten the v1 row we matched as v2. Missing either sent this capture down the
  // insert path, where _makeRoom evicted an owner's proof for a row that already existed
  // (Part 4 review: two NAT'd rigs reaching PROOF_MIN_SHARES together cost a full set two rows).
  const rows = _proofRows(db, grinAddress, kind);
  const row = (preMatch && rows.find((r) => r.hash === preMatch.hash)) ||
              rows.find((r) => sameDigest(r.hash, v2)) || null;
  const live = rows.filter(isLiveProof);

  if (row && isLiveProof(row)) {
    // Known value, seen again. Refresh the LRU key ONLY: first_seen_at is what the §J3-1 age
    // gate reads, and moving it here would defeat that gate exactly as window rotation did.
    db.prepare('UPDATE miner_proofs SET last_seen_at = ? WHERE id = ?').run(now, row.id);
    _upgradeV1Row(db, row, v2);
    return true;
  }

  // Everything below is an INSERT into the set. Re-activating the evicted anchor counts as
  // one (§17.2 #5) — it is a value returning to the live set, and a returning value is exactly
  // what an attacker replaying an old capture would be doing.
  if (live.length > 0 && !mayDisplace) return false;

  const evicted = _makeRoom(db, rows, now);

  if (row) {
    // The evicted anchor is coming back — and its AGE RESTARTS. This is the one write that
    // moves first_seen_at, and it must: an evicted anchor is refused by requireBothProofs
    // (§J3-4, an unrevocable credential must not redirect money), but once live it reads as an
    // ordinary 'set' member. Keeping its original stamp would let four shares from whoever now
    // holds that value — the owner's old CGNAT or re-leased IP — launder it into an AGED leg
    // for the destination gate. A value returning to the live set is treated like any other
    // new value (a non-anchor one is re-inserted with first_seen_at = now), which is also what
    // the 2-slot window did. The owner's other live proofs keep their ages (Part 4 review).
    db.prepare('UPDATE miner_proofs SET evicted_at = NULL, first_seen_at = ?, last_seen_at = ? WHERE id = ?')
      .run(now, now, row.id);
    _upgradeV1Row(db, row, v2);
  } else {
    // is_anchor is decided INSIDE the statement, not from the snapshot above: node:sqlite runs
    // one statement to completion, so the EXISTS can never see a half-written table and two
    // addresses' first captures can never both claim the anchor. OR IGNORE because the same
    // value may already have been inserted by a capture that raced this one through the KDF —
    // the UNIQUE (address, kind, hash) index is what decides, not our read.
    const res = db.prepare(
      `INSERT OR IGNORE INTO miner_proofs
         (grin_address, kind, hash, first_seen_at, last_seen_at, is_anchor, evicted_at)
       SELECT ?, ?, ?, ?, ?,
              CASE WHEN EXISTS (SELECT 1 FROM miner_proofs
                                 WHERE grin_address = ? AND kind = ? AND is_anchor = 1)
                   THEN 0 ELSE 1 END,
              NULL`
    ).run(grinAddress, kind, v2, now, now, grinAddress, kind);
    if (!res.changes) {
      // Lost that race: the row exists, so this capture is a refresh after all.
      db.prepare(
        'UPDATE miner_proofs SET last_seen_at = ? WHERE grin_address = ? AND kind = ? AND hash = ?'
      ).run(now, grinAddress, kind, v2);
      return true;
    }
  }

  // Audited only for an insert into a NON-EMPTY set (§17.2 #6). A refresh writes nothing and a
  // first capture is not news; a value arriving beside existing ones is the event a miner or an
  // operator would want to see. live_after is re-counted rather than derived, so the row cannot
  // disagree with the table. The VALUE is never audited — only its kind.
  if (live.length > 0) {
    const liveAfter = db.prepare(
      'SELECT COUNT(*) AS c FROM miner_proofs WHERE grin_address = ? AND kind = ? AND evicted_at IS NULL'
    ).get(grinAddress, kind).c;
    auditOwnerProof(db, {
      action: 'evidence_added', grinAddress, ip: auditIp, ok: true,
      details: { kind, live_after: liveAfter, evicted: evicted > 0 }
    });
  }
  db.prepare('UPDATE miner_accounts SET updated_at = unixepoch() WHERE grin_address = ?').run(grinAddress);
  return true;
}

// ─── Verify (one field: IP or password) ─────────────────────────────────────
// The account page has a single proof input. If it parses as an IP, the IP set is tried; a
// usable-password-shaped value is also tried against the password set (both run when
// applicable, so a password that happens to look odd still gets its chance). Honours BOTH the
// per-(address, origin) and (when clientIp is supplied) the per-IP throttle.
// Returns { ok, reason, method?, slot?, age_seconds? }.
//   slot  'set' for a live row, 'anchor' ONLY for an evicted anchor. index.js
//         requireBothProofs refuses 'anchor' outright (§J3-4).
//   age_seconds  from first_seen_at, which a refresh never moves (only a returning anchor
//         restarts it). NULL → null, which every caller
//         already treats as OLD — those rows predate the timestamps, not the attack.
// clientIp is optional — omitting it preserves the original address-only behaviour, so any
// caller without a request IP (the admin verify-owner tool) is unaffected.
//
// COST (measured in scripts/test-owner-gate.js, not assumed): the v2 digest does not depend on
// the kind, so the memo below lets one digest serve both sets — ONE scrypt when the input is
// used as typed. TWO when canonicalising changes an IP that is also password-shaped (a
// compressed IPv6 like `2001:db8::1`): the IP set needs the canonical form, the password set
// the raw one. Plus one per legacy v1 row of every kind tried — up to 6 on a migrated account
// that still holds its anchor/last/prev of both kinds, so the transitional ceiling is 8, above
// the old window's 6, falling as captures rewrite v1 rows. §F2's per-IP throttle is sized
// against this number — see audit §F2 and design §17.7 before changing it.
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

  let acct, ipRows, passRows;
  try {
    acct = db.prepare('SELECT proof_salt FROM miner_accounts WHERE grin_address = ?').get(grinAddress);
    if (!acct) return { ok: false, reason: 'account_not_found' };
    ipRows = _proofRows(db, grinAddress, 'ip');
    passRows = _proofRows(db, grinAddress, 'pass');
  } catch (e) {
    return { ok: false, reason: 'lookup_failed' };
  }
  if (ipRows.length === 0 && passRows.length === 0) {
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
  const hit = (method, row) => {
    clearAll();
    return {
      ok: true,
      reason: 'match',
      method,
      // A LIVE anchor is an ordinary member — labelling it 'anchor' would needlessly bar an
      // actively-mining owner from the destination gate (§17.2 #4).
      slot: isLiveProof(row) ? 'set' : 'anchor',
      age_seconds: age(row.first_seen_at)
    };
  };

  // An address with no salt can hold no v2 rows, so skip the KDF entirely and let the v1 scan
  // do the work. Verify must never MINT a salt: it is a read path, and a write here would let
  // an unauthenticated probe create state on an address it does not own.
  const digests = new Map();
  const v2of = async (v) => {
    if (!acct.proof_salt) return null;
    if (!digests.has(v)) digests.set(v, await hashProofV2(v, acct.proof_salt));
    return digests.get(v);
  };
  const usable = (row) => !!row && (allowAnchor || isLiveProof(row));

  const ip = canonicalizeIp(raw);
  if (net.isIP(ip)) {
    const row = await _matchProofRow(ipRows, ip, await v2of(ip));
    if (usable(row)) return hit('ip', row);
  }
  if (isUsablePassword(raw, db)) {
    const row = await _matchProofRow(passRows, raw, await v2of(raw));
    if (usable(row)) return hit('password', row);
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

// ─── One-time startup migration: the 2-slot window → the proof set (§17.2 #9) ───────────────
// Copies miner_accounts' ten legacy proof columns into `miner_proofs`, then NULLs them.
//
// THE NULL IS THE IDEMPOTENCY PROOF. There is no marker table (repo style): the SELECT below
// only finds accounts that still hold a legacy VALUE, so a second run reads nothing and writes
// nothing. It subsumes both jobs of the functions it replaces — migrateOwnerProofHashes()
// (plaintext → hash) and backfillProofAnchors() (seed the anchor) — which are DELETED.
//
// Synchronous, and it MUST stay ahead of the stratum listener, for backfillProofAnchors()'s
// original reason: an account that reached its first post-upgrade capture with an empty set
// would anchor to whoever mined that share, not to the owner.
//
// Mapping (§17.2 #9). The legacy slots hold hash STRINGS that were copied byte-for-byte
// between columns, so string equality is exactly "the same value":
//   anchor  → is_anchor = 1. Live when it equals `last` or `prev`; otherwise it was already
//             outside the window, so it lands evicted, stamped with anchor_set_at.
//   last,
//   prev    → live rows, first_seen_at = last_*_at / prev_*_at (NULL = unknown = OLD, the
//             existing rule that requireBothProofs already implements).
// Rows are inserted anchor → prev → last so that `id` — the tiebreaker when timestamps are
// unknown — runs oldest to newest.
function migrateProofSet(db) {
  let accounts = 0, inserted = 0;
  try {
    const rows = db.prepare(
      `SELECT grin_address, created_at,
              last_ip, prev_ip, anchor_ip, last_ip_at, prev_ip_at,
              last_pass_hash, prev_pass_hash, anchor_pass_hash,
              last_pass_at, prev_pass_at, anchor_set_at
         FROM miner_accounts
        WHERE last_ip IS NOT NULL OR prev_ip IS NOT NULL OR anchor_ip IS NOT NULL
           OR last_pass_hash IS NOT NULL OR prev_pass_hash IS NOT NULL
           OR anchor_pass_hash IS NOT NULL`
    ).all();
    if (rows.length === 0) return 0;

    const insert = db.prepare(
      `INSERT OR IGNORE INTO miner_proofs
         (grin_address, kind, hash, first_seen_at, last_seen_at, is_anchor, evicted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const clear = db.prepare(
      `UPDATE miner_accounts
          SET last_ip = NULL, prev_ip = NULL, anchor_ip = NULL,
              last_ip_at = NULL, prev_ip_at = NULL,
              last_pass_hash = NULL, prev_pass_hash = NULL, anchor_pass_hash = NULL,
              last_pass_at = NULL, prev_pass_at = NULL, anchor_set_at = NULL,
              updated_at = unixepoch()
        WHERE grin_address = ?`
    );

    for (const r of rows) {
      const fallback = r.created_at || 0;
      const plan = [];
      for (const kind of ['ip', 'pass']) {
        const anchorVal = kind === 'ip' ? r.anchor_ip : r.anchor_pass_hash;
        const lastVal = kind === 'ip' ? r.last_ip : r.last_pass_hash;
        const prevVal = kind === 'ip' ? r.prev_ip : r.prev_pass_hash;
        const lastAt = kind === 'ip' ? r.last_ip_at : r.last_pass_at;
        const prevAt = kind === 'ip' ? r.prev_ip_at : r.prev_pass_at;
        const entries = [];
        // Both slots of one kind may hold the same stored string (an anchor backfilled from
        // `last`, or a rotation that carried `last` down to `prev`). That is ONE row: keep the
        // OLDEST first_seen_at, the NEWEST last_seen_at, the anchor flag from whichever slot
        // had it, and live beats evicted.
        const push = (val, firstAt, isAnchor, evictedAt) => {
          const v = _normalizeLegacy(val, kind);
          if (!v) return;
          const dup = entries.find((e) => e.value === v.value && e.hashed === v.hashed);
          if (dup) {
            dup.firstAt = _olderStamp(dup.firstAt, firstAt);
            dup.seenAt = Math.max(dup.seenAt, firstAt === null || firstAt === undefined ? fallback : firstAt);
            dup.isAnchor = dup.isAnchor || isAnchor;
            if (evictedAt === null) dup.evictedAt = null;
            return;
          }
          entries.push({
            kind, value: v.value, hashed: v.hashed,
            firstAt: (firstAt === null || firstAt === undefined) ? null : firstAt,
            seenAt: (firstAt === null || firstAt === undefined) ? fallback : firstAt,
            isAnchor, evictedAt
          });
        };
        // An anchor that matches neither window slot was already outside the window, so it
        // arrives evicted. `|| 0` because evicted_at must be NOT NULL to mean "not live" —
        // an unknown eviction time is still an eviction.
        push(anchorVal, r.anchor_set_at, 1, (r.anchor_set_at || fallback || 0));
        push(prevVal, prevAt, 0, null);
        push(lastVal, lastAt, 0, null);
        plan.push(...entries);
      }
      if (plan.length === 0) { clear.run(r.grin_address); continue; }

      // Hash any pre-v1 PLAINTEXT value before opening the transaction: scryptSync is ~16 MB
      // and ~100 ms, and holding the write lock across it buys nothing. No VPS has ever held
      // one of these — the column has stored hashes since 2026-07-17 — so this is a
      // correctness path, not a hot one.
      let salt = null;
      for (const e of plan) {
        if (e.hashed) continue;
        if (!salt) salt = getOrCreateSalt(db, r.grin_address);
        if (!salt) { e.skip = true; continue; }
        e.value = hashProofV2Sync(e.value, salt);
        e.hashed = true;
      }

      const tx = db.transaction(() => {
        for (const e of plan) {
          if (e.skip) continue;
          const res = insert.run(r.grin_address, e.kind, e.value, e.firstAt, e.seenAt, e.isAnchor, e.evictedAt);
          if (res.changes) inserted++;
        }
        // Defensive: an account that somehow already held a full set AND legacy columns (a
        // hand-edited DB) must not come out of the migration over the cap.
        for (const kind of ['ip', 'pass']) {
          const now = Math.floor(Date.now() / 1000);
          const set = _proofRows(db, r.grin_address, kind);
          if (set.filter(isLiveProof).length > PROOF_SET_MAX) _makeRoom(db, set, now, 0);
        }
        clear.run(r.grin_address);
      });
      tx();
      accounts++;
    }

    console.log(`[owner-proof] proof-set migration: ${inserted} row(s) from ${accounts} account(s); legacy columns cleared`);
    return accounts;
  } catch (e) {
    console.error(`[owner-proof] proof-set migration failed: ${e.message}`);
    return accounts;
  }
}

// A legacy slot value as it should be STORED. v1$/v2$ strings carry across untouched; anything
// else is pre-v1 plaintext from a deploy that predates hashing (IPs only in practice) and is
// canonicalised here so it hashes the way a typed one will. Returns null for an empty slot.
function _normalizeLegacy(val, kind) {
  if (val === null || val === undefined || val === '') return null;
  const str = String(val);
  if (str.startsWith('v1$') || str.startsWith('v2$')) return { value: str, hashed: true };
  const plain = kind === 'ip' ? canonicalizeIp(str) : str.trim();
  return plain ? { value: plain, hashed: false } : null;
}

// The older of two capture stamps, where NULL means "unknown, therefore OLD" — the rule
// requireBothProofs already applies to age_seconds. An unknown stamp wins, because the value
// it describes genuinely predates the timestamp columns.
function _olderStamp(a, b) {
  if (a === null || a === undefined) return null;
  if (b === null || b === undefined) return null;
  return Math.min(a, b);
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
  migrateProofSet,
  hashProof,
  getOrCreateSalt,
  PROOF_SET_MAX,
  auditOwnerProof,
  isLockedOut,
  underAttack,
  _sweepFails,
  FAIL_MAX_PAIR,
  FAIL_MAX_IP,
  ADDR_ALERT_MAX
};
