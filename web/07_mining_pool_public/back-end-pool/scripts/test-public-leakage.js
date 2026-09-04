// Public-surface leakage regression tests — audit §J11 (public API leakage & privacy).
//
// Guards every §J11 fix, and pins the facts each one rests on so a later reader cannot
// "tidy" the evidence away:
//   §J11-1  The address mask keeps 9 leading + 4 trailing bech32 chars, which is a UNIQUE key:
//           a masked row re-attaches to its full address by joining against ANY feed that
//           publishes one. So it is only a control while no public LIST emits a full address —
//           the invariant asserted below across all seven feeds that used to. The four
//           independent copies of the mask must also stay in agreement.
//   §J11-2  Neither /api/pool/payments (pool-wide) nor /api/account/:addr/withdrawals
//           (per-address, JSON + CSV) may publish kernel_excess. The kernel names a specific
//           transaction in the Grin chain forever; published beside an address it is a public
//           address-to-chain index. It now comes from an ownership-gated POST, on the
//           `withdraw` bucket — never `public`, because verifyOwnerProof runs scrypt (§F2).
//   §J11-3  account-settings.html must be noindex, and no page may emit an
//           /account-settings.html?addr= link — that link was both the full-address source
//           that inverted the mask and the crawl path into third-party indexes.
//   §J11-5  The k-anonymity floor must reach the REGION breakdown, not just the country one,
//           and a withheld count must be null (a gap), never 0.
//   §J11-4  No analytics default may name a third-party property or select a provider. The
//           shipped ga4 + G-… id sent every visitor of every deployed pool to one fixed GA4
//           property, and the generated nginx CSP already allowlists the host, so nothing
//           blocked it. branding.js must scrub `addr` from BOTH page_location and
//           page_referrer — GA4 defaults the latter to document.referrer, so pinning only the
//           first shipped the address as the referrer of the very next page view.
//   §J11-7  The window/hours parsers must survive a non-numeric value. `parseInt(x || N)`
//           runs `||` first, so a junk string reaches parseInt and NaN propagates through
//           Math.min/Math.max — and because both consumers swallow it, the miner gets a
//           plausible EMPTY answer rather than an error.
//   §J11-8  coarsenIp() and the geo resolver must hold at the WRITE side.
//
// Pure in-process assertions against the real modules — no server, no DB, nothing left
// running. Run: node scripts/test-public-leakage.js
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const WEB = path.resolve(APP, '..');
const PoolSettings = require(path.join(APP, 'lib/pool-settings.js'));
const ownerProof = require(path.join(APP, 'lib/owner-proof.js'));
const geoip = require(path.join(APP, 'lib/geoip.js'));

const indexSrc = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');
const brandingSrc = fs.readFileSync(path.join(WEB, 'public_html/js/branding.js'), 'utf8');
const dormancySrc = fs.readFileSync(path.join(APP, 'lib/dormancy.js'), 'utf8');
const chartsSrc = fs.readFileSync(path.join(WEB, 'public_html/js/charts-init.js'), 'utf8');
const PUBLIC_PAGES = fs.readdirSync(path.join(WEB, 'public_html')).filter((n) => n.endsWith('.html'));

