'use strict';

// Connect-page suggestion — lib/connect-suggest.js (the geographic ESTIMATE behind
// GET /api/pool/connect/suggest) and the route's privacy stance.
// Covers: the K calibration against the 2026-09-23 measurements to OVH Gravelines (±25%);
// effective latency = viewer→gateway + hub_rtt_ms, so a near gateway with a long link home loses
// to connecting direct (the Singapore case); the direct bias; a gateway with no hub_rtt_ms or an
// offline one gets no estimate; an unknown country gets no recommendation; a same-country server
// placed by centroid is an in-country distance away, never 0 km; the route never
// stores, logs or echoes the viewer's IP or country, is never cached, and shares its region
// status with /api/pool/stats/regions.
// index.js starts a server on require, so the route is read as text (as in test-regions.js).
// Run: node scripts/test-connect-suggest.js   (no DB, no server, nothing left running)

const fs = require('fs');
const path = require('path');
const APP = path.resolve(__dirname, '..');

const cs = require(path.join(APP, 'lib/connect-suggest.js'));
const geoip = require(path.join(APP, 'lib/geoip.js'));
const indexSrc = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
const est = (res, region) => (res.estimates.find((e) => e.region === region) || {}).est_ms;

// City positions for the calibration — the probes were in cities, so test with cities, not
// country centroids (a centroid would test geoip's table, not K). Injected via `centroid`.
const CITY = {
  GRA: { lat: 50.99, lng: 2.13 },    // OVH Gravelines (the hub)
  FRA: { lat: 50.11, lng: 8.68 },    // Frankfurt
  IAD: { lat: 39.04, lng: -77.49 },  // Ashburn
  SIN: { lat: 1.35, lng: 103.82 },   // Singapore
  HKG: { lat: 22.30, lng: 114.20 },  // Hong Kong
};
const cityCentroid = (cc) => CITY[cc] || null;
const HUB = { region: 'cqf', is_hub: true, hub_rtt_ms: 0, status: 'idle', lat: CITY.GRA.lat, lng: CITY.GRA.lng };

console.log('\n[a] calibration — K = 0.015 ms/km lands within ±25% of the measured RTT to Gravelines\n');
for (const [viewer, lo, hi] of [['FRA', 9, 9], ['IAD', 84, 84], ['SIN', 148, 162], ['HKG', 159, 182]]) {
  const r = cs.estimate({ viewerCc: viewer, regions: [HUB], centroid: cityCentroid });
  const e = est(r, 'cqf');
  const within = e >= lo * 0.75 && e <= hi * 1.25;
  ok(`a. ${viewer} → Gravelines estimates ${e} ms (measured ${lo === hi ? lo : lo + '–' + hi})`, within,
    `outside ±25% of ${lo}–${hi}`);
}
ok('a. the default K is 0.015 and the default direct bias is 15 ms',
  cs.DEFAULT_K === 0.015 && cs.DEFAULT_DIRECT_BIAS_MS === 15);
ok('a. haversine is symmetric and 0 at a point',
  cs.haversineKm(CITY.GRA, CITY.SIN) === cs.haversineKm(CITY.SIN, CITY.GRA) && cs.haversineKm(CITY.GRA, CITY.GRA) === 0);

console.log('\n[b] effective latency — a gateway adds its link home, it never shortens it\n');
{
  // Singapore visitor; an HK gateway ~2,600 km away whose route home is a slow 182 ms.
  const hk = { region: 'hkg', is_hub: false, hub_rtt_ms: 182, status: 'idle', lat: CITY.HKG.lat, lng: CITY.HKG.lng };
  const r = cs.estimate({ viewerCc: 'SIN', regions: [HUB, hk], centroid: cityCentroid });
  ok('b. Singapore: connecting DIRECT beats the nearer HK gateway', r.recommended === 'cqf',
    JSON.stringify(r));
  ok('b. the HK gateway estimate includes its hub_rtt_ms (> 182 ms)', est(r, 'hkg') > 182);
  ok('b. the direct row is via "direct", the gateway via "gateway"',
    r.estimates.find((e) => e.region === 'cqf').via === 'direct' &&
    r.estimates.find((e) => e.region === 'hkg').via === 'gateway');
  // Hong Kong visitor with a FAST route home: the gateway wins by more than the bias.
  const hkFast = { ...hk, hub_rtt_ms: 100 };
  const r2 = cs.estimate({ viewerCc: 'HKG', regions: [HUB, hkFast], centroid: cityCentroid });
  ok('b. Hong Kong + a 100 ms route home: the HK gateway is recommended', r2.recommended === 'hkg',
    JSON.stringify(r2));
  ok('b. estimates are sorted fastest first', r2.estimates[0].region === 'hkg');
  ok('b. every est_ms is a positive integer',
    r2.estimates.every((e) => Number.isInteger(e.est_ms) && e.est_ms >= 1));
}

