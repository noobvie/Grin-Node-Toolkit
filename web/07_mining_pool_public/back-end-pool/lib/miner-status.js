'use strict';
// Live miner + rig status for the admin Miners page (admin-panel/miners.html).
//
// One module turns the in-memory stratum sessions plus a short window of the `shares` table into
// the per-address status dot (GET /api/admin/miners) and the per-rig rows of the expanded view
// (GET /api/admin/miners/:addr/workers). Both routes call it so the dot and the rows it
// summarises can never disagree about what "online" or "stalled" means.
//
// Windows, in seconds. The API returns them and the page builds its labels from them, so they
// are changed HERE and nowhere else:
//   hashrate_s  the list's Hashrate column (the same 10 min the public worker readout defaults to)
//   seen_s      how far back a rig still counts as one of this miner's rigs. A rig that shared
//               inside it but has no live session makes the miner Degraded; once it ages out the
//               miner reads plain Mining again. So a rig retired on purpose shows amber for up to
//               an hour, which is the price of catching one that died.
//   stall_s     a rig with a live session but no accepted share for this long is stalled (a hung
//               rig that still answers keepalives keeps its session open indefinitely).
// ⚠ stall_s must stay well above the slowest HONEST share interval. The pool has no vardiff: a
// small rig's share rate is set only by the node's minimum_share_difficulty, so a tight value
// paints healthy low-hash rigs amber. 15 min is ~30× the 15–30 s the pool is tuned for.
const HashrateTracker = require('./hashrate-tracker');

const WINDOWS = Object.freeze({ hashrate_s: 600, seen_s: 3600, stall_s: 900 });

// Same C32 conversion as HashrateTracker.getWorkersForAccount: Σdifficulty × 42 / (window × 16384).
function gps(sumdiff, windowSeconds) {
  const f = HashrateTracker.CYCLE_LENGTH / (windowSeconds * HashrateTracker.SOLUTION_RATE);
  return parseFloat(((Number(sumdiff) || 0) * f).toFixed(6));
}

// Group live sessions by address → rig. MINING sessions only (acceptedShares > 0), the same
// filter getWorkersForAccount applies (audit §J6-9): stratum login is unauthenticated — the
// address IS the username — so a bare session proves nothing, and must never turn a dot green or
// name a rig. A session that has not had a share accepted yet is only COUNTED (`connecting`), so
// the page can say "connected, no shares yet" without trusting anything it claims.
// Rig key = session.workerName, which login already defaults to 'default' — the same label
// getWorkersForAccount's COALESCE(worker_name, 'default') produces, so the two maps join.
function liveRigs(sessions) {
  const byAddr = new Map();
  for (const s of sessions || []) {
    if (!s || !s.grinAddress) continue;
    let a = byAddr.get(s.grinAddress);
    if (!a) { a = { mining: new Map(), connecting: 0 }; byAddr.set(s.grinAddress, a); }
    if (!(s.acceptedShares > 0)) { a.connecting++; continue; }
    const name = s.workerName || 'default';
    const rig = a.mining.get(name) || { regions: new Set(), since: null };
    if (s.region) rig.regions.add(String(s.region));
    const since = s.subscribedAt ? Math.floor(s.subscribedAt / 1000) : null;
    if (since && (rig.since === null || since < rig.since)) rig.since = since;
    a.mining.set(name, rig);
  }
  return byAddr;
}

// ONE pass over the last seen_s of shares for every address, grouped by (address, rig).
// This replaced two correlated subqueries PER LISTED ROW — COUNT(*) and MAX(created_at) over that
// address's whole retained share history, i.e. the entire ~31 h table walked twice on every 30 s
// refresh of a 500-row page, on the synchronous DB the stratum server shares (memory
// project_pool_db_capacity: a scan there stalls share submission for every miner).
// ⚠ The UPPER bound is load-bearing, not tidiness. With `created_at > ?` alone SQLite plans
// `SCAN shares USING INDEX idx_share_address` (it prefers that index to skip nothing); with both
// bounds it is `SEARCH shares USING INDEX idx_share_created (created_at>? AND created_at<?)`.
// The GROUP BY temp b-tree that remains covers one hour of rows, not the table.
// scripts/test-admin-miners.js pins that plan.
const RECENT_SQL = `
  SELECT grin_address,
         COALESCE(worker_name, 'default') AS worker,
         SUM(CASE WHEN created_at > ? THEN difficulty ELSE 0 END) AS sumdiff,
         MAX(created_at) AS last_share_at
    FROM shares
   WHERE created_at > ? AND created_at <= ?
   GROUP BY grin_address, COALESCE(worker_name, 'default')`;

