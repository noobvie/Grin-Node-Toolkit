'use strict';
/**
 * Grin Web Wallet — Linux port for Grin-Node-Toolkit Script 051.
 *
 * Lifted from GrinSuite (noobvie/GrinSuite:web/03_web_wallet/server.js,
 * upstream version 2.0.0) and adapted for:
 *   - Linux paths (/opt/grin/webwallet/...) — no D:\Grin\... drive scan
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

// ── Paths (toolkit-relative, no drive scanning) ───────────────────────────────
const WEBWALLET_ROOT = process.env.WW_ROOT || '/opt/grin/webwallet';
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

const MAINNET_NODES = ['api.grin.money','api.grinily.com','api.grinnode.org','main.gri.mw','grincoin.org'];
const TESTNET_NODES = ['testapi.grin.money','testapi.grinily.com','testnet.grincoin.org','test.gri.mw'];

// ── Session management ────────────────────────────────────────────────────────
// Map<walletName, { passphrase:string, listenerProc:ChildProcess|null, ownerProc:ChildProcess|null }>
const sessions = new Map();
function getSession(n) { return sessions.get(n) || null; }
function ensureSession(n) {
    if (!sessions.has(n)) sessions.set(n, { passphrase: '', listenerProc: null, ownerProc: null });
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
function recordAddressSend(walletDir, dest, amount) {
    if (!ADDR_RE.test(dest)) return;
    const book = loadAddressBook(walletDir);
    const now  = new Date().toISOString();
    const cur  = book[dest] || { firstSeen: now, label: '', totalSent: '0', sendCount: 0, testPassed: false };
    cur.lastUsed   = now;
    cur.sendCount  = (Number(cur.sendCount) || 0) + 1;
    cur.totalSent  = (Number(cur.totalSent || 0) + Number(amount || 0)).toString();
    cur.testPassed = true;
    book[dest] = cur;
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

async function ownerApiSession(wallet) {
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

    const token = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'open_wallet',
        { name: null, password: getPassphrase(wallet.name) });
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
app.use(express.json({ limit: '32kb' }));

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
    if (loadWallets().find(w => w.name === name && w.network === network))
        return apiErr(res, 'A ' + network + ' wallet named "' + name + '" already exists');

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
    const wallets = loadWallets().map(w => {
        const s = sessions.get(w.name);
        return {
            name: w.name, network: w.network,
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

app.get('/api/node/ping', async (req, res) => {
    const url = req.query.url;
    if (!url || !/^https?:\/\//i.test(url)) return apiErr(res, 'valid url required');
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
        const { headers, sharedKey, ownerUrl } = await ownerApiSession(wallet);
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

app.post('/api/wallet/:name/export', (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const { passphrase } = req.body || {};
    if (typeof passphrase !== 'string' || passphrase.length < 8) return apiErr(res, 'Backup passphrase required (min 8 chars)');

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

        log('INFO', 'WALLET_EXPORT wallet=' + wallet.name + ' bytes=' + out.length);
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

    const reg     = loadRegistry();
    if ((reg.wallets || []).some(w => w.name === name && w.network === network)) {
        return apiErr(res, 'A ' + network + ' wallet named "' + name + '" already exists. Choose a different name.');
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

app.delete('/api/wallet/:name', (req, res) => {
    const wallet = findWallet(req.params.name);
    if (!wallet) return apiErr(res, 'Wallet not found', 404);
    const deleteFiles = req.query.files === '1';

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

    log('INFO', 'WALLET_DELETED wallet=' + wallet.name + ' files=' + deleteFiles);
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
    if (process.env.WW_PUBLIC_HOST)   log('INFO', 'WW_PUBLIC_HOST=' + process.env.WW_PUBLIC_HOST);
    if (process.env.WW_PUBLIC_ORIGIN) log('INFO', 'WW_PUBLIC_ORIGIN=' + process.env.WW_PUBLIC_ORIGIN);
});
