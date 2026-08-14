'use strict';
/**
 * server.js — Grin Transporter (Script 093): store-and-forward slate queue.
 *
 * A dumb, encrypted blob queue keyed by Slatepack address. The server never
 * sees plaintext, keys, or amounts — deposits are armored slatepacks the
 * sender's wallet already encrypted to the recipient's ed25519 key. This is
 * an HTTP service (NOT email/SMTP): "a queue you PUT to and GET from."
 *
 * Endpoints:
 *   GET    /                        public — landing page (public/index.html)
 *   GET    /health                  public — redacted counters only
 *   GET    /auth/challenge?addr=    public — one-time nonce for the address
 *   POST   /auth                    {addr, nonce, signature} → bearer token
 *   PUT    /queue/:addr             public* — deposit ciphertext for addr
 *   GET    /queue/:addr             token   — list pending slates for addr
 *   DELETE /queue/:addr/:id         token   — remove a consumed slate
 *
 * (*) Deposits are intentionally open — anyone may leave an encrypted slate,
 * exactly like anyone may hand you a sealed envelope. Confidentiality is the
 * encryption itself; abuse is bounded by the layered caps below.
 *
 * Retrieval/deletion require proof of key ownership (R8): the caller signs a
 * single-use server nonce with the ed25519 key behind their slatepack address
 * (same address-as-identity model as the Script 07 pool). No accounts.
 *
 * ─── Abuse bounds (hardened 2026-08-05) ──────────────────────────────────────
 * An open PUT plus a per-recipient depth cap is, on its own, a denial-of-service
 * weapon AGAINST the recipient: a slatepack address is public (it is the wallet's
 * Tor address), so anyone could fill a victim's queue with junk that merely looks
 * armored and every real payout would then bounce with 429 until the TTL expired.
 * Five layers now stand between a depositor and that outcome:
 *
 *   1. GLOBAL cap        max_queue_total          — the store as a whole is bounded
 *   2. DEDUPE            unique (recipient, body) — re-posting one blob costs 1 slot,
 *                                                   not N; also makes agent retries safe
 *   3. PER-CLIENT quota  max_deposits_per_ip_hour — one source cannot fire at will
 *   4. FAIR SHARE        max_per_depositor_per_addr — ONE depositor may occupy only a
 *                                                   few slots of any one queue, so
 *                                                   filling a victim's queue needs many
 *                                                   distinct sources, not one
 *   5. PER-QUEUE depth   max_queue_per_addr       — the original cap, now a last resort
 *
 * Layer 4 is the one that actually defuses the attack; the others bound its cost.
 *
 * ─── Layer 6: delivery order (the caps alone are NOT enough) ─────────────────
 * Capping deposits stops a queue being FILLED; it does not stop it being BLOCKED.
 * A GET returns the oldest MAX_LIST_ROWS slates, and the poll agent deletes only
 * what it successfully processes — undecodable junk is left "for retry". So junk
 * that arrives first pins the head of the window forever and every real slate
 * behind it stays invisible until it expires. Measured: 25 junk deposits (5 each
 * from 5 sources, i.e. within every cap above) hid a real payment on every poll.
 *
 * The fix is ordering, not another cap: slates are handed out
 * `ORDER BY picked_up ASC` — anything already delivered sinks below anything that
 * has never been seen. Junk is therefore demoted after its first delivery and a
 * fresh slate reaches the front within ceil(depth / MAX_LIST_ROWS) + 1 polls,
 * bounded by max_queue_per_addr rather than by the TTL. `picked_up` ships in the
 * GET response so the agent can retire a blob it has failed on repeatedly.
 *
 * ─── Two fronts, two trust levels ────────────────────────────────────────────
 * nginx and Tor both arrive on 127.0.0.1, so the app CANNOT tell them apart by
 * peer address — and that matters, because a Tor client controls its own HTTP
 * headers. Behind nginx, `X-Forwarded-For` ends with the true peer nginx saw, so
 * the last element is authoritative. Reached directly through an onion, nothing
 * stops a caller sending a forged `X-Forwarded-For` and minting a fresh identity
 * per request, which would void every per-client limit above.
 *
 * So the two fronts get SEPARATE LOCAL PORTS: `port` (nginx only) and `tor_port`
 * (onion only). Requests are classified by `req.socket.localPort`, and forwarding
 * headers are honoured on the nginx port ONLY. Onion traffic is one shared
 * identity ("tor") — anonymous by design, therefore not individually accountable.
 *
 * Residual risk, stated precisely: because every onion caller IS that one
 * identity, layer 4 applies to the onion front as a WHOLE. That cuts both ways.
 * It means no onion flood can bury a queue (good), and it also means all onion
 * senders together may hold only `max_per_depositor_per_addr` slates for any one
 * recipient (a real availability limit — an abuser occupying those slots blocks
 * legitimate onion senders until the owner's agent drains them). Layer 6 is what
 * keeps that recoverable: junk sinks and is retired instead of sitting for the
 * full TTL. Operators wanting more onion headroom should raise
 * `max_per_depositor_per_addr`, accepting a proportionally larger flood ceiling.
 *
 * Config (JSON file, path via TRANSPORTER_CONF env from the systemd unit):
 *   { "network": "testnet", "port": 7466, "tor_port": 0, "ttl_hours": 336,
 *     "max_slate_bytes": 16384, "max_queue_per_addr": 100,
 *     "max_queue_total": 10000, "max_deposits_per_ip_hour": 60,
 *     "max_per_depositor_per_addr": 5, "auth_fail_limit": 5,
 *     "auth_lock_minutes": 15, "auth_log_days": 30 }
 * DB path via TRANSPORTER_DB env. Binds 127.0.0.1 only — nginx and Tor are the
 * sole public surfaces.
 */