console.log('\n[c] direct bias — a near tie goes to the hub\n');
{
  // Flat geometry: viewer and both servers at the same point, so est = hub_rtt_ms exactly.
  const at = () => ({ lat: 10, lng: 10 });
  const hub = { region: 'hub', is_hub: true, hub_rtt_ms: 0, status: 'idle', lat: 0, lng: 0 };
  const gw = (ms) => ({ region: 'gw', is_hub: false, hub_rtt_ms: ms, status: 'online', lat: 10, lng: 10 });
  // Viewer at (10,10): direct = dist((10,10),(0,0)) × K ≈ 1,568 km × 0.015 ≈ 23.5 ms.
  const d = cs.haversineKm({ lat: 10, lng: 10 }, { lat: 0, lng: 0 }) * cs.DEFAULT_K;
  const within = cs.estimate({ viewerCc: 'X', regions: [hub, gw(d - 10)], centroid: at });
  ok('c. gateway 10 ms faster than direct → direct recommended (bias 15)', within.recommended === 'hub',
    JSON.stringify(within));
  const beyond = cs.estimate({ viewerCc: 'X', regions: [hub, gw(d - 20)], centroid: at });
  ok('c. gateway 20 ms faster than direct → the gateway recommended', beyond.recommended === 'gw',
    JSON.stringify(beyond));
  const zero = cs.estimate({ viewerCc: 'X', regions: [hub, gw(d - 10)], centroid: at, directBiasMs: 0 });
  ok('c. directBiasMs 0 → the strictly fastest wins', zero.recommended === 'gw');
  const noHub = cs.estimate({ viewerCc: 'X', regions: [gw(50)], centroid: at });
  ok('c. no is_hub row (a hub-role pool) → the best gateway, no crash', noHub.recommended === 'gw');
}

console.log('\n[d] rows that get NO estimate\n');
{
  const base = { is_hub: false, status: 'idle', lat: CITY.FRA.lat, lng: CITY.FRA.lng };
  const r = cs.estimate({
    viewerCc: 'FRA', centroid: cityCentroid,
    regions: [
      HUB,
      { ...base, region: 'nul', hub_rtt_ms: null },
      { ...base, region: 'und' },
      { ...base, region: 'off', hub_rtt_ms: 3, status: 'offline' },
      { ...base, region: 'nan', hub_rtt_ms: NaN },
      { ...base, region: 'neg', hub_rtt_ms: -1 },
      { region: 'nopos', is_hub: false, hub_rtt_ms: 3, status: 'idle' },
      { ...base, region: 'chk', hub_rtt_ms: 3, status: 'checking' },
    ],
  });
  const tags = r.estimates.map((e) => e.region).sort().join(',');
  ok('d. a gateway with hub_rtt_ms null / missing / NaN / negative is excluded',
    !/\b(nul|und|nan|neg)\b/.test(tags), tags);
  ok('d. an offline gateway is excluded even with the fastest link home', !/\boff\b/.test(tags), tags);
  ok('d. a row with no lat/lng and no country is excluded', !/\bnopos\b/.test(tags), tags);
  ok('d. a "checking" gateway with a measured link is still estimated', /\bchk\b/.test(tags), tags);
  ok('d. exactly the hub and the checking gateway remain', tags === 'chk,cqf', tags);
  const offHub = cs.estimate({ viewerCc: 'FRA', centroid: cityCentroid, regions: [{ ...HUB, status: 'offline' }] });
  ok('d. an offline hub row → nothing to recommend', offHub.recommended === null && offHub.estimates.length === 0);
  const empty = cs.estimate({ viewerCc: 'FRA', centroid: cityCentroid, regions: [] });
  ok('d. no regions → recommended null, estimates []', empty.recommended === null && empty.estimates.length === 0);
}

console.log('\n[e] unknown viewer country → no recommendation (real geoip centroids)\n');
{
  const regs = [
    { region: 'cqf', is_hub: true, hub_rtt_ms: 0, status: 'idle', lat: CITY.GRA.lat, lng: CITY.GRA.lng },
    { region: 'nyc', is_hub: false, hub_rtt_ms: 80, status: 'online', country_code: 'US' },
  ];
  for (const cc of ['ZZ', '', null, undefined]) {
    const r = cs.estimate({ viewerCc: cc, regions: regs });
    ok(`e. viewer ${JSON.stringify(cc)} → recommended null, no estimates`,
      r.recommended === null && Array.isArray(r.estimates) && r.estimates.length === 0);
  }
  const de = cs.estimate({ viewerCc: 'DE', regions: regs });
  ok('e. a known country (DE) → the Gravelines hub, direct', de.recommended === 'cqf', JSON.stringify(de));
  ok('e. a gateway with no lat/lng falls back to its country centroid', est(de, 'nyc') > 80);
  ok('e. lowercase country codes resolve like uppercase',
    JSON.stringify(cs.estimate({ viewerCc: 'de', regions: regs })) === JSON.stringify(de));
  ok('e. the response carries no viewer position or country',
    Object.keys(de).sort().join(',') === 'estimates,recommended' &&
    de.estimates.every((e) => Object.keys(e).sort().join(',') === 'est_ms,region,via'));
  ok('e. geoip has a centroid for every country the seeded regions use (FR/US/CA/HK/SG/VN)',
    ['FR', 'US', 'CA', 'HK', 'SG', 'VN'].every((cc) => geoip.countryCentroid(cc)));
}

