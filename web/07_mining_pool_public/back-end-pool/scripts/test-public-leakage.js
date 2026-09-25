// Public-surface leakage regression tests — audit §J11 (public API leakage & privacy).
//
// Guards every §J11 fix, and pins the facts each one rests on so a later reader cannot
// "tidy" the evidence away:
//   §J11-1  The address mask keeps 9 leading + 4 trailing bech32 chars, which is a UNIQUE key:
//           a masked row re-attaches to its full address by joining against ANY feed that
//           publishes one. So it is only a control while no public LIST emits a full address —
//           the invariant asserted below across all seven feeds that used to. The four
//           independent copies of the mask must also stay in agreement.
//   §J11-2  /api/account/:addr/withdrawals (per-address, all-time, JSON + CSV) may not publish
//           kernel_excess. The kernel names a specific transaction in the Grin chain forever;
//           published beside a FULL address it is a public address-to-chain index. It comes
//           from an ownership-gated POST, on the `withdraw` bucket — never `public`, because
//           verifyOwnerProof runs scrypt (§F2).
//           The pool-wide /api/pool/payments feed DOES publish it since 2026-09-25 (operator
//           decision: payment-history.html P-05 Tx ID column). What is pinned there instead is
//           the two conditions that decision rests on — the address beside it is masked (§J11-1
//           list below) and only a shape-checked 66-hex value is emitted.
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
//   §17.4   Ownership proofs (design §17): NOTHING that reaches a browser may carry a proof
//           hash, the per-address `proof_salt`, or a per-row capture time. The public account
//           summary emits `proofs` as COUNTS ONLY, and the admin miner view — which §C3's
//           unrevocable access token makes a near-public surface — emits counts and set-level
//           timestamps. Both routes SELECT an explicit column list; the SELECT is the control,
//           because both spread their row into the response.
//   §16.10  Donor names (design §16, reworked by §18.9): /api/pool/donors and /api/account/:addr
//   §18.9   may emit a donor's APPROVED `name` and its state — never a pending name, image
//           bytes, a decider, or anything from the six v1 donor_* columns (unread since §18
//           Part 3, when the censor + marker machinery was deleted). Every route that touches
//           donor_requests is enumerated and pinned: the public ones use only the public-safe
//           readers, the admin readers sit behind secureAdmin/freshAdmin. The address on the
//           wall stays masked; the mask is a REQUIRED argument of the lib builder. A card's
//           approved `banner` is built only under the Top-N slot guard (§18 Part 4), and
//           donate.html keeps its own exact-shape fence on the banner URL.
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
const donorLedgerSrc = fs.readFileSync(path.join(APP, 'lib/donor-ledger.js'), 'utf8');
const donorNamesSrc = fs.readFileSync(path.join(APP, 'lib/donor-names.js'), 'utf8');
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

