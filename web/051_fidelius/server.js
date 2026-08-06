'use strict';
/**
 * Grin Web Wallet — Linux port for Grin-Node-Toolkit Script 051.
 *
 * Lifted from GrinSuite (noobvie/GrinSuite:web/03_web_wallet/server.js,
 * upstream version 2.0.0) and adapted for:
 *   - Linux paths (/opt/grin/fidelius/...) — no D:\Grin\... drive scan
 *   - systemd / apt-managed Tor (no NSSM, no sc.exe, no Tor service install)
 *   - Reverse proxy via nginx (Host/Origin guard reads WW_PUBLIC_HOST env)
 *   - grin-wallet `linux-x86_64.tar.gz` GitHub asset (not `win-x86_64.zip`)
 *
 * Listens on 127.0.0.1:7420 by default. Public traffic comes via nginx
 * Basic Auth → reverse_proxy 127.0.0.1:7420. The Node process itself does
 * NOT bind any public interface.
 */

const crypto              = require('crypto');
const fs                  = require('fs');
const path                = require('path');
const https               = require('https');
const os                  = require('os');
const net                 = require('net');
const { spawn, execSync } = require('child_process');
const express             = require('express');
const transporter         = require('./transporter');

// ── Paths (toolkit-relative, no drive scanning) ───────────────────────────────
const WEBWALLET_ROOT = process.env.WW_ROOT || '/opt/grin/fidelius';
const WALLETS_JSON   = path.join(WEBWALLET_ROOT, 'wallets_info.json');
const CLIENT_DIR     = path.join(__dirname, 'client');
const PORT           = parseInt(process.env.GRIN_WEB_PORT || '7420', 10);

// grin-wallet binary lives directly under WEBWALLET_ROOT (installed by Script 051).
const BINARY_PATH    = path.join(WEBWALLET_ROOT, 'grin-wallet');

// Linux node install paths (Script 01 lays these out). Used as fallback when
// the wallet's TOML doesn't pin check_node_api_http_addr to a specific URL.
const NODE_DIR_FALLBACKS = {
    mainnet: ['/opt/grin/node/mainnet-prune', '/opt/grin/node/mainnet-full'],
    testnet: ['/opt/grin/node/testnet-prune'],
};

// Curated public nodes. MUST stay in sync with PUBLIC_NODES in client/app.js —
// this list is also the allowlist for /api/node/ping (see nodePingAllowed), so a
// host the client offers but the server doesn't know would ping as unreachable.
const MAINNET_NODES = ['api.grin.money','api.grinily.com','api.onlygrins.com',
                       'api.grinnode.org','main.gri.mw','grincoin.org'];
const TESTNET_NODES = ['testapi.grin.money','testapi.grinily.com','testapi.onlygrins.com',
                       'testnet.grincoin.org','test.gri.mw'];

// ── Session management ────────────────────────────────────────────────────────
// Map<walletName, { passphrase:string, listenerProc:ChildProcess|null, ownerProc:ChildProcess|null }>
const sessions = new Map();
function getSession(n) { return sessions.get(n) || null; }
function ensureSession(n) {
    if (!sessions.has(n)) sessions.set(n, { passphrase: '', listenerProc: null, ownerProc: null, lastSeen: 0 });
    // Unlocking IS activity, and the idle middleware runs before this session
    // exists on a first connect — so stamp it here or the backstop would expire
    // a freshly-unlocked wallet.
    sessions.get(n).lastSeen = Date.now();
    return sessions.get(n);
}
function isAlive(proc) { return !!(proc && proc.exitCode === null && !proc.killed); }

// Passphrase is in-memory only. No `.wallet_pass` disk fallback — keep the
// wallet "unlocked" by keeping server.js running. systemd restart = re-unlock.
function getPassphrase(walletName) {
    const s = sessions.get(walletName);
    return s && s.passphrase ? s.passphrase : '';
}

// ── Registry ─────────────────────────────────────────────────────────────────

let registryCache = { data: null, mtimeMs: 0 };
function loadRegistry() {
    try {
        const st = fs.statSync(WALLETS_JSON);
        if (registryCache.data && registryCache.mtimeMs === st.mtimeMs) return registryCache.data;
        const data = JSON.parse(fs.readFileSync(WALLETS_JSON, 'utf8'));
        registryCache = { data, mtimeMs: st.mtimeMs };
        return data;
    } catch { return { wallets: [] }; }
}
function saveRegistry(r) {
    try {
        fs.mkdirSync(WEBWALLET_ROOT, { recursive: true });
        fs.writeFileSync(WALLETS_JSON, JSON.stringify(r, null, 2), 'utf8');
        try { fs.chmodSync(WALLETS_JSON, 0o600); } catch {}
        registryCache = { data: null, mtimeMs: 0 };
    } catch (e) { log('ERROR', 'SAVE_REGISTRY_FAIL ' + e.message); throw e; }
}
function loadWallets() { const r = loadRegistry(); return Array.isArray(r.wallets) ? r.wallets : []; }
function findWallet(n) { return loadWallets().find(w => w.name === n) || null; }

// Every /api/wallet/:name route — including DELETE ?files=1, which destroys a
// seed — resolves by NAME ALONE, and `sessions` is keyed by name too. So a name
// must be unique across BOTH networks, not just within one: with a mainnet and a
// testnet wallet both called "savings", findWallet() silently returns whichever
// is first in the registry, the second is unreachable from the UI, and deleting
// the row you can see destroys the wallet you can't. Registration goes through
// this helper so write-config and import can't drift apart.
function nameTaken(name) { return loadWallets().some(w => w.name === name); }

// A registry written before the rule above can already hold a collision. Refuse
// to route those rather than guess: flag them loudly at startup and let
// /api/wallets mark them so the UI can tell the operator to rename one.
function duplicateWalletNames() {
    const seen = new Map();
    for (const w of loadWallets()) seen.set(w.name, (seen.get(w.name) || 0) + 1);
    return [...seen.entries()].filter(([, n]) => n > 1).map(([n]) => n);
}
function getBinaryPath() { return BINARY_PATH; }

// Probe the toolkit's per-network node directories for a secret file.
function findNodeSecret(network, fileName /* '.api_secret' | '.foreign_api_secret' */) {
    for (const d of (NODE_DIR_FALLBACKS[network] || [])) {
        const p = path.join(d, fileName);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// ── File helpers ──────────────────────────────────────────────────────────────

function readFileOrEmpty(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } }
function readOwnerSecret(d) {
    const s = readFileOrEmpty(path.join(d, '.owner_api_secret'));
    if (!s) throw new Error(`Owner API secret missing in ${d}`);
    return s;
}
function readForeignSecret(d) {
    const s = readFileOrEmpty(path.join(d, '.foreign_api_secret'));
    if (!s) throw new Error(`Foreign API secret missing in ${d}`);
    return s;
}

// ── Address book (per-wallet sidecar) ────────────────────────────────────────

const ADDR_RE = /^(?:grin|tgrin)1[0-9a-z]{50,}$/i;
function addressNetwork(addr) {
    if (!addr) return null;
    if (/^tgrin1/i.test(addr)) return 'testnet';
    if (/^grin1/i.test(addr))  return 'mainnet';
    return null;
}
function addressBookPath(walletDir) { return path.join(walletDir, '.address_book.json'); }

function loadAddressBook(walletDir) {
    try { const j = JSON.parse(fs.readFileSync(addressBookPath(walletDir), 'utf8')); return (j && typeof j === 'object') ? j : {}; }
    catch { return {}; }
}
function saveAddressBook(walletDir, book) {
    fs.writeFileSync(addressBookPath(walletDir), JSON.stringify(book, null, 2), 'utf8');
}
// `proven` = this send completed end-to-end and the address demonstrably works.
// It gates the "first send to this address" warning, so only a rail that gets an
// answer may set it. A Tor send is proven (it broadcast); a Transporter send is
// NOT — it was merely queued, and an address that is wrong, abandoned, or never
// polled looks exactly the same at this point. Marking it proven would retire
// the large-amount warning on the strength of a payment nobody has collected.
function recordAddressSend(walletDir, dest, amount, proven = true) {
    if (!ADDR_RE.test(dest)) return;
    const book = loadAddressBook(walletDir);
    const now  = new Date().toISOString();
    const cur  = book[dest] || { firstSeen: now, label: '', totalSent: '0', sendCount: 0, testPassed: false };
    cur.lastUsed   = now;
    cur.sendCount  = (Number(cur.sendCount) || 0) + 1;
    cur.totalSent  = (Number(cur.totalSent || 0) + Number(amount || 0)).toString();
    if (proven) cur.testPassed = true;
    book[dest] = cur;
    try { saveAddressBook(walletDir, book); }
    catch (e) { log('ERROR', 'ADDR_BOOK_SAVE_FAIL ' + e.message); }
}

// The other half of `proven`. An address we sent to via the Transporter earns
// its proof later, when THEIR reply comes back and finalizes — that is the first
// moment we know a real wallet is behind it. Deliberately does not touch
// sendCount/totalSent: the send was already counted when it was queued.
function markAddressProven(walletDir, dest) {
    if (!ADDR_RE.test(dest)) return;
    const book = loadAddressBook(walletDir);
    if (!book[dest] || book[dest].testPassed) return;
    book[dest].testPassed = true;
    try { saveAddressBook(walletDir, book); }
    catch (e) { log('ERROR', 'ADDR_BOOK_SAVE_FAIL ' + e.message); }
}

// ── Network helpers ───────────────────────────────────────────────────────────

function isPortListening(port) {
    return new Promise(resolve => {
        const s = net.createConnection(port, '127.0.0.1');
        const t = setTimeout(() => { try { s.destroy(); } catch {} resolve(false); }, 600);
        s.once('connect',  () => { clearTimeout(t); s.destroy(); resolve(true); });
        s.once('error',    () => { clearTimeout(t); resolve(false); });
    });
}
function waitForPort(port, ms = 6000) {
    return new Promise((resolve, reject) => {
        const dl = Date.now() + ms;
        function try_() {
            const s = net.createConnection(port, '127.0.0.1');
            s.once('connect', () => { s.destroy(); resolve(); });
            s.once('error',   () => { if (Date.now() >= dl) reject(new Error(`Port ${port} not open after ${ms}ms`)); else setTimeout(try_, 300); });
        }
        try_();
    });
}

async function waitForJsonRpcReady(port, kind = 'owner', ms = 10000) {
    await waitForPort(port, ms);
    const dl = Date.now() + ms;
    const url  = 'http://127.0.0.1:' + port + (kind === 'owner' ? '/v3/owner' : '/v2/foreign');
    const probe = kind === 'owner'
        ? { jsonrpc: '2.0', id: 1, method: 'init_secure_api', params: { ecdh_pubkey: '02'.padEnd(66, '0') } }
        : { jsonrpc: '2.0', id: 1, method: 'get_version', params: [] };
    while (Date.now() < dl) {
        try {
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(probe),
                signal: AbortSignal.timeout(1500),
            });
            if (r.status > 0) return;
        } catch {}
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('JSON-RPC not ready on port ' + port + ' after ' + ms + 'ms');
}

// ── Download / extract helpers ────────────────────────────────────────────────

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        function get(u) {
            https.get(u, { headers: { 'User-Agent': 'grin-node-toolkit/051' } }, res => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return get(res.headers.location);
                if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
                let body = ''; res.setEncoding('utf8');
                res.on('data', d => body += d); res.on('end', () => resolve(body)); res.on('error', reject);
            }).on('error', reject);
        }
        get(url);
    });
}
function downloadFile(url, dest, onPct) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        function get(u) {
            https.get(u, { headers: { 'User-Agent': 'grin-node-toolkit/051' } }, res => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return get(res.headers.location);
                if (res.statusCode !== 200) { file.close(); return reject(new Error('HTTP ' + res.statusCode)); }
                const total = parseInt(res.headers['content-length'] || '0', 10);
                let got = 0;
                res.on('data', c => { got += c.length; if (total && onPct) onPct(Math.round(got * 100 / total)); });
                res.pipe(file);
                file.once('finish', () => file.close(resolve));
                res.on('error', reject);
            }).on('error', reject);
        }
        get(url);
    });
}
function findInDir(dir, name) {
    if (!fs.existsSync(dir)) return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isFile() && e.name === name) return fp;
        if (e.isDirectory()) { const r = findInDir(fp, name); if (r) return r; }
    }
    return null;
}
function sseHeaders(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    return d => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(d) + '\n\n'); };
}

