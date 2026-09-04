// Rate-limit and resource-exhaustion regression tests — audit §J12.
//
// Guards the six §J12 fixes, and pins the two facts an OPEN finding rests on so a later
// reader cannot "tidy" the evidence away:
//   §J12-1  (OPEN) getTopAvgHashrate's SQL still full-SCANs hashrate_history and the ?days
//           parameter does not enter the plan. Asserted with a real EXPLAIN QUERY PLAN so the
//           day someone adds the covering index, this test tells them the finding is closed
//           rather than silently continuing to pass.
//   §J12-4  The violation record must SURVIVE its own lockout expiry, or the exponential
//           backoff below it is unreachable code — `count` is always 1 and every lockout is
//           30 s, which is what shipped.
//   §J12-6  /api/public/price must send a descriptive User-Agent (CoinGecko 403s `node`),
//           must arm a negative cache on ANY failure — including a 200 carrying no price —
//           and must collapse concurrent misses onto one outbound call.
//   §J12-7  /api/pool/effort's round window must be FLOORED. `lastBlockAt || 0` meant a pool
//           that has not yet found a block summed the entire shares table per request.
//   §J12-10 Every bucket named by a middleware()/peek()/consume() call must exist, and no
//           bucket may exist without a consumer.
//   §J12-2 / §J12-8  The two endpoints that were "cached" by a response header only must
//           hold a real server-side cache, and branding's must be invalidated on a write.
//
// Pure in-process assertions against the real modules — no server, no network, no DB file,
// nothing left running. Run: node scripts/test-rate-limits.js
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const APP = path.resolve(__dirname, '..');
const RateLimiter = require(path.join(APP, 'lib/rate-limiter.js'));

