'use strict';

// Donor profiles (design §18.4–§18.6, §18 Part 2) — lib/donor-profiles.js against an in-memory
// copy of the real schema. Covers: the name rules (length, charset, whitespace collapse, case
// kept, homoglyph / bidi / NBSP / zero-width refused); the banner sniff + header-parsed
// dimensions on hand-built minimal PNG / GIF / JPEG buffers, truncated and lying headers, SVG,
// WEBP, over-size and wrong-aspect images, and a fuzz pass that must never throw; every state
// transition, including both partial unique indexes and a real constraint hit mapped to
// `conflict`; the approved-banner file writes (one file, 0644, a second approval deletes the
// first, a failed write leaves the request pending); the donor's own view never carrying the
// pending name, image bytes or the deciding admin; the public view excluding pending / rejected /
// expired; the donor_banner_slots setting bounded on read and write; leagueRank(); and (§18
// Part 3) the admin reads: the review queue with its flags, the image-bytes read and its
// refusals, the per-address admin view, the pending count, and a block emptying the queue.
// Run: node scripts/test-donor-profiles.js   (no server; temp dirs under the OS temp dir, removed)

const path = require('path');
const fs = require('fs');
const os = require('os');
const APP = path.resolve(__dirname, '..');

const { initDb, getDb } = require(path.join(APP, 'lib/db.js'));
initDb(':memory:');
const db = getDb();

const DP = require(path.join(APP, 'lib/donor-profiles.js'));
const DN = require(path.join(APP, 'lib/donor-names.js'));
const DL = require(path.join(APP, 'lib/donor-ledger.js'));
const PoolSettings = require(path.join(APP, 'lib/pool-settings.js'));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else      { fail++; console.error(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}
const throws = (fn) => { try { fn(); return false; } catch (_) { return true; } };

const NOW = 1_800_000_000;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'donor-profiles-'));
const UP = path.join(TMP, 'uploads');
const DONORS = path.join(UP, 'donors');
const donorFiles = () => (fs.existsSync(DONORS) ? fs.readdirSync(DONORS).sort() : []);

