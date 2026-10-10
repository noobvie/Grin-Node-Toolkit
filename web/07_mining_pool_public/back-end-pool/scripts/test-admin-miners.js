// Admin Miners page backend — lib/miner-status.js + GET /api/admin/miners(/:addr/workers).
//
// Pins three things a later edit could silently undo:
//   1. The status rules (mining / degraded / connecting / offline, per-rig mining / stalled /
//      offline), including the §J6-9 rule that a session with no accepted share proves nothing.
//   2. The query plan. The list used to walk every retained share twice per refresh; the
//      windowed replacement is only cheap while SQLite SEARCHes idx_share_created, and that
//      depends on the query keeping BOTH time bounds (a one-sided range plans as a full SCAN).
//   3. The real route handlers, run in-process against a throwaway DB (index.js starts a server
//      on require, so each handler is cut out of the source — the same loader
//      test-payout-guard.js uses).
//   4. The shares(grin_address, created_at) index that bounds every per-address read by its window.
//   5. Which accounts the capped list holds: miners active now first, whatever their balance, and
//      share-less sessions (mintable by anyone) last.
// Never touches the pool DB.
// Run: node scripts/test-admin-miners.js
const path = require('path');
const { readAppSource, routeSource } = require('./lib/app-source');
const fs = require('fs');
const os = require('os');

const APP = path.resolve(__dirname, '..');
const dbFile = path.join(os.tmpdir(), `pool-miners-${Date.now()}.sqlite`);

const { initDb, getDb, createSchema, closeDb } = require(path.join(APP, 'lib/db.js'));
initDb(dbFile);
const db = getDb();
createSchema();

const minerStatus = require(path.join(APP, 'lib/miner-status.js'));
const HashrateTracker = require(path.join(APP, 'lib/hashrate-tracker.js'));
const { parseDonateToken } = require(path.join(APP, 'lib/stratum-protocol.js'));
const W = minerStatus.WINDOWS;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const cleanup = () => {
  try { closeDb(); } catch (_) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbFile + suffix); } catch (_) {}
  }
};

const A = 'tgrin1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'tgrin1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'tgrin1cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const now = Math.floor(Date.now() / 1000);
const sess = (addr, worker, accepted, extra = {}) => ({
  grinAddress: addr, workerName: worker, acceptedShares: accepted, region: 'eu',
  subscribedAt: (now - 3000) * 1000, accepted, rejected: 0, stale: 0, ...extra
});

// ── 1. Status rules (pure) ────────────────────────────────────────────────────
console.log('\n[1] summarize() / liveRigs()');
{
  const recent = (entries) => new Map(entries.map(([w, sumdiff, ago]) => [w, { sumdiff, last: now - ago }]));
  const live = minerStatus.liveRigs([sess(A, 'rig1', 5), sess(A, 'rig2', 3), sess(A, 'ghost', 0), sess(B, 'x', 0)]);
  ok('liveRigs keeps only MINING sessions as rigs (§J6-9)', live.get(A).mining.size === 2 && !live.get(A).mining.has('ghost'));
  ok('…and counts the share-less ones as connecting', live.get(A).connecting === 1 && live.get(B).connecting === 1 && live.get(B).mining.size === 0);
  ok('…with the region and the session start', live.get(A).mining.get('rig1').regions.has('eu') && live.get(A).mining.get('rig1').since === now - 3000);

  const s1 = minerStatus.summarize(live.get(A), recent([['rig1', 100, 30], ['rig2', 50, 60]]), now);
  ok('two live rigs, both sharing → mining 2/2', s1.status === 'mining' && s1.workers_online === 2 && s1.workers_total === 2, JSON.stringify(s1));
  ok('hashrate = Σdiff over the hashrate window, C32 conversion', s1.hashrate_gps === minerStatus.gps(150, W.hashrate_s) && s1.hashrate_gps > 0);
  ok('last_share_at = newest rig share', s1.last_share_at === now - 30);

  const s2 = minerStatus.summarize(live.get(A), recent([['rig1', 100, 30], ['rig2', 50, 60], ['rig3', 10, 1800]]), now);
  ok('a rig that shared inside seen_s but has no session → degraded, missing 1', s2.status === 'degraded' && s2.workers_missing === 1 && s2.workers_total === 3, JSON.stringify(s2));

  const s3 = minerStatus.summarize(live.get(A), recent([['rig1', 100, 30], ['rig2', 0, W.stall_s + 60]]), now);
  ok('a live rig with no share inside stall_s → degraded, stalled 1', s3.status === 'degraded' && s3.workers_stalled === 1 && s3.workers_missing === 0, JSON.stringify(s3));

  const s4 = minerStatus.summarize(live.get(A), recent([['rig1', 100, 30]]), now);
  ok('a live rig absent from the window entirely counts as stalled', s4.status === 'degraded' && s4.workers_stalled === 1, JSON.stringify(s4));

  const s5 = minerStatus.summarize(live.get(B), undefined, now);
  ok('only a share-less session → connecting, never mining', s5.status === 'connecting' && s5.workers_online === 0 && s5.hashrate_gps === 0, JSON.stringify(s5));

  const s6 = minerStatus.summarize(undefined, recent([['old', 10, 1200]]), now);
  ok('no session but recent shares → offline (rigs 0/1)', s6.status === 'offline' && s6.workers_online === 0 && s6.workers_total === 1, JSON.stringify(s6));
  const s7 = minerStatus.summarize(undefined, undefined, now);
  ok('nothing at all → offline, last_share_at null', s7.status === 'offline' && s7.last_share_at === null && s7.workers_total === 0);
}

