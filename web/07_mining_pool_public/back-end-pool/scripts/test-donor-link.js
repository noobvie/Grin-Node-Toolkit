'use strict';

// Donor link (script07_design.md §18.12) — the third donor_requests kind. Covers: the one-time
// table rebuild of an existing pool.db (rows, ids, statuses and bytes identical; the
// AUTOINCREMENT sequence carried over; the three indexes and an extra index recreated; FK check
// clean; a failure part-way leaves the old table; a second start is a no-op; a fresh install
// stores the SAME schema text); the validator over an accept/refuse table plus a fuzz pass that
// must never throw; the state machine (submit / replace-pending / unchanged / approve / reject /
// withdraw / remove / block); a name change sending a live link back to review, and every name
// event that must NOT; the read shapes (the donor's own view never carries a pending URL, the
// wall carries the live link on every league card and never on the past strip, a stored row
// that no longer validates reaches no page); the admin queue's link rows; and the route + API
// doc wiring read as text.
// Run: node scripts/test-donor-link.js   (no server; temp files under the OS temp dir, removed)

const path = require('path');
const fs = require('fs');
const os = require('os');
const { routeSource, readAppSource } = require('./lib/app-source');
const APP = path.resolve(__dirname, '..');

const Database = require(path.join(APP, 'lib/sqlite-compat.js'));
const { initDb, getDb, closeDb } = require(path.join(APP, 'lib/db.js'));
const DP = require(path.join(APP, 'lib/donor-profiles.js'));
const DN = require(path.join(APP, 'lib/donor-names.js'));
const DL = require(path.join(APP, 'lib/donor-ledger.js'));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else      { fail++; console.error(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'donor-link-'));
const NOW = 1_800_000_000;
const ADDR = (c) => 'grin1' + c.repeat(58);
const ch = (n) => String.fromCharCode(n);
const BS = ch(92);                       // a backslash, built so the source holds none

// Capture console.warn / console.error while fn runs (the migration reports through them).
function quiet(fn) {
  const out = [];
  const w = console.warn, e = console.error;
  console.warn = (...a) => out.push(['warn', a.join(' ')]);
  console.error = (...a) => out.push(['error', a.join(' ')]);
  try { fn(); } finally { console.warn = w; console.error = e; }
  return out;
}

// ── bech32 encoder (independent of the lib's checker) ──────────────────────────────────────
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk = (chk ^ GEN[i]) >>> 0;
  }
  return chk;
}
const hrpExpand = (h) => [...h].map((c) => c.charCodeAt(0) >> 5).concat([0], [...h].map((c) => c.charCodeAt(0) & 31));
function toWords(bytes) {
  let acc = 0, bits = 0; const out = [];
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); } }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}
function bech32(hrp, bytes) {
  const data = toWords(bytes);
  const pm = polymod(hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
  const cs = [0, 1, 2, 3, 4, 5].map((i) => (pm >>> (5 * (5 - i))) & 31);
  return hrp + '1' + data.concat(cs).map((d) => CHARSET[d]).join('');
}
const KEY = Buffer.from('3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d', 'hex');
const NPUB = bech32('npub', KEY);
const NPROFILE = bech32('nprofile', Buffer.concat([Buffer.from([0, 32]), KEY, Buffer.from([1, 4]), Buffer.from('wss:')]));
const NSEC = bech32('nsec', KEY);
const NOTE = bech32('note', KEY);
const flipLast = (s) => s.slice(0, -1) + (s.slice(-1) === 'q' ? 'p' : 'q');

// The donor_requests table exactly as every pool before §18.12 created it.
const OLD_DDL = `CREATE TABLE IF NOT EXISTS donor_requests (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      grin_address TEXT NOT NULL REFERENCES miner_accounts(grin_address),
      kind         TEXT NOT NULL CHECK (kind IN ('name','banner')),
      status       TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','replaced','withdrawn','removed')),
      name         TEXT,
      image        BLOB,
      file         TEXT,
      mime TEXT, width INTEGER, height INTEGER, bytes INTEGER, sha256 TEXT,
      submitted_at INTEGER NOT NULL DEFAULT (unixepoch()),
      decided_at   INTEGER, decided_by INTEGER REFERENCES users(id),
      reason       TEXT
    )`;
const OLD_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_donor_req_pending  ON donor_requests(grin_address, kind) WHERE status = 'pending'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_donor_req_approved ON donor_requests(grin_address, kind) WHERE status = 'approved'`,
  `CREATE INDEX        IF NOT EXISTS idx_donor_req_status  ON donor_requests(status, submitted_at)`,
];
const OLD_COLS = 'id, grin_address, kind, status, name, image, file, mime, width, height, bytes, sha256, submitted_at, decided_at, decided_by, reason';

// A pool.db at the pre-link schema: the full current schema, then donor_requests swapped for
// the old table with realistic rows (every status, a pending blob, an id gap, a deleted top id
// so sqlite_sequence is ABOVE max(id)), plus an extra index of the operator's own.
function oldSchemaDb(file, opts = {}) {
  initDb(file);
  closeDb();
  const raw = new Database(file);
  raw.pragma('foreign_keys = OFF');
  raw.exec('DROP TABLE donor_requests');
  raw.exec(OLD_DDL);
  for (const s of OLD_INDEXES) raw.exec(s);
  raw.exec('CREATE INDEX idx_donor_req_extra ON donor_requests(decided_by)');
  raw.pragma('foreign_keys = ON');
  const A = ADDR('a'), B = ADDR('b');
  for (const a of [A, B]) raw.prepare('INSERT INTO miner_accounts (grin_address, balance) VALUES (?, 0)').run(a);
  raw.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (3, 'op', 'x', 1)").run();
  const ins = raw.prepare(`INSERT INTO donor_requests (${OLD_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run(1, A, 'name', 'replaced', 'Old Name', null, null, null, null, null, null, null, 100, 110, 3, null);
  ins.run(2, A, 'name', 'approved', 'Acme', null, null, null, null, null, null, null, 120, 120, null, null);
  ins.run(3, A, 'banner', 'approved', null, null, '0123456789abcdef.png', 'image/png', 800, 200, 999, 'ab'.repeat(32), 130, 140, 3, null);
  ins.run(5, A, 'banner', 'pending', null, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), null, 'image/png', 800, 200, 7, 'cd'.repeat(32), 150, null, null, null);
  ins.run(6, B, 'banner', 'rejected', null, null, null, 'image/gif', 640, 160, 50, 'ef'.repeat(32), 160, 170, 3, 'Too busy');
  ins.run(7, B, 'name', 'removed', 'Gone', null, null, null, null, null, null, null, 180, 190, 3, 'rude');
  ins.run(8, B, 'banner', 'withdrawn', null, null, null, 'image/jpeg', 400, 100, 60, '01'.repeat(32), 200, 210, null, null);
  ins.run(9, B, 'name', 'approved', 'Bee', null, null, null, null, null, null, null, 220, 220, null, null);
  if (!opts.noTopDelete) {
    ins.run(12, B, 'banner', 'withdrawn', null, null, null, null, null, null, null, null, 230, 240, null, null);
    raw.exec('DELETE FROM donor_requests WHERE id = 12');
  }
  if (opts.blocker) raw.exec('CREATE TABLE donor_requests_old (x INTEGER)');
  const rows = raw.prepare(`SELECT ${OLD_COLS} FROM donor_requests ORDER BY id`).all();
  const seq = raw.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'donor_requests'").get();
  raw.close();
  return { rows, seq: seq ? seq.seq : null };
}
const norm = (rows) => JSON.stringify(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
  [k, v && typeof v === 'object' && typeof v.length === 'number' ? 'hex:' + Buffer.from(v).toString('hex') : v]))));
