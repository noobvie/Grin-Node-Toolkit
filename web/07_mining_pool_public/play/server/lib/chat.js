'use strict';

// Chat (design §19.10, D9, D12, D21).
//
//   GET  /play/api/chat?room=global[&after=<id>&rev=<n>&epoch=<hex>]   read (no session needed)
//   POST /play/api/chat              { body }                          post
//   POST /play/api/chat/:id/report   { reason? }                       report
//
// Moderation (lib/moderation.js) changes message states through the helpers exported here,
// so the state rules and the change feed live in ONE place.
//
// Rules this module owns:
//   - A body is stored as PLAIN TEXT, normalised on the server (normaliseBody below).
//     Rendering is the client's job, with textContent only; nothing here produces HTML.
//   - The public read never carries a full address, an IP or an admin's name: `name` is the
//     masked address (with an approved nickname in front, §19.16 — never the nickname
//     alone), or "Operator" for an operator post.
//   - `role` is never an input. The operator badge comes only from the admin route
//     (role='operator' in the row); the moderator badge is computed at READ time from the
//     moderators table (D21), so removing a moderator also removes the badge from their old
//     messages.
//   - Every read is an indexed range read (idx_chat_room / idx_chat_address / the PK), so a
//     poll storm costs one bounded seek per request (§19.13 #11).
//
// The change feed. A poll only asks for ids after the newest one the client has, so a
// message that is DELETED, HELD or APPROVED later would never reach a screen that already
// drew it — and a scam message the operator removed would stay on every open page. So each
// state change is appended to an in-memory log with a revision number; a poll sends the
// revision it has seen and gets the changes since. The log is per process (`epoch` is random
// at boot) and bounded; a client whose revision is unknown gets `reset: true` with a fresh
// page, and redraws.

const crypto = require('node:crypto');
const { HttpError, parseIntStrict } = require('./http');
const { maskAddr } = require('./mask');
// names.js requires this file (normaliseBody), so its mask-only fallback is inlined here
// rather than imported: the same shape as names.js MASK_ONLY.
const MASK_ONLY = Object.freeze({ label: maskAddr });
const { createTokenBuckets } = require('./ratelimit');

const ROOMS = Object.freeze(['global']);
const BODY_MAX = 280;                 // code points, after normalisation (§19.10)
const REQUEST_MAX = 4096;             // the request body cap (§19.10: 4 KB)
const PAGE = 100;
const MIN_INTERVAL_S = 5;             // floor between one address's posts; slow mode may raise it
const IP_PER_HOUR = 60;               // §19.10; per IP, all addresses together
const DUP_WINDOW_S = 600;             // the same body from the same address is refused this long
const REPORT_REASON_MAX = 200;
const REPORTS_PER_HOUR = 20;          // per reporting address
const CHANGE_LOG_MAX = 1000;
const OPERATOR_NAME = 'Operator';
const WORD_MAX = 40;
const WORDS_MAX = 500;
const RETENTION_BATCH = 5000;
const DAY = 86400;

// ── Body normalisation (§19.10) ───────────────────────────────────────────────────────
// Written with Unicode property escapes and code points, never raw bytes (memory
// reference_grep_nul_blindspot):
//   - Cc (C0/C1 controls: newlines, tabs, NUL…) and Zl/Zp (line/paragraph separators)
//     become a SPACE, so a control between two words cannot glue them into one;
//   - Cf (format characters: the bidi overrides U+202A–E and isolates U+2066–9, LRM/RLM,
//     the zero-width U+200B–D, U+2060 word joiner, U+FEFF, the soft hyphen…) is REMOVED;
//   - the Hangul fillers are removed too: they are letters (Lo), not Cf, and render as
//     nothing — the classic "invisible message";
//   - a run of more than 3 combining marks is cut to 3 ("Zalgo" text that paints over the
//     lines above and below);
//   - whitespace is collapsed, the result trimmed, and it must be 1–280 code points.
const TO_SPACE = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const REMOVE = /\p{Cf}/gu;
const FILLERS = new RegExp(`[${String.fromCodePoint(0x115F, 0x1160, 0x3164, 0xFFA0)}]`, 'gu');
const MARK_RUN = /(\p{M}{3})\p{M}+/gu;

