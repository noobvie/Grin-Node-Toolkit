'use strict';

// Donor profiles — design §18.4–§18.6 (2026-09-24). A donor's public NICKNAME and BANNER, set
// from the account page and shown only after an admin approves them. Everything that decides
// what a profile IS lives here: name rules, the banner byte sniff + header-parsed dimensions,
// the request state machine, the approved-file writes, and the two read shapes (the donor's own
// view for /api/account/:addr, the public view for the wall).
//
// No dependency on index.js (it starts a server on require) and none on donor-ledger.js:
// §18 Part 4 makes donorWall() read publicProfiles() from here, so the require must only ever go
// ledger → profiles. Whatever needs the ledger (has this address donated? its league rank?) is
// passed in by the caller as a plain value.
//
// State machine, per (address × kind), each transition ONE transaction:
//   submit   → pending     an existing pending → replaced (its blob NULLed)
//   approve  → approved    the previous approved → replaced, its file deleted
//   reject   → rejected    (reason shown to the donor)
//   withdraw → withdrawn   the donor drops their own pending request
//   remove   → removed     the donor or an admin takes the live one down (file deleted)
//   block    → every pending of the address → withdrawn; donor_blocks row
// The partial unique indexes (lib/db.js) make "one pending + one approved per kind" a database
// fact; a constraint hit comes back as { ok:false, code:'conflict' }, never as a throw.
//
// Admin transitions write their admin_audit_log row INSIDE the transaction (fail-closed, as
// v1's adminCensor did): no admin decision lands without its audit row.
//
// ⚠ The pending name text and the pending image never leave this file through profileFor() or
// publicProfiles(): /api/account/:addr is public to anyone holding the address, and the wall is
// public to everyone. Only the admin reads at the bottom (adminQueue, requestImage), which §18
// Part 3 wired to secureAdmin routes, return them.
//
// Like a toolkit lib run without errexit (memory project_lib_errexit_suppression), every fs
// call's outcome is checked: a failed write aborts the approval and leaves the request pending;
// a failed unlink of a superseded file is reported back, never silently dropped.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SNIFFERS } = require('./asset-manager');
const { addMonthsUtc, nameFlagContext, nameFlags } = require('./donor-names');

const KINDS = Object.freeze(['name', 'banner']);

// ── Name (§18.5) ────────────────────────────────────────────────────────────────────────────
const NAME_MIN = 2;
const NAME_MAX = 32;
// ASCII only: no homoglyphs (Cyrillic a, U+0430), no bidi overrides (U+202E), no zero-width joiners —
// none of them are in this class, so every one is refused rather than normalised away.
const NAME_CHARSET_RE = /^[A-Za-z0-9 \-_.&']+$/;
const NAME_RULE = `2–${NAME_MAX} characters: letters, digits, spaces and - _ . & ' only, with at least one letter or digit`;

// Trim, collapse ASCII whitespace runs to one space, keep case (brands are cased). Only ASCII
// whitespace is collapsed: a Unicode space (NBSP, ideographic space) is not "whitespace we
// tidy", it is a character outside the charset and is refused with the rule.
function normaliseName(raw) {
  return String(raw == null ? '' : raw).replace(/[ \t\r\n\f\v]+/g, ' ').trim();
}

function validateName(raw) {
  if (raw !== null && raw !== undefined && typeof raw !== 'string') {
    return { ok: false, code: 'name_invalid', error: `A donor name must be text: ${NAME_RULE}.` };
  }
  const name = normaliseName(raw);
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return { ok: false, code: 'name_length', error: `A donor name must be ${NAME_RULE}.` };
  }
  if (!NAME_CHARSET_RE.test(name)) {
    return { ok: false, code: 'name_charset', error: `That name contains a character that is not allowed. A donor name must be ${NAME_RULE}.` };
  }
  if (!/[A-Za-z0-9]/.test(name)) {
    return { ok: false, code: 'name_no_alnum', error: `A donor name needs at least one letter or digit (${NAME_RULE}).` };
  }
  return { ok: true, name };
}

// ── Banner (§18.5) ──────────────────────────────────────────────────────────────────────────
const MAX_BANNER_BYTES = 300 * 1024;
const BANNER = Object.freeze({ minW: 320, maxW: 1600, minH: 80, maxH: 400, minAspect: 2, maxAspect: 8 });
const BANNER_RULE = `PNG, JPG or GIF (animation allowed), ${BANNER.minW}–${BANNER.maxW} × ${BANNER.minH}–${BANNER.maxH} px, `
  + `between 2:1 and 8:1 wide, up to ${MAX_BANNER_BYTES / 1024} KB — 800 × 200 recommended`;

// The binary signatures ONLY. Never detectImage(): it returns 'svg' for an XML head, and SVG
// (script-capable) and WEBP are both refused here by design (§18.1 #7).
function sniffBanner(buf) {
  if (!buf || typeof buf.length !== 'number' || buf.length < 8) return null;
  for (const s of SNIFFERS) {
    if (s.test(buf)) return { ext: s.ext, mime: s.mime };
  }
  return null;
}

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u32be = (b, i) => ((b[i] * 0x1000000) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]));

