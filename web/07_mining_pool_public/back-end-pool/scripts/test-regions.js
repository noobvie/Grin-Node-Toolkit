'use strict';

// Region list — the default-region seed (lib/db.js seedDefaultRegions), the local-region
// registration and its hub-MOVE activation rule (ensureLocalRegion), and the hub↔gateway RTT
// published on GET /api/pool/stats/regions (lib/region-rtt.js → hub_rtt_ms, plus is_hub).
// Covers: a fresh grinium DB seeds 8 rows, all INACTIVE, never the local tag; a v2 marker adds
// exactly hkg/sin/cqf and re-creates nothing older; a non-grinium domain seeds nothing and
// stamps nothing; a hub moving nyc → cqf publishes cqf once, and an operator who then switches
// cqf off is NOT overruled by the next restart; the RTT window's min / cap / null / hub-0 rules.
// index.js starts a server on require, so the route itself is read as text (as in
// test-public-leakage.js); everything with behaviour lives in the libs and is run for real.
// Run: node scripts/test-regions.js   (in-memory DB, no server, nothing left running)

const fs = require('fs');
const path = require('path');
const APP = path.resolve(__dirname, '..');

const dbLib = require(path.join(APP, 'lib/db.js'));
const { RTT_WINDOW, pushRttSample, hubRttMs } = require(path.join(APP, 'lib/region-rtt.js'));
const indexSrc = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

// The seed and ensureLocalRegion log one line each by design; keep the report readable.
const realWarn = console.warn;
const warned = [];
console.warn = (...a) => { warned.push(a.join(' ')); };

// A brand-new in-memory DB per scenario (the lib holds one module-level handle).
function freshDb() {
  dbLib.closeDb();
  dbLib.initDb(':memory:');
  return dbLib.getDb();
}
const rows = (db) => db.prepare('SELECT region, is_active, stratum_url FROM pool_locations ORDER BY region').all();
const tags = (db) => rows(db).map(r => r.region).join(',');
const marker = (db) => {
  const r = db.prepare("SELECT value FROM pool_config WHERE section = '_migrations' AND key = 'regions_seeded'").get();
  return r ? r.value : null;
};
const localStamp = (db) => {
  const r = db.prepare("SELECT value FROM pool_config WHERE section = '_state' AND key = 'local_region'").get();
  return r ? r.value : null;
};
const active = (db, region) => {
  const r = db.prepare('SELECT is_active FROM pool_locations WHERE region = ?').get(region);
  return r ? !!r.is_active : undefined;
};
const setMarker = (db, v) => db.prepare(
  "INSERT INTO pool_config (section, key, value, value_type) VALUES ('_migrations', 'regions_seeded', ?, 'string')"
).run(v);
// One pool boot as index.js runs it: seed first, then (singlebox) the local-region registration.
function boot(region, host = 'grinium.com') {
  dbLib.seedDefaultRegions(3333, host, region);
  dbLib.ensureLocalRegion(region, `${host}:3333`, { label: region.toUpperCase() });
}

const ALL8 = 'ams,cqf,hkg,lax,nyc,sgn,sin,yyz';

console.log('\n[a] seeds v3 — fresh grinium DB\n');
{
  const db = freshDb();
  dbLib.seedDefaultRegions(3333, 'pool.grinium.com', 'main');
  const r = rows(db);
  ok('a. fresh DB → 8 seeded rows', r.length === 8, `got ${r.length}: ${tags(db)}`);
  ok('a. …exactly the v1+v2+v3 tags (no han)', tags(db) === ALL8, tags(db));
  ok('a. …all INACTIVE', r.every(x => x.is_active === 0));
  ok('a. …every host is a grinium subdomain on the configured port',
    r.every(x => new RegExp(`^${x.region}\\.grinium\\.com:3333$`).test(x.stratum_url)));
  ok('a. …marker stamped 3', marker(db) === '3', String(marker(db)));
  ok('a. cqf is Gravelines, FR (not gra/lil)', (() => {
    const c = db.prepare("SELECT label, country, country_code FROM pool_locations WHERE region = 'cqf'").get();
    return c && c.label === 'Gravelines' && c.country === 'France' && c.country_code === 'FR';
  })());
  ok('a. hkg = Hong Kong/HK, sin = Singapore/SG', (() => {
    const h = db.prepare("SELECT label, country_code FROM pool_locations WHERE region = 'hkg'").get();
    const s = db.prepare("SELECT label, country_code FROM pool_locations WHERE region = 'sin'").get();
    return h && h.label === 'Hong Kong' && h.country_code === 'HK' && s && s.label === 'Singapore' && s.country_code === 'SG';
  })());

  const db2 = freshDb();
  dbLib.seedDefaultRegions(3333, 'grinium.com', 'cqf');
  ok('a. the local tag is EXCLUDED from the seed (local cqf → 7 rows, no cqf)',
    rows(db2).length === 7 && active(db2, 'cqf') === undefined, tags(db2));
  dbLib.ensureLocalRegion('cqf', 'grinium.com:3333', {});
  ok('a. …and ensureLocalRegion then registers it ACTIVE', active(db2, 'cqf') === true);
  dbLib.seedDefaultRegions(3333, 'grinium.com', 'cqf');
  ok('a. a second boot re-seeds nothing', rows(db2).length === 8 && marker(db2) === '3');
}