// ── 2. The windowed query: results and plan ───────────────────────────────────
console.log('\n[2] recentShares() — window + plan');
{
  for (const a of [A, B, C]) db.prepare('INSERT INTO miner_accounts (grin_address, balance, balance_locked) VALUES (?, ?, 0)').run(a, a === A ? 5 : 1);
  let n = 0;
  const share = (addr, worker, diff, ago) => db.prepare(
    'INSERT INTO shares (grin_address, worker_name, difficulty, block_height, share_hash, region, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)'
  ).run(addr, worker, diff, 'h' + (n++), 'eu', now - ago);
  share(A, 'rig1', 100, 30);
  share(A, 'rig1', 100, 300);
  share(A, 'rig1', 100, W.hashrate_s + 60);   // inside the hour, outside the hashrate window
  share(A, 'rig2', 40, 120);
  share(A, null, 7, 200);                      // NULL worker_name groups as 'default'
  share(B, 'x', 999, W.seen_s + 60);           // outside the seen window: must not appear
  share(C, 'y', 5, -120);                      // future-stamped: outside the upper bound

  const r = minerStatus.recentShares(db, now);
  const a = r.get(A);
  ok('groups per (address, rig), NULL worker → default', a && a.size === 3 && a.has('default'), a && JSON.stringify([...a.keys()]));
  ok('sumdiff counts only the hashrate window', a.get('rig1').sumdiff === 200, JSON.stringify(a.get('rig1')));
  ok('last share per rig is the newest in the seen window', a.get('rig1').last === now - 30);
  ok('a share older than seen_s is not read', !r.has(B));
  ok('a share past now is not read (the upper bound)', !r.has(C));

  const plan = db.prepare('EXPLAIN QUERY PLAN ' + minerStatus.RECENT_SQL).all(1, 1, 1).map((x) => x.detail).join(' | ');
  ok('plan SEARCHes idx_share_created on a two-sided range (no table SCAN)',
     /SEARCH shares USING (COVERING )?INDEX idx_share_created \(created_at>\? AND created_at<\?\)/.test(plan) && !/SCAN shares/.test(plan), plan);
  // Control: prove the plan check can fail — the one-sided form really does SCAN.
  const oneSided = minerStatus.RECENT_SQL.replace(/ AND created_at <= \?/, '');
  const plan1 = db.prepare('EXPLAIN QUERY PLAN ' + oneSided).all(1, 1).map((x) => x.detail).join(' | ');
  ok('control — without the upper bound the same query SCANs (why the bound is load-bearing)', /SCAN shares/.test(plan1), plan1);
}

// ── 3. The real route handlers ────────────────────────────────────────────────
console.log('\n[3] routes (real handlers)');
const indexSrc = readAppSource();
const routeSrc = routeSource;   // throws if the route is absent or ambiguous
const load = (verb, p, deps) => {
  const src = routeSrc(verb, p);
  let handler = null;
  const app = { [verb]: (_p, ...fns) => { handler = fns[fns.length - 1]; } };
  // eslint-disable-next-line no-new-func
  new Function('__d', `with (__d) {\n${src}\n}`)({ app, router: app, ...deps });
  return handler;
};
const call = (h, req) => {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
  };
  if (!h) { res.statusCode = -1; return res; }
  h({ params: {}, query: {}, body: {}, ...req }, res);
  return res;
};