// Width/height from the header, or null. Every read is bounds-checked against buf.length first,
// so a truncated or lying header is a null (a refusal), never an exception and never a read
// past the end. Pure arithmetic on a byte array — no decoder, so a decompression bomb cannot
// reach anything here; its declared size is refused by validateBanner's bounds instead.
function parseDimensions(buf, ext) {
  try {
    if (!buf || typeof buf.length !== 'number') return null;
    const n = buf.length;
    if (ext === 'png') {
      // 8-byte signature, then the first chunk MUST be IHDR, length 13: width @16, height @20.
      if (n < 24) return null;
      if (u32be(buf, 8) !== 13) return null;
      if (buf[12] !== 0x49 || buf[13] !== 0x48 || buf[14] !== 0x44 || buf[15] !== 0x52) return null;
      const width = u32be(buf, 16), height = u32be(buf, 20);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (ext === 'gif') {
      // 'GIF87a' / 'GIF89a', then the logical screen descriptor: width @6, height @8, LE u16.
      if (n < 10) return null;
      const width = u16le(buf, 6), height = u16le(buf, 8);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (ext === 'jpg') {
      // Walk the marker segments from after SOI to the first SOFn (C0–CF except C4 DHT, C8 JPG,
      // CC DAC). Stop — refusing — at SOS/EOI or anything that is not a marker. Each step
      // advances by at least 2 bytes, so the loop terminates on any input.
      let i = 2;
      while (i < n) {
        if (buf[i] !== 0xff) return null;
        while (i < n && buf[i] === 0xff) i++;          // fill bytes
        if (i >= n) return null;
        const m = buf[i];
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i++; continue; } // no length
        if (m === 0xd9 || m === 0xda) return null;     // EOI / SOS before any frame header
        if (m === 0x00) return null;                   // a stuffed byte is not a marker here
        if (i + 2 >= n) return null;
        const len = u16be(buf, i + 1);                 // includes its own two bytes
        if (len < 2) return null;
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          // [len:2][precision:1][height:2][width:2][components:1] — so len >= 8
          if (len < 8 || i + 7 >= n) return null;
          const height = u16be(buf, i + 4), width = u16be(buf, i + 6);
          return width > 0 && height > 0 ? { width, height } : null;
        }
        i += 1 + len;                                  // marker byte + segment
      }
      return null;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// { ok:true, ext, mime, width, height, bytes, sha256 } or { ok:false, code, error }. The client's
// filename and declared MIME are never an input — only the bytes.
function validateBanner(buf) {
  if (!buf || typeof buf.length !== 'number' || buf.length === 0) {
    return { ok: false, code: 'banner_missing', error: `No banner image was received. Banner: ${BANNER_RULE}.` };
  }
  if (buf.length > MAX_BANNER_BYTES) {
    return { ok: false, code: 'banner_too_large', error: `That image is larger than ${MAX_BANNER_BYTES / 1024} KB. Banner: ${BANNER_RULE}.` };
  }
  const t = sniffBanner(buf);
  if (!t) {
    return { ok: false, code: 'banner_type', error: `That file is not a PNG, JPG or GIF image (SVG and WEBP are not accepted). Banner: ${BANNER_RULE}.` };
  }
  const d = parseDimensions(buf, t.ext);
  if (!d) {
    return { ok: false, code: 'banner_unreadable', error: `The image header could not be read — the file may be damaged. Banner: ${BANNER_RULE}.` };
  }
  if (d.width < BANNER.minW || d.width > BANNER.maxW || d.height < BANNER.minH || d.height > BANNER.maxH) {
    return { ok: false, code: 'banner_dimensions', error: `That image is ${d.width} × ${d.height} px. Banner: ${BANNER_RULE}.` };
  }
  const aspect = d.width / d.height;
  if (!(aspect >= BANNER.minAspect && aspect <= BANNER.maxAspect)) {
    return { ok: false, code: 'banner_aspect', error: `That image is ${d.width} × ${d.height} px, which is not between 2:1 and 8:1 wide. Banner: ${BANNER_RULE}.` };
  }
  return {
    ok: true, ext: t.ext, mime: t.mime, width: d.width, height: d.height,
    bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex')
  };
}

// ── shared helpers ──────────────────────────────────────────────────────────────────────────
const nowUnix = () => Math.floor(Date.now() / 1000);
const clock = (opts) => (Number.isFinite(opts && opts.now) ? Math.floor(opts.now) : nowUnix());
const isKind = (k) => KINDS.includes(k);

// Reason text is SHOWN to the donor, on a page anyone holding the address can open: one line,
// no control characters, ≤ 200 chars. Empty → null.
function cleanReason(r) {
  if (r === null || r === undefined) return null;
  const s = String(r).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return s === '' ? null : s;
}

const isConstraint = (e) => !!e && /constraint failed/i.test(String(e.message || ''));

function audit(db, adminId, action, address, details, ip) {
  db.prepare(`
    INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
    VALUES (?, ?, 'donor', ?, ?, ?)
  `).run(Number.isFinite(adminId) ? adminId : null, action, address, JSON.stringify(details || {}),
         ip == null ? null : String(ip));
}

// ── files (approved banners only) ───────────────────────────────────────────────────────────
// uploads/donors/<16 hex>.<ext>: the name is random, the extension comes from the sniff. Served
// by nginx's existing `location /uploads/` (nosniff + sandbox CSP), which the deploy rsync
// excludes and the pool backup includes — verified against 07_grin_mining_public_pool.sh.
const FILE_RE = /^[0-9a-f]{16}\.(png|jpg|gif)$/;
const donorsDir = (uploadsDir) => path.join(path.resolve(String(uploadsDir)), 'donors');
const publicUrl = (file) => (FILE_RE.test(String(file || '')) ? `/uploads/donors/${file}` : null);

function writeBannerFile(uploadsDir, bytes, ext) {
  const dir = donorsDir(uploadsDir);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o755 }); }
  catch (e) { return { ok: false, error: `could not create ${dir}: ${e.message}` }; }
  const file = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
  const dest = path.join(dir, file);
  if (path.dirname(dest) !== dir || !FILE_RE.test(file)) return { ok: false, error: 'resolved path escapes the donors directory' };
  try { fs.writeFileSync(dest, bytes, { mode: 0o644, flag: 'wx' }); }
  catch (e) { return { ok: false, error: `could not write ${dest}: ${e.message}` }; }
  return { ok: true, file };
}