// ── TOML patchers ─────────────────────────────────────────────────────────────

function patchTomlKey(content, key, rawValue) {
    const re = new RegExp('^#?\\s*' + key + '\\s*=.*$', 'm');
    const line = key + ' = ' + rawValue;
    return re.test(content) ? content.replace(re, line) : content + '\n' + line;
}

function applyWalletTomlPatches(wallet) {
    const tomlPath = path.join(wallet.dir, 'grin-wallet.toml');
    if (!fs.existsSync(tomlPath)) throw new Error('grin-wallet.toml not found after init');
    let c = fs.readFileSync(tomlPath, 'utf8');
    c = patchTomlKey(c, 'api_listen_port',       String(wallet.foreignPort));
    c = patchTomlKey(c, 'owner_api_listen_port',  String(wallet.ownerPort));
    const nodeUrl = wallet.nodeUrl || (wallet.network === 'testnet' ? 'http://127.0.0.1:13413' : 'http://127.0.0.1:3413');
    c = patchTomlKey(c, 'check_node_api_http_addr', '"' + nodeUrl + '"');
    if (/127\.0\.0\.1|localhost/.test(nodeUrl)) {
        const sp = findNodeSecret(wallet.network, '.foreign_api_secret');
        if (sp) c = patchTomlKey(c, 'node_api_secret_path', '"' + sp + '"');
    }
    fs.writeFileSync(tomlPath, c, 'utf8');
    log('INFO', 'TOML_PATCHED dir=' + wallet.dir);
}

// ── ECDH Owner API session ─────────────────────────────────────────────────────

// `passwordOverride` lets a caller PROVE a passphrase instead of spending the one already
// held in the session. open_wallet decrypts the seed, so a returned token is proof the
// passphrase is correct — that is what /export uses as its authorisation check. Callers that
// omit it keep the normal behaviour: use whatever the browser session unlocked with.
// An empty string is a legitimate override (grin-wallet permits a blank passphrase), so the
// test is `typeof`, never truthiness — `||` here would silently fall back to the session and
// turn a wrong-passphrase export into a successful one.
async function ownerApiSession(wallet, passwordOverride) {
    const ownerUrl = 'http://127.0.0.1:' + wallet.ownerPort + '/v3/owner';
    const authHdr  = 'Basic ' + Buffer.from('grin:' + readOwnerSecret(wallet.dir)).toString('base64');
    const headers  = { 'Content-Type': 'application/json', Authorization: authHdr };

    const ecdh = crypto.createECDH('secp256k1');
    ecdh.generateKeys();

    let initRes;
    try {
        initRes = await fetch(ownerUrl, {
            method: 'POST', headers,
            body:   JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'init_secure_api',
                                     params: { ecdh_pubkey: ecdh.getPublicKey('hex', 'compressed') } }),
            signal: AbortSignal.timeout(10000),
        });
    } catch (e) {
        if (e.cause?.code === 'ECONNREFUSED' || e.code === 'ECONNREFUSED')
            throw new Error('Owner API not running on port ' + wallet.ownerPort);
        throw e;
    }
    const initJson = JSON.parse(await initRes.text());
    if (initJson.error) throw new Error('init_secure_api: ' + (initJson.error.message || JSON.stringify(initJson.error)));
    const sharedKey = ecdh.computeSecret(Buffer.from(initJson.result.Ok || initJson.result, 'hex'));

    const password = (typeof passwordOverride === 'string')
        ? passwordOverride
        : getPassphrase(wallet.name);
    const token = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'open_wallet',
        { name: null, password });
    return { headers, sharedKey, ownerUrl, token };
}

async function encryptedOwnerCall(headers, sharedKey, ownerUrl, method, params) {
    const nonce = crypto.randomBytes(12), nonceHex = nonce.toString('hex');
    const inner = JSON.stringify({ jsonrpc: '2.0', id: nonceHex, method, params });
    const cipher = crypto.createCipheriv('aes-256-gcm', sharedKey, nonce);
    const enc = Buffer.concat([cipher.update(inner, 'utf8'), cipher.final()]);
    const body_enc = Buffer.concat([enc, cipher.getAuthTag()]).toString('base64');

    // Tor sends can take 30-60s on the recipient circuit. Bump for that path.
    const isTorSend = method === 'init_send_tx'
        && params && params.args && params.args.send_args && params.args.send_args.method === 'tor';
    const timeoutMs = isTorSend ? 120000 : 30000;

    const res = await fetch(ownerUrl, {
        method: 'POST', headers,
        body:   JSON.stringify({ jsonrpc: '2.0', id: nonceHex,
                                 method: 'encrypted_request_v3', params: { nonce: nonceHex, body_enc } }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const encJson = JSON.parse(await res.text());
    if (encJson.error) throw new Error('encrypted_request_v3(' + method + '): ' + (encJson.error.message || JSON.stringify(encJson.error)));

    const { nonce: rNonce, body_enc: rBodyEnc } = encJson.result.Ok || encJson.result;
    const rBuf = Buffer.from(rBodyEnc, 'base64');
    const dec  = crypto.createDecipheriv('aes-256-gcm', sharedKey, Buffer.from(rNonce, 'hex'));
    dec.setAuthTag(rBuf.slice(-16));
    const inner2 = JSON.parse(Buffer.concat([dec.update(rBuf.slice(0, -16)), dec.final()]).toString('utf8'));
    if (inner2.error) throw new Error('Owner API ' + method + ': ' + (inner2.error.message || JSON.stringify(inner2.error)));
    if (inner2.result?.Err) throw new Error('Owner API ' + method + ': ' + JSON.stringify(inner2.result.Err));
    return inner2.result?.Ok !== undefined ? inner2.result.Ok : inner2.result;
}

// ── Express app ────────────────────────────────────────────────────────────────

const app = express();
app.set('trust proxy', 'loopback');     // nginx on the same host

// BODY SIZE — one small global cap, one deliberate exception.
// Every endpoint here takes short JSON except /api/wallet/import, which carries an entire
// .gws backup as base64 (~4/3 of the file size). A single permissive global limit would hand
// every other route a cheap memory-amplification vector, so the exception is mounted per-route.
//
// The global parser must SKIP the import path rather than being raised: whichever parser runs
// first consumes the stream, so a 32kb global would 413 a restore before the route was ever
// reached. That mismatch is exactly the bug this replaces — the client happily accepted files
// up to 5 MB that the server could never receive.
const JSON_LIMIT_DEFAULT = '32kb';
const JSON_LIMIT_IMPORT  = '8mb';        // 5 MB client cap × ~1.34 base64 overhead, rounded up
const IMPORT_PATH        = '/api/wallet/import';
const jsonDefault = express.json({ limit: JSON_LIMIT_DEFAULT });
const jsonImport  = express.json({ limit: JSON_LIMIT_IMPORT });
app.use((req, res, next) =>
    (req.method === 'POST' && req.path === IMPORT_PATH)
        ? jsonImport(req, res, next)
        : jsonDefault(req, res, next));

// Body-parser errors surface here, before any route runs. Without this, an oversize body gets
// Express's default HTML error page, which the client's `resp.json()` cannot read — the user
// would see a bare "HTTP 413" with no hint about what to do.
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        const cap = (req.path === IMPORT_PATH) ? JSON_LIMIT_IMPORT : JSON_LIMIT_DEFAULT;
        return apiErr(res, 'Request body too large (limit ' + cap + ')', 413);
    }
    if (err && err.type === 'entity.parse.failed') return apiErr(res, 'Malformed JSON body', 400);
    return next(err);
});

function apiErr(res, msg, code = 400) { return res.status(code).json({ error: msg }); }
function log(lv, msg) { process.stdout.write('[' + new Date().toISOString().slice(0,19) + '] [' + lv + '] ' + msg + '\n'); }
function validateSlatepack(s) { return typeof s === 'string' && s.length <= 16384 && s.includes('BEGINSLATEPACK') && s.includes('ENDSLATEPACK'); }

// ── Security: Host + Origin guard (DNS-rebinding defense) ────────────────────
// Localhost entries always allowed (ssh -L tunnels, server-local curl).
// Public host added via env so nginx-proxied requests pass.
//   WW_PUBLIC_HOST=wallet.example.com    (no scheme; matches Host: header)
//   WW_PUBLIC_ORIGIN=https://wallet.example.com
const ALLOWED_HOSTS = new Set([
    '127.0.0.1:' + PORT, 'localhost:' + PORT, '[::1]:' + PORT,
]);
const ALLOWED_ORIGINS = new Set([
    'http://127.0.0.1:' + PORT, 'http://localhost:' + PORT, 'http://[::1]:' + PORT,
]);
if (process.env.WW_PUBLIC_HOST) {
    const h = process.env.WW_PUBLIC_HOST.toLowerCase();
    ALLOWED_HOSTS.add(h);                       // bare host (e.g. proxied behind 443)
    ALLOWED_HOSTS.add(h + ':443');
    ALLOWED_HOSTS.add(h + ':80');
}
if (process.env.WW_PUBLIC_ORIGIN) {
    ALLOWED_ORIGINS.add(process.env.WW_PUBLIC_ORIGIN.toLowerCase().replace(/\/$/, ''));
}

app.use((req, res, next) => {
    const host = (req.headers.host || '').toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) {
        log('WARN', 'REJECTED_HOST host=' + host + ' path=' + req.path);
        return res.status(400).json({ error: 'Invalid Host header' });
    }
    const m = req.method.toUpperCase();
    if (m === 'POST' || m === 'PUT' || m === 'DELETE' || m === 'PATCH') {
        const origin  = (req.headers.origin || '').toLowerCase().replace(/\/$/, '');
        const referer = (req.headers.referer || '').toLowerCase();
        const ok = (origin && ALLOWED_ORIGINS.has(origin))
                || (!origin && referer && [...ALLOWED_ORIGINS].some(o => referer.startsWith(o)));
        if (!ok) {
            log('WARN', 'REJECTED_ORIGIN origin=' + (origin || '-') + ' referer=' + (referer || '-') + ' path=' + req.path);
            return res.status(403).json({ error: 'Cross-origin request rejected' });
        }
    }
    next();
});

// ── Rate limit on /connect ────────────────────────────────────────────────────
const connectAttempts = new Map();
function checkConnectRate(ip, wallet) {
    const key = ip + '|' + wallet;
    const now = Date.now();
    const arr = (connectAttempts.get(key) || []).filter(t => now - t < 60_000);
    if (arr.length >= 5) return { blocked: true, retryAfter: Math.ceil((60_000 - (now - arr[0])) / 1000) };
    arr.push(now);
    connectAttempts.set(key, arr);
    return { blocked: false };
}
function clearConnectRate(ip, wallet) { connectAttempts.delete(ip + '|' + wallet); }

// ── Server-side idle backstop ────────────────────────────────────────────────
// app.js already auto-locks on real user input (mousemove/keydown/…) — that is
// the primary control and the right signal. But it only runs while a TAB IS
// OPEN: close the browser, or lose it to a crash, and nothing ever fires, so the
// passphrase sits in this process's memory until systemd restarts it. This is
// the backstop for that case, deliberately longer than the client's window so
// the client normally wins.
//
// Idle is measured on DELIBERATE ACTIONS, never on request traffic: the UI polls
// /api/wallets, /api/wallet/:name/status, /api/node/* and /api/price on timers,
// so counting those would mean a forgotten open tab renews the session forever —
// which is the whole failure this is meant to catch.
//
// Expiry zeroes the passphrase ONLY. Listener/owner children keep running, so
// inbound receiving survives an auto-lock; spending needs a re-unlock.
const IDLE_LOCK_MIN = (() => {
    const v = parseInt(process.env.WW_IDLE_LOCK_MINUTES || '', 10);
    return Number.isFinite(v) && v >= 0 ? v : 60;
})();
const IDLE_GET_ACTIONS = /^\/api\/wallet\/[^/]+\/(txs|outputs|locked-outputs|accounts|payment-proof)/;

function touchSession(name) {
    const s = sessions.get(name);
    if (s) s.lastSeen = Date.now();
}

app.use((req, res, next) => {
    if (IDLE_LOCK_MIN > 0 && req.path.startsWith('/api/wallet/')) {
        const m = req.method.toUpperCase();
        const isAction = m !== 'GET' || IDLE_GET_ACTIONS.test(req.path);
        if (isAction) {
            const name = decodeURIComponent(req.path.split('/')[3] || '');
            if (name) touchSession(name);
        }
    }
    next();
});