// ── image builders (minimal, header-accurate; nothing here decodes pixels) ─────────────────
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u16l = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(w, h, opts = {}) {
  const ihdr = Buffer.concat([u32(opts.len === undefined ? 13 : opts.len), Buffer.from(opts.type || 'IHDR'),
    u32(w), u32(h), Buffer.from([8, 6, 0, 0, 0]), u32(0)]);
  const iend = Buffer.concat([u32(0), Buffer.from('IEND'), u32(0xae426082)]);
  return Buffer.concat([PNG_SIG, ihdr, iend]);
}
function gif(w, h, ver = '89a') {
  return Buffer.concat([Buffer.from('GIF' + ver), u16l(w), u16l(h), Buffer.from([0x00, 0x00, 0x00]), Buffer.from([0x3b])]);
}
const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker]), u16(payload.length + 2), payload]);
function jpeg(w, h, opts = {}) {
  const app0 = seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary'));
  const dqt = seg(0xdb, Buffer.alloc(65, 1));
  const dht = seg(0xc4, Buffer.alloc(20, 0));            // C4 is DHT, NOT a frame header
  const sof = seg(opts.sof || 0xc0, Buffer.concat([Buffer.from([8]), u16(h), u16(w), Buffer.from([1, 1, 0x11, 0])]));
  const parts = [Buffer.from([0xff, 0xd8]), app0, dqt];
  if (opts.fill) parts.push(Buffer.from([0xff, 0xff]));  // fill bytes before a marker are legal
  if (opts.dhtFirst) parts.push(dht);
  parts.push(sof, seg(0xda, Buffer.alloc(10, 0)), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="800" height="200"><script>alert(1)</script></svg>');
const WEBP = Buffer.concat([Buffer.from('RIFF'), u32(100), Buffer.from('WEBPVP8 '), Buffer.alloc(40, 0)]);

// ── fixtures ────────────────────────────────────────────────────────────────────────────────
const ADDR = (c) => 'grin1' + c.repeat(58);
const mkAcct = (a) => db.prepare('INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES (?, 0)').run(a);
const adminId = Number(db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES ('op', 'x', 1)").run().lastInsertRowid);
const rowsOf = (a, kind) => db.prepare('SELECT * FROM donor_requests WHERE grin_address = ? AND kind = ? ORDER BY id').all(a, kind);
const byStatus = (a, kind, st) => rowsOf(a, kind).filter((r) => r.status === st);
const auditOf = (a) => db.prepare("SELECT admin_id, action, details FROM admin_audit_log WHERE target_type = 'donor' AND target_id = ? ORDER BY id").all(a);
const DONOR = { isDonor: true, now: NOW };

// Walk any value; true when a Buffer / typed array appears anywhere in it.
const hasBytes = (v) => {
  if (v && (Buffer.isBuffer(v) || ArrayBuffer.isView(v))) return true;
  if (v && typeof v === 'object') return Object.values(v).some(hasBytes);
  return false;
};

// Invisible / look-alike characters, built from code points so the source file holds none of them.
const CYR_A = String.fromCharCode(0x410);   // Cyrillic capital A, looks like Latin A
const RLO = String.fromCharCode(0x202e);    // right-to-left override
const NBSP = String.fromCharCode(0xa0);     // no-break space
const ZWSP = String.fromCharCode(0x200b);   // zero-width space

try {
  // ══ 1. Name rules (§18.5) ══════════════════════════════════════════════════════════════
  console.log('\n[1] name rules\n');
  const vn = (s) => DP.validateName(s);
  check('name: 2 chars is the minimum', vn('ab').ok && !vn('a').ok && vn('a').code === 'name_length');
  check('name: 32 chars is the maximum', vn('a'.repeat(32)).ok && vn('a'.repeat(33)).code === 'name_length');
  check('name: trim + internal whitespace collapses to one space', vn('  My \t  Brand \n ').name === 'My Brand');
  check('name: the collapse happens BEFORE the length check (34 raw → 32 kept)',
        vn(' ' + 'a'.repeat(15) + '   ' + 'b'.repeat(15) + ' ').ok);
  check('name: case is kept', vn('ACME Mining').name === 'ACME Mining');
  check("name: - _ . & ' are allowed (a domain, an ampersand, an apostrophe)",
        vn("O'Neil & Sons").ok && vn('grin.money').ok && vn('rig_farm-01').ok);
  check('name: no letter or digit → name_no_alnum', vn('-- __').code === 'name_no_alnum' && vn("..&'").code === 'name_no_alnum');
  check('name: Cyrillic homoglyph refused', vn(CYR_A + 'cme').code === 'name_charset');
  check('name: RTL override refused', vn('abc' + RLO + 'def').code === 'name_charset');
  check('name: NBSP is NOT collapsed into a space — refused', vn('a' + NBSP + 'b').code === 'name_charset');
  check('name: zero-width space refused', vn('ab' + ZWSP + 'cd').code === 'name_charset');
  check('name: emoji refused', vn('grin \u{1F680}').code === 'name_charset');
  check('name: < > " refused (no markup survives even if a renderer forgets to escape)',
        vn('<b>x</b>').code === 'name_charset' && vn('a"b').code === 'name_charset');
  check('name: a non-string is refused, not coerced', vn(12345).code === 'name_invalid' && vn({ a: 1 }).code === 'name_invalid' && vn(['ab']).code === 'name_invalid');
  check('name: null / undefined / empty → name_length', vn(null).code === 'name_length' && vn(undefined).code === 'name_length' && vn('   ').code === 'name_length');
  check('name: every refusal carries the rule in its message', ['a', CYR_A + 'cme', '--'].every((s) => /2–32 characters/.test(vn(s).error)));

  // ══ 2. Sniff + dimensions (§18.5) ══════════════════════════════════════════════════════
  console.log('\n[2] banner sniff + dimensions\n');
  const vb = (b) => DP.validateBanner(b);
  const good = vb(png(800, 200));
  check('png 800×200 accepted with dims, mime, bytes, sha256',
        good.ok && good.ext === 'png' && good.mime === 'image/png' && good.width === 800 && good.height === 200 &&
        good.bytes === png(800, 200).length && /^[0-9a-f]{64}$/.test(good.sha256));
  check('gif89a 800×200 accepted', vb(gif(800, 200)).ok && vb(gif(800, 200)).ext === 'gif');
  check('gif87a accepted', vb(gif(640, 160, '87a')).ok);
  const j = vb(jpeg(800, 200));
  check('jpeg (APP0 + DQT before SOF0) accepted with dims', j.ok && j.ext === 'jpg' && j.mime === 'image/jpeg' && j.width === 800 && j.height === 200);
  check('jpeg: a DHT (C4) before the frame is skipped, not read as SOF', (() => {
    const r = vb(jpeg(800, 200, { dhtFirst: true })); return r.ok && r.width === 800 && r.height === 200;
  })());
  check('jpeg: progressive SOF2 accepted', vb(jpeg(1200, 300, { sof: 0xc2 })).ok);
  check('jpeg: fill bytes before a marker tolerated', vb(jpeg(800, 200, { fill: true })).ok);
  check('jpeg: dims are read as height-then-width (a 400×100 is not 100×400)',
        DP.parseDimensions(jpeg(400, 100), 'jpg').width === 400);
  check('svg refused as banner_type (never sniffed as an image)', vb(SVG).code === 'banner_type');
  check('webp refused as banner_type', vb(WEBP).code === 'banner_type');
  check('random text refused', vb(Buffer.from('hello world, not an image at all')).code === 'banner_type');
  check('empty / missing → banner_missing', vb(Buffer.alloc(0)).code === 'banner_missing' && vb(null).code === 'banner_missing');
  check('truncated png (20 bytes) → banner_unreadable', vb(png(800, 200).subarray(0, 20)).code === 'banner_unreadable');
  check('png with a bogus first chunk (IHDX) → unreadable', vb(png(800, 200, { type: 'IHDX' })).code === 'banner_unreadable');
  check('png with IHDR length ≠ 13 → unreadable', vb(png(800, 200, { len: 12 })).code === 'banner_unreadable');
  check('png zero width → unreadable', vb(png(0, 200)).code === 'banner_unreadable');
  check('png 0xFFFFFFFF wide → dimensions refusal, no throw', vb(png(0xffffffff, 200)).code === 'banner_dimensions');
  check('truncated gif (8 bytes) → refused', !vb(gif(800, 200).subarray(0, 8)).ok);
  check('gif zero height → unreadable', vb(gif(800, 0)).code === 'banner_unreadable');
  const jl = jpeg(800, 200);
  check('truncated jpeg (cut inside APP0) → unreadable', vb(jl.subarray(0, 12)).code === 'banner_unreadable');
  check('jpeg with a segment length pointing past the end → unreadable', (() => {
    const b = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xf0, 0x4a, 0x46, 0x49, 0x46, 0, 0]);
    return vb(b).code === 'banner_unreadable';
  })());
  check('jpeg with a zero-length segment → unreadable', vb(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0, 0, 0, 0])).code === 'banner_unreadable');
  check('jpeg: SOS before any frame → unreadable', vb(Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xda, Buffer.alloc(8)), Buffer.from([0xff, 0xd9])])).code === 'banner_unreadable');
  check('jpeg: SOF cut short (header present, dims missing) → unreadable', (() => {
    const b = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00])]);
    return vb(b).code === 'banner_unreadable';
  })());
  check('over-size (300 KB + 1) → banner_too_large before any sniff', (() => {
    const b = Buffer.concat([png(800, 200), Buffer.alloc(DP.MAX_BANNER_BYTES + 1 - png(800, 200).length)]);
    return vb(b).code === 'banner_too_large';
  })());
  check('exactly 300 KB is accepted', (() => {
    const b = Buffer.concat([png(800, 200), Buffer.alloc(DP.MAX_BANNER_BYTES - png(800, 200).length)]);
    return vb(b).ok;
  })());
  check('square 400×400 → banner_aspect', vb(png(400, 400)).code === 'banner_aspect');
  check('1600×150 (10.7:1) → banner_aspect', vb(png(1600, 150)).code === 'banner_aspect');
  check('2:1 and 8:1 are both inside the range', vb(png(800, 400)).ok && vb(png(1600, 200)).ok);
  check('1601 wide → banner_dimensions', vb(png(1601, 400)).code === 'banner_dimensions');
  check('319 wide / 79 high / 401 high → banner_dimensions',
        vb(png(319, 100)).code === 'banner_dimensions' && vb(png(640, 79)).code === 'banner_dimensions' && vb(png(1600, 401)).code === 'banner_dimensions');
  check('a Uint8Array (what node:sqlite hands back) validates like a Buffer', vb(new Uint8Array(png(800, 200))).ok);
  check('every refusal message states the rule', ['banner_type', 'banner_unreadable', 'banner_aspect'].every((c) => {
    const r = c === 'banner_type' ? vb(SVG) : c === 'banner_unreadable' ? vb(png(0, 1)) : vb(png(400, 400));
    return /800 × 200 recommended/.test(r.error);
  }));

  // Fuzz: truncations of every valid sample at every length, plus random bytes behind each
  // signature. The contract is "never throws, and anything accepted has in-range dims".
  let threw = 0, badAccept = 0, n = 0;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed & 0xff; };
  const samples = [png(800, 200), gif(800, 200), gif(640, 160, '87a'), jpeg(800, 200), jpeg(800, 200, { dhtFirst: true, fill: true })];
  const sigs = [PNG_SIG, Buffer.from('GIF89a'), Buffer.from([0xff, 0xd8, 0xff])];
  const probe = (b) => {
    n++;
    try {
      const r = vb(b);
      if (r.ok && !(r.width >= 320 && r.width <= 1600 && r.height >= 80 && r.height <= 400)) badAccept++;
      for (const ext of ['png', 'gif', 'jpg', 'svg', undefined]) DP.parseDimensions(b, ext);
    } catch (_) { threw++; }
  };
  for (const s of samples) for (let len = 0; len <= s.length; len++) probe(s.subarray(0, len));
  for (let k = 0; k < 3000; k++) {
    const sig = sigs[k % sigs.length];
    const tail = Buffer.alloc(k % 64);
    for (let i = 0; i < tail.length; i++) tail[i] = rnd();
    probe(Buffer.concat([sig, tail]));
  }
  check(`fuzz: ${n} truncated / random inputs — none throws`, threw === 0, `${threw} threw`);
  check('fuzz: nothing accepted outside the dimension bounds', badAccept === 0, `${badAccept} bad`);

  // ══ 3. State machine (§18.4) ═══════════════════════════════════════════════════════════
  console.log('\n[3] state machine\n');
  const A = ADDR('a'); mkAcct(A);
  const B = ADDR('b'); mkAcct(B);

  check('submit: unknown address → not_found', DP.submitName(db, ADDR('z'), 'Nobody', DONOR).code === 'not_found');
  check('submit: isDonor absent → not_a_donor (fail closed)', DP.submitName(db, A, 'Acme', { now: NOW }).code === 'not_a_donor');
  check('submit: isDonor truthy-but-not-true → not_a_donor', DP.submitName(db, A, 'Acme', { isDonor: 1, now: NOW }).code === 'not_a_donor');
  check('submit: an invalid name is refused before any write', DP.submitName(db, A, 'x', DONOR).code === 'name_length' && rowsOf(A, 'name').length === 0);

  const s1 = DP.submitName(db, A, '  Acme   Pool Fans ', DONOR);
  check('submit: → pending, normalised name returned to the submitter', s1.ok && s1.name === 'Acme Pool Fans' && s1.replaced === false && s1.submitted_at === NOW);
  const s2 = DP.submitName(db, A, 'Acme Fans', DONOR);
  check('submit again: the old pending → replaced, the new one pending', s2.ok && s2.replaced === true &&
        byStatus(A, 'name', 'pending').length === 1 && byStatus(A, 'name', 'replaced').length === 1 &&
        byStatus(A, 'name', 'pending')[0].name === 'Acme Fans');

  check('unique index: a second PENDING row for the same (address, kind) is refused by the DB',
        throws(() => db.prepare("INSERT INTO donor_requests (grin_address, kind, status, name) VALUES (?, 'name', 'pending', 'dup')").run(A)));
  check('unique index: pending name + pending banner may coexist (per KIND)', (() => {
    const r = DP.submitBanner(db, A, png(800, 200), DONOR);
    return r.ok && byStatus(A, 'banner', 'pending').length === 1 && byStatus(A, 'name', 'pending').length === 1;
  })());
  check('banner submit stores bytes + dims + sniffed mime, never a file', (() => {
    const r = byStatus(A, 'banner', 'pending')[0];
    return r.image && r.image.length === png(800, 200).length && r.mime === 'image/png' && r.width === 800 && r.height === 200 && r.file === null;
  })());
  check('banner resubmit: the replaced row loses its blob', (() => {
    DP.submitBanner(db, A, gif(800, 200), DONOR);
    const rep = byStatus(A, 'banner', 'replaced');
    return rep.length === 1 && rep[0].image === null && byStatus(A, 'banner', 'pending')[0].mime === 'image/gif';
  })());
  check('banner submit: an SVG never reaches the table', DP.submitBanner(db, A, SVG, DONOR).code === 'banner_type' && rowsOf(A, 'banner').length === 2);

  // A REAL constraint hit, not a fake one: a temp trigger inserts a competing pending row the
  // moment the old one is marked replaced, so the lib's own INSERT hits uq_donor_req_pending.
  db.exec(`CREATE TEMP TRIGGER t_race AFTER UPDATE OF status ON donor_requests
           WHEN NEW.status = 'replaced' AND NEW.kind = 'name'
           BEGIN INSERT INTO donor_requests (grin_address, kind, status, name) VALUES (NEW.grin_address, 'name', 'pending', 'racer'); END`);
  const race = DP.submitName(db, A, 'Loser', DONOR);
  db.exec('DROP TRIGGER t_race');
  check('conflict: a unique-index hit comes back as code conflict, not a throw', race.ok === false && race.code === 'conflict');
  check('conflict: the transaction rolled back (the previous pending is still the pending one)',
        byStatus(A, 'name', 'pending').length === 1 && byStatus(A, 'name', 'pending')[0].name === 'Acme Fans' &&
        !rowsOf(A, 'name').some((r) => r.name === 'racer' || r.name === 'Loser'));

  // withdraw
  check('withdraw: bad kind', DP.withdraw(db, A, 'avatar').code === 'bad_kind');
  const w = DP.withdraw(db, A, 'banner', { now: NOW + 5 });
  check('withdraw: pending → withdrawn, blob NULLed', w.ok && byStatus(A, 'banner', 'withdrawn').length === 1 &&
        byStatus(A, 'banner', 'withdrawn')[0].image === null && byStatus(A, 'banner', 'pending').length === 0);
  check('withdraw: nothing pending → nothing_pending', DP.withdraw(db, A, 'banner').code === 'nothing_pending');

  // approve / reject — ids
  check('approve: bad ids refused', ['abc', '-1', '0', '1.5', '', null, 1e300, '99999999999999999999'].every((x) => DP.approve(db, x, { adminId }).code === 'bad_id'));
  check('approve: unknown id → not_found', DP.approve(db, 999999, { adminId }).code === 'not_found');
  check('approve: a non-pending row → not_pending', DP.approve(db, byStatus(A, 'banner', 'withdrawn')[0].id, { adminId, uploadsDir: UP }).code === 'not_pending');

  // approve a name
  const pendName = byStatus(A, 'name', 'pending')[0];
  const ap1 = DP.approve(db, String(pendName.id), { adminId, ip: '198.51.100.1', now: NOW + 10 });
  check('approve name: → approved, decided_by + decided_at set', ap1.ok && ap1.kind === 'name' &&
        byStatus(A, 'name', 'approved').length === 1 && byStatus(A, 'name', 'approved')[0].decided_by === adminId &&
        byStatus(A, 'name', 'approved')[0].decided_at === NOW + 10);
  check('approve name: audit row written in the same transaction', auditOf(A).some((r) => r.action === 'donor_request_approve' && r.admin_id === adminId));
  check('unique index: a second APPROVED row for the same (address, kind) is refused by the DB',
        throws(() => db.prepare("INSERT INTO donor_requests (grin_address, kind, status, name) VALUES (?, 'name', 'approved', 'dup')").run(A)));
  DP.submitName(db, A, 'Acme Two', DONOR);
  const ap2 = DP.approve(db, byStatus(A, 'name', 'pending')[0].id, { adminId, now: NOW + 20 });
  check('approve a second name: the previous approved → replaced, one approved remains',
        ap2.ok && ap2.replaced_id === pendName.id && byStatus(A, 'name', 'approved').length === 1 &&
        byStatus(A, 'name', 'approved')[0].name === 'Acme Two');
  check('approve: already approved → not_pending', DP.approve(db, byStatus(A, 'name', 'approved')[0].id, { adminId }).code === 'not_pending');

  // approve banners — files
  check('approve banner without uploadsDir is a programming error (throws)', (() => {
    DP.submitBanner(db, A, png(800, 200), DONOR);
    return throws(() => DP.approve(db, byStatus(A, 'banner', 'pending')[0].id, { adminId }));
  })());
  const b1 = DP.approve(db, byStatus(A, 'banner', 'pending')[0].id, { adminId, uploadsDir: UP, now: NOW + 30 });
  const files1 = donorFiles();
  check('approve banner: writes exactly one file under uploads/donors/', b1.ok && files1.length === 1 && /^[0-9a-f]{16}\.png$/.test(files1[0]) && b1.file === files1[0]);
  check('approve banner: the file holds the submitted bytes', fs.readFileSync(path.join(DONORS, files1[0])).equals(png(800, 200)));
  check('approve banner: the extension comes from the sniff (.png for PNG bytes)', files1[0].endsWith('.png'));
  if (process.platform !== 'win32') {
    check('approve banner: file mode 0644', (fs.statSync(path.join(DONORS, files1[0])).mode & 0o777) === 0o644);
  }
  check('approve banner: the row keeps file + dims, loses the blob', (() => {
    const r = byStatus(A, 'banner', 'approved')[0];
    return r.file === files1[0] && r.image === null && r.width === 800;
  })());
  DP.submitBanner(db, A, jpeg(1200, 300), DONOR);
  const b2 = DP.approve(db, byStatus(A, 'banner', 'pending')[0].id, { adminId, uploadsDir: UP, now: NOW + 40 });
  const files2 = donorFiles();
  check('second banner approve: the first file is DELETED, the new one written (.jpg)',
        b2.ok && !b2.warning && files2.length === 1 && files2[0] !== files1[0] && files2[0].endsWith('.jpg'));
  check('second banner approve: previous approved → replaced', byStatus(A, 'banner', 'replaced').some((r) => r.file === files1[0]));

  // a failed write leaves the request pending and writes nothing
  DP.submitBanner(db, A, gif(800, 200), DONOR);
  const blocker = path.join(TMP, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const bf = DP.approve(db, byStatus(A, 'banner', 'pending')[0].id, { adminId, uploadsDir: blocker });
  check('approve: an unwritable uploads dir → write_failed, request still pending WITH its blob',
        bf.code === 'write_failed' && byStatus(A, 'banner', 'pending').length === 1 && byStatus(A, 'banner', 'pending')[0].image !== null);
  check('approve: a failed write changes no approved row', byStatus(A, 'banner', 'approved')[0].file === files2[0]);

  // reject
  const rj = DP.reject(db, byStatus(A, 'banner', 'pending')[0].id, { adminId, reason: 'Too\u0007 bright,\n  please tone it down ' + 'x'.repeat(300), now: NOW + 50 });
  const rjRow = rowsOf(A, 'banner').find((r) => r.status === 'rejected');
  check('reject: → rejected, blob NULLed, audited', rj.ok && rjRow && rjRow.image === null && auditOf(A).some((r) => r.action === 'donor_request_reject'));
  check('reject: the reason is one line, control chars stripped, ≤ 200 chars',
        rjRow.reason.startsWith('Too bright, please tone it down') && rjRow.reason.length === 200 && !/[\u0000-\u001f]/.test(rjRow.reason));
  check('reject: empty reason stored as NULL', (() => {
    DP.submitName(db, B, 'Bee Name', DONOR);
    const r = DP.reject(db, byStatus(B, 'name', 'pending')[0].id, { adminId, reason: '   ' });
    return r.ok && rowsOf(B, 'name').slice(-1)[0].reason === null;
  })());
  check('reject: not pending → not_pending', DP.reject(db, rjRow.id, { adminId }).code === 'not_pending');

  // removeLive
  check('removeLive: bad kind', DP.removeLive(db, A, 'x').code === 'bad_kind');
  check('removeLive banner without uploadsDir throws (never resolves "undefined")', throws(() => DP.removeLive(db, A, 'banner')));
  const rmB = DP.removeLive(db, A, 'banner', { uploadsDir: UP, now: NOW + 60 });
  check('removeLive (donor) banner: → removed, file deleted, decided_by NULL',
        rmB.ok && rmB.file_deleted === true && donorFiles().length === 0 &&
        byStatus(A, 'banner', 'removed')[0].decided_by === null && byStatus(A, 'banner', 'approved').length === 0);
  check('removeLive (donor): no ADMIN audit row', !auditOf(A).some((r) => r.action === 'donor_profile_remove'));
  check('removeLive: nothing live → nothing_live', DP.removeLive(db, A, 'banner', { uploadsDir: UP }).code === 'nothing_live');

  // block / unblock
  DP.submitName(db, A, 'Acme Three', DONOR);
  DP.submitBanner(db, A, png(800, 200), DONOR);
  const bl = DP.block(db, A, { adminId, reason: 'spam', now: NOW + 70 });
  check('block: withdraws EVERY pending request of the address', bl.ok && bl.withdrawn === 2 &&
        byStatus(A, 'name', 'pending').length === 0 && byStatus(A, 'banner', 'pending').length === 0);
  check('block: withdrawn rows lose their blob', rowsOf(A, 'banner').every((r) => r.status === 'pending' || r.image === null));
  check('block: the live name is untouched (removal is a separate action)', byStatus(A, 'name', 'approved').length === 1);
  check('block: audited', auditOf(A).some((r) => r.action === 'donor_block' && JSON.parse(r.details).withdrawn === 2));
  check('block: a new submit → blocked', DP.submitName(db, A, 'Acme Four', DONOR).code === 'blocked' &&
        DP.submitBanner(db, A, png(800, 200), DONOR).code === 'blocked');
  check('block: twice → already', DP.block(db, A, { adminId }).code === 'already');
  check('block: unknown address → not_found', DP.block(db, ADDR('y'), { adminId }).code === 'not_found');
  check('approve refuses a blocked address\'s request (defence in depth)', (() => {
    db.prepare("INSERT INTO donor_requests (grin_address, kind, status, name) VALUES (?, 'name', 'pending', 'sneaky')").run(A);
    const id = byStatus(A, 'name', 'pending')[0].id;
    const r = DP.approve(db, id, { adminId });
    db.prepare("UPDATE donor_requests SET status = 'withdrawn' WHERE id = ?").run(id);
    return r.code === 'blocked';
  })());
  const ub = DP.unblock(db, A, { adminId });
  check('unblock: → submits accepted again, audited', ub.ok && DP.submitName(db, A, 'Acme Four', DONOR).ok && auditOf(A).some((r) => r.action === 'donor_unblock'));
  check('unblock: not blocked → not_blocked', DP.unblock(db, A, { adminId }).code === 'not_blocked');

  // admin remove with a reason
  const rmN = DP.removeLive(db, A, 'name', { adminId, reason: 'impersonates another donor', now: NOW + 80 });
  check('removeLive (admin) name: → removed with reason + decided_by, audited',
        rmN.ok && byStatus(A, 'name', 'removed')[0].reason === 'impersonates another donor' &&
        byStatus(A, 'name', 'removed')[0].decided_by === adminId && auditOf(A).some((r) => r.action === 'donor_profile_remove'));

  // ══ 4. profileFor — the donor's own (public) view ════════════════════════════════════
  console.log('\n[4] profileFor\n');
  const C = ADDR('c'); mkAcct(C);
  DP.submitName(db, C, 'Live Name', DONOR);
  DP.approve(db, byStatus(C, 'name', 'pending')[0].id, { adminId, now: NOW });
  DP.submitName(db, C, 'Secret Pending', DONOR);
  DP.submitBanner(db, C, png(800, 200), DONOR);
  DP.approve(db, byStatus(C, 'banner', 'pending')[0].id, { adminId, uploadsDir: UP, now: NOW });
  DP.submitBanner(db, C, gif(800, 200), { isDonor: true, now: NOW + 100 });
  const ds = DN.donorSettings({}, 'GRINIUM');
  const pf = DP.profileFor(db, C, { active: true, lastDonatedAt: NOW, slotRank: 3, ds, now: NOW + 3600 });
  const pfJson = JSON.stringify(pf);
  check('profileFor: live name shown', pf.name.live === 'Live Name' && pf.name.state === 'shown');
  check('profileFor: the PENDING name text is not anywhere in the object', !pfJson.includes('Secret Pending'));
  check('profileFor: pending reported by time only', pf.name.pending_at === NOW && pf.banner.pending_at === NOW + 100);
  check('profileFor: no Buffer / typed array anywhere', !hasBytes(pf));
  check('profileFor: no decided_by / image / sha256 / file key anywhere', !/decided_by|"image"|sha256|"file"/.test(pfJson));
  check('profileFor: banner live_url under /uploads/donors/ with dims', /^\/uploads\/donors\/[0-9a-f]{16}\.png$/.test(pf.banner.live_url) && pf.banner.width === 800 && pf.banner.height === 200);
  check('profileFor: slot_rank 3 of 5 → showing', pf.banner.slot_rank === 3 && pf.banner.slots === 5 && pf.banner.showing === true);
  check('profileFor: rank 8 of 5 → not showing (the page says "you\'re #8")',
        DP.profileFor(db, C, { active: true, lastDonatedAt: NOW, slotRank: 8, ds, now: NOW + 3600 }).banner.showing === false);
  check('profileFor: no rank (past strip) → not showing, slot_rank null',
        (() => { const p = DP.profileFor(db, C, { active: true, lastDonatedAt: NOW, slotRank: null, ds, now: NOW }); return p.banner.slot_rank === null && !p.banner.showing; })());
  check('profileFor: donor_banner_slots 0 → never showing',
        DP.profileFor(db, C, { active: true, lastDonatedAt: NOW, slotRank: 1, ds: DN.donorSettings({ donor_banner_slots: 0 }, ''), now: NOW }).banner.showing === false);
  check('profileFor: eligible = donations on AND a donation debit', pf.eligible === true && pf.refusal === null &&
        DP.profileFor(db, C, { active: false, lastDonatedAt: NOW, ds }).eligible === false &&
        DP.profileFor(db, C, { active: false, lastDonatedAt: NOW, ds }).refusal === 'donations_off' &&
        DP.profileFor(db, C, { active: true, lastDonatedAt: null, ds }).refusal === 'not_a_donor');
  check('profileFor: expired — approved + last debit both older than the expiry → state expired, live null',
        (() => { const p = DP.profileFor(db, C, { active: true, lastDonatedAt: NOW, ds, now: NOW + 400 * 86400 });
                 return p.name.state === 'expired' && p.name.live === null && p.banner.state === 'expired' && p.banner.live_url === null; })());
  check('profileFor: expiry 0 → never expires',
        DP.profileFor(db, C, { active: true, lastDonatedAt: NOW, ds: DN.donorSettings({ donor_name_expiry_months: 0 }, ''), now: NOW + 4000 * 86400 }).name.state === 'shown');
  check('profileFor: a recent donation keeps an old approval alive',
        DP.profileFor(db, C, { active: true, lastDonatedAt: NOW + 399 * 86400, ds, now: NOW + 400 * 86400 }).name.state === 'shown');
  check('profileFor: rejection reason reported while it is the newest word', (() => {
    DP.reject(db, byStatus(C, 'name', 'pending')[0].id, { adminId, reason: 'reserved word', now: NOW + 200 });
    const p = DP.profileFor(db, C, { active: true, lastDonatedAt: NOW, ds, now: NOW + 300 });
    return p.name.rejected && p.name.rejected.reason === 'reserved word' && p.name.rejected.at === NOW + 200 && p.name.live === 'Live Name';
  })());
  check('profileFor: a newer submission supersedes the rejection', (() => {
    DP.submitName(db, C, 'Another Try', DONOR);
    return DP.profileFor(db, C, { active: true, lastDonatedAt: NOW, ds }).name.rejected === null;
  })());
  check('profileFor: an ADMIN removal is reported with its reason; the donor\'s own is not', (() => {
    const pa = DP.profileFor(db, A, { active: true, lastDonatedAt: NOW, ds });
    const pb = DP.profileFor(db, A, { active: true, lastDonatedAt: NOW, ds }).banner.removed;
    return pa.name.removed && pa.name.removed.reason === 'impersonates another donor' && pb === null && pa.name.state === 'none';
  })());
  check('profileFor: the removal notice survives a waiting resubmission, and clears once one is approved', (() => {
    const before = DP.profileFor(db, A, { active: true, lastDonatedAt: NOW, ds }).name;   // 'Acme Four' is pending
    DP.approve(db, byStatus(A, 'name', 'pending')[0].id, { adminId, now: NOW + 90 });
    const after = DP.profileFor(db, A, { active: true, lastDonatedAt: NOW, ds, now: NOW + 100 }).name;
    return before.removed !== null && before.pending_at !== null && after.removed === null && after.live === 'Acme Four';
  })());
  check('profileFor: blocked reported', (() => {
    DP.block(db, B, { adminId });
    const p = DP.profileFor(db, B, { active: true, lastDonatedAt: NOW, ds });
    DP.unblock(db, B, { adminId });
    return p.blocked === true && p.refusal === 'blocked';
  })());
  check('profileFor: an address with nothing → none/none, no throw', (() => {
    const D = ADDR('d'); mkAcct(D);
    const p = DP.profileFor(db, D, { active: true, lastDonatedAt: null, ds });
    return p.name.state === 'none' && p.banner.state === 'none' && p.banner.live_url === null && p.eligible === false;
  })());

  // ══ 5. publicProfiles — the wall's view ═══════════════════════════════════════════════
  console.log('\n[5] publicProfiles\n');
  const E = ADDR('e'); mkAcct(E);   // pending only
  const F = ADDR('f'); mkAcct(F);   // rejected only
  const G = ADDR('g'); mkAcct(G);   // approved, will be expired
  DP.submitName(db, E, 'Pending Only', DONOR);
  DP.submitBanner(db, E, png(800, 200), DONOR);
  DP.submitName(db, F, 'Rejected Only', DONOR);
  DP.reject(db, byStatus(F, 'name', 'pending')[0].id, { adminId, reason: 'no' });
  DP.submitName(db, G, 'Old Name', DONOR);
  DP.approve(db, byStatus(G, 'name', 'pending')[0].id, { adminId, now: NOW - 800 * 86400 });
  const last = new Map([[C, NOW], [G, NOW - 800 * 86400]]);
  const pp = DP.publicProfiles(db, [C, E, F, G, 'grin1unknown', C], { ds, now: NOW + 3600, lastDonatedAt: last });
  const ppJson = JSON.stringify([...pp]);
  check('public: approved + unexpired name shown', pp.get(C).name === 'Live Name' && pp.get(C).name_state === 'shown');
  check('public: approved banner url + dims', pp.get(C).banner && /^\/uploads\/donors\//.test(pp.get(C).banner.url) && pp.get(C).banner.width === 800);
  check('public: pending name and pending banner excluded', pp.get(E).name === null && pp.get(E).name_state === 'masked' && pp.get(E).banner === null);
  check('public: rejected excluded', pp.get(F).name === null && pp.get(F).name_state === 'masked');
  check('public: expired → name null, state expired', pp.get(G).name === null && pp.get(G).name_state === 'expired');
  check('public: no pending/rejected text or reason anywhere', !/Pending Only|Rejected Only|Another Try|"no"|reserved word/.test(ppJson));
  check('public: no bytes, no decided_by', !hasBytes([...pp.values()]) && !/decided_by|sha256|image/.test(ppJson));
  check('public: unknown address → masked, duplicates collapsed', pp.get('grin1unknown').name_state === 'masked' && pp.size === 5);
  check('public: lastDonatedAt as a function works too',
        DP.publicProfiles(db, [G], { ds, now: NOW, lastDonatedAt: () => NOW }).get(G).name_state === 'shown');
  check('public: a stored file name that is not ours never becomes a URL', (() => {
    db.prepare("UPDATE donor_requests SET file = '../../etc/passwd' WHERE grin_address = ? AND kind = 'banner' AND status = 'approved'").run(C);
    const r = DP.publicProfiles(db, [C], { ds, now: NOW, lastDonatedAt: last }).get(C).banner;
    const p = DP.profileFor(db, C, { active: true, lastDonatedAt: NOW, ds, now: NOW }).banner.live_url;
    return r === null && p === null;
  })());
  check('public: empty input → empty map, no query error', DP.publicProfiles(db, [], {}).size === 0);

  // ══ 6. Settings: donor_banner_slots (§18.6, §18.9 type traps) ═════════════════════════
  console.log('\n[6] settings\n');
  const V = PoolSettings.validators.incentives;
  check('settings: donor_banner_slots in defaults (5) with a validator',
        PoolSettings.defaults.incentives.donor_banner_slots === 5 && typeof V.donor_banner_slots === 'function');
  check('settings: validator accepts 0..10', V.donor_banner_slots('0') === 0 && V.donor_banner_slots(10) === 10);
  check('settings: validator refuses 11, -1, "abc", ""', [11, -1, 'abc', ''].every((x) => throws(() => V.donor_banner_slots(x))));
  const rs = (v) => DN.donorSettings({ donor_banner_slots: v }, '').bannerSlots;
  check('settings: read bound — junk → default 5', ['', 'abc', 11, -1, 'Infinity', null, undefined].every((v) => rs(v) === 5));
  check('settings: read bound — "0" → 0 (0 means banners off, not "use the default")', rs('0') === 0 && rs(10) === 10);
  check('settings: round trip through updateSection/getSection', (() => {
    const ps = new PoolSettings(db);
    ps.updateSection('incentives', { donor_banner_slots: '3' });
    const back = DN.donorSettings(ps.getSection('incentives'), '').bannerSlots;
    ps.updateSection('incentives', { donor_banner_slots: 5 });
    return back === 3;
  })());

  // ══ 7. leagueRank (donor-ledger.js) ════════════════════════════════════════════════════
  console.log('\n[7] leagueRank\n');
  const ins = db.prepare(`INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id, created_at)
                          VALUES (?, 'debit', ?, 1, 0.5, 0, 0, 'donation', 9, ?)`);
  const R1 = ADDR('h'), R2 = ADDR('i'), R3 = ADDR('j');
  [R1, R2, R3].forEach(mkAcct);
  ins.run(R1, 5, NOW - 3600); ins.run(R2, 9, NOW - 3600); ins.run(R3, 1, NOW - 400 * 86400);
  check('leagueRank: ordered by score (9 before 5)', DL.leagueRank(db, R2, { ds, H: 0, now: NOW }) === 1 && DL.leagueRank(db, R1, { ds, H: 0, now: NOW }) === 2);
  check('leagueRank: outside the window (past strip) → null', DL.leagueRank(db, R3, { ds, H: 0, now: NOW }) === null);
  check('leagueRank: never donated → null', DL.leagueRank(db, ADDR('k'), { ds, H: 0, now: NOW }) === null);
  check('leagueRank: agrees with the wall\'s own numbering', (() => {
    const w = DL.donorWall(db, { ds, H: 0, now: NOW, active: true, mask: (x) => x });
    return w.league.every((c) => DL.leagueRank(db, c.address, { ds, H: 0, now: NOW }) === c.rank);
  })());
  // ══ 8. Route wiring (index.js read as TEXT — it starts a server on require) ═══════════════
  console.log('');
  console.log('[8] route wiring');
  console.log('');
  const src = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');
  const srcLines = src.split(String.fromCharCode(10));
  // One handler, from its `app.<verb>('<path>'` line to the next route registration.
  const isRouteLine = (l) => {
    const t = l.trimStart();
    return l.length - t.length <= 4 && ['app.get(', 'app.post(', 'app.put(', 'app.delete(', 'app.patch('].some((p) => t.startsWith(p));
  };
  const route = (verb, p) => {
    const i = srcLines.findIndex((l) => l.trimStart().startsWith('app.' + verb + "('" + p + "'"));
    if (i < 0) return '';
    let j = i + 1;
    while (j < srcLines.length && !isRouteLine(srcLines[j])) j++;
    return srcLines.slice(i, j).join(String.fromCharCode(10));
  };
  const rName = route('post', '/api/account/:addr/donor-profile/name');
  const rBan = route('post', '/api/account/:addr/donor-profile/banner');
  const rDel = route('delete', '/api/account/:addr/donor-profile/:kind');
  check('routes: all three exist, rate-limited as withdraw', [rName, rBan, rDel].every((r) => r && r.includes("rateLimiter.middleware('withdraw')")));
  check("routes: all three pass the BOTH-proofs gate with the 'donor_profile' wording",
        [rName, rBan, rDel].every((r) => r.includes('requireBothProofs(addr, req.body, reqIp, ') && r.includes(", 'donor_profile');")));
  check('routes: the banner route refuses BEFORE multer reads the body',
        rBan.indexOf('donorSubmitRefusal(addr)') > 0 && rBan.indexOf('donorSubmitRefusal(addr)') < rBan.indexOf('donorBannerUpload.single('));
  check('routes: the banner route maps LIMIT_FILE_SIZE to banner_too_large', (() => {
    const a = rBan.indexOf('LIMIT_FILE_SIZE'), b = rBan.indexOf("'banner_too_large'");
    return a > 0 && b > a && b - a < 160;
  })());
  // +1 because busboy trips its limit when a file REACHES it; exactly 300 KB is allowed by the rule.
  check('routes: the upload is capped by multer at MAX_BANNER_BYTES + 1, one file',
        src.includes('limits: { fileSize: DonorProfiles.MAX_BANNER_BYTES + 1, files: 1,'));
  check('routes: the submits validate the input BEFORE spending a proof attempt',
        rName.indexOf('validateName') > 0 && rName.indexOf('validateName') < rName.indexOf('requireBothProofs') &&
        rBan.indexOf('validateBanner') > 0 && rBan.indexOf('validateBanner') < rBan.indexOf('requireBothProofs'));
  const acct = route('get', '/api/account/:addr');
  check('account: donor_profile comes from profileFor, and the route never names donor_requests itself',
        acct.includes('donor_profile: donorProfile') && acct.includes('DonorProfiles.profileFor(') && !acct.includes('donor_requests'));
  check('the Goblin route still calls the gate with the default (destination) wording',
        src.includes("requireBothProofs(addr, req.body, reqIp, 'nostr_destination_register');"));
  // §18 Part 6 review: a proof that VERIFIED as the other kind (an IP in the password box, or the
  // reverse) used to be refused with the verifier's own success code, `match` — so the response
  // and the owner-proof audit row read `ok:false, reason:'match'`. It is `wrong_kind` now.
  const gate = src.slice(src.indexOf('const requireBothProofs = async'), src.indexOf('const alertPreviousDestination'));
  check("gate: a proof verified as the OTHER kind is refused as 'wrong_kind', never with the success code 'match'",
        gate.includes("deny('ip', ipProof.ok ? 'wrong_kind' : (ipProof.reason || 'ip_no_match'))") &&
        gate.includes("deny('password', passProof.ok ? 'wrong_kind' : (passProof.reason || 'password_no_match'))"));
  // ══ 9. Admin reads (§18 Part 3): queue, image bytes, per-address view, pending count ════
  console.log('');
  console.log('[9] admin reads');
  console.log('');
  {
    const M = ADDR('m'), N = ADDR('n'), P = ADDR('p'), Q = ADDR('r');
    [M, N, P, Q].forEach(mkAcct);
    const mine = new Set([M, N, P, Q]);
    const dsQ = DN.donorSettings({ donor_name_blocklist: 'sh1t\nmoon' }, 'Zephyr');
    const pend0 = DP.pendingCount(db);

    // P already has an approved name "Acme Inc." (the impersonation target) and an approved banner.
    DP.submitName(db, P, 'Acme Inc.', { isDonor: true, now: NOW - 500 });
    DP.approve(db, rowsOf(P, 'name').find((r) => r.status === 'pending').id, { adminId, now: NOW - 400 });
    DP.submitBanner(db, P, png(800, 200), { isDonor: true, now: NOW - 500 });
    const pBan = DP.approve(db, rowsOf(P, 'banner').find((r) => r.status === 'pending').id, { adminId, uploadsDir: UP, now: NOW - 400 });
    // The queue: M asks for a flagged name (oldest), N for a copy of P's name, M for a banner.
    DP.submitName(db, M, 'Official Sh1t Co', { isDonor: true, now: NOW - 300 });
    DP.submitName(db, N, 'acme inc', { isDonor: true, now: NOW - 200 });
    DP.submitBanner(db, M, png(1200, 300), { isDonor: true, now: NOW - 100 });
    // P asks to replace its live name.
    DP.submitName(db, P, 'Acme Incorporated', { isDonor: true, now: NOW - 50 });

    const q = DP.adminQueue(db, { ds: dsQ });
    const qm = q.rows.filter((r) => mine.has(r.address));
    check('queue: default status is pending, total counts every pending row', q.ok && q.status === 'pending' && q.total === DP.pendingCount(db));
    check('queue: pendingCount went up by exactly the four new pending requests', DP.pendingCount(db) === pend0 + 4);
    check('queue: oldest first (first come, first reviewed)',
          qm.map((r) => r.submitted_at).join(',') === [NOW - 300, NOW - 200, NOW - 100, NOW - 50].join(','));
    check('queue: no row carries an `image` key or a Buffer anywhere',
          qm.every((r) => !('image' in r) && !Object.values(r).some((v) => Buffer.isBuffer(v))));
    check('queue: the admin DOES see the pending name text and the FULL address',
          qm[0].name === 'Official Sh1t Co' && qm[0].address === M);
    check('queue: flags on the first name — reserved "official" then flag word "sh1t"',
          JSON.stringify(qm[0].flags) === JSON.stringify([{ type: 'reserved', word: 'official' }, { type: 'word', word: 'sh1t' }]));
    check('queue: "acme inc" from ANOTHER address is flagged same_as_donor → P',
          qm[1].flags.length === 1 && qm[1].flags[0].type === 'same_as_donor' && qm[1].flags[0].addresses.join() === P);
    check('queue: the banner row has dims/bytes/mime/sha256, has_image, no name, no flags',
          qm[2].kind === 'banner' && qm[2].width === 1200 && qm[2].height === 300 && qm[2].mime === 'image/png' &&
          qm[2].bytes > 0 && /^[0-9a-f]{64}$/.test(qm[2].sha256) && qm[2].has_image === true && qm[2].name === null && qm[2].flags.length === 0);
    check('queue: a rename shows the CURRENT approved name; its own approved name is not "impersonation"',
          qm[3].current && qm[3].current.name === 'Acme Inc.' && qm[3].flags.length === 0);
    check('queue: limit caps the rows but not the total', (() => {
      const l = DP.adminQueue(db, { ds: dsQ, limit: 1 });
      return l.rows.length === 1 && l.total === q.total;
    })());
    check('queue: status is a closed enum — junk, an array, SQL → bad_status',
          ['bogus', ['pending'], "pending' OR 1=1", 'PENDING'].every((s) => DP.adminQueue(db, { status: s }).code === 'bad_status'));
    check('queue: approved history lists P\'s live banner with has_image (file on disk) and decided_by',
          (() => {
            const h = DP.adminQueue(db, { status: 'approved', ds: dsQ }).rows.filter((r) => r.address === P && r.kind === 'banner');
            return h.length === 1 && h[0].has_image === true && h[0].decided_by === adminId;
          })());

    // Image bytes.
    const mBan = qm[2];
    const img = DP.requestImage(db, mBan.id, { uploadsDir: UP });
    check('image: a pending banner returns its stored bytes + stored mime', img.ok && img.mime === 'image/png' &&
          Buffer.compare(img.bytes, png(1200, 300)) === 0);
    const apRow = rowsOf(P, 'banner').find((r) => r.status === 'approved');
    const imgA = DP.requestImage(db, apRow.id, { uploadsDir: UP });
    check('image: an approved banner is read back from uploads/donors/', imgA.ok && Buffer.compare(imgA.bytes, png(800, 200)) === 0 && !!pBan.file);
    check('image: an approved banner with no uploadsDir → no_image (never a throw)', DP.requestImage(db, apRow.id, {}).code === 'no_image');
    check('image: a NAME request → not_found; a missing id → not_found; junk ids → bad_id',
          DP.requestImage(db, qm[0].id, { uploadsDir: UP }).code === 'not_found' &&
          DP.requestImage(db, 99999999, { uploadsDir: UP }).code === 'not_found' &&
          ['0', '-1', '1e3', 'abc', '1; DROP', ''].every((x) => DP.requestImage(db, x, { uploadsDir: UP }).code === 'bad_id'));
    check('image: a stored mime that is not png/jpeg/gif is refused, never passed through', (() => {
      db.prepare("UPDATE donor_requests SET mime = 'image/svg+xml' WHERE id = ?").run(mBan.id);
      const r = DP.requestImage(db, mBan.id, { uploadsDir: UP });
      db.prepare("UPDATE donor_requests SET mime = 'image/png' WHERE id = ?").run(mBan.id);
      return r.code === 'no_image';
    })());
    check('image: a stored file name that is not ours is refused (no traversal)', (() => {
      db.prepare("UPDATE donor_requests SET file = '../../../etc/passwd' WHERE id = ?").run(apRow.id);
      const r = DP.requestImage(db, apRow.id, { uploadsDir: UP });
      db.prepare('UPDATE donor_requests SET file = ? WHERE id = ?').run(apRow.file, apRow.id);
      return r.code === 'no_image';
    })());
    check('image: an approved file deleted from disk → no_image', (() => {
      const f = path.join(DONORS, apRow.file);
      const keep = fs.readFileSync(f);
      fs.unlinkSync(f);
      const r = DP.requestImage(db, apRow.id, { uploadsDir: UP });
      fs.writeFileSync(f, keep);
      return r.code === 'no_image';
    })());

    // Decide, then the image is gone (bytes NULLed on the decision).
    const rj = DP.reject(db, mBan.id, { adminId, reason: 'Too busy', now: NOW });
    check('image: after a reject the bytes are gone → no_image', rj.ok && DP.requestImage(db, mBan.id, { uploadsDir: UP }).code === 'no_image');
    check('queue: the rejected banner left the pending queue and is in the rejected history with its reason',
          !DP.adminQueue(db, { ds: dsQ }).rows.some((r) => r.id === mBan.id) &&
          DP.adminQueue(db, { status: 'rejected', ds: dsQ }).rows.some((r) => r.id === mBan.id && r.reason === 'Too busy' && r.has_image === false));

    // Self-review (c): blocking withdraws pending → the queue never shows a blocked address's work.
    const bl = DP.block(db, M, { adminId, reason: 'spam', now: NOW + 1 });
    check('block: M\'s pending name is withdrawn and gone from the queue', bl.ok && bl.withdrawn === 1 &&
          !DP.adminQueue(db, { ds: dsQ }).rows.some((r) => r.address === M));
    check('block: a blocked address cannot submit → blocked', DP.submitName(db, M, 'Again', { isDonor: true }).code === 'blocked');

    // adminProfiles: the per-address view the donors list renders.
    const prof = DP.adminProfiles(db, { ds: DN.donorSettings({}, ''), now: NOW, lastDonatedAt: () => NOW - 86400 });
    const pp = prof.get(P), pm = prof.get(M), pn = prof.get(N);
    check('adminProfiles: live name + banner with state shown, pending rename flagged',
          pp && pp.name.text === 'Acme Inc.' && pp.name.state === 'shown' && pp.banner.state === 'shown' &&
          /^\/uploads\/donors\/[0-9a-f]{16}\.png$/.test(pp.banner.url) && pp.pending.name === true && pp.pending.banner === false);
    check('adminProfiles: a blocked address is listed with when + the note', pm && pm.blocked && pm.blocked.at === NOW + 1 &&
          pm.blocked.reason === 'spam' && pm.name === null && pm.pending.name === false);
    check('adminProfiles: a pending-only address is listed (so it can be blocked)', pn && pn.name === null && pn.pending.name === true);
    check('adminProfiles: an address with no request and no block is absent', !prof.has(Q));
    check('adminProfiles: expiry uses the same rule as the donor\'s own view', (() => {
      const later = NOW + 400 * 86400;
      const x = DP.adminProfiles(db, { ds: DN.donorSettings({}, ''), now: later, lastDonatedAt: () => NOW - 86400 }).get(P);
      const own = DP.profileFor(db, P, { active: true, lastDonatedAt: NOW - 86400, ds: DN.donorSettings({}, ''), now: later });
      return x.name.state === 'expired' && own.name.state === 'expired' && x.banner.state === 'expired';
    })());
    check('adminProfiles: never carries image bytes', [...prof.values()].every((v) => !JSON.stringify(v).includes('"type":"Buffer"')));
  }

} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

// ── The account page mirrors these rules as HINTS (design §18.8, §18 Part 5) ─────────────
// public_html/account-settings.html re-states the name rules and the banner limits so a miner
// learns about a bad name or file before spending a rate-limited request. The server stays the
// check, but a page that drifted from it would block a name the server accepts (the page refuses
// to send a name its own rules reject), so pin the two together: the constants, and the name
// verdict over a matrix, with the page's own dpCheckName evaluated from its source.
{
  const html = fs.readFileSync(path.join(APP, '..', 'public_html', 'account-settings.html'), 'utf8');
  const grab = (re) => { const m = html.match(re); return m ? m[0] : ''; };
  const nameLit = grab(/const DP_NAME = \{[^\n]*\};/);
  const banLit = grab(/const DP_BANNER = \{[^\n]*\};/);
  const fnSrc = grab(/function dpCheckName\(raw\) \{[\s\S]*?\n        \}/);
  check('page: DP_NAME, DP_BANNER and dpCheckName found in account-settings.html', !!(nameLit && banLit && fnSrc));
  let page = null;
  try {
    // eslint-disable-next-line no-new-func
    page = new Function(`${nameLit}\n${banLit}\n${fnSrc}\nreturn { DP_NAME, DP_BANNER, dpCheckName };`)();
  } catch (e) { page = null; }
  const libSrc = fs.readFileSync(path.join(APP, 'lib', 'donor-profiles.js'), 'utf8');
  const libCharset = (libSrc.match(/const NAME_CHARSET_RE = (\/[^\n]*\/);/) || [])[1] || '';
  check('page: DP_NAME min/max/charset = lib NAME_MIN / NAME_MAX / NAME_CHARSET_RE',
    !!page && page.DP_NAME.min === DP.NAME_MIN && page.DP_NAME.max === DP.NAME_MAX &&
    libCharset !== '' && String(page.DP_NAME.re) === libCharset, `${page && page.DP_NAME.re} vs ${libCharset}`);
  check('page: DP_BANNER = lib BANNER + MAX_BANNER_BYTES',
    !!page && ['minW', 'maxW', 'minH', 'maxH', 'minAspect', 'maxAspect'].every((k) => page.DP_BANNER[k] === DP.BANNER[k]) &&
    page.DP_BANNER.maxBytes === DP.MAX_BANNER_BYTES);
  const names = ['Acme', 'A', 'ab', '  Acme   Mining  ', 'x'.repeat(32), 'x'.repeat(33), "O'Brien & Co.", 'grin.money',
    '---', '. .', 'Ünïcode', 'emoji🙂', 'tab\there', 'nbsp here', 'rtl‮name', 'a_b-c', '99', '', '   '];
  const disagree = page ? names.filter((n) => page.dpCheckName(n).ok !== DP.validateName(n).ok) : names;
  check('page: dpCheckName agrees with validateName on every name in the matrix', disagree.length === 0,
    JSON.stringify(disagree));
  check('page: dpCheckName sends the same normalised name the server stores',
    !!page && page.dpCheckName('  Acme \t  Mining ').name === DP.validateName('  Acme \t  Mining ').name);
  const reasons = grab(/const DP_REASONS = \{[\s\S]*?\n        \};/);
  check("page: DP_REASONS maps the gate's 'wrong_kind' refusal, and no longer a 'match' key",
    /\n\s+wrong_kind: '/.test(reasons) && !/\n\s+match: '/.test(reasons));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
