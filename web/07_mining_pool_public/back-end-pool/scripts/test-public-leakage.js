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
//   §17.4   Ownership proofs (design §17): NOTHING that reaches a browser may carry a proof
//           hash, the per-address `proof_salt`, or a per-row capture time. The public account
//           summary emits `proofs` as COUNTS ONLY, and the admin miner view — which §C3's
//           unrevocable access token makes a near-public surface — emits counts and set-level
//           timestamps. Both routes SELECT an explicit column list; the SELECT is the control,
//           because both spread their row into the response.
//   §16.10  Donor names (design §16): /api/pool/donors and /api/account/:addr may emit a
//           donor's opt-in `name` and its state, and NOTHING else from the six donor_*
//           columns — never the censor word, the censoring admin, or the raw censor state —
//           and the censored MARKER string only when the operator chose `marker`. The address
//           on the wall stays masked; the mask is a REQUIRED argument of the lib builder.
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
const donorNames = require(path.join(APP, 'lib/donor-names.js'));

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


console.log('\n[9] §16.10 — donor names: only `name` + `name_state` leave the public routes\n');

// The wall. The response is built in lib/donor-ledger.js donorWall() (index.js cannot be
// required, so the behavioural sweep — 102 donors, censored rows, both display modes — lives in
// scripts/test-donor-league.js). Here: the route hands the lib the mask and nothing it must not,
// and the lib's card builder cannot emit a donor_* column by construction.
const donorsRoute = routeSrc('get', '/api/pool/donors');
const donorsJs = donorsRoute.replace(/\/\/[^\n]*/g, '');
ok('§16.10 /api/pool/donors delegates to donorWall() with the mask as an argument',
  /donorWall\(db,\s*\{[\s\S]*?mask:\s*\(a\)\s*=>\s*maskAddr\(a\)/.test(donorsJs));
ok('§16.10 /api/pool/donors reads no donor_* column itself (the lib does, and never emits it)',
  !/donor_censor|donor_name|balance_log/.test(donorsJs),
  'the route used to carry the ledger SQL inline; the v2 shape is the lib\'s');
ok('§16.10 /api/pool/donors counts rigs from MINING sessions only (acceptedShares > 0, §J6-9)',
  /acceptedShares > 0/.test(donorsJs) && /getActiveSessions\(\)/.test(donorsJs),
  'a login is unauthenticated — without the share bar anyone can put rigs on someone else\'s card');

const wallFn = donorLedgerSrc.slice(donorLedgerSrc.indexOf('function donorWall('),
                                    donorLedgerSrc.indexOf('module.exports'));
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
ok('§16.10 name + name_state come from displayState, the function the account API also uses',
  /displayState\(i,\s*\{/.test(cardBlock) && /name:\s*st\.name,/.test(cardBlock) && /name_state:\s*st\.name_state/.test(cardBlock));
ok('§16.10 the lib never reads donor_censor_word or donor_censor_by for the wall',
  !/donor_censor_word|donor_censor_by/.test(wallFn.replace(/\/\/[^\n]*/g, '')));
// index.js may SPELL the marker in one place only: the API_DOC_META row that documents it
// (a client must know the string can arrive). Outside that block, neither file references
// the string or the constant.
const indexNoMeta = (() => {
  const a = indexSrc.indexOf('const API_DOC_META = {');
  const b = indexSrc.indexOf('\n  };', a);
  return (indexSrc.slice(0, a) + indexSrc.slice(b)).replace(/\/\/[^\n]*/g, '');
})();
ok('§16.10 the lib never spells the censored marker itself — displayState is the one emitter',
  !/censored-donor|CENSORED_MARKER/.test(donorLedgerSrc.replace(/\/\/[^\n]*/g, '')) &&
  !/censored-donor|CENSORED_MARKER/.test(indexNoMeta));
ok('§16.10 the api-docs row documents the marker and the masking',
  /censored-donor/.test(routeMeta('GET /api/pool/donors')) && /MASKED/.test(routeMeta('GET /api/pool/donors')));
ok('§16.10 in lib/donor-names.js the marker is returned from displayState only',
  (donorNamesSrc.replace(/\/\/[^\n]*/g, '').match(/CENSORED_MARKER/g) || []).length === 3,
  'const, the displayState return, the export — a 4th mention is a new emitter to review');

// The miner's own view. The account route reads three donor columns for displayState and
// emits the two fields it returns; a response key named donor_censor* would be a new leak.
const acctRoute = routeSrc('get', '/api/account/:addr');
const acctJs = acctRoute.replace(/\/\/[^\n]*/g, '');
ok('§16.10 /api/account/:addr selects donor_name, donor_name_set_at, donor_censor and nothing more',
  /SELECT donor_name, donor_name_set_at, donor_censor FROM miner_incentives/.test(acctJs) &&
  !/donor_censor_word|donor_censor_by/.test(acctJs));
ok('§16.10 /api/account/:addr emits donor_name + donor_name_state via displayState only',
  /donorDisplayState\(row,/.test(acctJs) && /donor_name:\s*donor\.name,/.test(acctJs) &&
  /donor_name_state:\s*donor\.name_state/.test(acctJs) && !/donor_censor\s*:/.test(acctJs));

// displayState is the single emitter, so its contract IS the public contract — asserted live.
const censoredRow = { donor_name: 'sh1thead', donor_name_set_at: 1_800_000_000, donor_censor: 'auto' };
const adminRow = { donor_name: 'spam', donor_name_set_at: 1_800_000_000, donor_censor: 'admin' };
const shownRow = { donor_name: 'acme', donor_name_set_at: 1_800_000_000, donor_censor: null };
const now = 1_800_000_100;
const st = (row, censoredDisplay, extra = {}) =>
  donorNames.displayState(row, { now, expiryMonths: 12, censoredDisplay, lastDonatedAt: now - 10, ...extra });
ok("§16.10 displayState: censored + 'masked' → name null",
  st(censoredRow, 'masked').name === null && st(adminRow, 'masked').name === null &&
  st(censoredRow, 'masked').name_state === 'censored');
ok("§16.10 displayState: censored + 'marker' → the marker, and only then",
  st(censoredRow, 'marker').name === donorNames.CENSORED_MARKER && st(adminRow, 'marker').name === donorNames.CENSORED_MARKER);
ok('§16.10 displayState: an unknown display value is treated as masked, never as marker',
  st(censoredRow, 'MARKER').name === null && st(censoredRow, undefined).name === null && st(censoredRow, 'yes').name === null);
ok("§16.10 displayState: 'marker' never touches a shown, masked or expired card",
  st(shownRow, 'marker').name === 'acme' && st(null, 'marker').name === null &&
  st(shownRow, 'marker', { now: now + 400 * 86400 }).name === null &&
  st(shownRow, 'marker', { now: now + 400 * 86400 }).name_state === 'expired');
ok('§16.10 displayState never returns the censor word or any donor_ key',
  Object.keys(st(censoredRow, 'marker')).sort().join(',') === 'name,name_state' &&
  !JSON.stringify(st({ ...censoredRow, donor_censor_word: 'shit', donor_censor_by: 7 }, 'marker')).includes('shit'));

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

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
