'use strict';
/**
 * server.js — Grin Transporter (Script 092): store-and-forward slate queue.
 *
 * A dumb, encrypted blob queue keyed by Slatepack address. The server never
 * sees plaintext, keys, or amounts — deposits are armored slatepacks the
 * sender's wallet already encrypted to the recipient's ed25519 key. This is
 * an HTTP service (NOT email/SMTP): "a queue you PUT to and GET from."
 *
 * Endpoints:
 *   GET    /health                  public — redacted counters only
 *   GET    /auth/challenge?addr=    public — one-time nonce for the address
 *   POST   /auth                    {addr, nonce, signature} → bearer token
 *   PUT    /queue/:addr             public* — deposit ciphertext for addr
 *   GET    /queue/:addr             token   — list pending slates for addr
 *   DELETE /queue/:addr/:id         token   — remove a consumed slate
 *
 * (*) Deposits are intentionally open — anyone may leave an encrypted slate,
 * exactly like anyone may hand you a sealed envelope. Confidentiality is the
 * encryption itself; abuse is bounded by the size cap, the per-recipient
 * queue-depth cap, the TTL sweep, and nginx rate limiting in front.
 *
 * Retrieval/deletion require proof of key ownership (R8): the caller signs a
 * single-use server nonce with the ed25519 key behind their slatepack address
 * (same address-as-identity model as the Script 07 pool). No accounts.
 *
 * Config (JSON file, path via TRANSPORTER_CONF env from the systemd unit):
 *   { "network": "testnet", "port": 7466, "ttl_hours": 336,
 *     "max_slate_bytes": 16384, "max_queue_per_addr": 100 }
 * DB path via TRANSPORTER_DB env. Binds 127.0.0.1 only — nginx is the sole
 * public surface.
 */

const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const { DatabaseSync: Database } = require('node:sqlite');

const VERSION = '0.1.0';

// ── Config ────────────────────────────────────────────────────────────────────

const CONF_PATH = process.env.TRANSPORTER_CONF;
const DB_PATH   = process.env.TRANSPORTER_DB;
if (!CONF_PATH || !DB_PATH) {
  throw new Error('TRANSPORTER_CONF and TRANSPORTER_DB must be set — the systemd unit provides them.');
}

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));
  return {
    network:            raw.network === 'mainnet' ? 'mainnet' : 'testnet',
    port:               parseInt(raw.port, 10) || 7466,
    ttl_hours:          Math.max(1, parseInt(raw.ttl_hours, 10) || 336),          // 14 days
    max_slate_bytes:    Math.max(1024, parseInt(raw.max_slate_bytes, 10) || 16384),
    max_queue_per_addr: Math.max(1, parseInt(raw.max_queue_per_addr, 10) || 100),
  };
}
const cfg = loadConfig();

// Mainnet addresses are bech32 with HRP "grin", testnet "tgrin".
const HRP = cfg.network === 'mainnet' ? 'grin' : 'tgrin';

const CHALLENGE_TTL_MS = 120 * 1000;       // nonce must be signed within 2 min
const TOKEN_TTL_MS     = 15 * 60 * 1000;   // bearer token lifetime
const MAX_LIST_ROWS    = 20;               // slates returned per GET

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

  CREATE TABLE IF NOT EXISTS challenges (
    nonce      TEXT PRIMARY KEY,
    addr       TEXT    NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

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

// ── Slatepack body validation — armored ciphertext only, size-capped ──────────

function validSlatepackBody(body) {
  return typeof body === 'string'
    && body.length > 0
    && Buffer.byteLength(body, 'utf8') <= cfg.max_slate_bytes
    && body.includes('BEGINSLATEPACK')
    && body.includes('ENDSLATEPACK');
}

function truncAddr(addr) { return addr.slice(0, 12) + '…' + addr.slice(-4); }

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');                       // nginx sets X-Forwarded-For
app.use(express.json({ limit: cfg.max_slate_bytes + 4096 }));

function err(res, msg, code = 400) { return res.status(code).json({ error: msg }); }

// Middleware: validate :addr for this network on all /queue routes.
app.use('/queue/:addr', (req, res, next) => {
  if (!decodeSlatepackAddress(req.params.addr)) {
    return err(res, `Invalid ${HRP}1… slatepack address for this network`, 400);
  }
  req.params.addr = req.params.addr.trim().toLowerCase();
  next();
});

// Middleware factory: require a valid bearer token for the addressed queue.
function requireOwner(req, res, next) {
  const auth  = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!verifyToken(token, req.params.addr)) {
    return err(res, 'Invalid or expired token — re-authenticate via /auth/challenge', 401);
  }
  next();
}

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
  const nonce = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO challenges (nonce, addr, expires_at) VALUES (?, ?, ?)')
    .run(nonce, addr, Date.now() + CHALLENGE_TTL_MS);
  res.json({ nonce, expires_in: Math.floor(CHALLENGE_TTL_MS / 1000) });
});