const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const { DatabaseSync: Database } = require('node:sqlite');

const VERSION = '0.3.0';   // 0.3.0 adds the public landing page at GET /

// ── Config ────────────────────────────────────────────────────────────────────

const CONF_PATH = process.env.TRANSPORTER_CONF;
const DB_PATH   = process.env.TRANSPORTER_DB;
if (!CONF_PATH || !DB_PATH) {
  throw new Error('TRANSPORTER_CONF and TRANSPORTER_DB must be set — the systemd unit provides them.');
}

/** Clamp a config integer into [min,max], falling back to `def` on garbage. */
function num(raw, def, min, max) {
  const v = parseInt(raw, 10);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, v));
}

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));
  const cfg = {
    network:            raw.network === 'mainnet' ? 'mainnet' : 'testnet',
    port:               num(raw.port, 7466, 1, 65535),
    // 0 = no onion front. Must differ from `port`: the split is what makes the
    // trust distinction possible at all (see the header note).
    tor_port:           num(raw.tor_port, 0, 0, 65535),
    ttl_hours:          num(raw.ttl_hours, 336, 1, 24 * 365),            // 14 days
    max_slate_bytes:    num(raw.max_slate_bytes, 16384, 1024, 1024 * 1024),
    max_queue_per_addr: num(raw.max_queue_per_addr, 100, 1, 10000),
    max_queue_total:    num(raw.max_queue_total, 10000, 100, 10000000),
    // Deposits allowed per client identity per hour on the TRUSTED front.
    max_deposits_per_ip_hour: num(raw.max_deposits_per_ip_hour, 60, 1, 100000),
    // How many of ONE queue's slots a single depositor may hold at once.
    max_per_depositor_per_addr: num(raw.max_per_depositor_per_addr, 5, 1, 10000),
    auth_fail_limit:    num(raw.auth_fail_limit, 5, 1, 1000),
    auth_lock_minutes:  num(raw.auth_lock_minutes, 15, 1, 1440),
    auth_log_days:      num(raw.auth_log_days, 30, 1, 3650),
  };
  if (cfg.tor_port === cfg.port) cfg.tor_port = 0;   // never collide with the nginx front
  return cfg;
}
const cfg = loadConfig();

// Mainnet addresses are bech32 with HRP "grin", testnet "tgrin".
const HRP = cfg.network === 'mainnet' ? 'grin' : 'tgrin';

const CHALLENGE_TTL_MS = 120 * 1000;       // nonce must be signed within 2 min
const TOKEN_TTL_MS     = 15 * 60 * 1000;   // bearer token lifetime
const MAX_LIST_ROWS    = 20;               // slates returned per GET

// Anti-abuse windows that are not worth a config knob.
const CHALLENGE_PER_CLIENT_MIN = 30;       // /auth/challenge calls per client per minute
const MAX_OPEN_CHALLENGES_ADDR = 10;       // outstanding un-redeemed nonces per address
const TOR_AUTH_ATTEMPTS_MIN    = 30;       // /auth attempts per minute across the onion front
const TOR_DEPOSITS_MIN         = 60;       // deposit ATTEMPTS per minute across the onion front
const MAX_RATE_BUCKETS         = 100000;   // memory ceiling for the in-process counters

// Per-boot HMAC secret — tokens are stateless; a restart just forces re-auth.
const TOKEN_SECRET = crypto.randomBytes(32);

const startedAt = Date.now();