const schemaOf = (d) => d.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'donor_requests' ORDER BY type, name").all()
  .map((r) => `${r.type}|${r.name}|${r.sql}`);

try {
  // ══ 1. The table rebuild (lib/db.js migrateDonorRequests) ═══════════════════════════════════
  console.log('\n[1] migration: rebuild donor_requests for kind link\n');
  const FILE = path.join(TMP, 'old.sqlite');
  const before = oldSchemaDb(FILE);
  check('fixture: the old table refuses kind link (the reason for the rebuild)', (() => {
    const raw = new Database(FILE);
    try { raw.prepare("INSERT INTO donor_requests (grin_address, kind, status) VALUES (?, 'link', 'pending')").run(ADDR('a')); return false; }
    catch (e) { return /constraint/i.test(e.message); } finally { raw.close(); }
  })());
  let logs = quiet(() => initDb(FILE));
  let db = getDb();
  const sqlNow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'donor_requests'").get().sql;
  check('migrate: the kind CHECK admits link and the table has a url column',
        /kind IN \('name','banner','link'\)/.test(sqlNow) && db.prepare('PRAGMA table_info(donor_requests)').all().some((c) => c.name === 'url'));
  check('migrate: the start says so once (warn), no error', logs.filter((l) => /rebuilt/.test(l[1])).length === 1 && !logs.some((l) => l[0] === 'error'),
        JSON.stringify(logs));
  check('migrate: every row identical column-for-column — ids, statuses, names, reasons, blob bytes',
        norm(db.prepare(`SELECT ${OLD_COLS} FROM donor_requests ORDER BY id`).all()) === norm(before.rows));
  check('migrate: url is NULL on every carried row', db.prepare('SELECT COUNT(*) AS n FROM donor_requests WHERE url IS NOT NULL').get().n === 0);
  check('migrate: sqlite_sequence carried over (12, above max(id) = 9 — a deleted id is never reused)',
        before.seq === 12 && db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'donor_requests'").get().seq === 12 &&
        db.prepare("INSERT INTO donor_requests (grin_address, kind, status, url) VALUES (?, 'link', 'pending', 'https://x.example/')").run(ADDR('a')).lastInsertRowid === 13);
  check('migrate: no table named donor_requests_old is left', !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'donor_requests_old'").get());
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'donor_requests' AND sql IS NOT NULL ORDER BY name").all().map((r) => r.name);
  check('migrate: the three indexes AND the operator\'s extra one are back',
        idx.join() === 'idx_donor_req_extra,idx_donor_req_status,uq_donor_req_approved,uq_donor_req_pending', idx.join());
  check('migrate: the partial unique index still holds — a second pending link for one address is refused', (() => {
    try { db.prepare("INSERT INTO donor_requests (grin_address, kind, status, url) VALUES (?, 'link', 'pending', 'https://y.example/')").run(ADDR('a')); return false; }
    catch (e) { return /constraint/i.test(e.message); }
  })());
  check('migrate: foreign_key_check is clean and foreign_keys is back ON',
        db.pragma('foreign_key_check').length === 0 && db.pragma('foreign_keys', { simple: true }) === 1);
  const migratedSchema = schemaOf(db).filter((s) => !s.includes('idx_donor_req_extra'));
  closeDb();

  logs = quiet(() => initDb(FILE));
  db = getDb();
  check('second start: a no-op — nothing logged, schema and rows unchanged',
        !logs.some((l) => /donor_requests/.test(l[1])) && JSON.stringify(schemaOf(db).filter((s) => !s.includes('idx_donor_req_extra'))) === JSON.stringify(migratedSchema) &&
        db.prepare('SELECT COUNT(*) AS n FROM donor_requests').get().n === before.rows.length + 1);
  closeDb();

  initDb(':memory:');
  const freshSchema = schemaOf(getDb());
  check('fresh install == migrated: identical sqlite_master text for the table and all three indexes',
        freshSchema.length === 4 && JSON.stringify(freshSchema) === JSON.stringify(migratedSchema),
        JSON.stringify({ freshSchema, migratedSchema }));
  check('fresh install: the table text names no quoted or temporary table name',
        !/"donor_requests"|donor_requests_old|_new/.test(freshSchema.join('\n')));
  closeDb();

  // A failure part-way: an object already named donor_requests_old makes the RENAME fail.
  const FILE2 = path.join(TMP, 'old-blocked.sqlite');
  const before2 = oldSchemaDb(FILE2, { blocker: true, noTopDelete: true });
  logs = quiet(() => initDb(FILE2));
  db = getDb();
  check('failure part-way: the old table stands untouched (old CHECK, every row, its indexes)',
        /kind IN \('name','banner'\)/.test(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'donor_requests'").get().sql) &&
        norm(db.prepare(`SELECT ${OLD_COLS} FROM donor_requests ORDER BY id`).all()) === norm(before2.rows) &&
        db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND tbl_name = 'donor_requests' AND sql IS NOT NULL").get().n === 4);
  check('failure part-way: logged as an error with "retried at the next start", and foreign_keys is ON again',
        logs.some((l) => l[0] === 'error' && /rebuild failed — retried at the next start/.test(l[1])) && db.pragma('foreign_keys', { simple: true }) === 1);
  check('failure part-way: the url column went on before the rebuild, and survived its rollback',
        db.prepare('PRAGMA table_info(donor_requests)').all().some((c) => c.name === 'url') && DP.linksSupported(db) === false);
  // Through the libs, with a donor on the wall — a raw INSERT cannot see a reader that names `url`.
  {
    const A2 = ADDR('a');
    db.prepare(`INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id, created_at)
                VALUES (?, 'debit', 1, 1, 0.5, 0, 0, 'donation', 9, ?)`).run(A2, NOW - 3600);
    const lives = (f) => { try { f(); return true; } catch (e) { console.log('    threw:', e.message); return false; } };
    const rule1 = DP.nameRuleContext('', 'Zephyr');
    check('failure part-way: names, banners and the wall keep working through the libs',
          lives(() => DP.profileFor(db, A2, { active: true, lastDonatedAt: NOW - 60, now: NOW })) &&
          lives(() => DP.publicProfiles(db)) && lives(() => DP.adminQueue(db, {})) && lives(() => DP.adminProfiles(db)) &&
          lives(() => DL.donorWall(db, { ds: DN.donorSettings({}, ''), H: 0, now: NOW, active: true, mask: (x) => x })) &&
          DP.submitName(db, A2, 'Renamed Acme', { isDonor: true, rule: rule1, now: NOW }).ok === true);
    const rl = DP.submitLink(db, A2, 'https://example.org', { isDonor: true, now: NOW });
    check('failure part-way: a link submit is refused as links_unavailable', rl.ok === false && rl.code === 'links_unavailable', JSON.stringify(rl));
  }
  db.exec('DROP TABLE donor_requests_old');
  const afterFail = norm(db.prepare(`SELECT ${OLD_COLS} FROM donor_requests ORDER BY id`).all());
  closeDb();
  logs = quiet(() => initDb(FILE2));
  check('failure part-way: the next start (blocker gone) rebuilds, every row kept, to the canonical schema text',
        /'link'/.test(getDb().prepare("SELECT sql FROM sqlite_master WHERE name = 'donor_requests'").get().sql) &&
        norm(getDb().prepare(`SELECT ${OLD_COLS} FROM donor_requests ORDER BY id`).all()) === afterFail &&
        JSON.stringify(schemaOf(getDb()).filter((s) => !s.includes('idx_donor_req_extra'))) === JSON.stringify(migratedSchema));
  closeDb();

  // A table with the NEW kind CHECK but no url column (an intermediate build) is not "done".
  {
    const FILE3 = path.join(TMP, 'check-no-url.sqlite');
    oldSchemaDb(FILE3);
    const raw = new Database(FILE3);
    raw.pragma('foreign_keys = OFF');
    raw.exec(`ALTER TABLE donor_requests RENAME TO donor_requests_x;
      ${OLD_DDL.replace("('name','banner')", "('name','banner','link')")};
      INSERT INTO donor_requests SELECT * FROM donor_requests_x; DROP TABLE donor_requests_x;`);
    raw.close();
    logs = quiet(() => initDb(FILE3));
    check('new CHECK without url: the start adds the column and rebuilds to the canonical text',
          getDb().prepare('PRAGMA table_info(donor_requests)').all().some((c) => c.name === 'url') &&
          JSON.stringify(schemaOf(getDb()).filter((s) => !s.includes('idx_donor_req_extra'))) === JSON.stringify(migratedSchema) &&
          !logs.some((l) => l[0] === 'error'), JSON.stringify(logs));
    closeDb();
  }

  // ══ 2. The validator (§18.12 Validation) ════════════════════════════════════════════════════
  console.log('\n[2] validateLink\n');
  initDb(':memory:');
  db = getDb();
  const v = (s) => DP.validateLink(s);
  // A REAL v3 onion label (fixed pubkey, checksum computed per the Tor rend-spec), plus a same-shape fake.
  const mkOnion = (pub, badSum = false) => {
    const sum = require('crypto').createHash('sha3-256').update(Buffer.concat([Buffer.from('.onion checksum'), pub, Buffer.from([3])])).digest();
    const bytes = Buffer.concat([pub, Buffer.from([sum[0] ^ (badSum ? 1 : 0), sum[1]]), Buffer.from([3])]);
    const B = 'abcdefghijklmnopqrstuvwxyz234567'; let bits = 0, acc = 0, o = '';
    for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; o += B[(acc >> bits) & 31]; } acc &= (1 << bits) - 1; }
    return o;
  };
  const O56 = mkOnion(Buffer.alloc(32, 7));
  const FAKE56 = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx';   // 56 base32 chars, no checksum
  const BADSUM56 = mkOnion(Buffer.alloc(32, 7), true);   // version byte 3, checksum off by one bit
  const ACCEPT = [
    // [input, stored url, host, kind]
    ['https://example.com', 'https://example.com/', 'example.com', 'web'],
    ['HTTPS://Example.COM/Path', 'https://example.com/Path', 'example.com', 'web'],
    ['  https://example.com/a  ', 'https://example.com/a', 'example.com', 'web'],
    [ch(9) + 'https://example.com' + ch(10), 'https://example.com/', 'example.com', 'web'],
    ['https://example.com/a?utm=1#top', 'https://example.com/a', 'example.com', 'web'],
    ['https://example.com/?', 'https://example.com/', 'example.com', 'web'],
    ['https://example.com.', 'https://example.com/', 'example.com', 'web'],
    ['https://shop.example.co.uk:8443/x', 'https://shop.example.co.uk:8443/x', 'shop.example.co.uk:8443', 'web'],
    ['https://b' + ch(0xfc) + 'cher.example/', 'https://xn--bcher-kva.example/', 'xn--bcher-kva.example', 'web'],
    ['https://example.xn--p1ai/', 'https://example.xn--p1ai/', 'example.xn--p1ai', 'web'],
    ['http://' + O56 + '.onion/', 'http://' + O56 + '.onion/', O56 + '.onion', 'onion'],
    ['https://' + O56.toUpperCase() + '.onion', 'https://' + O56 + '.onion/', O56 + '.onion', 'onion'],
    ['nostr:' + NPUB, 'nostr:' + NPUB, NPUB.slice(0, 9) + ch(0x2026) + NPUB.slice(-4), 'nostr'],
    ['NOSTR:' + NPUB.toUpperCase(), 'nostr:' + NPUB, NPUB.slice(0, 9) + ch(0x2026) + NPUB.slice(-4), 'nostr'],
    ['nostr:' + NPROFILE, 'nostr:' + NPROFILE, NPROFILE.slice(0, 9) + ch(0x2026) + NPROFILE.slice(-4), 'nostr'],
    ['https://' + 'a'.repeat(60) + '.' + 'b'.repeat(60) + '.example', 'https://' + 'a'.repeat(60) + '.' + 'b'.repeat(60) + '.example/', 'a'.repeat(60) + '.' + 'b'.repeat(60) + '.example', 'web'],
  ];
  for (const [inp, url, host, kind] of ACCEPT) {
    const r = v(inp);
    check(`accept ${JSON.stringify(inp).slice(0, 60)} → ${url.slice(0, 50)}`, r.ok && r.url === url && r.host === host && r.kind === kind, JSON.stringify(r));
  }
  check('accept: every stored form re-validates to exactly itself (what is approved is what is shown)',
        ACCEPT.every(([inp]) => { const a = v(inp); const b = v(a.url); return b.ok && b.url === a.url; }));
  check('accept: exactly 200 characters is allowed', v('https://example.com/' + 'a'.repeat(180)).ok && ('https://example.com/' + 'a'.repeat(180)).length === 200);
  check('npub is exactly 63 characters (the fixture is real-shaped)', NPUB.length === 63);

  const REFUSE = [
    ['', 'link_empty'], ['   ', 'link_empty'], [null, 'link_empty'], [undefined, 'link_empty'], [42, 'link_empty'], [['https://a.example'], 'link_empty'],
    ['https://example.com/' + 'a'.repeat(181), 'link_too_long'],
    ['javascript:alert(1)', 'link_scheme'], ['JAVASCRIPT:alert(1)', 'link_scheme'], ['JaVaScRiPt:alert(1)', 'link_scheme'],
    ['data:text/html,<script>alert(1)</script>', 'link_scheme'], ['file:///etc/passwd', 'link_scheme'],
    ['vbscript:msgbox(1)', 'link_scheme'], ['mailto:a@example.com', 'link_scheme'], ['ftp://example.com', 'link_scheme'],
    ['//example.com', 'link_scheme'], ['example.com', 'link_scheme'], ['https:/example.com', 'link_scheme'],
    ['https:///example.com', 'link_scheme'], ['%6Aavascript:alert(1)', 'link_scheme'], ['wss://example.com', 'link_scheme'],
    ['https://exa mple.com', 'link_chars'], ['https://example.com/a' + ch(9) + 'b', 'link_chars'],
    ['https://example.com/a' + ch(10) + 'b', 'link_chars'], ['https://example.com/' + ch(0), 'link_chars'],
    [ch(0xa0) + 'https://example.com', 'link_chars'], ['https://example.com/' + ch(0x200b), 'link_chars'],
    ['https://example.com/' + ch(0x202e) + 'gpj.exe', 'link_chars'], ['https://example.com/' + ch(0x2028), 'link_chars'],
    ['https://example.com/' + ch(0xfeff), 'link_chars'], ['https://example.com/' + ch(0x2060), 'link_chars'], ['https://ex' + ch(0xad) + 'ample.com', 'link_chars'],
    ['https:' + BS + BS + 'example.com', 'link_chars'], ['https://example.com' + BS + '@evil.com', 'link_chars'],
    ['http://example.com', 'link_host'], ['http://' + FAKE56 + '.onion/', 'link_host'], ['http://' + BADSUM56 + '.onion/', 'link_host'], ['http://' + O56.slice(0, 55) + '.onion', 'link_host'],
    ['http://' + O56 + '1.onion', 'link_host'], ['https://x.' + O56 + '.onion', 'link_host'],
    ['https://' + O56 + '.onion.example.com', 'link_host'], ['https://short.onion', 'link_host'],
    ['https://127.0.0.1/', 'link_host'], ['https://0x7f.1/', 'link_host'], ['https://2130706433/', 'link_host'],
    ['https://[::1]/', 'link_host'], ['https://[2001:db8::1]/', 'link_host'], ['https://localhost/', 'link_host'],
    ['https://intranet/', 'link_host'], ['https://example.123/', 'link_host'], ['https://example.c/', 'link_host'],
    ['https://a..example.com/', 'link_host'], ['https://-bad.example.com/', 'link_host'], ['https://bad-.example.com/', 'link_host'], ['https://' + 'a'.repeat(64) + '.example.com/', 'link_host'], ['https://example.com:99999/', 'link_host'],
    // A host whose own Unicode label holds `xn--` serialises to an href that does not re-parse;
    // a URL setter on it ABORTS the process (no exception), so this row fails the whole suite.
    ['https://' + ch(0x430) + 'xn--.com', 'link_host'], ['HTTPS://' + ch(0xe9) + 'xn--Z0.com', 'link_host'],
    ['https://user:pass@example.com', 'link_userinfo'], ['https://user@example.com', 'link_userinfo'], ['https://@example.com', 'link_userinfo'],
    ['nostr:' + NOTE, 'link_nostr'], ['nostr:' + NSEC, 'link_nostr'], ['nostr:' + KEY.toString('hex'), 'link_nostr'],
    ['nostr:' + flipLast(NPUB), 'link_nostr'], ['nostr:' + NPUB.slice(0, -1), 'link_nostr'], ['nostr:' + NPUB + 'q', 'link_nostr'],
    ['nostr:' + NPUB + '?relay=wss://x', 'link_nostr'], ['nostr:' + NPUB + '#x', 'link_nostr'], ['nostr://' + NPUB, 'link_nostr'],
    ['nostr:nevent1qqqqqqqq', 'link_nostr'], ['nostr:', 'link_nostr'],
  ];
  for (const [inp, code] of REFUSE) {
    const r = v(inp);
    check(`refuse ${JSON.stringify(inp === undefined ? 'undefined' : inp).slice(0, 60)} → ${code}`, !r.ok && r.code === code && typeof r.error === 'string' && r.error.length > 10, JSON.stringify(r));
  }
  check('refusals never echo the input back in the error text', REFUSE.every(([inp]) => typeof inp !== 'string' || inp.trim().length < 12 || !v(inp).error.includes(inp.trim())));
  check('fuzz: 20 000 random strings never throw, and every accepted one is https/http-onion/nostr and re-validates to itself', (() => {
    const alphabet = ['h', 't', 'p', 's', ':', '/', '.', '@', '?', '#', 'a', 'x', 'n', 'o', 'r', '1', '%', ' ', BS, ch(0x200b), ch(0xfc), ch(0x430), '-', 'xn--', '[', ']', 'onion', 'https://', 'nostr:', 'npub1', 'example.com', 'javascript:'];
    let seed = 7;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 20000; i++) {
      let s = '';
      const len = rnd(12);
      for (let j = 0; j < len; j++) s += alphabet[rnd(alphabet.length)];
      let r;
      try { r = v(s); } catch (e) { return false; }
      if (r.ok) {
        if (!/^(https:\/\/|http:\/\/[a-z2-7]{56}\.onion|nostr:npub1|nostr:nprofile1)/.test(r.url)) return false;
        if (v(r.url).url !== r.url) return false;
      }
    }
    return true;
  })());

  // ══ 3. State machine (§18.12 table) ════════════════════════════════════════════════════════
  console.log('\n[3] state machine\n');
  const adminId = Number(db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES ('op', 'x', 1)").run().lastInsertRowid);
  const mk = (a) => db.prepare('INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES (?, 0)').run(a);
  const donate = (a, at) => db.prepare(`INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id, created_at)
                                        VALUES (?, 'debit', ?, 1, 0.5, 0, 0, 'donation', 9, ?)`).run(a, 1, at);
  const linksOf = (a) => db.prepare("SELECT id, status, url, reason, decided_by FROM donor_requests WHERE grin_address = ? AND kind = 'link' ORDER BY id").all(a);
  const st = (a, s) => linksOf(a).filter((r) => r.status === s);
  const DONOR = { isDonor: true, now: NOW };
  const own = (a, extra = {}) => DP.profileFor(db, a, Object.assign({ active: true, lastDonatedAt: NOW - 60, now: NOW }, extra));
  const A = ADDR('c'), B = ADDR('d');
  [A, B].forEach(mk);

  check('submit: refused without a donation (fail closed), with nothing stored',
        DP.submitLink(db, A, 'https://a.example', { now: NOW }).code === 'not_a_donor' && linksOf(A).length === 0);
  check('submit: a refused shape stores nothing', DP.submitLink(db, A, 'javascript:alert(1)', DONOR).code === 'link_scheme' && linksOf(A).length === 0);
  const s1 = DP.submitLink(db, A, ' https://A.example/x#frag ', DONOR);
  check('submit → pending, the STORED form is the normalised one', s1.ok && st(A, 'pending').length === 1 &&
        st(A, 'pending')[0].url === 'https://a.example/x' && s1.url === 'https://a.example/x' && s1.host === 'a.example' && s1.link_kind === 'web');
  check('submit: the same URL again while it waits → unchanged (after the proofs: submitLink), nothing written',
        DP.submitLink(db, A, 'https://a.example/x', DONOR).code === 'unchanged' && linksOf(A).length === 1);
  check('precheck: the PENDING URL is not compared before the proofs (no oracle)', DP.linkPrecheck(db, A, 'https://a.example/x') === null);
  const s2 = DP.submitLink(db, A, 'https://b.example', DONOR);
  check('resubmit while pending: the old pending → replaced, one pending (the new one)',
        s2.ok && s2.replaced === true && st(A, 'replaced').length === 1 && st(A, 'pending').length === 1 && st(A, 'pending')[0].url === 'https://b.example/');
  check('own view: pending reported by its time only — the URL is nowhere in it',
        own(A).link.pending_at === NOW && own(A).link.live === null && own(A).link.state === 'none' &&
        !JSON.stringify(own(A)).includes('b.example') && !JSON.stringify(own(A)).includes('a.example'));
  const ap = DP.approve(db, s2.id, { adminId, now: NOW + 10 });
  check('approve → approved; no file, no uploads dir needed', ap.ok && ap.kind === 'link' && ap.file === null && st(A, 'approved').length === 1);
  check('approve: audited in the transaction, with the HOST and never the full URL', (() => {
    const r = db.prepare("SELECT admin_id, details FROM admin_audit_log WHERE action = 'donor_request_approve' AND target_id = ? ORDER BY id DESC").get(A);
    return r && r.admin_id === adminId && JSON.parse(r.details).host === 'b.example' && JSON.parse(r.details).kind === 'link' && !r.details.includes('https://');
  })());
  check('own view: the live link is shown (it is public on the wall anyway)',
        JSON.stringify(own(A).link.live) === JSON.stringify({ url: 'https://b.example/', host: 'b.example', kind: 'web' }) && own(A).link.state === 'shown' && own(A).link.pending_at === null);
  check('precheck: the LIVE URL → unchanged before the proofs', DP.linkPrecheck(db, A, 'https://b.example/').code === 'unchanged');
  const s3 = DP.submitLink(db, A, 'https://c.example', DONOR);
  check('resubmit while live: the live one STAYS live until the new one is approved',
        s3.ok && st(A, 'approved')[0].url === 'https://b.example/' && st(A, 'pending')[0].url === 'https://c.example/' && own(A).link.live.url === 'https://b.example/');
  DP.approve(db, s3.id, { adminId, now: NOW + 20 });
  check('approve the replacement → the previous approved → replaced', st(A, 'approved').length === 1 && st(A, 'approved')[0].url === 'https://c.example/' &&
        st(A, 'replaced').some((r) => r.url === 'https://b.example/'));
  const s4 = DP.submitLink(db, A, 'https://d.example', DONOR);
  const rj = DP.reject(db, s4.id, { adminId, reason: 'Not a donor site', now: NOW + 30 });
  check('reject {reason} → rejected, the reason SHOWN to the donor, the live link untouched',
        rj.ok && JSON.stringify(own(A).link.rejected) === JSON.stringify({ reason: 'Not a donor site', at: NOW + 30 }) && own(A).link.live.url === 'https://c.example/');
  const s5 = DP.submitLink(db, A, 'https://e.example', DONOR);
  const wd = DP.withdraw(db, A, 'link', { now: NOW + 40 });
  check('withdraw → withdrawn, the live link untouched, the host (not the URL) handed back for the audit row',
        wd.ok && wd.host === 'e.example' && st(A, 'withdrawn').some((r) => r.id === s5.id) &&
        own(A).link.live.url === 'https://c.example/');
  check('withdraw with nothing pending → nothing_pending', DP.withdraw(db, A, 'link').code === 'nothing_pending');
  const rmD = DP.removeLive(db, A, 'link', { now: NOW + 50 });
  check('donor remove → removed at once, no uploads dir, NOT reported as news (the donor did it)',
        rmD.ok && rmD.file_deleted === false && rmD.host === 'c.example' && st(A, 'approved').length === 0 && own(A).link.removed === null && own(A).link.live === null);
  {
    const s7 = DP.submitLink(db, A, 'https://h.example', DONOR);
    const rjObj = DP.reject(db, s7.id, { adminId, reason: { a: 1 }, now: NOW + 55 });
    check('a non-string reason is stored as none, never "[object Object]" shown to the donor',
          rjObj.ok && own(A).link.rejected && own(A).link.rejected.reason === null, JSON.stringify(own(A).link.rejected));
  }
  const s6 = DP.submitLink(db, A, 'https://f.example', DONOR);
  DP.approve(db, s6.id, { adminId, now: NOW + 60 });
  const rmA = DP.removeLive(db, A, 'link', { adminId, reason: 'Spam', now: NOW + 70 });
  check('admin remove {reason} → removed, the reason shown to the donor, audited with the host',
        rmA.ok && JSON.stringify(own(A).link.removed) === JSON.stringify({ reason: 'Spam', at: NOW + 70 }) &&
        JSON.parse(db.prepare("SELECT details FROM admin_audit_log WHERE action = 'donor_profile_remove' ORDER BY id DESC").get().details).host === 'f.example');
  check('remove with nothing live → nothing_live', DP.removeLive(db, A, 'link').code === 'nothing_live');
  DP.submitLink(db, A, 'https://g.example', DONOR);
  const bl = DP.block(db, A, { adminId, reason: 'x', now: NOW + 80 });
  check('block → the pending link is withdrawn (the queue never shows a blocked address\'s work)',
        bl.ok && bl.withdrawn === 1 && st(A, 'pending').length === 0 && DP.submitLink(db, A, 'https://h.example', DONOR).code === 'blocked');
  check('requestImage: a link row → not_found (the image route answers 404)',
        DP.requestImage(db, s6.id, { uploadsDir: TMP }).code === 'not_found');
  DP.unblock(db, A, { adminId });

  // ══ 4. A name change sends a live link back to review ══════════════════════════════════════
  console.log('\n[4] name change → link re-review\n');
  const rule = DP.nameRuleContext('', 'Zephyr');
  const C = ADDR('e'), D = ADDR('f'), E = ADDR('g'), F = ADDR('h');
  [C, D, E, F].forEach(mk);
  [C, D, E, F].forEach((a) => donate(a, NOW - 3600));
  const liveLink = (a, url, at = NOW - 1000) => {
    const s = DP.submitLink(db, a, url, { isDonor: true, now: at });
    return DP.approve(db, s.id, { adminId, now: at + 1 });
  };
  const wallLink = (a) => {
    const w = DL.donorWall(db, { ds: DN.donorSettings({}, ''), H: 0, now: NOW, active: true, mask: (x) => x });
    const c = w.league.concat(w.past.donors).find((x) => x.address === a);
    return c ? c.link : undefined;
  };
  liveLink(C, 'https://harmless.example');
  check('control: C\'s link is on the wall before any name', wallLink(C) && wallLink(C).url === 'https://harmless.example/');
  const n1 = DP.submitName(db, C, 'Grin Wallet', { isDonor: true, rule, now: NOW });
  check('a FIRST-EVER name (none → X) counts: the live link → replaced, a new pending row with the SAME url',
        n1.ok && n1.link_review && st(C, 'approved').length === 0 &&
        st(C, 'replaced').length === 1 && st(C, 'pending').length === 1 && st(C, 'pending')[0].url === 'https://harmless.example/' &&
        st(C, 'pending')[0].id === n1.link_review.pending_id);
  check('the wall loses the link AT ONCE (the next read)', wallLink(C) === null);
  check('the account page shows it waiting, not its URL', own(C).link.pending_at === NOW && own(C).link.live === null &&
        !JSON.stringify(own(C)).includes('harmless'));
  check('the admin queue shows it again, beside the NEW name', (() => {
    const q = DP.adminQueue(db, { kind: 'link' }).rows.find((r) => r.address === C);
    return q && q.live_name === 'Grin Wallet' && q.url === 'https://harmless.example/';
  })());
  DP.approve(db, st(C, 'pending')[0].id, { adminId, now: NOW + 5 });
  check('approved again → back on the wall', wallLink(C) && wallLink(C).url === 'https://harmless.example/');

  check('a name change with NO link: behaves as before, no link row appears',
        DP.submitName(db, D, 'Plain Donor', { isDonor: true, rule, now: NOW }).ok && linksOf(D).length === 0 &&
        DP.submitName(db, D, 'Plain Donor', { isDonor: true, rule, now: NOW }).link_review === undefined);
  liveLink(E, 'https://e-live.example', NOW - 900);
  DP.submitName(db, E, 'First Name', { isDonor: true, rule, now: NOW - 800 * 86400 });   // long ago
  DP.approve(db, st(E, 'pending')[0].id, { adminId, now: NOW - 100 });
  const eLive = st(E, 'approved')[0].id;
  check('a REFUSED rename leaves the link live — the 7-day limit, unchanged, a blocked word', (() => {
    const cool = DP.submitName(db, C, 'Another Name', { isDonor: true, rule, now: NOW + 10 });
    const same = DP.submitName(db, E, 'First Name', { isDonor: true, rule, now: NOW });
    const bad = DP.submitName(db, E, 'Zephyr Official', { isDonor: true, rule, now: NOW });
    return cool.code === 'name_cooldown' && same.code === 'unchanged' && bad.code === 'name_not_allowed' &&
           st(E, 'approved').length === 1 && st(E, 'approved')[0].id === eLive && st(E, 'pending').length === 0 &&
           st(C, 'approved').length === 1;
  })());
  DP.submitLink(db, E, 'https://e-next.example', { isDonor: true, now: NOW - 50 });
  const ePend = st(E, 'pending')[0].id;
  const n2 = DP.submitName(db, E, 'Second Name', { isDonor: true, rule, now: NOW });
  check('rename while a link is ALSO pending: the live one → replaced, the waiting one re-issued under a NEW id (the waiting URL wins — the donor\'s newest request is kept)',
        n2.ok && n2.link_review.pending_id !== ePend && n2.link_review.replaced_id === eLive &&
        st(E, 'approved').length === 0 && st(E, 'pending').length === 1 && st(E, 'pending')[0].id === n2.link_review.pending_id &&
        st(E, 'pending')[0].url === 'https://e-next.example/');
  check('a stale approve (the card the admin judged beside the OLD name) is refused, nothing goes live',
        DP.approve(db, ePend, { adminId, now: NOW + 1 }).code === 'not_pending' && st(E, 'approved').length === 0);
  check('rename with ONLY a pending link (none live): re-issued under a new id, a stale approve fails', (() => {
    const H = ADDR('q'); mk(H); donate(H, NOW - 3600);
    DP.submitName(db, H, 'Hal One', { isDonor: true, rule, now: NOW - 800 * 86400 });
    DP.submitLink(db, H, 'https://h-wait.example', { isDonor: true, now: NOW - 50 });
    const old = st(H, 'pending')[0].id;
    const r = DP.submitName(db, H, 'Hal Two', { isDonor: true, rule, now: NOW });
    return r.ok && r.link_review.replaced_id === null && st(H, 'pending').length === 1 && st(H, 'pending')[0].id !== old &&
           st(H, 'pending')[0].url === 'https://h-wait.example/' && DP.approve(db, old, { adminId, now: NOW + 1 }).code === 'not_pending';
  })());

  liveLink(F, 'https://f-live.example', NOW - 900);
  DP.submitName(db, F, 'Effie', { isDonor: true, rule, now: NOW - 800 * 86400 });
  DP.approve(db, st(F, 'pending')[0].id, { adminId, now: NOW - 100 });
  const fLive = st(F, 'approved')[0].id;
  DP.removeLive(db, F, 'name', { adminId, reason: 'r', now: NOW - 90 });
  check('an ADMIN removal of the name does not touch the link', st(F, 'approved')[0].id === fLive && st(F, 'pending').length === 0);
  DP.submitName(db, F, 'Effie Two', { isDonor: true, rule, now: NOW - 80 });
  DP.approve(db, st(F, 'pending')[0].id, { adminId, now: NOW - 70 });
  const fLive2 = st(F, 'approved')[0].id;
  DP.removeLive(db, F, 'name', { now: NOW - 60 });
  check('the donor removing their own name does not touch the link', st(F, 'approved')[0].id === fLive2 && st(F, 'pending').length === 0);
  check('a name BAN that strips a live name does not touch the link', (() => {
    const G = ADDR('j'); mk(G); donate(G, NOW - 3600);
    DP.submitName(db, G, 'Banme Co', { isDonor: true, rule, now: NOW - 800 * 86400 });
    liveLink(G, 'https://g-live.example', NOW - 50);
    const before = st(G, 'approved')[0].id;
    const b = DP.banName(db, 'Banme Co', { adminId, now: NOW });
    return b.ok && b.removed.length === 1 && st(G, 'approved').length === 1 && st(G, 'approved')[0].id === before;
  })());
  check('setting a name again after a removal counts as a first-ever name (re-review fires)', (() => {
    const r = DP.submitName(db, F, 'Effie Three', { isDonor: true, rule, now: NOW + 8 * 86400 });
    return r.ok && r.link_review && st(F, 'approved').length === 0 && st(F, 'pending').length === 1;
  })());

  // ══ 5. Reads: the wall, expiry, a stored row that no longer validates ═══════════════════════
  console.log('\n[5] reads\n');
  db.exec('DELETE FROM donor_requests; DELETE FROM balance_log; DELETE FROM donor_blocks;');
  const ds = DN.donorSettings({ donor_banner_slots: 1 }, '');
  const W = ['k', 'm', 'n', 'p'].map(ADDR);
  W.forEach(mk);
  W.slice(0, 3).forEach((a, i) => donate(a, NOW - 3600 - i));            // league: three donors
  donate(W[3], NOW - 400 * 86400);                                         // past strip
  W.forEach((a) => liveLink(a, `https://${a.slice(-3)}.example`, NOW - 500));
  const w = DL.donorWall(db, { ds, H: 0, now: NOW, active: true, mask: (x) => x });
  check('wall: a link on EVERY league card, beyond the banner slots too (rank 1..3 with slots = 1)',
        w.league.length === 3 && w.league.every((c) => c.link && c.link.kind === 'web' && c.link.url === `https://${c.address.slice(-3)}.example/`) &&
        w.league.some((c) => c.rank > ds.bannerSlots));
  check('wall: NEVER on the past strip — the key is there, always null', w.past.donors.length === 1 && 'link' in w.past.donors[0] && w.past.donors[0].link === null);
  check('wall: the card link is exactly { url, host, kind }', Object.keys(w.league[0].link).sort().join() === 'host,kind,url');
  check('wall: a nostr link and an onion link carry their kinds', (() => {
    DP.removeLive(db, W[0], 'link', { now: NOW });
    DP.removeLive(db, W[1], 'link', { now: NOW });
    liveLink(W[0], 'nostr:' + NPUB, NOW - 10);
    liveLink(W[1], 'http://' + O56 + '.onion', NOW - 10);
    const x = DL.donorWall(db, { ds, H: 0, now: NOW, active: true, mask: (y) => y });
    const by = (a) => x.league.find((c) => c.address === a).link;
    return by(W[0]).kind === 'nostr' && by(W[0]).host === NPUB.slice(0, 9) + ch(0x2026) + NPUB.slice(-4) && by(W[1]).kind === 'onion';
  })());
  check('expiry: the same donation-recency rule as name and banner (12 months)', (() => {
    const later = NOW + 400 * 86400;
    const x = DL.donorWall(db, { ds, H: 0, now: later, active: true, mask: (y) => y });
    return x.league.concat(x.past.donors).every((c) => c.link === null) && own(W[2], { now: later, lastDonatedAt: NOW - 3600 }).link.state === 'expired' &&
           own(W[2], { now: later, lastDonatedAt: NOW - 3600 }).link.live === null;
  })());
  // A row written by hand or by an older build: the reads re-validate and drop it.
  db.prepare("UPDATE donor_requests SET url = 'javascript:alert(document.cookie)' WHERE grin_address = ? AND kind = 'link' AND status = 'approved'").run(W[2]);
  check('a stored approved javascript: url reaches NO page — wall, own view, admin list',
        DL.donorWall(db, { ds, H: 0, now: NOW, active: true, mask: (y) => y }).league.find((c) => c.address === W[2]).link === null &&
        own(W[2]).link.live === null && own(W[2]).link.state === 'none' &&
        DP.adminProfiles(db, { now: NOW, lastDonatedAt: () => NOW }).get(W[2]).link === null &&
        DP.publicProfiles(db, [W[2]], { now: NOW }).get(W[2]).link === null);
  check('a stored url not in its normalised form is dropped too (https://X.example has no trailing slash)', (() => {
    db.prepare("UPDATE donor_requests SET url = 'https://X.example' WHERE grin_address = ? AND kind = 'link' AND status = 'approved'").run(W[2]);
    return DP.publicProfiles(db, [W[2]], { now: NOW }).get(W[2]).link === null;
  })());
  check('approve refuses a stored pending url that does not validate → invalid_link, nothing goes live', (() => {
    const H = ADDR('r'); mk(H);
    const id = Number(db.prepare("INSERT INTO donor_requests (grin_address, kind, status, url, submitted_at) VALUES (?, 'link', 'pending', 'data:text/html,x', ?)").run(H, NOW).lastInsertRowid);
    const r = DP.approve(db, id, { adminId, now: NOW });
    return r.code === 'invalid_link' && db.prepare('SELECT status FROM donor_requests WHERE id = ?').get(id).status === 'pending';
  })());

  // ══ 6. Admin reads ════════════════════════════════════════════════════════════════════════
  console.log('\n[6] admin queue + admin list\n');
  const P = ADDR('s'), Q = ADDR('t'), R = ADDR('u');
  [P, Q, R].forEach((a) => { mk(a); donate(a, NOW - 3600); });
  DP.submitName(db, P, 'Pat', { isDonor: true, rule, now: NOW - 99 });
  liveLink(Q, 'https://shared.example/q', NOW - 90);
  const pending0 = DP.pendingCount(db);
  DP.submitLink(db, P, 'https://shared.example/p', { isDonor: true, now: NOW - 50 });
  DP.submitLink(db, R, 'https://alone.example', { isDonor: true, now: NOW - 40 });
  const q = DP.adminQueue(db, { kind: 'link' });
  const qp = q.rows.find((r) => r.address === P), qr = q.rows.find((r) => r.address === R);
  check('queue: ?kind=link holds links only; the pending count (nav badge) includes them',
        q.ok && q.rows.every((r) => r.kind === 'link') && DP.pendingCount(db) === pending0 + 2);
  check('queue: a link row carries the STORED url, its host and kind, and the donor\'s CURRENT live name',
        qp.url === 'https://shared.example/p' && qp.host === 'shared.example' && qp.link_kind === 'web' && qp.live_name === 'Pat');
  check('queue: a donor with no name reads live_name null (the page says "(no name)")', qr.live_name === null);
  check('queue: a host equal to another donor\'s LIVE link is flagged (a hint only)', qp.same_host_as.join() === Q && qr.same_host_as.length === 0);
  check('queue: link rows carry no image fields and has_image false', [qp, qr].every((r) => r.mime === null && r.width === null && r.has_image === false && r.name === null));
  check('queue: a replacement shows the current LIVE link', (() => {
    DP.submitLink(db, Q, 'https://new.example', { isDonor: true, now: NOW - 30 });
    const r = DP.adminQueue(db, { kind: 'link' }).rows.find((x) => x.address === Q);
    return r.current && r.current.url === 'https://shared.example/q';
  })());
  check('admin list: link + pending.link per address', (() => {
    const pr = DP.adminProfiles(db, { now: NOW, lastDonatedAt: () => NOW - 3600 });
    return pr.get(Q).link.url === 'https://shared.example/q' && pr.get(Q).link.state === 'shown' && pr.get(Q).pending.link === true &&
           pr.get(P).link === null && pr.get(P).pending.link === true;
  })());
  check('a public read never carries the pending URL (wall + own view, every address above)', (() => {
    const pub = JSON.stringify([DL.donorWall(db, { ds, H: 0, now: NOW, active: true, mask: (y) => y }), own(P), own(Q), own(R)]);
    return !pub.includes('shared.example/p') && !pub.includes('alone.example') && !pub.includes('new.example') && pub.includes('shared.example/q');
  })());

  // ══ 7. Wiring, read as text ═══════════════════════════════════════════════════════════════
  console.log('\n[7] route + API-doc wiring\n');
  const rLink = routeSource('post', '/api/account/:addr/donor-profile/link');
  const rName = routeSource('post', '/api/account/:addr/donor-profile/name');
  const rDel = routeSource('delete', '/api/account/:addr/donor-profile/:kind');
  check('route: POST …/donor-profile/link exists, rate-limited as withdraw, BOTH proofs with the donor_profile wording',
        rLink.includes("rateLimiter.middleware('withdraw')") && rLink.includes("requireBothProofs(addr, req.body, reqIp, 'donor_profile_submit', 'donor_profile')"));
  check('route: the link POST answers status pending and echoes only what the caller sent (normalised)',
        rLink.includes("status: 'pending', url: r.url, host: r.host, link_kind: r.link_kind"));
  check('route: DELETE …/:kind takes its closed enum from DonorProfiles.KINDS (link included)',
        rDel.includes('DonorProfiles.KINDS.includes(kind)') && DP.KINDS.join() === 'name,banner,link');
  check('route: the name POST tells the donor a live link went back to review',
        rName.includes('link_review: !!(r.link_review && r.link_review.replaced_id)'));
  const src = readAppSource();
  const meta = (k) => { const i = src.indexOf(`'${k}': {`); return i < 0 ? '' : src.slice(i, src.indexOf('\n', i)); };
  check('API docs: the link POST row exists and names every reason code',
        ['link_empty', 'link_too_long', 'link_chars', 'link_scheme', 'link_host', 'link_userinfo', 'link_nostr', 'unchanged']
          .every((c) => meta('POST /api/account/:addr/donor-profile/link').includes(c)));
  check('API docs: DELETE says kind = name | banner | link; the wall and account rows document link',
        meta('DELETE /api/account/:addr/donor-profile/:kind').includes('kind = name | banner | link') &&
        meta('GET /api/pool/donors').includes('banner, link, address') && meta('GET /api/account/:addr').includes('link: { live: { url, host, kind'));
  check('API docs: the link POST row names links_unavailable', meta('POST /api/account/:addr/donor-profile/link').includes('links_unavailable'));
  {
    const adminJs = fs.readFileSync(path.join(APP, 'admin-panel/js/donors.js'), 'utf8');
    const adminHtml = fs.readFileSync(path.join(APP, 'admin-panel/donors.html'), 'utf8');
    check('admin: the "same host as" list badge wraps (.badge is nowrap — a list in one would scroll the table sideways)',
          /badge badge-warn req-badge-wrap" title=[^\n]*same host as/.test(adminJs) && /\.req-badge-wrap\s*\{[^}]*white-space:\s*normal/.test(adminHtml));
    check('admin: a link decision reports into the link section, a banner decision into the banner one',
          adminJs.includes("const msg = r.kind === 'link' ? 'link-queue-msg' : 'queue-msg';") &&
          adminJs.includes('approveRequest(el.dataset.id, el.dataset.msg)') && adminJs.includes('rejectRequest(el.dataset.id, el.dataset.msg)'));
  }
  check('route: links_unavailable is answered BEFORE the proofs (a pool fact, not an address fact)',
        rLink.indexOf('linksSupported(db)') > 0 && rLink.indexOf('linksSupported(db)') < rLink.indexOf('requireBothProofs('));
  check('route: a link withdraw/remove audit row carries the host, never the URL',
        rDel.includes("kind === 'link' ? { kind, request_id: r.id, host: r.host,") && !/details[^\n]*url/.test(rDel));
  // A rebuild that failed at startup leaves the old CHECK: the donor must not be told "saved at the same moment".
  {
    const Z = ADDR('z'); mk(Z); donate(Z, NOW - 3600);
    const okBefore = DP.linksSupported(db);
    db.exec(`DROP TABLE donor_requests; CREATE TABLE donor_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, grin_address TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('name','banner')), status TEXT NOT NULL, name TEXT, image BLOB, file TEXT, mime TEXT, width INTEGER,
      height INTEGER, bytes INTEGER, sha256 TEXT, url TEXT, submitted_at INTEGER NOT NULL, decided_at INTEGER, decided_by INTEGER, reason TEXT)`);
    const r = DP.submitLink(db, Z, 'https://example.org', { isDonor: true, now: NOW });
    check('old kind CHECK (failed rebuild): a link submit says links_unavailable, not conflict',
          okBefore === true && DP.linksSupported(db) === false && r.ok === false && r.code === 'links_unavailable');
  }

  // ══ Terms/Privacy on an EXISTING install (lib/db.js seedShippedPages UPDATES) ══════════════════
  console.log('\n[legal] the External-links clauses reach an existing, unedited install\n');
  closeDb();
  {
    const PAGES = require(path.join(APP, 'lib/pool-settings.js')).defaults.pages;
    const prevTerms = PAGES.terms.replace(/<h2>10\. External links and user content<\/h2>\n<p>[^\n]*<\/p>\n\n/, '')
      .replace('<h2>11. Contact</h2>', '<h2>10. Contact</h2>').trim();
    const prevPrivacy = PAGES.privacy.replace(/<p><strong>External links\.<\/strong>[^\n]*<\/p>\n/, '').trim();
    check('fixture: the previous texts really lack the clauses', !prevTerms.includes('External links') && !prevPrivacy.includes('External links'));
    const FILE4 = path.join(TMP, 'pages.sqlite');
    let lg = quiet(() => initDb(FILE4));
    let d = getDb();
    const html = (slug) => d.prepare('SELECT html FROM pages WHERE slug = ?').get(slug).html;
    check('fresh install: the clauses are there and nothing is logged about them',
          html('terms').includes('10. External links and user content') && html('privacy').includes('<strong>External links.</strong>') &&
          !lg.some((l) => /External links/.test(l[1])));
    // An install from the previous release: terms unedited, privacy edited by the operator.
    d.prepare('UPDATE pages SET html = ? WHERE slug = ?').run(prevTerms, 'terms');
    d.prepare('UPDATE pages SET html = ? WHERE slug = ?').run(prevPrivacy + '\n<p>Operator addition.</p>', 'privacy');
    d.exec("DELETE FROM pool_config WHERE section = '_migrations' AND key LIKE 'pages_updated_%'");
    closeDb();
    lg = quiet(() => initDb(FILE4));
    d = getDb();
    check('existing install: the UNEDITED terms page takes the new default (§10 links, §11 contact)',
          html('terms') === PAGES.terms.trim() && lg.some((l) => /page "terms".*updated/.test(l[1])));
    check('existing install: the EDITED privacy page is untouched, and the operator is told',
          html('privacy') === prevPrivacy + '\n<p>Operator addition.</p>' && lg.some((l) => /page "privacy" was edited, so it was NOT updated/.test(l[1])));
    closeDb();
    lg = quiet(() => initDb(FILE4));
    check('the next start: both markers set, nothing logged, nothing changed',
          !lg.some((l) => /page "/.test(l[1])) && getDb().prepare("SELECT html FROM pages WHERE slug = 'privacy'").get().html.endsWith('Operator addition.</p>'));
    closeDb();
  }
} finally {
  try { closeDb(); } catch (_) { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