if (IDLE_LOCK_MIN > 0) {
    setInterval(() => {
        const cutoff = Date.now() - IDLE_LOCK_MIN * 60_000;
        for (const [name, s] of sessions) {
            if (!s.passphrase) continue;
            if ((s.lastSeen || 0) > cutoff) continue;
            s.passphrase = '';
            log('INFO', 'IDLE_LOCK wallet=' + name + ' after=' + IDLE_LOCK_MIN + 'min');
        }
    }, 60_000).unref();
}

app.use(express.static(CLIENT_DIR));

// ── Setup: grin-wallet binary ─────────────────────────────────────────────────

app.get('/api/setup/binary-status', (_req, res) => {
    const installed = fs.existsSync(BINARY_PATH);
    let version = '';
    if (installed) {
        try { version = execSync('"' + BINARY_PATH + '" --version', { timeout: 5000, encoding: 'utf8' }).trim().split('\n')[0]; }
        catch { version = 'unknown'; }
    }
    res.json({ installed, version, binaryPath: BINARY_PATH });
});

app.post('/api/setup/install-binary', async (req, res) => {
    const send = sseHeaders(res);
    try {
        send({ stage: 'checking', msg: 'Querying GitHub for latest release...' });
        const gh    = JSON.parse(await httpsGet('https://api.github.com/repos/mimblewimble/grin-wallet/releases/latest'));
        const asset = (gh.assets || []).find(a => /linux-x86_64.*\.tar\.gz$/i.test(a.name));
        if (!asset) throw new Error('No linux-x86_64 tar.gz in latest release');
        const version = gh.tag_name || 'unknown';

        fs.mkdirSync(WEBWALLET_ROOT, { recursive: true });
        const tempTar = path.join(os.tmpdir(), 'grin-wallet-' + Date.now() + '.tar.gz');
        const tempDir = path.join(os.tmpdir(), 'grin-wallet-extract-' + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });

        send({ stage: 'downloading', percent: 0, version });
        await downloadFile(asset.browser_download_url, tempTar, p => send({ stage: 'downloading', percent: p }));

        send({ stage: 'extracting', msg: 'Extracting...' });
        execSync('tar -xzf "' + tempTar + '" -C "' + tempDir + '"', { timeout: 120000 });
        fs.unlinkSync(tempTar);

        const exePath = findInDir(tempDir, 'grin-wallet');
        if (!exePath) throw new Error('grin-wallet not found in archive');
        fs.copyFileSync(exePath, BINARY_PATH);
        fs.chmodSync(BINARY_PATH, 0o755);
        fs.rmSync(tempDir, { recursive: true, force: true });

        log('INFO', 'BINARY_INSTALLED version=' + version + ' path=' + BINARY_PATH);
        send({ stage: 'done', version, binaryPath: BINARY_PATH });
        res.end();
    } catch (e) {
        log('ERROR', 'BINARY_INSTALL_FAIL ' + e.message);
        send({ error: e.message }); res.end();
    }
});

// ── Setup: wallet directory ───────────────────────────────────────────────────

// All wallet dirs MUST live under WEBWALLET_ROOT. Defense against an
// authenticated client passing `dir = "/etc"` (would mkdir /etc and write
// wallet files there) or `dir = "../../"` to escape the wallet root.
const _RESOLVED_ROOT = path.resolve(WEBWALLET_ROOT);
function _isInsideRoot(dir) {
    if (typeof dir !== 'string' || !dir) return false;
    const resolved = path.resolve(dir);
    return resolved === _RESOLVED_ROOT || resolved.startsWith(_RESOLVED_ROOT + path.sep);
}

app.get('/api/setup/default-dir', (req, res) => {
    const { network, name } = req.query;
    if (!network || !name) return apiErr(res, 'network and name required');
    if (!/^[a-zA-Z0-9\-_]+$/.test(name)) return apiErr(res, 'Invalid wallet name');
    res.json({ dir: path.join(WEBWALLET_ROOT, 'wallet_' + network + '_' + name) });
});

app.post('/api/setup/check-dir', (req, res) => {
    const { dir } = req.body;
    if (!dir) return apiErr(res, 'dir required');
    if (!_isInsideRoot(dir)) return apiErr(res, 'dir must be inside ' + _RESOLVED_ROOT);
    const exists        = fs.existsSync(dir);
    const hasWalletData = exists && fs.existsSync(path.join(dir, 'wallet_data'));
    const hasSeed       = exists && fs.existsSync(path.join(dir, 'wallet_data', 'wallet.seed'));
    res.json({ exists, hasWalletData, hasSeed });
});

app.post('/api/setup/rename-dir', (req, res) => {
    const { dir } = req.body;
    if (!dir || !fs.existsSync(dir)) return apiErr(res, 'dir not found');
    if (!_isInsideRoot(dir)) return apiErr(res, 'dir must be inside ' + _RESOLVED_ROOT);
    const newDir = dir + '_old_' + Date.now();
    try { fs.renameSync(dir, newDir); res.json({ ok: true, renamedTo: newDir }); }
    catch (e) { apiErr(res, e.message); }
});

// ── Setup: node ping (SSE) ────────────────────────────────────────────────────

app.get('/api/setup/nodes', async (req, res) => {
    const net_ = req.query.network;
    const hosts = net_ === 'testnet' ? TESTNET_NODES : MAINNET_NODES;
    const localPort = net_ === 'testnet' ? 13413 : 3413;
    const send = sseHeaders(res);

    const checks = [
        ...hosts.map(async h => {
            const t = Date.now();
            try {
                const r = await fetch('https://' + h + '/v2/foreign', { signal: AbortSignal.timeout(8000) });
                send({ host: h, url: 'https://' + h, online: r.status !== 0, latencyMs: Date.now() - t });
            } catch { send({ host: h, url: 'https://' + h, online: false, latencyMs: Date.now() - t }); }
        }),
        (async () => {
            const localUrl = 'http://127.0.0.1:' + localPort;
            const t = Date.now();
            try {
                const r = await fetch(localUrl + '/v1/status', { signal: AbortSignal.timeout(3000) });
                send({ host: '127.0.0.1:' + localPort, url: localUrl, online: r.ok || r.status === 401, latencyMs: Date.now() - t, isLocal: true });
            } catch { send({ host: '127.0.0.1:' + localPort, url: localUrl, online: false, latencyMs: 0, isLocal: true }); }
        })(),
    ];
    await Promise.allSettled(checks);
    send({ done: true }); res.end();
});

// ── Setup: write wallet config + register ─────────────────────────────────────

const NODE_URL_RE = /^https?:\/\/[A-Za-z0-9._\-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._\-\/]*)?$/;

app.post('/api/setup/write-config', (req, res) => {
    const { name, dir, network, nodeUrl } = req.body;
    if (!name || !dir || !network || !nodeUrl) return apiErr(res, 'name, dir, network, nodeUrl required');
    if (!/^[a-zA-Z0-9\-_]+$/.test(name)) return apiErr(res, 'Invalid wallet name');
    if (!_isInsideRoot(dir)) return apiErr(res, 'dir must be inside ' + _RESOLVED_ROOT);
    if (typeof nodeUrl !== 'string' || !NODE_URL_RE.test(nodeUrl)) return apiErr(res, 'Invalid nodeUrl');
    if (network !== 'mainnet' && network !== 'testnet') return apiErr(res, 'network must be mainnet or testnet');
    if (nameTaken(name))
        return apiErr(res, 'A wallet named "' + name + '" already exists. Names must be unique across '
                         + 'both networks — try "' + name + '-' + (network === 'testnet' ? 'test' : 'main') + '".');

    const reg     = loadRegistry();
    const wallets = Array.isArray(reg.wallets) ? reg.wallets : [];
    const baseFp  = network === 'testnet' ? 13415 : 3415;
    const baseOp  = network === 'testnet' ? 13420 : 3420;
    const usedFp  = wallets.filter(w => w.network === network).map(w => w.foreignPort);
    const usedOp  = wallets.filter(w => w.network === network).map(w => w.ownerPort);
    let fp = baseFp; while (usedFp.includes(fp)) fp++;
    let op = baseOp; while (usedOp.includes(op)) op++;

    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(dir, 0o700); } catch {}
        reg.wallets = wallets.filter(w => !(w.name === name && w.network === network));
        reg.wallets.push({ name, dir, network, foreignPort: fp, ownerPort: op, nodeUrl });
        saveRegistry(reg);
        log('INFO', 'WRITE_CONFIG name=' + name + ' net=' + network + ' fp=' + fp + ' op=' + op);
        res.json({ ok: true, foreignPort: fp, ownerPort: op });
    } catch (e) { apiErr(res, e.message); }
});

// ── Setup: Tor status (apt + systemd, not NSSM) ───────────────────────────────
// We only EXPOSE status — install/start/stop is done via bash apt + systemctl.
// User-visible: "tor service is running on this host, SOCKS5 port 9050 reachable".

app.get('/api/setup/tor-status', async (_req, res) => {
    // systemctl is-active: 0 if active, non-zero otherwise. Fall through to port check.
    let serviceActive = false;
    try {
        execSync('systemctl is-active --quiet tor', { timeout: 3000 });
        serviceActive = true;
    } catch {
        try { execSync('systemctl is-active --quiet tor@default', { timeout: 3000 }); serviceActive = true; }
        catch {}
    }
    const portOpen = await isPortListening(9050);
    res.json({
        installed:      serviceActive || portOpen,
        serviceActive,
        portOpen,
        running:        serviceActive && portOpen,
        hint:           serviceActive ? null : 'On the host: sudo apt install tor && sudo systemctl enable --now tor',
    });
});

// ── Session endpoints ─────────────────────────────────────────────────────────

app.get('/api/wallets', (_req, res) => {
    const dupes = duplicateWalletNames();
    const wallets = loadWallets().map(w => {
        const s = sessions.get(w.name);
        return {
            name: w.name, network: w.network,
            duplicateName: dupes.includes(w.name),
            ownerPort: w.ownerPort, foreignPort: w.foreignPort,
            connected:       !!(s && s.passphrase),
            listenerRunning: isAlive(s?.listenerProc),
            ownerRunning:    isAlive(s?.ownerProc),
            address: readFileOrEmpty(path.join(w.dir, '.wallet_address')),
            nodeUrl: w.nodeUrl || (w.network === 'testnet' ? 'http://127.0.0.1:13413' : 'http://127.0.0.1:3413'),
        };
    });
    res.json({ wallets });
});

app.post('/api/wallet/:name/connect', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const { passphrase = '' } = req.body;

    const ip   = req.ip || req.socket?.remoteAddress || 'unknown';
    const rate = checkConnectRate(ip, wallet.name);
    if (rate.blocked) {
        log('WARN', 'CONNECT_RATE_LIMIT wallet=' + wallet.name + ' ip=' + ip);
        return res.status(429).json({ error: 'Too many attempts. Try again in ' + rate.retryAfter + 's.' });
    }

    const sess = ensureSession(wallet.name);
    sess.passphrase = passphrase;

    if (!(await isPortListening(wallet.ownerPort)))
        return res.json({ ok: true, ownerRunning: false });

    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        let address = readFileOrEmpty(path.join(wallet.dir, '.wallet_address'));
        try {
            const addr = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'get_slatepack_address', { token, derivation_index: 0 });
            if (addr) { fs.writeFileSync(path.join(wallet.dir, '.wallet_address'), addr, 'utf8'); address = addr; }
        } catch {}
        clearConnectRate(ip, wallet.name);
        log('INFO', 'CONNECT wallet=' + wallet.name);
        return res.json({ ok: true, ownerRunning: true, address });
    } catch (e) {
        sess.passphrase = '';
        const isConnErr = e.message.includes('ECONNREFUSED') || e.message.includes('not running');
        return apiErr(res, isConnErr ? 'Owner API not running' : 'Wrong passphrase', isConnErr ? 503 : 401);
    }
});

app.post('/api/wallet/:name/disconnect', (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const s = sessions.get(wallet.name);
    if (s) { [s.listenerProc, s.ownerProc].forEach(p => { if (p) try { p.kill(); } catch {} }); sessions.delete(wallet.name); }
    res.json({ ok: true });
});

app.get('/api/wallet/:name/session', (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const s = sessions.get(wallet.name);
    res.json({ connected: !!(s && s.passphrase), listenerRunning: isAlive(s?.listenerProc), ownerRunning: isAlive(s?.ownerProc) });
});

// ── grin-wallet child processes (listener + owner_api) ────────────────────────

