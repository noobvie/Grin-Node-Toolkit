'use strict';

// Regional-gateway + public stratum-reachability helpers (code-layout refactor P10; moved out of
// index.js verbatim). ONE module = ONE home for the state below (_gwStatusCache, _stratumProbe) —
// route files require() it directly and a cached module is the same instance everywhere (I7).
// The only thing it needs from boot is the loaded config (network → which wg iface / --net):
// index.js calls setConfig(config) once, right after the config is validated.

const fs = require('fs');
const net = require('net');
const { execSync, execFile } = require('child_process');
const { pushRttSample } = require('./region-rtt');

let config = null;
function setConfig(cfg) { config = cfg; }

// ─── grin-gateway-ctl bridge (design §13.2/§13.3) ────────────────────────────
// The root helper is the SINGLE WireGuard mutation path (peer add/remove +
// region_ports persistence), shared with the CLI (Script 07 menu W). The
// de-rooted grin-pool-manager reaches it via a one-line scoped sudoers entry
// (pool_deroot); `sudo -n` never blocks on a password prompt. argv array only —
// never a shell string — and the helper re-validates every input itself.
const GWCTL = '/usr/local/bin/grin-gateway-ctl';
// timeoutMs defaults to the 10s that suits every peer/list/status call. Only
// init-server needs more — it may install wireguard-tools inside the request —
// and it passes its own; do NOT raise the default, because the cached liveness
// read sits behind it and a slow helper there stalls the public patch bay.
function gwctl(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const net = (config && config.network === 'testnet') ? 'testnet' : 'mainnet';
    execFile('sudo', ['-n', GWCTL, ...args, '--net', net],
      { timeout: timeoutMs || 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        let out = null;
        try { out = JSON.parse(String(stdout || '').trim()); } catch (e) { /* not JSON */ }
        if (out && out.ok) return resolve(out);
        // A helper killed by the timeout has printed no JSON, and execFile's message for
        // it is the bare "Command failed: sudo -n …" — after init-server's 3-minute wait
        // that reads as an instant failure of the command itself. Name the timeout.
        if (err && err.killed) {
          return reject(new Error(`gateway helper timed out after ${Math.round((timeoutMs || 10000) / 1000)}s (${args[0]}) — the box may be waiting on apt or a hung wg-quick; check the pool service journal`));
        }
        reject(new Error((out && out.error) ? out.error : (err ? err.message : 'gateway helper failed')));
      });
  });
}

// Per-region tunnel liveness for the health endpoint: helper `status` first
// (works de-rooted, adds rx/tx), silent fallback to the direct root-only read
// below so an old install (no helper/sudoers yet) or a gateway-only box
// degrades to share-recency status exactly as before (§13.9 step 5).
// Returns { available, regions } — `available` says whether we could READ WireGuard at all,
// which is NOT the same as "there are peers". An empty `regions` used to be returned for both
// "wg unreadable" and "wg readable, zero peers configured", so a pool with no gateway paired
// yet judged every declared region live and painted the whole patch bay blue/idle. Keep the
// two apart: available=true + no entry for a region means that region has NO tunnel.
async function readGatewayStatus() {
  try {
    const st = await gwctl(['status']);
    const out = {};
    for (const g of st.gateways || []) {
      // Include peers that have NEVER handshaked (handshake 0/absent). A present-but-zero
      // entry means "peer declared, tunnel never came up" → regionStatus() treats the 0
      // handshake as stale → offline. (`wg show latest-handshakes` prints 0 the same way.)
      if (!g.region) continue;
      out[g.region] = { handshake: g.handshake || 0, rx_bytes: g.rx_bytes, tx_bytes: g.tx_bytes };
    }
    return { available: true, regions: out };
  } catch (e) {
    return readWgHandshakes();
  }
}