console.log('\n[b] seeds v3 — upgrade from an older marker\n');
{
  const db = freshDb();
  setMarker(db, '2');
  dbLib.seedDefaultRegions(3333, 'grinium.com', 'main');
  ok('b. marker 2 → exactly hkg/sin/cqf added', tags(db) === 'cqf,hkg,sin', tags(db));
  ok('b. …inactive', rows(db).every(x => x.is_active === 0));
  ok('b. …older rows NOT re-created (an operator\'s deletions stay deleted)', active(db, 'nyc') === undefined);
  ok('b. …marker advanced to 3', marker(db) === '3');

  const db1 = freshDb();
  setMarker(db1, '1');
  dbLib.seedDefaultRegions(3333, 'grinium.com', 'main');
  ok('b. legacy marker 1 → sgn + the v3 three', tags(db1) === 'cqf,hkg,sgn,sin', tags(db1));

  const db3 = freshDb();
  setMarker(db3, '2');
  db3.prepare("INSERT INTO pool_locations (region, label, stratum_url, is_active) VALUES ('hkg', 'Mine', 'hk.example.org:4444', 1)").run();
  dbLib.seedDefaultRegions(3333, 'grinium.com', 'main');
  const h = db3.prepare("SELECT label, stratum_url, is_active FROM pool_locations WHERE region = 'hkg'").get();
  ok('b. an operator row already owning a new tag is kept as it is (INSERT OR IGNORE)',
    h.label === 'Mine' && h.stratum_url === 'hk.example.org:4444' && h.is_active === 1);

  const db4 = freshDb();
  setMarker(db4, '2');
  dbLib.seedDefaultRegions(3333, 'grinium.com', 'hkg');
  ok('b. the local tag is excluded on an upgrade too (local hkg → cqf,sin only)', tags(db4) === 'cqf,sin', tags(db4));
}

console.log('\n[c] seeds v3 — not grinium\n');
{
  for (const host of ['pool.example.org', 'evilgrinium.com', 'grinium.com.evil.net', '']) {
    const db = freshDb();
    dbLib.seedDefaultRegions(3333, host, 'main');
    ok(`c. domain "${host}" → no rows, no marker`, rows(db).length === 0 && marker(db) === null,
      `${rows(db).length} rows, marker ${marker(db)}`);
  }
}

console.log('\n[d] F3 — a hub MOVE publishes its new region once, and only once\n');
{
  const db = freshDb();
  boot('nyc');
  ok('d. boot as nyc: nyc active', active(db, 'nyc') === true);
  ok('d. …cqf seeded INACTIVE (it is a plan on this box)', active(db, 'cqf') === false);
  ok('d. …local region stamped nyc', localStamp(db) === 'nyc', String(localStamp(db)));

  boot('nyc');
  ok('d. restart as nyc: nothing changes', active(db, 'nyc') === true && active(db, 'cqf') === false);

  // The DB is restored on the new box, which is configured with its own tag.
  warned.length = 0;
  boot('cqf');
  ok('d. switch local to cqf → the cqf row is ACTIVE', active(db, 'cqf') === true);
  ok('d. …the OLD local row nyc is left as it was (not deactivated)', active(db, 'nyc') === true);
  ok('d. …stamp moved to cqf', localStamp(db) === 'cqf');
  const moveLine = warned.filter(l => /local region changed/.test(l));
  ok('d. …exactly one warn line, naming both regions',
    moveLine.length === 1 && /'nyc'/.test(moveLine[0]) && /'cqf'/.test(moveLine[0]), moveLine.join(' / '));
  ok('d. …the rest of the seed is untouched (still inactive plans)',
    ['ams', 'hkg', 'lax', 'sgn', 'sin', 'yyz'].every(t => active(db, t) === false));

  // The operator switches cqf off in admin → Regions, then the box restarts.
  db.prepare("UPDATE pool_locations SET is_active = 0 WHERE region = 'cqf'").run();
  warned.length = 0;
  boot('cqf');
  ok('d. restart with cqf again after the operator deactivates it → STAYS inactive', active(db, 'cqf') === false);
  ok('d. …and logs no move', !warned.some(l => /local region changed/.test(l)));
  boot('cqf');
  ok('d. …on every later restart too', active(db, 'cqf') === false);

  // Moving back (rollback to the old box's tag) activates nyc again only if it was switched off.
  db.prepare("UPDATE pool_locations SET is_active = 0 WHERE region = 'nyc'").run();
  boot('nyc');
  ok('d. a move back to nyc re-publishes nyc once', active(db, 'nyc') === true && localStamp(db) === 'nyc');

  // A move to a tag with no row at all (not a seed tag) → registered active, stamp follows.
  boot('fra');
  ok('d. a move to a tag with no row → inserted ACTIVE, stamp follows',
    active(db, 'fra') === true && localStamp(db) === 'fra');

  // No stamp yet (a DB from before this rule): previous region unknown → never activate.
  const dbOld = freshDb();
  boot('nyc');
  dbOld.prepare("DELETE FROM pool_config WHERE section = '_state' AND key = 'local_region'").run();
  boot('cqf');
  ok('d. NO stamp (pre-2026-09-23 DB) → cqf is NOT activated (cannot tell a plan from an operator\'s off switch)',
    active(dbOld, 'cqf') === false);
  ok('d. …but the stamp is written, so the NEXT move is detected', localStamp(dbOld) === 'cqf');

  // 'default' is not a region: no row, no stamp.
  const dbDef = freshDb();
  dbLib.ensureLocalRegion('default', 'x:3333', {});
  ok('d. region "default" → no row, no stamp', rows(dbDef).length === 0 && localStamp(dbDef) === null);
}