// One API_DOC_META row's source line, by its `'VERB /path':` key (line-anchored, like §1b).
function routeMeta(key) {
  const lines = indexSrc.split('\n');
  const hit = lines.find((l) => l.trimStart().startsWith(`'${key}':`));
  return hit || '';
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

console.log('\n[4] §J11-2 — the per-address kernel needs an ownership proof; the pool-wide one is shape-gated\n');

const paymentsRoute = routeSrc('get', '/api/pool/payments');
ok('§J11-2 the /api/pool/payments route exists', paymentsRoute.length > 0);
// Published by operator decision (2026-09-25). The SELECT reads the raw column, so the response
// must overwrite it: `...p` alone would ship whatever the wallet log or a manual record stored.
ok('§J11-2 /api/pool/payments overwrites kernel_excess with the shape-checked value',
  /kernel_excess: kernel\b/.test(paymentsRoute) &&
  /KERNEL_EXCESS_RE\.test\(p\.kernel_excess\)/.test(paymentsRoute));
const kRe = (indexSrc.match(/const KERNEL_EXCESS_RE = (\/[^\n]+\/[a-z]*);/) || [])[1];
ok('§J11-2 KERNEL_EXCESS_RE is an anchored 66-hex pattern', kRe === '/^[0-9a-f]{66}$/i', `got ${kRe}`);
ok('§J11-2 /api/pool/payments still masks the address it pairs the kernel with',
  /grin_address: maskAddr\(p\.grin_address\)/.test(paymentsRoute));
ok('§J11-2 /api/pool/payments sends has_kernel_proof as a boolean',
  /has_kernel_proof: !!p\.kernel_excess/.test(paymentsRoute));

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

// The signed payment proof (§H6) names the miner's address AND the kernel in one signed
// document, so it is at least as linking as the kernel and gets the identical treatment:
// the per-address GET may only drop it or coerce it to a boolean; the value travels only on
// the ownership-gated POST; and that POST must not reach for the wallet (a per-address list of
// hundreds of payouts must never become a wallet-load lever).
const ppMentions = (wJs.match(/(?<![\w])payment_proof\b/g) || []).length; // not has_payment_proof
const ppAllowed =
  (wJs.match(/const \{\s*payment_proof,\s*\.\.\.pub\s*\}/g) || []).length +
  (wJs.match(/!!payment_proof/g) || []).length;
ok('§H6 the per-address withdrawals GET never puts the signed proof in a response',
  ppMentions > 0 && ppMentions === ppAllowed,
  `${ppMentions} mention(s), ${ppAllowed} of them provably non-leaking`);
ok('§H6 its JSON row carries has_payment_proof instead', /has_payment_proof: !!payment_proof/.test(wJs));
ok('§H6 the gated proofs route is the one that emits payment_proofs',
  /payment_proofs\[r\.id\] = JSON\.parse\(r\.payment_proof\)/.test(proofsRoute));
ok('§H6 the gated proofs route reads the DB only — no wallet call in the request path',
  !/wallet\./.test(proofsRoute.replace(/\/\/[^\n]*/g, '')) && !/withdrawalScheduler\./.test(proofsRoute));
const adminWdList = routeSrc('get', '/api/admin/withdrawals');
ok('§H6 the admin withdrawals list strips the blob to a flag (SELECT * would carry it)',
  /const \{\s*payment_proof,\s*\.\.\.rest\s*\}/.test(adminWdList) && /has_payment_proof: !!payment_proof/.test(adminWdList));
const adminProofRoute = routeSrc('get', '/api/admin/withdrawals/:id/payment-proof');
ok('§H6 the admin per-row proof route exists and is admin-authenticated',
  adminProofRoute.length > 0 && /secureAdmin/.test(adminProofRoute));
ok('§H6 it resolves the slate from OUR row by id — the request never names a slate or address',
  /req\.params\.id/.test(adminProofRoute) && !/req\.(query|body)\.(slate|slate_id|address|addr)/.test(adminProofRoute));

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


console.log('\n[9] §16.10 / §18.9 — donor names: only the APPROVED `name` + `name_state` leave the public routes\n');

// The wall. The response is built in lib/donor-ledger.js donorWall() (index.js cannot be
// required, so the behavioural sweep — 102 donors, every non-approved profile state — lives in
// scripts/test-donor-league.js). Here: the route hands the lib the mask and nothing it must not,
// and the lib's card builder cannot emit a donor_* column by construction.
const donorsRoute = routeSrc('get', '/api/pool/donors');
const donorsJs = donorsRoute.replace(/\/\/[^\n]*/g, '');
ok('§16.10 /api/pool/donors delegates to donorWall() with the mask as an argument',
  /donorWall\(db,\s*\{[\s\S]*?mask:\s*\(a\)\s*=>\s*maskAddr\(a\)/.test(donorsJs));
ok('§16.10 /api/pool/donors reads no donor_* column itself (the lib does, and never emits it)',
  !/donor_censor|donor_name|balance_log/.test(donorsJs),
  'the route used to carry the ledger SQL inline; the v2 shape is the lib\'s');
// Since design §18.3 the count lives in lib/donor-ledger.js liveDonations() (shared with the
// account page + admin list), so the bar is asserted THERE and the route must go through it.
const liveFn = donorLedgerSrc.slice(donorLedgerSrc.indexOf('function liveDonations('),
                                    donorLedgerSrc.indexOf('const NO_LIVE'));
ok('§16.10 /api/pool/donors counts rigs from MINING sessions only (acceptedShares > 0, §J6-9)',
  /donorLiveDonations\(minerManager \? minerManager\.getActiveSessions\(\) : \[\]\)/.test(donorsJs) &&
  /live,/.test(donorsJs) && /acceptedShares > 0/.test(liveFn.replace(/\/\/[^\n]*/g, '')),
  'a login is unauthenticated — without the share bar anyone can put rigs on someone else\'s card');

const wallFn = donorLedgerSrc.slice(donorLedgerSrc.indexOf('function donorWall('),
                                    donorLedgerSrc.indexOf('module.exports'));
ok('§18.3 the wall never reads the dead v1 donation_percent column',
  !/donation_percent/.test(wallFn.replace(/\/\/[^\n]*/g, '')) && !/donation_percent/.test(donorsJs));
ok('§16.10 donorWall THROWS when no mask function is passed (fail closed)',
  /typeof opts\.mask !== 'function'\)\s*throw/.test(wallFn));
const cardBlock = (() => {
  const a = wallFn.indexOf('const card = (r, rank) => {');
  const b = wallFn.indexOf('\n  };', a);
  return a < 0 || b < 0 ? '' : wallFn.slice(a, b);
})();
// `rank,` is shorthand — a key is followed by `:` OR `,`.
const cardKeys = [...cardBlock.replace(/\/\/[^\n]*/g, '').matchAll(/^\s{6}([a-z_]+)[:,]/gm)].map((m) => m[1]);
ok('§16.10 the card builder was found', cardBlock.length > 0 && cardKeys.length >= 14, `${cardKeys.length} keys`);
ok('§16.10 no card key starts with donor_ (word / by / at / raw censor state stay admin-side)',
  cardKeys.length > 0 && !cardKeys.some((k) => /^donor_/.test(k)), cardKeys.join(','));
ok('§16.10 the card address goes through the mask, and only the mask',
  /address:\s*opts\.mask\(r\.address\)/.test(cardBlock) && !/address:\s*r\.address/.test(cardBlock));
// Names (design §18.7, since §18 Part 3): the card's name comes from publicProfiles() — the
// APPROVED, unexpired donor_requests row, nothing else. The v1 displayState/censor/marker
// machinery is deleted, and the lib must not read the v1 donor_* columns for the wall.
ok('§18.7 name + name_state come from publicProfiles (approved rows only), not a v1 column',
  /publicProfiles\(db,/.test(wallFn) && /name:\s*st\.name,/.test(cardBlock) && /name_state:\s*st\.name_state/.test(cardBlock));
// Banners (design §18.7/§18.9, §18 Part 4). Behaviour (rank N has one, N+1 and the past strip
// never, slots 0 = none, non-approved rows never) is swept in scripts/test-donor-league.js;
// here, the card builder's guard itself: the banner is built only under the slot test, the
// slot count is the bounded helper's, and past cards reach the builder with rank null.
const cardJs = cardBlock.replace(/\/\/[^\n]*/g, '');
ok('§18.9 the card banner exists only under inSlot (a safe-integer rank ≥ 1 and ≤ slots)',
  /const inSlot = Number\.isSafeInteger\(rank\) && rank >= 1 && rank <= slots;/.test(cardJs) &&
  /const banner = inSlot && b && /.test(cardJs) && /^\s{6}banner,/m.test(cardJs));
ok('§18.9 slots come from donor-profiles bannerSlots() (bounded 0–10), past cards get rank null',
  /const slots = bannerSlots\(ds\);/.test(wallFn) && /past\.map\(\(r\) => card\(r, null\)\)/.test(wallFn));
ok('§18.7 current_percent is gone from the card (Part 4 drops the v1 alias of pct_max)',
  !/current_percent/.test(cardJs));

// The page. donate.html is the wall's only renderer: no v1 copy may survive the §18.7
// rewrite, it must not read the dropped field, and it keeps its own fence on the banner URL.
const donateHtml = fs.readFileSync(path.join(WEB, 'public_html/donate.html'), 'utf8');
ok('§18.7 donate.html carries no v1 copy (yourbrandname / ceremony / donate0-first / censored)',
  !/yourbrandname|ceremony|go through <code>donate0|censored/i.test(donateHtml));
ok('§18.7 donate.html no longer reads current_percent', !/current_percent/.test(donateHtml));
ok('§18.9 donate.html renders a banner only through bannerOf() and its exact-shape URL regex',
  donateHtml.includes('var BANNER_URL_RE = /^\\/uploads\\/donors\\/[0-9a-f]{16}\\.(png|jpg|gif)$/;') &&
  /var b = bannerOf\(d\);/.test(donateHtml) &&
  (donateHtml.match(/<img /g) || []).length === 1 && /<img src="' \+ escHtml\(b\.url\) \+/.test(donateHtml));
ok('§18.9 donate.html escapes every name it renders (nameCell + the banner alt)',
  /'<span class="donor-name">' \+ escHtml\(d\.name\)/.test(donateHtml) && /alt="' \+ escHtml\(alt\)/.test(donateHtml));

ok('§18.7 the wall reads no v1 donor_* column and no miner_incentives row at all',
  !/donor_name|donor_censor|miner_incentives/.test(wallFn.replace(/\/\/[^\n]*/g, '')));
ok('§18.6 the censored marker is gone from every source (lib, index incl. api-docs, donor-names)',
  !/censored-donor|CENSORED_MARKER|censored_display/.test(donorLedgerSrc.replace(/\/\/[^\n]*/g, '')) &&
  !/censored-donor|CENSORED_MARKER|censored_display|donorDisplayState/.test(indexSrc.replace(/\/\/[^\n]*/g, '')) &&
  !/censored-donor|CENSORED_MARKER|displayState/.test(donorNamesSrc.replace(/\/\/[^\n]*/g, '')));
ok('§18.7 the api-docs row says names are APPROVED and addresses MASKED',
  /APPROVED/.test(routeMeta('GET /api/pool/donors')) && /MASKED/.test(routeMeta('GET /api/pool/donors')));

// The two public readers in lib/donor-profiles.js. publicProfiles selects APPROVED rows only;
// profileFor's column list never names `image`, and it reads `name` only through the
// CASE WHEN status = 'approved' expression — the pending text cannot come back from either.
const profilesSrc = fs.readFileSync(path.join(APP, 'lib/donor-profiles.js'), 'utf8');
const fnSrc = (name) => {
  const a = profilesSrc.indexOf(`function ${name}(`);
  return a < 0 ? '' : profilesSrc.slice(a, profilesSrc.indexOf('\nfunction ', a + 1)).replace(/\/\/[^\n]*/g, '');
};
const readCols = (profilesSrc.match(/const READ_COLS = '([^']*)'/) || [])[1] || '';
ok('§18.9 publicProfiles selects status = approved only, and never `image`',
  /WHERE status = 'approved'/.test(fnSrc('publicProfiles')) && !/\bimage\b/.test(fnSrc('publicProfiles')));
ok('§18.9 profileFor reads READ_COLS (no image, no name) + the name of APPROVED rows only',
  readCols !== '' && !/\bimage\b|\bname\b/.test(readCols) &&
  /CASE WHEN status = 'approved' THEN name END AS live_name/.test(fnSrc('profileFor')) &&
  !/\bimage\b/.test(fnSrc('profileFor')));

// Every route that touches donor_requests, directly (SQL) or through the profile/wall libs,
// enumerated from the route declarations. A public route on this list reads only the
// public-safe readers (profileFor / publicProfiles via donorWall) or the donor's own writes; the
// admin readers (adminQueue, requestImage, adminProfiles — full addresses, pending text, bytes)
// may appear under /api/admin/ only, behind secureAdmin/freshAdmin. A NEW public route here
// fails this test on purpose: read what it emits (§18.9), then add it.
const routeDecls = [...indexSrc.matchAll(/\n\s{2}app\.(get|post|put|delete|patch)\('([^']+)',\s*([A-Za-z]+)?/g)]
  .map((m) => ({ verb: m[1], path: m[2], guard: m[3] || '' }));
// The handler only: routeSrc runs to the NEXT app.* call, so a route followed by a block of
// shared setup (the donor-profile multer config follows the Goblin DELETE) would otherwise be
// charged with that setup. Cut at the handler's own closing `  });` (2-space indent).
const handlerSrc = (verb, p) => {
  const s = routeSrc(verb, p);
  const e = s.indexOf('\n  });');
  return (e < 0 ? s : s.slice(0, e)).replace(/\/\/[^\n]*/g, '');
};
const touching = routeDecls.filter((r) => /donor_requests|DonorProfiles\.|donorWall\(/.test(handlerSrc(r.verb, r.path)));
const ADMIN_READERS = /DonorProfiles\.(adminQueue|requestImage|adminProfiles)\(/;
const publicTouching = touching.filter((r) => !r.path.startsWith('/api/admin/'))
  .map((r) => `${r.verb.toUpperCase()} ${r.path}`).sort();
ok('§18.9 the public routes that touch donor_requests are exactly the reviewed five',
  publicTouching.join(' | ') === [
    'DELETE /api/account/:addr/donor-profile/:kind',
    'GET /api/account/:addr',
    'GET /api/pool/donors',
    'POST /api/account/:addr/donor-profile/banner',
    'POST /api/account/:addr/donor-profile/name'
  ].join(' | '), publicTouching.join(' | '));
ok('§18.9 no public route calls an admin reader (adminQueue / requestImage / adminProfiles)',
  touching.filter((r) => !r.path.startsWith('/api/admin/'))
    .every((r) => !ADMIN_READERS.test(handlerSrc(r.verb, r.path))));
ok('§18.9 every admin route that touches donor_requests is secureAdmin or freshAdmin',
  touching.filter((r) => r.path.startsWith('/api/admin/')).length >= 8 &&
  touching.filter((r) => r.path.startsWith('/api/admin/')).every((r) => r.guard === 'secureAdmin' || r.guard === 'freshAdmin'),
  touching.filter((r) => r.path.startsWith('/api/admin/')).map((r) => `${r.path}:${r.guard}`).join(', '));

// The miner's own view. The account route reads no v1 column, and since §18 Part 5 it no
// longer sends the v1 aliases either: `donation_percent` (= pct_max) and the donor_name /
// donor_name_state pair (derived from donor_profile) went once the page read `donation` and
// `donor_profile` directly (§18.3 "then dropped").
const acctRoute = routeSrc('get', '/api/account/:addr');
const acctJs = acctRoute.replace(/\/\/[^\n]*/g, '');
ok('§18.7 /api/account/:addr reads no v1 donor_* column',
  !/SELECT[^`]*donor_(name|censor)[^`]*FROM miner_incentives/.test(acctJs) && !/donor_censor/.test(acctJs));
ok('§18.3 /api/account/:addr sends donation + donor_profile (profileFor), and none of the v1 aliases',
  /donation:\s*donation,/.test(acctJs) && /donor_profile:\s*donorProfile,/.test(acctJs) &&
  /DonorProfiles\.profileFor\(db,/.test(acctJs) &&
  !/donation_percent|donor_name_state|donor_name:/.test(acctJs));
ok('§18.3 the account api-docs row no longer documents the dropped aliases',
  !/donation_percent|donor_name_state/.test(routeMeta('GET /api/account/:addr')));

// The page (design §18.8, §18 Part 5). account-settings.html renders the donor's own view:
// no v1 copy, no dropped alias read, a live banner only through the exact-shape URL fence,
// previews from data: URLs (the public CSP's img-src has no blob:), and the two proof boxes
// cleared after every change that went through.
const acctHtml5 = fs.readFileSync(path.join(WEB, 'public_html/account-settings.html'), 'utf8');
const acctPageJs = acctHtml5.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
ok('§18.8 account-settings.html carries no v1 donation copy (ceremony / yourbrand / donate0-first / censored)',
  !/yourbrand|ceremony|go through donate0|donate0 first|censored/i.test(acctPageJs));
ok('§18.8 account-settings.html reads no dropped alias (donation_percent / donor_name / donor_name_state)',
  !/donation_percent|donor_name/.test(acctPageJs));
ok('§18.9 the page shows a live banner only through DP_BANNER_URL_RE, the server\'s exact file shape',
  acctHtml5.includes('const DP_BANNER_URL_RE = /^\\/uploads\\/donors\\/[0-9a-f]{16}\\.(png|jpg|gif)$/;') &&
  /DP_BANNER_URL_RE\.test\(b\.live_url\)/.test(acctPageJs));
ok('§18.8 banner previews are data: URLs — createObjectURL appears only in the proof-file download',
  /readAsDataURL/.test(acctPageJs) && (acctPageJs.match(/createObjectURL/g) || []).length === 1 &&
  /function downloadPaymentProof[\s\S]*?createObjectURL/.test(acctPageJs));
ok('§18.8 every donor-profile success clears both proof boxes (name, banner, delete)',
  (acctPageJs.match(/dpClearProofs\(\);/g) || []).length === 3 &&
  /function dpClearProofs\(\) \{ \$id\('dp-ip-proof'\)\.value = ''; \$id\('dp-pass-proof'\)\.value = ''; \}/.test(acctPageJs));
ok('§18.6 the page never reads a pending name or image from the API (only its own POST response)',
  !/pending_name|pending_image|\.pending\.name|name\.pending\b/.test(acctPageJs) &&
  /text: String\(json\.name \|\| v\.name\)/.test(acctPageJs));

// ── §17.4 — the ownership-proof set must never reach a browser ───────────────────────────
const acctProofJs = routeSrc('get', '/api/account/:addr').replace(/\/\/[^\n]*/g, '');
const adminMinerJs = routeSrc('get', '/api/admin/miners/:addr').replace(/\/\/[^\n]*/g, '');

ok('§17.4 /api/account/:addr never selects proof_salt or any legacy proof column',
  !/proof_salt/.test(acctProofJs) &&
  !/\b(last_ip|prev_ip|anchor_ip|last_pass_hash|prev_pass_hash|anchor_pass_hash)\b/.test(acctProofJs));
ok('§17.4 /api/account/:addr never selects a proof HASH from miner_proofs',
  !/SELECT[^`]*\bhash\b[^`]*FROM miner_proofs/i.test(acctProofJs),
  'the summary reads counts and MAX(first_seen_at) only');
ok('§17.4 the public `proofs` object is counts, the cap, a boolean and one timestamp',
  /ip:\s*ipSet\.live/.test(acctProofJs) && /pass:\s*passSet\.live/.test(acctProofJs) &&
  /max:\s*PROOF_SET_MAX/.test(acctProofJs) && /anchor:\s*!!\(/.test(acctProofJs) &&
  /last_added_at:/.test(acctProofJs));
ok('§17.4 the retired `evidence` object is gone from the summary',
  !/evidence:\s*\{/.test(acctProofJs),
  'it reported per-row capture times, which is the (address, origin, time) linkage hashing removes');
ok('§17.4 /api/admin/miners/:addr does not select proof_salt or a legacy proof column',
  !/proof_salt/.test(adminMinerJs) &&
  !/\b(last_ip|prev_ip|anchor_ip|last_pass_hash|prev_pass_hash|anchor_pass_hash)\b/.test(adminMinerJs));
ok('§17.4 the admin miner view still uses an explicit column list, not SELECT *',
  /SELECT id, grin_address, balance/.test(adminMinerJs) && !/SELECT \* FROM miner_accounts/.test(adminMinerJs),
  'audit §J8-2 — `...acct` spreads whatever the SELECT names');
ok('§17.4 the admin proof view is per-kind counts and set-level timestamps only',
  !/\bhash\b/.test(adminMinerJs.slice(adminMinerJs.indexOf('miner_proofs'))) &&
  /anchor_live/.test(adminMinerJs) && /oldest_first_seen/.test(adminMinerJs));
ok('§17.4 no CODE path in index.js touches proof_salt',
  !/proof_salt/.test(indexSrc.replace(/\/\/[^\n]*/g, '')),
  'the salt is minted and read inside lib/owner-proof.js and nowhere else');

// Every `${…}` interpolated into a console line in owner-proof.js, checked against the
// identifiers that HOLD a secret. A password or a digest in a service log is exactly the leak
// the hashing exists to prevent, and journald keeps it far longer than the row would.
const ownerProofSrc = fs.readFileSync(path.join(APP, 'lib/owner-proof.js'), 'utf8');
const loggedExprs = (ownerProofSrc.match(/console\.(?:warn|error|log)\(`[^`]*`/g) || [])
  .flatMap((l) => (l.match(/\$\{([^}]*)\}/g) || []).map((x) => x.slice(2, -1).trim()));
const SECRET_IDENT = /^(rawPass|pass|rawIp|ip|value|salt|v2|hash|row\.hash|e\.value)$/;
ok('§17.4 owner-proof.js interpolates no proof value, digest or salt into a log line',
  loggedExprs.length > 0 && loggedExprs.every((x) => !SECRET_IDENT.test(x)),
  `logged: ${loggedExprs.join(', ')}`);

// ─── F5 (Part 6): the step-by-step Tor send's two columns ─────────────────────────────────────
// withdrawals.tor_final_slate holds a complete signed transaction (kept only so the stale sweep can
// post it again); tor_step is operator state. Neither may reach any non-admin route, and the two
// admin routes that SELECT * FROM withdrawals and serve the rows must drop the slate.
console.log('\n[F5] stepwise columns stay off every public route');
{
  const routes = [...indexSrc.matchAll(/\bapp\.(get|post|put|delete|patch)\('([^']+)'/g)].map((m) => [m[1], m[2]]);
  const publicRoutes = routes.filter(([, p]) => !p.startsWith('/api/admin'));
  const leaks = publicRoutes.filter(([v, p]) => /tor_final_slate|tor_step/.test(routeSrc(v, p)));
  ok('no non-admin route mentions tor_final_slate or tor_step', publicRoutes.length > 20 && leaks.length === 0,
    leaks.map(([v, p]) => `${v} ${p}`).join(', '));
  const starSelect = publicRoutes.filter(([v, p]) =>
    /SELECT\s+(?:w\.)?\*\s+FROM\s+withdrawals/i.test(routeSrc(v, p).replace(/\/\/[^\n]*/g, '')));
  ok('no non-admin route does SELECT * FROM withdrawals (the columns would ride along)', starSelect.length === 0,
    starSelect.map(([v, p]) => `${v} ${p}`).join(', '));
  const adminList = routeSrc('get', '/api/admin/withdrawals');
  ok('GET /api/admin/withdrawals drops tor_final_slate from every row', /delete rest\.tor_final_slate;/.test(adminList));
  const adminMiner = routeSrc('get', '/api/admin/miners/:addr');
  ok('GET /api/admin/miners/:addr drops tor_final_slate from pending_withdrawals',
    /\.map\(\(\{ tor_final_slate, (?:[a-z_0-9]+, )*\.\.\.rest \}\) => rest\)/.test(adminMiner));
  ok('every admin route that serves SELECT * FROM withdrawals rows is one of those two',
    routes.filter(([v, p]) => p.startsWith('/api/admin') &&
      /SELECT \* FROM withdrawals WHERE (status|grin_address)/.test(routeSrc(v, p)))
      .every(([v, p]) => (v === 'get' && (p === '/api/admin/withdrawals' || p === '/api/admin/miners/:addr'))));
}

// ─── Stored manual-rail S1 (2026-09-25) ───────────────────────────────────────────────────────
// withdrawals.slatepack_s1 is served by exactly ONE route: the owner's ownership-gated re-fetch,
// narrowed in its SQL to their own pending manual-rail payout. Encrypted to the owner, so a leak
// would not steal — but a Goblin row must never carry one (plain armor), and a second route
// serving it would quietly drop the proof gate the payout surface is built on.
console.log('\n[S1] the stored slatepack is served by one gated route only');
{
  const RESHOW = ['post', '/api/account/:addr/withdraw/:id/slatepack'];
  const routes = [...indexSrc.matchAll(/\bapp\.(get|post|put|delete|patch)\('([^']+)'/g)].map((m) => [m[1], m[2]]);
  const mentions = routes.filter(([v, p]) => /slatepack_s1/.test(routeSrc(v, p).replace(/\/\/[^\n]*/g, '')));
  ok('only the re-fetch route reads slatepack_s1 (admin routes only strip it)',
    mentions.every(([v, p]) => (v === RESHOW[0] && p === RESHOW[1]) ||
      (v === 'get' && (p === '/api/admin/withdrawals' || p === '/api/admin/miners/:addr'))) &&
    mentions.some(([v, p]) => v === RESHOW[0] && p === RESHOW[1]),
    mentions.map(([v, p]) => `${v} ${p}`).join(', '));
  const src = routeSrc(...RESHOW).replace(/\/\/[^\n]*/g, '');
  const proofAt = src.indexOf('verifyOwnerProof(');
  const selectAt = src.indexOf('slatepack_s1 FROM withdrawals');
  ok('re-fetch: the ownership proof is checked BEFORE the row is read', proofAt > 0 && selectAt > proofAt && /if \(!proof\.ok\)/.test(src));
  ok('re-fetch: the SELECT is narrowed to this address, the manual rail and a still-pending row',
    /WHERE id = \? AND grin_address = \? AND method = 'slatepack' AND status = 'slatepack_pending'/.test(src));
  ok('re-fetch: rate-limited on the withdraw bucket, answered no-store',
    /rateLimiter\.middleware\('withdraw'\)/.test(src) && /Cache-Control', 'no-store'/.test(src));
  ok('GET /api/admin/withdrawals drops slatepack_s1', /delete rest\.slatepack_s1;/.test(routeSrc('get', '/api/admin/withdrawals')));
  ok('GET /api/admin/miners/:addr drops slatepack_s1',
    /\(\{ tor_final_slate, slatepack_s1, \.\.\.rest \}\) => rest/.test(routeSrc('get', '/api/admin/miners/:addr')));
  const sched = fs.readFileSync(path.join(APP, 'lib/withdrawal-scheduler.js'), 'utf8');
  const nostrCreate = sched.slice(sched.indexOf('async createNostrWithdrawal('), sched.indexOf('async finalizeNostrWithdrawal('));
  ok('the Goblin rail (plain-armor S1) never writes slatepack_s1', nostrCreate.length > 500 && !/slatepack_s1/.test(nostrCreate));
  const pageSync = acctPageJs.slice(acctPageJs.indexOf('function spSyncPending('), acctPageJs.indexOf('function spClear('));
  ok('the page restores a pending payout only for the manual rail',
    /p\.status === 'slatepack_pending' && p\.method === 'slatepack'/.test(pageSync));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
