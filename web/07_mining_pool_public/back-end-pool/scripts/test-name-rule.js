// test-name-rule.js — the pool's copy of the name rule v2 and the names.blocked_words setting
// (design §19.17.5, D28; games Part C3).
//
//   [1] the SHARED fixture (play/server/scripts/fixtures/name-rule.json) through THIS copy —
//       the games' test-names.js runs the same file through theirs (§19.13 #24)
//   [2] the two copies are the same code, line for line below their headers, and the seed holds
//       every word of the donor STARTER_BLOCKLIST it was built from
//   [3] the names.blocked_words validator: folded, prefixes kept, duplicates gone, bounded,
//       refusing what can never match; step-up; the admin page + nav
//
// The games files are READ AS TEXT here (allowed, as test-events.js does) — never required: the
// pool must not load games code, and the games must not load ours (D5).
// Run: node scripts/test-name-rule.js

'use strict';

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const GAMES_RULE = path.join(APP, '..', 'play', 'server', 'lib', 'name-rule.js');
const FIXTURE = path.join(APP, '..', 'play', 'server', 'scripts', 'fixtures', 'name-rule.json');
const R = require(path.join(APP, 'lib/name-rule.js'));
const PoolSettings = require(path.join(APP, 'lib/pool-settings.js'));
const { STARTER_BLOCKLIST } = require(path.join(APP, 'lib/donor-names.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return !re || re.test(e.message); } };

console.log('\n[1] the shared fixture through the pool copy');
{
  const exists = fs.existsSync(FIXTURE);
  ok('the fixture is where both suites read it', exists);
  const F = exists ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) : { cases: [], innocent: [], adversarial: [], contexts: {} };
  const ctxOf = (c = {}, shape) => ({ shape, poolName: c.pool_name, blocked: R.compileList(c.blocked), words: R.compileList(c.words) });
  const bad = [];
  for (const k of F.cases) {
    const r = R.check(k.name, ctxOf(F.contexts[k.ctx || 'default'], k.shape));
    const got = r.ok ? 'ok' : r.code;
    if (got !== k.expect || (k.list && r.list !== k.list)) bad.push(`${JSON.stringify(k.name)} → ${got}/${r.list}`);
  }
  ok(`every fixture case (${F.cases.length}) gives the same verdict as in the games`, F.cases.length >= 60 && bad.length === 0, bad.slice(0, 4).join('; '));
  const innocent = F.innocent.filter((n) => !R.check(n, ctxOf(F.contexts.default)).ok);
  ok(`every innocent name (${F.innocent.length}) passes`, F.innocent.length >= 30 && innocent.length === 0, innocent.join(', '));
  const adv = F.adversarial.filter((n) => R.check(n, ctxOf(F.contexts.default)).ok);
  ok(`every adversarial name (${F.adversarial.length}) is refused`, F.adversarial.length >= 30 && adv.length === 0, adv.join(', '));
  // Part C4 — the donor shape (§19.17.6): the same rule with §18.5's character set + §16.4's reserved words.
  const donorCtx = ctxOf(F.contexts.donor, 'donor');
  ok('the fixture carries donor-shape cases', F.cases.filter((k) => k.shape === 'donor').length >= 25);
  const dInn = (F.donor_innocent || []).filter((n) => !R.check(n, donorCtx).ok);
  ok(`every donor-shape innocent name (${(F.donor_innocent || []).length}) passes`, (F.donor_innocent || []).length >= 20 && dInn.length === 0, dInn.join(', '));
  const dAdv = (F.donor_adversarial || []).filter((n) => R.check(n, donorCtx).ok);
  ok(`every donor-shape adversarial name (${(F.donor_adversarial || []).length}) is refused`, (F.donor_adversarial || []).length >= 20 && dAdv.length === 0, dAdv.join(', '));
  ok('an unknown shape throws (never a silent fallback to the looser shape)', throws(() => R.check('Alice', { shape: 'donr' }), /unknown shape/));
  ok('the donor reserved words are §16.4\'s list', JSON.stringify(R.DONOR_RESERVED) ===
    JSON.stringify(['admin', 'official', 'operator', 'support', 'staff', 'pool', 'grinium', 'prize', 'jackpot', 'winner']));
}

console.log('\n[2] the two copies agree');
{
  const body = (text) => text.slice(text.indexOf('const NAME_MIN'));
  const games = fs.existsSync(GAMES_RULE) ? fs.readFileSync(GAMES_RULE, 'utf8') : '';
  const mine = fs.readFileSync(path.join(APP, 'lib/name-rule.js'), 'utf8');
  ok('both copies exist and start their code at `const NAME_MIN`', games.includes('const NAME_MIN') && mine.includes('const NAME_MIN'));
  const a = body(games).split('\n');
  const b = body(mine).split('\n');
  const firstDiff = a.findIndex((line, i) => line !== b[i]);
  ok('the code below the header is IDENTICAL, line for line (a drift fails here, not on a box)',
    a.length === b.length && firstDiff === -1, firstDiff === -1 ? `lengths ${a.length} vs ${b.length}` : `first difference at code line ${firstDiff + 1}: ${JSON.stringify(a[firstDiff])} vs ${JSON.stringify(b[firstDiff])}`);
  const seedWords = R.SEED.map((w) => w.replace(/^[*=]/, ''));
  const missing = STARTER_BLOCKLIST.filter((w) => !seedWords.includes(w));
  ok('the seed holds every word of the donor STARTER_BLOCKLIST', missing.length === 0, missing.join(', '));
  ok('only the two documented entries are forced to substring', JSON.stringify(R.SEED.filter((w) => /^[*=]/.test(w))) === '["*fuck","*jizz"]');
}

console.log('\n[3] names.blocked_words — validator, default, step-up, the page');
{
  const V = PoolSettings.validators.names;
  ok('the names section exists with blocked_words empty by default (the seed always applies)',
    PoolSettings.defaults.names && PoolSettings.defaults.names.blocked_words === '' && typeof V.blocked_words === 'function');
  ok('entries are folded to the matching form, * and = kept, blanks + duplicates dropped',
    V.blocked_words(' Rug Pull \r\n\r\n*Cr4p\n= Scammer\nrugpull\n') === 'rugpull\n*crap\n=scammer');
  ok('an array is accepted too', V.blocked_words(['moon', '*whale']) === 'moon\n*whale');
  ok('empty → empty', V.blocked_words('') === '' && V.blocked_words('\n \n') === '');
  ok('an entry that can never match a name is REFUSED with its line', throws(() => V.blocked_words('ok\ncafé'), /line 2/)
    && throws(() => V.blocked_words('*')) && throws(() => V.blocked_words('<script>')) && throws(() => V.blocked_words('x'.repeat(33))));
  ok('at most 500 entries (after duplicates are dropped)', throws(() => V.blocked_words(Array.from({ length: 501 }, (_, i) => `w${i}`).join('\n')), /500/)
    && V.blocked_words(Array(800).fill('same').join('\n')) === 'same');
  ok('a non-text line in an array is refused', throws(() => V.blocked_words(['ok', 5])));

  const index = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');
  ok("the 'names' settings section is step-up (emptying it would let offensive names go live)",
    /STEP_UP_SETTINGS_SECTIONS = new Set\(\[[^\]]*'names'/.test(index));

  const PANEL = path.join(APP, 'admin-panel');
  const page = fs.readFileSync(path.join(PANEL, 'settings-names.html'), 'utf8');
  const form = (page.match(/<div id="names" class="settings-content[^"]*">([\s\S]*?)<script/) || [])[1] || '';
  const ids = [];
  for (const m of form.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const id = (m[2].match(/\bid="([^"]+)"/) || [])[1];
    if (id && !/\bsettings-skip\b/.test(m[2])) ids.push(id);
  }
  ok('settings-names.html harvests exactly the names keys (an unknown id fails the save)',
    JSON.stringify(ids.sort()) === JSON.stringify(Object.keys(PoolSettings.defaults.names).sort()), ids.join());
  ok('the page declares SETTINGS_SECTION names and loads stepup.js', /window\.SETTINGS_SECTION = "names"/.test(page) && /<script src="\/js\/stepup\.js"><\/script>/.test(page));
  ok('the page explains the 4-letter rule and the * / = prefixes', /4 letters or fewer/.test(page) && /<code>\*crap<\/code>/.test(page) && /<code>=scammer<\/code>/.test(page));
  const shell = fs.readFileSync(path.join(PANEL, 'admin-shell.js'), 'utf8');
  ok('admin nav links it under Settings, after Games',
    /\{ file: 'settings-games\.html',\s+title: 'Games' \},[^\n]*\n\s*\{ file: 'settings-names\.html',\s+title: 'Names' \}/.test(shell));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