// POST /auth  {addr, nonce, signature} ─────────────────────────────────────────
// signature = ed25519 over the UTF-8 bytes of the nonce string, hex-encoded.
app.post('/auth', (req, res) => {
  const body  = req.body || {};
  const addr  = String(body.addr || '').trim().toLowerCase();
  const nonce = String(body.nonce || '').trim();
  const sig   = String(body.signature || '').trim();

  const pubkey = decodeSlatepackAddress(addr);
  if (!pubkey) return err(res, `Invalid ${HRP}1… slatepack address for this network`, 400);
  if (!/^[0-9a-f]{64}$/.test(nonce)) return err(res, 'Invalid nonce', 400);

  const row = db.prepare('SELECT addr, expires_at FROM challenges WHERE nonce = ?').get(nonce);
  db.prepare('DELETE FROM challenges WHERE nonce = ?').run(nonce);   // single-use, always
  if (!row || row.addr !== addr) return err(res, 'Unknown challenge — request a new one', 401);
  if (Date.now() > row.expires_at) return err(res, 'Challenge expired — request a new one', 401);

  if (!verifyAddrSignature(pubkey, nonce, sig)) {
    logLine('WARN', `AUTH_FAIL addr=${truncAddr(addr)}`);
    return err(res, 'Signature verification failed', 401);
  }
  logLine('INFO', `AUTH_OK addr=${truncAddr(addr)}`);
  res.json(issueToken(addr));
});

// PUT /queue/:addr  {slatepack} — open deposit ─────────────────────────────────
function handleDeposit(req, res) {
  const addr = req.params.addr;
  const body = (req.body || {}).slatepack;
  if (!validSlatepackBody(body)) {
    return err(res, `slatepack required: BEGINSLATEPACK…ENDSLATEPACK, max ${cfg.max_slate_bytes} bytes`, 400);
  }
  const depth = db.prepare('SELECT COUNT(*) AS n FROM slates WHERE recipient = ?').get(addr).n;
  if (depth >= cfg.max_queue_per_addr) {
    logLine('WARN', `QUEUE_FULL addr=${truncAddr(addr)} depth=${depth}`);
    return err(res, 'Recipient queue is full', 429);
  }
  const now  = Date.now();
  const info = db.prepare('INSERT INTO slates (recipient, body, created_at) VALUES (?, ?, ?)')
                 .run(addr, body.trim(), now);
  logLine('INFO', `DEPOSIT addr=${truncAddr(addr)} id=${info.lastInsertRowid} bytes=${Buffer.byteLength(body, 'utf8')}`);
  res.status(201).json({
    id:         Number(info.lastInsertRowid),
    expires_at: new Date(now + cfg.ttl_hours * 3600 * 1000).toISOString(),
  });
}
app.put('/queue/:addr', handleDeposit);
app.post('/queue/:addr', handleDeposit);   // alias for clients that can't PUT

// GET /queue/:addr — owner only ────────────────────────────────────────────────
app.get('/queue/:addr', requireOwner, (req, res) => {
  const addr = req.params.addr;
  const rows = db.prepare(
    'SELECT id, body, created_at FROM slates WHERE recipient = ? ORDER BY id LIMIT ?'
  ).all(addr, MAX_LIST_ROWS);
  if (rows.length) {
    db.prepare(`UPDATE slates SET picked_up = 1
                WHERE recipient = ? AND id IN (${rows.map(() => '?').join(',')})`)
      .run(addr, ...rows.map(r => r.id));
  }
  res.json({
    slates: rows.map(r => ({
      id:         r.id,
      slatepack:  r.body,
      created_at: new Date(r.created_at).toISOString(),
    })),
  });
});

// DELETE /queue/:addr/:id — owner only ─────────────────────────────────────────
app.delete('/queue/:addr/:id', requireOwner, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 1) return err(res, 'Invalid slate id', 400);
  const info = db.prepare('DELETE FROM slates WHERE recipient = ? AND id = ?')
                 .run(req.params.addr, id);
  if (!info.changes) return err(res, 'Slate not found', 404);
  logLine('INFO', `CONSUMED addr=${truncAddr(req.params.addr)} id=${id}`);
  res.json({ deleted: id });
});

// Fallbacks ────────────────────────────────────────────────────────────────────
app.use((req, res) => err(res, 'Not found', 404));
// Express error handler (malformed JSON, oversized body, …) — keep it terse.
app.use((e, _req, res, _next) => {
  const code = e.type === 'entity.too.large' ? 413 : 400;
  err(res, code === 413 ? 'Body too large' : 'Bad request', code);
});

// ── TTL sweep — expired slates + stale challenges ─────────────────────────────

function sweep() {
  const cutoff = Date.now() - cfg.ttl_hours * 3600 * 1000;
  const s = db.prepare('DELETE FROM slates WHERE created_at < ?').run(cutoff);
  const c = db.prepare('DELETE FROM challenges WHERE expires_at < ?').run(Date.now());
  if (s.changes || c.changes) {
    logLine('INFO', `SWEEP expired_slates=${s.changes} stale_challenges=${c.changes}`);
  }
}
setInterval(sweep, 10 * 60 * 1000).unref();
sweep();

// ── Listen — localhost only; nginx/Tor are the public surfaces ────────────────

app.listen(cfg.port, '127.0.0.1', () => {
  logLine('INFO', `Grin Transporter v${VERSION} [${cfg.network}] listening on 127.0.0.1:${cfg.port} ` +
                  `(ttl=${cfg.ttl_hours}h, max_slate=${cfg.max_slate_bytes}B, queue_cap=${cfg.max_queue_per_addr})`);
});
