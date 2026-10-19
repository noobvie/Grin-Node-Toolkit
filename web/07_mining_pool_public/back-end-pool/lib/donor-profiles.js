'use strict';

// Donor profiles — script07_design.md §18.4–§18.6 and §18.12; names are auto-checked per
// script07_design_games.md §19.17.6. A donor's public NICKNAME, BANNER and LINK, set from the
// account page. Everything that decides what a profile IS lives here: the name check, the banner
// byte sniff + header-parsed dimensions, the link validator, the request state machine, the
// approved-file writes, and the two read shapes (the donor's own view for /api/account/:addr, the
// public view for the wall).
//
// NAMES are AUTO-CHECKED and live at once (games design D29): lib/name-rule.js with the donor shape (§18.5's
// character set, §16.4's reserved words, the code seed + the operator's `names.blocked_words`),
// then banned_donor_names, then "taken" (another address's approved name with the same matching
// form), then a 7-day change limit. BANNERS and LINKS stay PRE-moderated — a word list can check
// text, never an image or where a URL goes.
//
// No dependency on index.js (it starts a server on require) and none on donor-ledger.js:
// donorWall() reads publicProfiles() from here, so the require must only ever go
// ledger → profiles. Whatever needs the ledger (has this address donated? its league rank?) is
// passed in by the caller as a plain value.
//
// State machine, per (address × kind), each transition ONE transaction:
//   name     submit   → approved at once (the previous approved → replaced), or refused with
//                       nothing stored; `pending` is never written for a name. A live LINK of
//                       the address goes back to review in the same transaction (below)
//   banner,  submit   → pending     an existing pending → replaced (its blob NULLed); a live
//   link                            item stays live until the new one is approved
//            approve  → approved    the previous approved → replaced (a banner's file deleted)
//            reject   → rejected    (reason shown to the donor)
//            withdraw → withdrawn   the donor drops their own pending request
//   all      remove   → removed     the donor or an admin takes the live one down (file deleted)
//            block    → every pending of the address → withdrawn; donor_blocks row
//   name     ban      → banned_donor_names row + every live holder of that matching form removed
//   link     re-review  a new approved name (a first-ever one included) turns the live link →
//                       replaced + a new pending row with the same URL; a waiting link is
//                       re-issued under a new id too, so a stale admin approve fails
//                       (design §18.12). An admin removal, a ban or the
//                       donor's own removal of a name does not trigger it.
// The partial unique indexes (lib/db.js) make "one pending + one approved per kind" a database
// fact; a constraint hit comes back as { ok:false, code:'conflict' }, never as a throw.
//
// Admin transitions write their admin_audit_log row INSIDE the transaction (fail-closed): no
// admin decision lands without its audit row.
//
// ⚠ The pending name text, the pending image and the pending URL never leave this file through
// profileFor() or publicProfiles(): /api/account/:addr is public to anyone holding the address, and the wall is
// public to everyone. Only the admin reads at the bottom (adminQueue, requestImage), served by
// secureAdmin routes only, return them.
//
// Like a toolkit lib run without errexit (memory project_lib_errexit_suppression), every fs
// call's outcome is checked: a failed write aborts the approval and leaves the request pending;
// a failed unlink of a superseded file is reported back, never silently dropped.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SNIFFERS } = require('./asset-manager');
const { addMonthsUtc } = require('./donor-names');
const NameRule = require('./name-rule');

const KINDS = Object.freeze(['name', 'banner', 'link']);

// ── Name (script07_design.md §18.5 shape, script07_design_games.md §19.17.6 check) ──────────
// The shape is the name rule's `donor` shape (one definition, in lib/name-rule.js): trim,
// collapse ASCII whitespace runs to one space, 2–32 of A–Z a–z 0–9 space - _ . & ', at least
// one letter or digit, case kept (brands are cased). ASCII only: a homoglyph, a bidi override,
// a zero-width joiner or a Unicode space is refused, never normalised away.
const NAME_MIN = NameRule.DONOR_MIN;
const NAME_MAX = NameRule.DONOR_MAX;
const NAME_RULE = NameRule.DONOR_RULE;
// One change per 7 days, counted from the donor's own last change (an admin removal does not
// reset it). A code constant on purpose (script07_design_games.md §19.17.6): a form field for a
// knob nobody turns.
const NAME_CHANGE_DAYS = 7;
const NAME_CHANGE_SECS = NAME_CHANGE_DAYS * 86400;

// The answers a refused name gets. The rule's own list (reserved / blocked) and the database's
// (banned / taken) are deliberately GENERIC: which list hit, and whether a name is banned or
// merely taken, is the admin's to know — a donor who could tell would probe the lists.
const NAME_TEXT = Object.freeze({
  name_not_allowed: "That name isn't allowed. Please choose another.",
  name_unavailable: "That name isn't available. Please choose another.",
  unchanged: 'That is already your donor name.',
});

// Shape only → { ok:true, name } | { ok:false, code, error }. These refusals explain themselves.
function validateName(raw) {
  const r = NameRule.checkShape(raw, 'donor');
  if (r.ok) return r;
  return { ok: false, code: r.code, error: NameRule.DONOR_RULE_TEXT[r.code] || `A donor name must be ${NAME_RULE}.` };
}

// The rule's context for a donor name: the operator's `names.blocked_words` text as stored
// (folded, one entry per line, optional * / =) and the pool's name. Compiled once per call
// site; an unreadable list is the caller's '' — the code seed in the rule applies regardless.
function nameRuleContext(blockedText, poolName) {
  const lines = String(blockedText == null ? '' : blockedText).split('\n');
  return { shape: 'donor', poolName: poolName == null ? '' : String(poolName), blocked: NameRule.compileList(lines) };
}

const nameNorm = (name) => NameRule.matchForm(name);
const BAN_NORM_RE = /^[a-z0-9]{1,32}$/;

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

// ── Link (script07_design.md §18.12) ────────────────────────────────────────────────────────
// ONE reviewed link per donor. The validator runs on every submit AND on every read of an
// approved row (profileFor, publicProfiles, adminProfiles), so a row written by an older build
// or by hand can never become a live `javascript:` href. The STORED form is the normalised one —
// what the admin approves is exactly what the wall shows.
const LINK_MAX = 200;
const LINK_RULE = 'an https:// address, an http:// Tor v3 .onion address, or nostr:npub1… / nostr:nprofile1…, '
  + `up to ${LINK_MAX} characters`;
