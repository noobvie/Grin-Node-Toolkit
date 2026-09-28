// Every SQL statement in the backend that touches `shares`, planned against the real schema.
//
// `shares` is the hottest table (one INSERT per accepted share, ~31 h retained) and lives on the
// synchronous node:sqlite DB the stratum server shares: a statement that full-SCANs it stalls
// share submission for every connected miner for as long as the scan runs. The trap that kept
// recurring (memory project_pool_db_capacity) is a ONE-SIDED time range grouped by a column
// that leads another index — `created_at > ? GROUP BY grin_address` walks the whole
// address-leading index to skip a small sort, and `GROUP BY region` walks idx_share_region
// (region, created_at) because a range on an index's second column cannot seek. The fix is an
// upper bound (`AND created_at <= ?`), which flips the plan to a SEARCH of idx_share_created.
//
// So this test does not list queries by hand (a hand list is how the siblings got missed): it
// pulls every SQL string literal that names the table out of index.js and lib/*.js, runs
// EXPLAIN QUERY PLAN on each, and fails on any `SCAN shares` that is not in ALLOWED with a reason.
// Plans are taken WITHOUT ANALYZE, like production (nothing there runs it).
// Never touches the pool DB.
// Run: node scripts/test-shares-plans.js
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP = path.resolve(__dirname, '..');
const dbFile = path.join(os.tmpdir(), `pool-shares-plans-${Date.now()}.sqlite`);
const { initDb, getDb, createSchema, closeDb } = require(path.join(APP, 'lib/db.js'));
initDb(dbFile);
const db = getDb();
createSchema();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// A full scan that is correct by design. Keyed by a substring of the normalised SQL.
const ALLOWED = [
  // One-off unit migration (db.js): rescales every row exactly once, guarded by a schema marker.
  { match: 'UPDATE shares SET difficulty = difficulty *', why: 'one-off migration over every row, by design' },
];

// SQL string literals. A single left-to-right regex over the file is NOT safe: comments here are
// full of `code` spans, and one odd backtick in a comment pairs with a real template's opener and
// shifts every match after it (that is how a first version found nothing in index.js). So each
// quote character is tried as an opener ON ITS OWN, and only where code could open a string —
// after `(`, `=`, `,`, `:`, `+`, `?` or `return` — then read to its matching close. The content
// must START with an SQL verb and name the shares table.
const VERB = /^\s*(SELECT|WITH|INSERT|UPDATE|DELETE)\b/;
const NAMES_SHARES = /\b(FROM|INTO|UPDATE|JOIN)\s+shares\b/;
function extract(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const q = src[i];
    if (q !== '`' && q !== "'" && q !== '"') continue;
    const before = src.slice(Math.max(0, i - 12), i).replace(/\s+$/, '');
    if (!/([(=,:+?]|\breturn)$/.test(before)) continue;
    let j = i + 1;
    while (j < src.length && src[j] !== q) {
      if (src[j] === '\\') j++;
      else if (q !== '`' && src[j] === '\n') break;   // a quoted string never spans lines
      j++;
    }
    if (src[j] !== q) continue;
    const body = src.slice(i + 1, j);
    if (!VERB.test(body) || !NAMES_SHARES.test(body)) continue;
    out.push({ where: `${path.relative(APP, file)}:${src.slice(0, i).split('\n').length}`, sql: body });
    i = j;
  }
  return out;
}

const files = [path.join(APP, 'index.js')].concat(
  fs.readdirSync(path.join(APP, 'lib')).filter((f) => f.endsWith('.js')).map((f) => path.join(APP, 'lib', f)));
const queries = files.flatMap(extract);

console.log('\n[1] every shares statement in index.js + lib/*.js');
// Floors, per file, from a `grep -E "(FROM|INTO|UPDATE) shares"` count on 2026-09-27 — so an
// extractor that silently stops matching (or a file it cannot parse) fails here, not by omission.
const fromIndex = queries.filter((q) => q.where.startsWith('index.js')).length;
ok(`the extractor found the statements (${queries.length}; index.js ${fromIndex})`,
   queries.length >= 25 && fromIndex >= 7, 'fewer than expected — has the extractor stopped matching?');

for (const q of queries) {
  const norm = q.sql.replace(/\s+/g, ' ').trim();
  if (/\$\{/.test(q.sql)) {
    ok(`${q.where} is a plain string (no \${} interpolation to plan around)`, false, norm.slice(0, 120));
    continue;
  }
  let plan;
  try {
    const n = (q.sql.match(/\?/g) || []).length;
    plan = db.prepare('EXPLAIN QUERY PLAN ' + q.sql).all(...Array(n).fill(1)).map((x) => x.detail).join(' | ');
  } catch (e) {
    ok(`${q.where} plans`, false, `${e.message} :: ${norm.slice(0, 120)}`);
    continue;
  }
  const scans = /\bSCAN shares\b/.test(plan);
  const allowed = ALLOWED.find((a) => norm.includes(a.match));
  if (scans && allowed) ok(`${q.where} SCANs by design (${allowed.why})`, true);
  else ok(`${q.where} does not full-scan shares`, !scans, `${plan} :: ${norm.slice(0, 140)}`);
}

// Control: prove the check can fail — the one-sided form of the recordHashrates shape SCANs.
console.log('\n[2] control');
{
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT grin_address, SUM(difficulty) FROM shares WHERE created_at > ? GROUP BY grin_address')
    .all(1).map((x) => x.detail).join(' | ');
  ok('a one-sided `created_at > ? GROUP BY grin_address` really does SCAN (why the bounds are load-bearing)', /SCAN shares/.test(plan), plan);
  const regionPlan = db.prepare('EXPLAIN QUERY PLAN SELECT region, COUNT(*) FROM shares WHERE created_at > ? GROUP BY region')
    .all(1).map((x) => x.detail).join(' | ');
  ok('…and so does the one-sided `GROUP BY region`', /SCAN shares/.test(regionPlan), regionPlan);
}

try { closeDb(); } catch (_) {}
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbFile + s); } catch (_) {} }
console.log('\n' + (fail ? 'FAILURES' : 'ALL PASS') + ` — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