function ts()          { return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC'); }
function logLine(lvl, msg) { console.log(`[${ts()}] [${lvl}] ${msg}`); }

// ── SQLite ────────────────────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS slates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient  TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    picked_up  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_slates_recipient ON slates(recipient, id);
  -- Covers the delivery-order read (recipient, picked_up ASC, id ASC) so the
  -- hot poll path never sorts a queue in memory.
  CREATE INDEX IF NOT EXISTS idx_slates_delivery  ON slates(recipient, picked_up, id);

  CREATE TABLE IF NOT EXISTS challenges (
    nonce      TEXT PRIMARY KEY,
    addr       TEXT    NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_challenges_addr ON challenges(addr);

  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );

  -- Audit trail for ownership proofs (R8 requires each attempt be logged).
  -- "client" is a SALTED HASH, never a raw IP — same privacy rule as the pool.
  CREATE TABLE IF NOT EXISTS auth_events (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     INTEGER NOT NULL,
    addr   TEXT    NOT NULL,
    client TEXT    NOT NULL,
    result TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auth_events_ts ON auth_events(ts);
`);

/** Add a column to an existing table if a pre-0.2.0 DB predates it. */
function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
}
ensureColumn('slates', 'body_hash', 'body_hash TEXT');
ensureColumn('slates', 'depositor', 'depositor TEXT');

/** Persistent salt so a depositor hash cannot be reversed to an IP by guessing. */
function metaGetOrCreate(key, gen) {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(key);
  if (row && row.v) return row.v;
  const v = gen();
  db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(key, v);
  return v;
}
const CLIENT_SALT = metaGetOrCreate('client_salt', () => crypto.randomBytes(32).toString('hex'));

function bodyHash(body) {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

/** One-way, salted, truncated — enough to group a depositor, useless as an IP. */
function clientHash(identity) {
  return crypto.createHash('sha256').update(CLIENT_SALT + '|' + identity).digest('hex').slice(0, 16);
}

// Backfill + de-duplicate before the unique index can be created.
(function migrateBodyHashes() {
  const rows = db.prepare('SELECT id, body FROM slates WHERE body_hash IS NULL').all();
  if (rows.length) {
    const upd = db.prepare('UPDATE slates SET body_hash = ? WHERE id = ?');
    for (const r of rows) upd.run(bodyHash(r.body), r.id);
    logLine('INFO', `MIGRATE body_hash backfilled rows=${rows.length}`);
  }
  const dupes = db.prepare(`
    DELETE FROM slates WHERE id NOT IN (
      SELECT MIN(id) FROM slates GROUP BY recipient, body_hash
    )`).run();
  if (dupes.changes) logLine('INFO', `MIGRATE removed duplicate slates=${dupes.changes}`);
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_slates_dedupe ON slates(recipient, body_hash)');
  } catch (e) {
    // Not fatal: handleDeposit checks for an existing row before inserting, so
    // the index is a backstop, not the mechanism.
    logLine('WARN', `Could not create dedupe index: ${e.message}`);
  }
})();

// ── Bech32 (BIP-173) decode — a slatepack address is bech32("grin"/"tgrin",
//    32-byte ed25519 public key). Implemented inline: ~40 lines beats a dep. ──

const B32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function _b32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function _b32HrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

/** Decode a bech32 string → { hrp, data: number[] (5-bit) } or null. */
function bech32Decode(str) {
  if (str.length < 8 || str.length > 90) return null;
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) return null;
  str = str.toLowerCase();
  const pos = str.lastIndexOf('1');
  if (pos < 1 || pos + 7 > str.length) return null;
  const hrp = str.slice(0, pos);
  const data = [];
  for (const c of str.slice(pos + 1)) {
    const v = B32_CHARSET.indexOf(c);
    if (v === -1) return null;
    data.push(v);
  }
  if (_b32Polymod(_b32HrpExpand(hrp).concat(data)) !== 1) return null;  // bech32 const = 1
  return { hrp, data: data.slice(0, -6) };
}

/** 5-bit groups → bytes (strict: no leftover bits allowed to be non-zero). */
function _fromWords(words) {
  let acc = 0, bits = 0;
  const out = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff)) return null;
  return Buffer.from(out);
}

/** Validate a slatepack address for THIS network → 32-byte pubkey Buffer or null. */
function decodeSlatepackAddress(addr) {
  if (typeof addr !== 'string') return null;
  const dec = bech32Decode(addr.trim());
  if (!dec || dec.hrp !== HRP) return null;
  const key = _fromWords(dec.data);
  if (!key || key.length !== 32) return null;
  return key;
}

// ── ed25519 verify via node:crypto (SPKI DER wrap around the raw key) ─────────

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifyAddrSignature(pubkey32, message, sigHex) {
  if (!/^[0-9a-fA-F]{128}$/.test(sigHex || '')) return false;
  try {
    const keyObj = crypto.createPublicKey({
      key:    Buffer.concat([ED25519_SPKI_PREFIX, pubkey32]),
      format: 'der',
      type:   'spki',
    });
    return crypto.verify(null, Buffer.from(message, 'utf8'), keyObj, Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

// ── Stateless bearer tokens: base64url(addr|exp) + "." + HMAC ─────────────────

function issueToken(addr) {
  const exp     = Date.now() + TOKEN_TTL_MS;
  const payload = Buffer.from(`${addr}|${exp}`).toString('base64url');
  const mac     = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return { token: `${payload}.${mac}`, expires_in: Math.floor(TOKEN_TTL_MS / 1000) };
}

function verifyToken(token, addr) {
  if (typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const mac     = token.slice(dot + 1);
  const expect  = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  let decoded;
  try { decoded = Buffer.from(payload, 'base64url').toString('utf8'); } catch { return false; }
  const sep = decoded.lastIndexOf('|');
  if (sep === -1) return false;
  const tAddr = decoded.slice(0, sep);
  const exp   = parseInt(decoded.slice(sep + 1), 10);
  return tAddr === addr && Number.isFinite(exp) && Date.now() < exp;
}

// ── In-process fixed-window counters (deliberately not persisted: a restart
//    forgiving a rate limit is fine; a restart forgetting a queue is not) ─────

const depositBuckets   = new Map();   // client → deposits this hour
const challengeBuckets = new Map();   // client → challenges this minute
const torAuthBucket    = new Map();   // single key → onion-front attempts this minute
const authFails        = new Map();   // addr|client → { n, until }

/** Count a hit; false once the window's limit is exceeded. */
function bucketHit(map, key, limit, windowMs) {
  const now = Date.now();
  if (map.size > MAX_RATE_BUCKETS) pruneBuckets();
  let b = map.get(key);
  if (!b || now >= b.reset) { b = { n: 0, reset: now + windowMs }; map.set(key, b); }
  b.n++;
  return b.n <= limit;
}

function pruneBuckets() {
  const now = Date.now();
  for (const map of [depositBuckets, challengeBuckets, torAuthBucket]) {
    for (const [k, b] of map) if (now >= b.reset) map.delete(k);
    // Still oversized after dropping expired windows: this is a flood from many
    // distinct sources. Drop everything rather than grow without bound — the
    // worst case is that some limiters restart their window early.
    if (map.size > MAX_RATE_BUCKETS) map.clear();
  }
  // Drop entries that are neither locked nor inside a live failure window.
  const window = cfg.auth_lock_minutes * 60 * 1000;
  for (const [k, f] of authFails) {
    if (now >= f.until && now - f.firstAt >= window) authFails.delete(k);
  }
  if (authFails.size > MAX_RATE_BUCKETS) authFails.clear();
}

// ── Slatepack body validation — armored ciphertext only, size-capped ──────────

function validSlatepackBody(body) {
  return typeof body === 'string'
    && body.length > 0
    && Buffer.byteLength(body, 'utf8') <= cfg.max_slate_bytes
    && body.includes('BEGINSLATEPACK')
    && body.includes('ENDSLATEPACK');
}

function truncAddr(addr) { return addr.slice(0, 12) + '…' + addr.slice(-4); }

// ── Landing page ──────────────────────────────────────────────────────────────
//
// A depot with a bare 404 on `/` is indistinguishable from a broken one, and the
// station URL is something a human has to read off a screen and paste into a
// wallet. So `/` serves one static page, rendered from public/index.html with
// this instance's live settings substituted in.
//
// Deliberately NOT express.static: exactly one file is public, it needs
// substitution, and a static root is one misplaced file away from serving
// config.json. The page ships with no JavaScript and no external requests, so
// the CSP below can be `default-src 'none'`.

const PAGE_PATH = path.join(__dirname, 'public', 'index.html');
let pageTemplate = null;
try {
  pageTemplate = fs.readFileSync(PAGE_PATH, 'utf8');
} catch (e) {
  // Not fatal — an upgrade from 0.2.x has no public/ dir until the deployer
  // re-copies the app. The queue API is what matters; `/` just stays a 404.
  logLine('WARN', `No landing page at ${PAGE_PATH}: ${e.message}`);
}

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) { return String(s).replace(/[&<>"']/g, c => HTML_ESC[c]); }

/** "16 KB" / "1 MB" / "900 B" — the cap as an operator wrote it, not raw bytes. */
function fmtBytes(n) {
  if (n >= 1048576 && n % 1048576 === 0) return `${n / 1048576} MB`;
  if (n >= 1024 && n % 1024 === 0)       return `${n / 1024} KB`;
  return `${n} B`;
}

/** TTL in the unit a human thinks in: whole days when it divides, else hours. */
function fmtTtl(hours) {
  if (hours % 24 === 0) {
    const d = hours / 24;
    return `${d} ${d === 1 ? 'day' : 'days'}`;
  }
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/**
 * The URL a visitor should paste into a wallet — derived from how THEY reached
 * us, so the onion front advertises the onion and the nginx front the domain.
 *
 * Host is attacker-controlled, so it is validated against a strict hostname
 * grammar and HTML-escaped before it goes anywhere near the page. A request
 * that fails validation gets the loopback URL: wrong-but-harmless beats
 * reflecting junk that someone might paste into a wallet.
 *
 * X-Forwarded-Proto is honoured on the nginx front ONLY, for the same reason
 * X-Forwarded-For is (see clientKey) — an onion client writes its own headers.
 */
const HOST_RE = /^[a-z0-9.-]{1,250}(:\d{1,5})?$/i;
function stationUrl(req) {
  const host = String(req.get('host') || '').trim();
  if (!HOST_RE.test(host)) return `http://127.0.0.1:${cfg.port}`;
  let scheme;
  if (!isTorFront(req) && req.get('x-forwarded-proto')) {
    scheme = req.get('x-forwarded-proto').split(',')[0].trim() === 'http' ? 'http' : 'https';
  } else {
    const name = host.split(':')[0].toLowerCase();
    // An onion is reached over HTTP inside the tunnel; so is a loopback test.
    scheme = (name.endsWith('.onion') || name === 'localhost' || /^127\./.test(name)) ? 'http' : 'https';
  }
  return `${scheme}://${host}`;
}

// COUNT(*) is cheap but `/` is the one unauthenticated page a crawler will hit
// in a loop — memoise it so a page view is not a DB read.
let pageCount = { n: 0, until: 0 };
function queuedNow() {
  if (Date.now() >= pageCount.until) {
    pageCount = { n: db.prepare('SELECT COUNT(*) AS n FROM slates').get().n, until: Date.now() + 30000 };
  }
  return pageCount.n;
}

/** Render the landing page for this request (helpers above; route below). */
function renderPage(req) {
  const full = queuedNow() >= cfg.max_queue_total;
  const vals = {
    STATION_URL:   esc(stationUrl(req)),
    NETWORK:       cfg.network === 'mainnet' ? 'Mainnet' : 'Testnet',
    NETWORK_LOWER: cfg.network,
    HRP:           HRP,
    COIN:          cfg.network === 'mainnet' ? 'Grin' : 'test Grin',
    STATUS_TEXT:   full ? 'Store at capacity' : 'Accepting deposits',
    STATUS_CLASS:  full ? 'full' : '',
    TTL_HOURS:     String(cfg.ttl_hours),
    TTL_DAYS:      fmtTtl(cfg.ttl_hours),
    MAX_SLATE:     fmtBytes(cfg.max_slate_bytes),
    QUEUE_DEPTH:   String(cfg.max_queue_per_addr),
    VERSION:       VERSION,
  };
  return pageTemplate.replace(/\{\{([A-Z_]+)\}\}/g,
    (m, k) => (Object.prototype.hasOwnProperty.call(vals, k) ? vals[k] : m));
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');
// req.ip is NOT used for any limit — clientKey() below is authoritative because
// it also accounts for which front the request arrived on.
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: cfg.max_slate_bytes + 4096 }));
app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

