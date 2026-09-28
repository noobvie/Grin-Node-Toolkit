'use strict';

// Approved nicknames (design §19.16, D19 amended by Part 12).
//
//   POST /play/api/nickname            { name }   submit → pending (replaces your pending one)
//   POST /play/api/nickname/withdraw   {}         pending → withdrawn
//   POST /play/api/nickname/remove     {}         your live one → removed
//   /me carries `nickname` (built here: meView)
//
//   admin (/internal/admin/*, all STEP-UP — none is in FAST_WRITES, like the pool's donor queue):
//   GET  nicknames?state=pending|approved|rejected   the queue / lists, full addresses + flags
//   POST nicknames/:id/approve  {}                   pending → approved (the old live one → replaced)
//   POST nicknames/:id/reject   {reason?}            pending → rejected (the reason is shown to the player)
//   POST nicknames/:id/remove   {reason?}            approved → removed
//
// The rules this module owns:
//   - PRE-moderated: nothing a player types is shown to anyone else until the operator
//     approves it. The pending text is shown only to its own author (/me is session-bound —
//     unlike the pool's account page, which is public to anyone holding the address, §18.6).
//   - A nickname is NEVER shown alone: label() returns `Nick (grin1abcd…wxyz)`, so every public
//     surface carries the same 9…4 mask it carried before (§19.13 #10: a mask costs ~2^40 key
//     generations to grind; a nickname costs nothing to copy). The composition happens HERE,
//     on the server, into the one `name` field — no client can drop the mask, because no
//     response carries the nickname without it.
//   - The operator's badge and the Mod badge stay the only trusted markers: role words are
//     refused outright, and two live nicknames can never share a matching form (a partial
//     unique index, so it is a database fact, not a check that a race can slip past).
//   - Acting on a nickname needs a CHAT-CAPABLE session (the same aged, non-anchor, mining
//     bar as posting, whatever the chat switch says): a stranger who mined a few shares to
//     your address must not be able to name you.
//
// Validation copies the pool's donor-name RULES (back-end-pool/lib/donor-profiles.js §18.5,
// lib/donor-names.js normalise) — copied, not required: the two services deploy separately
// and the games never load pool code (D5). Where it differs, and why, is §19.16.

const { HttpError, parseIntStrict } = require('./http');
const { maskAddr } = require('./mask');
const { normaliseBody } = require('./chat');