app.post('/api/wallet/:name/start-listener', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const s = getSession(req.params.name);
    if (!s || !s.passphrase) return apiErr(res, 'Wallet not connected', 401);
    if (isAlive(s.listenerProc)) return res.json({ ok: true, port: wallet.foreignPort, alreadyRunning: true });

    const bin = getBinaryPath();
    if (!fs.existsSync(bin)) return apiErr(res, 'Binary not installed', 503);
    // SECURITY: passphrase NEVER on argv (would show in `ps`). Pipe via stdin.
    const args = [...(wallet.network === 'testnet' ? ['--testnet'] : []), 'listen'];
    const proc = spawn(bin, args, { cwd: wallet.dir, stdio: ['pipe', 'ignore', 'ignore'] });
    try { proc.stdin.write((s.passphrase || '') + '\n'); proc.stdin.end(); } catch {}
    s.listenerProc = proc;
    proc.on('exit', () => { if (s.listenerProc === proc) s.listenerProc = null; });
    try { await waitForJsonRpcReady(wallet.foreignPort, 'foreign', 8000); log('INFO', 'LISTENER_STARTED wallet=' + wallet.name); res.json({ ok: true, port: wallet.foreignPort }); }
    catch { res.json({ ok: false, error: 'Started but JSON-RPC not yet ready (wrong passphrase?)' }); }
});

app.post('/api/wallet/:name/stop-listener', (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const s = sessions.get(wallet.name);
    if (s?.listenerProc) { try { s.listenerProc.kill(); } catch {} s.listenerProc = null; }
    res.json({ ok: true });
});

app.post('/api/wallet/:name/start-owner', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const s = getSession(req.params.name);
    if (!s || !s.passphrase) return apiErr(res, 'Wallet not connected', 401);
    if (isAlive(s.ownerProc)) return res.json({ ok: true, port: wallet.ownerPort, alreadyRunning: true });

    const bin = getBinaryPath();
    if (!fs.existsSync(bin)) return apiErr(res, 'Binary not installed', 503);
    const args = [...(wallet.network === 'testnet' ? ['--testnet'] : []), 'owner_api'];
    const proc = spawn(bin, args, { cwd: wallet.dir, stdio: ['pipe', 'ignore', 'ignore'] });
    try { proc.stdin.write((s.passphrase || '') + '\n'); proc.stdin.end(); } catch {}
    s.ownerProc = proc;
    proc.on('exit', () => { if (s.ownerProc === proc) s.ownerProc = null; });
    try { await waitForJsonRpcReady(wallet.ownerPort, 'owner', 8000); log('INFO', 'OWNER_STARTED wallet=' + wallet.name); res.json({ ok: true, port: wallet.ownerPort }); }
    catch { res.json({ ok: false, error: 'Started but JSON-RPC not yet ready (wrong passphrase?)' }); }
});

app.post('/api/wallet/:name/stop-owner', (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const s = sessions.get(wallet.name);
    if (s?.ownerProc) { try { s.ownerProc.kill(); } catch {} s.ownerProc = null; }
    res.json({ ok: true });
});

// ── Wallet init / recover ─────────────────────────────────────────────────────

app.post('/api/wallet/:name/init', (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const { passphrase = '' } = req.body;
    const bin = getBinaryPath();
    if (!fs.existsSync(bin)) return apiErr(res, 'Binary not installed', 503);

    const tomlPath = path.join(wallet.dir, 'grin-wallet.toml');
    if (fs.existsSync(tomlPath)) fs.renameSync(tomlPath, tomlPath + '.bak.' + Date.now());

    const args = [...(wallet.network === 'testnet' ? ['--testnet'] : []), 'init', '-h'];
    const proc = spawn(bin, args, { cwd: wallet.dir, stdio: ['pipe', 'pipe', 'pipe'] });
    try { proc.stdin.write(passphrase + '\n' + passphrase + '\n'); proc.stdin.end(); } catch {}
    let out = '';
    proc.stdout?.on('data', d => { out += d; });
    proc.stderr?.on('data', d => { out += d; });
    proc.on('close', code => {
        if (code !== 0) return apiErr(res, 'init failed (code ' + code + '): ' + out.slice(0, 400));
        try { applyWalletTomlPatches(wallet); } catch (pe) { log('WARN', 'TOML_PATCH_FAIL ' + pe.message); }
        const clean = out.replace(/\[[0-9;]*m/g, '');
        let seed = '';
        let capture = false;
        for (const line of clean.split(/\r?\n/)) {
            if (/recovery phrase|mnemonic|seed phrase/i.test(line)) { capture = true; continue; }
            if (!capture) continue;
            const words = line.split(/[^a-z]+/i).filter(w => /^[a-z]{3,8}$/i.test(w)).map(w => w.toLowerCase());
            if (words.length) {
                seed += (seed ? ' ' : '') + words.join(' ');
                if (seed.split(/\s+/).length >= 24) break;
            }
        }
        const sess = ensureSession(wallet.name);
        sess.passphrase = passphrase;
        log('INFO', 'WALLET_INIT wallet=' + wallet.name);
        res.json({ ok: true, seed: seed.trim() });
    });
    proc.on('error', e => apiErr(res, e.message));
});

app.post('/api/wallet/:name/recover', (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const { passphrase = '', seedPhrase } = req.body;
    if (!seedPhrase) return apiErr(res, 'seedPhrase required');
    const bin = getBinaryPath();
    if (!fs.existsSync(bin)) return apiErr(res, 'Binary not installed', 503);

    const tomlPath = path.join(wallet.dir, 'grin-wallet.toml');
    if (fs.existsSync(tomlPath)) fs.renameSync(tomlPath, tomlPath + '.bak.' + Date.now());

    const args = [...(wallet.network === 'testnet' ? ['--testnet'] : []), 'init', '-hr'];
    const proc = spawn(bin, args, { cwd: wallet.dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout?.on('data', d => { out += d; });
    proc.stderr?.on('data', d => { out += d; });
    try { proc.stdin.write(passphrase + '\n' + passphrase + '\n' + seedPhrase + '\n'); proc.stdin.end(); } catch {}
    proc.on('close', code => {
        if (code !== 0) return apiErr(res, 'recover failed (code ' + code + '): ' + out.slice(0, 400));
        try { applyWalletTomlPatches(wallet); } catch (pe) { log('WARN', 'TOML_PATCH_FAIL ' + pe.message); }
        const sess = ensureSession(wallet.name);
        sess.passphrase = passphrase;
        log('INFO', 'WALLET_RECOVER wallet=' + wallet.name);
        res.json({ ok: true });
    });
    proc.on('error', e => apiErr(res, e.message));
});

// ── Node status ───────────────────────────────────────────────────────────────

async function nodeOwnerApiCall(method, params = []) {
    const wallets = loadWallets();
    if (!wallets.length) throw new Error('No wallets registered');
    const wallet = wallets[0];
    const isTestnet = wallet.network === 'testnet';
    let nodeUrl = 'http://127.0.0.1:' + (isTestnet ? 13413 : 3413);
    try {
        const toml = fs.readFileSync(path.join(wallet.dir, 'grin-wallet.toml'), 'utf8');
        const m = toml.match(/check_node_api_http_addr\s*=\s*"([^"]+)"/);
        if (m) nodeUrl = m[1];
    } catch {}
    const isLocal = /127\.0\.0\.1|localhost/.test(nodeUrl);
    let secret = '';
    if (isLocal) {
        const sp = findNodeSecret(wallet.network, '.api_secret');
        if (sp) secret = readFileOrEmpty(sp);
    }
    const hdrs = { 'Content-Type': 'application/json' };
    if (secret) hdrs.Authorization = 'Basic ' + Buffer.from('grin:' + secret).toString('base64');
    const r = await fetch(nodeUrl + '/v2/owner', {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    if (j.result?.Err) throw new Error(JSON.stringify(j.result.Err));
    return { data: j.result?.Ok !== undefined ? j.result.Ok : j.result, nodeUrl, isLocal };
}

app.get('/api/node/status', async (_req, res) => {
    const wallets = loadWallets();
    if (!wallets.length) return res.json({ reachable: false, error: 'No wallets registered' });
    const wallet = wallets[0];
    const isTestnet = wallet.network === 'testnet';
    const defPort   = isTestnet ? 13413 : 3413;
    let nodeUrl = 'http://127.0.0.1:' + defPort, secret = '';
    try {
        const toml = fs.readFileSync(path.join(wallet.dir, 'grin-wallet.toml'), 'utf8');
        const uM   = toml.match(/check_node_api_http_addr\s*=\s*"([^"]+)"/);
        if (uM) nodeUrl = uM[1];
    } catch {}
    const isLocal = /127\.0\.0\.1|localhost/.test(nodeUrl);
    if (isLocal) {
        const sp = findNodeSecret(wallet.network, '.api_secret');
        if (sp) secret = readFileOrEmpty(sp);
    }
    try {
        const hdrs = secret ? { Authorization: 'Basic ' + Buffer.from('grin:' + secret).toString('base64') } : {};
        const r = await fetch(nodeUrl + '/v1/status', { headers: hdrs, signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        res.json({ reachable: true, node_type: isLocal ? 'local' : 'external', node_url: nodeUrl,
                   height: d.tip?.height ?? 0, connections: d.connections ?? 0,
                   sync_status: d.sync_status ?? 'unknown', user_agent: d.user_agent ?? '' });
    } catch (e) {
        res.json({ reachable: false, node_type: isLocal ? 'local' : 'external', node_url: nodeUrl, error: e.message });
    }
});

app.get('/api/node/peers', async (_req, res) => {
    try {
        const r = await nodeOwnerApiCall('get_connected_peers');
        const peers = (Array.isArray(r.data) ? r.data : []).map(p => ({
            addr:       p.addr,
            direction:  p.direction,
            user_agent: p.user_agent,
            version:    p.version,
            height:     p.height ?? null,
            total_difficulty: p.total_difficulty ?? null,
            capabilities: p.capabilities?.bits ?? p.capabilities ?? null,
        }));
        res.json({ peers, count: peers.length });
    } catch (e) {
        res.json({ peers: [], count: 0, error: e.message });
    }
});

app.get('/api/node/sync-detail', async (_req, res) => {
    try {
        const r = await nodeOwnerApiCall('get_status');
        const d = r.data || {};
        const status = d.sync_status || 'unknown';
        const info   = d.sync_info || {};
        let progress = null;
        if (info.current_height != null && info.highest_height != null && info.highest_height > 0) {
            progress = {
                current: Number(info.current_height),
                target:  Number(info.highest_height),
                percent: Math.max(0, Math.min(100, Math.round((Number(info.current_height) / Number(info.highest_height)) * 100))),
                unit:    'blocks',
            };
        } else if (info.downloaded_size != null && info.total_size != null && Number(info.total_size) > 0) {
            progress = {
                current: Number(info.downloaded_size),
                target:  Number(info.total_size),
                percent: Math.max(0, Math.min(100, Math.round((Number(info.downloaded_size) / Number(info.total_size)) * 100))),
                unit:    'bytes',
            };
        }
        const fullySynced = status === 'no_sync';
        res.json({
            reachable:  true,
            synced:     fullySynced,
            sync_status: status,
            sync_label: humanSyncLabel(status),
            progress,
            height:     d.tip?.height ?? null,
            peers:      d.connections ?? 0,
            user_agent: d.user_agent ?? '',
            node_url:   r.nodeUrl,
            is_local:   r.isLocal,
        });
    } catch (e) {
        res.json({ reachable: false, synced: false, error: e.message });
    }
});

function humanSyncLabel(s) {
    switch (s) {
        case 'no_sync':              return 'Fully synced';
        case 'awaiting_peers':       return 'Awaiting peers';
        case 'header_sync':          return 'Syncing headers';
        case 'txhashset_download':   return 'Downloading state';
        case 'txhashset_set_validation': return 'Validating state';
        case 'txhashset_save':       return 'Saving state';
        case 'body_sync':            return 'Syncing blocks';
        case 'shutdown':             return 'Shutting down';
        default:                     return s || 'Unknown';
    }
}

// ── GRIN price (CoinGecko, 60s cache) ─────────────────────────────────────────
let priceCache = { usd: null, btc: null, ts: 0, source: null };
const PRICE_TTL_MS = 60_000;

async function fetchPrice() {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=grin&vs_currencies=usd,btc';
    try {
        const body = await httpsGet(url);
        const j    = JSON.parse(body);
        const usd  = Number(j?.grin?.usd);
        const btc  = Number(j?.grin?.btc);
        if (isFinite(usd) && usd > 0) {
            priceCache = { usd, btc: isFinite(btc) ? btc : null, ts: Date.now(), source: 'coingecko' };
            return priceCache;
        }
        throw new Error('Bad price response');
    } catch (e) {
        log('WARN', 'PRICE_FETCH_FAIL ' + e.message);
        return null;
    }
}

app.get('/api/price', async (_req, res) => {
    const fresh = Date.now() - priceCache.ts < PRICE_TTL_MS;
    if (!fresh || !priceCache.usd) await fetchPrice();
    if (!priceCache.usd) return res.json({ usd: null, btc: null, ts: priceCache.ts, error: 'Unavailable' });
    res.json({ usd: priceCache.usd, btc: priceCache.btc, ts: priceCache.ts, source: priceCache.source, ageMs: Date.now() - priceCache.ts });
});

app.get('/api/portfolio', async (_req, res) => {
    const wallets = loadWallets().filter(w => w.network === 'mainnet');
    let spendable = 0n, pending = 0n, immature = 0n, locked = 0n;
    const perWallet = [];
    for (const w of wallets) {
        const sess = sessions.get(w.name);
        if (!sess || !sess.passphrase) { perWallet.push({ name: w.name, connected: false }); continue; }
        try {
            const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(w);
            const info = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'retrieve_summary_info',
                { token, minimum_confirmations: 1, refresh_from_node: false });
            const d = Array.isArray(info) ? info[1] : info;
            const s = BigInt(d?.amount_currently_spendable || '0');
            const p = BigInt(d?.amount_awaiting_confirmation || '0');
            const i = BigInt(d?.amount_immature || '0');
            const l = BigInt(d?.amount_locked || '0');
            spendable += s; pending += p; immature += i; locked += l;
            perWallet.push({ name: w.name, connected: true, spendable: s.toString(), pending: p.toString() });
        } catch (e) {
            perWallet.push({ name: w.name, connected: true, error: e.message });
        }
    }
    res.json({
        spendable: spendable.toString(),
        pending:   pending.toString(),
        immature:  immature.toString(),
        locked:    locked.toString(),
        usdPrice:  priceCache.usd, btcPrice: priceCache.btc, priceTs: priceCache.ts,
        wallets:   perWallet,
    });
});

// ── Node ping proxy ───────────────────────────────────────────────────────────

// Audit F1 — this used to accept ANY http(s) URL and POST to it, giving an
// authenticated caller an outbound-request primitive (internal services, cloud
// metadata at 169.254.169.254, port scanning by latency). It's a GET, so the
// Origin/CSRF guard above never covered it. The target is now restricted to
// hosts we already trust: the curated public lists, loopback, and whatever node
// the operator has actually configured for a wallet (already validated by
// NODE_URL_RE at write-config time). Anything else is refused before the fetch.
function nodePingAllowed(url) {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true;
    if (MAINNET_NODES.includes(host) || TESTNET_NODES.includes(host)) return true;
    return loadWallets().some(w => {
        try { return new URL(w.nodeUrl || '').hostname.toLowerCase() === host; }
        catch { return false; }
    });
}

app.get('/api/node/ping', async (req, res) => {
    const url = req.query.url;
    if (!url || !/^https?:\/\//i.test(url)) return apiErr(res, 'valid url required');
    if (!nodePingAllowed(url)) {
        log('WARN', 'PING_REJECTED url=' + String(url).slice(0, 120));
        return apiErr(res, 'Node not in the allowed list. Assign it to a wallet first.', 403);
    }
    const t = Date.now();
    try {
        const r = await fetch(url + '/v2/foreign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'get_tip', params: [] }),
            signal: AbortSignal.timeout(6000),
        });
        const latency_ms = Date.now() - t;
        const d = await r.json().catch(() => null);
        const tip = d?.result?.Ok ?? d?.result;
        res.json({ reachable: true, latency_ms, height: tip?.height ?? null });
    } catch {
        res.json({ reachable: false, latency_ms: Date.now() - t });
    }
});

// ── Local node status by network ──────────────────────────────────────────────

app.get('/api/node/local/:network', async (req, res) => {
    const isTestnet = req.params.network === 'testnet';
    const port    = isTestnet ? 13413 : 3413;
    const nodeUrl = 'http://127.0.0.1:' + port;
    let secret = '';
    const sp = findNodeSecret(isTestnet ? 'testnet' : 'mainnet', '.api_secret');
    if (sp) secret = readFileOrEmpty(sp);
    const t = Date.now();
    try {
        const hdrs = secret ? { Authorization: 'Basic ' + Buffer.from('grin:' + secret).toString('base64') } : {};
        const r = await fetch(nodeUrl + '/v1/status', { headers: hdrs, signal: AbortSignal.timeout(3000) });
        const latency_ms = Date.now() - t;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        res.json({ reachable: true, latency_ms, height: d.tip?.height ?? 0,
                   connections: d.connections ?? 0, sync_status: d.sync_status ?? 'unknown' });
    } catch {
        res.json({ reachable: false, latency_ms: Date.now() - t });
    }
});

// ── Update wallet node URL ────────────────────────────────────────────────────

app.post('/api/wallet/node', (req, res) => {
    const { walletName, nodeUrl } = req.body;
    if (!walletName || !nodeUrl) return apiErr(res, 'walletName and nodeUrl required');
    if (typeof nodeUrl !== 'string' || !NODE_URL_RE.test(nodeUrl)) return apiErr(res, 'invalid nodeUrl');
    const wallet = findWallet(walletName);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    try {
        const reg = loadRegistry();
        const w   = reg.wallets.find(x => x.name === walletName);
        if (w) w.nodeUrl = nodeUrl;
        saveRegistry(reg);
        const tomlPath = path.join(wallet.dir, 'grin-wallet.toml');
        if (fs.existsSync(tomlPath)) {
            let c = fs.readFileSync(tomlPath, 'utf8');
            c = patchTomlKey(c, 'check_node_api_http_addr', '"' + nodeUrl + '"');
            fs.writeFileSync(tomlPath, c, 'utf8');
        }
        log('INFO', 'WALLET_NODE_UPDATED wallet=' + walletName + ' url=' + nodeUrl);
        res.json({ ok: true });
    } catch (e) { apiErr(res, e.message); }
});

// ── Wallet operations ─────────────────────────────────────────────────────────

app.get('/api/wallet/:name/status', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        const info = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'retrieve_summary_info',
            { token, minimum_confirmations: 1, refresh_from_node: false });
        const d = Array.isArray(info) ? info[1] : info;
        let address = readFileOrEmpty(path.join(wallet.dir, '.wallet_address'));
        try {
            const addr = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'get_slatepack_address', { token, derivation_index: 0 });
            if (addr) { fs.writeFileSync(path.join(wallet.dir, '.wallet_address'), addr, 'utf8'); address = addr; }
        } catch {}
        res.json({ spendable: d?.amount_currently_spendable || '0', pending: d?.amount_awaiting_confirmation || '0',
                   immature: d?.amount_immature || '0', locked: d?.amount_locked || '0',
                   height: d?.last_confirmed_height || 0, address, network: wallet.network });
    } catch (e) { apiErr(res, e.message, 503); }
});