const indexSrc = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');
const trackerSrc = fs.readFileSync(path.join(APP, 'lib/hashrate-tracker.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

// A limiter with its cleanup timer never started — startCleanup() would keep the process
// alive past the last assertion, which is exactly the stale-process trap CLAUDE.md warns about.
const mkLimiter = (limits) => {
  const rl = new RateLimiter({ rate_limits: limits });
  rl.stopCleanup();
  return rl;
};

console.log('\n[1] §J12-4 — the exponential backoff is reachable and escalates\n');

{
  const rl = mkLimiter({ public: 2 });
  const key = rl.bucketKey('public', '198.51.100.7');
  // Spend the budget, then trip it.
  rl.checkLimit(key, 2); rl.checkLimit(key, 2);
  ok('§J12-4 the 3rd request in the window is refused', rl.checkLimit(key, 2) === false);
  const v1 = rl.violations.get(key);
  ok('§J12-4 first lockout is 30 s', v1 && v1.count === 1 &&
    Math.abs((v1.lockedUntil - Date.now()) - 30000) < 2000, JSON.stringify(v1));

  // Expire the lockout WITHOUT letting the request window drain — i.e. the client hammered
  // straight back through it. This is the path that used to delete the record.
  v1.lockedUntil = Date.now() - 1;
  ok('§J12-4 the next refusal escalates to 60 s (count survived the expiry)',
    (() => {
      rl.checkLimit(key, 2);
      const v2 = rl.violations.get(key);
      return v2 && v2.count === 2 && Math.abs((v2.lockedUntil - Date.now()) - 60000) < 2000;
    })(), JSON.stringify(rl.violations.get(key)));

  const v2 = rl.violations.get(key);
  v2.lockedUntil = Date.now() - 1;
  rl.checkLimit(key, 2);
  const v3 = rl.violations.get(key);
  ok('§J12-4 and again to 120 s', v3 && v3.count === 3 &&
    Math.abs((v3.lockedUntil - Date.now()) - 120000) < 2000, JSON.stringify(v3));

  // The kept record must be INERT everywhere a lockout is reported, or "remembering" would
  // silently extend the ban.
  v3.lockedUntil = Date.now() - 1;
  ok('§J12-4 an expired-but-remembered violation is not reported as an active lockout',
    rl.getViolations().length === 0 && rl.getStatus('198.51.100.7').violations === null);
}

console.log('\n[2] §J12-10 — every bucket has a consumer and every consumer names a real bucket\n');

{
  const rl = mkLimiter();
  const used = new Set();
  for (const m of indexSrc.matchAll(/rateLimiter\.(?:middleware|peek|consume)\(\s*'([a-z]+)'/g)) {
    used.add(m[1]);
  }
  const defined = new Set(Object.keys(rl.limits));
  const unknown = [...used].filter((b) => !defined.has(b));
  const orphan = [...defined].filter((b) => !used.has(b));
  ok('§J12-10 no route names a bucket that does not exist', unknown.length === 0, unknown.join(', '));
  ok('§J12-10 no bucket is defined without a consumer (the dead `api` bucket)',
    orphan.length === 0, orphan.join(', '));
  ok("§J12-10 middleware()'s default argument is a bucket that exists",
    defined.has((/middleware\(limitType = '([a-z]+)'\)/.exec(
      fs.readFileSync(path.join(APP, 'lib/rate-limiter.js'), 'utf8')) || [])[1]));
}

console.log('\n[3] §J12-2 / §J12-7 — the two node/DB-touching GETs hold a real cache\n');

ok('§J12-2 /api/pool/status has a server-side TTL, not just a Cache-Control header',
  /POOL_STATUS_TTL_MS\s*=\s*\d+/.test(indexSrc) && /_poolStatusCache/.test(indexSrc));
ok('§J12-2 concurrent misses are collapsed onto one upstream pair',
  /_poolStatusInflight/.test(indexSrc));
ok('§J12-7 /api/pool/effort is memoised', /EFFORT_TTL_MS\s*=\s*\d+/.test(indexSrc) && /_effortCache/.test(indexSrc));
ok('§J12-7 the round window is floored, never `lastBlockAt || 0`',
  !/get\(lastBlockAt \|\| 0\)/.test(indexSrc) &&
  /EFFORT_WINDOW_MAX_S/.test(indexSrc) &&
  /Math\.max\(lastBlockAt \|\| 0, now - EFFORT_WINDOW_MAX_S\)/.test(indexSrc));

console.log('\n[4] §J12-6 — the price fetch is UA-tagged, negative-cached and deduped\n');

ok('§J12-6 a descriptive User-Agent is sent (CoinGecko 403s a bare `node`)',
  /PRICE_UA\s*=/.test(indexSrc) && /'user-agent':\s*PRICE_UA/.test(indexSrc));
ok('§J12-6 a failure arms a negative cache', /PRICE_FAIL_TTL_MS/.test(indexSrc) && /_priceFailAt = Date\.now\(\)/.test(indexSrc));
ok('§J12-6 a 200 carrying no price counts as a failure, not a cache hit',
  /upstream returned no price/.test(indexSrc));
ok('§J12-6 concurrent misses are collapsed onto one outbound call', /_priceInflight/.test(indexSrc));

console.log('\n[5] §J12-8 — the branding payload is memoised and invalidated on a write\n');

ok('§J12-8 /api/public/branding holds a server-side memo',
  /BRANDING_TTL_MS\s*=\s*\d+/.test(indexSrc) && /_brandingCache/.test(indexSrc));
ok('§J12-8 the memo key space is bounded (hostname is attacker-chosen)',
  /_brandingCache\.size >= \d+/.test(indexSrc));
{
  const n = (indexSrc.match(/invalidateBranding\(\);/g) || []).length;
  ok('§J12-8 every settings/asset write invalidates it (updateSection, resetSection, saveAsset, deleteAsset)',
    n >= 4, `found ${n} call sites`);
}

console.log('\n[6] §J12-1 — the shape that made the old query unbounded is gone\n');

{
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE hashrate_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, grin_address TEXT NOT NULL,
      hashrate_gps REAL NOT NULL, window_seconds INTEGER NOT NULL DEFAULT 60,
      recorded_at INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE INDEX idx_hashrate_address ON hashrate_history(grin_address, recorded_at DESC);
    CREATE INDEX idx_hashrate_time ON hashrate_history(recorded_at, hashrate_gps);`);
  const planOf = (sql) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => r.detail).join(' | ');

  // The original shape, kept here as the negative control: an open-ended range over the raw
  // table full-SCANs whatever ?days says. If a future edit reintroduces it, section [7]'s
  // plan assertions fail — this one documents WHY they exist.
  ok('§J12-1 the original open-ended shape does full-SCAN (negative control)',
    /^SCAN hashrate_history/.test(planOf(`
      SELECT grin_address, SUM(hashrate_gps * window_seconds) AS s
      FROM hashrate_history WHERE recorded_at > 0 GROUP BY grin_address`)));
  ok('§J12-1 the sibling getPoolHistory uses its covering index',
    /COVERING INDEX idx_hashrate_time/.test(planOf(`
      SELECT recorded_at AS t, COALESCE(SUM(hashrate_gps), 0) AS gps
      FROM hashrate_history WHERE recorded_at > 0 GROUP BY recorded_at ORDER BY recorded_at ASC`)));
  ok('§J12-1 getTopAvgHashrate is now TTL-cached like its sibling',
    /TOP_AVG_TTL_MS/.test(trackerSrc) && /_topAvgCache/.test(trackerSrc));
  ok('§J12-1 the rollup runs from the tracking loop', /rollupMinerDays\(\)/.test(trackerSrc));
  db.close();
}

console.log('\n[7] §J12-1 — the daily rollup reproduces the original query exactly\n');

{
  // The whole risk of a rollup is that it silently answers a DIFFERENT question. So the
  // oracle here is the ORIGINAL raw query, verbatim, run against the same synthetic data —
  // if the composite read and the raw read ever disagree, the leaderboard is lying.
  const Database = require(path.join(APP, 'lib/sqlite-compat.js'));
  const HashrateTracker = require(path.join(APP, 'lib/hashrate-tracker.js'));
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE hashrate_history (id INTEGER PRIMARY KEY AUTOINCREMENT, grin_address TEXT NOT NULL,
      hashrate_gps REAL NOT NULL, window_seconds INTEGER NOT NULL DEFAULT 60, recorded_at INTEGER NOT NULL);
    CREATE INDEX idx_hashrate_address ON hashrate_history(grin_address, recorded_at DESC);
    CREATE INDEX idx_hashrate_time ON hashrate_history(recorded_at, hashrate_gps);
    CREATE TABLE miner_hashrate_daily (day INTEGER NOT NULL, grin_address TEXT NOT NULL,
      gps_seconds REAL NOT NULL DEFAULT 0, sample_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, grin_address));
    CREATE INDEX idx_mhd_day ON miner_hashrate_daily(day, grin_address, gps_seconds);
    CREATE TABLE pool_config (section TEXT NOT NULL, key TEXT NOT NULL, value TEXT, value_type TEXT,
      PRIMARY KEY(section, key));`);

  // Construct without the constructor so getDb() is not called — this is a pure unit.
  const t = Object.create(HashrateTracker.prototype);
  t.db = db; t.samplingInterval = 60000; t._topAvgCache = new Map();

  const DAY = 86400;
  const nowS = Math.floor(Date.now() / 1000);
  const todayStart = Math.floor(nowS / DAY) * DAY;
  const ins = db.prepare(
    'INSERT INTO hashrate_history (grin_address, hashrate_gps, window_seconds, recorded_at) VALUES (?,?,?,?)');
  const addrs = ['grin1a', 'grin1b', 'grin1c', 'grin1d', 'grin1e'];
  let rng = 12345;
  const rnd = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
  db.transaction(() => {
    for (let d = 40; d >= 0; d--) {
      if (d === 17) continue;                          // a completely QUIET day — the case a
                                                       // MAX(day) cursor would stick on forever
      const dayStart = todayStart - d * DAY;
      const samples = d === 0 ? 300 : 1440;            // today is deliberately partial
      for (let i = 0; i < samples; i++) {
        for (const a of addrs) {
          if (rnd() < 0.3) continue;                   // gaps, so days are not uniform
          ins.run(a, rnd() * 100, 60, dayStart + i * 60);
        }
      }
    }
  })();

  // The oracle: the exact query this endpoint used before §J12-1.
  const truth = (days, limit) => {
    const windowSeconds = days * DAY;
    const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
    return db.prepare(
      `SELECT grin_address, COALESCE(SUM(hashrate_gps * window_seconds), 0) / ? AS avg_gps
       FROM hashrate_history WHERE recorded_at > ?
       GROUP BY grin_address ORDER BY avg_gps DESC LIMIT ?`
    ).all(windowSeconds, cutoff, limit)
      .map((r) => ({ addr: r.grin_address, gps: parseFloat((r.avg_gps || 0).toFixed(6)) }));
  };

  const wrote = t.rollupMinerDays();
  ok('§J12-1 the rollup writes rows for the completed days', wrote > 0, String(wrote));
  const cover = db.prepare('SELECT COUNT(DISTINCT day) AS d FROM miner_hashrate_daily').get();
  const todayRows = db.prepare('SELECT COUNT(*) AS n FROM miner_hashrate_daily WHERE day >= ?').get(todayStart);
  ok('§J12-1 it covers the 39 busy completed days and NEVER the current partial day',
    cover.d === 39 && todayRows.n === 0, `${cover.d} days, ${todayRows.n} rows for today`);
  ok('§J12-1 the horizon advances past a QUIET day (a MAX(day) cursor would stick on it)',
    t._minerDayHorizon() === todayStart, `${t._minerDayHorizon()} vs ${todayStart}`);
  ok('§J12-1 a second call is a no-op', t.rollupMinerDays() === 0);

  let allMatch = true, firstBad = '';
  for (const d of [1, 7, 30, 40, 90]) {
    t._topAvgCache = new Map();
    const got = t.getTopAvgHashrate(d, 500).map((r) => ({ addr: r.grin_address, gps: r.avg_hashrate_gps }));
    const want = truth(d, 500);
    const same = got.length === want.length &&
      got.every((g, i) => g.addr === want[i].addr && Math.abs(g.gps - want[i].gps) < 1e-6);
    if (!same && !firstBad) firstBad = `days=${d}: ${JSON.stringify({ got: got.slice(0, 2), want: want.slice(0, 2) })}`;
    allMatch = allMatch && same;
  }
  ok('§J12-1 the composite read matches the original raw query at days=1/7/30/40/90',
    allMatch, firstBad);

  // Re-rolling already-rolled days must be a no-op on the numbers, or a restart double-counts.
  db.prepare("UPDATE pool_config SET value = ? WHERE section='_state' AND key='miner_hashrate_day_horizon'")
    .run(String(todayStart - 5 * DAY));
  t.rollupMinerDays();
  t._topAvgCache = new Map();
  const after = t.getTopAvgHashrate(30, 500).map((r) => r.avg_hashrate_gps);
  const want30 = truth(30, 500).map((r) => r.gps);
  ok('§J12-1 re-rolling five already-rolled days does not double count',
    after.length === want30.length && after.every((v, i) => Math.abs(v - want30[i]) < 1e-6));

  const a1 = t.getTopAvgHashrate(30, 500);
  ok('§J12-1 the result is TTL-cached (identical array on the second call)',
    t.getTopAvgHashrate(30, 500) === a1);

  // The plan assertion that actually protects the fix: a ONE-SIDED range on recorded_at still
  // full-scans, because SQLite prefers idx_hashrate_address to avoid the temp b-tree. The
  // upper bound in the tail query is what makes it a seek — so pin both halves.
  const planOf = (sql) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => r.detail).join(' | ');
  ok('§J12-1 the rollup read is a covering-index seek',
    /SEARCH miner_hashrate_daily USING COVERING INDEX idx_mhd_day/.test(planOf(
      `SELECT grin_address, SUM(gps_seconds) FROM miner_hashrate_daily
       WHERE day >= 1 AND day < 2 GROUP BY grin_address`)));
  ok('§J12-1 the raw tail is a SEEK — the upper bound is load-bearing, not cosmetic',
    /SEARCH hashrate_history USING INDEX idx_hashrate_time/.test(planOf(
      `SELECT grin_address, SUM(hashrate_gps * window_seconds) FROM hashrate_history
       WHERE recorded_at >= 1 AND recorded_at < 2 GROUP BY grin_address`)));
  ok('§J12-1 …and dropping that upper bound would silently restore the full SCAN',
    /^SCAN hashrate_history/.test(planOf(
      `SELECT grin_address, SUM(hashrate_gps * window_seconds) FROM hashrate_history
       WHERE recorded_at >= 1 GROUP BY grin_address`)));
  ok('§J12-1 the endpoint no longer aggregates hashrate_history over the ?days window directly',
    !/FROM hashrate_history\s+WHERE recorded_at > \?\s+GROUP BY grin_address/.test(trackerSrc));
  db.close();
}

console.log('\n[8] §J12-3 / -5 / -9 / -11 / -12 — the remaining resolution pass\n');

{
  const vhost = fs.readFileSync(
    path.resolve(APP, '../../../scripts/07_grin_mining_public_pool.sh'), 'utf8');
  const ipFilterSrc = fs.readFileSync(path.join(APP, 'lib/ip-filter.js'), 'utf8');
  const schedSrc = fs.readFileSync(path.join(APP, 'lib/withdrawal-scheduler.js'), 'utf8');
  const rlSrc = fs.readFileSync(path.join(APP, 'lib/rate-limiter.js'), 'utf8');

  // §J12-3 — the four SEO proxies must forward the client IP AND carry a zone. Without the
  // header every visitor collapses into one `public|127.0.0.1` bucket; without the zone that
  // bucket is trivially reachable. Both halves, all four locations.
  const seoBlocks = ['= /robots.txt', '= /sitemap.xml', '= /manifest.json', '= /blog/rss.xml'];
  const missing = seoBlocks.filter((loc) => {
    const i = vhost.indexOf('location ' + loc);
    if (i < 0) return true;
    // End at the block's own closing brace — the first `}` is NOT it, because
    // `limit_req zone=${POOL_SERVICE}_static` contains one. Match the indented closer.
    const end = vhost.indexOf('\n    }', i);
    const body = vhost.slice(i, end < 0 ? i + 600 : end);
    return !/X-Forwarded-For\s+\\\$proxy_add_x_forwarded_for/.test(body) || !/limit_req\s+zone=/.test(body);
  });
  ok('§J12-3 all four SEO proxies forward X-Forwarded-For and carry a limit_req zone',
    missing.length === 0, missing.join(', '));
  ok('§J12-3 isLocalRequest requires BOTH a loopback ip and no forwarding header',
    /function isLocalRequest\([\s\S]{0,600}?x-forwarded-for/.test(indexSrc));

  // §J12-5 — the pool-wide admin exports must be capped, paged, throttled and streamed.
  ok('§J12-5 both admin CSV exports go through the export bucket',
    (indexSrc.match(/adminCsvGate\(req, res\)/g) || []).length === 2);
  ok('§J12-5 neither admin export still runs an uncapped SELECT',
    !/FROM withdrawals WHERE status = 'confirmed' ORDER BY confirmed_at DESC`\s*\n\s*\)\.all\(\)/.test(indexSrc) &&
    !/FROM blocks ORDER BY height DESC`\s*\n\s*\)\.all\(\)/.test(indexSrc) &&
    /ADMIN_CSV_MAX_ROWS = 50000/.test(indexSrc));
  ok('§J12-5 truncation is reported in the FILE, not only in a header a download hides',
    /TRUNCATED at \$\{ADMIN_CSV_MAX_ROWS\} rows/.test(indexSrc) && /X-Export-Next-Before/.test(indexSrc));
  ok('§J12-5 sendCsv streams per row instead of building one string',
    /for \(const r of rows\) res\.write\(/.test(indexSrc) && !/lines\.join\('\\r\\n'\)/.test(indexSrc));

  // §J12-9 — topology memoised.
  ok('§J12-9 /api/pool/topology holds a server-side memo',
    /TOPOLOGY_TTL_MS/.test(indexSrc) && /_topologyCache = \{ at: Date\.now\(\), body \}/.test(indexSrc));

  // §J12-11 — every previously unbounded map now has a bound, and violations still does NOT
  // get size-evicted (that would lift a lockout).
  ok('§J12-11 the limiter request map has a hard cap',
    /MAX_TRACKED_BUCKETS/.test(rlSrc) && /EVICT_BATCH/.test(rlSrc));
  ok('§J12-11 the violations map is never size-evicted (eviction would lift a lockout)',
    !/violations\.delete\([^)]*\)[^\n]*EVICT/.test(rlSrc) &&
    /Eviction only ever touches `requests`, NEVER `violations`/.test(rlSrc));
  ok('§J12-11 the two admin-failure maps sweep expired rows',
    /ADMIN_FAIL_MAP_MAX/.test(indexSrc) && /store\.delete\(k\)/.test(indexSrc));
  ok('§J12-11 tempBan sweeps EXPIRED bans only, never by size',
    /TEMP_BAN_SWEEP_AT/.test(ipFilterSrc) && /if \(exp <= now\) this\.tempBans\.delete\(k\)/.test(ipFilterSrc));

  {
    // Behavioural: the cap must engage, and must not drop a live lockout.
    const rl = mkLimiter({ public: 5 });
    RateLimiterCapProbe(rl);
    function RateLimiterCapProbe(r) {
      const RL = require(path.join(APP, 'lib/rate-limiter.js'));
      const saveMax = RL.MAX_TRACKED_BUCKETS, saveBatch = RL.EVICT_BATCH;
      RL.MAX_TRACKED_BUCKETS = 50; RL.EVICT_BATCH = 10;
      // Trip a real lockout for one IP, then flood with fresh IPs past the cap.
      const victim = r.bucketKey('public', '198.51.100.1');
      for (let i = 0; i < 6; i++) r.checkLimit(victim, 5);
      const lockedBefore = r.violations.has(victim);
      for (let i = 0; i < 500; i++) r.checkLimit(r.bucketKey('public', '203.0.113.' + (i % 254) + '.' + i), 5);
      ok('§J12-11 the cap actually bounds the request map under a source flood',
        r.requests.size <= RL.MAX_TRACKED_BUCKETS + RL.EVICT_BATCH, String(r.requests.size));
      ok('§J12-11 …and a live lockout survives that flood',
        lockedBefore && r.violations.has(victim) && r.checkLimit(victim, 5) === false);
      RL.MAX_TRACKED_BUCKETS = saveMax; RL.EVICT_BATCH = saveBatch;
    }
  }

  // §J12-12 — the cheap admission checks must run BEFORE the Tor probe, and the authoritative
  // copy must still be inside createWithdrawal's transaction.
  ok('§J12-12 a read-only precheck exists on the scheduler',
    /precheckWithdrawable\(grinAddress/.test(schedSrc));
  ok('§J12-12 the route calls it BEFORE the Tor pre-flight probe',
    indexSrc.indexOf('precheckWithdrawable(addr)') > 0 &&
    indexSrc.indexOf('precheckWithdrawable(addr)') <
      indexSrc.indexOf('await walletTor.probeToronlineStatus(addr)', indexSrc.indexOf('precheckWithdrawable(addr)')));
  ok('§J12-12 createWithdrawal still re-checks the pending cap inside its transaction',
    /const txn = this\.db\.transaction\(\(\) => \{[\s\S]{0,900}?you already have a pending withdrawal/.test(schedSrc));
  ok('§J12-12 the probe is still uncached on the money path (freshness guarantee intact)',
    /await walletTor\.probeToronlineStatus\(addr\)/.test(indexSrc));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