// Unlink one approved file. Only a name this lib could have written, only inside donors/.
// A file already gone is success (the goal is "not served"); any other failure is reported.
function unlinkBannerFile(uploadsDir, file) {
  if (!file) return { ok: true };
  if (!FILE_RE.test(String(file))) return { ok: false, error: `refusing to unlink unexpected name ${file}` };
  const dir = donorsDir(uploadsDir);
  const p = path.join(dir, file);
  if (path.dirname(p) !== dir) return { ok: false, error: 'resolved path escapes the donors directory' };
  try { fs.unlinkSync(p); return { ok: true }; }
  catch (e) { return e && e.code === 'ENOENT' ? { ok: true } : { ok: false, error: `could not delete ${p}: ${e.message}` }; }
}

// ── donor-side transitions ──────────────────────────────────────────────────────────────────
// opts.isDonor MUST be true (the caller read ≥ 1 donation debit from the ledger — this lib does
// not depend on donor-ledger.js, see the header). Fail closed: anything else is not_a_donor.
function gateSubmit(db, address, opts) {
  if (!db.prepare('SELECT 1 FROM miner_accounts WHERE grin_address = ?').get(address)) return 'not_found';
  if (db.prepare('SELECT 1 FROM donor_blocks WHERE grin_address = ?').get(address)) return 'blocked';
  if (!opts || opts.isDonor !== true) return 'not_a_donor';
  return null;
}