app.get('/api/wallet/:name/locked-outputs', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        const r = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'retrieve_txs',
            { token, refresh_from_node: false, tx_id: null, tx_slate_id: null });
        const all = Array.isArray(r) && Array.isArray(r[1]) ? r[1] : (r || []);
        const stuck = all.filter(t =>
            t.tx_type === 'TxSent' &&
            !t.confirmed && !t.confirmation_ts &&
            !t.kernel_excess && !t.kernel_lookup_min_height);
        res.json({ txs: stuck });
    } catch (e) { apiErr(res, e.message, 503); }
});

app.get('/api/wallet/:name/address-book', (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const book = loadAddressBook(wallet.dir);
    const entries = Object.entries(book).map(([addr, v]) => ({ address: addr, ...v }))
        .sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')));
    res.json({ entries });
});

app.post('/api/wallet/:name/address-book', (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const address = String(req.body.address || '').trim();
    const label   = String(req.body.label || '').trim().slice(0, 64);
    if (!ADDR_RE.test(address)) return apiErr(res, 'Invalid address (expected grin1…)');
    const book = loadAddressBook(wallet.dir);
    const now  = new Date().toISOString();
    book[address] = { firstSeen: now, totalSent: '0', sendCount: 0, testPassed: false,
                      ...(book[address] || {}), label };
    try { saveAddressBook(wallet.dir, book); res.json({ ok: true }); }
    catch (e) { apiErr(res, e.message, 500); }
});

app.delete('/api/wallet/:name/address-book/:address', (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const address = String(req.params.address || '').trim();
    const book = loadAddressBook(wallet.dir);
    if (book[address]) {
        delete book[address];
        try { saveAddressBook(wallet.dir, book); }
        catch (e) { return apiErr(res, e.message, 500); }
    }
    res.json({ ok: true });
});

app.post('/api/wallet/:name/cancel-tx', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const txId    = req.body.tx_id ? String(req.body.tx_id) : null;
    const txSlateId = req.body.tx_slate_id ? String(req.body.tx_slate_id) : null;
    if (!txId && !txSlateId) return apiErr(res, 'tx_id or tx_slate_id required');
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'cancel_tx',
            { token, tx_id: txId ? Number(txId) : null, tx_slate_id: txSlateId });
        log('INFO', 'CANCEL_TX wallet=' + wallet.name + ' tx_id=' + (txId || txSlateId));
        res.json({ ok: true });
    } catch (e) { apiErr(res, e.message, 503); }
});

app.get('/api/wallet/:name/txs', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        const r = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'retrieve_txs',
            { token, refresh_from_node: false, tx_id: null, tx_slate_id: null });
        res.json({ txs: Array.isArray(r) && Array.isArray(r[1]) ? r[1] : (r || []) });
    } catch (e) { apiErr(res, e.message, 503); }
});

app.post('/api/wallet/:name/fee', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const amount = parseFloat(req.body.amount);
    if (!amount || isNaN(amount) || amount <= 0) return apiErr(res, 'Invalid amount');
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        const r = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'estimate_fee', {
            token, args: { amount: Math.round(amount * 1e9), minimum_confirmations: 10,
                           max_outputs: 500, num_change_outputs: 1, selection_strategy_is_use_all: false } });
        const feeArr = Array.isArray(r) && r.length >= 2 ? r[1] : null;
        res.json({ fee: feeArr?.length ? feeArr[0].fee : (r?.fee ?? null) });
    } catch (e) { apiErr(res, e.message, 503); }
});

app.post('/api/wallet/:name/send', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const amount = parseFloat(req.body.amount);
    if (!amount || isNaN(amount) || amount <= 0) return apiErr(res, 'Invalid amount');
    const method = (req.body.method || 'slatepack').toLowerCase();
    if (method !== 'slatepack' && method !== 'tor') return apiErr(res, 'Invalid send method');

    let dest = null;
    if (method === 'tor') {
        dest = String(req.body.dest || '').trim();
        if (!ADDR_RE.test(dest)) return apiErr(res, 'Invalid Tor recipient address (expected grin1… for mainnet or tgrin1… for testnet)');
        // Hard-block network mismatch — burning funds is unrecoverable.
        const destNet = addressNetwork(dest);
        if (destNet && destNet !== wallet.network) {
            return apiErr(res,
                'NETWORK_MISMATCH: This wallet is ' + wallet.network.toUpperCase()
                + ' but the recipient address is ' + destNet.toUpperCase()
                + '. Refusing to send — these funds would be unrecoverable.', 400);
        }
        if (!(await isPortListening(9050))) return apiErr(res, 'Tor not running (port 9050). On host: sudo systemctl start tor', 503);
    }

    const proofAddr = req.body.proofAddress && ADDR_RE.test(String(req.body.proofAddress).trim())
        ? String(req.body.proofAddress).trim() : null;

    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        const sendArgs = method === 'tor'
            ? { method: 'tor', dest, post_tx: true, fluff: false, finalize: true, skip_tor: false }
            : null;
        const slate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'init_send_tx', {
            token, args: { src_acct_name: null, amount: Math.round(amount * 1e9), minimum_confirmations: 10,
                           max_outputs: 500, num_change_outputs: 1, selection_strategy_is_use_all: false,
                           target_slate_version: null, payment_proof_recipient_address: proofAddr, ttl_blocks: null,
                           send_args: sendArgs } });

        if (method === 'tor') {
            recordAddressSend(wallet.dir, dest, amount);
            log('INFO', 'SEND_TOR wallet=' + wallet.name + ' amount=' + amount + ' dest=' + dest.slice(0, 12) + '...');
            const txId = slate?.id || slate?.tx_id || null;
            return res.json({ ok: true, method: 'tor', txId, amount, dest });
        }

        const slatepack = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'create_slatepack_message',
            { token, sender_index: null, recipients: [], slate });
        log('INFO', 'SEND_INIT wallet=' + wallet.name + ' amount=' + amount);
        res.json({ slatepack });
    } catch (e) {
        const msg = e.message || String(e);
        const code = /tor|socks|connection refused/i.test(msg) ? 502 : 503;
        apiErr(res, msg, code);
    }
});