function normaliseText(v) {
  if (typeof v !== 'string') return null;
  return v.normalize('NFC')
    .replace(TO_SPACE, ' ')
    .replace(REMOVE, '')
    .replace(FILLERS, '')
    .replace(MARK_RUN, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

// → the normalised body, or null when it is empty or too long.
function normaliseBody(v, max = BODY_MAX) {
  const s = normaliseText(v);
  if (s === null || s === '') return null;
  if ([...s].length > max) return null;
  return s;
}

// The form every hold check compares: compatibility-folded (fullwidth ｗｗｗ．, ligatures)
// and lower-cased, so a lookalike spelling does not slip past the word list or the link test.
const folded = (s) => s.normalize('NFKC').toLowerCase();

// Link-like (§19.10: `://`, `www.`, or a name.tld). Held, never linked. A Grin address is
// held under the same switch: "send to grin1…" is this chain's version of a scam link.
const LINK_RE = /:\/\/|\bwww\.|\b[a-z0-9][a-z0-9-]{1,62}\.[a-z]{2,24}\b/;
const PAY_RE = /\bt?grin1[ac-hj-np-z02-9]{20,}/;

function holdReason(body, { words, holdLinks }) {
  const f = folded(body);
  for (const w of words) if (f.includes(w)) return 'word';
  if (holdLinks && (LINK_RE.test(f) || PAY_RE.test(f))) return 'link';
  return null;
}

// A word-list entry: the folded form, 1–40 code points, no control or format characters.
function normaliseWord(v) {
  const s = normaliseText(v);
  if (s === null || s === '') return null;
  const w = folded(s);
  if ([...w].length > WORD_MAX) return null;
  return w;
}

function createChat({ db, sessions, settings, auth, mode, log, names = MASK_ONLY, now = () => Math.floor(Date.now() / 1000) }) {
  const raw = db.raw;
  const COLS = 'id, room, role, address, admin_user, body, state, hold_reason, created_at, deleted_by, reason';
  const stmts = {
    latest: raw.prepare(`SELECT ${COLS} FROM chat_messages WHERE room = ? AND state = 'visible' ORDER BY id DESC LIMIT ?`),
    after: raw.prepare(`SELECT ${COLS} FROM chat_messages WHERE room = ? AND state = 'visible' AND id > ? ORDER BY id ASC LIMIT ?`),
    ownHeld: raw.prepare(
      `SELECT ${COLS} FROM chat_messages WHERE address = ? AND created_at >= ? AND state = 'held' AND room = ? AND id > ? ORDER BY id ASC LIMIT ?`),
    byId: raw.prepare(`SELECT ${COLS} FROM chat_messages WHERE id = ?`),
    lastPost: raw.prepare('SELECT MAX(created_at) AS t FROM chat_messages WHERE address = ?'),
    postsSince: raw.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE address = ? AND created_at > ?'),
    dup: raw.prepare('SELECT 1 AS x FROM chat_messages WHERE address = ? AND created_at > ? AND body = ? LIMIT 1'),
    insert: raw.prepare(
      'INSERT INTO chat_messages (room, role, address, admin_user, body, state, hold_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    setState: raw.prepare('UPDATE chat_messages SET state = ?, hold_reason = ?, deleted_by = ?, reason = ? WHERE id = ? AND state = ?'),
    report: raw.prepare(
      'INSERT INTO chat_reports (message_id, reporter, reason, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(message_id, reporter) DO NOTHING'),
    openReports: raw.prepare('SELECT COUNT(*) AS n FROM chat_reports WHERE message_id = ? AND resolved_at IS NULL'),
    resolveReports: raw.prepare('UPDATE chat_reports SET resolved_at = ?, resolved_by = ? WHERE message_id = ? AND resolved_at IS NULL'),
    moderators: raw.prepare('SELECT address FROM moderators'),
    words: raw.prepare('SELECT word FROM chat_words ORDER BY word'),
    // Retention (hourly). Reports first: they reference the message (foreign_keys = ON).
    oldIds: raw.prepare('SELECT id FROM chat_messages WHERE created_at < ? ORDER BY id ASC LIMIT ?'),
    keepFrom: raw.prepare('SELECT id FROM chat_messages WHERE room = ? ORDER BY id DESC LIMIT 1 OFFSET ?'),
    overIds: raw.prepare('SELECT id FROM chat_messages WHERE room = ? AND id < ? ORDER BY id ASC LIMIT ?'),
    delReports: raw.prepare('DELETE FROM chat_reports WHERE message_id = ?'),
    delMessage: raw.prepare('DELETE FROM chat_messages WHERE id = ?'),
    rooms: raw.prepare('SELECT DISTINCT room FROM chat_messages'),
  };

  // ── Caches: the moderator set and the word list are tiny, read on every view/post ────
  let modSet = null;
  let wordList = null;
  const moderators = () => {
    if (!modSet) modSet = new Set(stmts.moderators.all().map((r) => r.address));
    return modSet;
  };
  const words = () => {
    if (!wordList) wordList = stmts.words.all().map((r) => r.word);
    return wordList;
  };
  const invalidateModerators = () => { modSet = null; };
  const invalidateWords = () => { wordList = null; };

  // ── The change feed ──────────────────────────────────────────────────────────────────
  const epoch = crypto.randomBytes(8).toString('hex');
  let rev = 0;
  const changeLog = [];     // { rev, id, room, kind: 'removed' | 'held' | 'shown' }
  function logChange(id, room, kind) {
    rev += 1;
    changeLog.push({ rev, id, room, kind });
    if (changeLog.length > CHANGE_LOG_MAX) changeLog.shift();
  }
  const oldestKnownRev = () => (changeLog.length ? changeLog[0].rev - 1 : rev);

  // ── Views ────────────────────────────────────────────────────────────────────────────
  function view(row, me) {
    const operator = row.role === 'operator';
    return {
      id: row.id,
      created_at: row.created_at,
      name: operator ? OPERATOR_NAME : names.label(row.address),   // the mask, or `Nick (mask)` (§19.16)
      role: operator ? 'operator' : (moderators().has(row.address) ? 'moderator' : 'player'),
      body: row.body,
      own: me !== null && !operator && row.address === me,
      ...(row.state === 'held' ? { held: true } : {}),
    };
  }

  const bad = (field) => new HttpError(400, 'bad_request', { field });

  function roomOf(v) {
    if (v === null || v === undefined) return 'global';
    if (typeof v !== 'string' || !ROOMS.includes(v)) throw bad('room');
    return v;
  }

  function retentionCutoff(t) {
    return t - settings.get('chat_retention_days') * DAY;
  }

  // The newest page: up to 100 visible messages + the caller's own held ones, ascending.
  function page(room, me, t) {
    const rows = stmts.latest.all(room, PAGE).reverse();
    const held = me === null ? [] : stmts.ownHeld.all(me, retentionCutoff(t), room, 0, PAGE);
    return merge(rows, held).map((r) => view(r, me));
  }

  const merge = (a, b) => (b.length ? [...a, ...b].sort((x, y) => x.id - y.id) : a);

  function read(ctx) {
    const q = ctx.query;
    for (const k of new Set(q.keys())) {
      if (!['room', 'after', 'rev', 'epoch'].includes(k) || q.getAll(k).length > 1) throw bad(k);
    }
    const room = roomOf(q.get('room'));
    const m = mode.get();
    if (m.chat_enabled !== true) return { ok: true, enabled: false, room, messages: [] };
    const s = sessions.lookup(ctx.cookies.grin_play);
    const me = s ? s.address : null;
    const t = now();
    const base = { ok: true, enabled: true, room, epoch, rev };

    const afterRaw = q.get('after');
    if (afterRaw === null) return { ...base, messages: page(room, me, t) };
    const after = parseIntStrict(afterRaw, { min: 0 });
    if (after === null) throw bad('after');
    const seen = q.get('rev') === null ? null : parseIntStrict(q.get('rev'), { min: 0 });
    if (q.get('rev') !== null && seen === null) throw bad('rev');
    // A revision this process never issued, or one the bounded log has already dropped:
    // the client cannot be told what it missed, so it gets a fresh page and redraws.
    if (seen === null || q.get('epoch') !== epoch || seen > rev || seen < oldestKnownRev()) {
      return { ...base, reset: true, messages: page(room, me, t) };
    }
    const rows = stmts.after.all(room, after, PAGE);
    const held = me === null ? [] : stmts.ownHeld.all(me, retentionCutoff(t), room, after, PAGE);
    const messages = merge(rows, held).map((r) => view(r, me));

    // Changes since `seen`, the last one per message winning.
    const last = new Map();
    for (let i = changeLog.length - 1; i >= 0 && changeLog[i].rev > seen; i--) {
      const c = changeLog[i];
      if (c.room === room && !last.has(c.id)) last.set(c.id, c.kind);
    }
    const changes = { removed: [], held: [], shown: [] };
    for (const [id, kind] of last) {
      if (kind === 'shown') {
        // Re-read: the message may have changed again, or been purged, since.
        const r = stmts.byId.get(id);
        if (r && r.state === 'visible' && r.room === room && id <= after) changes.shown.push(view(r, me));
        else if (!r || r.state === 'deleted') changes.removed.push(id);
      } else {
        changes[kind].push(id);
      }
    }
    for (const k of ['removed', 'held']) changes[k].sort((a, b) => a - b);
    changes.shown.sort((a, b) => a.id - b.id);
    return { ...base, messages, more: rows.length === PAGE, changes };
  }

  // ── Posting ──────────────────────────────────────────────────────────────────────────
  const ipBucket = createTokenBuckets({ capacity: IP_PER_HOUR, refillPerSec: IP_PER_HOUR / 3600, maxKeys: 20000 });
  const reportBucket = createTokenBuckets({ capacity: REPORTS_PER_HOUR, refillPerSec: REPORTS_PER_HOUR / 3600, maxKeys: 20000 });

  const tooMany = (retryAfter) => new HttpError(429, 'too_many_requests', { retry_after: retryAfter }, { 'Retry-After': String(retryAfter) });

  // The per-ADDRESS limits read the DB, not memory: they survive a restart, and a second
  // session (or twenty) of the same address shares them (§19.13 #11).
  function addressLimits(address, t, isModerator) {
    const slow = isModerator ? 0 : settings.get('chat_slow_seconds');
    const gap = Math.max(MIN_INTERVAL_S, slow);
    const last = stmts.lastPost.get(address).t;
    if (last !== null && t - last < gap) return gap - (t - last);
    const perHour = settings.get('chat_posts_per_hour');
    if (stmts.postsSince.get(address, t - 3600).n >= perHour) return 60;
    return 0;
  }

  function onlyKeys(b, allowed) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body');
    for (const k of Object.keys(b)) if (!allowed.includes(k)) throw bad('body');
    return b;
  }

  function post(ctx) {
    const s = auth.requireSession(ctx);
    const b = onlyKeys(ctx.body, ['body', 'room']);
    const room = roomOf(b.room);
    const st = auth.chatStatus(s);
    if (!st.enabled) throw new HttpError(403, 'chat_off');
    if (!st.can_post) {
      throw new HttpError(403, 'chat_refused', {
        reason: st.reason, available_at: st.available_at, ...(st.mining ? { mining: st.mining } : {}),
      });
    }
    const body = normaliseBody(b.body);
    if (body === null) throw bad('body');
    const t = now();
    const isMod = moderators().has(s.address);
    const wait = addressLimits(s.address, t, isMod);
    if (wait > 0) throw tooMany(wait);
    if (stmts.dup.get(s.address, t - DUP_WINDOW_S, body)) throw new HttpError(409, 'duplicate');
    const ipTake = ipBucket.take(ctx.ip);
    if (!ipTake.ok) throw tooMany(ipTake.retryAfter);
    const hold = holdReason(body, { words: words(), holdLinks: settings.get('chat_hold_links') });
    const id = Number(stmts.insert.run(room, 'player', s.address, null, body, hold ? 'held' : 'visible', hold, t).lastInsertRowid);
    return { ok: true, message: view(stmts.byId.get(id), s.address), held: hold !== null };
  }

  // ── Reports ──────────────────────────────────────────────────────────────────────────
  const messageId = (ctx) => {
    const id = parseIntStrict(ctx.params.id, { min: 1 });
    if (id === null) throw new HttpError(404, 'not_found');
    return id;
  };

  // Reporting needs a CHAT-CAPABLE session, not just any session: `chat_report_threshold`
  // distinct reporters hold a message, and "distinct" must mean distinct aged, mining
  // addresses, or a fresh proof per address could hide anyone's messages.
  function report(ctx) {
    const s = auth.requireSession(ctx);
    const b = onlyKeys(ctx.body, ['reason']);
    let reason = null;
    if (b.reason !== undefined && b.reason !== null && b.reason !== '') {
      reason = normaliseBody(b.reason, REPORT_REASON_MAX);
      if (reason === null) throw bad('reason');
    }
    const st = auth.chatStatus(s);
    if (!st.can_post) throw new HttpError(403, 'chat_refused', { reason: st.reason, available_at: st.available_at });
    const id = messageId(ctx);
    const t = now();
    const out = db.transaction(() => {
      const m = stmts.byId.get(id);
      if (!m || m.state === 'deleted') throw new HttpError(404, 'not_found');
      if (m.role === 'operator') throw new HttpError(400, 'not_reportable');
      if (m.address === s.address) throw new HttpError(400, 'not_reportable');
      const take = reportBucket.peek(s.address);
      if (!take.ok) throw tooMany(take.retryAfter);
      const r = stmts.report.run(id, s.address, reason, t);
      if (r.changes === 0) return { duplicate: true, held: m.state === 'held' };
      reportBucket.take(s.address);
      let held = m.state === 'held';
      if (m.state === 'visible' && stmts.openReports.get(id).n >= settings.get('chat_report_threshold')) {
        if (stmts.setState.run('held', 'reports', null, null, id, 'visible').changes === 1) {
          logChange(id, m.room, 'held');
          held = true;
        }
      }
      return { duplicate: false, held };
    });
    return { ok: true, ...out };
  }

  // ── State changes, for moderation.js ─────────────────────────────────────────────────
  // Each runs inside the caller's transaction and returns the row as it was before, or
  // null when nothing changed. `by` is the admin's name or `mod:<address>`.

  function remove(id, by, reason, t = now()) {
    const m = stmts.byId.get(id);
    if (!m) throw new HttpError(404, 'not_found');
    if (m.state === 'deleted') return null;
    stmts.setState.run('deleted', m.hold_reason, by, reason, id, m.state);
    stmts.resolveReports.run(t, by, id);
    logChange(id, m.room, 'removed');
    return m;
  }

  // Approve = keep this message: held → visible, and every open report on it resolved. On a
  // visible message it only resolves the reports (the "keep" answer to a report).
  function approve(id, by, t = now()) {
    const m = stmts.byId.get(id);
    if (!m || m.state === 'deleted') throw new HttpError(404, 'not_found');
    const resolved = stmts.resolveReports.run(t, by, id).changes;
    if (m.state === 'held') {
      stmts.setState.run('visible', null, null, null, id, 'held');
      logChange(id, m.room, 'shown');
    } else if (resolved === 0) {
      return null;
    }
    return m;
  }

  function restore(id, t = now()) {
    const m = stmts.byId.get(id);
    if (!m) throw new HttpError(404, 'not_found');
    if (m.state !== 'deleted') return null;
    stmts.setState.run('visible', null, null, null, id, 'deleted');
    logChange(id, m.room, 'shown');
    return m;
  }

  // An operator post: role 'operator', no address, never held, no gate but the body rules.
  function operatorPost(adminUser, bodyIn, room = 'global', t = now()) {
    const body = normaliseBody(bodyIn);
    if (body === null) throw bad('body');
    const id = Number(stmts.insert.run(room, 'operator', null, adminUser, body, 'visible', null, t).lastInsertRowid);
    return stmts.byId.get(id);
  }

  // ── Retention (hourly, §19.10): older than the retention days, or past the newest
  // `chat_retention_max` in a room — hard-deleted with their reports. Batched, so one run
  // holds the write lock for a bounded time; a backlog clears over the next runs.
  function purgeRetention(t = now()) {
    let removed = 0;
    const drop = (ids) => db.transaction(() => {
      for (const { id } of ids) { stmts.delReports.run(id); removed += stmts.delMessage.run(id).changes; }
    });
    drop(stmts.oldIds.all(retentionCutoff(t), RETENTION_BATCH));
    const max = settings.get('chat_retention_max');
    for (const { room } of stmts.rooms.all()) {
      const k = stmts.keepFrom.get(room, max - 1);
      if (k) drop(stmts.overIds.all(room, k.id, RETENTION_BATCH));
    }
    return removed;
  }

  return {
    routes: [
      ['GET', '/play/api/chat', read],
      ['POST', '/play/api/chat', post, { bodyLimit: REQUEST_MAX }],
      ['POST', '/play/api/chat/:id/report', report, { bodyLimit: 1024 }],
    ],
    view, remove, approve, restore, operatorPost, purgeRetention,
    moderators, words, invalidateModerators, invalidateWords, onlyKeys, messageId,
    byId: (id) => stmts.byId.get(id),
    _internal: { changeLog, epoch: () => epoch, rev: () => rev, ipBucket, stmts },
  };
}

module.exports = {
  createChat, normaliseBody, normaliseText, normaliseWord, holdReason, folded,
  ROOMS, BODY_MAX, PAGE, MIN_INTERVAL_S, IP_PER_HOUR, DUP_WINDOW_S, CHANGE_LOG_MAX, WORD_MAX, WORDS_MAX, OPERATOR_NAME,
};