/** True when the request came in on the onion port (headers untrustworthy). */
function isTorFront(req) {
  return cfg.tor_port > 0 && req.socket.localPort === cfg.tor_port;
}

/**
 * Identity used for every per-client limit.
 *
 * Onion front → one shared bucket; anonymity means no per-caller accountability.
 * nginx front → the LAST element of X-Forwarded-For. nginx appends the peer it
 * actually saw, so anything a client prepends is ignored by taking the tail.
 */
function clientKey(req) {
  if (isTorFront(req)) return 'tor';
  const xff = req.get('x-forwarded-for');
  if (xff) {
    const last = xff.split(',').pop().trim();
    if (last) return last;
  }
  return req.socket.remoteAddress || 'local';
}

function err(res, msg, code = 400) { return res.status(code).json({ error: msg }); }

/**
 * Canonical queue address for a request.
 *
 * MUST be used instead of req.params.addr. Express rebuilds `req.params` for
 * every layer that matches, so normalising it inside an app.use() mount is
 * silently discarded before the route handler runs. Bech32 is case-insensitive,
 * so an ALL-CAPS address passed validation and was then stored verbatim, while
 * /auth always issued a lowercase token — deposits to the uppercase form landed
 * in a queue whose owner could never authenticate to it. Verified against the
 * running server: PUT 201, owner GET (lowercase) 0 slates, owner GET (uppercase)
 * 401. Mixed case is still rejected outright: bech32 forbids it.
 */