const LINK_TEXT = Object.freeze({
  link_empty: `No link was given. A link is ${LINK_RULE}.`,
  link_too_long: `That link is longer than ${LINK_MAX} characters.`,
  link_chars: 'A link cannot contain spaces, invisible or control characters, or backslashes.',
  link_scheme: `That kind of link is not accepted. A link is ${LINK_RULE}.`,
  link_host: 'That web address is not accepted: it needs a public domain name (no IP address, no localhost), and plain http:// only for a Tor v3 .onion address.',
  link_userinfo: 'A link cannot carry a user name or password (user:pass@).',
  link_nostr: 'A nostr: link must be an npub1… or nprofile1… identifier with a valid checksum, with nothing after it.',
  unchanged: 'That is already your link (live or waiting for review).',
  links_unavailable: 'Links are not available on this pool yet. Please tell the pool operator.',
});
// Whitespace in any script, C0/C1 controls, soft hyphen, zero-width and bidi controls, word
// joiners, the BOM — and the backslash, which the URL parser reads as a slash.
const LINK_BAD_CHARS = /[\s\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff\\]/;
const ONION_V3_RE = /^[a-z2-7]{56}\.onion$/;
// A v3 onion is base32(pubkey[32] | checksum[2] | 0x03); checksum = SHA3-256(".onion checksum" |
// pubkey | 0x03)[0..2]. Shape alone lets any 56 base32 characters wear the "Tor" label.
function onionV3Valid(label) {
  const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, acc = 0;
  const out = [];
  for (const c of label) {
    acc = (acc << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); acc &= (1 << bits) - 1; }
  }
  if (out.length !== 35 || out[34] !== 3) return false;
  const pub = Buffer.from(out.slice(0, 32));
  const sum = crypto.createHash('sha3-256').update(Buffer.concat([Buffer.from('.onion checksum'), pub, Buffer.from([3])])).digest();
  return sum[0] === out[32] && sum[1] === out[33];
}
const IPV4_RE = /^[0-9]+(\.[0-9]+){3}$/;
const HOST_LABEL_RE = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;
const TLD_RE = /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/;

// bech32 (BIP-173 checksum, constant 1 — NIP-19 entities are bech32, not bech32m).
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Valid(s) {
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) return false;
  const values = [];
  for (const c of s.slice(pos + 1)) {
    const v = BECH32_CHARSET.indexOf(c);
    if (v < 0) return false;
    values.push(v);
  }
  const hrp = s.slice(0, pos);
  const expanded = [];
  for (const c of hrp) expanded.push(c.charCodeAt(0) >> 5);
  expanded.push(0);
  for (const c of hrp) expanded.push(c.charCodeAt(0) & 31);
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of expanded.concat(values)) {
    const top = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk = (chk ^ GEN[i]) >>> 0;
  }
  return chk === 1;
}

// What the wall prints beside the name: the host for a web link, the identifier shortened to
// its first 9 and last 4 characters for nostr (`npub1abcd…wxyz`).
const nostrShort = (id) => (id.length > 13 ? `${id.slice(0, 9)}\u2026${id.slice(-4)}` : id);

