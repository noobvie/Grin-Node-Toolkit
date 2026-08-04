'use strict';
// Grin Web Wallet — browser client

// ── Constants ────────────────────────────────────────────────────────────────
// Slatepack address: mainnet HRP="grin" → "grin1...", testnet HRP="tgrin" → "tgrin1..."
const ADDR_RE = /^(?:grin|tgrin)1[0-9a-z]{50,}$/i;
function addressNetwork(addr) {
    if (!addr) return null;
    if (/^tgrin1/i.test(addr)) return 'testnet';
    if (/^grin1/i.test(addr))  return 'mainnet';
    return null;
}

// ── State ─────────────────────────────────────────────────────────────────────
let allWallets = [];   // from /api/wallets
let curWallet  = null; // currently selected wallet name
let balCache   = {};   // { [name]: { spendable, pending, immature, address } }
let priceCache    = { usd: null, btc: null, ts: 0 };
let priceTimer    = null;
let balancesTimer = null;   // periodic refresh of all connected wallets' balances

// ── Privacy mode (hide balances) ──────────────────────────────────────────────
const PRIVACY_KEY = 'grin-privacy-mode';
function isPrivacyOn() { return localStorage.getItem(PRIVACY_KEY) === '1'; }
function setPrivacyMode(on) {
    if (on) { document.body.classList.add('privacy-mode'); localStorage.setItem(PRIVACY_KEY, '1'); }
    else    { document.body.classList.remove('privacy-mode'); localStorage.removeItem(PRIVACY_KEY); }
}

// ── Per-wallet color tags ─────────────────────────────────────────────────────
const WALLET_TAGS_KEY = 'grin-wallet-tags';
function loadWalletTags() {
    try { return JSON.parse(localStorage.getItem(WALLET_TAGS_KEY) || '{}'); }
    catch { return {}; }
}
function setWalletTag(walletName, tagIdx) {
    const t = loadWalletTags();
    if (tagIdx === 0) delete t[walletName]; else t[walletName] = tagIdx;
    localStorage.setItem(WALLET_TAGS_KEY, JSON.stringify(t));
}
function getWalletTag(walletName) {
    return loadWalletTags()[walletName] || 0;
}

// ── Auto-lock state ───────────────────────────────────────────────────────────
let lastActivityTs   = Date.now();
let autolockTimer    = null;
const AUTOLOCK_KEY   = 'grin-autolock-minutes';
function getAutolockMinutes() {
    const v = parseInt(localStorage.getItem(AUTOLOCK_KEY) || '15', 10);
    return isFinite(v) && v >= 0 ? v : 15;
}
function setAutolockMinutes(m) { localStorage.setItem(AUTOLOCK_KEY, String(m)); }
const wizard   = { step: 1, name: '', network: 'mainnet', dir: '', nodeUrl: '', fp: 0, op: 0 };

// ── DOM helpers ───────────────────────────────────────────────────────────────
const q   = id => document.getElementById(id);
const esc = s  => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function fmt(n) {
    try {
        if (typeof n === 'string') n = BigInt(n);
        else if (typeof n === 'number') n = BigInt(Math.floor(n));
        return (Number(n) / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '') + ' ∩';
    } catch { return '? ∩'; }
}

// Convert nanograin → USD string ("≈ $1.23") given a unit price.
function fmtUsd(nanograin, usdPerGrin) {
    if (!usdPerGrin || !isFinite(usdPerGrin) || usdPerGrin <= 0) return '';
    try {
        const grin = (typeof nanograin === 'bigint' ? Number(nanograin) : Number(BigInt(nanograin || '0'))) / 1e9;
        const usd  = grin * usdPerGrin;
        if (usd === 0) return '≈ $0.00';
        if (usd < 0.01)   return '≈ <$0.01';
        if (usd < 1)      return '≈ $' + usd.toFixed(3);
        if (usd < 1000)   return '≈ $' + usd.toFixed(2);
        if (usd < 100000) return '≈ $' + Math.round(usd).toLocaleString();
        return '≈ $' + (usd / 1000).toFixed(1) + 'K';
    } catch { return ''; }
}

function showEl(id)  { const e = q(id); if (e) e.style.display = ''; }
function hideEl(id)  { const e = q(id); if (e) e.style.display = 'none'; }
function setText(id, t) { const e = q(id); if (e) e.textContent = t; }

function resultBox(el, cls, html) {
    el.style.display = '';
    el.className = 'result-box ' + cls;
    el.innerHTML = html;
}
function clipMsg(id, msg = 'COPIED!') {
    const el = q(id);
    if (!el) return;
    el.textContent = msg; el.className = 'clip-msg success';
    setTimeout(() => { el.textContent = ''; el.className = 'clip-msg'; }, 2000);
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function apiGet(url) {
    const r = await fetch(url);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    return d;
}
async function apiPost(url, body = {}) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    return d;
}
async function streamPost(url, body, onData) {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) { const d = await resp.json().catch(() => ({})); throw new Error(d.error || 'HTTP ' + resp.status); }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
            const line = part.trim();
            if (line.startsWith('data: ')) { try { onData(JSON.parse(line.slice(6))); } catch {} }
        }
    }
}

// ── Tab switching ─────────────────────────────────────────────────────────────
let nodeTabInterval        = null;
let dashboardSyncInterval  = null;   // polls /api/node/sync-detail every 5s on Wallet tab
let dashboardPeersInterval = null;   // polls /api/node/peers every 10s on Wallet tab

function fmtBytes(n) {
    const v = Number(n);
    if (!isFinite(v) || v <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, x = v;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
    return x.toFixed(x >= 100 ? 0 : 1) + ' ' + units[i];
}

async function refreshDashboardSync() {
    const banner = q('syncBanner');
    const dot    = q('nodeSvcDot');
    const info   = q('nodeSvcInfo');
    if (!banner) return;
    try {
        const d = await apiGet('/api/node/sync-detail');
        if (dot)  dot.className = 'svc-dot ' + (d.reachable && d.synced ? 'dot-on' : (d.reachable ? 'dot-warn' : 'dot-off'));
        if (info) info.textContent = !d.reachable
            ? 'offline'
            : (d.synced
                ? 'h ' + (d.height ?? '?') + ' · ' + (d.peers ?? 0) + ' peers'
                : (d.sync_label || d.sync_status));
        if (!d.reachable || d.synced) { banner.style.display = 'none'; return; }
        banner.style.display = '';
        const label = q('syncBannerLabel');
        const fill  = q('syncBannerFill');
        const det   = q('syncBannerDetail');
        if (label) label.textContent = d.sync_label || d.sync_status;
        const p = d.progress;
        if (p) {
            if (fill) fill.style.width = (p.percent || 0) + '%';
            if (det)  det.textContent = p.unit === 'bytes'
                ? fmtBytes(p.current) + ' / ' + fmtBytes(p.target) + ' (' + (p.percent || 0) + '%) · ' + (d.peers ?? 0) + ' peers'
                : 'Block ' + (p.current || 0).toLocaleString() + ' / ' + (p.target || 0).toLocaleString() + ' (' + (p.percent || 0) + '%) · ' + (d.peers ?? 0) + ' peers';
        } else {
            if (fill) fill.style.width = '0%';
            if (det)  det.textContent = (d.peers ?? 0) + ' peers · waiting for sync progress';
        }
    } catch { banner.style.display = 'none'; }
}

async function refreshDashboardPeers() {
    const row = q('nodeServiceRow');
    if (!row || !row.open) return;     // only fetch when user expanded the row
    const list = q('peerList');
    if (!list) return;
    try {
        const d = await apiGet('/api/node/peers');
        if (!d.peers || !d.peers.length) {
            list.innerHTML = '<div class="peer-list-empty">No connected peers.</div>';
            return;
        }
        list.innerHTML = d.peers.map(p => {
            const dir = (p.direction || '?').toString().toLowerCase().startsWith('out') ? 'out' : 'in';
            const ht  = p.height != null ? Number(p.height).toLocaleString() : '?';
            const ua  = (p.user_agent || '').replace(/^MW\//, '').slice(0, 24);
            return '<div class="peer-row">'
                + '<span title="' + esc(p.addr || '') + '">' + esc(p.addr || '?') + '</span>'
                + '<span class="peer-dir">' + dir + '</span>'
                + '<span class="peer-h">' + esc(ht) + '</span>'
                + '<span class="peer-ua" title="' + esc(p.user_agent || '') + '">' + esc(ua) + '</span>'
                + '</div>';
        }).join('');
    } catch (e) {
        list.innerHTML = '<div class="peer-list-empty">Error: ' + esc(e.message) + '</div>';
    }
}

function startDashboardPolling() {
    stopDashboardPolling();
    refreshDashboardSync();
    refreshDashboardPeers();
    dashboardSyncInterval  = setInterval(refreshDashboardSync, 5000);
    dashboardPeersInterval = setInterval(refreshDashboardPeers, 10000);
}
function stopDashboardPolling() {
    if (dashboardSyncInterval)  clearInterval(dashboardSyncInterval);
    if (dashboardPeersInterval) clearInterval(dashboardPeersInterval);
    dashboardSyncInterval = dashboardPeersInterval = null;
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopDashboardPolling();
        stopBalancesPolling();
        stopPricePolling();
    } else {
        startPricePolling();
        startBalancesPolling();
        if (curWallet && document.querySelector('.tab-panel.active')?.id === 'tab-wallet') startDashboardPolling();
    }
});

// Peer row toggle — fetch peers immediately on expand
document.addEventListener('DOMContentLoaded', () => {
    const row = q('nodeServiceRow');
    if (row) row.addEventListener('toggle', () => { if (row.open) refreshDashboardPeers(); });
});

function switchTab(name) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('[data-tab]').forEach(b => b.classList.remove('active'));
    const panel = q('tab-' + name);
    if (panel) panel.classList.add('active');
    document.querySelectorAll('[data-tab="' + name + '"]').forEach(b => b.classList.add('active'));
    // Node tab interval management
    clearInterval(nodeTabInterval); nodeTabInterval = null;
    if (name === 'node') {
        initNodeTab();
        nodeTabInterval = setInterval(initNodeTab, 30000);
    }
    // Dashboard sync/peers polling — only on Wallet tab when a wallet is selected
    if (name === 'wallet' && curWallet) startDashboardPolling();
    else                                 stopDashboardPolling();
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function renderSidebar(wallets) {
    const container = q('walletList');
    if (!container) return;
    if (!wallets.length) {
        container.innerHTML = '<div class="sidebar-empty">No wallets.<br>Click [ + ADD WALLET ].</div>';
        return;
    }
    const groups = {};
    for (const w of wallets) { (groups[w.network] = groups[w.network] || []).push(w); }
    let html = '';
    for (const net of ['mainnet', 'testnet']) {
        const list = groups[net];
        if (!list) continue;
        html += '<div class="wallet-net-label">' + net.toUpperCase() + '</div>';
        for (const w of list) {
            const dot   = (w.listenerRunning || w.ownerRunning) ? 'dot-on' : 'dot-off';
            const bal   = w.connected && balCache[w.name] ? fmt(balCache[w.name].spendable) : '─';
            const active = w.name === curWallet ? ' active' : '';
            const tagIdx = getWalletTag(w.name);
            const tagCls = tagIdx ? ' tag-' + tagIdx : '';
            html += '<div class="wallet-item' + active + tagCls + '" data-wname="' + esc(w.name) + '" data-network="' + esc(w.network) + '">'
                  + '<span class="wallet-dot ' + dot + '"></span>'
                  + '<span class="wallet-name">' + esc(w.name) + '</span>'
                  + '<span class="wallet-bal">' + esc(bal) + '</span>'
                  + '</div>';
        }
    }
    container.innerHTML = html;
    container.querySelectorAll('.wallet-item').forEach(el =>
        el.addEventListener('click', () => selectWallet(el.dataset.wname)));
}

function closeSidebar() {
    q('sidebar').classList.remove('open');
    q('sidebarOverlay').classList.remove('visible');
}