// Best-effort WireGuard handshake per region (Model C gateway liveness). Maps each peer's
// public key → region using the "# region: <name>" comment the installer writes above every
// [Peer] in the central wg config, then reads `wg show ... latest-handshakes`. The iface is
// per-network to match the bash installer (07 pool menu W): mainnet "wg-grinpool", testnet
// "wg-grinpool-tn".
// Legacy/fallback path — requires root (reads /etc/wireguard); readGatewayStatus() is the
// primary. Returns { available: true, regions: { <region>: { handshake: <unix_ts> } } };
// available:false on ANY failure (wg not installed, not the central box, no permission,
// dev/Windows) so callers fall back to the stratum probe / share-activity signals.
function readWgHandshakes() {
  const out = {};
  let available = false;
  try {
    const iface = (config && config.network === 'testnet') ? 'wg-grinpool-tn' : 'wg-grinpool';
    const conf = fs.readFileSync(`/etc/wireguard/${iface}.conf`, 'utf8');
    const pubToRegion = {};
    let curRegion = null;
    for (const line of conf.split('\n')) {
      const rm = line.match(/^\s*#\s*region:\s*(.+?)\s*$/i);
      if (rm) { curRegion = rm[1]; continue; }
      const pm = line.match(/^\s*PublicKey\s*=\s*(.+?)\s*$/i);
      if (pm && curRegion) { pubToRegion[pm[1]] = curRegion; curRegion = null; }
    }
    const dump = execSync(`wg show ${iface} latest-handshakes`, { timeout: 2000 }).toString();
    available = true;  // we READ wg — an empty peer list below is now real information
    for (const line of dump.split('\n')) {
      const [pub, ts] = line.trim().split(/\s+/);
      if (pub && ts && pubToRegion[pub]) out[pubToRegion[pub]] = { handshake: parseInt(ts, 10) || 0 };
    }
  } catch (e) { /* wg unavailable — stratum probe / share activity are used instead */ }
  return { available, regions: out };
}

// Cached wrapper for the public /api/pool/stats/regions + /api/pool/topology paths: those
// endpoints are unauthenticated and polled by every open dashboard, so calling
// readGatewayStatus() (which spawns grin-gateway-ctl / `wg show`) on every hit is a needless
// per-request subprocess. SYNCHRONOUS stale-while-revalidate: the caller always gets the
// cached snapshot immediately and a stale one is refreshed in the background — a liveness
// read must NEVER sit in front of the region list (gwctl carries a 10s exec timeout, which
// on a cold cache used to stall the whole patch bay before it could paint). The admin
// endpoint keeps its own uncached await (low call volume, wants ground truth).
const GW_STATUS_TTL_MS = 15000;
let _gwStatusCache = { ts: 0, running: false, data: { available: false, regions: {} } };
function cachedGatewayStatus() {
  if (!_gwStatusCache.running && Date.now() - _gwStatusCache.ts > GW_STATUS_TTL_MS) {
    _gwStatusCache.running = true;
    readGatewayStatus()
      .then((d) => { _gwStatusCache.data = d; })
      .catch(() => { /* keep the previous snapshot */ })
      .then(() => { _gwStatusCache.ts = Date.now(); _gwStatusCache.running = false; });
  }
  return _gwStatusCache.data;
}

// Active wire check: TCP-dial a region's PUBLIC stratum host:port — the exact path a miner's
// rig takes. Resolves ms-to-connect on success, null on refuse/timeout/DNS fail. Never rejects.
// Connect-only (no stratum handshake): proves the region's HAProxy/listener is up and
// reachable, which is all the edge can prove without a fake miner login.
// The clock restarts on 'lookup' (DNS done) and on each 'connectionAttempt' (Node's
// happy-eyeballs tries each address in turn), so the figure is the connecting attempt's SYN →
// SYN-ACK alone — about one RTT, which hub_rtt_ms publishes (lib/region-rtt.js). Uncached DNS
// and a dead IPv6 attempt used to be counted in it.
function probeStratumTcp(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let t0 = Date.now();
    let sock, settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (e) { /* already gone */ }
      resolve(ok ? Date.now() - t0 : null);
    };
    try { sock = net.connect({ host, port: +port }); } catch (e) { return resolve(null); }
    const restart = () => { t0 = Date.now(); };
    sock.on('lookup', restart);
    sock.on('connectionAttempt', restart);
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// Public per-region reachability cache (feeds the patch bay + network map).
// WireGuard alone cannot answer "can a miner mine here?" for a region that has no peer at
// all — a seeded/declared endpoint with nothing behind it looked identical to a healthy quiet
// one. This dials the advertised stratum_url instead, entirely OUT of the request path:
// endpoints read the snapshot and kick a refresh only when it is stale, so a public hit never
// waits on a dial. Two consecutive failures before calling a region down (a single dial can
// lose to a momentary egress hiccup); a region with no verdict yet reports 'checking', never
// a guess.
const STRATUM_PROBE_TTL_MS = 60000;
const STRATUM_PROBE_STRIKES = 2;
let _stratumProbe = { ts: 0, running: false, byRegion: new Map() };
function refreshStratumProbes(locations) {
  if (_stratumProbe.running) return;
  if (Date.now() - _stratumProbe.ts < STRATUM_PROBE_TTL_MS) return;
  const targets = [];
  for (const l of locations || []) {
    const m = String(l.stratum_url || '').replace(/^\w+:\/\//, '').match(/^([^:/]+):(\d+)$/);
    if (m) targets.push({ region: l.region, host: m[1], port: m[2] });
  }
  if (!targets.length) { _stratumProbe.ts = Date.now(); return; }
  _stratumProbe.running = true;
  Promise.all(targets.map(async (t) => {
    const ms = await probeStratumTcp(t.host, t.port);
    const prev = _stratumProbe.byRegion.get(t.region) || { fails: 0, rtt: [] };
    _stratumProbe.byRegion.set(t.region, {
      ok: ms !== null,
      fails: ms !== null ? 0 : prev.fails + 1,
      ms,
      // Rolling window of the last successful connect times → hub_rtt_ms (lib/region-rtt.js).
      rtt: pushRttSample(prev.rtt, ms),
      ts: Math.floor(Date.now() / 1000)
    });
  })).catch(() => { /* probeStratumTcp never rejects; belt and braces */ })
    .then(() => { _stratumProbe.ts = Date.now(); _stratumProbe.running = false; });
}
// true = reachable · false = confirmed unreachable · null = no verdict yet (never probed,
// or one lone failure that has not been confirmed).
function stratumVerdict(region) {
  const p = _stratumProbe.byRegion.get(region);
  if (!p) return null;
  if (p.ok) return true;
  return p.fails >= STRATUM_PROBE_STRIKES ? false : null;
}
// A region's rolling connect-time window (undefined until its first probe).
function stratumRttWindow(region) {
  const p = _stratumProbe.byRegion.get(region);
  return p ? p.rtt : undefined;
}
// A region's public status — 'online' | 'idle' | 'offline' | 'checking'. ONE implementation for
// every public reader that names a region reachable or not (GET /api/pool/stats/regions and
// GET /api/pool/connect/suggest), so the connect suggestion can never recommend a region the
// patch bay beside it paints red. The precedence and the reasons for it are documented at the
// regions route. ctx = { localRegion, wgSnapshot, nowS, offlineS }.
function publicRegionStatus(region, hasShares, shareAge, hasTarget, ctx) {
  const { localRegion, wgSnapshot, nowS, offlineS } = ctx;
  const wgByRegion = (wgSnapshot && wgSnapshot.regions) || {};
  const sharesFresh = shareAge !== null && shareAge < offlineS;
  const verdict = stratumVerdict(region);
  let up;
  if (sharesFresh) up = true;
  else if (region === localRegion) up = true;
  else if (wgSnapshot && wgSnapshot.available && wgByRegion[region]) {
    const wg = wgByRegion[region];
    up = !!(wg.handshake && (nowS - wg.handshake) < offlineS) && verdict !== false;
  } else if (verdict === null) {
    // Nothing to dial and no tunnel to read → liveness is genuinely unknowable; keep the
    // old lenient behaviour rather than stranding the region on 'checking' forever.
    if (!hasTarget) return hasShares ? 'online' : 'idle';
    return 'checking';
  } else {
    up = verdict;
  }
  if (!up) return 'offline';
  return hasShares ? 'online' : 'idle';
}

module.exports = {
  setConfig, gwctl, readGatewayStatus, readWgHandshakes, cachedGatewayStatus,
  probeStratumTcp, refreshStratumProbes, stratumVerdict, stratumRttWindow, publicRegionStatus,
};