function recentShares(db, now) {
  const byAddr = new Map();
  const rows = db.prepare(RECENT_SQL).all(now - WINDOWS.hashrate_s, now - WINDOWS.seen_s, now);
  for (const r of rows) {
    let m = byAddr.get(r.grin_address);
    if (!m) { m = new Map(); byAddr.set(r.grin_address, m); }
    m.set(r.worker, { sumdiff: Number(r.sumdiff) || 0, last: r.last_share_at || null });
  }
  return byAddr;
}

// Per-address summary for one list row. `live` / `recent` are this address's entries from the
// two maps above (either may be undefined).
//   status  mining     ≥1 live rig, none stalled, none missing
//           degraded   ≥1 live rig, but a rig is stalled or a rig seen inside seen_s is gone
//           connecting a session is open but no share has been accepted on it yet
//           offline    nothing live
// Banned is NOT a status here: it is a flag on the account, and a banned address has no sessions
// (banMiner drops them), so the page draws it on top of whatever this returns.
function summarize(live, recent, now) {
  const mining = live ? live.mining : new Map();
  const seen = recent || new Map();
  let sumdiff = 0, last = null;
  for (const v of seen.values()) {
    sumdiff += v.sumdiff;
    if (v.last && (last === null || v.last > last)) last = v.last;
  }
  const missing = [...seen.keys()].filter((w) => !mining.has(w));
  const stalled = [...mining.keys()].filter((w) => {
    const r = seen.get(w);
    return !r || !r.last || (now - r.last) > WINDOWS.stall_s;
  });
  const total = new Set([...seen.keys(), ...mining.keys()]).size;
  let status;
  if (mining.size) status = (missing.length || stalled.length) ? 'degraded' : 'mining';
  else if (live && live.connecting) status = 'connecting';
  else status = 'offline';
  return {
    status,
    workers_online: mining.size,
    workers_total: total,
    workers_missing: missing.length,
    workers_stalled: stalled.length,
    hashrate_gps: gps(sumdiff, WINDOWS.hashrate_s),
    last_share_at: last
  };
}

// Rows for the expanded view. `hour` = getWorkersForAccount(addr, seen_s/60, hashrate_s/60): ONE
// call supplies the rig list, share counts, live reject/stale, `online` and both hashrates (the
// short one as hashrate_gps_short). One call, not one per window: that query reads every retained
// share of the address whatever its window, and this route is re-polled while a row is open.
// `donateOf(name)` → percent | null.
// Status per rig: mining | stalled (live, no share inside stall_s) | offline (no live session).
const RIG_ORDER = { stalled: 0, offline: 1, mining: 2 };
function workerRows({ hour, live, now, donateOf }) {
  const mining = live ? live.mining : new Map();
  const rows = (hour || []).map((w) => {
    const { hashrate_gps, hashrate_gps_short, ...rest } = w;
    const rig = mining.get(w.worker_name);
    const quiet = !w.last_share_at || (now - w.last_share_at) > WINDOWS.stall_s;
    return {
      ...rest,
      hashrate_gps_10m: hashrate_gps_short || 0,
      hashrate_gps_1h: hashrate_gps || 0,
      status: w.online ? (quiet ? 'stalled' : 'mining') : 'offline',
      regions: rig ? [...rig.regions].sort() : [],
      connected_since: rig ? rig.since : null,
      donate_percent: donateOf ? donateOf(w.worker_name) : null
    };
  });
  // Problems first (that is what the operator opened the row to find), then by hashrate.
  rows.sort((a, b) => (RIG_ORDER[a.status] - RIG_ORDER[b.status]) || (b.hashrate_gps_1h - a.hashrate_gps_1h));
  return rows;
}

module.exports = { WINDOWS, RECENT_SQL, gps, liveRigs, recentShares, summarize, workerRows };