// ── Wallet selection ──────────────────────────────────────────────────────────
async function refreshWallets() {
    try {
        const data = await apiGet('/api/wallets');
        allWallets = data.wallets || [];
        renderSidebar(allWallets);
    } catch {
        // sidebar stays as-is on transient fetch failure; next poll will refresh
    }
}

async function selectWallet(name) {
    curWallet = name;
    closeSidebar();
    renderSidebar(allWallets);
    loadAddrBook(name).catch(() => {});  // warm cache for first-send warning

    const w = allWallets.find(x => x.name === name);
    if (!w) return;

    q('networkBadge').textContent  = w.network === 'testnet' ? 'TESTNET' : 'MAINNET';
    q('networkBadge').className    = 'network-badge ' + w.network;
    // C3: testnet body class triggers the amber ribbon + header tint + sidebar accent
    document.body.classList.toggle('is-testnet', w.network === 'testnet');
    // G1: stamp the network onto the Send-tab panels so the user never confuses
    // which wallet they're sending from
    const netLbl = w.network === 'testnet' ? 'TESTNET' : 'MAINNET';
    ['sendTorNet', 'sendSlateNet'].forEach(id => {
        const e = q(id);
        if (e) { e.textContent = netLbl; e.className = 'send-method-net ' + w.network; }
    });

    showEl('appShell');
    hideEl('loadingPanel');

    if (!w.connected) {
        showUnlock(w);
    } else {
        showDashboard(w);
    }
}

// ── Unlock ────────────────────────────────────────────────────────────────────
function showUnlock(w) {
    switchTab('wallet');
    hideEl('noSelectionPanel');
    hideEl('dashboardPanel');
    showEl('unlockPanel');
    setText('unlockWalletLabel', w.name + ' (' + w.network + ')');
    q('unlockPassphrase').value = '';
    hideEl('unlockError');
}

q('unlockForm').addEventListener('submit', async e => {
    e.preventDefault();
    const pass = q('unlockPassphrase').value;
    hideEl('unlockError');
    try {
        await apiPost('/api/wallet/' + curWallet + '/connect', { passphrase: pass });
        await refreshWallets();
        const w = allWallets.find(x => x.name === curWallet);
        if (w) showDashboard(w);
        refreshAllConnectedBalances();   // populate sidebar for all connected wallets immediately
    } catch (err) {
        showEl('unlockError');
        setText('unlockError', err.message);
    }
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
function showDashboard(w) {
    switchTab('wallet');
    hideEl('noSelectionPanel');
    hideEl('unlockPanel');
    showEl('dashboardPanel');
    updateServicesPanel(w);
    refreshNodeStatus();
    refreshBalance(w.name);
    const addr = w.address || (balCache[w.name] && balCache[w.name].address) || '';
    if (addr) { setText('walletAddress', addr); setText('receiveAddress', addr); }
}

function updateServicesPanel(w) {
    const lr = w.listenerRunning, or_ = w.ownerRunning;
    q('listenerDot').className    = 'svc-dot ' + (lr ? 'dot-on' : 'dot-off');
    q('listenerBtn').textContent  = lr ? '[ STOP ]' : '[ START ]';
    setText('listenerPortLabel', lr ? ':' + w.foreignPort : '');
    q('ownerDot').className       = 'svc-dot ' + (or_ ? 'dot-on' : 'dot-off');
    q('ownerBtn').textContent     = or_ ? '[ STOP ]' : '[ START ]';
    setText('ownerPortLabel', or_ ? ':' + w.ownerPort : '');
}

// ── Auto-lock: disconnect all wallets after N minutes of no user activity ────
async function lockAllWallets(reason) {
    const connected = allWallets.filter(w => w.connected);
    if (!connected.length) return;
    for (const w of connected) {
        try { await apiPost('/api/wallet/' + w.name + '/disconnect'); }
        catch {}
    }
    await refreshWallets();
    // If user is looking at a wallet, kick them back to the unlock screen
    if (curWallet) {
        const w = allWallets.find(x => x.name === curWallet);
        if (w && !w.connected) showUnlock(w);
    }
    if (reason) {
        // Quiet visual cue — no modal, just an unlock-screen hint
        const u = q('unlockError');
        if (u) { u.textContent = reason; u.style.display = ''; }
    }
}

function recordActivity() { lastActivityTs = Date.now(); }

function checkAutolock() {
    const mins = getAutolockMinutes();
    if (mins <= 0) return;            // disabled
    const idleMs = Date.now() - lastActivityTs;
    if (idleMs >= mins * 60_000) {
        const anyConnected = allWallets.some(w => w.connected);
        if (anyConnected) {
            lockAllWallets('Locked after ' + mins + ' min of inactivity');
            lastActivityTs = Date.now();    // reset so we don't re-fire immediately
        }
    }
}

function startAutolock() {
    if (autolockTimer) return;
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'].forEach(ev =>
        document.addEventListener(ev, recordActivity, { passive: true }));
    autolockTimer = setInterval(checkAutolock, 30_000);     // check every 30s
}

// Setup tab wiring (called from initSetupTab)
function initAutolockSection() {
    const sel = q('autolockMinutes');
    const stat = q('autolockStatus');
    if (!sel) return;
    sel.value = String(getAutolockMinutes());
    const updateStatus = () => {
        const v = parseInt(sel.value, 10);
        if (!stat) return;
        stat.textContent = v <= 0
            ? 'Auto-lock disabled. Wallets stay unlocked until you click Lock or server.js restarts.'
            : 'Wallets will lock after ' + v + ' min of no mouse/keyboard input.';
    };
    sel.onchange = () => { setAutolockMinutes(parseInt(sel.value, 10) || 0); updateStatus(); recordActivity(); };
    updateStatus();
}

// ── USD price + portfolio chip ────────────────────────────────────────────────
async function refreshPrice() {
    try {
        const d = await apiGet('/api/price');
        if (d && d.usd) priceCache = { usd: d.usd, btc: d.btc, ts: d.ts };
    } catch {}
    // Re-render the currently-shown balance so USD subtitles update
    if (curWallet) {
        const w = allWallets.find(x => x.name === curWallet);
        if (w && w.network === 'mainnet') {
            const d = balCache[curWallet];
            if (d) {
                setText('balSpendableUsd', fmtUsd(d.spendable, priceCache.usd));
                setText('balPendingUsd',   fmtUsd(d.pending,   priceCache.usd));
                setText('balImmatureUsd',  fmtUsd(d.immature,  priceCache.usd));
            }
        }
    }
    refreshPortfolioChip();
}

async function refreshPortfolioChip() {
    const chip = q('portfolioChip');
    const usdEl = q('portfolioUsd');
    if (!chip || !usdEl) return;
    // Show chip only when at least one mainnet wallet is registered AND we have a price
    const hasMainnet = allWallets.some(w => w.network === 'mainnet');
    if (!hasMainnet || !priceCache.usd) { chip.style.display = 'none'; return; }
    try {
        const d = await apiGet('/api/portfolio');
        const total = BigInt(d.spendable || '0');
        chip.style.display = '';
        usdEl.textContent = total > 0n
            ? fmtUsd(total, priceCache.usd).replace(/^≈ /, '')
            : '—';
        chip.title = 'Mainnet total: ' + fmt(total)
            + (d.pending && BigInt(d.pending) > 0n ? '  ·  Pending: ' + fmt(d.pending) : '');
    } catch { chip.style.display = 'none'; }
}

function startPricePolling() {
    if (priceTimer) return;
    refreshPrice();
    priceTimer = setInterval(refreshPrice, 60_000);   // 60s, matches server cache
}
function stopPricePolling() {
    if (priceTimer) clearInterval(priceTimer);
    priceTimer = null;
}

// Refresh balances for ALL connected wallets — keeps sidebar amounts current
// even for wallets the user isn't actively looking at.
// Tracks last-seen wallet metrics to detect incoming txs + chain reorgs.
// reorgPeakHeight = the highest height ever seen before a reorg fired; once
// the local node climbs past it again, the banner auto-clears.
const lastSeen = {};      // { [walletName]: { pending: BigInt, spendable: BigInt, height: number } }
let reorgPeakHeight = 0;

function maybeNotify(title, body) {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
        try { new Notification(title, { body, silent: false }); } catch {}
    }
}

function ensureNotificationPermission() {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') {
        // Don't auto-prompt; let user opt in via Setup panel
    }
}

async function refreshAllConnectedBalances() {
    const connected = allWallets.filter(w => w.connected);
    if (!connected.length) return;
    const results = await Promise.allSettled(
        connected.map(w => apiGet('/api/wallet/' + w.name + '/status'))
    );
    let changed = false;
    connected.forEach((w, i) => {
        if (results[i].status === 'fulfilled') {
            const d   = results[i].value;
            const ls  = lastSeen[w.name] || {};
            const newSpendable = BigInt(d.spendable || '0');
            const newPending   = BigInt(d.pending || '0');
            const newHeight    = Number(d.height || 0);

            // F13: notify on incoming pending tx
            if (ls.pending !== undefined && newPending > ls.pending) {
                const diff = newPending - ls.pending;
                maybeNotify('Incoming payment', '+' + fmt(diff.toString()) + ' to ' + w.name);
            }
            // F13: notify on confirmation (pending → spendable)
            if (ls.spendable !== undefined && newSpendable > ls.spendable) {
                const diff = newSpendable - ls.spendable;
                maybeNotify('Funds confirmed', '+' + fmt(diff.toString()) + ' confirmed on ' + w.name);
            }
            // F15: reorg detection — local height drops by >3 blocks unexpectedly
            const banner = q('reorgBanner');
            if (ls.height && newHeight && newHeight + 3 < ls.height) {
                maybeNotify('⚠ Chain reorganization detected',
                    'Local height dropped from ' + ls.height + ' to ' + newHeight + '. Wait for new confirmations.');
                reorgPeakHeight = Math.max(reorgPeakHeight, ls.height);
                if (banner) {
                    banner.textContent = '⚠ Chain reorg: height dropped from ' + ls.height + ' to ' + newHeight + '. Pending txs may need to re-confirm. Banner clears once we pass height ' + reorgPeakHeight + '.';
                    banner.style.display = '';
                }
                // G7: invalidate history cache and refresh if the user is on that tab.
                // Confirmation depths shown there are no longer accurate after a reorg.
                historyState.currentHeight = newHeight;
                const activeTab = document.querySelector('.tab-panel.active')?.id;
                if (activeTab === 'tab-history' && curWallet === w.name) {
                    refreshHistory();
                }
            } else {
                // Normal forward progress — keep history's height current and auto-dismiss
                // the reorg banner once we've climbed back past the prior tip.
                if (newHeight) historyState.currentHeight = newHeight;
                if (banner && reorgPeakHeight && newHeight > reorgPeakHeight) {
                    banner.style.display = 'none';
                    reorgPeakHeight = 0;
                }
            }

            lastSeen[w.name] = { spendable: newSpendable, pending: newPending, height: newHeight };
            balCache[w.name] = d;
            changed = true;
        }
    });
    if (changed) renderSidebar(allWallets);
    refreshPortfolioChip();
}

function startBalancesPolling() {
    if (balancesTimer) return;
    refreshAllConnectedBalances();
    balancesTimer = setInterval(refreshAllConnectedBalances, 60_000);   // every 60s
}
function stopBalancesPolling() {
    if (balancesTimer) clearInterval(balancesTimer);
    balancesTimer = null;
}