const NAME_MIN = 2;
const NAME_MAX = 20;       // the donor rule is 32; a chat line and a board row have less room
// ASCII only, as §18.5: no homoglyphs (Cyrillic а), no bidi overrides, no zero-width
// characters — none is in this class, so each is refused rather than normalised away. The
// dot of the donor rule is NOT here: a nickname sits beside chat, and `free-grin.io` as a
// name would be the scam link the chat's link hold exists to stop.
const NAME_CHARSET_RE = /^[A-Za-z0-9 \-_&']+$/;
const NAME_RULE = `${NAME_MIN}–${NAME_MAX} characters: letters, digits, spaces and - _ & ' only, with at least one letter`;

// The matching form (donor-names.js normalise, copied): lowercase, separators stripped, six
// leet digits mapped back — `0per4tor` → `operator`, `B o b` → `bob`. Used for the role
// words, the flags and the one-live-per-form rule.
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' };
function matchForm(name) {
  return String(name == null ? '' : name).toLowerCase()
    .replace(/[\s\-_.&']/g, '')
    .replace(/[013457]/g, (c) => LEET[c]);
}

// REFUSED outright: the words the page's own badges say. A nickname beside the mask could
// otherwise read as a badge ("Operator (grin1…)").
const ROLE_WORDS = Object.freeze(['operator', 'admin', 'moderator']);
// FLAGGED for the operator (a hint in the queue, never a decision): the pool's reserved
// words (donor-names.js RESERVED, copied) plus the two short labels this page uses itself.
const RESERVED = Object.freeze([
  'official', 'support', 'staff', 'pool', 'grinium', 'prize', 'jackpot', 'winner', 'mod', 'bot',
]);

function normaliseName(raw) {
  return String(raw == null ? '' : raw).replace(/[ \t\r\n\f\v]+/g, ' ').trim();
}

// → { ok:true, name, norm } | { ok:false, code }
function validateName(raw) {
  if (typeof raw !== 'string') return { ok: false, code: 'name_invalid' };
  const name = normaliseName(raw);
  if (name.length < NAME_MIN || name.length > NAME_MAX) return { ok: false, code: 'name_length' };
  if (!NAME_CHARSET_RE.test(name)) return { ok: false, code: 'name_charset' };
  if (!/[A-Za-z]/.test(name)) return { ok: false, code: 'name_no_letter' };
  // An address-like name (`grin1…`, `tgrin1…`) would sit in chat looking like a payment
  // target. Checked on the lower-cased name with separators out, BEFORE the leet fold
  // (which would turn the 1 into an i).
  if (/t?grin1/.test(name.toLowerCase().replace(/[\s\-_&']/g, ''))) return { ok: false, code: 'name_address' };
  const norm = matchForm(name);
  if (ROLE_WORDS.some((w) => norm.includes(w))) return { ok: false, code: 'name_role' };
  return { ok: true, name, norm };
}

const RULE_TEXT = Object.freeze({
  name_invalid: `A nickname must be text: ${NAME_RULE}.`,
  name_length: `A nickname must be ${NAME_RULE}.`,
  name_charset: `That nickname has a character that is not allowed. A nickname must be ${NAME_RULE}.`,
  name_no_letter: `A nickname needs at least one letter (${NAME_RULE}).`,
  name_address: 'A nickname cannot look like a GRIN address.',
  name_role: 'A nickname cannot contain "operator", "admin" or "moderator" — those are badges the page gives.',
});

const DAY = 86400;
const SUBMITS_PER_DAY = 5;            // per address, counted from the table (survives a restart)
const REASON_MAX = 200;
const LIST_MAX = 200;
const KEEP_DECIDED_S = 180 * DAY;     // rejected / replaced / withdrawn / removed rows (§19.13 #19)
const PURGE_BATCH = 5000;
const SELF = 'self';                  // decided_by for the player's own withdraw / remove

function createNames({ db, auth, sessions, settings, admin, ledger, config, words = () => [], now = () => Math.floor(Date.now() / 1000) }) {
  const raw = db.raw;
  const prefix = config.net === 'mainnet' ? 'grin1' : 'tgrin1';
  const COLS = 'id, address, name, norm, state, submitted_at, decided_at, decided_by, reason';
  const stmts = {
    live: raw.prepare('SELECT address, name FROM nicknames WHERE state = \'approved\''),
    byId: raw.prepare(`SELECT ${COLS} FROM nicknames WHERE id = ?`),
    liveOf: raw.prepare(`SELECT ${COLS} FROM nicknames WHERE address = ? AND state = 'approved'`),
    pendingOf: raw.prepare(`SELECT ${COLS} FROM nicknames WHERE address = ? AND state = 'pending'`),
    lastOf: raw.prepare(`SELECT ${COLS} FROM nicknames WHERE address = ? ORDER BY id DESC LIMIT 1`),
    takenBy: raw.prepare('SELECT address FROM nicknames WHERE norm = ? AND state = \'approved\' AND address != ?'),
    pendingSame: raw.prepare('SELECT address FROM nicknames WHERE norm = ? AND state = \'pending\' AND address != ? LIMIT 5'),
    submitsSince: raw.prepare('SELECT COUNT(*) AS n FROM nicknames WHERE address = ? AND submitted_at > ?'),
    insert: raw.prepare('INSERT INTO nicknames (address, name, norm, state, submitted_at) VALUES (?, ?, ?, \'pending\', ?)'),
    decide: raw.prepare('UPDATE nicknames SET state = ?, decided_at = ?, decided_by = ?, reason = ? WHERE id = ? AND state = ?'),
    list: raw.prepare(`SELECT ${COLS} FROM nicknames WHERE state = ? ORDER BY id ASC LIMIT ?`),
    listDesc: raw.prepare(`SELECT ${COLS} FROM nicknames WHERE state = ? ORDER BY id DESC LIMIT ?`),
    count: raw.prepare('SELECT COUNT(*) AS n FROM nicknames WHERE state = ?'),
    oldIds: raw.prepare(
      "SELECT id FROM nicknames WHERE state IN ('rejected','replaced','withdrawn','removed') AND COALESCE(decided_at, submitted_at) < ? ORDER BY id ASC LIMIT ?"),
    del: raw.prepare('DELETE FROM nicknames WHERE id = ?'),
  };

  const bad = (field) => new HttpError(400, 'bad_request', { field });
  const enabled = () => settings.get('nicknames_enabled') === true;

  // ── The display cache: address → approved nickname. Tiny (one row per named player) and
  // read on every chat line and board row; invalidated by every write that changes it.
  let liveMap = null;
  const live = () => {
    if (!liveMap) liveMap = new Map(stmts.live.all().map((r) => [r.address, r.name]));
    return liveMap;
  };
  const invalidate = () => { liveMap = null; };

  // THE public name of an address: the mask, or `Nick (mask)`. Never the nickname alone.
  function label(address) {
    const mask = maskAddr(address);
    if (!enabled() || typeof address !== 'string') return mask;
    const n = live().get(address);
    return n ? `${n} (${mask})` : mask;
  }

  // ── Player side ─────────────────────────────────────────────────────────────────────
  // The same bar as posting in chat (auth.chatStatus), minus the chat switch: a nickname is
  // shown on the boards too, so turning chat off must not freeze everyone's name.
  function gate(s) {
    if (!enabled()) return { can_submit: false, reason: 'nicknames_off', available_at: null };
    const st = auth.chatStatus(s, { ignoreChatSwitch: true });
    return { can_submit: st.can_post, reason: st.reason, available_at: st.available_at };
  }

  function requireGate(ctx) {
    const s = auth.requireSession(ctx);
    const g = gate(s);
    if (!g.can_submit) {
      if (g.reason === 'nicknames_off') throw new HttpError(403, 'nicknames_off');
      throw new HttpError(403, 'nickname_refused', { reason: g.reason, available_at: g.available_at });
    }
    return s;
  }

  function onlyKeys(b, allowed) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body');
    for (const k of Object.keys(b)) if (!allowed.includes(k)) throw bad('body');
    return b;
  }

  // What /me says about the caller's own nickname. The pending text is the caller's OWN
  // (the session proves it), so it is shown back to them — to nobody else.
  function meView(s) {
    const g = gate(s);
    const l = stmts.liveOf.get(s.address);
    const p = stmts.pendingOf.get(s.address);
    const last = stmts.lastOf.get(s.address);
    const refused = last && (last.state === 'rejected' || (last.state === 'removed' && last.decided_by !== SELF)) ? last : null;
    return {
      enabled: enabled(),
      live: l ? l.name : null,
      shown_as: label(s.address),
      pending: p ? { name: p.name, at: p.submitted_at } : null,
      refused: refused ? { name: refused.name, state: refused.state, reason: refused.reason, at: refused.decided_at } : null,
      can_submit: g.can_submit,
      reason: g.reason,
      available_at: g.available_at,
      rule: NAME_RULE,
    };
  }

  function submit(ctx) {
    const s = requireGate(ctx);
    const b = onlyKeys(ctx.body, ['name']);
    const v = validateName(b.name);
    if (!v.ok) throw new HttpError(400, v.code, { hint: RULE_TEXT[v.code] });
    const t = now();
    db.transaction(() => {
      if (stmts.submitsSince.get(s.address, t - DAY).n >= SUBMITS_PER_DAY) {
        throw new HttpError(429, 'too_many_requests', { retry_after: 3600 }, { 'Retry-After': '3600' });
      }
      const l = stmts.liveOf.get(s.address);
      if (l && l.name === v.name) throw new HttpError(409, 'unchanged');
      if (stmts.takenBy.get(v.norm, s.address)) throw new HttpError(409, 'nickname_taken');
      const p = stmts.pendingOf.get(s.address);
      if (p && p.name === v.name) throw new HttpError(409, 'unchanged');
      if (p) stmts.decide.run('replaced', t, SELF, null, p.id, 'pending');
      ledger.ensurePlayer(s.address, t);
      stmts.insert.run(s.address, v.name, v.norm, t);
    });
    return { ok: true, nickname: meView(s) };
  }

  function withdraw(ctx) {
    const s = requireGate(ctx);
    onlyKeys(ctx.body, []);
    const t = now();
    const changed = db.transaction(() => {
      const p = stmts.pendingOf.get(s.address);
      return p ? stmts.decide.run('withdrawn', t, SELF, null, p.id, 'pending').changes : 0;
    });
    return { ok: true, changed: changed === 1, nickname: meView(s) };
  }

  function removeOwn(ctx) {
    const s = requireGate(ctx);
    onlyKeys(ctx.body, []);
    const t = now();
    const changed = db.transaction(() => {
      const l = stmts.liveOf.get(s.address);
      return l ? stmts.decide.run('removed', t, SELF, null, l.id, 'approved').changes : 0;
    });
    invalidate();
    return { ok: true, changed: changed === 1, nickname: meView(s) };
  }

  // ── Operator side ───────────────────────────────────────────────────────────────────
  // Flags on a queued name — hints, never decisions (as the donor queue, §18.6):
  //   reserved   a RESERVED word                 word       a chat word-list entry
  //   same_as    another address's LIVE nickname matches (cannot be approved: 409)
  //   pending_same  another address's PENDING nickname matches
  function flagsOf(r) {
    const out = [];
    const r1 = RESERVED.find((w) => r.norm.includes(w));
    if (r1) out.push({ type: 'reserved', word: r1 });
    const folded = r.name.normalize('NFKC').toLowerCase();
    const w1 = (words() || []).find((w) => folded.includes(w) || r.norm.includes(matchForm(w)));
    if (w1) out.push({ type: 'word', word: w1 });
    const taken = stmts.takenBy.get(r.norm, r.address);
    if (taken) out.push({ type: 'same_as', addresses: [taken.address] });
    const pend = stmts.pendingSame.all(r.norm, r.address).map((x) => x.address);
    if (pend.length) out.push({ type: 'pending_same', addresses: pend });
    return out;
  }

  function adminRow(r) {
    return {
      id: r.id, address: r.address, name: r.name, state: r.state, submitted_at: r.submitted_at,
      decided_at: r.decided_at, decided_by: r.decided_by, reason: r.reason,
      shown_as: `${r.name} (${maskAddr(r.address)})`,
      ...(r.state === 'pending' ? { flags: flagsOf(r) } : {}),
    };
  }

  // The operator's view of one address, for the Players page.
  function adminFor(address) {
    const l = stmts.liveOf.get(address);
    const p = stmts.pendingOf.get(address);
    return { live: l ? adminRow(l) : null, pending: p ? adminRow(p) : null };
  }

  function reasonOf(b) {
    if (b.reason === undefined || b.reason === null || b.reason === '') return null;
    const r = normaliseBody(b.reason, REASON_MAX);
    if (r === null) throw bad('reason');
    return r;
  }

  const nickId = (ctx) => {
    const id = parseIntStrict(ctx.params.id, { min: 1 });
    if (id === null) throw new HttpError(404, 'not_found');
    return id;
  };

  function adminList(ctx) {
    const q = ctx.query;
    for (const k of new Set(q.keys())) if (k !== 'state' || q.getAll(k).length > 1) throw bad(k);
    const st = q.get('state') === null ? 'pending' : q.get('state');
    if (!['pending', 'approved', 'rejected'].includes(st)) throw bad('state');
    // The queue oldest first (the order to work it); the lists newest first.
    const rows = (st === 'pending' ? stmts.list : stmts.listDesc).all(st, LIST_MAX);
    return {
      ok: true, state: st, enabled: enabled(),
      counts: { pending: stmts.count.get('pending').n, approved: stmts.count.get('approved').n },
      nicknames: rows.map(adminRow),
    };
  }

  function adminApprove(ctx) {
    const id = nickId(ctx);
    onlyKeys(ctx.body, []);
    const t = now();
    const r = db.transaction(() => {
      const n = stmts.byId.get(id);
      if (!n) throw new HttpError(404, 'not_found');
      if (n.state !== 'pending') throw new HttpError(409, 'not_pending');
      if (stmts.takenBy.get(n.norm, n.address)) throw new HttpError(409, 'nickname_taken');
      const prev = stmts.liveOf.get(n.address);
      if (prev) stmts.decide.run('replaced', t, ctx.admin.user, null, prev.id, 'approved');
      stmts.decide.run('approved', t, ctx.admin.user, null, id, 'pending');
      admin.audit(ctx, 'nickname_approve', n.address, { id, name: n.name, replaced: prev ? prev.name : null });
      return stmts.byId.get(id);
    });
    invalidate();
    return { ok: true, nickname: adminRow(r) };
  }

  function adminReject(ctx) {
    const id = nickId(ctx);
    const reason = reasonOf(onlyKeys(ctx.body, ['reason']));
    const t = now();
    const r = db.transaction(() => {
      const n = stmts.byId.get(id);
      if (!n) throw new HttpError(404, 'not_found');
      if (n.state !== 'pending') throw new HttpError(409, 'not_pending');
      stmts.decide.run('rejected', t, ctx.admin.user, reason, id, 'pending');
      admin.audit(ctx, 'nickname_reject', n.address, { id, name: n.name, reason });
      return stmts.byId.get(id);
    });
    return { ok: true, nickname: adminRow(r) };
  }

  function adminRemove(ctx) {
    const id = nickId(ctx);
    const reason = reasonOf(onlyKeys(ctx.body, ['reason']));
    const r = db.transaction(() => {
      const n = stmts.byId.get(id);
      if (!n) throw new HttpError(404, 'not_found');
      if (n.state !== 'approved') throw new HttpError(409, 'not_live');
      removeLive(n, ctx.admin.user, reason);
      admin.audit(ctx, 'nickname_remove', n.address, { id, name: n.name, reason });
      return stmts.byId.get(id);
    });
    invalidate();
    return { ok: true, nickname: adminRow(r) };
  }

  // For moderation.js (a ban ends the nickname, in the ban's own transaction). → the row as
  // it was, or null. Does not audit — the caller's ban row says so.
  function removeLive(n, by, reason, t = now()) {
    stmts.decide.run('removed', t, by, reason, n.id, 'approved');
    invalidate();
    return n;
  }
  function removeLiveOf(address, by, reason) {
    const l = stmts.liveOf.get(address);
    const p = stmts.pendingOf.get(address);
    const t = now();
    if (p) stmts.decide.run('rejected', t, by, reason, p.id, 'pending');
    return l ? removeLive(l, by, reason, t) : null;
  }

  // Hourly: decided rows past 180 days are dropped. The live and pending rows are never
  // touched; one row per decision, and a player can submit 5 a day, so this is the bound.
  function purge(t = now()) {
    const ids = stmts.oldIds.all(t - KEEP_DECIDED_S, PURGE_BATCH);
    if (!ids.length) return 0;
    return db.transaction(() => ids.reduce((n, { id }) => n + stmts.del.run(id).changes, 0));
  }

  if (admin) {
    admin.add('GET', 'nicknames', adminList);
    admin.add('POST', 'nicknames/:id/approve', adminApprove, { bodyLimit: 256 });
    admin.add('POST', 'nicknames/:id/reject', adminReject, { bodyLimit: 1024 });
    admin.add('POST', 'nicknames/:id/remove', adminRemove, { bodyLimit: 1024 });
  }

  return {
    label, meView, adminFor, removeLiveOf, purge, invalidate,
    routes: [
      ['POST', '/play/api/nickname', submit, { bodyLimit: 1024 }],
      ['POST', '/play/api/nickname/withdraw', withdraw, { bodyLimit: 256 }],
      ['POST', '/play/api/nickname/remove', removeOwn, { bodyLimit: 256 }],
    ],
  };
}

// The fallback every module uses when it is built without names (the Part 1–10 tests
// construct some directly): the mask, exactly as before Part 12.
const MASK_ONLY = Object.freeze({ label: maskAddr });

module.exports = {
  createNames, validateName, matchForm, MASK_ONLY,
  NAME_MIN, NAME_MAX, NAME_RULE, ROLE_WORDS, RESERVED, SUBMITS_PER_DAY, KEEP_DECIDED_S, RULE_TEXT,
};