function qAddr(req) { return String(req.params.addr || '').trim().toLowerCase(); }

// Middleware: validate :addr for this network on all /queue routes.
app.use('/queue/:addr', (req, res, next) => {
  if (!decodeSlatepackAddress(req.params.addr)) {
    return err(res, `Invalid ${HRP}1… slatepack address for this network`, 400);
  }
  next();
});

// Middleware factory: require a valid bearer token for the addressed queue.
function requireOwner(req, res, next) {
  const auth  = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!verifyToken(token, qAddr(req))) {
    return err(res, 'Invalid or expired token — re-authenticate via /auth/challenge', 401);
  }
  next();
}

function auditAuth(addr, client, result) {
  db.prepare('INSERT INTO auth_events (ts, addr, client, result) VALUES (?, ?, ?, ?)')
    .run(Date.now(), addr, clientHash(client), result);
}

// GET / — the landing page (see the block above the Express app) ──────────────
app.get('/', (req, res) => {
  if (!pageTemplate) return err(res, 'Not found', 404);
  res.set({
    'Content-Type':            'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
                               "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy':         'no-referrer',
    // Overrides the no-store default: the page is public and identical for
    // everyone on a given host, and a censored client re-fetching it is waste.
    'Cache-Control':           'public, max-age=300',
  });
  res.send(renderPage(req));
});