// → { ok:true, url, host, kind: 'web'|'onion'|'nostr' } | { ok:false, code, error }
function validateLink(raw) {
  const no = (code) => ({ ok: false, code, error: LINK_TEXT[code] });
  if (typeof raw !== 'string') return no('link_empty');
  const s = raw.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');
  if (s === '') return no('link_empty');
  if (s.length > LINK_MAX) return no('link_too_long');
  if (LINK_BAD_CHARS.test(s)) return no('link_chars');

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (!scheme) return no('link_scheme');
  const proto = scheme[1].toLowerCase();

  if (proto === 'nostr') {
    const rest = s.slice(scheme[0].length).toLowerCase();
    if (rest.startsWith('//') || /[?#]/.test(rest)) return no('link_nostr');
    const m = /^(npub|nprofile)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.exec(rest);
    if (!m || (m[1] === 'npub' && rest.length !== 63) || !bech32Valid(rest)) return no('link_nostr');
    const url = `nostr:${rest}`;
    return url.length > LINK_MAX ? no('link_too_long') : { ok: true, url, host: nostrShort(rest), kind: 'nostr' };
  }
  if (proto !== 'https' && proto !== 'http') return no('link_scheme');
  // The raw text must say `<scheme>://<something>` itself: the parser would also repair
  // `https:/x` and `https:///x` into a valid URL, which is not what the donor typed.
  if (!/^[a-z]+:\/\/[^/]/i.test(s)) return no('link_scheme');
  const authority = s.slice(scheme[0].length + 2).split(/[/?#]/, 1)[0];
  if (authority.includes('@')) return no('link_userinfo');

  let u;
  try { u = new URL(s); } catch (_) { return no('link_host'); }
  // ⚠ Never call a URL setter on `u`. A host whose own Unicode label holds `xn--` serialises to
  // an href that does not re-parse (`https://аxn--.com` → `xn--xn---43d.com`), and any setter on
  // it then hits a native assertion that ABORTS the process — try/catch cannot catch it, and
  // this runs before the proofs. Refuse what does not re-parse; build the stored form as text.
  try { new URL(u.href); } catch (_) { return no('link_host'); }
  if (u.protocol !== `${proto}:`) return no('link_scheme');
  if (u.username !== '' || u.password !== '') return no('link_userinfo');
  let host = u.hostname;
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '' || host.startsWith('[') || IPV4_RE.test(host) || host === 'localhost') return no('link_host');
  const onion = ONION_V3_RE.test(host) && onionV3Valid(host.slice(0, 56));
  if (proto === 'http' && !onion) return no('link_host');
  const labels = host.split('.');
  if (!onion) {
    if (labels.length < 2 || !labels.every((l) => HOST_LABEL_RE.test(l))) return no('link_host');
    // Any `onion` label on a host that is not exactly a v3 onion is refused: a subdomain of an
    // onion, a short one, and the look-alike `<56>.onion.example.com`, which is a real
    // clearnet domain made to read as a Tor address on the wall.
    if (labels.includes('onion') || !TLD_RE.test(labels[labels.length - 1])) return no('link_host');
  }
  // Query and fragment dropped, default port already omitted by the parser.
  const hostPort = u.port ? `${host}:${u.port}` : host;
  const url = `${u.protocol}//${hostPort}${u.pathname}`;
  if (url.length > LINK_MAX) return no('link_too_long');
  return { ok: true, url, host: hostPort, kind: onion ? 'onion' : 'web' };
}

// ── shared helpers ──────────────────────────────────────────────────────────────────────────
const nowUnix = () => Math.floor(Date.now() / 1000);
const clock = (opts) => (Number.isFinite(opts && opts.now) ? Math.floor(opts.now) : nowUnix());
const isKind = (k) => KINDS.includes(k);

// Reason text is SHOWN to the donor, on a page anyone holding the address can open: one line,
// no control characters, ≤ 200 chars. Empty or not a string → null (never "[object Object]").
function cleanReason(r) {
  if (typeof r !== 'string') return null;
  const s = r.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return s === '' ? null : s;
}

const isConstraint = (e) => !!e && /constraint failed/i.test(String(e.message || ''));

// target_type 'donor' + the address, or 'donor_name' + a matching form (a ban is about a NAME,
// whoever holds it). adminId null = the system (migratePendingNames).
function audit(db, adminId, action, targetId, details, ip, targetType = 'donor') {
  db.prepare(`
    INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(Number.isFinite(adminId) ? adminId : null, action, targetType, targetId, JSON.stringify(details || {}),
         ip == null ? null : String(ip));
}

// ── files (approved banners only) ───────────────────────────────────────────────────────────
// uploads/donors/<16 hex>.<ext>: the name is random, the extension comes from the sniff. Served
// by nginx's existing `location /uploads/` (nosniff + sandbox CSP), which the deploy rsync
// excludes and the pool backup includes — verified against scripts/lib/07_lib_pool_nginx.sh, 07_lib_pool_install.sh and 07_lib_pool_backup.sh.
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
    INSERT INTO donor_requests (grin_address, kind, status, name, image, mime, width, height, bytes, sha256, url, submitted_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(address, kind, fields.name || null, fields.image || null, fields.mime || null,
         fields.width || null, fields.height || null, fields.bytes || null, fields.sha256 || null, fields.url || null, now);
  return { id: Number(info.lastInsertRowid), replaced: replaced > 0 };
}

// opts.inTx(db) — an extra check run inside the transaction, after the gate; a non-null return
// is the refusal.
function submit(db, address, kind, fields, opts) {
  const now = clock(opts);
  try {
    return db.transaction(() => {
      const bad = gateSubmit(db, address, opts);
      if (bad) return { ok: false, code: bad };
      const extra = opts && typeof opts.inTx === 'function' ? opts.inTx(db) : null;
      if (extra) return extra;
      const r = insertPending(db, address, kind, fields, now);
      return { ok: true, id: r.id, kind, replaced: r.replaced, submitted_at: now };
    })();
  } catch (e) {
    if (isConstraint(e)) return { ok: false, code: 'conflict' };
    throw e;
  }
}

// ── name: auto-checked, live at once (script07_design_games.md §19.17.6) ─────────────────────
const liveNameRow = (db, address) => db.prepare(
  "SELECT id, name, submitted_at FROM donor_requests WHERE grin_address = ? AND kind = 'name' AND status = 'approved'"
).get(address);

// Every approved name of OTHER addresses whose matching form equals `norm`. Approved includes an
// EXPIRED approval: it shows again the moment its donor donates, so it still owns the name. A
// scan, not an index: the matching form is the rule's (JS), and the table holds one approved
// name per donor — small, and read only on a submit (rate-limited) or an admin action.
function nameHolders(db, norm, exceptAddress) {
  return db.prepare("SELECT id, grin_address, name FROM donor_requests WHERE kind = 'name' AND status = 'approved'")
    .all().filter((r) => r.grin_address !== exceptAddress && nameNorm(r.name) === norm);
}
const isBannedNorm = (db, norm) => !!db.prepare('SELECT 1 FROM banned_donor_names WHERE norm = ?').get(norm);

// When this address may next change its name (unix), or null = now. Counted from its OWN last
// change: the newest name row that was ever live or submitted (approved, replaced, removed) —
// an admin removal keeps the row's submitted_at, so it does not reset the clock (the brake on
// "set an offensive name, get it removed, set the next one").
function nameChangeAvailableAt(db, address, now) {
  const r = db.prepare(`
    SELECT MAX(submitted_at) AS t FROM donor_requests
    WHERE grin_address = ? AND kind = 'name' AND status IN ('approved', 'replaced', 'removed')
  `).get(address);
  const at = r && Number.isFinite(r.t) ? r.t + NAME_CHANGE_SECS : null;
  return at !== null && at > now ? at : null;
}

// The checks that run BEFORE the route spends a proof attempt: none of them reads a word list,
// so a stranger holding the address learns nothing from them that the account page does not
// already show (the live name, and when it can change). → null | { ok:false, code, error?, available_at? }
function namePrecheck(db, address, name, opts = {}) {
  const now = clock(opts);
  const live = liveNameRow(db, address);
  if (live && live.name === name) return { ok: false, code: 'unchanged', error: NAME_TEXT.unchanged };
  const at = nameChangeAvailableAt(db, address, now);
  if (at !== null) {
    return { ok: false, code: 'name_cooldown', available_at: at,
             error: `A donor name can be changed once every ${NAME_CHANGE_DAYS} days. Your next change is possible from ${new Date(at * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC.` };
  }
  const lower = name.toLowerCase();
  if (lower.startsWith('grin1') || lower.startsWith('tgrin1')) {
    return { ok: false, code: 'name_address', error: NameRule.DONOR_RULE_TEXT.name_address };
  }
  return null;
}

// Submit → check → live. opts: { isDonor (MUST be true — see gateSubmit), rule: nameRuleContext(),
// now }. Everything runs in ONE transaction, the precheck included (the route ran it already, but
// the proof check awaited in between). A refused name's text is stored nowhere.
// → { ok:true, id, kind, name, replaced_id, submitted_at, link_review: linkBackToReview() }
//   | { ok:false, code, error?, available_at?, hit? }   hit = { list, entry } on name_not_allowed
//                                                       and { why: banned|taken } on name_unavailable —
//                                                       for the server log / audit, NEVER the response
function submitName(db, address, rawName, opts = {}) {
  const v = validateName(rawName);
  if (!v.ok) return v;
  const now = clock(opts);
  const ctx = opts.rule || nameRuleContext('', '');
  try {
    return db.transaction(() => {
      const bad = gateSubmit(db, address, opts);
      if (bad) return { ok: false, code: bad };
      const pre = namePrecheck(db, address, v.name, { now });
      if (pre) return pre;
      const r = NameRule.check(v.name, ctx);
      if (!r.ok) {
        if (r.code === 'name_reserved' || r.code === 'name_blocked') {
          return { ok: false, code: 'name_not_allowed', error: NAME_TEXT.name_not_allowed, hit: { list: r.list, entry: r.entry } };
        }
        return { ok: false, code: r.code, error: NameRule.DONOR_RULE_TEXT[r.code] || NAME_TEXT.name_not_allowed };
      }
      if (isBannedNorm(db, r.norm)) return { ok: false, code: 'name_unavailable', error: NAME_TEXT.name_unavailable, hit: { why: 'banned' } };
      if (nameHolders(db, r.norm, address).length) return { ok: false, code: 'name_unavailable', error: NAME_TEXT.name_unavailable, hit: { why: 'taken' } };

      // A legacy pending name cannot survive the startup migration, but never leave two rows
      // the unique indexes would have to arbitrate: any pending name goes too.
      db.prepare(`UPDATE donor_requests SET status = 'replaced', decided_at = ?
                  WHERE grin_address = ? AND kind = 'name' AND status = 'pending'`).run(now, address);
      const prev = liveNameRow(db, address);
      if (prev) db.prepare("UPDATE donor_requests SET status = 'replaced', decided_at = ? WHERE id = ?").run(now, prev.id);
      // decided_by NULL = the automatic check approved it (an admin id here means a human did,
      // which only rows from before the automatic check can say).
      const info = db.prepare(`
        INSERT INTO donor_requests (grin_address, kind, status, name, submitted_at, decided_at)
        VALUES (?, 'name', 'approved', ?, ?, ?)
      `).run(address, r.name, now, now);
      // A new displayed identity: a link approved beside the old name is judged again beside
      // this one (§18.12), so a harmless name cannot be swapped for "Official …" under it.
      const link = linkBackToReview(db, address, now);
      return { ok: true, id: Number(info.lastInsertRowid), kind: 'name', name: r.name, replaced_id: prev ? prev.id : null,
               submitted_at: now, link_review: link };
    })();
  } catch (e) {
    if (isConstraint(e)) return { ok: false, code: 'conflict' };
    throw e;
  }
}

// ── name bans (admin) ───────────────────────────────────────────────────────────────────────
// Why a pool table of its own and not one banned-names table with a scope column (script07_design_games.md
// §19.17.6 left the choice open): the pool has exactly ONE name namespace — donor names. Game nicknames are
// banned in the games' own database (games design D5: the services share no table), so a scope column here
// would hold one value forever and invite a second namespace nobody designed.

// Ban a matching form: no spelling of it can be taken again, and every address that holds it
// live loses it now (reason shown to them, as for a remove). One transaction, one audit row
// (target_type 'donor_name') listing the holders removed.
// → { ok:true, norm, removed: [{ id, address }] } | { ok:false, code:'bad_name'|'already_banned' }
function banName(db, rawName, opts = {}) {
  const shown = String(rawName == null ? '' : rawName).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 64);
  const norm = nameNorm(shown);
  if (!BAN_NORM_RE.test(norm)) return { ok: false, code: 'bad_name' };
  const now = clock(opts);
  const reason = cleanReason(opts.reason);
  const adminId = Number.isFinite(opts.adminId) ? opts.adminId : null;
  try {
    return db.transaction(() => {
      if (isBannedNorm(db, norm)) return { ok: false, code: 'already_banned' };
      db.prepare('INSERT INTO banned_donor_names (norm, name, banned_at, banned_by, reason) VALUES (?, ?, ?, ?, ?)')
        .run(norm, shown, now, adminId, reason);
      const holders = nameHolders(db, norm, null);
      for (const h of holders) {
        db.prepare("UPDATE donor_requests SET status = 'removed', decided_at = ?, decided_by = ?, reason = ? WHERE id = ?")
          .run(now, adminId, reason, h.id);
      }
      const removed = holders.map((h) => ({ id: h.id, address: h.grin_address }));
      audit(db, adminId, 'donor_name_ban', norm, { name: shown, reason, removed }, opts.ip, 'donor_name');
      return { ok: true, norm, removed };
    })();
  } catch (e) {
    if (isConstraint(e)) return { ok: false, code: 'already_banned' };
    throw e;
  }
}

// Lift a ban. Nothing is restored: a removed name stays removed. → { ok:true, norm } | { ok:false, code:'bad_name'|'not_banned' }
function unbanName(db, norm, opts = {}) {
  const n = String(norm == null ? '' : norm);
  if (!BAN_NORM_RE.test(n)) return { ok: false, code: 'bad_name' };
  return db.transaction(() => {
    const row = db.prepare('SELECT name FROM banned_donor_names WHERE norm = ?').get(n);
    if (!row) return { ok: false, code: 'not_banned' };
    db.prepare('DELETE FROM banned_donor_names WHERE norm = ?').run(n);
    audit(db, opts.adminId, 'donor_name_unban', n, { name: row.name }, opts.ip, 'donor_name');
    return { ok: true, norm: n };
  })();
}

// The ban list for the admin page, newest first.
function bannedNames(db) {
  return db.prepare('SELECT norm, name, banned_at, banned_by, reason FROM banned_donor_names ORDER BY banned_at DESC, norm').all();
}

// ── migration: legacy pending names → the automatic check ─────────────────────────────────
// Run at every start (index.js), after the blocked-word carry-over. Idempotent: nothing else
// writes a pending name, so after the first run it finds none. Each pending name, oldest first,
// goes through the same check a submit does, minus the 7-day limit (the request predates it):
// pass and available → approved (the address's previous approved → replaced), else → rejected
// with a reason the donor can read. Already-APPROVED names are KEPT — a human approved them —
// and the admin list flags any pair that now collides. Each decision writes one audit row
// (admin_id NULL = the system), inside its own transaction.
const MIGRATION_REASON = Object.freeze({
  rule: 'Donor names are now checked automatically, and this one did not pass. Please choose another.',
  unavailable: 'Donor names are now checked automatically, and this one is not available. Please choose another.',
});
function migratePendingNames(db, opts = {}) {
  const now = clock(opts);
  const ctx = opts.rule || nameRuleContext('', '');
  const out = { approved: 0, rejected: 0 };
  const rows = db.prepare("SELECT id, grin_address, name FROM donor_requests WHERE kind = 'name' AND status = 'pending' ORDER BY submitted_at, id").all();
  for (const row of rows) {
    db.transaction(() => {
      const cur = db.prepare('SELECT status FROM donor_requests WHERE id = ?').get(row.id);
      if (!cur || cur.status !== 'pending') return;
      const r = NameRule.check(row.name, ctx);
      let outcome = 'approved';
      let reason = null;
      if (!r.ok) { outcome = 'rejected'; reason = MIGRATION_REASON.rule; }
      else if (isBannedNorm(db, r.norm) || nameHolders(db, r.norm, row.grin_address).length) { outcome = 'rejected'; reason = MIGRATION_REASON.unavailable; }
      if (outcome === 'approved') {
        const prev = liveNameRow(db, row.grin_address);
        if (prev) db.prepare("UPDATE donor_requests SET status = 'replaced', decided_at = ? WHERE id = ?").run(now, prev.id);
        db.prepare("UPDATE donor_requests SET status = 'approved', decided_at = ?, decided_by = NULL, reason = NULL WHERE id = ?").run(now, row.id);
        out.approved++;
      } else {
        db.prepare("UPDATE donor_requests SET status = 'rejected', decided_at = ?, decided_by = NULL, reason = ? WHERE id = ?").run(now, reason, row.id);
        out.rejected++;
      }
      audit(db, null, 'donor_name_auto_v2', row.grin_address,
            { request_id: row.id, outcome, check: r.ok ? 'ok' : r.code }, null);
    })();
  }
  return out;
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

// ── link: pre-moderated (§18.12) ─────────────────────────────────────────────────────────────
const linkRow = (db, address, status) => db.prepare(
  "SELECT id, url, submitted_at, decided_at FROM donor_requests WHERE grin_address = ? AND kind = 'link' AND status = ?"
).get(address, status);

// The check the route runs BEFORE spending a proof attempt: the LIVE link only, which the wall
// and the account page already show. ⚠ Never the PENDING one here — "is this your pending URL?"
// answered to anyone holding the address would be an oracle for a value that is never returned
// (§18.12 "Account-page read shape"); submitLink compares it after the proofs instead.
// `url` is a validateLink() result's normalised url. → null | { ok:false, code:'unchanged', error }
function linkPrecheck(db, address, url) {
  const live = linkRow(db, address, 'approved');
  return live && live.url === url ? { ok: false, code: 'unchanged', error: LINK_TEXT.unchanged } : null;
}

// True when donor_requests' kind CHECK admits 'link' (false = the startup rebuild has not run).
function linksSupported(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'donor_requests'").get();
  return !!(row && /CHECK\s*\(\s*kind\s+IN\s*\([^)]*'link'/i.test(row.sql));
}

// → { ok:true, id, kind, url, host, link_kind, replaced, submitted_at } | { ok:false, code, error? }
function submitLink(db, address, raw, opts = {}) {
  const v = validateLink(raw);
  if (!v.ok) return v;
  const r = submit(db, address, 'link', { url: v.url }, Object.assign({}, opts, {
    inTx: (d) => {
      const live = linkRow(d, address, 'approved');
      const pend = linkRow(d, address, 'pending');
      return (live && live.url === v.url) || (pend && pend.url === v.url)
        ? { ok: false, code: 'unchanged', error: LINK_TEXT.unchanged } : null;
    }
  }));
  // A failed startup rebuild leaves the old kind CHECK, which refuses every link row as a
  // constraint error — say so instead of the "saved at the same moment" conflict.
  if (!r.ok && r.code === 'conflict' && !linksSupported(db)) return { ok: false, code: 'links_unavailable', error: LINK_TEXT.links_unavailable };
  return r.ok ? Object.assign(r, { url: v.url, host: v.host, link_kind: v.kind }) : r;
}

// The re-review a name change triggers (§18.12), run INSIDE submitName's transaction: the live
// link → replaced, and a FRESH pending row replaces any waiting one (the waiting URL wins, else
// the live URL). The fresh id is the point: an admin who judged the old card beside the old name
// holds the old id, and approve() refuses it as not_pending instead of publishing the link
// under the new name. ⚠ The WAITING URL wins because it is the donor's newest request — the live
// one was already on its way out; re-queueing the live URL would drop that request unannounced.
// → null (no link at all) | { replaced_id (the live link, or null), pending_id }
function linkBackToReview(db, address, now) {
  const live = linkRow(db, address, 'approved');
  const pend = linkRow(db, address, 'pending');
  const url = pend ? pend.url : live ? live.url : null;
  if (url === null) return null;
  if (live) db.prepare("UPDATE donor_requests SET status = 'replaced', decided_at = ? WHERE id = ?").run(now, live.id);
  const r = insertPending(db, address, 'link', { url }, now);
  return { replaced_id: live ? live.id : null, pending_id: r.id };
}

// A stored URL as every READ shows it: { url, host, kind } only when it re-validates to
// exactly itself, else null — the row stays in the table, it just never reaches a page.
function readLink(stored) {
  if (typeof stored !== 'string') return null;
  const v = validateLink(stored);
  return v.ok && v.url === stored ? { url: v.url, host: v.host, kind: v.kind } : null;
}
// For an admin audit row: the host of a link row (never the full URL), else null.
const linkHostOf = (row) => {
  if (!row || row.kind !== 'link') return null;
  const v = validateLink(row.url);
  return v.ok ? v.host : null;
};

// The donor drops their own pending request. `host` is for the caller's audit row (a link only).
// → { ok:true, id, host } | { ok:false, code:'bad_kind'|'nothing_pending' }
function withdraw(db, address, kind, opts = {}) {
  if (!isKind(kind)) return { ok: false, code: 'bad_kind' };
  const now = clock(opts);
  return db.transaction(() => {
    const row = db.prepare(
      "SELECT id, kind, url FROM donor_requests WHERE grin_address = ? AND kind = ? AND status = 'pending'"
    ).get(address, kind);
    if (!row) return { ok: false, code: 'nothing_pending' };
    db.prepare("UPDATE donor_requests SET status = 'withdrawn', image = NULL, decided_at = ? WHERE id = ?").run(now, row.id);
    return { ok: true, id: row.id, host: linkHostOf(row) };
  })();
}

// Take the LIVE (approved) item down. By the donor (no opts.adminId) or an admin (opts.adminId
// set → audited in the transaction, reason stored and shown to the donor). The file is unlinked
// after the commit — a crash between leaves an orphan file, never a live row pointing at nothing.
// `host` is for the caller's audit row (a link only).
// → { ok:true, id, host, file_deleted, warning? } | { ok:false, code:'bad_kind'|'nothing_live' }
function removeLive(db, address, kind, opts = {}) {
  if (!isKind(kind)) return { ok: false, code: 'bad_kind' };
  if (kind === 'banner' && !opts.uploadsDir) throw new Error('removeLive: uploadsDir is required for a banner');
  const now = clock(opts);
  const byAdmin = Number.isFinite(opts.adminId);
  const reason = cleanReason(opts.reason);
  const res = db.transaction(() => {
    const row = db.prepare(
      "SELECT id, kind, name, file, url FROM donor_requests WHERE grin_address = ? AND kind = ? AND status = 'approved'"
    ).get(address, kind);
    if (!row) return { ok: false, code: 'nothing_live' };
    db.prepare(`
      UPDATE donor_requests SET status = 'removed', decided_at = ?, decided_by = ?, reason = ?
      WHERE id = ?
    `).run(now, byAdmin ? opts.adminId : null, byAdmin ? reason : null, row.id);
    if (byAdmin) audit(db, opts.adminId, 'donor_profile_remove', address, { kind, request_id: row.id, name: row.name || null, host: linkHostOf(row), reason }, opts.ip);
    return { ok: true, id: row.id, file: row.file || null, host: linkHostOf(row) };
  })();
  if (!res.ok) return res;
  if (kind !== 'banner') return { ok: true, id: res.id, host: res.host, file_deleted: false };
  const u = unlinkBannerFile(opts.uploadsDir, res.file);
  return u.ok ? { ok: true, id: res.id, host: null, file_deleted: !!res.file } : { ok: true, id: res.id, host: null, file_deleted: false, warning: u.error };
}

// ── admin transitions ──────────────────────────────────────────────────────────────────────
// opts: { adminId, ip, now, reason, uploadsDir }.

const parseId = (id) => {
  const n = typeof id === 'number' ? id : (/^[0-9]{1,15}$/.test(String(id)) ? parseInt(id, 10) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

// → { ok:true, id, kind, address, file?, replaced_id, warning? }
//   | { ok:false, code:'bad_id'|'not_found'|'not_pending'|'blocked'|'no_image'|'invalid_image'|'invalid_link'|'write_failed'|'conflict' }
// For a banner the file is written FIRST (so the row never points at a missing file), then the
// transaction flips the rows; if the transaction fails the new file is unlinked again. The
// superseded file is unlinked only after the commit.
function approve(db, id, opts = {}) {
  const rid = parseId(id);
  if (rid === null) return { ok: false, code: 'bad_id' };
  const now = clock(opts);
  const row = db.prepare(
    'SELECT id, grin_address, kind, status, name, image, url FROM donor_requests WHERE id = ?'
  ).get(rid);
  if (!row) return { ok: false, code: 'not_found' };
  if (row.status !== 'pending') return { ok: false, code: 'not_pending' };
  if (db.prepare('SELECT 1 FROM donor_blocks WHERE grin_address = ?').get(row.grin_address)) return { ok: false, code: 'blocked' };

  // A link goes live only if its stored form still passes the validator unchanged (a row
  // written by hand or by an older build is refused here, not published).
  let linkHost = null;
  if (row.kind === 'link') {
    const v = validateLink(row.url);
    if (!v.ok || v.url !== row.url) return { ok: false, code: 'invalid_link', error: v.ok ? 'The stored link is not in its normalised form.' : v.error };
    linkHost = v.host;
  }

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
            { kind: row.kind, request_id: rid, name: row.name || null, file: newFile, host: linkHost, replaced_id: prev ? prev.id : null }, opts.ip);
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
    const row = db.prepare('SELECT id, grin_address, kind, status, name, url FROM donor_requests WHERE id = ?').get(rid);
    if (!row) return { ok: false, code: 'not_found' };
    if (row.status !== 'pending') return { ok: false, code: 'not_pending' };
    db.prepare(`
      UPDATE donor_requests SET status = 'rejected', image = NULL, decided_at = ?, decided_by = ?, reason = ?
      WHERE id = ?
    `).run(now, Number.isFinite(opts.adminId) ? opts.adminId : null, reason, rid);
    audit(db, opts.adminId, 'donor_request_reject', row.grin_address,
          { kind: row.kind, request_id: rid, name: row.name || null, host: linkHostOf(row), reason }, opts.ip);
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
// Never carries the pending name, the pending URL, any image bytes, decided_by, or who removed
// an item.
function profileFor(db, address, opts = {}) {
  const now = clock(opts);
  const months = expiryMonths(opts.ds);
  const slots = bannerSlots(opts.ds);
  const active = opts.active === true;
  const lastDonatedAt = opts.lastDonatedAt == null ? null : Number(opts.lastDonatedAt);
  const isDonor = lastDonatedAt !== null && Number.isFinite(lastDonatedAt);
  const blocked = !!db.prepare('SELECT 1 FROM donor_blocks WHERE grin_address = ?').get(address);

  // The name and the URL only from the APPROVED row: a pending one's text never comes back.
  const current = db.prepare(`
    SELECT ${READ_COLS}, CASE WHEN status = 'approved' THEN name END AS live_name,
           CASE WHEN status = 'approved' THEN url END AS live_link
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

  // A stored link that no longer re-validates reads as no link at all (state none).
  const linkAp = pick('link', 'approved');
  const linkPend = pick('link', 'pending');
  const linkVal = linkAp ? readLink(linkAp.live_link) : null;
  const linkState = !linkVal ? 'none' : (isExpired(linkAp.decided_at, lastDonatedAt, months, now) ? 'expired' : 'shown');

  const nameWord = lastWord('name');
  const banWord = lastWord('banner');
  const linkWord = lastWord('link');
  return {
    eligible: active && isDonor,
    blocked,
    refusal,
    name: {
      live: nameState === 'shown' ? nameAp.live_name : null,
      state: nameState,
      // Always null (names go live at once); kept so the shape does not move.
      pending_at: namePend ? namePend.submitted_at : null,
      rejected: nameWord.rejected,
      removed: nameWord.removed,
      // When the 7-day change limit lets this address set a name again; null = now.
      change_available_at: nameChangeAvailableAt(db, address, now)
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
    },
    // §18.12: the LIVE link may be shown (it is public on the wall); a pending one is reported
    // by its submit time only — never its URL.
    link: {
      live: linkState === 'shown' ? linkVal : null,
      state: linkState,
      pending_at: linkPend ? linkPend.submitted_at : null,
      rejected: linkWord.rejected,
      removed: linkWord.removed
    }
  };
}

// The public view for the wall (§18.7, §18.12): Map<address, { name, name_state,
// banner, link }> for the given addresses. APPROVED + UNEXPIRED only — a pending, rejected, withdrawn,
// replaced or removed row can never contribute, because only status = 'approved' is selected.
//   name_state  shown · masked (no approved name) · expired
//   banner      { url, width, height } | null — every approved unexpired banner; the SLOT rule
//               (rank ≤ donor_banner_slots, never on the past strip) is the wall's job.
//   link        { url, host, kind } | null — re-validated here (readLink), so a stored row that
//               no longer passes is simply absent; "never on the past strip" is the wall's job.
// opts: { ds, now, lastDonatedAt: Map<address, unix> | (address) => unix }
function publicProfiles(db, addresses, opts = {}) {
  const out = new Map();
  const list = Array.from(new Set((addresses || []).filter((a) => typeof a === 'string' && a !== '')));
  for (const a of list) out.set(a, { name: null, name_state: 'masked', banner: null, link: null });
  if (!list.length) return out;
  const now = clock(opts);
  const months = expiryMonths(opts.ds);
  const ld = opts.lastDonatedAt;
  const lastOf = (a) => (ld && typeof ld.get === 'function' ? ld.get(a) : (typeof ld === 'function' ? ld(a) : null));

  const CHUNK = 500;
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const rows = db.prepare(`
      SELECT grin_address, kind, name, file, width, height, url, decided_at
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
      } else if (r.kind === 'link' && !expired) {
        p.link = readLink(r.url);
      }
    }
  }
  return out;
}

// ── admin reads ────────────────────────────────────────────────────────────────────────────
// Everything below is for secureAdmin routes only: FULL addresses, the pending name text, who
// decided. None of it may be called from a public route (scripts/test-public-leakage.js §9).

const STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'replaced', 'withdrawn', 'removed']);
const IMAGE_MIMES = Object.freeze(SNIFFERS.map((s) => s.mime));   // png, jpeg, gif — never svg/webp
const QUEUE_MAX = 500;

// The review queue (§18.6): rows of one status, oldest first for `pending` (first come, first
// reviewed) and newest decision first for the rest. Never selects `image` — a banner row says
// whether its bytes can be fetched (`has_image`), and the admin page asks the image route.
// The queue is BANNERS and LINKS: names are checked automatically and listed by adminNames().
// `kind` narrows the rows (the admin page asks per kind); absent = all, for the history.
//   opts: { status = 'pending', kind, limit }
// → { ok:true, status, total, rows } | { ok:false, code:'bad_status'|'bad_kind' }
// Each row: id, address, kind, status, name (name rows), mime/width/height/bytes/sha256 (banner
// rows), has_image, url/host/link_kind (link rows: the STORED url as the admin approves it; host
// and link_kind null when it no longer validates), live_name (link rows: the address's approved
// name NOW, null = none — the pair is what is judged, §18.12), same_host_as (link rows: other
// addresses whose live link has the same host — a hint, never a refusal), submitted_at,
// decided_at, decided_by, reason, current (the address's approved item of the same kind: its
// name, its banner URL or its link URL — so a reviewer sees a replacement as one), blocked.
function adminQueue(db, opts = {}) {
  const status = opts.status === undefined || opts.status === null || opts.status === '' ? 'pending' : opts.status;
  if (!STATUSES.includes(status)) return { ok: false, code: 'bad_status' };
  const kind = opts.kind === undefined || opts.kind === null || opts.kind === '' ? null : opts.kind;
  if (kind !== null && !isKind(kind)) return { ok: false, code: 'bad_kind' };
  const lim = Number.isSafeInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, QUEUE_MAX) : QUEUE_MAX;
  const order = status === 'pending' ? 'submitted_at ASC, id ASC' : 'decided_at DESC, id DESC';
  const kindSql = kind === null ? '' : ' AND kind = ?';
  const args = kind === null ? [status] : [status, kind];
  const rows = db.prepare(`
    SELECT id, grin_address, kind, status, name, file, mime, width, height, bytes, sha256, url,
           submitted_at, decided_at, decided_by, reason,
           CASE WHEN image IS NULL THEN 0 ELSE 1 END AS has_blob
    FROM donor_requests WHERE status = ?${kindSql} ORDER BY ${order} LIMIT ?
  `).all(...args, lim);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM donor_requests WHERE status = ?${kindSql}`).get(...args).n;

  // `id` is selected so an APPROVED row (the history view) is not shown as replacing itself.
  const approved = db.prepare(`
    SELECT id, grin_address AS address, kind, name, file, url FROM donor_requests WHERE status = 'approved'
  `).all();
  const liveOf = new Map();                       // `${address}|${kind}` → approved row
  const liveHosts = new Map();                    // host key → addresses with that live link
  // A web link compares on its host, a nostr link on its whole identifier.
  const hostKey = (l) => (l.kind === 'nostr' ? l.url : l.host);
  for (const a of approved) {
    liveOf.set(`${a.address}|${a.kind}`, a);
    const l = a.kind === 'link' ? readLink(a.url) : null;
    if (l) liveHosts.set(hostKey(l), (liveHosts.get(hostKey(l)) || []).concat(a.address));
  }
  const blocked = new Set(db.prepare('SELECT grin_address FROM donor_blocks').all().map((r) => r.grin_address));

  return {
    ok: true, status, total,
    rows: rows.map((r) => {
      const live = liveOf.get(`${r.grin_address}|${r.kind}`) || null;
      const isBanner = r.kind === 'banner';
      const isLink = r.kind === 'link';
      const lv = isLink ? validateLink(r.url) : null;
      const nameRow = isLink ? liveOf.get(`${r.grin_address}|name`) : null;
      let current = null;
      if (live && live.id !== r.id) {
        current = isBanner ? { url: publicUrl(live.file) } : (isLink ? { url: live.url } : { name: live.name });
      }
      return {
        id: r.id,
        address: r.grin_address,
        kind: r.kind,
        status: r.status,
        name: r.kind === 'name' ? r.name : null,
        mime: isBanner ? r.mime : null,
        width: isBanner ? r.width : null,
        height: isBanner ? r.height : null,
        bytes: isBanner ? r.bytes : null,
        sha256: isBanner ? r.sha256 : null,
        // Pending bytes live in the row; approved bytes live in the file. Nothing else has any.
        has_image: isBanner && ((r.status === 'pending' && r.has_blob === 1) || (r.status === 'approved' && FILE_RE.test(String(r.file || '')))),
        url: isLink ? r.url : null,
        host: lv && lv.ok ? lv.host : null,
        link_kind: lv && lv.ok ? lv.kind : null,
        live_name: nameRow ? nameRow.name : null,
        same_host_as: lv && lv.ok ? (liveHosts.get(hostKey(lv)) || []).filter((a) => a !== r.grin_address) : [],
        submitted_at: r.submitted_at,
        decided_at: r.decided_at,
        decided_by: r.decided_by,
        reason: r.reason,
        current,
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

// Per-address profile state for the admin donors list: Map<address, { name, banner, link,
// pending, blocked }> for every address that has an approved or pending request, or a block.
//   name     { text, state: shown|expired, approved_at } | null   (the LIVE approved name)
//   banner   { url, width, height, state, approved_at } | null
//   link     { url, host, kind, state, approved_at } | null       (re-validated, as on the wall)
//   pending  { name: bool, banner: bool, link: bool }
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
    if (!p) { p = { name: null, banner: null, link: null, pending: { name: false, banner: false, link: false }, blocked: null }; out.set(a, p); }
    return p;
  };
  const rows = db.prepare(`
    SELECT grin_address, kind, status, name, file, width, height, url, decided_at
    FROM donor_requests WHERE status IN ('approved', 'pending')
  `).all();
  for (const r of rows) {
    const p = get(r.grin_address);
    if (r.status === 'pending') { p.pending[r.kind] = true; continue; }
    const state = isExpired(r.decided_at, lastOf(r.grin_address), months, now) ? 'expired' : 'shown';
    if (r.kind === 'name') p.name = { text: r.name, state, approved_at: r.decided_at };
    else if (r.kind === 'banner') p.banner = { url: publicUrl(r.file), width: r.width, height: r.height, state, approved_at: r.decided_at };
    else if (r.kind === 'link') {
      const l = readLink(r.url);
      if (l) p.link = Object.assign(l, { state, approved_at: r.decided_at });
    }
  }
  for (const b of db.prepare('SELECT grin_address, blocked_at, reason FROM donor_blocks').all()) {
    get(b.grin_address).blocked = { at: b.blocked_at, reason: b.reason || null };
  }
  return out;
}

// The donor-names admin list (script07_design_games.md §19.17.6 "Live names"), FULL addresses —
// secureAdmin only.
//   opts: { state: 'live' (default) | 'removed', q, rule: nameRuleContext(), limit }
// live rows:    id, address, name, set_at, approved_by (admin id; null = the automatic check),
//               hit (what the rule answers TODAY: null, or { code, list, entry } — a word added
//               after the name went live is HINTED here, never applied by itself: taking a live
//               name down is a human decision), banned (its form is on the ban list), same_as
//               (other addresses whose approved name has the same matching form — only names
//               approved before the automatic check can collide), blocked.
// removed rows: id, address, name, set_at, removed_at, removed_by (admin id; null = the donor
//               took it down, or a legacy row), reason.
// q: an address start, or a name fragment compared on the matching form (so `sh1t` finds Shit).
// → { ok:true, state, total, rows } | { ok:false, code:'bad_state' }
function adminNames(db, opts = {}) {
  const state = opts.state === undefined || opts.state === null || opts.state === '' ? 'live' : opts.state;
  if (state !== 'live' && state !== 'removed') return { ok: false, code: 'bad_state' };
  const lim = Number.isSafeInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, QUEUE_MAX) : QUEUE_MAX;
  const q = typeof opts.q === 'string' ? opts.q.trim().slice(0, 64) : '';
  const qNorm = nameNorm(q);
  const match = (r) => q === '' || r.grin_address.startsWith(q) || (qNorm !== '' && nameNorm(r.name).includes(qNorm));
  const status = state === 'live' ? 'approved' : 'removed';
  const order = state === 'live' ? 'submitted_at DESC, id DESC' : 'decided_at DESC, id DESC';
  const all = db.prepare(`
    SELECT id, grin_address, name, submitted_at, decided_at, decided_by, reason
    FROM donor_requests WHERE kind = 'name' AND status = ? ORDER BY ${order}
  `).all(status).filter(match);
  const rows = all.slice(0, lim);
  if (state === 'removed') {
    return {
      ok: true, state, total: all.length,
      rows: rows.map((r) => ({ id: r.id, address: r.grin_address, name: r.name, set_at: r.submitted_at,
                               removed_at: r.decided_at, removed_by: r.decided_by, reason: r.reason }))
    };
  }
  const ctx = opts.rule || nameRuleContext('', '');
  const byNorm = new Map();
  for (const r of db.prepare("SELECT grin_address, name FROM donor_requests WHERE kind = 'name' AND status = 'approved'").all()) {
    const n = nameNorm(r.name);
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push(r.grin_address);
  }
  const banned = new Set(db.prepare('SELECT norm FROM banned_donor_names').all().map((r) => r.norm));
  const blocked = new Set(db.prepare('SELECT grin_address FROM donor_blocks').all().map((r) => r.grin_address));
  return {
    ok: true, state, total: all.length,
    rows: rows.map((r) => {
      const n = nameNorm(r.name);
      const v = NameRule.check(r.name, ctx);
      return {
        id: r.id, address: r.grin_address, name: r.name, set_at: r.submitted_at, approved_by: r.decided_by,
        hit: v.ok ? null : { code: v.code, list: v.list || null, entry: v.entry || null },
        banned: banned.has(n),
        same_as: (byNorm.get(n) || []).filter((a) => a !== r.grin_address),
        blocked: blocked.has(r.grin_address)
      };
    })
  };
}

// The nav badge + dashboard tile: requests waiting for a decision.
function pendingCount(db) {
  const r = db.prepare("SELECT COUNT(*) AS n FROM donor_requests WHERE status = 'pending'").get();
  return r ? r.n : 0;
}

module.exports = {
  KINDS, STATUSES,
  NAME_MIN, NAME_MAX, NAME_RULE, NAME_CHANGE_DAYS, NAME_TEXT,
  MAX_BANNER_BYTES, BANNER, BANNER_RULE,
  LINK_MAX, LINK_RULE, LINK_TEXT, linksSupported,
  validateName, nameRuleContext, namePrecheck, nameChangeAvailableAt,
  sniffBanner, parseDimensions, validateBanner,
  validateLink, linkPrecheck, readLink,
  cleanReason,
  submitName, submitBanner, submitLink, withdraw, removeLive,
  approve, reject, block, unblock,
  banName, unbanName, bannedNames, migratePendingNames,
  profileFor, publicProfiles,
  adminQueue, adminNames, requestImage, adminProfiles, pendingCount,
  publicUrl, bannerSlots
};