app.post('/api/wallet/:name/receive', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const { slatepack } = req.body;
    if (!validateSlatepack(slatepack)) return apiErr(res, 'Invalid slatepack');
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        const slate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'slate_from_slatepack_message',
            { token, secret_indices: [0], message: slatepack });
        const fAuth = 'Basic ' + Buffer.from('grin:' + readForeignSecret(wallet.dir)).toString('base64');
        let fJson;
        try {
            const fRes = await fetch('http://127.0.0.1:' + wallet.foreignPort + '/v2/foreign', {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: fAuth },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'receive_tx', params: [slate, null, null] }),
                signal: AbortSignal.timeout(30000) });
            fJson = await fRes.json();
        } catch (fe) {
            if (fe.cause?.code === 'ECONNREFUSED' || fe.code === 'ECONNREFUSED')
                throw new Error('Listener not running on port ' + wallet.foreignPort + ' — start it from Dashboard');
            throw fe;
        }
        if (fJson.error) throw new Error('receive_tx: ' + (fJson.error.message || JSON.stringify(fJson.error)));
        const rSlate = fJson.result?.Ok !== undefined ? fJson.result.Ok : fJson.result;
        const responseSlatepack = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'create_slatepack_message',
            { token, sender_index: null, recipients: [], slate: rSlate });
        res.json({ response_slatepack: responseSlatepack });
    } catch (e) { apiErr(res, e.message, 503); }
});

app.post('/api/wallet/:name/finalize', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const { slatepack } = req.body;
    if (!validateSlatepack(slatepack)) return apiErr(res, 'Invalid slatepack');
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        const slate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'slate_from_slatepack_message',
            { token, secret_indices: [0], message: slatepack });
        await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'tx_lock_outputs', { token, slate, participant_id: 0 });
        const finalSlate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'finalize_tx', { token, slate });
        try { await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'post_tx', { token, slate: finalSlate, fluff: true }); }
        catch (pe) { log('WARN', 'BROADCAST_FAIL ' + pe.message); }
        log('INFO', 'FINALIZE_OK wallet=' + wallet.name);
        res.json({ ok: true, tx_id: finalSlate?.id || null });
    } catch (e) { apiErr(res, e.message, 503); }
});

// ══ Grin Transporter (Script 093) ════════════════════════════════════════════
//
// A third delivery rail next to Tor (both parties online) and copy-paste
// slatepacks (a human moves the blob). The Transporter is a dumb store-and-
// forward queue: we PUT an encrypted slatepack addressed to the payee, and the
// payee's wallet collects it whenever it next comes online.
//
// TRUST MODEL — worth being precise, because "a server in the middle" sounds
// worse than it is. Slates are encrypted to the recipient's slatepack key, so a
// hostile Transporter cannot read them, and finalizing requires our key, so it
// cannot spend. What it CAN do is (a) refuse to deliver and (b) learn which
// address talks to which. So the endpoint is an availability and metadata
// dependency, not a custody one — that is why a wrong URL is annoying, and why
// a wrong NETWORK is dangerous enough to be a hard error at config time.
//
// Config lives in the registry file (0600, alongside the wallet list) rather
// than in a new file, so it inherits the same permissions and backup coverage.

const TSP_POLL_TICK_MS  = 15_000;   // scheduler granularity; per-network interval is config
const TSP_POLL_MIN_SEC  = 30;
const TSP_POLL_MAX_SEC  = 3600;

function tspDefaultNet() { return { url: '', enabled: false }; }

function loadTspConfig() {
    const r = loadRegistry();
    const t = (r && typeof r.transporter === 'object' && r.transporter) ? r.transporter : {};
    const norm = (n) => {
        const v = t[n];
        if (!v || typeof v !== 'object') return tspDefaultNet();
        return {
            url:     typeof v.url === 'string' ? v.url.trim().replace(/\/+$/, '') : '',
            enabled: !!v.enabled,
        };
    };
    let ps = parseInt(t.poll_seconds, 10);
    if (!Number.isFinite(ps)) ps = 60;
    ps = Math.min(TSP_POLL_MAX_SEC, Math.max(TSP_POLL_MIN_SEC, ps));
    return { mainnet: norm('mainnet'), testnet: norm('testnet'), poll_seconds: ps };
}

function saveTspConfig(cfg) {
    const r = loadRegistry();
    r.transporter = cfg;
    if (!Array.isArray(r.wallets)) r.wallets = [];
    saveRegistry(r);
}

// Node's fetch (undici) has no SOCKS support, so an .onion host cannot be
// reached from this process however the operator configures it. Rejecting it
// with the reason beats a config that saves cleanly and then times out forever.
function validateTspUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return { ok: true, url: '' };            // empty = not configured
    let u;
    try { u = new URL(s); } catch { return { ok: false, msg: 'Not a valid URL' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, msg: 'URL must be http:// or https://' };
    if (u.username || u.password) return { ok: false, msg: 'Credentials in the URL are not supported' };
    if (/\.onion$/i.test(u.hostname))
        return { ok: false, msg: 'This process cannot reach .onion hosts directly (no SOCKS support in Node fetch). '
                               + 'Use the Transporter\'s HTTPS front, or forward it to a local port first.' };
    return { ok: true, url: u.origin + u.pathname.replace(/\/+$/, '') };
}

// One client per base URL so the bearer-token cache actually survives between
// polls (it is keyed by address inside, so wallets sharing a URL share this).
const tspClients = new Map();
function tspClientFor(url) {
    if (!tspClients.has(url)) tspClients.set(url, transporter.makeClient(url));
    return tspClients.get(url);
}

// Per-wallet runtime state. Deliberately NOT in `sessions`: this must survive a
// lock/unlock so the UI can still explain why nothing is arriving.
const tspState = new Map();
function tspGetState(name) {
    if (!tspState.has(name))
        tspState.set(name, { lastPoll: 0, lastError: null, lastResult: null, depth: 0, running: false });
    return tspState.get(name);
}

// Bind an open ECDH session into the plain (method, params) shape transporter.js
// expects, folding in the token so the module never handles one.
function boundOwnerCall(session) {
    return (method, params) => encryptedOwnerCall(session.headers, session.sharedKey, session.ownerUrl,
                                                  method, Object.assign({ token: session.token }, params || {}));
}

// Wallet Foreign API v2. The inline copy in /receive is left alone on purpose —
// it is the working copy-paste path and this is a new caller, not a refactor.
async function walletForeignCall(wallet, method, params = []) {
    const auth = 'Basic ' + Buffer.from('grin:' + readForeignSecret(wallet.dir)).toString('base64');
    let res;
    try {
        res = await fetch('http://127.0.0.1:' + wallet.foreignPort + '/v2/foreign', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            signal:  AbortSignal.timeout(30000),
        });
    } catch (e) {
        if (e.cause?.code === 'ECONNREFUSED' || e.code === 'ECONNREFUSED')
            throw new Error('Listener not running on port ' + wallet.foreignPort + ' — start it from the Wallet tab');
        throw e;
    }
    const json = await res.json();
    if (json.error) throw new Error(method + ': ' + (json.error.message || JSON.stringify(json.error)));
    if (json.result && json.result.Err) throw new Error(method + ': ' + JSON.stringify(json.result.Err));
    return json.result && json.result.Ok !== undefined ? json.result.Ok : json.result;
}

// Resolve the endpoint for a wallet, or explain precisely what is missing.
function tspEndpointFor(wallet) {
    const cfg = loadTspConfig();
    const net = cfg[wallet.network];
    if (!net || !net.url) throw new Error('No Transporter configured for ' + wallet.network + ' — set one in Setup');
    return { url: net.url, enabled: net.enabled, pollSeconds: cfg.poll_seconds };
}

async function tspRunPoll(wallet, url) {
    const session = await ownerApiSession(wallet);
    const call    = boundOwnerCall(session);
    const client  = tspClientFor(url);
    const myAddr  = await transporter.ownAddress(call);
    return transporter.poll({
        call,
        foreign: (m, p) => walletForeignCall(wallet, m, p),
        client,
        myAddr,
        onLog:    (m) => log('INFO', 'TSP wallet=' + wallet.name + ' ' + m.split('\n')[0]),
        onProven: (addr) => markAddressProven(wallet.dir, addr),
    });
}

// ── Config endpoints ─────────────────────────────────────────────────────────

app.get('/api/transporter/config', (_req, res) => res.json(loadTspConfig()));

app.post('/api/transporter/config', (req, res) => {
    const body = req.body || {};
    const out  = { mainnet: tspDefaultNet(), testnet: tspDefaultNet(), poll_seconds: 60 };
    for (const net of ['mainnet', 'testnet']) {
        const v = body[net] || {};
        const chk = validateTspUrl(v.url);
        if (!chk.ok) return apiErr(res, net + ': ' + chk.msg);
        out[net] = { url: chk.url, enabled: !!v.enabled && !!chk.url };
    }
    let ps = parseInt(body.poll_seconds, 10);
    if (!Number.isFinite(ps)) ps = 60;
    out.poll_seconds = Math.min(TSP_POLL_MAX_SEC, Math.max(TSP_POLL_MIN_SEC, ps));
    try {
        saveTspConfig(out);
        log('INFO', 'TSP_CONFIG mainnet=' + (out.mainnet.url || '-') + ' testnet=' + (out.testnet.url || '-')
                  + ' poll=' + out.poll_seconds + 's');
        res.json(Object.assign({ ok: true }, out));
    } catch (e) { apiErr(res, e.message); }
});

// Probe an endpoint WITHOUT saving it. Reports the network mismatch as an error
// so the operator finds out here rather than by losing a payment into a queue
// on the wrong chain.
app.post('/api/transporter/test', async (req, res) => {
    const { url, network } = req.body || {};
    if (network !== 'mainnet' && network !== 'testnet') return apiErr(res, 'network must be mainnet or testnet');
    const chk = validateTspUrl(url);
    if (!chk.ok)  return apiErr(res, chk.msg);
    if (!chk.url) return apiErr(res, 'URL required');
    try {
        const health = await transporter.checkEndpoint(transporter.makeClient(chk.url), network);
        res.json({ ok: true, url: chk.url, health });
    } catch (e) { apiErr(res, e.message, 502); }
});

// ── Per-wallet endpoints ─────────────────────────────────────────────────────

app.get('/api/wallet/:name/transporter/status', (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const cfg = loadTspConfig();
    const net = cfg[wallet.network] || tspDefaultNet();
    const st  = tspGetState(wallet.name);
    const s   = getSession(wallet.name);
    res.json({
        network:        wallet.network,
        url:            net.url,
        configured:     !!net.url,
        autoPoll:       !!net.enabled,
        pollSeconds:    cfg.poll_seconds,
        unlocked:       !!getPassphrase(wallet.name),
        listenerRunning: isAlive(s && s.listenerProc),
        ownerRunning:    isAlive(s && s.ownerProc),
        lastPoll:       st.lastPoll || null,
        lastError:      st.lastError,
        lastResult:     st.lastResult,
        depth:          st.depth,
        polling:        st.running,
    });
});