// GET /health ──────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  const row = db.prepare('SELECT COUNT(*) AS n FROM slates').get();
  res.json({
    ok:       true,
    service:  'grin-transporter',
    version:  VERSION,
    network:  cfg.network,
    queued:   row.n,
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
  });
});

// GET /auth/challenge?addr= ────────────────────────────────────────────────────
app.get('/auth/challenge', (req, res) => {
  const addr = String(req.query.addr || '').trim().toLowerCase();
  if (!decodeSlatepackAddress(addr)) {
    return err(res, `Invalid ${HRP}1… slatepack address for this network`, 400);
  }
  // Minting a nonce writes a row, so an unauthenticated caller must not be able
  // to do it in a loop — cap per client AND per address.
  if (!bucketHit(challengeBuckets, clientKey(req), CHALLENGE_PER_CLIENT_MIN, 60 * 1000)) {
    return err(res, 'Too many challenge requests — slow down', 429);
  }
  const open = db.prepare('SELECT COUNT(*) AS n FROM challenges WHERE addr = ? AND expires_at > ?')
                 .get(addr, Date.now()).n;
  if (open >= MAX_OPEN_CHALLENGES_ADDR) {
    return err(res, 'Too many outstanding challenges for this address', 429);
  }
  const nonce = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO challenges (nonce, addr, expires_at) VALUES (?, ?, ?)')
    .run(nonce, addr, Date.now() + CHALLENGE_TTL_MS);
  res.json({ nonce, expires_in: Math.floor(CHALLENGE_TTL_MS / 1000) });
});

// POST /auth  {addr, nonce, signature} ─────────────────────────────────────────
// signature = ed25519 over the UTF-8 bytes of the nonce string, hex-encoded.
app.post('/auth', (req, res) => {
  const body   = req.body || {};
  const addr   = String(body.addr || '').trim().toLowerCase();
  const nonce  = String(body.nonce || '').trim();
  const sig    = String(body.signature || '').trim();
  const client = clientKey(req);
  const tor    = isTorFront(req);

  const pubkey = decodeSlatepackAddress(addr);
  if (!pubkey) return err(res, `Invalid ${HRP}1… slatepack address for this network`, 400);
  if (!/^[0-9a-f]{64}$/.test(nonce)) return err(res, 'Invalid nonce', 400);

  // Throttling failed ownership proofs (R8 / security-checklist item 2).
  //
  // The lockout key is (address, client) — NEVER the address alone. The Script 07
  // pool learned this the hard way: an address-keyed lockout is a remote DoS,
  // because anyone can fail proofs against someone else's address and lock the
  // owner out of their own queue.
  //
  // On the onion front every caller shares one identity, so an (addr, "tor") key
  // would reintroduce exactly that DoS. There the lockout is skipped and a plain
  // front-wide attempt ceiling applies instead: a flood degrades all onion auth
  // equally but cannot single out one address.
  const failKey = `${addr}|${client}`;
  if (tor) {
    if (!bucketHit(torAuthBucket, 'tor', TOR_AUTH_ATTEMPTS_MIN, 60 * 1000)) {
      auditAuth(addr, client, 'throttled');
      return err(res, 'Too many authentication attempts on the onion front — retry shortly', 429);
    }
  } else {
    const f = authFails.get(failKey);
    if (f && f.until > Date.now()) {
      auditAuth(addr, client, 'locked');
      return err(res, 'Too many failed attempts — locked out, retry later', 429);
    }
  }

  const row = db.prepare('SELECT addr, expires_at FROM challenges WHERE nonce = ?').get(nonce);
  db.prepare('DELETE FROM challenges WHERE nonce = ?').run(nonce);   // single-use, always

  const fail = (reason, msg, code) => {
    if (!tor) {
      const now    = Date.now();
      const window = cfg.auth_lock_minutes * 60 * 1000;
      const cur    = authFails.get(failKey);
      // Failures decay: a count older than one lock window starts over, so an
      // occasional typo months apart never accumulates into a lockout.
      const n = (cur && now - cur.firstAt < window ? cur.n : 0) + 1;
      if (n >= cfg.auth_fail_limit) {
        authFails.set(failKey, { n: 0, firstAt: now, until: now + window });
        logLine('WARN', `AUTH_LOCKED addr=${truncAddr(addr)} for ${cfg.auth_lock_minutes}m`);
      } else {
        authFails.set(failKey, { n, firstAt: cur && n > 1 ? cur.firstAt : now, until: 0 });
      }
    }
    auditAuth(addr, client, reason);
    return err(res, msg, code);
  };

  if (!row || row.addr !== addr)      return fail('unknown_challenge', 'Unknown challenge — request a new one', 401);
  if (Date.now() > row.expires_at)    return fail('expired_challenge', 'Challenge expired — request a new one', 401);
  if (!verifyAddrSignature(pubkey, nonce, sig)) {
    logLine('WARN', `AUTH_FAIL addr=${truncAddr(addr)}`);
    return fail('bad_signature', 'Signature verification failed', 401);
  }

  authFails.delete(failKey);
  auditAuth(addr, client, 'ok');
  logLine('INFO', `AUTH_OK addr=${truncAddr(addr)}`);
  res.json(issueToken(addr));
});