console.log('\n[g] a same-country server placed by centroid is NOT 0 km from the viewer\n');
{
  // The seeded rows carry no lat/lng, so nyc sits on the US centroid — exactly where every US
  // viewer is placed. Without the in-country distance the viewer→nyc leg computed as 0 km.
  const hub = { region: 'cqf', is_hub: true, hub_rtt_ms: 0, status: 'idle', lat: CITY.GRA.lat, lng: CITY.GRA.lng };
  const nyc = { region: 'nyc', is_hub: false, hub_rtt_ms: 78, status: 'online', country_code: 'US' };
  const r = cs.estimate({ viewerCc: 'US', regions: [hub, nyc] });
  const floor = Math.round(cs.inCountryKm('US') * cs.DEFAULT_K);
  ok('g. the in-country distance for US is the table\'s half-extent (9° ≈ 999 km)',
    Math.round(cs.inCountryKm('US')) === 999);
  ok(`g. US viewer → centroid-placed US gateway = ${floor} ms in-country + its 78 ms link, not 78 alone`,
    est(r, 'nyc') === 78 + floor, JSON.stringify(r));
  ok('g. lowercase viewer code gets the same in-country distance',
    est(cs.estimate({ viewerCc: 'us', regions: [hub, nyc] }), 'nyc') === 78 + floor);
  ok('g. a gateway with a DECLARED lat/lng uses geometry, not the in-country guess',
    est(cs.estimate({ viewerCc: 'US', regions: [hub, { ...nyc, lat: 40.71, lng: -74.0 }] }), 'nyc') !== 78 + floor);
  ok('g. a DIFFERENT country\'s centroid-placed server is plain geometry (DE viewer → nyc)',
    est(cs.estimate({ viewerCc: 'DE', regions: [hub, nyc] }), 'nyc') ===
      Math.round(cs.haversineKm(geoip.countryCentroid('DE'), geoip.countryCentroid('US')) * cs.DEFAULT_K + 78));
  ok('g. an unknown country code falls back to a 1.5° in-country distance',
    Math.round(cs.inCountryKm('ZZ')) === Math.round(1.5 * 111));
}