app.post('/api/wallet/:name/transporter/send', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    if (!getPassphrase(wallet.name)) return apiErr(res, 'Wallet is locked — unlock it first', 401);

    let ep;
    try { ep = tspEndpointFor(wallet); } catch (e) { return apiErr(res, e.message, 409); }

    try {
        const session = await ownerApiSession(wallet);
        const result  = await transporter.send({
            call:    boundOwnerCall(session),
            client:  tspClientFor(ep.url),
            network: wallet.network,
            dest:    req.body.dest,
            amount:  req.body.amount,
            minConfirmations: 10,
        });
        // proven=false: queued is not delivered — see recordAddressSend.
        recordAddressSend(wallet.dir, result.dest, parseFloat(result.amount), false);
        log('INFO', 'TSP_SEND wallet=' + wallet.name + ' amount=' + result.amount
                  + ' dest=' + result.dest.slice(0, 12) + '… tx=' + result.txSlateId);
        res.json(Object.assign({ ok: true }, result));
    } catch (e) {
        // A locked-but-undelivered send is a distinct, recoverable state — the
        // client needs the tx id to offer Cancel, so pass it through.
        const payload = { error: e.message };
        if (e.locked) { payload.locked = true; payload.txSlateId = e.txSlateId; }
        const code = /NETWORK_MISMATCH|Invalid recipient|Invalid amount|greater than zero/.test(e.message) ? 400 : 502;
        res.status(code).json(payload);
    }
});

app.post('/api/wallet/:name/transporter/poll', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    if (!getPassphrase(wallet.name)) return apiErr(res, 'Wallet is locked — unlock it first', 401);

    let ep;
    try { ep = tspEndpointFor(wallet); } catch (e) { return apiErr(res, e.message, 409); }

    const st = tspGetState(wallet.name);
    if (st.running) return apiErr(res, 'A check is already in progress', 409);
    st.running = true;
    try {
        const r = await tspRunPoll(wallet, ep.url);
        st.lastError  = null;
        st.lastResult = r;
        st.depth      = r.depth;
        res.json(Object.assign({ ok: true }, r));
    } catch (e) {
        st.lastError = e.message;
        apiErr(res, e.message, 502);
    } finally {
        st.running  = false;
        st.lastPoll = Date.now();
    }
});

// ── Background poller ────────────────────────────────────────────────────────
//
// Scoped to UNLOCKED wallets only, and that is not a limitation to work around:
// collecting a slate means decrypting it with the wallet key, so a locked wallet
// could not act on the queue even if it fetched it. Tying the poller to the
// unlock state also means the operator has exactly one control for "is my wallet
// working for me right now", and nothing runs after an idle auto-lock.
//
// This path NEVER calls touchSession(): the idle backstop deliberately measures
// deliberate actions, not background traffic, and a self-renewing poller would
// keep a forgotten wallet unlocked forever — the exact failure it exists to stop.
async function tspAutoPollOnce() {
    const cfg = loadTspConfig();
    const now = Date.now();
    for (const w of loadWallets()) {
        const net = cfg[w.network];
        if (!net || !net.enabled || !net.url) continue;
        if (!getPassphrase(w.name)) continue;
        const st = tspGetState(w.name);
        if (st.running) continue;
        if (now - (st.lastPoll || 0) < cfg.poll_seconds * 1000) continue;

        st.running = true;
        try {
            const r = await tspRunPoll(w, net.url);
            st.lastError  = null;
            st.lastResult = r;
            st.depth      = r.depth;
            if (r.processed || r.removed)
                log('INFO', 'TSP_AUTO wallet=' + w.name + ' processed=' + r.processed + ' removed=' + r.removed);
        } catch (e) {
            // Log once per transition, not every tick — a stopped owner API
            // would otherwise fill the journal at the poll interval.
            if (st.lastError !== e.message) log('WARN', 'TSP_AUTO wallet=' + w.name + ' ' + e.message);
            st.lastError = e.message;
        } finally {
            st.running  = false;
            st.lastPoll = Date.now();   // a failure backs off by the same interval
        }
    }
}
setInterval(() => { tspAutoPollOnce().catch((e) => log('ERROR', 'TSP_AUTO_TICK ' + e.message)); },
            TSP_POLL_TICK_MS).unref();

// ── Payment proofs ────────────────────────────────────────────────────────────
app.get('/api/wallet/:name/payment-proof/:tx_slate_id', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        const proof = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'retrieve_payment_proof',
            { token, refresh_from_node: true, tx_id: null, tx_slate_id: req.params.tx_slate_id });
        res.json({ proof });
    } catch (e) { apiErr(res, e.message, 503); }
});

app.post('/api/wallet/:name/verify-proof', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const { proof } = req.body || {};
    if (!proof || typeof proof !== 'object') return apiErr(res, 'Proof JSON required');
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        const result = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'verify_payment_proof',
            { token, proof });
        res.json({ ok: true, result });
    } catch (e) { apiErr(res, e.message, 503); }
});

// ── Wallet handbook parity ────────────────────────────────────────────────────

app.post('/api/wallet/:name/invoice', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const amount = parseFloat(req.body.amount);
    if (!amount || isNaN(amount) || amount <= 0) return apiErr(res, 'Invalid amount');
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        const slate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'issue_invoice_tx', {
            token, args: { amount: Math.round(amount * 1e9), message: null,
                           dest_acct_name: null, target_slate_version: null } });
        const slatepack = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'create_slatepack_message',
            { token, sender_index: null, recipients: [], slate });
        log('INFO', 'INVOICE_INIT wallet=' + wallet.name + ' amount=' + amount);
        res.json({ slatepack, amount });
    } catch (e) { apiErr(res, e.message, 503); }
});

app.post('/api/wallet/:name/pay-invoice', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const { slatepack, confirmedAmount } = req.body || {};
    if (!validateSlatepack(slatepack)) return apiErr(res, 'Invalid slatepack');
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        const slate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'slate_from_slatepack_message',
            { token, secret_indices: [0], message: slatepack });

        if (confirmedAmount !== undefined && confirmedAmount !== null) {
            const expected = Math.round(parseFloat(confirmedAmount) * 1e9);
            const got = Number(slate?.amt ?? slate?.amount ?? 0);
            if (!Number.isFinite(expected) || expected !== got) {
                return apiErr(res, 'AMOUNT_MISMATCH: invoice amount (' + (got / 1e9)
                    + ') does not match confirmed amount (' + confirmedAmount + ')', 400);
            }
        }

        const responseSlate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'process_invoice_tx', {
            token, slate,
            args: { src_acct_name: null, amount: 0, minimum_confirmations: 10,
                    max_outputs: 500, num_change_outputs: 1, selection_strategy_is_use_all: false,
                    target_slate_version: null, payment_proof_recipient_address: null,
                    ttl_blocks: null, send_args: null } });
        await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'tx_lock_outputs',
            { token, slate: responseSlate, participant_id: 0 });
        const responseSlatepack = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'create_slatepack_message',
            { token, sender_index: null, recipients: [], slate: responseSlate });
        log('INFO', 'PAY_INVOICE wallet=' + wallet.name + ' amount=' + (Number(slate?.amt ?? slate?.amount ?? 0) / 1e9));
        res.json({ response_slatepack: responseSlatepack });
    } catch (e) { apiErr(res, e.message, 503); }
});

app.post('/api/wallet/:name/scan', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const startHeight  = req.body.start_height != null ? Number(req.body.start_height) : null;
    const deleteUnconfirmed = !!req.body.delete_unconfirmed;
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'scan',
            { token, start_height: startHeight, delete_unconfirmed: deleteUnconfirmed });
        log('INFO', 'SCAN wallet=' + wallet.name + ' from=' + (startHeight ?? 'genesis')
            + ' delete_unconfirmed=' + deleteUnconfirmed);
        res.json({ ok: true });
    } catch (e) { apiErr(res, e.message, 503); }
});

app.post('/api/wallet/:name/unpack', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const { slatepack } = req.body || {};
    if (!validateSlatepack(slatepack)) return apiErr(res, 'Invalid slatepack');
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        const slate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'slate_from_slatepack_message',
            { token, secret_indices: [0], message: slatepack });
        const nano = Number(slate?.amt ?? slate?.amount ?? 0);
        res.json({ slate, amount_grin: nano / 1e9, fee_nano: Number(slate?.fee ?? 0) });
    } catch (e) { apiErr(res, e.message, 503); }
});

app.get('/api/wallet/:name/outputs', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const includeSpent = req.query.include_spent === '1';
    const refresh      = req.query.refresh !== '0';
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        const r = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'retrieve_outputs',
            { token, include_spent: includeSpent, refresh_from_node: refresh, tx_id: null });
        const list = Array.isArray(r) && Array.isArray(r[1]) ? r[1] : (Array.isArray(r) ? r : []);
        res.json({ outputs: list, refreshed: Array.isArray(r) ? !!r[0] : false });
    } catch (e) { apiErr(res, e.message, 503); }
});

app.get('/api/wallet/:name/accounts', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        const accounts = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'accounts', { token });
        res.json({ accounts: Array.isArray(accounts) ? accounts : [] });
    } catch (e) { apiErr(res, e.message, 503); }
});

app.post('/api/wallet/:name/accounts', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const label = String(req.body.label || '').trim();
    if (!label || label.length > 64 || !/^[A-Za-z0-9 _\-]+$/.test(label))
        return apiErr(res, 'Invalid account label (1-64 chars; letters, numbers, space, _ or - only)');
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        const path_ = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'create_account_path',
            { token, label });
        log('INFO', 'ACCOUNT_CREATE wallet=' + wallet.name + ' label=' + label);
        res.json({ ok: true, label, path: path_ });
    } catch (e) { apiErr(res, e.message, 503); }
});

app.post('/api/wallet/:name/show-seed', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const { passphrase } = req.body || {};
    if (typeof passphrase !== 'string')
        return apiErr(res, 'Passphrase required to reveal seed');

    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const rate = checkConnectRate(ip, wallet.name);
    if (rate.blocked) return apiErr(res,
        'Too many attempts. Retry after ' + rate.retryAfter + 's.', 429);

    try {
        // Pass the typed passphrase as the open_wallet override rather than relying on the
        // in-memory session, so an idle-locked wallet can still reveal its seed — the caller
        // has just proved the passphrase anyway. This still needs the wallet's owner-API
        // child to be RUNNING; after a reboot (nothing unlocked yet) it 503s, which is the
        // same "connect first" state every other wallet route is in.
        const { headers, sharedKey, ownerUrl } = await ownerApiSession(wallet, passphrase);
        const mnemonic = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'get_mnemonic',
            { name: null, password: passphrase });
        clearConnectRate(ip, wallet.name);
        log('INFO', 'SEED_DISPLAY wallet=' + wallet.name + ' ip=' + ip);
        res.json({ mnemonic });
    } catch (e) {
        const msg = e.message || String(e);
        const code = /password|mnemonic|decrypt/i.test(msg) ? 401 : 503;
        apiErr(res, code === 401 ? 'Wrong passphrase' : msg, code);
    }
});

app.post('/api/wallet/:name/post-tx', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const { slatepack } = req.body || {};
    const fluff = req.body.fluff !== false;
    if (!validateSlatepack(slatepack)) return apiErr(res, 'Invalid slatepack');
    try {
        const { headers, sharedKey, ownerUrl, token } = await ownerApiSession(wallet);
        const slate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'slate_from_slatepack_message',
            { token, secret_indices: [0], message: slatepack });
        await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'post_tx', { token, slate, fluff });
        log('INFO', 'POST_TX wallet=' + wallet.name + ' tx_id=' + (slate?.id || '?'));
        res.json({ ok: true, tx_id: slate?.id || null });
    } catch (e) { apiErr(res, e.message, 503); }
});

// ── Encrypted wallet backup (.gws) ────────────────────────────────────────────
const GWS_MAGIC = Buffer.from('GWS1');
const GWS_PBKDF2_ITER = 200_000;