async function refreshBalance(name) {
    const statusEl = q('balStatus');
    statusEl.className = 'status-box mt-8';
    statusEl.innerHTML = '<span class="loading">CONNECTING TO WALLET...</span>';
    try {
        const d = await apiGet('/api/wallet/' + name + '/status');
        balCache[name] = d;
        setText('balSpendable', fmt(d.spendable));
        setText('balPending',   fmt(d.pending));
        setText('balImmature',  fmt(d.immature));
        // USD subtitles (only when we have a price + this is mainnet)
        const w = allWallets.find(x => x.name === name);
        const showUsd = priceCache.usd && w && w.network === 'mainnet';
        setText('balSpendableUsd', showUsd ? fmtUsd(d.spendable, priceCache.usd) : '');
        setText('balPendingUsd',   showUsd ? fmtUsd(d.pending,   priceCache.usd) : '');
        setText('balImmatureUsd',  showUsd ? fmtUsd(d.immature,  priceCache.usd) : '');
        if (d.address) {
            setText('walletAddress', d.address); setText('receiveAddress', d.address);
            const qrWrap = q('receiveQrWrap');
            if (qrWrap && qrWrap.style.display !== 'none') renderReceiveQr(d.address);
        }
        renderSidebar(allWallets);
        statusEl.className = 'status-box success mt-8';
        statusEl.innerHTML = '<strong>CONNECTED</strong> &mdash; Height: <code>' + esc(String(d.height)) + '</code>';
        const locked = Number(d.locked || 0);
        const chip = q('lockedOutputsChip');
        if (chip) chip.style.display = locked > 0 ? '' : 'none';
        refreshPortfolioChip();
    } catch (e) {
        statusEl.className = 'status-box error mt-8';
        statusEl.innerHTML = '<strong>ERROR:</strong> ' + esc(e.message);
    }
}

q('refreshBtn').addEventListener('click', async () => {
    if (!curWallet) return;
    await refreshWallets();
    const w = allWallets.find(x => x.name === curWallet);
    if (w) { updateServicesPanel(w); refreshNodeStatus(); refreshBalance(curWallet); }
});

q('lockBtn').addEventListener('click', async () => {
    if (!curWallet) return;
    try {
        await apiPost('/api/wallet/' + curWallet + '/disconnect');
        await refreshWallets();
        const w = allWallets.find(x => x.name === curWallet);
        if (w) showUnlock(w);
    } catch (e) { alert(e.message); }
});

// Encrypted backup export (.gws) — requires a separate backup passphrase
// G6: Import a .gws encrypted backup
q('setupImportWalletBtn')?.addEventListener('click', () => q('setupImportFile')?.click());
q('setupImportFile')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';   // allow re-selecting
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { alert('Backup file too large (>5MB) — that doesn\'t look right.'); return; }
    if (!/\.gws$/i.test(file.name) && file.type !== 'application/octet-stream') {
        if (!confirm('File doesn\'t have a .gws extension. Try anyway?')) return;
    }
    // Read file as base64
    const buf = await file.arrayBuffer();
    const fileBase64 = btoa(String.fromCharCode(...new Uint8Array(buf)));

    const r = await showModal({
        title: 'Import encrypted backup',
        body:  '<p>File: <code>' + esc(file.name) + '</code> (' + Math.round(file.size / 1024) + ' KB)</p>'
             + '<p>Enter the <strong>backup passphrase</strong> used when this .gws was exported.</p>'
             + '<div class="field mt-8"><input type="password" id="importPass" class="input" placeholder="Backup passphrase"></div>'
             + '<div class="field mt-8"><input type="text" id="importName" class="input" placeholder="Wallet name on this machine (leave blank to use backup\'s name)"></div>'
             + '<div id="importErr" class="error-inline mt-8" style="display:none"></div>',
        actions: [
            { label: 'Import', kind: 'primary', onClick: () => {
                const p = document.getElementById('importPass')?.value || '';
                if (p.length < 8) {
                    const err = document.getElementById('importErr');
                    err.style.display = ''; err.textContent = 'Passphrase must be at least 8 characters.';
                    throw new Error('short');
                }
                return { pass: p, name: document.getElementById('importName')?.value.trim() || '' };
            }},
            { label: 'Cancel', kind: 'outline', value: null },
        ],
    });
    if (!r || typeof r !== 'object') return;
    try {
        const resp = await apiPost('/api/wallet/import', { fileBase64, passphrase: r.pass, walletName: r.name || undefined });
        await refreshWallets();
        renderSetupWalletList();
        await showModal({
            title: 'Backup imported',
            body:  '<p>Wallet <strong>' + esc(resp.name) + '</strong> (' + esc(resp.network) + ') restored to:</p>'
                 + '<p><code>' + esc(resp.dir) + '</code></p>'
                 + '<p class="field-hint mt-8">Click the wallet in the sidebar to unlock with its original passphrase.</p>',
            actions: [{ label: 'OK', kind: 'primary' }],
        });
    } catch (err) {
        alert('Import failed: ' + err.message);
    }
});

q('exportWalletBtn')?.addEventListener('click', async () => {
    if (!curWallet) return;
    const r = await showModal({
        title: 'Export encrypted backup',
        body:  '<p>Bundles wallet config, secrets, seed file, and address book into an AES-256-GCM encrypted <code>.gws</code> file.</p>'
             + '<p>Choose a strong <strong>backup passphrase</strong> (not your wallet passphrase). You\'ll need it to decrypt the backup.</p>'
             + '<div class="field mt-8"><input type="password" id="exportPass" class="input" placeholder="Backup passphrase (min 8 chars)" autocomplete="new-password"></div>'
             + '<div class="field mt-8"><input type="password" id="exportPass2" class="input" placeholder="Confirm passphrase" autocomplete="new-password"></div>'
             + '<div id="exportErr" class="error-inline mt-8" style="display:none"></div>',
        actions: [
            { label: 'Export', kind: 'primary', onClick: () => {
                const p1 = document.getElementById('exportPass')?.value || '';
                const p2 = document.getElementById('exportPass2')?.value || '';
                const err = document.getElementById('exportErr');
                if (p1.length < 8) { err.style.display=''; err.textContent='Passphrase must be at least 8 characters.'; throw new Error('short'); }
                if (p1 !== p2)     { err.style.display=''; err.textContent='Passphrases do not match.'; throw new Error('mismatch'); }
                return p1;
            }},
            { label: 'Cancel', kind: 'outline', value: null },
        ],
    });
    if (!r || typeof r !== 'string') return;
    try {
        const resp = await fetch('/api/wallet/' + curWallet + '/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ passphrase: r }),
        });
        if (!resp.ok) {
            const d = await resp.json().catch(() => ({}));
            throw new Error(d.error || 'HTTP ' + resp.status);
        }
        const blob = await resp.blob();
        const url  = URL.createObjectURL(blob);
        const cd   = resp.headers.get('Content-Disposition') || '';
        const name = (cd.match(/filename="([^"]+)"/) || [])[1] || (curWallet + '-backup.gws');
        const a    = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (e) { alert('Backup failed: ' + e.message); }
});

q('deleteWalletBtn').addEventListener('click', async () => {
    if (!curWallet) return;
    if (!confirm('Remove wallet "' + curWallet + '" from the list?')) return;
    const delFiles = confirm('Also DELETE all wallet files from disk?\n\nOK = delete files  |  Cancel = keep files');
    try {
        await fetch('/api/wallet/' + encodeURIComponent(curWallet) + '?files=' + (delFiles ? '1' : '0'),
                    { method: 'DELETE' });
        curWallet = null;
        await refreshWallets();
        hideEl('dashboardPanel');
        showEl('noSelectionPanel');
    } catch (e) { alert(e.message); }
});

// ── Services ──────────────────────────────────────────────────────────────────
q('listenerBtn').addEventListener('click', async () => {
    const w = allWallets.find(x => x.name === curWallet);
    if (!w) return;
    try {
        if (w.listenerRunning) await apiPost('/api/wallet/' + w.name + '/stop-listener');
        else                   await apiPost('/api/wallet/' + w.name + '/start-listener');
        await refreshWallets();
        const updated = allWallets.find(x => x.name === curWallet);
        if (updated) updateServicesPanel(updated);
    } catch (e) { alert(e.message); }
});

q('ownerBtn').addEventListener('click', async () => {
    const w = allWallets.find(x => x.name === curWallet);
    if (!w) return;
    try {
        if (w.ownerRunning) await apiPost('/api/wallet/' + w.name + '/stop-owner');
        else                await apiPost('/api/wallet/' + w.name + '/start-owner');
        await refreshWallets();
        const updated = allWallets.find(x => x.name === curWallet);
        if (updated) { updateServicesPanel(updated); if (updated.ownerRunning) refreshBalance(updated.name); }
    } catch (e) { alert(e.message); }
});

// ── Node status bar (wallet dashboard) ───────────────────────────────────────
async function refreshNodeStatus() {
    const bar = q('nodeStatus'), txt = q('nodeBarText');
    try {
        const d = await apiGet('/api/node/status');
        if (!d.reachable) {
            bar.className = 'node-bar offline';
            txt.textContent = (d.node_type === 'local' ? 'LOCAL NODE' : d.node_url) + '  OFFLINE';
            return;
        }
        const synced = d.sync_status === 'no_sync';
        bar.className = 'node-bar ' + (synced ? 'online' : 'syncing');
        const label = d.node_type === 'local' ? 'LOCAL NODE' : (new URL(d.node_url).hostname || d.node_url);
        const parts = [label, 'HEIGHT ' + Number(d.height).toLocaleString(),
                       d.connections > 0 ? d.connections + ' PEERS' : '',
                       synced ? 'SYNCED' : d.sync_status.toUpperCase().replace(/_/g,' ')].filter(Boolean);
        txt.textContent = parts.join('  \xb7  ');
    } catch { bar.className = 'node-bar offline'; txt.textContent = 'NODE UNREACHABLE'; }
}

// ── Address copy ──────────────────────────────────────────────────────────────
function copyAddr(addrId, msgId) {
    const t = q(addrId)?.textContent;
    if (t && t.length > 10) navigator.clipboard?.writeText(t).then(() => clipMsg(msgId));
}
q('copyAddrBtn').addEventListener('click',        () => copyAddr('walletAddress',  'addrClipMsg'));
q('copyReceiveAddrBtn').addEventListener('click', () => copyAddr('receiveAddress', 'receiveAddrClip'));

// ── QR code for receive address ──────────────────────────────────────────────
// Uses qrcode-generator (Kazuhiko Arase, MIT). Loaded as a global `qrcode`.
function renderReceiveQr(address) {
    const wrap = q('receiveQrWrap');
    const target = q('receiveQr');
    if (!target || !wrap || typeof qrcode !== 'function') return;
    if (!address || address.length < 10 || address.includes('─')) {
        target.innerHTML = '';
        return;
    }
    try {
        // typeNumber=0 → auto-select; errorCorrectionLevel='L' fits longer text
        const qr = qrcode(0, 'L');
        qr.addData(address);
        qr.make();
        // 5px module size, 4px margin (standard "quiet zone")
        target.innerHTML = qr.createImgTag(5, 16);
    } catch (e) {
        target.innerHTML = '<span class="error">QR render failed: ' + esc(e.message) + '</span>';
    }
}

// ── QR scanner (Send tab) — uses BarcodeDetector if available, image-decode otherwise
async function decodeQrFromImage(file) {
    if (!file || !file.type.startsWith('image/')) throw new Error('Not an image file');
    // Prefer BarcodeDetector (Chrome/Edge); fall back to drawing onto canvas and
    // using qrcode-generator's reverse decode if exposed (qrcode-generator does
    // NOT decode — only encodes — so this is encoder-only). For decoding we
    // rely on BarcodeDetector; if absent, surface a clear error.
    if ('BarcodeDetector' in window) {
        const det = new BarcodeDetector({ formats: ['qr_code'] });
        const bmp = await createImageBitmap(file);
        const results = await det.detect(bmp);
        if (results && results.length) return results[0].rawValue;
        throw new Error('No QR code found in image');
    }
    throw new Error('Browser does not support QR scanning. Use Chrome or Edge, or paste the address manually.');
}

q('scanQrBtn')?.addEventListener('click', () => q('scanQrFile')?.click());
q('scanQrFile')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
        const text = await decodeQrFromImage(file);
        if (text && ADDR_RE.test(text.trim())) {
            q('sendTorDest').value = text.trim();
        } else {
            // Accept any string but warn the user it doesn't look like a Grin address
            q('sendTorDest').value = text.trim();
            alert('Scanned, but the content doesn\'t look like a Grin slatepack address (grin1… or tgrin1…). Verify before sending.');
        }
    } catch (err) {
        alert('QR scan failed: ' + err.message);
    } finally {
        e.target.value = '';   // allow re-selecting the same file
    }
});