(async () => {
  const sessions = [sess(A, 'rig1', 5), sess(A, 'rig2', 2), sess(B, 'x', 0)];
  const minerManager = {
    getActiveSessions: () => sessions,
    getSessionsByMiner: (addr) => sessions.filter((s) => s.grinAddress === addr),
  };
  const hashrateTracker = new HashrateTracker({}, minerManager);
  const deps = {
    db, secureAdmin: null, minerStatus, minerManager, hashrateTracker, parseDonateToken,
    incentivesManager: { donationsActive: () => false },
  };

  {
    const src = routeSrc('get', '/api/admin/miners');
    ok('the list no longer runs per-row share subqueries',
       !/FROM shares s WHERE s\.grin_address = ma\.grin_address/.test(src) && /minerStatus\.recentShares\(db, now\)/.test(src));
    ok('both routes are secureAdmin reads',
       /app\.get\('\/api\/admin\/miners', secureAdmin,/.test(indexSrc) && /app\.get\('\/api\/admin\/miners\/:addr\/workers', secureAdmin,/.test(indexSrc));

    const res = call(load('get', '/api/admin/miners', deps), { query: { limit: '500' } });
    const byAddr = new Map(((res.body && res.body.miners) || []).map((m) => [m.grin_address, m]));
    ok('GET /api/admin/miners → 200 with windows', res.statusCode === 200 && res.body.windows && res.body.windows.stall_s === W.stall_s,
       JSON.stringify({ code: res.statusCode, body: res.body }));
    const a = byAddr.get(A);
    ok('A: two live rigs + the default rig that is not connected → degraded 2/3',
       a && a.status === 'degraded' && a.workers_online === 2 && a.workers_total === 3 && a.workers_missing === 1, JSON.stringify(a));
    ok('B: share-less session only → connecting', byAddr.get(B) && byAddr.get(B).status === 'connecting');
    ok('C: nothing inside the window → offline', byAddr.get(C) && byAddr.get(C).status === 'offline' && byAddr.get(C).last_share_at === null);
    ok('the list is still ordered by balance', res.body.miners[0].grin_address === A);
    ok('shares_count is no longer in the list', !('shares_count' in a));
  }
  {
    const res = call(load('get', '/api/admin/miners/:addr/workers', deps), { params: { addr: A } });
    const rows = (res.body && res.body.workers) || [];
    const by = new Map(rows.map((w) => [w.worker_name, w]));
    ok('GET …/:addr/workers → 200 with one row per rig', res.statusCode === 200 && rows.length === 3, JSON.stringify(res.body));
    ok('rig1: mining, both hashrates, region + since from the session',
       by.get('rig1') && by.get('rig1').status === 'mining' && by.get('rig1').hashrate_gps_10m > 0 && by.get('rig1').hashrate_gps_1h > 0 &&
       by.get('rig1').regions.join() === 'eu' && by.get('rig1').connected_since === now - 3000, JSON.stringify(by.get('rig1')));
    ok('default: shared inside the hour, no session → offline', by.get('default') && by.get('default').status === 'offline');
    ok('rows are problem-first (offline before mining)', rows[0].status !== 'mining', JSON.stringify(rows.map((w) => w.status)));
    ok('no rig IP or password in the payload', !/"ip"|"pass"/.test(JSON.stringify(res.body)));
    const none = call(load('get', '/api/admin/miners/:addr/workers', deps), { params: { addr: 'tgrin1nobody' } });
    ok('unknown address → 404', none.statusCode === 404, JSON.stringify(none.body));
  }
  {
    // The page re-polls this route for each open row, so both windows must come from ONE pass
    // (the short window is a subset of the long one), not one call per window.
    const src = routeSrc('get', '/api/admin/miners/:addr/workers');
    ok('the workers route reads the shares ONCE (both windows from one getWorkersForAccount call)',
       (src.match(/getWorkersForAccount\(/g) || []).length === 1, src.match(/getWorkersForAccount\([^)]*\)/g));
    const both = hashrateTracker.getWorkersForAccount(A, W.seen_s / 60, W.hashrate_s / 60);
    const rig1 = both.find((w) => w.worker_name === 'rig1');
    ok('short-window hashrate = the 10-min shares only (200 of rig1\'s 300)',
       rig1 && rig1.hashrate_gps_short === minerStatus.gps(200, W.hashrate_s) && rig1.hashrate_gps === minerStatus.gps(300, W.seen_s), JSON.stringify(rig1));
    const pub = hashrateTracker.getWorkersForAccount(A, 10);
    ok('the public two-argument call is unchanged (no hashrate_gps_short key)',
       pub.length > 0 && pub.every((w) => !('hashrate_gps_short' in w)), JSON.stringify(pub[0]));
  }

  // ── 4. idx_share_address_created: per-address reads bounded by their window ─────────────────
  console.log('\n[4] shares(grin_address, created_at) index');
  {
    const plan = (sql, n) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...Array(n).fill(1)).map((x) => x.detail).join(' | ');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'shares'").all().map((r) => r.name);
    ok('the composite exists and the single-column idx_share_address is gone (a 3rd write per share for nothing)',
       idx.includes('idx_share_address_created') && !idx.includes('idx_share_address'), JSON.stringify(idx));
    const w = plan("SELECT COALESCE(worker_name,'default'), SUM(difficulty), COUNT(*), MAX(created_at) FROM shares WHERE grin_address = ? AND created_at > ? GROUP BY 1", 2);
    ok('getWorkersForAccount\'s shape seeks the address AND the window', /idx_share_address_created \(grin_address=\? AND created_at>\?\)/.test(w), w);
    const c = plan('SELECT COUNT(*), MAX(created_at) FROM shares WHERE grin_address = ?', 1);
    ok('the detail route\'s count/max by address is index-only', /COVERING INDEX idx_share_address_created/.test(c), c);
  }

  // ── 5. Which accounts the capped list holds ──────────────────────────────────────────────────
  console.log('\n[5] list priority (the cap)');
  {
    const D = 'tgrin1dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
    const E = 'tgrin1eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const F = 'tgrin1ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    const add = db.prepare('INSERT INTO miner_accounts (grin_address, balance, balance_locked, is_banned) VALUES (?, ?, 0, ?)');
    add.run(D, 0, 0);     // brand new: mining NOW, nothing matured yet
    add.run(E, 100, 0);   // rich and idle
    add.run(F, 50, 1);    // banned, idle
    db.prepare("INSERT INTO shares (grin_address, worker_name, difficulty, block_height, share_hash, region, created_at) VALUES (?, 'r', 1, 1, 'hd', 'eu', ?)").run(D, now - 60);

    const pr = minerStatus.listPriority(minerStatus.liveRigs(sessions), minerStatus.recentShares(db, now));
    ok('listPriority: PoW-backed biggest first, share-less sessions separately', pr.mined.join() === [A, D].join() && pr.connecting.join() === B, JSON.stringify(pr));

    const list = load('get', '/api/admin/miners', deps);
    const r3 = call(list, { query: { limit: '3' } }).body;
    const got3 = (r3 && r3.miners || []).map((m) => m.grin_address);
    ok('cap 3: the zero-balance miner mining NOW is listed, over the richest idle account',
       got3.includes(D) && got3.includes(A) && !got3.includes(E), JSON.stringify(got3));
    ok('cap 3: banned outranks a share-less session (which anyone can mint by logging in)', got3.includes(F) && !got3.includes(B), JSON.stringify(got3));
    ok('cap 3: returned in balance order, with honest totals', got3.join() === [F, A, D].join() &&
       r3.total_accounts === 6 && r3.mined_accounts === 2 && r3.truncated === true, JSON.stringify({ got3, t: r3.total_accounts, m: r3.mined_accounts, tr: r3.truncated }));
    const r5 = call(list, { query: { limit: '5' } }).body;
    const got5 = r5.miners.map((m) => m.grin_address);
    ok('cap 5: the connecting session, then the rest by balance fill the room', got5.includes(B) && got5.includes(E) && !got5.includes(C) && r5.truncated === true, JSON.stringify(got5));
    const r50 = call(list, { query: { limit: '50' } }).body;
    ok('no cap hit → every account, truncated false', r50.miners.length === 6 && r50.truncated === false);
    ok('limit is clamped to 1000', /Math\.min\(Math\.max\(parseInt\(req\.query\.limit, 10\) \|\| 50, 1\), 1000\)/.test(routeSrc('get', '/api/admin/miners')));

    const s1 = call(list, { query: { search: 'eeeeeeee', limit: '50' } }).body;
    ok('?search finds an account by substring', s1.miners.length === 1 && s1.miners[0].grin_address === E && s1.truncated === false, JSON.stringify(s1.miners.map((m) => m.grin_address)));
    const s2 = call(list, { query: { search: '_', limit: '50' } }).body;
    ok('?search escapes LIKE wildcards (`_` is a literal, not "any character")', s2.miners.length === 0, JSON.stringify(s2.miners.length));
    const s3 = call(list, { query: { search: ['aaa', 'bbb'], limit: '50' } });
    ok('?search given twice (an array) is ignored, not stringified into the pattern', s3.statusCode === 200 && s3.body.miners.length === 6);
    const pIn = db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM miner_accounts ma WHERE ma.grin_address IN (SELECT value FROM json_each(?))').all('[]').map((x) => x.detail).join(' | ');
    ok('the priority read SEARCHes miner_accounts by address (no table scan)', /SEARCH ma USING (COVERING )?INDEX/.test(pIn) && !/SCAN ma\b/.test(pIn), pIn);
  }
})().catch((e) => { fail++; console.log('  FAIL  unexpected throw ' + (e && e.stack)); })
  .finally(() => {
    cleanup();
    console.log('\n' + (fail ? 'FAILURES' : 'ALL PASS') + ` — ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