// AUTHORISATION — read this before touching the handler.
// This endpoint hands out `wallet_data/wallet.seed`. That file is the wallet: whoever holds it
// needs only the wallet passphrase to spend, and they can attack that passphrase OFFLINE where
// neither nginx's Basic Auth nor the 5/min limiter below can see them.
//
// Every OTHER sensitive endpoint is gated by accident of design — they all route through
// ownerApiSession(), which pulls the passphrase from the in-memory session, gets '' when nobody
// is connected, and dies at open_wallet. This handler is pure filesystem I/O, so it never
// touched that path and was reachable by anyone past Basic Auth with NO wallet passphrase at
// all. The `passphrase` field does not help: it is the backup's own encryption key, chosen by
// the caller. So the seed left the building encrypted under the ATTACKER's key.
//
// The gate is therefore modelled on /show-seed, the other endpoint that releases seed material:
// demand the real wallet passphrase, prove it against the wallet, rate-limit, log. Do not
// weaken this to a session check — connect() stores an UNVERIFIED passphrase whenever the
// owner API is down (see the early return there), so `connected` does not mean "correct".
app.post('/api/wallet/:name/export', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const { passphrase, walletPassphrase } = req.body || {};
    if (typeof passphrase !== 'string' || passphrase.length < 8) return apiErr(res, 'Backup passphrase required (min 8 chars)');
    if (typeof walletPassphrase !== 'string') return apiErr(res, 'Wallet passphrase required — this backup contains your seed', 401);

    // Shares the /connect + /show-seed counter (same ip|wallet key) on purpose: 5 attempts per
    // minute TOTAL across all three, so an attacker cannot farm a fresh allowance per endpoint.
    const ip   = req.ip || req.socket?.remoteAddress || 'unknown';
    const rate = checkConnectRate(ip, wallet.name);
    if (rate.blocked) {
        log('WARN', 'EXPORT_RATE_LIMIT wallet=' + wallet.name + ' ip=' + ip);
        return apiErr(res, 'Too many attempts. Retry after ' + rate.retryAfter + 's.', 429);
    }

    try {
        await ownerApiSession(wallet, walletPassphrase);
    } catch (e) {
        const msg       = e.message || String(e);
        const isConnErr = /ECONNREFUSED|not running/i.test(msg);
        log('WARN', 'EXPORT_DENIED wallet=' + wallet.name + ' ip=' + ip
                  + ' reason=' + (isConnErr ? 'owner_api_down' : 'bad_passphrase'));
        // Fail CLOSED when the wallet cannot be asked. A backup you can't take is recoverable
        // (start the owner API); a seed released without proof is not.
        return apiErr(res, isConnErr
            ? 'Owner API not running — start it before exporting a backup.'
            : 'Wrong wallet passphrase', isConnErr ? 503 : 401);
    }
    clearConnectRate(ip, wallet.name);

    const manifest = {
        version:    1,
        walletName: wallet.name,
        network:    wallet.network,
        timestamp:  new Date().toISOString(),
        files:      {},
    };
    const textFiles = ['grin-wallet.toml', '.foreign_api_secret', '.owner_api_secret', '.wallet_address', '.address_book.json'];
    for (const f of textFiles) {
        const p = path.join(wallet.dir, f);
        if (fs.existsSync(p)) manifest.files[f] = fs.readFileSync(p, 'utf8');
    }
    const seedPath = path.join(wallet.dir, 'wallet_data', 'wallet.seed');
    if (fs.existsSync(seedPath)) manifest.files['wallet_data/wallet.seed'] = fs.readFileSync(seedPath).toString('base64');

    try {
        const json   = Buffer.from(JSON.stringify(manifest), 'utf8');
        const salt   = crypto.randomBytes(16);
        const iv     = crypto.randomBytes(12);
        const key    = crypto.pbkdf2Sync(passphrase, salt, GWS_PBKDF2_ITER, 32, 'sha256');
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ct     = Buffer.concat([cipher.update(json), cipher.final()]);
        const tag    = cipher.getAuthTag();
        const out    = Buffer.concat([GWS_MAGIC, salt, iv, tag, ct]);

        // Log the IP like SEED_DISPLAY does — this line is the audit trail for "the seed left".
        log('INFO', 'WALLET_EXPORT wallet=' + wallet.name + ' ip=' + ip + ' bytes=' + out.length);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment; filename="' + wallet.name + '-' + wallet.network + '-' + new Date().toISOString().slice(0, 10) + '.gws"');
        res.send(out);
    } catch (e) {
        log('ERROR', 'WALLET_EXPORT_FAIL ' + e.message);
        apiErr(res, e.message, 500);
    }
});

app.post('/api/wallet/import', (req, res) => {
    const { fileBase64, passphrase, walletName, dir } = req.body || {};
    if (typeof fileBase64 !== 'string' || !fileBase64) return apiErr(res, 'fileBase64 required');
    if (typeof passphrase !== 'string' || passphrase.length < 8) return apiErr(res, 'Backup passphrase required (min 8 chars)');

    let buf;
    try { buf = Buffer.from(fileBase64, 'base64'); }
    catch { return apiErr(res, 'Invalid base64 in fileBase64'); }
    if (buf.length < 50 || buf.slice(0, 4).toString() !== 'GWS1') return apiErr(res, 'Not a GrinSuite backup (.gws) file');

    const salt = buf.slice(4, 20);
    const iv   = buf.slice(20, 32);
    const tag  = buf.slice(32, 48);
    const ct   = buf.slice(48);

    let manifest;
    try {
        const key = crypto.pbkdf2Sync(passphrase, salt, GWS_PBKDF2_ITER, 32, 'sha256');
        const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
        dec.setAuthTag(tag);
        const json = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
        manifest = JSON.parse(json);
    } catch { return apiErr(res, 'Decryption failed — wrong passphrase or corrupted file'); }

    if (!manifest || manifest.version !== 1 || !manifest.network || !manifest.files) {
        return apiErr(res, 'Unsupported backup format');
    }
    const network = manifest.network === 'testnet' ? 'testnet' : 'mainnet';
    const name    = (typeof walletName === 'string' && walletName.trim()) || manifest.walletName || ('imported-' + Date.now().toString(36));
    if (!/^[a-zA-Z0-9\-_]+$/.test(name)) return apiErr(res, 'Invalid wallet name');

    const reg = loadRegistry();
    if (nameTaken(name)) {
        return apiErr(res, 'A wallet named "' + name + '" already exists. Names must be unique across '
                         + 'both networks — pass a different "Wallet name on this machine".');
    }

    const destDir = (typeof dir === 'string' && dir.trim()) || path.join(WEBWALLET_ROOT, 'wallet_' + network + '_' + name);
    if (!_isInsideRoot(destDir)) return apiErr(res, 'dir must be inside ' + _RESOLVED_ROOT);
    if (fs.existsSync(destDir) && fs.readdirSync(destDir).length > 0) {
        return apiErr(res, 'Destination directory exists and is not empty: ' + destDir);
    }

    try {
        fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(destDir, 0o700); } catch {}
        fs.mkdirSync(path.join(destDir, 'wallet_data'), { recursive: true });
        for (const [relPath, content] of Object.entries(manifest.files || {})) {
            if (relPath.includes('..') || path.isAbsolute(relPath)) {
                throw new Error('Refusing path "' + relPath + '" in backup (path traversal guard)');
            }
            const target = path.join(destDir, relPath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            if (relPath === 'wallet_data/wallet.seed') {
                fs.writeFileSync(target, Buffer.from(content, 'base64'));
            } else {
                fs.writeFileSync(target, content, 'utf8');
            }
        }

        const wallets = Array.isArray(reg.wallets) ? reg.wallets : [];
        const baseFp  = network === 'testnet' ? 13415 : 3415;
        const baseOp  = network === 'testnet' ? 13420 : 3420;
        const usedFp  = wallets.filter(w => w.network === network).map(w => w.foreignPort);
        const usedOp  = wallets.filter(w => w.network === network).map(w => w.ownerPort);
        let fp = baseFp; while (usedFp.includes(fp)) fp++;
        let op = baseOp; while (usedOp.includes(op)) op++;

        const tomlPath = path.join(destDir, 'grin-wallet.toml');
        if (fs.existsSync(tomlPath)) {
            let c = fs.readFileSync(tomlPath, 'utf8');
            c = patchTomlKey(c, 'api_listen_port',      String(fp));
            c = patchTomlKey(c, 'owner_api_listen_port', String(op));
            fs.writeFileSync(tomlPath, c, 'utf8');
        }

        reg.wallets = wallets.concat([{ name, dir: destDir, network, foreignPort: fp, ownerPort: op }]);
        saveRegistry(reg);

        log('INFO', 'WALLET_IMPORTED name=' + name + ' net=' + network + ' dir=' + destDir + ' fp=' + fp + ' op=' + op);
        res.json({ ok: true, name, network, dir: destDir, foreignPort: fp, ownerPort: op });
    } catch (e) {
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch {}
        log('ERROR', 'WALLET_IMPORT_FAIL ' + e.message);
        apiErr(res, e.message, 500);
    }
});

// ── Wallet delete ─────────────────────────────────────────────────────────────

// AUTHORISATION — two very different actions share this route, so they get different gates.
//   files=0  unregister only. The directory stays on disk untouched, so this is reversible by
//            re-registering it. Left open deliberately: it is the everyday "remove from list"
//            action, and it cannot escalate — once unregistered, findWallet() 404s, so the
//            destructive branch below becomes UNREACHABLE for that wallet. Free unregister
//            protects the files rather than exposing them.
//   files=1  rmSync -r on the wallet directory. Irreversible, and it destroys the seed. Same
//            blast radius as /export (loss instead of theft) and it was reachable by anyone
//            past nginx Basic Auth with no wallet passphrase at all — the browser confirm()
//            was the only obstacle, and an attacker calling the API never runs it.
// So the destructive branch is proven exactly like /export: real wallet passphrase, verified
// against the wallet, rate-limited, logged, fail-closed.
app.delete('/api/wallet/:name', async (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const deleteFiles = req.query.files === '1';
    const ip          = req.ip || req.socket?.remoteAddress || 'unknown';

    if (deleteFiles) {
        const { walletPassphrase } = req.body || {};
        if (typeof walletPassphrase !== 'string')
            return apiErr(res, 'Wallet passphrase required to delete wallet files', 401);

        const rate = checkConnectRate(ip, wallet.name);
        if (rate.blocked) {
            log('WARN', 'DELETE_RATE_LIMIT wallet=' + wallet.name + ' ip=' + ip);
            return apiErr(res, 'Too many attempts. Retry after ' + rate.retryAfter + 's.', 429);
        }
        try {
            await ownerApiSession(wallet, walletPassphrase);
        } catch (e) {
            const msg       = e.message || String(e);
            const isConnErr = /ECONNREFUSED|not running/i.test(msg);
            log('WARN', 'DELETE_DENIED wallet=' + wallet.name + ' ip=' + ip
                      + ' reason=' + (isConnErr ? 'owner_api_down' : 'bad_passphrase'));
            // Fail closed. If the owner API is down we cannot prove anything, and an
            // unprovable request must never be the one that erases a seed. The operator can
            // still unregister (files=0) and delete the directory from a shell.
            return apiErr(res, isConnErr
                ? 'Owner API not running — start it before deleting wallet files.'
                : 'Wrong wallet passphrase', isConnErr ? 503 : 401);
        }
        clearConnectRate(ip, wallet.name);
    }

    const s = sessions.get(wallet.name);
    if (s) {
        [s.listenerProc, s.ownerProc].forEach(p => { if (p) try { p.kill(); } catch {} });
        sessions.delete(wallet.name);
    }

    const reg = loadRegistry();
    reg.wallets = (Array.isArray(reg.wallets) ? reg.wallets : []).filter(w => w.name !== wallet.name);
    saveRegistry(reg);

    if (deleteFiles && wallet.dir) {
        try { fs.rmSync(wallet.dir, { recursive: true, force: true }); }
        catch (e) { log('WARN', 'DELETE_FILES_FAIL ' + e.message); }
    }

    log('INFO', 'WALLET_DELETED wallet=' + wallet.name + ' ip=' + ip + ' files=' + deleteFiles);
    res.json({ ok: true });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

let shuttingDown = false;
function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', 'SHUTDOWN signal=' + signal);
    for (const [, s] of sessions) {
        [s.listenerProc, s.ownerProc].forEach(p => { if (p) { try { p.kill(); } catch {} } });
    }
    process.exit(0);
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

app.listen(PORT, '127.0.0.1', () => {
    log('INFO', 'Grin Web Wallet (toolkit 051) listening on http://127.0.0.1:' + PORT);
    log('INFO', 'Wallets registered: ' + loadWallets().length);
    log('INFO', 'WW_ROOT=' + WEBWALLET_ROOT);
    log('INFO', 'Idle backstop: ' + (IDLE_LOCK_MIN > 0 ? IDLE_LOCK_MIN + ' min' : 'disabled'));
    const _dupes = duplicateWalletNames();
    if (_dupes.length) {
        log('ERROR', 'DUPLICATE_WALLET_NAMES ' + _dupes.join(', ') + ' — routes resolve by name '
            + 'alone, so only the FIRST registry entry for each of these is reachable. Rename one '
            + 'side in ' + WALLETS_JSON + ' (and its dir) before using them.');
    }
    if (process.env.WW_PUBLIC_HOST)   log('INFO', 'WW_PUBLIC_HOST=' + process.env.WW_PUBLIC_HOST);
    if (process.env.WW_PUBLIC_ORIGIN) log('INFO', 'WW_PUBLIC_ORIGIN=' + process.env.WW_PUBLIC_ORIGIN);
});