q('toggleQrBtn')?.addEventListener('click', () => {
    const wrap = q('receiveQrWrap');
    if (!wrap) return;
    const showing = wrap.style.display !== 'none';
    if (showing) {
        wrap.style.display = 'none';
        q('toggleQrBtn').textContent = 'Show QR';
    } else {
        const addr = q('receiveAddress')?.textContent || '';
        renderReceiveQr(addr);
        wrap.style.display = '';
        q('toggleQrBtn').textContent = 'Hide QR';
    }
});

// ── Modal helper ──────────────────────────────────────────────────────────────
// showModal({ title, body, actions: [{ label, kind, onClick }] })
// kind: 'primary' | 'outline' | 'danger'  (defaults to outline)
function showModal({ title = 'Confirm', body = '', actions = [] }) {
    return new Promise(resolve => {
        const overlay = q('modalOverlay');
        if (!overlay) return resolve(null);
        q('modalTitle').textContent = title;
        q('modalBody').innerHTML    = body;
        const actEl = q('modalActions');
        actEl.innerHTML = '';
        const close = (val) => { overlay.style.display = 'none'; resolve(val); };
        actions.forEach((a, i) => {
            const btn = document.createElement('button');
            const kind = a.kind === 'primary' ? 'btn btn-primary'
                       : a.kind === 'danger'  ? 'btn btn-outline'
                       : 'btn btn-outline';
            btn.className = kind;
            if (a.kind === 'danger') btn.style.color = 'var(--error)';
            btn.textContent = a.label;
            btn.addEventListener('click', async () => {
                try { const r = a.onClick ? await a.onClick() : a.value; close(r); }
                catch (e) { close({ error: e.message }); }
            });
            actEl.appendChild(btn);
        });
        overlay.style.display = '';
        overlay.onclick = (e) => { if (e.target === overlay) close(null); };
    });
}

// ── Address book ──────────────────────────────────────────────────────────────
let addrBookCache = {}; // { [walletName]: [{ address, label, ... }, ...] }

async function loadAddrBook(walletName) {
    try {
        const d = await apiGet('/api/wallet/' + walletName + '/address-book');
        addrBookCache[walletName] = d.entries || [];
    } catch { addrBookCache[walletName] = []; }
    return addrBookCache[walletName];
}

function findAddrEntry(walletName, address) {
    return (addrBookCache[walletName] || []).find(e => e.address === address) || null;
}

function renderRecentRecipients() {
    const el = q('sendTorRecent');
    if (!el || !curWallet) return;
    const entries = (addrBookCache[curWallet] || []).slice(0, 5);
    if (!entries.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = entries.map(e =>
        '<div class="recent-list-item" data-addr="' + esc(e.address) + '">'
        + '<span class="recent-list-item-label">' + esc(e.label || '(no label)') + '</span>'
        + '<span class="recent-list-item-addr">' + esc(e.address.slice(0, 14)) + '…' + esc(e.address.slice(-6)) + '</span>'
        + '</div>'
    ).join('');
    el.querySelectorAll('.recent-list-item').forEach(item =>
        item.addEventListener('click', () => {
            q('sendTorDest').value = item.dataset.addr;
            el.style.display = 'none';
        })
    );
}

function renderAddrBook() {
    const section = q('addressBookSection');
    const list    = q('addrBookList');
    const label   = q('addrBookWalletLabel');
    if (!section || !list) return;
    if (!curWallet) { section.style.display = 'none'; return; }
    section.style.display = '';
    label.textContent = '(' + curWallet + ')';
    const entries = addrBookCache[curWallet] || [];
    if (!entries.length) {
        list.innerHTML = '<div class="addr-book-empty">No saved addresses yet. Successful Tor sends are saved here automatically.</div>';
        return;
    }
    list.innerHTML = entries.map(e => {
        const short = esc(e.address.slice(0, 14)) + '…' + esc(e.address.slice(-8));
        const total = e.totalSent && Number(e.totalSent) > 0 ? esc(Number(e.totalSent).toFixed(3)) + ' ∩ · ' : '';
        const cnt   = (e.sendCount || 0) + (e.sendCount === 1 ? ' send' : ' sends');
        return '<div class="addr-book-item">'
            + '<input type="text" class="addr-book-label-input" data-addr="' + esc(e.address) + '" value="' + esc(e.label || '') + '" placeholder="(no label)" maxlength="64">'
            + '<span class="addr-book-addr" title="' + esc(e.address) + '">' + short + '</span>'
            + '<span class="addr-book-meta">' + total + cnt + '</span>'
            + '<button class="addr-book-del" data-addr="' + esc(e.address) + '" title="Remove">&times;</button>'
            + '</div>';
    }).join('');
    list.querySelectorAll('.addr-book-label-input').forEach(input =>
        input.addEventListener('change', async () => {
            try {
                await apiPost('/api/wallet/' + curWallet + '/address-book',
                    { address: input.dataset.addr, label: input.value.trim() });
                await loadAddrBook(curWallet);
            } catch (e) { alert(e.message); }
        })
    );
    list.querySelectorAll('.addr-book-del').forEach(btn =>
        btn.addEventListener('click', async () => {
            const entry = (addrBookCache[curWallet] || []).find(e => e.address === btn.dataset.addr);
            const short = esc(btn.dataset.addr.slice(0, 14)) + '…' + esc(btn.dataset.addr.slice(-8));
            const lbl   = entry?.label ? '<strong>' + esc(entry.label) + '</strong> &mdash; ' : '';
            const ok = await showModal({
                title: 'Remove from address book?',
                body:  '<p>' + lbl + '<code>' + short + '</code></p>'
                     + '<p class="field-hint" style="margin-top:8px">Future sends to this address will trigger the 0.1 ∩ test-send warning again. The address itself is not touched on the blockchain.</p>',
                actions: [
                    { label: 'Remove',  kind: 'danger',  value: true  },
                    { label: 'Cancel',  kind: 'outline', value: false },
                ],
            });
            if (!ok) return;
            try {
                await fetch('/api/wallet/' + curWallet + '/address-book/' + encodeURIComponent(btn.dataset.addr), { method: 'DELETE' });
                await loadAddrBook(curWallet);
                renderAddrBook();
                renderRecentRecipients();
            } catch (e) { alert(e.message); }
        })
    );
}

// ── Locked outputs recovery ──────────────────────────────────────────────────
async function recoverLockedOutputs() {
    if (!curWallet) return;
    let stuck = [];
    try {
        const d = await apiGet('/api/wallet/' + curWallet + '/locked-outputs');
        stuck = d.txs || [];
    } catch (e) { alert('Could not list stuck txs: ' + e.message); return; }
    if (!stuck.length) {
        await showModal({ title: 'Nothing to Recover', body: 'No stuck pending sends were found.', actions: [{ label: 'OK', kind: 'primary' }] });
        return;
    }
    const lines = stuck.map(t => '<li><code>' + esc(t.tx_slate_id || ('id ' + t.id)) + '</code> &mdash; ' + esc(fmt(t.amount_debited || '0')) + '</li>').join('');
    const confirmed = await showModal({
        title: 'Recover Locked Outputs',
        body:  '<p>The following pending sends will be cancelled and their outputs unlocked:</p><ul style="margin:10px 0 0 18px;font-size:13px">' + lines + '</ul>'
            + '<p class="field-hint" style="margin-top:12px">This only affects txs that were never broadcast. Confirmed sends are unaffected.</p>',
        actions: [
            { label: 'Cancel & Unlock', kind: 'primary', value: true },
            { label: 'Keep Pending',     kind: 'outline', value: false },
        ],
    });
    if (!confirmed) return;
    let failures = [];
    for (const t of stuck) {
        try { await apiPost('/api/wallet/' + curWallet + '/cancel-tx', { tx_slate_id: t.tx_slate_id }); }
        catch (e) { failures.push(t.tx_slate_id + ': ' + e.message); }
    }
    if (failures.length) alert('Some recoveries failed:\n' + failures.join('\n'));
    refreshBalance(curWallet);
}

q('recoverLockedBtn')?.addEventListener('click', recoverLockedOutputs);

// ── Send: Tor availability + Tor send form ───────────────────────────────────
async function refreshSendTorAvailability() {
    const panel  = q('sendTorPanel');
    const statEl = q('sendTorStatus');
    if (!panel || !statEl) return;
    let running = false, msg = 'Tor not running', cls = 'warn';
    try {
        const d = await apiGet('/api/setup/tor-status');
        running = !!d.running;
        if (running)             { msg = 'Running'; cls = 'ok'; }
        else if (d.serviceActive){ msg = 'Service active, port 9050 not yet listening'; cls = 'warn'; }
        else if (d.portOpen)     { msg = 'Port 9050 listening, systemd unit inactive'; cls = 'warn'; }
        else                     { msg = 'Tor not running — on host: sudo systemctl start tor'; cls = 'error'; }
    } catch { msg = 'Status unavailable'; cls = 'error'; }
    statEl.textContent = msg;
    statEl.className = 'send-method-status ' + cls;
    panel.title = running ? '' : msg;
    panel.classList.toggle('send-method-disabled', !running);
}

const TEST_AMOUNT = 0.1;  // ∩ — hardcoded test-send threshold

async function executeTorSend(amount, dest) {
    const el  = q('sendTorResult');
    const btn = q('sendTorBtn');
    btn.disabled = true;
    resultBox(el, '', '<p class="loading">CONNECTING VIA TOR &amp; FINALIZING&hellip;</p><p class="field-hint">This can take up to 30 seconds.</p>');
    try {
        const proofAddress = q('sendTorProofAddr')?.value?.trim() || null;
        const d = await apiPost('/api/wallet/' + curWallet + '/send', { amount, method: 'tor', dest, proofAddress });
        const idLine = d.txId ? '<p><strong>TX ID:</strong> <code>' + esc(d.txId) + '</code></p>' : '';
        resultBox(el, 'success',
            '<p class="ok-text"><strong>BROADCAST SUCCESSFUL</strong></p>'
            + '<p>Sent <strong>' + esc(String(amount)) + ' ∩</strong> to <code>' + esc(dest.slice(0, 16)) + '…</code></p>'
            + idLine
            + '<p class="field-hint">Check the History tab once the next block confirms.</p>');
        q('sendTorAmount').value = '';   // keep dest in field for follow-up sends
        if (curWallet) { await loadAddrBook(curWallet); renderRecentRecipients(); renderAddrBook(); refreshBalance(curWallet); }
        return true;
    } catch (err) {
        resultBox(el, 'error', '<strong>ERROR:</strong> ' + esc(err.message)
            + '<p class="field-hint mt-8">If outputs got locked, recover them from the Wallet tab.</p>');
        return false;
    } finally { btn.disabled = false; }
}

q('sendTorForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!curWallet) return;
    const amount = parseFloat(q('sendTorAmount').value);
    const dest   = q('sendTorDest').value.trim();
    const el     = q('sendTorResult');
    if (!amount || amount <= 0)                  { resultBox(el, 'error', '<strong>ERROR:</strong> Invalid amount'); return; }
    if (!ADDR_RE.test(dest))                     { resultBox(el, 'error', '<strong>ERROR:</strong> Invalid recipient (expected grin1… for mainnet, tgrin1… for testnet)'); return; }

    // C2: HARD-BLOCK on network mismatch. No "send anyway" — sending mainnet
    // GRIN to a tgrin1 recipient (or vice versa) burns the funds.
    const w = allWallets.find(x => x.name === curWallet);
    const destNet = addressNetwork(dest);
    if (w && destNet && destNet !== w.network) {
        await showModal({
            title: '⛔ Network mismatch',
            body:  '<p>This wallet is <strong>' + w.network.toUpperCase() + '</strong> but the recipient address is <strong>' + destNet.toUpperCase() + '</strong>.</p>'
                 + '<p class="error-inline" style="display:block;margin-top:8px">Sending across networks <strong>burns the funds permanently</strong> — neither side can recover them.</p>'
                 + '<p class="field-hint mt-8">If you meant to send on a different network, switch wallets in the sidebar first.</p>',
            actions: [
                { label: 'Cancel', kind: 'primary', value: null },
            ],
        });
        resultBox(el, 'error', '<strong>BLOCKED:</strong> Network mismatch — this send was prevented to protect your funds.');
        return;
    }

    // First-send warning: unknown address + amount above test threshold.
    // "Known but not testPassed" = the user manually labelled it but hasn't
    // actually completed a successful send yet — still treat as new.
    const known = findAddrEntry(curWallet, dest);
    const isUnknown = !known || !known.testPassed;
    if (isUnknown && amount > TEST_AMOUNT) {
        const short = esc(dest.slice(0, 18)) + '…' + esc(dest.slice(-8));
        const seenBefore = known && !known.testPassed;
        const headline = seenBefore
            ? '<p>This address is in your address book but you haven\'t completed a successful send to it yet.</p>'
            : '<p>You haven\'t sent to <code>' + short + '</code> before.</p>';
        const choice = await showModal({
            title: seenBefore ? 'No confirmed sends yet' : 'First send to this address',
            body:  headline
                 + '<p>It\'s safer to send a small <strong>0.1 ∩</strong> test first to confirm the address is correct, then send the full amount.</p>',
            actions: [
                { label: 'Send 0.1 ∩ test first', kind: 'primary', value: 'test' },
                { label: 'Send ' + amount + ' ∩ anyway', kind: 'outline', value: 'full' },
                { label: 'Cancel', kind: 'outline', value: null },
            ],
        });
        if (!choice) return;
        if (choice === 'test') {
            const ok = await executeTorSend(TEST_AMOUNT, dest);
            if (ok) {
                // keep the original amount loaded so user can confirm + click Send again
                q('sendTorAmount').value = String(amount);
                q('sendTorDest').value   = dest;
            }
            return;
        }
        // 'full' → fall through to the normal send
    }
    await executeTorSend(amount, dest);
});