console.log('\n[f] the route — privacy, caching, one status implementation\n');
{
  const start = indexSrc.indexOf("app.get('/api/pool/connect/suggest'");
  const next = start < 0 ? -1 : indexSrc.slice(start + 10).search(/\n\s{0,4}app\.(get|post|put|delete|patch)\(/);
  const route = start < 0 ? '' : indexSrc.slice(start, start + 10 + next);
  const code = route.replace(/\/\/[^\n]*/g, '');
  ok('f. GET /api/pool/connect/suggest exists behind the public rate limiter',
    route.length > 0 && /rateLimiter\.middleware\('public'\)/.test(route));
  ok('f. it is never cached (private, no-store)', /Cache-Control',\s*'private, no-store'/.test(code));
  ok('f. no geoip → { basis: "unavailable" } and nothing else',
    /res\.json\(\{\s*basis:\s*'unavailable'\s*\}\)/.test(code));
  ok('f. nothing logged in the handler', !/console\.|logger\.|\blog\(/.test(code));
  // Uppercase SQL only — `.replace('::ffff:', '')` is string handling, not a write.
  ok('f. nothing written in the handler (no SQL write, no .run())',
    !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/.test(code) && !/\.run\(/.test(code));
  ok('f. the IP and country never reach the response',
    !/res\.json\([^)]*\b(geo|ip|cc|country)\b/.test(code) && !/req\.ip[^\n]*res\./.test(code));
  ok('f. the success response is exactly { basis, recommended, estimates }',
    /res\.json\(\{\s*basis:\s*'estimate',\s*recommended,\s*estimates\s*\}\)/.test(code));
  ok('f. the published-row filter matches the patch bay (active + stratum_url)',
    /l\.stratum_url && \(l\.is_active === 1 \|\| l\.is_active === true\)/.test(code));
  ok('f. status comes from publicRegionStatus(), shared with /api/pool/stats/regions',
    /publicRegionStatus\(/.test(code));
  const rs = indexSrc.indexOf("app.get('/api/pool/stats/regions'");
  const rn = indexSrc.slice(rs + 10).search(/\n\s{0,4}app\.(get|post|put|delete|patch)\(/);
  const regionsRoute = indexSrc.slice(rs, rs + 10 + rn);
  ok('f. /api/pool/stats/regions uses the same publicRegionStatus()', /publicRegionStatus\(/.test(regionsRoute));
  ok('f. …and no longer carries its own copy of the precedence',
    !/sharesFresh/.test(regionsRoute));
  const meta = indexSrc.split('\n').find((l) => l.trimStart().startsWith("'GET /api/pool/connect/suggest':")) || '';
  ok('f. API_DOC_META documents the route, est_ms units and the unavailable case',
    /est_ms/.test(meta) && /milliseconds/.test(meta) && /unavailable/.test(meta) && /no-store/.test(meta));
}

console.log('\n[h] pickRecommended — the ranking rule, and the page\'s copy of it agrees\n');
{
  const P = cs.pickRecommended;
  const row = (region, ms, direct = false) => ({ region, ms, direct });
  ok('h. lowest wins', P([row('a', 50), row('b', 20)], 15) === 'b');
  ok('h. direct within the bias wins', P([row('hub', 30, true), row('gw', 16)], 15) === 'hub');
  ok('h. direct exactly at the bias wins (<=)', P([row('hub', 31, true), row('gw', 16)], 15) === 'hub');
  ok('h. a gateway beyond the bias wins', P([row('hub', 32, true), row('gw', 16)], 15) === 'gw');
  ok('h. a tie breaks on the tag', P([row('zz', 10), row('aa', 10)], 0) === 'aa');
  ok('h. rows with a non-finite ms are ignored', P([row('x', NaN), row('y', Infinity), row('z', 40)], 15) === 'z');
  ok('h. no usable rows → null', P([], 15) === null && P([row('x', null)], 15) === null);
  ok('h. an invalid bias falls back to the default', P([row('hub', 30, true), row('gw', 16)], -1) === 'hub'
    && P([row('hub', 30, true), row('gw', 16)], NaN) === 'hub');

  // The page's copy (public_html/js/reactor-dashboard.js) must rank exactly like this one. The
  // web root deploys apart from the app, so a deployed app dir has no public_html/ → SKIP there.
  const PAGE = path.resolve(APP, '../public_html/js/reactor-dashboard.js');
  if (!fs.existsSync(PAGE)) {
    console.log(`  SKIP  h. ${PAGE} not present (a deployed app dir has no public_html/) — run from the repo`);
  } else {
    const src = fs.readFileSync(PAGE, 'utf8');
    const m = /\n( *)function pickRecommended\(rows, bias\) \{[\s\S]*?\n\1\}\n/.exec(src);
    ok('h. the page defines pickRecommended(rows, bias)', !!m);
    let pageP = null;
    try { pageP = m ? new Function(`${m[0]}; return pickRecommended;`)() : null; } catch (e) { pageP = null; }
    ok('h. the page copy is self-contained (evaluates on its own)', typeof pageP === 'function');
    ok('h. the page takes the bias from branding, never a literal',
      /pickRecommended\(rows, latencyCfg\.direct_bias_ms\)/.test(src) && !/pickRecommended\([^)]*,\s*\d/.test(src));
    if (typeof pageP === 'function') {
      // Deterministic pseudo-random cases (no Math.random: a failure must reproduce).
      let seed = 7;
      const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      let agree = 0, cases = 0, firstDiff = '';
      for (let i = 0; i < 2000; i++) {
        const n = 1 + Math.floor(rnd() * 5);
        const rows = [];
        for (let j = 0; j < n; j++) {
          const ms = rnd() < 0.08 ? NaN : Math.round(rnd() * 3000) / 10;
          rows.push(row(['cqf', 'nyc', 'lax', 'hkg', 'yyz', 'sin'][Math.floor(rnd() * 6)], ms, j === 0 && rnd() < 0.7));
        }
        const bias = [0, 15, 15, 30][Math.floor(rnd() * 4)];
        const a = P(rows.map((r) => ({ ...r })), bias);
        const b = pageP(rows.map((r) => ({ ...r })), bias);
        cases++;
        if (a === b) agree++;
        else if (!firstDiff) firstDiff = `${JSON.stringify(rows)} bias ${bias}: lib ${a} page ${b}`;
      }
      ok(`h. lib and page agree on all ${cases} generated cases`, agree === cases, firstDiff);
    }
  }
  ok('h. estimate() ranks through pickRecommended (one rule server-side)',
    /pickRecommended\(scored\.map/.test(fs.readFileSync(path.join(APP, 'lib/connect-suggest.js'), 'utf8')));
}

console.log(fail ? `\nFAILED — ${pass} passed, ${fail} failed` : `\nALL PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