// PUT /queue/:addr  {slatepack} — open deposit ─────────────────────────────────
function handleDeposit(req, res) {
  const addr   = qAddr(req);
  const body   = (req.body || {}).slatepack;
  const client = clientKey(req);
  if (!validSlatepackBody(body)) {
    return err(res, `slatepack required: BEGINSLATEPACK…ENDSLATEPACK, max ${cfg.max_slate_bytes} bytes`, 400);
  }
  // The onion front has no nginx in front of it, so nothing else rate-limits it,
  // and the dedupe short-circuit below returns before layer 3 — an attacker could
  // otherwise replay one blob without limit. A front-wide ceiling bounds the CPU
  // and DB cost of that; it cannot be per-caller (one shared identity).
  if (isTorFront(req) && !bucketHit(torAuthBucket, 'tor-deposit', TOR_DEPOSITS_MIN, 60 * 1000)) {
    return err(res, 'Too many deposits on the onion front — retry shortly', 429);
  }

  const trimmed = body.trim();
  const hash    = bodyHash(trimmed);
  const depositor = clientHash(client);

  // Layer 2 — dedupe. An identical blob already waiting is not a new slate; say
  // so idempotently so an agent retrying a timed-out PUT does not burn a slot.
  const existing = db.prepare('SELECT id, created_at FROM slates WHERE recipient = ? AND body_hash = ?')
                     .get(addr, hash);
  if (existing) {
    return res.status(200).json({
      id:         existing.id,
      duplicate:  true,
      expires_at: new Date(existing.created_at + cfg.ttl_hours * 3600 * 1000).toISOString(),
    });
  }

  // Layer 1 — global ceiling.
  const total = db.prepare('SELECT COUNT(*) AS n FROM slates').get().n;
  if (total >= cfg.max_queue_total) {
    logLine('WARN', `STORE_FULL total=${total}`);
    return err(res, 'Store is at capacity — try again later', 503);
  }

  // Layer 3 — per-client hourly quota. Skipped on the onion front, where the
  // identity is shared and the quota would throttle every legitimate caller
  // alongside the abusive one (see the header note on residual risk).
  if (!isTorFront(req) &&
      !bucketHit(depositBuckets, client, cfg.max_deposits_per_ip_hour, 3600 * 1000)) {
    logLine('WARN', `DEPOSIT_QUOTA client=${depositor}`);
    return err(res, 'Deposit quota exceeded for this source — try again later', 429);
  }

  // Layer 4 — fair share. THIS is what stops one source burying a known address:
  // filling a queue now requires as many distinct depositors as slots.
  const mine = db.prepare('SELECT COUNT(*) AS n FROM slates WHERE recipient = ? AND depositor = ?')
                 .get(addr, depositor).n;
  if (mine >= cfg.max_per_depositor_per_addr) {
    logLine('WARN', `DEPOSITOR_CAP addr=${truncAddr(addr)} client=${depositor} held=${mine}`);
    return err(res, 'You already have the maximum pending slates for this recipient', 429);
  }

  // Layer 5 — per-queue depth, the original cap.
  const depth = db.prepare('SELECT COUNT(*) AS n FROM slates WHERE recipient = ?').get(addr).n;
  if (depth >= cfg.max_queue_per_addr) {
    logLine('WARN', `QUEUE_FULL addr=${truncAddr(addr)} depth=${depth}`);
    return err(res, 'Recipient queue is full', 429);
  }

  const now = Date.now();
  let info;
  try {
    info = db.prepare(
      'INSERT INTO slates (recipient, body, created_at, body_hash, depositor) VALUES (?, ?, ?, ?, ?)'
    ).run(addr, trimmed, now, hash, depositor);
  } catch (e) {
    // Unique-index backstop: a concurrent identical deposit won the race.
    const dup = db.prepare('SELECT id, created_at FROM slates WHERE recipient = ? AND body_hash = ?')
                  .get(addr, hash);
    if (dup) {
      return res.status(200).json({
        id:         dup.id,
        duplicate:  true,
        expires_at: new Date(dup.created_at + cfg.ttl_hours * 3600 * 1000).toISOString(),
      });
    }
    logLine('WARN', `DEPOSIT_FAILED addr=${truncAddr(addr)}: ${e.message}`);
    return err(res, 'Could not store slate', 500);
  }
  logLine('INFO', `DEPOSIT addr=${truncAddr(addr)} id=${info.lastInsertRowid} bytes=${Buffer.byteLength(trimmed, 'utf8')}`);
  res.status(201).json({
    id:         Number(info.lastInsertRowid),
    expires_at: new Date(now + cfg.ttl_hours * 3600 * 1000).toISOString(),
  });
}
app.put('/queue/:addr', handleDeposit);
app.post('/queue/:addr', handleDeposit);   // alias for clients that can't PUT