// ── F17: Batch CSV send via Tor ──────────────────────────────────────────────
q('batchSendBtn')?.addEventListener('click', async () => {
    if (!curWallet) return;
    const el = q('batchSendResult');
    const raw = q('batchSendInput')?.value || '';
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) { resultBox(el, 'error', 'No rows.'); return; }

    // Parse + validate first; abort if any row is bad
    const w = allWallets.find(x => x.name === curWallet);
    const walletNet = w?.network;
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
        const parts = lines[i].split(',').map(p => p.trim());
        const addr = parts[0]; const amt = parseFloat(parts[1]); const label = parts[2] || '';
        if (!ADDR_RE.test(addr))         { resultBox(el, 'error', 'Line ' + (i + 1) + ': invalid address (expected grin1… for mainnet, tgrin1… for testnet)'); return; }
        if (!isFinite(amt) || amt <= 0)  { resultBox(el, 'error', 'Line ' + (i + 1) + ': invalid amount'); return; }
        const aNet = addressNetwork(addr);
        if (walletNet && aNet && aNet !== walletNet) {
            resultBox(el, 'error', 'Line ' + (i + 1) + ': NETWORK MISMATCH — wallet is ' + walletNet.toUpperCase() + ' but address is ' + aNet.toUpperCase() + '. Batch refused to protect funds.');
            return;
        }
        rows.push({ addr, amt, label });
    }

    const total = rows.reduce((s, r) => s + r.amt, 0);

    // G8: estimate fees for each row in parallel before confirming.
    // Falls back to "?" if an estimate fails (still shows the row).
    resultBox(el, '', '<p class="loading">Estimating fees…</p>');
    const feeResults = await Promise.allSettled(
        rows.map(r => apiPost('/api/wallet/' + curWallet + '/fee', { amount: r.amt }).then(d => Number(d.fee) || null).catch(() => null))
    );
    const feesNano = feeResults.map(r => r.status === 'fulfilled' && r.value != null ? r.value : null);
    const totalFeeNano = feesNano.reduce((s, f) => s + (f || 0), 0);
    const totalFee = totalFeeNano / 1e9;
    const grandTotal = total + totalFee;
    el.style.display = 'none';

    const ok = await showModal({
        title: 'Confirm batch send',
        body:  '<p>' + rows.length + ' transactions via Tor.</p>'
             + '<table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:10px">'
               + '<thead><tr style="text-align:left;color:var(--text-dim)"><th>Recipient</th><th style="text-align:right">Amount (∩)</th><th style="text-align:right">Fee (∩)</th></tr></thead>'
               + '<tbody>' + rows.map((r, i) => {
                   const fee = feesNano[i] != null ? (feesNano[i] / 1e9).toFixed(7) : '?';
                   return '<tr style="border-top:1px solid rgba(255,255,255,0.05)">'
                       + '<td><code>' + esc(r.addr.slice(0,14)) + '…</code>' + (r.label ? ' <span style="color:var(--text-dim)">(' + esc(r.label) + ')</span>' : '') + '</td>'
                       + '<td style="text-align:right">' + esc(r.amt) + '</td>'
                       + '<td style="text-align:right">' + esc(fee) + '</td>'
                       + '</tr>';
               }).join('') + '</tbody>'
               + '<tfoot><tr style="border-top:2px solid rgba(255,255,255,0.15);font-weight:600">'
                 + '<td>Total</td>'
                 + '<td style="text-align:right">' + total.toFixed(7) + ' ∩</td>'
                 + '<td style="text-align:right">' + totalFee.toFixed(7) + ' ∩</td>'
               + '</tr>'
               + '<tr><td colspan="2">Grand total</td><td style="text-align:right;font-weight:700">' + grandTotal.toFixed(7) + ' ∩</td></tr></tfoot>'
             + '</table>'
             + '<p class="field-hint mt-8">Each send takes up to 30s. If one fails, the batch stops.</p>',
        actions: [
            { label: 'Send All',    kind: 'primary', value: true },
            { label: 'Cancel',      kind: 'outline', value: false },
        ],
    });
    if (!ok) return;

    const btn = q('batchSendBtn'); btn.disabled = true;
    const results = [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        resultBox(el, '', '<p class="loading">Sending ' + (i + 1) + ' of ' + rows.length + ': ' + esc(r.amt) + ' ∩ → ' + esc(r.addr.slice(0, 14)) + '…</p>');
        try {
            const d = await apiPost('/api/wallet/' + curWallet + '/send', { amount: r.amt, method: 'tor', dest: r.addr });
            results.push({ ok: true, row: r, txId: d.txId });
        } catch (e) {
            results.push({ ok: false, row: r, error: e.message });
            break;     // stop on first failure
        }
    }
    btn.disabled = false;

    const okCount  = results.filter(r => r.ok).length;
    const failCount = results.filter(r => !r.ok).length;
    const lines2 = results.map(r => r.ok
        ? '<li class="ok-text">✓ ' + esc(r.row.amt) + ' ∩ → <code>' + esc(r.row.addr.slice(0,14)) + '…</code></li>'
        : '<li class="error">✗ ' + esc(r.row.amt) + ' ∩ → <code>' + esc(r.row.addr.slice(0,14)) + '…</code> — ' + esc(r.error) + '</li>'
    ).join('');
    resultBox(el, failCount ? 'error' : 'success',
        '<p><strong>' + okCount + ' sent · ' + failCount + ' failed</strong></p>'
        + '<ul style="margin:8px 0 0 18px;font-size:12px">' + lines2 + '</ul>'
        + (failCount ? '<p class="field-hint mt-8">Batch stopped after first failure. Remaining rows were not attempted.</p>' : ''));
    if (curWallet) refreshBalance(curWallet);
});

// ── Send ──────────────────────────────────────────────────────────────────────
q('sendForm').addEventListener('submit', async e => {
    e.preventDefault();
    const amount = q('sendAmount').value;
    const el     = q('sendResult');
    resultBox(el, '', '<p class="loading">GENERATING SLATEPACK...</p>');
    try {
        const fee = await apiPost('/api/wallet/' + curWallet + '/fee', { amount: parseFloat(amount) }).then(d => d.fee ? fmt(d.fee) : '?').catch(() => '?');
        resultBox(el, '', '<p class="info">Est. fee: <strong>' + esc(fee) + '</strong></p><p class="loading">CREATING SLATEPACK...</p>');
        const d = await apiPost('/api/wallet/' + curWallet + '/send', { amount: parseFloat(amount) });
        resultBox(el, 'success', '<p><strong>SLATEPACK — share with recipient:</strong></p>'
            + '<textarea readonly class="slate-textarea" id="sendSlateText">' + esc(d.slatepack) + '</textarea>'
            + '<button onclick="navigator.clipboard.writeText(document.getElementById(\'sendSlateText\').value).then(()=>clipMsg(\'sendClipMsg\'))" class="btn btn-sm mt-8">[ COPY ]</button>'
            + '<span id="sendClipMsg" class="clip-msg"></span>');
        q('sendForm').reset(); setText('feeEstimate', '');
    } catch (err) { resultBox(el, 'error', '<strong>ERROR:</strong> ' + esc(err.message)); }
});

q('sendAmount').addEventListener('input', async e => {
    const el = q('feeEstimate'), v = e.target.value;
    if (v && parseFloat(v) > 0 && curWallet) {
        el.textContent = 'ESTIMATING FEE...';
        const fee = await apiPost('/api/wallet/' + curWallet + '/fee', { amount: parseFloat(v) }).then(d => d.fee ? fmt(d.fee) : '?').catch(() => '?');
        el.textContent = 'EST. FEE: ' + fee;
    } else { el.textContent = ''; }
});

// ── Receive ───────────────────────────────────────────────────────────────────
q('processSlateBtn').addEventListener('click', async () => {
    const text = q('receiveSlateInput').value.trim();
    const el   = q('receiveResult');
    if (!text || !/BEGINSLATEPACK/i.test(text)) { resultBox(el, 'error', 'Paste a valid BEGINSLATEPACK...ENDSLATEPACK.'); return; }
    resultBox(el, '', '<p class="loading">PROCESSING...</p>');
    try {
        const d = await apiPost('/api/wallet/' + curWallet + '/receive', { slatepack: text });
        resultBox(el, 'success', '<p><strong>PROCESSED — send back to sender:</strong></p>'
            + '<textarea readonly class="slate-textarea" id="rcvRespText">' + esc(d.response_slatepack) + '</textarea>'
            + '<button onclick="navigator.clipboard.writeText(document.getElementById(\'rcvRespText\').value).then(()=>clipMsg(\'rcvClip\'))" class="btn btn-sm mt-8">[ COPY ]</button>'
            + '<span id="rcvClip" class="clip-msg"></span>');
    } catch (e) { resultBox(el, 'error', '<strong>ERROR:</strong> ' + esc(e.message)); }
});

q('finalizeBtn').addEventListener('click', async () => {
    const text = q('finalizeSlateInput').value.trim();
    const el   = q('finalizeResult');
    if (!text || !/BEGINSLATEPACK/i.test(text)) { resultBox(el, 'error', 'Paste the response Slatepack.'); return; }
    resultBox(el, '', '<p class="loading">FINALIZING AND BROADCASTING...</p>');
    try {
        await apiPost('/api/wallet/' + curWallet + '/finalize', { slatepack: text });
        resultBox(el, 'success', '<p><strong>FINALIZED AND BROADCAST.</strong></p><p class="info">Confirmed after ~10 blocks.</p>');
        q('finalizeSlateInput').value = '';
        setTimeout(() => refreshBalance(curWallet), 3000);
    } catch (e) { resultBox(el, 'error', '<strong>ERROR:</strong> ' + esc(e.message)); }
});