function insertPending(db, address, kind, fields, now) {
  const replaced = db.prepare(`
    UPDATE donor_requests SET status = 'replaced', image = NULL, decided_at = ?
    WHERE grin_address = ? AND kind = ? AND status = 'pending'
  `).run(now, address, kind).changes;
  const info = db.prepare(`
    INSERT INTO donor_requests (grin_address, kind, status, name, image, mime, width, height, bytes, sha256, submitted_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(address, kind, fields.name || null, fields.image || null, fields.mime || null,
         fields.width || null, fields.height || null, fields.bytes || null, fields.sha256 || null, now);
  return { id: Number(info.lastInsertRowid), replaced: replaced > 0 };
}

function submit(db, address, kind, fields, opts) {
  const now = clock(opts);
  try {
    return db.transaction(() => {
      const bad = gateSubmit(db, address, opts);
      if (bad) return { ok: false, code: bad };
      const r = insertPending(db, address, kind, fields, now);
      return { ok: true, id: r.id, kind, replaced: r.replaced, submitted_at: now };
    })();
  } catch (e) {
    if (isConstraint(e)) return { ok: false, code: 'conflict' };
    throw e;
  }
}

// → { ok:true, id, kind, name, replaced, submitted_at } | { ok:false, code, error? }
function submitName(db, address, rawName, opts = {}) {
  const v = validateName(rawName);
  if (!v.ok) return v;
  const r = submit(db, address, 'name', { name: v.name }, opts);
  return r.ok ? Object.assign(r, { name: v.name }) : r;
}

// → { ok:true, id, kind, mime, width, height, bytes, replaced, submitted_at } | { ok:false, code, error? }
function submitBanner(db, address, buf, opts = {}) {
  const v = validateBanner(buf);
  if (!v.ok) return v;
  const image = Buffer.from(buf); // a copy: never keep a reference into multer's buffer
  const r = submit(db, address, 'banner', {
    image, mime: v.mime, width: v.width, height: v.height, bytes: v.bytes, sha256: v.sha256
  }, opts);
  return r.ok ? Object.assign(r, { mime: v.mime, width: v.width, height: v.height, bytes: v.bytes }) : r;
}

// The donor drops their own pending request. → { ok:true, id } | { ok:false, code:'bad_kind'|'nothing_pending' }
function withdraw(db, address, kind, opts = {}) {
  if (!isKind(kind)) return { ok: false, code: 'bad_kind' };
  const now = clock(opts);
  return db.transaction(() => {
    const row = db.prepare(
      "SELECT id FROM donor_requests WHERE grin_address = ? AND kind = ? AND status = 'pending'"
    ).get(address, kind);
    if (!row) return { ok: false, code: 'nothing_pending' };
    db.prepare("UPDATE donor_requests SET status = 'withdrawn', image = NULL, decided_at = ? WHERE id = ?").run(now, row.id);
    return { ok: true, id: row.id };
  })();
}

// Take the LIVE (approved) item down. By the donor (no opts.adminId) or an admin (opts.adminId
// set → audited in the transaction, reason stored and shown to the donor). The file is unlinked
// after the commit — a crash between leaves an orphan file, never a live row pointing at nothing.
// → { ok:true, id, file_deleted, warning? } | { ok:false, code:'bad_kind'|'nothing_live' }
function removeLive(db, address, kind, opts = {}) {
  if (!isKind(kind)) return { ok: false, code: 'bad_kind' };
  if (kind === 'banner' && !opts.uploadsDir) throw new Error('removeLive: uploadsDir is required for a banner');
  const now = clock(opts);
  const byAdmin = Number.isFinite(opts.adminId);
  const reason = cleanReason(opts.reason);
  const res = db.transaction(() => {
    const row = db.prepare(
      "SELECT id, name, file FROM donor_requests WHERE grin_address = ? AND kind = ? AND status = 'approved'"
    ).get(address, kind);
    if (!row) return { ok: false, code: 'nothing_live' };
    db.prepare(`
      UPDATE donor_requests SET status = 'removed', decided_at = ?, decided_by = ?, reason = ?
      WHERE id = ?
    `).run(now, byAdmin ? opts.adminId : null, byAdmin ? reason : null, row.id);
    if (byAdmin) audit(db, opts.adminId, 'donor_profile_remove', address, { kind, request_id: row.id, name: row.name || null, reason }, opts.ip);
    return { ok: true, id: row.id, file: row.file || null };
  })();
  if (!res.ok) return res;
  if (kind !== 'banner') return { ok: true, id: res.id, file_deleted: false };
  const u = unlinkBannerFile(opts.uploadsDir, res.file);
  return u.ok ? { ok: true, id: res.id, file_deleted: !!res.file } : { ok: true, id: res.id, file_deleted: false, warning: u.error };
}

// ── admin transitions (wired by §18 Part 3) ────────────────────────────────────────────────
// opts: { adminId, ip, now, reason, uploadsDir }.

const parseId = (id) => {
  const n = typeof id === 'number' ? id : (/^[0-9]{1,15}$/.test(String(id)) ? parseInt(id, 10) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

// → { ok:true, id, kind, address, file?, replaced_id, warning? }
//   | { ok:false, code:'bad_id'|'not_found'|'not_pending'|'blocked'|'no_image'|'invalid_image'|'write_failed'|'conflict' }
// For a banner the file is written FIRST (so the row never points at a missing file), then the
// transaction flips the rows; if the transaction fails the new file is unlinked again. The
// superseded file is unlinked only after the commit.
function approve(db, id, opts = {}) {
  const rid = parseId(id);
  if (rid === null) return { ok: false, code: 'bad_id' };
  const now = clock(opts);
  const row = db.prepare(
    'SELECT id, grin_address, kind, status, name, image FROM donor_requests WHERE id = ?'
  ).get(rid);
  if (!row) return { ok: false, code: 'not_found' };
  if (row.status !== 'pending') return { ok: false, code: 'not_pending' };
  if (db.prepare('SELECT 1 FROM donor_blocks WHERE grin_address = ?').get(row.grin_address)) return { ok: false, code: 'blocked' };

  let newFile = null;
  if (row.kind === 'banner') {
    if (!opts.uploadsDir) throw new Error('approve: uploadsDir is required for a banner');
    if (!row.image || !row.image.length) return { ok: false, code: 'no_image' };
    // Re-derive type + dims from the stored bytes: the extension on disk comes from the sniff,
    // here as at submit, never from anything stored beside the bytes.
    const v = validateBanner(row.image);
    if (!v.ok) return { ok: false, code: 'invalid_image', error: v.error };
    const w = writeBannerFile(opts.uploadsDir, Buffer.from(row.image), v.ext);
    if (!w.ok) return { ok: false, code: 'write_failed', error: w.error };
    newFile = w.file;
  }

  let res;
  try {
    res = db.transaction(() => {
      const cur = db.prepare('SELECT status FROM donor_requests WHERE id = ?').get(rid);
      if (!cur || cur.status !== 'pending') return { ok: false, code: 'not_pending' };
      const prev = db.prepare(
        "SELECT id, file FROM donor_requests WHERE grin_address = ? AND kind = ? AND status = 'approved'"
      ).get(row.grin_address, row.kind);
      if (prev) {
        db.prepare("UPDATE donor_requests SET status = 'replaced', decided_at = ? WHERE id = ?").run(now, prev.id);
      }
      db.prepare(`
        UPDATE donor_requests SET status = 'approved', image = NULL, file = ?, decided_at = ?, decided_by = ?, reason = NULL
        WHERE id = ?
      `).run(newFile, now, Number.isFinite(opts.adminId) ? opts.adminId : null, rid);
      audit(db, opts.adminId, 'donor_request_approve', row.grin_address,
            { kind: row.kind, request_id: rid, name: row.name || null, file: newFile, replaced_id: prev ? prev.id : null }, opts.ip);
      return { ok: true, id: rid, kind: row.kind, address: row.grin_address, file: newFile, replaced_id: prev ? prev.id : null, prevFile: prev ? prev.file : null };
    })();
  } catch (e) {
    if (newFile) unlinkBannerFile(opts.uploadsDir, newFile);
    if (isConstraint(e)) return { ok: false, code: 'conflict' };
    throw e;
  }
  if (!res.ok) {
    if (newFile) unlinkBannerFile(opts.uploadsDir, newFile);
    return res;
  }
  const prevFile = res.prevFile;
  delete res.prevFile;
  if (prevFile) {
    const u = unlinkBannerFile(opts.uploadsDir, prevFile);
    if (!u.ok) res.warning = u.error;
  }
  return res;
}

// → { ok:true, id, kind, address } | { ok:false, code:'bad_id'|'not_found'|'not_pending' }
function reject(db, id, opts = {}) {
  const rid = parseId(id);
  if (rid === null) return { ok: false, code: 'bad_id' };
  const now = clock(opts);
  const reason = cleanReason(opts.reason);
  return db.transaction(() => {
    const row = db.prepare('SELECT id, grin_address, kind, status, name FROM donor_requests WHERE id = ?').get(rid);
    if (!row) return { ok: false, code: 'not_found' };
    if (row.status !== 'pending') return { ok: false, code: 'not_pending' };
    db.prepare(`
      UPDATE donor_requests SET status = 'rejected', image = NULL, decided_at = ?, decided_by = ?, reason = ?
      WHERE id = ?
    `).run(now, Number.isFinite(opts.adminId) ? opts.adminId : null, reason, rid);
    audit(db, opts.adminId, 'donor_request_reject', row.grin_address, { kind: row.kind, request_id: rid, name: row.name || null, reason }, opts.ip);
    return { ok: true, id: rid, kind: row.kind, address: row.grin_address };
  })();
}

// Bar an address from submitting; its pending requests are withdrawn in the same transaction
// (so the queue never shows a blocked address's work). A live name/banner is untouched.
// → { ok:true, address, withdrawn } | { ok:false, code:'not_found'|'already' }
function block(db, address, opts = {}) {
  const now = clock(opts);
  const reason = cleanReason(opts.reason);
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM miner_accounts WHERE grin_address = ?').get(address)) return { ok: false, code: 'not_found' };
    if (db.prepare('SELECT 1 FROM donor_blocks WHERE grin_address = ?').get(address)) return { ok: false, code: 'already' };
    db.prepare('INSERT INTO donor_blocks (grin_address, blocked_at, blocked_by, reason) VALUES (?, ?, ?, ?)')
      .run(address, now, Number.isFinite(opts.adminId) ? opts.adminId : null, reason);
    const withdrawn = db.prepare(`
      UPDATE donor_requests SET status = 'withdrawn', image = NULL, decided_at = ?, decided_by = ?
      WHERE grin_address = ? AND status = 'pending'
    `).run(now, Number.isFinite(opts.adminId) ? opts.adminId : null, address).changes;
    audit(db, opts.adminId, 'donor_block', address, { reason, withdrawn }, opts.ip);
    return { ok: true, address, withdrawn };
  })();
}

// → { ok:true, address } | { ok:false, code:'not_blocked' }
function unblock(db, address, opts = {}) {
  return db.transaction(() => {
    const n = db.prepare('DELETE FROM donor_blocks WHERE grin_address = ?').run(address).changes;
    if (!n) return { ok: false, code: 'not_blocked' };
    audit(db, opts.adminId, 'donor_unblock', address, {}, opts.ip);
    return { ok: true, address };
  })();
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────
// Expiry (§18.1 #9, unchanged from §16.7 #12): an APPROVED item stops showing `months` calendar
// months after the LATER of the address's last donation debit and the approval itself — an item
// approved today is never instantly expired because the last debit was long ago. months 0 = never.
function isExpired(approvedAt, lastDonatedAt, months, now) {
  if (!(months > 0)) return false;
  const ref = Math.max(Number(lastDonatedAt) || 0, Number(approvedAt) || 0);
  return ref > 0 && now >= addMonthsUtc(ref, months);
}
const expiryMonths = (ds) => {
  const m = ds && Number.isFinite(ds.nameExpiryMonths) ? Math.floor(ds.nameExpiryMonths) : 12;
  return m >= 0 && m <= 120 ? m : 12;
};
const bannerSlots = (ds) => {
  const s = ds && Number.isFinite(ds.bannerSlots) ? Math.floor(ds.bannerSlots) : 5;
  return s >= 0 && s <= 10 ? s : 5;
};

// Columns a read may select. NEVER `image`, and the name column only from APPROVED rows.
const READ_COLS = 'id, grin_address, kind, status, file, width, height, submitted_at, decided_at, reason, decided_by';

// The donor's own view — design §18.6 `donor_profile` on /api/account/:addr (public to anyone
// holding the address). opts:
//   active         donationsActive()
//   lastDonatedAt  unix time of the last donation debit, null = never donated (the caller reads
//                  the ledger; see the header)
//   slotRank       the address's league rank, null when not in the league
//   ds             donorSettings() (nameExpiryMonths, bannerSlots)
//   now
// Never carries the pending name, any image bytes, decided_by, or who removed an item.
function profileFor(db, address, opts = {}) {
  const now = clock(opts);
  const months = expiryMonths(opts.ds);
  const slots = bannerSlots(opts.ds);
  const active = opts.active === true;
  const lastDonatedAt = opts.lastDonatedAt == null ? null : Number(opts.lastDonatedAt);
  const isDonor = lastDonatedAt !== null && Number.isFinite(lastDonatedAt);
  const blocked = !!db.prepare('SELECT 1 FROM donor_blocks WHERE grin_address = ?').get(address);

  const current = db.prepare(`
    SELECT ${READ_COLS}, CASE WHEN status = 'approved' THEN name END AS live_name
    FROM donor_requests WHERE grin_address = ? AND status IN ('approved', 'pending')
  `).all(address);
  // Per kind: the newest row of any status, and the newest REMOVED row.
  const newest = db.prepare(`
    SELECT ${READ_COLS} FROM donor_requests
    WHERE id IN (SELECT MAX(id) FROM donor_requests WHERE grin_address = ? GROUP BY kind)
       OR id IN (SELECT MAX(id) FROM donor_requests WHERE grin_address = ? AND status = 'removed' GROUP BY kind)
  `).all(address, address);

  const pick = (kind, status) => current.find((r) => r.kind === kind && r.status === status) || null;
  // Two different pieces of news, each with its own "still current?" rule:
  //   rejected  — about a SUBMISSION: current only while it is the newest row of its kind (a
  //               later submission supersedes it).
  //   removed   — about the LIVE slot: current while nothing is approved in that slot, whatever
  //               is pending (a waiting resubmission does not un-remove the old one). Only an
  //               ADMIN removal is news — the donor did their own — and who removed it is never
  //               emitted.
  const lastWord = (kind) => {
    const rows = newest.filter((x) => x.kind === kind);
    const top = rows.reduce((a, b) => (a === null || b.id > a.id ? b : a), null);
    const rem = rows.filter((x) => x.status === 'removed').reduce((a, b) => (a === null || b.id > a.id ? b : a), null);
    const rejected = top && top.status === 'rejected' ? { reason: top.reason || null, at: top.decided_at } : null;
    const removed = rem && !pick(kind, 'approved') && rem.decided_by !== null && rem.decided_by !== undefined
      ? { reason: rem.reason || null, at: rem.decided_at } : null;
    return { rejected, removed };
  };

  const nameAp = pick('name', 'approved');
  const namePend = pick('name', 'pending');
  const nameExpired = nameAp ? isExpired(nameAp.decided_at, lastDonatedAt, months, now) : false;
  const nameState = !nameAp ? 'none' : (nameExpired ? 'expired' : 'shown');

  const banAp = pick('banner', 'approved');
  const banPend = pick('banner', 'pending');
  const banExpired = banAp ? isExpired(banAp.decided_at, lastDonatedAt, months, now) : false;
  const banState = !banAp ? 'none' : (banExpired ? 'expired' : 'shown');
  const liveUrl = banState === 'shown' ? publicUrl(banAp.file) : null;

  const rank = Number.isSafeInteger(opts.slotRank) && opts.slotRank > 0 ? opts.slotRank : null;
  let refusal = null;
  if (!active) refusal = 'donations_off';
  else if (blocked) refusal = 'blocked';
  else if (!isDonor) refusal = 'not_a_donor';

  const nameWord = lastWord('name');
  const banWord = lastWord('banner');
  return {
    eligible: active && isDonor,
    blocked,
    refusal,
    name: {
      live: nameState === 'shown' ? nameAp.live_name : null,
      state: nameState,
      pending_at: namePend ? namePend.submitted_at : null,
      rejected: nameWord.rejected,
      removed: nameWord.removed
    },
    banner: {
      live_url: liveUrl,
      width: liveUrl ? banAp.width : null,
      height: liveUrl ? banAp.height : null,
      state: banState,
      pending_at: banPend ? banPend.submitted_at : null,
      rejected: banWord.rejected,
      removed: banWord.removed,
      slot_rank: rank,
      slots,
      showing: !!liveUrl && rank !== null && rank <= slots
    }
  };
}

// The public view for the wall (§18.7, wired by §18 Part 4): Map<address, { name, name_state,
// banner }> for the given addresses. APPROVED + UNEXPIRED only — a pending, rejected, withdrawn,
// replaced or removed row can never contribute, because only status = 'approved' is selected.
//   name_state  shown · masked (no approved name) · expired
//   banner      { url, width, height } | null — every approved unexpired banner; the SLOT rule
//               (rank ≤ donor_banner_slots, never on the past strip) is the wall's job.
// opts: { ds, now, lastDonatedAt: Map<address, unix> | (address) => unix }
function publicProfiles(db, addresses, opts = {}) {
  const out = new Map();
  const list = Array.from(new Set((addresses || []).filter((a) => typeof a === 'string' && a !== '')));
  for (const a of list) out.set(a, { name: null, name_state: 'masked', banner: null });
  if (!list.length) return out;
  const now = clock(opts);
  const months = expiryMonths(opts.ds);
  const ld = opts.lastDonatedAt;
  const lastOf = (a) => (ld && typeof ld.get === 'function' ? ld.get(a) : (typeof ld === 'function' ? ld(a) : null));

  const CHUNK = 500;
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const rows = db.prepare(`
      SELECT grin_address, kind, name, file, width, height, decided_at
      FROM donor_requests
      WHERE status = 'approved' AND grin_address IN (${part.map(() => '?').join(',')})
    `).all(...part);
    for (const r of rows) {
      const p = out.get(r.grin_address);
      const expired = isExpired(r.decided_at, lastOf(r.grin_address), months, now);
      if (r.kind === 'name') {
        p.name = expired ? null : r.name;
        p.name_state = expired ? 'expired' : 'shown';
      } else if (r.kind === 'banner' && !expired) {
        const url = publicUrl(r.file);
        if (url) p.banner = { url, width: r.width, height: r.height };
      }
    }
  }
  return out;
}

// ── admin reads (wired by §18 Part 3) ──────────────────────────────────────────────────────
// Everything below is for secureAdmin routes only: FULL addresses, the pending name text, who
// decided. None of it may be called from a public route (scripts/test-public-leakage.js §9).

const STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'replaced', 'withdrawn', 'removed']);
const IMAGE_MIMES = Object.freeze(SNIFFERS.map((s) => s.mime));   // png, jpeg, gif — never svg/webp
const QUEUE_MAX = 500;

// The review queue (§18.6): rows of one status, oldest first for `pending` (first come, first
// reviewed) and newest decision first for the rest. Never selects `image` — a banner row says
// whether its bytes can be fetched (`has_image`), and the admin page asks the image route.
//   opts: { status = 'pending', limit, ds = donorSettings() (listText, poolName) }
// → { ok:true, status, total, rows } | { ok:false, code:'bad_status' }
// Each row: id, address, kind, status, name (name rows), mime/width/height/bytes/sha256 (banner
// rows), has_image, submitted_at, decided_at, decided_by, reason, flags (name rows — see
// donor-names.js nameFlags), current (the address's approved item of the same kind: its name,
// or its banner URL — so a reviewer sees a rename as a rename), blocked.
function adminQueue(db, opts = {}) {
  const status = opts.status === undefined || opts.status === null || opts.status === '' ? 'pending' : opts.status;
  if (!STATUSES.includes(status)) return { ok: false, code: 'bad_status' };
  const lim = Number.isSafeInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, QUEUE_MAX) : QUEUE_MAX;
  const order = status === 'pending' ? 'submitted_at ASC, id ASC' : 'decided_at DESC, id DESC';
  const rows = db.prepare(`
    SELECT id, grin_address, kind, status, name, file, mime, width, height, bytes, sha256,
           submitted_at, decided_at, decided_by, reason,
           CASE WHEN image IS NULL THEN 0 ELSE 1 END AS has_blob
    FROM donor_requests WHERE status = ? ORDER BY ${order} LIMIT ?
  `).all(status, lim);
  const total = db.prepare('SELECT COUNT(*) AS n FROM donor_requests WHERE status = ?').get(status).n;

  const approved = db.prepare(`
    SELECT grin_address AS address, kind, name, file FROM donor_requests WHERE status = 'approved'
  `).all();
  const liveOf = new Map();                       // `${address}|${kind}` → approved row
  for (const a of approved) liveOf.set(`${a.address}|${a.kind}`, a);
  const ds = opts.ds || {};
  const ctx = nameFlagContext(ds.listText, ds.poolName, approved.filter((a) => a.kind === 'name'));
  const blocked = new Set(db.prepare('SELECT grin_address FROM donor_blocks').all().map((r) => r.grin_address));

  return {
    ok: true, status, total,
    rows: rows.map((r) => {
      const live = liveOf.get(`${r.grin_address}|${r.kind}`) || null;
      const isBanner = r.kind === 'banner';
      return {
        id: r.id,
        address: r.grin_address,
        kind: r.kind,
        status: r.status,
        name: isBanner ? null : r.name,
        mime: isBanner ? r.mime : null,
        width: isBanner ? r.width : null,
        height: isBanner ? r.height : null,
        bytes: isBanner ? r.bytes : null,
        sha256: isBanner ? r.sha256 : null,
        // Pending bytes live in the row; approved bytes live in the file. Nothing else has any.
        has_image: isBanner && ((r.status === 'pending' && r.has_blob === 1) || (r.status === 'approved' && FILE_RE.test(String(r.file || '')))),
        submitted_at: r.submitted_at,
        decided_at: r.decided_at,
        decided_by: r.decided_by,
        reason: r.reason,
        flags: isBanner ? [] : nameFlags(r.name, r.grin_address, ctx),
        current: live && live.id !== r.id
          ? (isBanner ? { url: publicUrl(live.file) } : { name: live.name })
          : null,
        blocked: blocked.has(r.grin_address)
      };
    })
  };
}

// The bytes behind one banner request, for the admin image route: the pending blob, or the
// approved file read back from uploads/donors/. Every other status has no bytes (NULLed on the
// decision). The mime returned is the STORED sniffed one, and only if it is one of the three the
// sniffer can produce — anything else is a refusal, never a Content-Type we pass through.
// → { ok:true, mime, bytes } | { ok:false, code:'bad_id'|'not_found'|'no_image' }
function requestImage(db, id, opts = {}) {
  const rid = parseId(id);
  if (rid === null) return { ok: false, code: 'bad_id' };
  const row = db.prepare('SELECT kind, status, mime, image, file FROM donor_requests WHERE id = ?').get(rid);
  if (!row || row.kind !== 'banner') return { ok: false, code: 'not_found' };
  if (!IMAGE_MIMES.includes(row.mime)) return { ok: false, code: 'no_image' };
  if (row.status === 'pending') {
    return row.image && row.image.length ? { ok: true, mime: row.mime, bytes: Buffer.from(row.image) } : { ok: false, code: 'no_image' };
  }
  if (row.status !== 'approved' || !opts.uploadsDir || !FILE_RE.test(String(row.file || ''))) return { ok: false, code: 'no_image' };
  const dir = donorsDir(opts.uploadsDir);
  const p = path.join(dir, row.file);
  if (path.dirname(p) !== dir) return { ok: false, code: 'no_image' };
  try {
    const bytes = fs.readFileSync(p);
    return bytes.length ? { ok: true, mime: row.mime, bytes } : { ok: false, code: 'no_image' };
  } catch (_) {
    return { ok: false, code: 'no_image' };
  }
}

// Per-address profile state for the admin donors list: Map<address, { name, banner, pending,
// blocked }> for every address that has an approved or pending request, or a block.
//   name     { text, state: shown|expired, approved_at } | null   (the LIVE approved name)
//   banner   { url, width, height, state, approved_at } | null
//   pending  { name: bool, banner: bool }
//   blocked  { at, reason } | null
// Expiry uses the same rule as the donor's own page and the wall (isExpired), so "expired" here
// means exactly what the donor sees. opts: { ds, now, lastDonatedAt: Map | fn }.
function adminProfiles(db, opts = {}) {
  const now = clock(opts);
  const months = expiryMonths(opts.ds);
  const ld = opts.lastDonatedAt;
  const lastOf = (a) => (ld && typeof ld.get === 'function' ? ld.get(a) : (typeof ld === 'function' ? ld(a) : null));
  const out = new Map();
  const get = (a) => {
    let p = out.get(a);
    if (!p) { p = { name: null, banner: null, pending: { name: false, banner: false }, blocked: null }; out.set(a, p); }
    return p;
  };
  const rows = db.prepare(`
    SELECT grin_address, kind, status, name, file, width, height, decided_at
    FROM donor_requests WHERE status IN ('approved', 'pending')
  `).all();
  for (const r of rows) {
    const p = get(r.grin_address);
    if (r.status === 'pending') { p.pending[r.kind] = true; continue; }
    const state = isExpired(r.decided_at, lastOf(r.grin_address), months, now) ? 'expired' : 'shown';
    if (r.kind === 'name') p.name = { text: r.name, state, approved_at: r.decided_at };
    else p.banner = { url: publicUrl(r.file), width: r.width, height: r.height, state, approved_at: r.decided_at };
  }
  for (const b of db.prepare('SELECT grin_address, blocked_at, reason FROM donor_blocks').all()) {
    get(b.grin_address).blocked = { at: b.blocked_at, reason: b.reason || null };
  }
  return out;
}

// The nav badge + dashboard tile: requests waiting for a decision.
function pendingCount(db) {
  const r = db.prepare("SELECT COUNT(*) AS n FROM donor_requests WHERE status = 'pending'").get();
  return r ? r.n : 0;
}

module.exports = {
  KINDS, STATUSES,
  NAME_MIN, NAME_MAX, NAME_RULE,
  MAX_BANNER_BYTES, BANNER, BANNER_RULE,
  normaliseName, validateName,
  sniffBanner, parseDimensions, validateBanner,
  cleanReason,
  submitName, submitBanner, withdraw, removeLive,
  approve, reject, block, unblock,
  profileFor, publicProfiles,
  adminQueue, requestImage, adminProfiles, pendingCount,
  publicUrl, bannerSlots
};
