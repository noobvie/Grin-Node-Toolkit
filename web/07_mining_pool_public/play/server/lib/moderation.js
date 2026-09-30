'use strict';

// Moderation (design §19.10, §19.11, D11, D21).
//
// Two kinds of moderator, with different reach:
//
//   the OPERATOR — the pool admin, through the admin proxy (/internal/admin/*, guarded by
//   lib/admin.js: link secret + X-Admin-User + step-up). Everything: messages, players, the
//   word list, settings, moderators, points.
//
//     GET  chat/messages?state=&address=&before=      the message list (full addresses)
//     GET  chat/reports                               open reports, grouped per message
//     POST chat/messages/:id/delete   {reason?}       FAST
//     POST chat/held/:id/approve      {}              FAST  (also "keep" for a reported message)
//     POST chat/messages/:id/restore  {}              step-up
//     POST chat/post                  {body}          FAST  (the operator badge)
//     GET  chat/words · POST chat/words {add?, remove?}          step-up
//     GET  players?filter=muted|banned|moderators · GET players/:addr
//     POST players/:addr/mute    {minutes, reason?}   FAST
//     POST players/:addr/unmute  {}                   step-up
//     POST players/:addr/ban     {days|forever, reason?}   step-up (revokes sessions)
//     POST players/:addr/unban   {}                   step-up
//     POST players/:addr/purge   {days}               step-up (deletes their recent messages)
//     POST players/:addr/adjust  {kind, delta, note?} step-up (admin_adjust ledger row)
//     GET  moderators · POST moderators/:addr {note?} · POST moderators/:addr/remove   step-up
//     GET  settings  · POST settings {values}         step-up
//     GET  mod-log?before=&limit=
//
//   a MODERATOR — a miner address the operator appointed (D21), acting from /play/ with its
//   own games session. Chat only, and bounded:
//
//     GET  /play/api/mod/queue                        held + reported messages (masked names)
//     POST /play/api/mod/messages/:id/delete  {reason?}
//     POST /play/api/mod/messages/:id/approve {}
//     POST /play/api/mod/messages/:id/mute    {minutes ≤ 1440}   mutes the message's author
//
//   A moderator cannot touch an operator message or another moderator (their messages or
//   their mute), cannot approve or mute themselves, cannot shorten a longer mute, and has no
//   ban, purge, word list, settings, events or points. Every action is a mod_actions row
//   with admin_user = `mod:<full address>`, so the operator's mod log says exactly who.
//   Removing a moderator takes effect on their next request.
//
// Every write adds its mod_actions row inside its own transaction (admin.audit for the
// operator, auditMod here), so an action that rolls back leaves no record of happening.

const { HttpError, parseIntStrict } = require('./http');
const { GRIN_ADDR_RE } = require('./pool-link');
const { maskAddr } = require('./mask');
const { LedgerError } = require('./ledger');
const { createTokenBuckets } = require('./ratelimit');
const { SPEC } = require('./settings');
const { CHAT_MIN_AGE_FLOOR } = require('./sessions');
const { normaliseBody, normaliseWord, MIN_INTERVAL_S, IP_PER_HOUR, WORDS_MAX, PAGE } = require('./chat');
const { publicBadges } = require('./badges');

const DAY = 86400;
const FOREVER = 253402300799;             // §19.4: banned_until for "forever"
const OPERATOR_MUTE_MAX_MIN = 30 * 1440;  // §19.10: mute ≤ 30 days
const MOD_MUTE_MAX_MIN = 1440;            // D21: a moderator's mute ≤ 24 h
const BAN_MAX_DAYS = 3650;
const PURGE_MAX_DAYS = 30;
const REASON_MAX = 200;
const NOTE_MAX = 200;
const ADJUST_MAX = 1000000;
const WORDS_PER_CALL = 100;
const MODS_MAX = 50;
const MOD_ACTIONS_PER_HOUR = 120;
const MOD_LOG_MAX = 200;
const LIST_MAX = 200;