// F14: Verify payment proof
q('verifyProofBtn')?.addEventListener('click', async () => {
    const text = q('verifyProofInput')?.value?.trim() || '';
    const el   = q('verifyProofResult');
    if (!text)    { resultBox(el, 'error', 'Paste the payment proof JSON.'); return; }
    if (!curWallet) { resultBox(el, 'error', 'Open a wallet first.'); return; }
    let proof;
    try { proof = JSON.parse(text); }
    catch { resultBox(el, 'error', 'Invalid JSON.'); return; }
    resultBox(el, '', '<p class="loading">VERIFYING&hellip;</p>');
    try {
        const d = await apiPost('/api/wallet/' + curWallet + '/verify-proof', { proof });
        const r = d.result;
        // grin-wallet returns [sender_ours, recipient_ours]
        const senderOurs    = Array.isArray(r) ? r[0] : r?.sender_ours;
        const recipientOurs = Array.isArray(r) ? r[1] : r?.recipient_ours;
        resultBox(el, 'success',
            '<p class="ok-text"><strong>PROOF VALID.</strong></p>'
            + '<p>Sender address belongs to this wallet: <strong>' + (senderOurs ? 'Yes' : 'No') + '</strong></p>'
            + '<p>Recipient address belongs to this wallet: <strong>' + (recipientOurs ? 'Yes' : 'No') + '</strong></p>'
            + (senderOurs || recipientOurs ? '' : '<p class="field-hint">Proof is cryptographically valid but neither party is this wallet.</p>'));
    } catch (e) {
        resultBox(el, 'error', '<strong>VERIFICATION FAILED:</strong> ' + esc(e.message));
    }
});

// ── History ───────────────────────────────────────────────────────────────────
let historyState = { txs: [], shown: 0, pageSize: 25, currentHeight: 0 };

function txTypeLabel(t) {
    return {
        TxSent:              'Sent',
        TxReceived:          'Received',
        TxSentCancelled:     'Sent (cancelled)',
        TxReceivedCancelled: 'Received (cancelled)',
        ConfirmedCoinbase:   'Mining reward',
        TxReverted:          'Reverted',
    }[t] || (t || 'Transaction');
}

// Per-tx notes stored in localStorage, keyed by wallet name + tx_slate_id
function txNoteKey(walletName, slateId) { return 'grin-tx-note|' + walletName + '|' + slateId; }
function getTxNote(walletName, slateId) { return localStorage.getItem(txNoteKey(walletName, slateId)) || ''; }
function setTxNote(walletName, slateId, note) {
    const k = txNoteKey(walletName, slateId);
    if (note) localStorage.setItem(k, note.slice(0, 200));
    else      localStorage.removeItem(k);
}

function renderHistoryPage() {
    const el     = q('transactionsList');
    const more   = q('historyMoreBtn');
    const count  = q('historyCount');
    const txs    = historyState.txs.slice(0, historyState.shown);
    if (!historyState.txs.length) {
        el.innerHTML = '<p class="info">No transactions yet.</p>';
        if (count) count.textContent = '';
        if (more)  more.style.display = 'none';
        return;
    }

    el.innerHTML = txs.map(tx => {
        const cr = BigInt(tx.amount_credited || '0'), db = BigInt(tx.amount_debited || '0');
        const net = cr - db, abs = net < 0n ? -net : net;
        const ts  = tx.creation_ts ? new Date(tx.creation_ts).toLocaleString() : '—';
        const kern = tx.kernel_excess ? '<code class="tx-kernel">' + esc(tx.kernel_excess) + '</code>' : '—';
        const note = getTxNote(curWallet, tx.tx_slate_id || tx.id);
        const slateRef = esc(tx.tx_slate_id || ('id ' + tx.id));

        // Confirmation depth (F9)
        let depth = null, depthLabel = '', statusCls = 'pending', statusTxt = 'PENDING';
        if (tx.tx_type === 'TxSentCancelled' || tx.tx_type === 'TxReceivedCancelled') {
            statusCls = 'cancelled'; statusTxt = 'CANCELLED';
        } else if (tx.confirmed && tx.confirmation_height && historyState.currentHeight) {
            depth = Math.max(0, Number(historyState.currentHeight) - Number(tx.confirmation_height));
            statusCls = depth >= 10 ? 'confirmed' : 'confirming';
            statusTxt = depth >= 10 ? 'CONFIRMED · ' + depth + ' deep' : 'CONFIRMING · ' + depth + '/10';
            depthLabel = depth + ' confirmations';
        } else if (tx.confirmed) {
            statusCls = 'confirmed'; statusTxt = 'CONFIRMED';
        }

        return '<details class="transaction-item" data-slate="' + esc(tx.tx_slate_id || '') + '">'
            + '<summary class="tx-summary">'
              + '<div class="tx-info"><h4>' + esc(txTypeLabel(tx.tx_type)) + '</h4><p>' + ts + '</p></div>'
              + '<div class="tx-amount ' + (net >= 0n ? 'credit' : 'debit') + '">' + (net >= 0n ? '+' : '-') + fmt(abs.toString()) + '</div>'
              + '<div class="tx-status ' + statusCls + '">' + statusTxt + '</div>'
            + '</summary>'
            + '<div class="tx-details">'
              + '<p><strong>Fee:</strong> ' + (tx.fee != null ? fmt(tx.fee) : '—') + '</p>'
              + '<p><strong>Slate ID:</strong> <code>' + slateRef + '</code></p>'
              + (depthLabel ? '<p><strong>Depth:</strong> ' + esc(depthLabel) + '</p>' : '')
              + '<p><strong>Kernel:</strong> ' + kern + '</p>'
              + '<div class="tx-note-row">'
                + '<label class="tx-note-label">Note:</label>'
                + '<input type="text" class="input tx-note-input" data-slate="' + esc(tx.tx_slate_id || '') + '" value="' + esc(note) + '" placeholder="Add a private note (stored locally)" maxlength="200">'
              + '</div>'
            + '</div>'
          + '</details>';
    }).join('');

    // Wire note inputs
    el.querySelectorAll('.tx-note-input').forEach(inp =>
        inp.addEventListener('change', () => setTxNote(curWallet, inp.dataset.slate, inp.value.trim()))
    );

    if (count) count.textContent = 'Showing ' + txs.length + ' of ' + historyState.txs.length;
    if (more)  more.style.display = historyState.shown < historyState.txs.length ? '' : 'none';
}

async function refreshHistory() {
    const el = q('transactionsList');
    el.innerHTML = '<p class="loading">LOADING TRANSACTIONS...</p>';
    try {
        const data = await apiGet('/api/wallet/' + curWallet + '/txs');
        // Try to grab current node height for confirmation-depth calculation
        let currentHeight = 0;
        try { currentHeight = (balCache[curWallet]?.height) || 0; } catch {}
        if (!currentHeight) {
            try { const st = await apiGet('/api/wallet/' + curWallet + '/status'); currentHeight = st.height || 0; } catch {}
        }
        historyState = {
            txs:           (data.txs || []).slice().reverse(),
            shown:         25,
            pageSize:      25,
            currentHeight,
        };
        renderHistoryPage();
    } catch (e) { el.innerHTML = '<p class="error">Failed: ' + esc(e.message) + '</p>'; }
}

q('historyMoreBtn')?.addEventListener('click', () => {
    historyState.shown += historyState.pageSize;
    renderHistoryPage();
});