// GET /queue/:addr — owner only ────────────────────────────────────────────────
app.get('/queue/:addr', requireOwner, (req, res) => {
  const addr = qAddr(req);
  // Layer 6 — least-delivered first. Ordering by id alone let junk pin the head
  // of the window forever, because the agent only deletes what it can process.
  // `picked_up` demotes anything already handed out, so a never-seen slate can
  // never be starved by an older one that keeps failing.
  const rows = db.prepare(
    'SELECT id, body, created_at, picked_up FROM slates WHERE recipient = ? ' +
    'ORDER BY picked_up ASC, id ASC LIMIT ?'
  ).all(addr, MAX_LIST_ROWS);
  if (rows.length) {
    // A delivery counter, not a filter: slates are handed out again until the
    // owner DELETEs them, so an agent that crashes mid-poll loses nothing.
    db.prepare(`UPDATE slates SET picked_up = picked_up + 1
                WHERE recipient = ? AND id IN (${rows.map(() => '?').join(',')})`)
      .run(addr, ...rows.map(r => r.id));
  }
  res.json({
    slates: rows.map(r => ({
      id:         r.id,
      slatepack:  r.body,
      created_at: new Date(r.created_at).toISOString(),
      // Deliveries BEFORE this one. Lets the agent retire a blob it keeps
      // failing on instead of re-decoding it every poll until the TTL.
      picked_up:  r.picked_up,
    })),
  });
});

// DELETE /queue/:addr/:id — owner only ─────────────────────────────────────────
app.delete('/queue/:addr/:id', requireOwner, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 1) return err(res, 'Invalid slate id', 400);
  const info = db.prepare('DELETE FROM slates WHERE recipient = ? AND id = ?')
                 .run(qAddr(req), id);
  if (!info.changes) return err(res, 'Slate not found', 404);
  logLine('INFO', `CONSUMED addr=${truncAddr(qAddr(req))} id=${id}`);
  res.json({ deleted: id });
});

// Fallbacks ────────────────────────────────────────────────────────────────────
app.use((req, res) => err(res, 'Not found', 404));
// Express error handler (malformed JSON, oversized body, …) — keep it terse.
app.use((e, _req, res, _next) => {
  const code = e.type === 'entity.too.large' ? 413 : 400;
  err(res, code === 413 ? 'Body too large' : 'Bad request', code);
});

// ── TTL sweep — expired slates, stale challenges, old audit rows ──────────────

function sweep() {
  const cutoff = Date.now() - cfg.ttl_hours * 3600 * 1000;
  const s = db.prepare('DELETE FROM slates WHERE created_at < ?').run(cutoff);
  const c = db.prepare('DELETE FROM challenges WHERE expires_at < ?').run(Date.now());
  const a = db.prepare('DELETE FROM auth_events WHERE ts < ?')
              .run(Date.now() - cfg.auth_log_days * 86400 * 1000);
  pruneBuckets();
  if (s.changes || c.changes || a.changes) {
    logLine('INFO', `SWEEP expired_slates=${s.changes} stale_challenges=${c.changes} old_auth_events=${a.changes}`);
  }
}
setInterval(sweep, 10 * 60 * 1000).unref();
sweep();

// ── Listen — localhost only; nginx/Tor are the public surfaces ────────────────

app.listen(cfg.port, '127.0.0.1', () => {
  logLine('INFO', `Grin Transporter v${VERSION} [${cfg.network}] listening on 127.0.0.1:${cfg.port} ` +
                  `(ttl=${cfg.ttl_hours}h, max_slate=${cfg.max_slate_bytes}B, queue_cap=${cfg.max_queue_per_addr}, ` +
                  `total_cap=${cfg.max_queue_total}, per_depositor=${cfg.max_per_depositor_per_addr})`);
});

if (cfg.tor_port > 0) {
  app.listen(cfg.tor_port, '127.0.0.1', () => {
    logLine('INFO', `Onion front on 127.0.0.1:${cfg.tor_port} — forwarding headers ignored, ` +
                    `deposits share one identity (no per-client quota)`);
  });
}