function createModeration({ db, chat, sessions, settings, auth, admin, ledger, log, config, names = null, now = () => Math.floor(Date.now() / 1000) }) {
  const raw = db.raw;
  const prefix = config.net === 'mainnet' ? 'grin1' : 'tgrin1';
  const COLS = 'id, room, role, address, admin_user, body, state, hold_reason, created_at, deleted_by, reason';
  const stmts = {
    listAll: raw.prepare(`SELECT ${COLS} FROM chat_messages WHERE id < ? ORDER BY id DESC LIMIT ?`),
    listState: raw.prepare(`SELECT ${COLS} FROM chat_messages WHERE room = 'global' AND state = ? AND id < ? ORDER BY id DESC LIMIT ?`),
    listAddr: raw.prepare(`SELECT ${COLS} FROM chat_messages WHERE address = ? ORDER BY created_at DESC, id DESC LIMIT ?`),
    reportCount: raw.prepare('SELECT COUNT(*) AS n FROM chat_reports WHERE message_id = ? AND resolved_at IS NULL'),
    openReports: raw.prepare(
      'SELECT message_id, COUNT(*) AS n, MIN(created_at) AS first_at FROM chat_reports WHERE resolved_at IS NULL GROUP BY message_id ORDER BY first_at ASC LIMIT ?'),
    reportsOf: raw.prepare('SELECT reporter, reason, created_at FROM chat_reports WHERE message_id = ? AND resolved_at IS NULL ORDER BY id ASC LIMIT 20'),
    player: raw.prepare('SELECT address, first_seen, last_seen, plays, points, banned_until, muted_until, badges_json FROM players WHERE address = ?'),
    setMute: raw.prepare('UPDATE players SET muted_until = ? WHERE address = ?'),
    setBan: raw.prepare('UPDATE players SET banned_until = ? WHERE address = ?'),
    muted: raw.prepare('SELECT address, muted_until AS until FROM players WHERE muted_until > ? ORDER BY muted_until DESC LIMIT ?'),
    banned: raw.prepare('SELECT address, banned_until AS until FROM players WHERE banned_until > ? ORDER BY banned_until DESC LIMIT ?'),
    mods: raw.prepare('SELECT address, added_by, added_at, note FROM moderators ORDER BY added_at ASC'),
    modCount: raw.prepare('SELECT COUNT(*) AS n FROM moderators'),
    isMod: raw.prepare('SELECT 1 AS x FROM moderators WHERE address = ?'),
    addMod: raw.prepare('INSERT INTO moderators (address, added_by, added_at, note) VALUES (?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET note = excluded.note'),
    delMod: raw.prepare('DELETE FROM moderators WHERE address = ?'),
    purgeIds: raw.prepare("SELECT id FROM chat_messages WHERE address = ? AND created_at >= ? AND state != 'deleted' ORDER BY id ASC"),
    words: raw.prepare('SELECT word, added_by, added_at FROM chat_words ORDER BY word'),
    wordCount: raw.prepare('SELECT COUNT(*) AS n FROM chat_words'),
    addWord: raw.prepare('INSERT INTO chat_words (word, added_by, added_at) VALUES (?, ?, ?) ON CONFLICT(word) DO NOTHING'),
    delWord: raw.prepare('DELETE FROM chat_words WHERE word = ?'),
    modLog: raw.prepare('SELECT id, admin_user, action, target, details_json, created_at FROM mod_actions WHERE id < ? ORDER BY id DESC LIMIT ?'),
    liveSessions: raw.prepare('SELECT proof_kind, COUNT(*) AS n FROM sessions WHERE address = ? AND revoked_at IS NULL AND expires_at > ? GROUP BY proof_kind'),
    matches1: raw.prepare('SELECT id, game_id, mode, state, seat1, seat2, result, reason, rated, ply, created_at, finished_at FROM matches WHERE seat1 = ? ORDER BY id DESC LIMIT ?'),
    matches2: raw.prepare('SELECT id, game_id, mode, state, seat1, seat2, result, reason, rated, ply, created_at, finished_at FROM matches WHERE seat2 = ? ORDER BY id DESC LIMIT ?'),
    activity: raw.prepare('SELECT day, seconds, plays_awarded FROM activity_daily WHERE address = ? AND day >= ? ORDER BY day DESC'),
    insertModAction: raw.prepare('INSERT INTO mod_actions (admin_user, action, target, details_json, created_at) VALUES (?, ?, ?, ?, ?)'),
  };

  const bad = (field) => new HttpError(400, 'bad_request', { field });
  const { onlyKeys, messageId } = chat;

  function addressParam(ctx) {
    const a = ctx.params.addr;
    if (typeof a !== 'string' || !GRIN_ADDR_RE.test(a) || !a.startsWith(prefix)) throw bad('address');
    return a;
  }

  function reasonOf(b) {
    if (b.reason === undefined || b.reason === null || b.reason === '') return null;
    const r = normaliseBody(b.reason, REASON_MAX);
    if (r === null) throw bad('reason');
    return r;
  }

  const intIn = (v, min, max, field) => {
    if (!Number.isSafeInteger(v) || v < min || v > max) throw bad(field);
    return v;
  };

  // The full row, for the operator only (this module never builds a PUBLIC list of these).
  function adminMessage(r) {
    return {
      id: r.id, room: r.room, role: r.role, address: r.address, admin_user: r.admin_user,
      moderator: r.address !== null && chat.moderators().has(r.address),
      body: r.body, state: r.state, hold_reason: r.hold_reason, created_at: r.created_at,
      deleted_by: r.deleted_by, reason: r.reason, open_reports: stmts.reportCount.get(r.id).n,
    };
  }

  // ═══ Operator: messages ══════════════════════════════════════════════════════════════
  function adminMessages(ctx) {
    const q = ctx.query;
    for (const k of new Set(q.keys())) if (!['state', 'address', 'before', 'limit'].includes(k) || q.getAll(k).length > 1) throw bad(k);
    const st = q.get('state');
    if (st !== null && !['visible', 'held', 'deleted'].includes(st)) throw bad('state');
    const before = q.get('before') === null ? Number.MAX_SAFE_INTEGER : parseIntStrict(q.get('before'), { min: 1 });
    if (before === null) throw bad('before');
    const limit = q.get('limit') === null ? PAGE : parseIntStrict(q.get('limit'), { min: 1, max: LIST_MAX });
    if (limit === null) throw bad('limit');
    let rows;
    if (q.get('address') !== null) {
      const a = q.get('address');
      if (!GRIN_ADDR_RE.test(a) || !a.startsWith(prefix)) throw bad('address');
      rows = stmts.listAddr.all(a, limit).filter((r) => r.id < before && (st === null || r.state === st));
    } else if (st !== null) {
      rows = stmts.listState.all(st, before, limit);
    } else {
      rows = stmts.listAll.all(before, limit);
    }
    return { ok: true, messages: rows.map(adminMessage) };
  }

  // Open reports, grouped per message, oldest first — the queue order.
  function reportQueue({ masked }) {
    return stmts.openReports.all(LIST_MAX).map((g) => {
      const m = chat.byId(g.message_id);
      if (!m) return null;
      const reports = stmts.reportsOf.all(g.message_id).map((r) => ({
        reporter: masked ? maskAddr(r.reporter) : r.reporter, reason: r.reason, created_at: r.created_at,
      }));
      return { message: masked ? modMessage(m) : adminMessage(m), count: g.n, first_at: g.first_at, reports };
    }).filter(Boolean);
  }

  function adminReports() {
    return { ok: true, reports: reportQueue({ masked: false }) };
  }

  function adminDelete(ctx) {
    const id = messageId(ctx);
    const reason = reasonOf(onlyKeys(ctx.body, ['reason']));
    const r = db.transaction(() => {
      const m = chat.remove(id, ctx.admin.user, reason);
      if (m) admin.audit(ctx, 'chat_delete', `msg:${id}`, { author: m.address, reason });
      return m;
    });
    return { ok: true, changed: r !== null, message: adminMessage(chat.byId(id)) };
  }

  function adminApprove(ctx) {
    const id = messageId(ctx);
    onlyKeys(ctx.body, []);
    const r = db.transaction(() => {
      const m = chat.approve(id, ctx.admin.user);
      if (m) admin.audit(ctx, m.state === 'held' ? 'chat_approve' : 'chat_keep', `msg:${id}`, { author: m.address, hold_reason: m.hold_reason });
      return m;
    });
    return { ok: true, changed: r !== null, message: adminMessage(chat.byId(id)) };
  }

  function adminRestore(ctx) {
    const id = messageId(ctx);
    onlyKeys(ctx.body, []);
    const r = db.transaction(() => {
      const m = chat.restore(id);
      if (m) admin.audit(ctx, 'chat_restore', `msg:${id}`, { author: m.address, was_deleted_by: m.deleted_by });
      return m;
    });
    return { ok: true, changed: r !== null, message: adminMessage(chat.byId(id)) };
  }

  const opPostBucket = createTokenBuckets({ capacity: 10, refillPerSec: 10 / 60, maxKeys: 100 });
  function adminPost(ctx) {
    const b = onlyKeys(ctx.body, ['body']);
    const take = opPostBucket.take(ctx.admin.user);
    if (!take.ok) throw new HttpError(429, 'too_many_requests', { retry_after: take.retryAfter }, { 'Retry-After': String(take.retryAfter) });
    const m = db.transaction(() => {
      const row = chat.operatorPost(ctx.admin.user, b.body);
      admin.audit(ctx, 'chat_operator_post', `msg:${row.id}`, { length: [...row.body].length });
      return row;
    });
    return { ok: true, message: adminMessage(m) };
  }

  // ═══ Operator: word list ═════════════════════════════════════════════════════════════
  function adminWords() {
    return { ok: true, words: stmts.words.all(), max: WORDS_MAX };
  }

  function adminWordsEdit(ctx) {
    const b = onlyKeys(ctx.body, ['add', 'remove']);
    const list = (v, field) => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.length > WORDS_PER_CALL) throw bad(field);
      return v.map((w) => { const n = normaliseWord(w); if (n === null) throw bad(field); return n; });
    };
    const add = [...new Set(list(b.add, 'add'))];
    const remove = [...new Set(list(b.remove, 'remove'))];
    const t = now();
    const res = db.transaction(() => {
      let removed = 0, added = 0;
      for (const w of remove) removed += stmts.delWord.run(w).changes;
      for (const w of add) added += stmts.addWord.run(w, ctx.admin.user, t).changes;
      if (stmts.wordCount.get().n > WORDS_MAX) throw new HttpError(400, 'bad_request', { field: 'add', max: WORDS_MAX });
      if (added || removed) admin.audit(ctx, 'chat_words', 'words', { added: add.slice(0, 20), removed: remove.slice(0, 20), n_added: added, n_removed: removed });
      return { added, removed };
    });
    chat.invalidateWords();
    return { ok: true, ...res, words: stmts.words.all() };
  }

  // ═══ Operator: players ═══════════════════════════════════════════════════════════════
  function playerView(a) {
    const t = now();
    const p = stmts.player.get(a);
    const sessionsByKind = Object.fromEntries(stmts.liveSessions.all(a, t).map((r) => [r.proof_kind, r.n]));
    const matches = [...stmts.matches1.all(a, 20), ...stmts.matches2.all(a, 20)]
      .sort((x, y) => y.id - x.id).slice(0, 20)
      .map((m) => ({ id: m.id, game_id: m.game_id, mode: m.mode, state: m.state, seat: m.seat1 === a ? 1 : 2,
        opponent: m.seat1 === a ? m.seat2 : m.seat1, result: m.result, reason: m.reason, rated: m.rated === 1, ply: m.ply,
        created_at: m.created_at, finished_at: m.finished_at }));
    const mod = stmts.mods.all().find((r) => r.address === a) || null;
    return {
      address: a,
      known: !!p,
      player: p ? {
        first_seen: p.first_seen, last_seen: p.last_seen, plays: p.plays, points: p.points,
        banned_until: p.banned_until, muted_until: p.muted_until,
        banned: p.banned_until !== null && p.banned_until > t, muted: p.muted_until !== null && p.muted_until > t,
        badges: publicBadges(p.badges_json),
      } : null,
      moderator: mod,
      nickname: names ? names.adminFor(a) : null,   // §19.16: live + pending, full rows (operator only)
      sessions: { ip: sessionsByKind.ip || 0, password: sessionsByKind.password || 0 },
      activity: stmts.activity.all(a, new Date((t - 13 * DAY) * 1000).toISOString().slice(0, 10))
        .map((r) => ({ day: r.day, minutes: Math.floor(r.seconds / 60), plays_awarded: r.plays_awarded })),
      matches,
      messages: stmts.listAddr.all(a, 20).map(adminMessage),
    };
  }

  function adminPlayers(ctx) {
    const q = ctx.query;
    for (const k of new Set(q.keys())) if (k !== 'filter' || q.getAll(k).length > 1) throw bad(k);
    const f = q.get('filter');
    const t = now();
    if (f === 'muted') return { ok: true, filter: f, players: stmts.muted.all(t, LIST_MAX) };
    if (f === 'banned') return { ok: true, filter: f, players: stmts.banned.all(t, LIST_MAX) };
    if (f === 'moderators') return { ok: true, filter: f, players: stmts.mods.all() };
    throw bad('filter');
  }

  function adminPlayer(ctx) {
    return { ok: true, ...playerView(addressParam(ctx)) };
  }

  function adminMute(ctx) {
    const a = addressParam(ctx);
    const b = onlyKeys(ctx.body, ['minutes', 'reason']);
    const minutes = intIn(b.minutes, 1, OPERATOR_MUTE_MAX_MIN, 'minutes');
    const reason = reasonOf(b);
    const until = now() + minutes * 60;
    db.transaction(() => {
      ledger.ensurePlayer(a);
      stmts.setMute.run(until, a);        // the operator sets it exactly: it may shorten a mute
      admin.audit(ctx, 'mute', a, { minutes, until, reason });
    });
    return { ok: true, ...playerView(a) };
  }

  function adminUnmute(ctx) {
    const a = addressParam(ctx);
    onlyKeys(ctx.body, []);
    db.transaction(() => {
      if (stmts.player.get(a)) stmts.setMute.run(null, a);
      admin.audit(ctx, 'unmute', a, null);
    });
    return { ok: true, ...playerView(a) };
  }

  // A ban revokes every session of the address at once (§19.5, closing §19.15 Part 4 #14),
  // blocks login, games and chat, and ends a moderator appointment and a nickname (§19.16).
  function adminBan(ctx) {
    const a = addressParam(ctx);
    const b = onlyKeys(ctx.body, ['days', 'forever', 'reason']);
    if ((b.days === undefined) === (b.forever === undefined)) throw bad('days');
    let until;
    if (b.forever !== undefined) {
      if (b.forever !== true) throw bad('forever');
      until = FOREVER;
    } else {
      until = now() + intIn(b.days, 1, BAN_MAX_DAYS, 'days') * DAY;
    }
    const reason = reasonOf(b);
    const out = db.transaction(() => {
      ledger.ensurePlayer(a);
      stmts.setBan.run(until, a);
      const revoked = sessions.revokeAll(a);
      const wasMod = stmts.delMod.run(a).changes === 1;
      // §19.16: a ban also ends the nickname (and refuses a pending one). An unban does not
      // restore it — the player submits again and it is reviewed again.
      const nick = names ? names.removeLiveOf(a, ctx.admin.user, 'ban') : null;
      admin.audit(ctx, 'ban', a, { until, forever: until === FOREVER, reason, sessions_revoked: revoked, moderator_removed: wasMod, nickname_removed: nick ? nick.name : null });
      return { revoked, wasMod };
    });
    if (out.wasMod) chat.invalidateModerators();
    return { ok: true, sessions_revoked: out.revoked, moderator_removed: out.wasMod, ...playerView(a) };
  }

  function adminUnban(ctx) {
    const a = addressParam(ctx);
    onlyKeys(ctx.body, []);
    db.transaction(() => {
      if (stmts.player.get(a)) stmts.setBan.run(null, a);
      admin.audit(ctx, 'unban', a, null);
    });
    return { ok: true, ...playerView(a) };
  }

  function adminPurge(ctx) {
    const a = addressParam(ctx);
    const b = onlyKeys(ctx.body, ['days', 'reason']);
    const days = intIn(b.days, 1, PURGE_MAX_DAYS, 'days');
    const reason = reasonOf(b) || 'purge';
    const t = now();
    const n = db.transaction(() => {
      let count = 0;
      for (const { id } of stmts.purgeIds.all(a, t - days * DAY)) if (chat.remove(id, ctx.admin.user, reason, t)) count++;
      admin.audit(ctx, 'purge', a, { days, deleted: count });
      return count;
    });
    return { ok: true, deleted: n, ...playerView(a) };
  }

  function adminAdjust(ctx) {
    const a = addressParam(ctx);
    const b = onlyKeys(ctx.body, ['kind', 'delta', 'note']);
    if (b.kind !== 'plays' && b.kind !== 'points') throw bad('kind');
    const delta = intIn(b.delta, -ADJUST_MAX, ADJUST_MAX, 'delta');
    if (delta === 0) throw bad('delta');
    let note = null;
    if (b.note !== undefined && b.note !== null && b.note !== '') {
      note = normaliseBody(b.note, NOTE_MAX);
      if (note === null) throw bad('note');
    }
    try {
      db.transaction(() => {
        const r = ledger.post({ address: a, kind: b.kind, delta, reason: 'admin_adjust', ref: null });
        admin.audit(ctx, 'adjust', a, { kind: b.kind, delta, balance: r.balance, note });
      });
    } catch (e) {
      if (e instanceof LedgerError) throw new HttpError(409, e.code === 'no_plays' ? 'no_plays' : 'no_points');
      throw e;
    }
    return { ok: true, ...playerView(a) };
  }

  // ═══ Operator: moderators (D21) ══════════════════════════════════════════════════════
  function adminModerators() {
    return { ok: true, moderators: stmts.mods.all(), max: MODS_MAX };
  }

  function adminAddModerator(ctx) {
    const a = addressParam(ctx);
    const b = onlyKeys(ctx.body, ['note']);
    let note = null;
    if (b.note !== undefined && b.note !== null && b.note !== '') {
      note = normaliseBody(b.note, NOTE_MAX);
      if (note === null) throw bad('note');
    }
    db.transaction(() => {
      const p = stmts.player.get(a);
      if (p && p.banned_until !== null && p.banned_until > now()) throw new HttpError(409, 'banned');
      if (!stmts.isMod.get(a) && stmts.modCount.get().n >= MODS_MAX) throw new HttpError(409, 'too_many_moderators');
      ledger.ensurePlayer(a);
      stmts.addMod.run(a, ctx.admin.user, now(), note);
      admin.audit(ctx, 'moderator_add', a, { note });
    });
    chat.invalidateModerators();
    return { ok: true, moderators: stmts.mods.all() };
  }

  function adminRemoveModerator(ctx) {
    const a = addressParam(ctx);
    onlyKeys(ctx.body, []);
    const n = db.transaction(() => {
      const c = stmts.delMod.run(a).changes;
      if (c) admin.audit(ctx, 'moderator_remove', a, null);
      return c;
    });
    chat.invalidateModerators();
    return { ok: true, changed: n === 1, moderators: stmts.mods.all() };
  }

  // ═══ Operator: games-owned settings (§19.11 games.html) ═══════════════════════════════
  // The floors the page must SHOW (§19.11: "the 1 h floor shown") — constants, never settings.
  const FLOORS = Object.freeze({
    chat_min_proof_age: CHAT_MIN_AGE_FLOOR,
    chat_min_interval_s: MIN_INTERVAL_S,
    chat_ip_posts_per_hour: IP_PER_HOUR,
    mod_mute_max_minutes: MOD_MUTE_MAX_MIN,
    operator_mute_max_minutes: OPERATOR_MUTE_MAX_MIN,
  });

  function adminSettings() {
    const values = settings.all();
    return {
      ok: true,
      values,
      spec: Object.entries(SPEC).map(([key, s]) => ({ key, type: s.type, def: s.def, ...(s.type === 'int' ? { min: s.min, max: s.max } : {}) })),
      floors: FLOORS,
      meta: settings.meta(),
    };
  }

  function adminSettingsSave(ctx) {
    const b = onlyKeys(ctx.body, ['values']);
    const v = b.values;
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length === 0) throw bad('values');
    const before = settings.all();
    let changed;
    try {
      changed = db.transaction(() => {
        const c = settings.setMany(v, ctx.admin.user);
        if (c.length) admin.audit(ctx, 'settings', 'settings', Object.fromEntries(c.map((k) => [k, [before[k], v[k]]])));
        return c;
      });
    } catch (e) {
      if (e && e.field) throw bad(e.field);
      throw e;
    }
    return { ok: true, changed, ...adminSettings() };
  }

  // ═══ Operator: the mod log ═══════════════════════════════════════════════════════════
  function adminModLog(ctx) {
    const q = ctx.query;
    for (const k of new Set(q.keys())) if (!['before', 'limit'].includes(k) || q.getAll(k).length > 1) throw bad(k);
    const before = q.get('before') === null ? Number.MAX_SAFE_INTEGER : parseIntStrict(q.get('before'), { min: 1 });
    if (before === null) throw bad('before');
    const limit = q.get('limit') === null ? 100 : parseIntStrict(q.get('limit'), { min: 1, max: MOD_LOG_MAX });
    if (limit === null) throw bad('limit');
    return {
      ok: true,
      actions: stmts.modLog.all(before, limit).map((r) => {
        let details = null;
        try { details = r.details_json ? JSON.parse(r.details_json) : null; } catch { details = null; }
        return { id: r.id, actor: r.admin_user, action: r.action, target: r.target, details, created_at: r.created_at };
      }),
    };
  }

  if (admin) {
    admin.add('GET', 'chat/messages', adminMessages);
    admin.add('GET', 'chat/reports', adminReports);
    admin.add('POST', 'chat/messages/:id/delete', adminDelete, { bodyLimit: 1024 });
    admin.add('POST', 'chat/held/:id/approve', adminApprove, { bodyLimit: 256 });
    admin.add('POST', 'chat/messages/:id/restore', adminRestore, { bodyLimit: 256 });
    admin.add('POST', 'chat/post', adminPost, { bodyLimit: 4096 });
    admin.add('GET', 'chat/words', adminWords);
    admin.add('POST', 'chat/words', adminWordsEdit, { bodyLimit: 16 * 1024 });
    admin.add('GET', 'players', adminPlayers);
    admin.add('GET', 'players/:addr', adminPlayer);
    admin.add('POST', 'players/:addr/mute', adminMute, { bodyLimit: 1024 });
    admin.add('POST', 'players/:addr/unmute', adminUnmute, { bodyLimit: 256 });
    admin.add('POST', 'players/:addr/ban', adminBan, { bodyLimit: 1024 });
    admin.add('POST', 'players/:addr/unban', adminUnban, { bodyLimit: 256 });
    admin.add('POST', 'players/:addr/purge', adminPurge, { bodyLimit: 1024 });
    admin.add('POST', 'players/:addr/adjust', adminAdjust, { bodyLimit: 1024 });
    admin.add('GET', 'moderators', adminModerators);
    admin.add('POST', 'moderators/:addr', adminAddModerator, { bodyLimit: 1024 });
    admin.add('POST', 'moderators/:addr/remove', adminRemoveModerator, { bodyLimit: 256 });
    admin.add('GET', 'settings', adminSettings);
    admin.add('POST', 'settings', adminSettingsSave, { bodyLimit: 4096 });
    admin.add('GET', 'mod-log', adminModLog);
  }

  // ═══ Moderators (D21), on the public API ═════════════════════════════════════════════
  const modBucket = createTokenBuckets({ capacity: MOD_ACTIONS_PER_HOUR, refillPerSec: MOD_ACTIONS_PER_HOUR / 3600, maxKeys: 1000 });

  // The acting moderator's session, or a refusal. Re-read on every request, so removing a
  // moderator (or banning, muting, or the password switch) takes effect at once.
  function requireModerator(ctx) {
    const s = auth.requireSession(ctx);
    const st = auth.modStatus(s);
    if (st === null) throw new HttpError(403, 'not_moderator');
    if (!st.can_act) throw new HttpError(403, 'mod_refused', { reason: st.reason });
    return s;
  }

  function auditMod(s, action, target, details) {
    const d = details === undefined || details === null ? null : JSON.stringify(details);
    stmts.insertModAction.run(`mod:${s.address}`, action, target, d, now());
  }

  function modTake(s) {
    const take = modBucket.take(s.address);
    if (!take.ok) throw new HttpError(429, 'too_many_requests', { retry_after: take.retryAfter }, { 'Retry-After': String(take.retryAfter) });
  }

  // A message as a moderator sees it: masked names only, like the public view, plus its
  // state and why it was held.
  function modMessage(m) {
    return { ...chat.view(m, null), state: m.state, hold_reason: m.hold_reason, open_reports: stmts.reportCount.get(m.id).n };
  }

  // What a moderator may not touch: operator posts, and anything by another moderator.
  function protectedFrom(s, m) {
    if (m.role === 'operator') return 'operator_message';
    if (m.address !== s.address && chat.moderators().has(m.address)) return 'moderator_message';
    return null;
  }

  function modQueue(ctx) {
    requireModerator(ctx);
    const held = stmts.listState.all('held', Number.MAX_SAFE_INTEGER, PAGE).map(modMessage);
    return { ok: true, held, reports: reportQueue({ masked: true }) };
  }

  function modDelete(ctx) {
    const s = requireModerator(ctx);
    const id = messageId(ctx);
    const reason = reasonOf(onlyKeys(ctx.body, ['reason']));
    modTake(s);
    const r = db.transaction(() => {
      const m = chat.byId(id);
      if (!m || m.state === 'deleted') throw new HttpError(404, 'not_found');
      const p = protectedFrom(s, m);
      if (p) throw new HttpError(403, 'mod_protected', { reason: p });
      const before = chat.remove(id, `mod:${s.address}`, reason);
      if (before) auditMod(s, 'chat_delete', `msg:${id}`, { author: m.address, reason });
      return before;
    });
    return { ok: true, changed: r !== null };
  }

  function modApprove(ctx) {
    const s = requireModerator(ctx);
    const id = messageId(ctx);
    onlyKeys(ctx.body, []);
    modTake(s);
    const r = db.transaction(() => {
      const m = chat.byId(id);
      if (!m || m.state === 'deleted') throw new HttpError(404, 'not_found');
      if (m.address === s.address) throw new HttpError(403, 'mod_protected', { reason: 'own_message' });
      const p = protectedFrom(s, m);
      if (p) throw new HttpError(403, 'mod_protected', { reason: p });
      const before = chat.approve(id, `mod:${s.address}`);
      if (before) auditMod(s, before.state === 'held' ? 'chat_approve' : 'chat_keep', `msg:${id}`, { author: m.address, hold_reason: m.hold_reason });
      return before;
    });
    return { ok: true, changed: r !== null };
  }

  // Mutes the AUTHOR of a message, so a moderator never needs (or sees) a full address.
  // ≤ 24 h, and never shortens a mute already in place (the operator's 30-day one included).
  function modMute(ctx) {
    const s = requireModerator(ctx);
    const id = messageId(ctx);
    const b = onlyKeys(ctx.body, ['minutes', 'reason']);
    const minutes = intIn(b.minutes, 1, MOD_MUTE_MAX_MIN, 'minutes');
    const reason = reasonOf(b);
    modTake(s);
    const until = db.transaction(() => {
      const m = chat.byId(id);
      if (!m) throw new HttpError(404, 'not_found');
      if (m.role === 'operator' || m.address === null) throw new HttpError(403, 'mod_protected', { reason: 'operator_message' });
      if (m.address === s.address) throw new HttpError(403, 'mod_protected', { reason: 'own_message' });
      if (chat.moderators().has(m.address)) throw new HttpError(403, 'mod_protected', { reason: 'moderator_message' });
      const p = stmts.player.get(m.address);
      const t = now();
      const want = t + minutes * 60;
      const cur = p && p.muted_until !== null && p.muted_until > t ? p.muted_until : null;
      if (cur !== null && cur >= want) return cur;
      stmts.setMute.run(want, m.address);
      auditMod(s, 'mute', m.address, { minutes, until: want, reason, message: id });
      return want;
    });
    return { ok: true, muted_until: until };
  }

  return {
    routes: [
      ['GET', '/play/api/mod/queue', modQueue],
      ['POST', '/play/api/mod/messages/:id/delete', modDelete, { bodyLimit: 1024 }],
      ['POST', '/play/api/mod/messages/:id/approve', modApprove, { bodyLimit: 256 }],
      ['POST', '/play/api/mod/messages/:id/mute', modMute, { bodyLimit: 1024 }],
    ],
    FLOORS,
  };
}

module.exports = { createModeration, FOREVER, MOD_MUTE_MAX_MIN, OPERATOR_MUTE_MAX_MIN, MODS_MAX };