q('historyExportBtn')?.addEventListener('click', () => {
    if (!historyState.txs.length || !curWallet) return;
    // CSV columns: Date, Type, Amount (∩), Fee (∩), Confirmations, Slate ID, Note
    const rows = [['Date', 'Type', 'Amount (∩)', 'Fee (∩)', 'Confirmations', 'Slate ID', 'Note']];
    for (const tx of historyState.txs) {
        const cr = BigInt(tx.amount_credited || '0'), db = BigInt(tx.amount_debited || '0');
        const net = Number(cr - db) / 1e9;
        const fee = tx.fee != null ? (Number(tx.fee) / 1e9).toFixed(9) : '';
        const conf = tx.confirmed && tx.confirmation_height && historyState.currentHeight
            ? Math.max(0, Number(historyState.currentHeight) - Number(tx.confirmation_height))
            : (tx.confirmed ? '✓' : '');
        const ts = tx.creation_ts ? new Date(tx.creation_ts).toISOString() : '';
        const note = getTxNote(curWallet, tx.tx_slate_id || tx.id);
        rows.push([ts, txTypeLabel(tx.tx_type), net.toFixed(9), fee, conf, tx.tx_slate_id || ('id ' + tx.id), note]);
    }
    const csv = rows.map(r => r.map(c => {
        const s = String(c == null ? '' : c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = 'grin-history-' + curWallet + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
});

// ── NODE tab ──────────────────────────────────────────────────────────────────

const PUBLIC_NODES = {
    mainnet: ['https://api.grin.money','https://api.grinily.com','https://api.onlygrins.com',
              'https://api.grinnode.org','https://main.gri.mw','https://grincoin.org'],
    testnet: ['https://testapi.grin.money','https://testapi.grinily.com',
              'https://testapi.onlygrins.com','https://testnet.grincoin.org','https://test.gri.mw'],
};

async function initNodeTab() {
    await Promise.all([loadLocalNode('mainnet'), loadLocalNode('testnet')]);
    pingPublicNodes('mainnet');
    pingPublicNodes('testnet');
}

async function loadLocalNode(net) {
    const cap  = net === 'mainnet' ? 'Mainnet' : 'Testnet';
    const dotEl = q('nodeLocal' + cap + 'Dot');
    const txtEl = q('nodeLocal' + cap + 'Text');
    if (!txtEl) return;
    txtEl.textContent = 'checking...';
    try {
        const d = await apiGet('/api/node/local/' + net);
        if (d.reachable) {
            dotEl.style.background = 'var(--success)';
            const synced = d.sync_status === 'no_sync';
            const parts = [
                'H ' + Number(d.height).toLocaleString(),
                d.connections + ' peers',
                synced ? 'SYNCED' : 'SYNCING',
                d.latency_ms + 'ms',
            ];
            txtEl.textContent = parts.join('  ');
        } else {
            dotEl.style.background = 'var(--grin-dim)';
            txtEl.textContent = 'not running';
        }
    } catch {
        dotEl.style.background = 'var(--grin-dim)';
        txtEl.textContent = 'not running';
    }
}

function pingPublicNodes(net) {
    const listEl = q('nodeList' + (net === 'mainnet' ? 'Mainnet' : 'Testnet'));
    if (!listEl) return;
    const curW     = allWallets.find(x => x.name === curWallet);
    const curNet   = curW?.network;
    const curUrl   = curW?.nodeUrl || null;

    listEl.innerHTML = PUBLIC_NODES[net].map(url => {
        const host       = new URL(url).hostname;
        const isSelected = curNet === net && url === curUrl;
        return '<div class="node-tab-row' + (isSelected ? ' selected' : '') + '" data-url="' + esc(url) + '" data-net="' + net + '">'
            + '<span class="node-select-dot ' + (isSelected ? 'on' : 'off') + '">' + (isSelected ? '●' : '○') + '</span>'
            + '<span class="node-tab-host">' + esc(host) + '</span>'
            + '<span class="latency-badge loading">─</span>'
            + '<button class="btn btn-sm use-node-btn">[ USE ]</button>'
            + '</div>';
    }).join('');

    listEl.querySelectorAll('.use-node-btn').forEach((btn, i) => {
        const url = PUBLIC_NODES[net][i];
        btn.addEventListener('click', () => useNode(url, net));
    });

    PUBLIC_NODES[net].forEach(async (url, i) => {
        const row   = listEl.children[i];
        if (!row) return;
        const badge = row.querySelector('.latency-badge');
        const dot   = row.querySelector('.node-select-dot');
        try {
            const d = await apiGet('/api/node/ping?url=' + encodeURIComponent(url));
            if (d.reachable) {
                badge.className   = 'latency-badge online';
                badge.textContent = d.latency_ms + 'ms';
            } else {
                badge.className   = 'latency-badge offline';
                badge.textContent = '—';
                if (dot && !dot.classList.contains('on')) {
                    dot.className   = 'node-select-dot err';
                    dot.textContent = '✗';
                }
            }
        } catch {
            badge.className   = 'latency-badge offline';
            badge.textContent = '—';
        }
    });
}

async function useNode(url, net) {
    if (!curWallet) { alert('Open a wallet first.'); return; }
    const w = allWallets.find(x => x.name === curWallet);
    if (!w || w.network !== net) {
        alert('Open a ' + net + ' wallet first to set its node.');
        return;
    }
    try {
        await apiPost('/api/wallet/node', { walletName: curWallet, nodeUrl: url });
        await refreshWallets();
        refreshNodeStatus();
        pingPublicNodes('mainnet');
        pingPublicNodes('testnet');
    } catch (e) { alert('Failed: ' + e.message); }
}

// ── Setup wizard ──────────────────────────────────────────────────────────────
function showWizardStep(n) {
    wizard.step = n;
    const titles = ['', 'WALLET DETAILS', 'NODE', 'INIT / RECOVER', 'TOR'];
    for (let i = 2; i <= 6; i++) { const el = q('wizardStep' + i); if (el) el.style.display = 'none'; }
    const panelEl = q('wizardStep' + (n <= 4 ? n + 1 : 6));
    if (panelEl) panelEl.style.display = '';
    for (let i = 1; i <= 4; i++) {
        const dot = q('wstep' + i);
        if (dot) dot.className = 'wstep' + (n === 5 ? ' done' : i === n ? ' active' : i < n ? ' done' : '');
    }
    setText('wizardStepTitle', n <= 4 ? (titles[n] || '') : 'COMPLETE');
}

// Binary panel — permanent card in setup tab
async function initBinaryPanel() {
    const infoEl     = q('binaryPanelInfo');
    const installBtn = q('binaryInstallBtn');
    if (!infoEl) return;
    infoEl.className = 'info-box mt-8';
    infoEl.innerHTML = '<span class="loading">CHECKING BINARY...</span>';
    try {
        const d = await apiGet('/api/setup/binary-status');
        if (d.installed) {
            infoEl.className = 'info-box success mt-8';
            infoEl.innerHTML = '<strong>INSTALLED</strong> &mdash; ' + esc(d.version) + '<br><small>' + esc(d.binaryPath || '') + '</small>';
            if (installBtn) installBtn.textContent = '[ REINSTALL ]';
            showEl('binaryInstallBtn');
        } else {
            infoEl.className = 'info-box warn mt-8';
            infoEl.innerHTML = 'grin-wallet binary not found at <code>' + esc(d.binaryPath || '') + '</code>';
            if (installBtn) installBtn.textContent = '[ INSTALL BINARY ]';
            showEl('binaryInstallBtn');
        }
    } catch (e) {
        infoEl.className = 'info-box error mt-8';
        infoEl.innerHTML = 'Error: ' + esc(e.message);
    }
}

q('binaryInstallBtn').addEventListener('click', async () => {
    const btn  = q('binaryInstallBtn');
    const prog = q('binaryPanelProgress');
    btn.disabled = true;
    showEl('binaryPanelProgress');
    prog.innerHTML = '<span class="loading">CONNECTING TO GITHUB...</span>';
    try {
        await streamPost('/api/setup/install-binary', {}, d => {
            if (d.error)  { prog.innerHTML = '<span class="error">ERROR: ' + esc(d.error) + '</span>'; return; }
            if (d.stage === 'downloading') prog.innerHTML = 'DOWNLOADING... ' + (d.percent || 0) + '%  (' + esc(d.version || '') + ')';
            else if (d.stage === 'extracting') prog.innerHTML = 'EXTRACTING...';
            else if (d.stage === 'done') {
                prog.innerHTML = '<span class="ok-text">INSTALLED ' + esc(d.version) + '</span>';
                initBinaryPanel();
            }
        });
    } catch (e) { prog.innerHTML = '<span class="error">FAILED: ' + esc(e.message) + '</span>'; }
    btn.disabled = false;
});

// ── Setup tab ─────────────────────────────────────────────────────────────────

function renderSetupWalletList() {
    const el = q('setupWalletList');
    if (!el) return;
    if (!allWallets.length) {
        el.innerHTML = '<div class="setup-wallet-empty">No wallets yet.</div>';
        return;
    }
    el.innerHTML = allWallets.map(w => {
        const cur = getWalletTag(w.name);
        const swatches = [0,1,2,3,4,5].map(t =>
            '<span class="tag-swatch tag-' + t + (cur === t ? ' selected' : '') + '" data-tag="' + t + '" data-wallet="' + esc(w.name) + '" title="' + (t === 0 ? 'No tag' : 'Color tag ' + t) + '"></span>'
        ).join('');
        return '<div class="setup-wallet-item">'
            + '<span class="wallet-dot ' + ((w.listenerRunning || w.ownerRunning) ? 'dot-on' : 'dot-off') + '"></span>'
            + '<span class="setup-wallet-item-name">' + esc(w.name) + '</span>'
            + '<span class="setup-wallet-tags">' + swatches + '</span>'
            + '<span class="network-badge ' + w.network + '">' + (w.network === 'testnet' ? 'TEST' : 'MAIN') + '</span>'
            + '</div>';
    }).join('');
    el.querySelectorAll('.tag-swatch[data-wallet]').forEach(sw =>
        sw.addEventListener('click', () => {
            setWalletTag(sw.dataset.wallet, parseInt(sw.dataset.tag, 10));
            renderSetupWalletList();
            renderSidebar(allWallets);
        })
    );
}

// Tor service panel — read-only status card. On Linux the host owns the
// systemd unit; install/start/stop are done via apt + systemctl on the host,
// not from this UI. Server returns { installed, serviceActive, portOpen, running, hint }.
async function initTorPanel() {
    const infoEl = q('torPanelInfo');
    if (!infoEl) return;
    infoEl.className = 'info-box mt-8';
    infoEl.innerHTML = '<span class="loading">CHECKING TOR&hellip;</span>';
    try {
        const d = await apiGet('/api/setup/tor-status');
        if (d.running) {
            infoEl.className = 'info-box success mt-8';
            infoEl.innerHTML = '<strong>RUNNING</strong> &mdash; service active, SOCKS on 127.0.0.1:9050';
        } else if (d.serviceActive) {
            infoEl.className = 'info-box warn mt-8';
            infoEl.innerHTML = '<strong>Service active</strong> but port 9050 not yet listening &mdash; wait a moment.';
        } else if (d.portOpen) {
            infoEl.className = 'info-box warn mt-8';
            infoEl.innerHTML = 'Port 9050 listening but systemd unit not reported active &mdash; manual <code>tor</code> process?';
        } else {
            infoEl.className = 'info-box mt-8';
            infoEl.innerHTML = '<strong>Not running.</strong> ' + (d.hint ? esc(d.hint) : 'Install via apt + systemctl on the host.');
        }
    } catch (e) {
        infoEl.className = 'info-box error mt-8';
        infoEl.innerHTML = 'Error: ' + esc(e.message);
    }
    refreshSendTorAvailability();
}

// ── Node Service panel removed in Linux port ─────────────────────────────────
// On Linux the toolkit's Script 01 owns node lifecycle (systemd). The NSSM /
// install-node-service / legacy Task Scheduler flow was Windows-only.

function initNotificationsSection() {
    const stat = q('notifStatus');
    const btn  = q('notifEnableBtn');
    if (!stat || !btn) return;
    if (typeof Notification === 'undefined') {
        stat.className = 'info-box warn mt-8';
        stat.innerHTML = 'Browser does not support notifications.';
        btn.style.display = 'none';
        return;
    }
    const updateUi = () => {
        if (Notification.permission === 'granted') {
            stat.className = 'info-box success mt-8';
            stat.innerHTML = '<strong>Enabled</strong> — desktop notifications active.';
            btn.style.display = 'none';
        } else if (Notification.permission === 'denied') {
            stat.className = 'info-box error mt-8';
            stat.innerHTML = '<strong>Blocked</strong> — re-enable in your browser settings (lock icon in the address bar).';
            btn.style.display = 'none';
        } else {
            stat.className = 'info-box mt-8';
            stat.innerHTML = 'Notifications not yet enabled.';
            btn.style.display = '';
        }
    };
    btn.onclick = async () => { try { await Notification.requestPermission(); } catch {} updateUi(); };
    updateUi();
}

function initSetupTab() {
    initNotificationsSection();
    initAutolockSection();
    initBinaryPanel();
    initTorPanel();
    renderSetupWalletList();
    hideEl('setupWizard');
    showEl('setupAddWalletBtn');
    if (curWallet) { loadAddrBook(curWallet).then(renderAddrBook); }
    else           { hideEl('addressBookSection'); }
}

function openAddWalletWizard() {
    wizard.step = 1; wizard.name = ''; wizard.network = 'mainnet'; wizard.dir = ''; wizard.nodeUrl = '';
    hideEl('setupAddWalletBtn');
    showEl('setupWizard');
    showWizardStep(1); wizardStep2Init();
}

function closeWizard() {
    hideEl('setupWizard');
    showEl('setupAddWalletBtn');
    renderSetupWalletList();
}

q('setupAddWalletBtn').addEventListener('click', openAddWalletWizard);

// Step 2: Wallet details
async function wizardStep2Init() {
    const net = document.querySelector('[name="wNetwork"]:checked')?.value || 'mainnet';
    const name = q('wName').value.trim() || 'main';
    try {
        const d = await apiGet('/api/setup/default-dir?network=' + net + '&name=' + encodeURIComponent(name));
        q('wDir').value = d.dir;
    } catch {}
}

document.querySelectorAll('[name="wNetwork"]').forEach(r => r.addEventListener('change', wizardStep2Init));
q('wName').addEventListener('input', () => {
    const name = q('wName').value.trim();
    if (name && /^[a-zA-Z0-9\-_]+$/.test(name)) wizardStep2Init();
});

q('wNext2').addEventListener('click', async () => {
    const name = q('wName').value.trim();
    const dir  = q('wDir').value.trim();
    const net  = document.querySelector('[name="wNetwork"]:checked')?.value || 'mainnet';
    const statusEl = q('dirStatus');
    if (!name || !/^[a-zA-Z0-9\-_]+$/.test(name)) { statusEl.className = 'info-box error'; statusEl.innerHTML = 'Invalid name — use letters, digits, hyphens, underscores.'; showEl('dirStatus'); return; }
    if (!dir) { statusEl.className = 'info-box error'; statusEl.innerHTML = 'Directory is required.'; showEl('dirStatus'); return; }
    try {
        const d = await apiPost('/api/setup/check-dir', { dir });
        if (d.hasSeed) {
            statusEl.className = 'info-box warn';
            statusEl.innerHTML = 'Existing wallet found in this directory.<br>'
                + '<button id="renameExistingBtn" class="btn btn-sm mt-8">[ RENAME &amp; CONTINUE ]</button>'
                + '  <button id="changeDirBtn" class="btn btn-sm mt-8">[ CHANGE DIRECTORY ]</button>';
            showEl('dirStatus');
            q('renameExistingBtn').addEventListener('click', async () => {
                await apiPost('/api/setup/rename-dir', { dir });
                hideEl('dirStatus');
                wizard.name = name; wizard.network = net; wizard.dir = dir;
                showWizardStep(2); wizardStep3Init();
            });
            q('changeDirBtn').addEventListener('click', () => { hideEl('dirStatus'); q('wDir').focus(); });
            return;
        }
        wizard.name = name; wizard.network = net; wizard.dir = dir;
        hideEl('dirStatus');
        showWizardStep(2); wizardStep3Init();
    } catch (e) { statusEl.className = 'info-box error'; statusEl.innerHTML = 'Error: ' + esc(e.message); showEl('dirStatus'); }
});

// Step 3: Node selection
async function wizardStep3Init() {
    const list  = q('nodePickList');
    const next  = q('wNext3');
    next.disabled = true;
    wizard.nodeUrl = '';
    list.innerHTML = '<span class="loading">CHECKING NODES...</span>';

    const results = [];
    let selectedUrl = '';

    const es = new EventSource('/api/setup/nodes?network=' + wizard.network);
    es.onmessage = e => {
        const d = JSON.parse(e.data);
        if (d.done) { es.close(); renderNodeList(); return; }
        results.push(d);
        renderNodeList();
    };
    es.onerror = () => es.close();

    function renderNodeList() {
        if (!results.length) return;
        const sorted = [...results].sort((a, b) => (b.online - a.online) || (a.latencyMs - b.latencyMs));
        list.innerHTML = sorted.map((r, i) => {
            const label   = r.isLocal ? 'Local node' : r.host;
            const status  = r.online ? ('<span class="ok-text">● online ' + r.latencyMs + 'ms</span>') : '<span class="dim-text">○ offline</span>';
            const checked = (i === 0 && !selectedUrl) ? ' checked' : (selectedUrl === r.url ? ' checked' : '');
            return '<label class="node-pick-row"><input type="radio" name="nodeChoice" value="' + esc(r.url) + '"' + checked + '> '
                + '<span class="node-pick-label">' + esc(label) + '</span> ' + status + '</label>';
        }).join('');
        const first = sorted.find(r => r.online);
        if (first && !selectedUrl) { selectedUrl = first.url; wizard.nodeUrl = first.url; next.disabled = false; }
        list.querySelectorAll('[name="nodeChoice"]').forEach(r => r.addEventListener('change', () => {
            selectedUrl = r.value; wizard.nodeUrl = r.value; next.disabled = false;
        }));
    }
}

q('wNext3').addEventListener('click', async () => {
    if (!wizard.nodeUrl) return;
    const next = q('wNext3');
    next.disabled = true;
    try {
        const d = await apiPost('/api/setup/write-config', { name: wizard.name, dir: wizard.dir, network: wizard.network, nodeUrl: wizard.nodeUrl });
        wizard.fp = d.foreignPort; wizard.op = d.ownerPort;
        await refreshWallets();
        showWizardStep(3); wizardStep4Init();
    } catch (e) { alert('Config error: ' + e.message); }
    next.disabled = false;
});

// Step 4: Init / Recover
function wizardStep4Init() {
    const modeRadios = document.querySelectorAll('[name="initMode"]');
    modeRadios.forEach(r => r.addEventListener('change', () => {
        const mode = r.value;
        q('initPassField').style.display   = mode === 'skip' ? 'none' : '';
        q('recoverSeedField').style.display = mode === 'recover' ? '' : 'none';
        q('runInitBtn').style.display       = mode === 'skip' ? 'none' : '';
        q('wNext4').disabled = (mode !== 'skip');
    }));
    hideEl('seedDisplay'); hideEl('initError'); q('wNext4').disabled = true;
}

// Seed phrase backup + verification quiz
// Step 1: show seed → user writes it down → clicks "I've written it down"
// Step 2: hide seed → ask for 3 random words by position → verify → enable Next
function renderSeedBackup(seedPhrase) {
    const words = seedPhrase.trim().split(/\s+/);
    const display = q('seedDisplay');
    if (!display) return;
    q('wNext4').disabled = true;

    // Step 1: show seed
    const wordsHtml = words.map((w, i) =>
        '<span class="seed-word"><span class="seed-num">' + (i + 1) + '</span>' + esc(w) + '</span>'
    ).join('');
    display.innerHTML =
        '<div class="seed-title">WRITE DOWN YOUR SEED PHRASE</div>'
        + '<div class="seed-warning">If you lose this, your funds are gone. There is no recovery without it.</div>'
        + '<div class="seed-words seed-words-grid">' + wordsHtml + '</div>'
        + '<button id="seedWrittenBtn" class="btn btn-primary btn-full mt-12">I\'ve written it down &mdash; Verify</button>';

    q('seedWrittenBtn').addEventListener('click', () => renderSeedQuiz(words));
}

function renderSeedQuiz(words) {
    const display = q('seedDisplay');
    if (!display) return;

    // Pick 3 random distinct positions
    const picks = [];
    while (picks.length < 3) {
        const p = Math.floor(Math.random() * words.length);
        if (!picks.includes(p)) picks.push(p);
    }
    picks.sort((a, b) => a - b);

    const inputs = picks.map(p =>
        '<div class="quiz-row">'
        + '<label class="quiz-label">Word #' + (p + 1) + '</label>'
        + '<input type="text" class="input quiz-input" data-pos="' + p + '" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false">'
        + '<span class="quiz-mark" data-pos="' + p + '"></span>'
        + '</div>'
    ).join('');

    display.innerHTML =
        '<div class="seed-title">VERIFY YOUR BACKUP</div>'
        + '<div class="field-hint mb-8">Type the words at the requested positions to confirm you wrote them down.</div>'
        + '<div class="quiz-grid">' + inputs + '</div>'
        + '<div id="quizError" class="error-inline mt-8" style="display:none"></div>'
        + '<button id="seedShowAgainBtn" class="btn btn-outline btn-full mt-8">Show seed phrase again</button>';

    const checkAll = () => {
        const allInputs = display.querySelectorAll('.quiz-input');
        let allCorrect = true;
        allInputs.forEach(inp => {
            const pos    = Number(inp.dataset.pos);
            const expect = words[pos];
            const got    = inp.value.trim().toLowerCase();
            const mark   = display.querySelector('.quiz-mark[data-pos="' + pos + '"]');
            if (got && got === expect) {
                if (mark) { mark.textContent = '✓'; mark.className = 'quiz-mark ok'; }
            } else {
                if (mark) { mark.textContent = got ? '✗' : ''; mark.className = 'quiz-mark ' + (got ? 'bad' : ''); }
                allCorrect = false;
            }
        });
        q('wNext4').disabled = !allCorrect;
        const err = q('quizError');
        if (err) {
            err.style.display = allCorrect ? 'none' : '';
            if (!allCorrect) err.textContent = 'Type the words exactly as shown earlier. Click "Show seed phrase again" if you need to re-check.';
        }
    };

    display.querySelectorAll('.quiz-input').forEach(inp => inp.addEventListener('input', checkAll));
    q('seedShowAgainBtn').addEventListener('click', () => renderSeedBackup(words.join(' ')));
}

q('runInitBtn').addEventListener('click', async () => {
    const mode = document.querySelector('[name="initMode"]:checked')?.value || 'new';
    const pass = q('initPass').value;
    const seed = q('seedInput').value.trim();
    hideEl('initError');
    q('runInitBtn').disabled = true;
    try {
        if (mode === 'recover') {
            if (!seed) { showEl('initError'); setText('initError', 'Enter your 24-word seed phrase.'); return; }
            await apiPost('/api/wallet/' + wizard.name + '/recover', { passphrase: pass, seedPhrase: seed });
            q('wNext4').disabled = false;
        } else {
            const d = await apiPost('/api/wallet/' + wizard.name + '/init', { passphrase: pass });
            if (d.seed) {
                showEl('seedDisplay');
                renderSeedBackup(d.seed);
            } else {
                q('wNext4').disabled = false;
            }
        }
    } catch (e) { showEl('initError'); setText('initError', e.message); }
    q('runInitBtn').disabled = false;
});

q('wNext4').addEventListener('click', () => { showWizardStep(4); wizardStep5Init(); });

// Step 5: Tor
async function wizardStep5Init() {
    const infoEl = q('torStatusInfo');
    infoEl.innerHTML = '<span class="loading">CHECKING TOR...</span>';
    try {
        const d = await apiGet('/api/setup/tor-status');
        if (d.running) {
            infoEl.className = 'info-box success';
            infoEl.innerHTML = '<strong>TOR RUNNING</strong> &mdash; service active, SOCKS on 127.0.0.1:9050';
        } else if (d.serviceActive) {
            infoEl.className = 'info-box warn';
            infoEl.innerHTML = '<strong>Service active</strong> but port 9050 not yet listening &mdash; wait a moment.';
        } else if (d.portOpen) {
            infoEl.className = 'info-box warn';
            infoEl.innerHTML = 'Port 9050 listening but systemd unit not reported active &mdash; manual <code>tor</code> process?';
        } else {
            infoEl.className = 'info-box';
            infoEl.innerHTML = '<strong>Tor not running.</strong> ' + (d.hint ? esc(d.hint) : 'Install via apt + systemctl on the host.');
        }
    } catch (e) { infoEl.className = 'info-box error'; infoEl.innerHTML = 'Error: ' + esc(e.message); }
}

// Wizard Tor step is read-only on Linux — Tor is managed by host systemd.
// Install/start buttons were removed; users see status only.

q('wNext5').addEventListener('click', () => {
    showWizardStep(5);
    setText('doneWalletName', wizard.name + ' (' + wizard.network + ')');
    refreshWallets();
});

q('openNewWalletBtn').addEventListener('click', () => {
    const name = wizard.name;
    closeWizard();
    switchTab('wallet');
    selectWallet(name);
});
q('addAnotherBtn').addEventListener('click', () => {
    wizard.step = 1; wizard.name = ''; wizard.network = 'mainnet'; wizard.dir = ''; wizard.nodeUrl = '';
    showWizardStep(1); wizardStep2Init();
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
    try {
        const data = await apiGet('/api/wallets');
        allWallets = data.wallets || [];
        renderSidebar(allWallets);
        hideEl('loadingPanel');
        showEl('appShell');
        startPricePolling();      // start once; runs whether wallet is selected or not
        startBalancesPolling();   // keep all sidebar balances fresh
        startAutolock();          // monitor activity + auto-lock on inactivity
        if (allWallets.length > 0) {
            selectWallet(allWallets[0].name);
        } else {
            hideEl('noSelectionPanel');
            switchTab('setup');
            initSetupTab();
        }
    } catch (e) {
        setText('loadingPanel', 'Could not reach web server. Is it running?');
    }
}

// ── Wire up events on DOMContentLoaded ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-tab]').forEach(btn =>
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            switchTab(tab);
            if (tab === 'history' && curWallet) refreshHistory();
            if (tab === 'setup') initSetupTab();
            if (tab === 'send') {
                refreshSendTorAvailability();
                if (curWallet) loadAddrBook(curWallet).then(renderRecentRecipients);
            }
        })
    );

    q('addWalletBtn').addEventListener('click', () => {
        switchTab('setup');
        openAddWalletWizard();
    });

    q('hamburgerBtn').addEventListener('click', () => {
        q('sidebar').classList.add('open');
        q('sidebarOverlay').classList.add('visible');
    });
    q('sidebarOverlay').addEventListener('click', closeSidebar);

    setInterval(() => {
        if (curWallet && q('appShell')?.style.display !== 'none') {
            refreshNodeStatus();
            refreshWallets().then(() => {
                const w = allWallets.find(x => x.name === curWallet);
                if (w?.connected) updateServicesPanel(w);
            });
        }
    }, 30000);

    init();
});

// ── Theme toggle ──────────────────────────────────────────────────────────────
(function () {
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
    function applyTheme(t) {
        if (t === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
            btn.innerHTML = '&#9681;'; // half-moon = "switch to dark"
            btn.title = 'Switch to dark theme';
        } else {
            document.documentElement.removeAttribute('data-theme');
            btn.innerHTML = '&#9728;'; // sun = "switch to light"
            btn.title = 'Switch to light theme';
        }
    }
    applyTheme(localStorage.getItem('grin-theme') || 'dark');
    btn.addEventListener('click', function () {
        const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        localStorage.setItem('grin-theme', next);
        applyTheme(next);
    });

    // Privacy mode toggle (header eye button)
    const privacyBtn = document.getElementById('privacyToggleBtn');
    if (privacyBtn) {
        if (isPrivacyOn()) document.body.classList.add('privacy-mode');
        privacyBtn.addEventListener('click', () => setPrivacyMode(!document.body.classList.contains('privacy-mode')));
    }
}());