// A route's source text, from its `app.<verb>('<path>'` to the next route registration. Used to
// assert what a specific handler does without booting the app (index.js starts a server on
// require), the same way test-branding-sinks.js reads public_html/.
function routeSrc(verb, routePath) {
  const start = indexSrc.indexOf(`app.${verb}('${routePath}'`);
  if (start < 0) return '';
  const next = indexSrc.slice(start + 10).search(/\n\s{0,4}app\.(get|post|put|delete|patch)\(/);
  return next < 0 ? indexSrc.slice(start) : indexSrc.slice(start, start + 10 + next);
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('\n[1] §J11-4 — no analytics default ships a third-party property\n');

const a = PoolSettings.defaults.analytics;
ok("§J11-4 analytics.provider defaults to 'none'", a.provider === 'none',
  `got ${JSON.stringify(a.provider)}`);
ok('§J11-4 analytics.ga_tracking_id ships empty', a.ga_tracking_id === '',
  `got ${JSON.stringify(a.ga_tracking_id)}`);
// The src/domain defaults (plausible_src, umami_src) are the vendors' own script URLs and are
// inert while their id/domain field is blank — so the assertion is about IDENTIFIERS, which is
// what actually attributes a visitor to somebody's account.
const ID_KEYS = ['ga_tracking_id', 'plausible_domain', 'umami_website_id', 'matomo_url', 'matomo_site_id'];
const populatedIds = ID_KEYS.filter((k) => String(a[k] || '') !== '');
ok('§J11-4 no analytics identifier default is populated', populatedIds.length === 0,
  populatedIds.join(', '));
ok('§J11-4 no analytics default contains a GA measurement id',
  !Object.values(a).some((v) => typeof v === 'string' && /\bG-[A-Z0-9]{6,}\b/.test(v)));

console.log('\n[2] §J11-4 — branding.js scrubs `addr` from BOTH GA4 URL parameters\n');

ok('§J11-4 loadGa4 pins page_location', /page_location:/.test(brandingSrc));
ok('§J11-4 loadGa4 also pins page_referrer', /page_referrer:/.test(brandingSrc),
  'GA4 defaults page_referrer to document.referrer, so the scrub is one-sided without this');
ok('§J11-4 a scrubbedReferrer() helper exists', /function scrubbedReferrer\s*\(/.test(brandingSrc));
ok('§J11-4 the shared scrubber deletes the addr parameter',
  /searchParams\.delete\(\s*['"]addr['"]\s*\)/.test(brandingSrc));

console.log('\n[3] §J11-1 — the address mask is a UNIQUE key, so NO public list may emit a full address\n');

// The mask as index.js:291 defines it. Re-derived here rather than imported: index.js starts a
// server on require, so this suite reads it as text (the same approach test-branding-sinks.js
// takes for public_html/).
const maskAddr = (v) => {
  const s = String(v || '');
  return s.length > 16 ? `${s.slice(0, 9)}…${s.slice(-4)}` : s;
};

// Two addresses that agree on a 9-char prefix but not on the mask, and one that is byte-equal
// to the first — a realistic "does the mask collide?" population.
const A = 'grin1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz9x';
const B = 'grin1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqwwww4p';
const C = 'grin1wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwmn4p';
const FULL_FEED = [A, B, C];   // what /api/pool/blocks | top-block-finders | top-miners publish

const recovered = FULL_FEED.filter((f) => maskAddr(f) === maskAddr(A));
ok('§J11-1 a masked row resolves to exactly ONE full address in the harvested set',
  recovered.length === 1 && recovered[0] === A,
  `${recovered.length} candidates`);
ok('§J11-1 the mask does not collide across a shared 9-char prefix',
  maskAddr(A) !== maskAddr(B));
ok('§J11-1 the mask keeps 9 leading and 4 trailing characters',
  maskAddr(A) === A.slice(0, 9) + '…' + A.slice(-4));
// dormancy.js keeps its own copy; if the two ever disagree the /api/pool/unclaimed rows stop
// joining to the leaderboards, which would be an accidental privacy IMPROVEMENT nobody
// documented — and an accidental one is not a control.
ok('§J11-1 dormancy.js carries the same 9+4 mask',
  /a\.slice\(0,\s*9\)\s*\+\s*['"…]/.test(dormancySrc) && /a\.slice\(-4\)/.test(dormancySrc));

// THE INVARIANT. Every public LIST route that carries an address must pass it through
// maskAddr() before it reaches res.json(). These seven are the ones that did not before
// 2026-09-02; /api/pool/miners and /api/stratum/stats already did. If a new list route is
// added, add it here — the mask is worthless the moment any one of them leaks a full address.
const MASKED_LIST_ROUTES = [
  ['get', '/api/pool/blocks'],
  ['get', '/api/pool/top-block-finders'],
  ['get', '/api/pool/payments'],
  ['get', '/api/pool/donors'],
  ['get', '/api/pool/miners'],
  ['get', '/api/stratum/stats'],
  ['get', '/api/stratum/hashrate'],
  ['get', '/api/stratum/top-miners'],
  ['get', '/api/stratum/top-avg-hashrate'],
];
for (const [verb, p] of MASKED_LIST_ROUTES) {
  const src = routeSrc(verb, p);
  // /api/stratum/stats masks inline (its own slice(0,9) copy) rather than calling maskAddr.
  const masks = /maskAddr\(/.test(src) || /slice\(0,\s*9\)/.test(src);
  ok(`§J11-1 ${p} masks the address before it is sent`, src.length > 0 && masks,
    src.length === 0 ? 'route not found — did it move?' : 'no maskAddr() in the handler');
}

// The deep-link was the other half: it needed the FULL address to build the href, so every
// leaderboard row put one in the page even when the API masked. No public page may emit one.
const linkers = PUBLIC_PAGES.filter((n) => {
  const html = fs.readFileSync(path.join(WEB, 'public_html', n), 'utf8');
  return /account-settings\.html\?addr='\s*\+|account-settings\.html\?addr=" \+/.test(html);
});
ok('§J11-1 no public page builds an /account-settings.html?addr= link', linkers.length === 0,
  linkers.join(', '));

console.log('\n[4] §J11-2 — the on-chain kernel needs an ownership proof\n');

const paymentsRoute = routeSrc('get', '/api/pool/payments');
ok('§J11-2 the /api/pool/payments route exists', paymentsRoute.length > 0);
ok('§J11-2 /api/pool/payments does NOT select kernel_excess',
  !/SELECT[\s\S]*kernel_excess[\s\S]*FROM withdrawals/i.test(paymentsRoute),
  'a pool-wide address+kernel pair is a public chain-analysis index');

const withdrawalsRoute = routeSrc('get', '/api/account/:addr/withdrawals');
// Testing that `has_kernel_proof` is PRESENT is not the same as testing that the kernel is
// ABSENT — a mutation that added `kernel_excess` back to the response object passed such a
// check, because the string still appeared elsewhere in the route. So assert the absence
// directly: outside the SQL and the comments, every mention of `kernel_excess` in this handler
// must be one of the three that cannot leak it — the destructure that drops it, the `!!`
// coercion for the JSON flag, and the yes/no coercion for the CSV column. A bare
// `{ ...rest, kernel_excess }`, a `kernel_excess: r.kernel_excess`, or an `esc(r.kernel_excess)`
// all raise the count above the allowance and fail here.
const wJs = withdrawalsRoute.replace(/`[\s\S]*?`/g, '').replace(/\/\/[^\n]*/g, '');
const kernelMentions = (wJs.match(/kernel_excess/g) || []).length;
const kernelAllowed =
  (wJs.match(/const \{\s*kernel_excess,\s*\.\.\.rest\s*\}/g) || []).length +
  (wJs.match(/!!kernel_excess/g) || []).length +
  (wJs.match(/r\.kernel_excess \? 'yes' : 'no'/g) || []).length;
ok('§J11-2 the per-address withdrawals GET never puts the kernel in a response',
  kernelMentions > 0 && kernelMentions === kernelAllowed,
  `${kernelMentions} mention(s), ${kernelAllowed} of them provably non-leaking`);
ok('§J11-2 its JSON row carries the boolean instead', /has_kernel_proof: !!kernel_excess/.test(wJs));
ok('§J11-2 its CSV header says has_kernel_proof, not kernel_excess',
  /has_kernel_proof'\]/.test(withdrawalsRoute) && !/,kernel_excess'\]/.test(withdrawalsRoute));

const proofsRoute = routeSrc('post', '/api/account/:addr/withdrawals/proofs');
ok('§J11-2 an ownership-gated proofs route exists', proofsRoute.length > 0);
ok('§J11-2 it calls verifyOwnerProof and audits both paths',
  /verifyOwnerProof\(/.test(proofsRoute) &&
  (proofsRoute.match(/auditOwnerProof\(/g) || []).length >= 2);
// §F2's lesson: verifyOwnerProof runs scrypt (16 MB), so a proof endpoint on the loose
// `public` bucket (1200/min) is a CPU exhaustion lever, not a read.
ok('§J11-2 the proofs route is on the `withdraw` bucket, not `public`',
  /rateLimiter\.middleware\('withdraw'\)/.test(proofsRoute) &&
  !/rateLimiter\.middleware\('public'\)/.test(proofsRoute));

console.log('\n[5] §J11-6 / §J11-7 — header suppression and the NaN-safe window parsers\n');

ok("§J11-6 app.disable('x-powered-by') is called",
  /app\.disable\(\s*['"]x-powered-by['"]\s*\)/.test(indexSrc));

// The failing form, reproduced: `||` binds before parseInt, so junk survives it and NaN then
// propagates through both clamps (Math.min/Math.max do not sanitise — see §J7-4).
const bad = (v, d, lo, hi) => Math.min(Math.max(parseInt(v || d), lo), hi);
const good = (v, d, lo, hi) => Math.min(Math.max(parseInt(v, 10) || d, lo), hi);
ok('§J11-7 the OLD form yields NaN on a non-numeric value',
  Number.isNaN(bad('abc', 24, 1, 720)));
ok('§J11-7 the fixed form falls back to the default', good('abc', 24, 1, 720) === 24);
ok('§J11-7 the fixed form still clamps a real value', good('9999', 24, 1, 720) === 720);
// The defect is not `parseInt(req.query.x || N)` on its own — it is that form with NO trailing
// `|| N` to catch the NaN. `Math.min(parseInt(req.query.days || 30, 10) || 30, 3650)` is safe;
// `Math.min(Math.max(parseInt(req.query.hours || 24), 1), 720)` is not. Match the inner form,
// then require a default immediately after it.
const INNER = /parseInt\(\s*req\.query\.\w+\s*\|\|[^)]*\)/g;
const undefended = [];
let m;
while ((m = INNER.exec(indexSrc)) !== null) {
  const after = indexSrc.slice(m.index + m[0].length, m.index + m[0].length + 8);
  // `parseInt(req.query.days || 0)` at :3564 is the documented exception: NaN > 0 is false, so
  // it falls through to "all history", which IS the intended default. Anything else needs a
  // `|| N` guard, or the NaN reaches a clamp and propagates (§J7-4, §J11-7).
  if (!/^\s*\|\|/.test(after) && !/req\.query\.days\s*\|\|\s*0\s*\)$/.test(m[0])) {
    undefended.push(m[0]);
  }
}
ok('§J11-7 every `parseInt(req.query.x || N)` site carries a NaN default',
  undefended.length === 0, undefended.join(' · '));

console.log('\n[6] §J11-3 — the account dossier is not offered to crawlers\n');

const acctHtml = fs.readFileSync(path.join(WEB, 'public_html/account-settings.html'), 'utf8');
const robotsTag = /<meta\s+name=["']robots["']\s+content=["']([^"']+)["']/i.exec(acctHtml);
ok('§J11-3 account-settings.html declares a robots meta', !!robotsTag);
ok('§J11-3 …and it is noindex', !!robotsTag && /noindex/i.test(robotsTag[1]),
  robotsTag ? robotsTag[1] : 'absent');
// `follow` on purpose — it is INDEXING this URL that leaks the address, not its outbound links.
ok('§J11-3 …and still follow (the shell nav stays crawlable)',
  !!robotsTag && /(?<!no)follow/i.test(robotsTag[1]), robotsTag ? robotsTag[1] : 'absent');
// CONTROL: robots.txt must stay permissive, or the crawler never reads the noindex above and
// the URL gets indexed anyway, URL-only.
ok('CONTROL: robots.txt is not disallowing the site by default',
  /body \+= noindex \? 'Disallow: \/\\n' : 'Disallow:\\n'/.test(indexSrc));

console.log('\n[7] §J11-5 — the k-anonymity floor reaches the REGION breakdown\n');

const regionsRoute = routeSrc('get', '/api/pool/stats/regions');
ok('§J11-5 /api/pool/stats/regions applies minBucket()', /minBucket\(\)/.test(regionsRoute));
ok('§J11-5 …suppressing to null, not 0', /r\.miners = null/.test(regionsRoute),
  'a withheld count rendered as 0 is §J5-4 in reverse');
ok('§J11-5 …and hashrate with it (one miner\'s count IS one miner\'s rig)',
  /r\.hashrate_gps = null/.test(regionsRoute));
ok('§J11-5 …only above 0 (a real zero stays zero)',
  /r\.miners > 0 && r\.miners < kMinRegions/.test(regionsRoute));
ok('§J11-5 …and never on a single-region pool',
  /out\.length > 1/.test(regionsRoute));

const regionHistRoute = routeSrc('get', '/api/pool/metrics/history/regions');
ok('§J11-5 the durable region series applies the same floor per point',
  /minBucket\(\)/.test(regionHistRoute) &&
  /p\.miner_count > 0 && p\.miner_count < kMinRegions/.test(regionHistRoute),
  '?range=all would otherwise keep yesterday\'s thin-region counts public forever');

// The render half. Chart.js draws null as a gap; `Number(null) || 0` would have drawn a
// suppressed point as a measured zero.
ok('§J11-5 the chart helper preserves a null datum instead of coercing it to 0',
  /p\.v === null \|\| p\.v === undefined\) \? null/.test(chartsSrc));
const reactorSrc = fs.readFileSync(path.join(WEB, 'public_html/js/reactor-dashboard.js'), 'utf8');
ok('§J11-5 the gateway lamp renders a suppressed count as "<N", not "idle"',
  /below_floor \?/.test(reactorSrc));

console.log('\n[8] §J11-8 — the IP/geo privacy controls hold at the WRITE side\n');

ok('§J11-8 coarsenIp masks IPv4 to /24',
  ownerProof.coarsenIp('203.0.113.42') === '203.0.113.0/24',
  ownerProof.coarsenIp('203.0.113.42'));
ok('§J11-8 coarsenIp masks IPv6 to /48',
  /^2001:0?db8:1234::\/48$/.test(String(ownerProof.coarsenIp('2001:db8:1234:5678::1'))),
  String(ownerProof.coarsenIp('2001:db8:1234:5678::1')));
ok('§J11-8 coarsenIp returns null for a non-IP rather than storing junk',
  ownerProof.coarsenIp('not-an-ip') === null);
ok('§J11-8 geoip never hands an IP back to a caller',
  (() => { const r = geoip.lookupCountry('8.8.8.8'); return r === null || (!('ip' in r) && Object.keys(r).sort().join(',') === 'cc,name'); })(),
  JSON.stringify(geoip.lookupCountry('8.8.8.8')));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