console.log('\n[e] hub_rtt_ms — the rolling window\n');
{
  ok('e. the window holds 5 samples', RTT_WINDOW === 5);
  let w;
  for (const ms of [40, 31, 55, 33, 47]) w = pushRttSample(w, ms);
  ok('e. hub_rtt_ms is the MIN of the window', hubRttMs(w, false) === 31, String(hubRttMs(w, false)));
  w = pushRttSample(w, 60);
  ok('e. a 6th sample drops the oldest (window stays 5)', w.length === 5 && w[0] === 31, JSON.stringify(w));
  w = pushRttSample(w, 70);
  ok('e. …so an old minimum ages out', hubRttMs(w, false) === 33, JSON.stringify(w));
  const before = JSON.stringify(w);
  w = pushRttSample(w, null);
  ok('e. a failed probe (null) adds nothing and clears nothing', JSON.stringify(w) === before);
  w = pushRttSample(w, NaN); w = pushRttSample(w, -1); w = pushRttSample(w, Infinity);
  ok('e. NaN / negative / Infinity are ignored', JSON.stringify(w) === before);
  ok('e. rounded to an integer', hubRttMs(pushRttSample([], 12.6), false) === 13);
  ok('e. null with no samples (empty window)', hubRttMs([], false) === null);
  ok('e. null before the first probe (undefined window)', hubRttMs(undefined, false) === null);
  ok('e. null when every probe so far failed', hubRttMs(pushRttSample(pushRttSample(undefined, null), null), false) === null);
  ok('e. 0 for the hub row, with samples', hubRttMs([25, 30], true) === 0);
  ok('e. 0 for the hub row, without samples', hubRttMs(undefined, true) === 0);
  const src = [12, 9];
  pushRttSample(src, 3);
  ok('e. pushRttSample does not mutate the caller\'s array', JSON.stringify(src) === '[12,9]');
}

console.log('\n[f] the route and the probe publish it (index.js, read as text)\n');
{
  const start = indexSrc.indexOf("app.get('/api/pool/stats/regions'");
  const next = indexSrc.slice(start + 10).search(/\n\s{0,4}app\.(get|post|put|delete|patch)\(/);
  const route = indexSrc.slice(start, start + 10 + next);
  ok('f. the regions route publishes is_hub for the local region',
    /is_hub:\s*region === localRegion/.test(route));
  ok('f. …and hub_rtt_ms from the probe window, 0 on the hub row',
    /hub_rtt_ms:\s*hubRttMs\(stratumRttWindow\(region\),\s*region === localRegion\)/.test(route));
  ok('f. the probe cache keeps the window (pushRttSample in refreshStratumProbes)',
    /rtt:\s*pushRttSample\(prev\.rtt,\s*ms\)/.test(indexSrc));
  ok('f. probeStratumTcp restarts its clock after DNS and per connection attempt',
    /sock\.on\('lookup',\s*restart\)/.test(indexSrc) && /sock\.on\('connectionAttempt',\s*restart\)/.test(indexSrc));
  const meta = indexSrc.split('\n').find(l => l.trimStart().startsWith("'GET /api/pool/stats/regions':")) || '';
  ok('f. API_DOC_META documents is_hub and hub_rtt_ms, the unit and when it is null',
    /is_hub/.test(meta) && /hub_rtt_ms/.test(meta) && /milliseconds/.test(meta) && /null/.test(meta) && /0 on the is_hub row/.test(meta));
}

console.warn = realWarn;
dbLib.closeDb();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nALL PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
