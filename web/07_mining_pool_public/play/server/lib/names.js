'use strict';

// Nicknames v2 (design §19.17.5, D27/D28; v1 was Part 12's pre-moderation, §19.16).
//
//   POST /play/api/nickname          { name }   checked → live at once (replaces your live one)
//   POST /play/api/nickname/remove   {}         your live one → removed (always allowed)
//   /me carries `nickname` (built here: meView)
//
//   admin (/internal/admin/*, all STEP-UP — none is in FAST_WRITES, so the pool code does not
//   change):
//   GET  nicknames?state=live|removed&q=        the lists, full addresses, `shown_as`, and on a
//                                                live row the rule `hit` it would now get
//   POST nicknames/:id/remove        {reason?}  live → removed (the owner sees the reason)
//   GET  banned-names                           the banned matching forms
//   POST banned-names                {name, reason?}   ban that matching form + remove its holder
//   POST banned-names/:norm/unban    {}         delete the ban (nothing is restored)
//   GET  nick-blocked                           players blocked from nicknames
//   POST players/:addr/nick-block    {reason?}  block + remove the live name
//   POST players/:addr/nick-unblock  {}
//
//   a moderator (D21 amended) removes a name through moderation.js (modRemove below).
//
// The rules this module owns:
//   - A nickname is NEVER shown alone: label() returns `Nick (grin1abcd…wxyz)` (§19.13 #10: a
//     mask costs ~2^40 key generations to grind; a nickname costs nothing to copy). Unchanged
//     from Part 12, and the reason a name may go live without a human looking at it first.
//   - The word checks are lib/name-rule.js (one rule, two copies, one fixture). A reserved or
//     blocked hit answers only `name_not_allowed`; a banned or taken name only
//     `name_unavailable` — which list, or that a ban exists, is the admin's to know.
//   - Refusals that could probe the lists (not allowed / unavailable) are capped at
//     REFUSED_PER_DAY per account per UTC day, counted on the players row; the refused text is
//     never stored.
//   - "No two live names alike" is the partial unique index uq_nick_norm, so a race between
//     two submits is a database refusal, answered `name_unavailable`, not a duplicate.
//   - Setting a name needs a CHAT-CAPABLE session (the aged, non-anchor, mining bar, whatever
//     the chat switch says): a stranger who mined a few shares to your address must not be
//     able to name you. Removing your own name needs only a session.
//
// The pool's half of the lists (D28: names.blocked_words + the pool's name) arrives on every
// /internal/games/config fetch (lib/mode.js → updatePoolLists) and is persisted in the
// settings table under POOL_LISTS_KEY, so a restart with the pool down keeps the last list.
// The seed in name-rule.js applies whatever the pool says.

const { HttpError, parseIntStrict } = require('./http');
const { maskAddr, isGuestId, playerParam } = require('./mask');
const { normaliseBody } = require('./chat');
const rule = require('./name-rule');

const DAY = 86400;
const REFUSED_PER_DAY = 10;
const REASON_MAX = 200;
const LIST_MAX = 200;
const BANNED_MAX = 500;
const Q_MAX = 64;
const KEEP_DECIDED_S = 180 * DAY;     // replaced / removed rows (§19.13 #19)
const PURGE_BATCH = 5000;
const SELF = 'self';                  // decided_by for the player's own change / remove
const POOL_LISTS_KEY = 'pool_name_lists';
const POOL_BLOCKED_MAX = 500;         // the pool's validator bound (§19.17.5)
const POOL_ENTRY_RE = /^[*=]?[a-z0-9]{1,32}$/;
const POOL_NAME_MAX = 64;
const DELETED_GUEST = 'deleted guest';

const utcDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const nextUtcMidnight = (t) => (Math.floor(t / DAY) + 1) * DAY;

function createNames({ db, auth, settings, admin, ledger, config, log = null, words = () => [], now = () => Math.floor(Date.now() / 1000) }) {
  const raw = db.raw;
  const prefix = config.net === 'mainnet' ? 'grin1' : 'tgrin1';
  const COLS = 'id, address, name, norm, state, submitted_at, decided_at, decided_by, reason';
  const stmts = {
    live: raw.prepare('SELECT address, name FROM nicknames WHERE state = \'approved\''),
    byId: raw.prepare(`SELECT ${COLS} FROM nicknames WHERE id = ?`),
    liveOf: raw.prepare(`SELECT ${COLS} FROM nicknames WHERE address = ? AND state = 'approved'`),
    pendingOf: raw.prepare(`SELECT ${COLS} FROM nicknames WHERE address = ? AND state = 'pending'`),
    lastOf: raw.prepare(`SELECT ${COLS} FROM nicknames WHERE address = ? ORDER BY id DESC LIMIT 1`),
    liveByNorm: raw.prepare(`SELECT ${COLS} FROM nicknames WHERE norm = ? AND state = 'approved'`),
    takenBy: raw.prepare('SELECT address FROM nicknames WHERE norm = ? AND state = \'approved\' AND address != ?'),
    insertLive: raw.prepare(
      'INSERT INTO nicknames (address, name, norm, state, submitted_at, decided_at, decided_by) VALUES (?, ?, ?, \'approved\', ?, ?, ?)'),
    decide: raw.prepare('UPDATE nicknames SET state = ?, decided_at = ?, decided_by = ?, reason = ? WHERE id = ? AND state = ?'),
    list: raw.prepare(`SELECT ${COLS} FROM nicknames WHERE state = ? ORDER BY id DESC LIMIT ?`),
    listNorm: raw.prepare(`SELECT ${COLS} FROM nicknames WHERE state = ? AND norm LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`),
    listAddr: raw.prepare(`SELECT ${COLS} FROM nicknames WHERE state = ? AND address LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`),
    count: raw.prepare('SELECT COUNT(*) AS n FROM nicknames WHERE state = ?'),
    oldIds: raw.prepare(
      "SELECT id FROM nicknames WHERE state IN ('rejected','replaced','withdrawn','removed') AND COALESCE(decided_at, submitted_at) < ? ORDER BY id ASC LIMIT ?"),
    del: raw.prepare('DELETE FROM nicknames WHERE id = ?'),
    nickPlayer: raw.prepare('SELECT nick_blocked, nick_changed_at, nick_refused_day, nick_refused_n FROM players WHERE address = ?'),
    setChanged: raw.prepare('UPDATE players SET nick_changed_at = ? WHERE address = ?'),
    setRefused: raw.prepare('UPDATE players SET nick_refused_day = ?, nick_refused_n = ? WHERE address = ?'),
    setBlocked: raw.prepare('UPDATE players SET nick_blocked = ? WHERE address = ? AND nick_blocked != ?'),
    blocked: raw.prepare('SELECT address, nick_changed_at FROM players WHERE nick_blocked = 1 ORDER BY address LIMIT ?'),
    blockedCount: raw.prepare('SELECT COUNT(*) AS n FROM players WHERE nick_blocked = 1'),
    banned: raw.prepare('SELECT 1 AS x FROM banned_names WHERE norm = ?'),
    bannedList: raw.prepare('SELECT norm, name, banned_at, banned_by, reason FROM banned_names ORDER BY banned_at DESC, norm LIMIT ?'),
    bannedCount: raw.prepare('SELECT COUNT(*) AS n FROM banned_names'),
    ban: raw.prepare('INSERT INTO banned_names (norm, name, banned_at, banned_by, reason) VALUES (?, ?, ?, ?, ?) ON CONFLICT(norm) DO NOTHING'),
    unban: raw.prepare('DELETE FROM banned_names WHERE norm = ?'),
    deletedAt: raw.prepare('SELECT deleted_at FROM players WHERE address = ?'),
    kindOf: raw.prepare('SELECT kind FROM players WHERE address = ?'),
    poolListsGet: raw.prepare('SELECT value FROM settings WHERE key = ?'),
    poolListsPut: raw.prepare(
      'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, \'pool\') ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by'),
  };

  const bad = (field) => new HttpError(400, 'bad_request', { field });
  const enabled = () => settings.get('nicknames_enabled') === true;

  // ── The display cache: address → live nickname. Tiny (one row per named player) and read on
  // every chat line and board row; invalidated by every write that changes it.
  let liveMap = null;
  const live = () => {
    if (!liveMap) liveMap = new Map(stmts.live.all().map((r) => [r.address, r.name]));
    return liveMap;
  };
  const invalidate = () => { liveMap = null; };

  // THE public name of an address: the mask, or `Nick (mask)`. Never the nickname alone.
  // A guest (§19.17.5, Part C5): `Nick · guest`, or `Guest-XXXX` with no nickname (maskAddr's
  // guest branch), or "deleted guest" once the account is gone — a guest's nickname is not
  // pinned to an unforgeable mask, and the " · guest" says so: a name that matters (the operator,
  // a moderator) is never a guest's (D21/D32: guests are never moderators).
  function label(address) {
    const mask = maskAddr(address);
    if (isGuestId(address)) {
      const p = stmts.deletedAt.get(address);
      if (p && p.deleted_at !== null) return DELETED_GUEST;
      if (!enabled()) return mask;
      const g = live().get(address);
      return g ? `${g} · guest` : mask;
    }
    if (!enabled() || typeof address !== 'string') return mask;
    const n = live().get(address);
    return n ? `${n} (${mask})` : mask;
  }
  // The same form for a name that is not (or no longer) live — the admin lists.
  const shownAs = (address, name) => (isGuestId(address) ? `${name} · guest` : `${name} (${maskAddr(address)})`);

  // ── The lists ───────────────────────────────────────────────────────────────────────
  // The pool's half, as last received: { pool_name, blocked }. A stored value that does not
  // parse reads as empty — the seed still applies.
  function sanePoolLists(v) {
    const out = { pool_name: '', blocked: [] };
    if (!v || typeof v !== 'object') return out;
    if (typeof v.pool_name === 'string' && v.pool_name.length <= POOL_NAME_MAX) out.pool_name = v.pool_name;
    if (Array.isArray(v.blocked) && v.blocked.length <= POOL_BLOCKED_MAX) out.blocked = v.blocked.filter((w) => typeof w === 'string' && POOL_ENTRY_RE.test(w));
    return out;
  }
  let poolLists = (() => {
    const row = stmts.poolListsGet.get(POOL_LISTS_KEY);
    try { return sanePoolLists(row ? JSON.parse(row.value) : null); } catch { return sanePoolLists(null); }
  })();
  let compiledPool = rule.compileList(poolLists.blocked);

  // From the config fetch (lib/mode.js). A pool that sends neither field (a build before C3)
  // changes nothing; one that sends them replaces the copy, and a change is persisted.
  function updatePoolLists(c) {
    if (!c || (c.blocked_words === undefined && c.pool_name === undefined)) return false;
    const next = sanePoolLists({
      pool_name: c.pool_name === undefined ? poolLists.pool_name : c.pool_name,
      blocked: c.blocked_words === undefined ? poolLists.blocked : c.blocked_words,
    });
    const text = JSON.stringify(next);
    if (text === JSON.stringify(poolLists)) return false;
    poolLists = next;
    compiledPool = rule.compileList(next.blocked);
    try { stmts.poolListsPut.run(POOL_LISTS_KEY, text, now()); } catch (e) { if (log) log.warn(`[names] could not persist the pool's name list: ${e.message}`); }
    if (log) log.info(`[names] the pool's name list now has ${next.blocked.length} entr${next.blocked.length === 1 ? 'y' : 'ies'}`);
    return true;
  }

  // The chat word list is chat's (cached there, a new array after each edit), compiled here on
  // identity change.
  let wordsSrc = null;
  let wordsCompiled = [];
  function ruleCtx() {
    const w = words() || [];
    if (w !== wordsSrc) { wordsSrc = w; wordsCompiled = rule.compileList(w); }
    return { poolName: poolLists.pool_name, blocked: compiledPool, words: wordsCompiled };
  }

  // ── Player side ─────────────────────────────────────────────────────────────────────
  function nickRow(address) {
    return stmts.nickPlayer.get(address) || { nick_blocked: 0, nick_changed_at: null, nick_refused_day: null, nick_refused_n: 0 };
  }

  // Who may SET a name now: the switch, the block, the chat bar minus the chat switch (a name
  // shows on the boards too, so turning chat off must not freeze everyone's name), and the
  // change cooldown.
  // A GUEST needs only its session (§19.17.5): the chat bar exists for miners because a stranger
  // who mined to your address could otherwise name you; nobody can sign in to a guest account
  // without its password.
  function gate(s, t = now()) {
    if (!enabled()) return { can_submit: false, reason: 'nicknames_off', available_at: null };
    const p = nickRow(s.address);
    if (p.nick_blocked === 1) return { can_submit: false, reason: 'nick_blocked', available_at: null };
    if (!isGuestId(s.address)) {
      const st = auth.chatStatus(s, { ignoreChatSwitch: true });
      if (!st.can_post) return { can_submit: false, reason: st.reason, available_at: st.available_at };
    }
    const days = settings.get('nickname_change_days');
    if (days > 0 && p.nick_changed_at !== null && t < p.nick_changed_at + days * DAY) {
      return { can_submit: false, reason: 'cooldown', available_at: p.nick_changed_at + days * DAY };
    }
    return { can_submit: true, reason: null, available_at: null };
  }

  function onlyKeys(b, allowed) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body');
    for (const k of Object.keys(b)) if (!allowed.includes(k)) throw bad('body');
    return b;
  }

  // The latest row of an address, when it says someone else ended the name (an admin, a
  // moderator, the v4 migration) — shown to its owner with the reason. Gone once they pick a
  // new one (the latest row is then that one).
  function refusedView(address) {
    const last = stmts.lastOf.get(address);
    if (!last || !(last.state === 'removed' || last.state === 'rejected') || last.decided_by === SELF) return null;
    const by = typeof last.decided_by === 'string' && last.decided_by.startsWith('mod:') ? 'moderator'
      : last.decided_by === 'system' ? 'rule' : 'pool';
    return { name: last.name, state: last.state, reason: last.reason, at: last.decided_at, by };
  }

  // What /me says about the caller's own nickname.
  function meView(s) {
    const g = gate(s);
    const l = stmts.liveOf.get(s.address);
    return {
      enabled: enabled(),
      live: l ? l.name : null,
      shown_as: label(s.address),
      refused: refusedView(s.address),
      can_submit: g.can_submit,
      reason: g.reason,
      available_at: g.available_at,
      can_remove: !!l,
      rule: rule.NAME_RULE,
      change_days: settings.get('nickname_change_days'),
    };
  }

  // One refused attempt counted (its own transaction: the request is about to fail).
  function countRefusal(address, t) {
    db.transaction(() => {
      ledger.ensurePlayer(address, t);
      const p = nickRow(address);
      const day = utcDay(t);
      stmts.setRefused.run(day, p.nick_refused_day === day ? p.nick_refused_n + 1 : 1, address);
    });
  }
  function refusedToday(address, t) {
    const p = nickRow(address);
    return p.nick_refused_day === utcDay(t) ? p.nick_refused_n : 0;
  }

  const isUnique = (e) => e && /UNIQUE/i.test(String(e.message));

  function submit(ctx) {
    const s = auth.requireSession(ctx);
    const b = onlyKeys(ctx.body, ['name']);
    const t = now();
    const g = gate(s, t);
    if (!g.can_submit) {
      if (g.reason === 'nicknames_off') throw new HttpError(403, 'nicknames_off');
      throw new HttpError(403, 'nickname_refused', { reason: g.reason, available_at: g.available_at });
    }
    const sh = rule.checkShape(b.name);
    if (!sh.ok) throw new HttpError(400, sh.code, { hint: rule.RULE_TEXT[sh.code] });
    const cur = stmts.liveOf.get(s.address);
    if (cur && cur.name === sh.name) throw new HttpError(409, 'unchanged');
    if (refusedToday(s.address, t) >= REFUSED_PER_DAY) {
      const ra = Math.max(1, nextUtcMidnight(t) - t);
      throw new HttpError(429, 'too_many_refusals', { retry_after: ra }, { 'Retry-After': String(ra) });
    }
    const v = rule.check(sh.name, ruleCtx());
    if (!v.ok && v.code === 'name_address') throw new HttpError(400, 'name_address', { hint: rule.RULE_TEXT.name_address });
    const unavailable = () => { countRefusal(s.address, t); return new HttpError(409, 'name_unavailable'); };
    if (!v.ok) { countRefusal(s.address, t); throw new HttpError(400, 'name_not_allowed'); }
    if (stmts.banned.get(v.norm) || stmts.takenBy.get(v.norm, s.address)) throw unavailable();
    try {
      db.transaction(() => {
        ledger.ensurePlayer(s.address, t);
        const prev = stmts.liveOf.get(s.address);
        if (prev) stmts.decide.run('replaced', t, SELF, null, prev.id, 'approved');
        stmts.insertLive.run(s.address, v.name, v.norm, t, t, SELF);
        stmts.setChanged.run(t, s.address);
      });
    } catch (e) {
      if (isUnique(e)) throw unavailable();      // another address took it between the check and here
      throw e;
    }
    invalidate();
    return { ok: true, nickname: meView(s) };
  }

  function removeOwn(ctx) {
    const s = auth.requireSession(ctx);
    onlyKeys(ctx.body, []);
    const t = now();
    const changed = db.transaction(() => {
      const l = stmts.liveOf.get(s.address);
      return l ? stmts.decide.run('removed', t, SELF, null, l.id, 'approved').changes : 0;
    });
    invalidate();
    return { ok: true, changed: changed === 1, nickname: meView(s) };
  }

  // ── Guest sign-up (§19.17.3, Part C5) ──────────────────────────────────────────────
  // The sign-up name is the rule's, like a nickname, and must be free as a nickname; guests.js
  // adds the login-name check, which ONLY sign-up makes (a rename must never be an oracle for
  // the login namespace). No refusal counter here: there is no account yet, and each attempt
  // has already cost a proof-of-work. → { name, norm }, or an HttpError.
  function checkSignupName(input) {
    const sh = rule.checkShape(input);
    if (!sh.ok) throw new HttpError(400, sh.code, { hint: rule.RULE_TEXT[sh.code] });
    const v = rule.check(sh.name, ruleCtx());
    if (!v.ok && v.code === 'name_address') throw new HttpError(400, 'name_address', { hint: rule.RULE_TEXT.name_address });
    if (!v.ok) throw new HttpError(400, 'name_not_allowed');
    if (!availableForSignup(v.norm)) throw new HttpError(409, 'name_unavailable');
    return { name: v.name, norm: v.norm };
  }
  const availableForSignup = (norm) => !stmts.banned.get(norm) && !stmts.liveByNorm.get(norm);
  // Inside guests.js's sign-up transaction: the first nickname, live at once. Sign-up counts as a
  // change for the cooldown (§19.17.5).
  function setSignupName(address, name, norm, t) {
    stmts.insertLive.run(address, name, norm, t, t, SELF);
    stmts.setChanged.run(t, address);
  }

  // ── Operator side ───────────────────────────────────────────────────────────────────
  // On a LIVE row: what the rule would say about it today (the lists change after a name went
  // live) — a hint for the admin, never applied by itself.
  function hitOf(r) {
    const v = rule.check(r.name, ruleCtx());
    if (!v.ok) return { code: v.code, list: v.list || null, entry: v.entry || null };
    if (stmts.banned.get(r.norm)) return { code: 'name_banned', list: 'banned', entry: r.norm };
    return null;
  }

  function adminRow(r) {
    return {
      id: r.id, address: r.address, name: r.name, state: r.state, submitted_at: r.submitted_at,
      decided_at: r.decided_at, decided_by: r.decided_by, reason: r.reason,
      shown_as: shownAs(r.address, r.name),
      ...(r.state === 'approved' ? { hit: hitOf(r) } : {}),
    };
  }

  // The operator's view of one address, for the Players page.
  function adminFor(address) {
    const l = stmts.liveOf.get(address);
    const p = nickRow(address);
    return { live: l ? adminRow(l) : null, blocked: p.nick_blocked === 1, changed_at: p.nick_changed_at };
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
  // A miner address, or a guest as 'g.<16>' (mask.js playerParam: a path cannot carry ':').
  // An unknown guest id is a 404 (moderation.js playerParamOf says why).
  function addressParam(ctx) {
    const a = playerParam(ctx.params.addr, prefix);
    if (a === null) throw bad('address');
    if (isGuestId(a)) {
      const p = stmts.kindOf.get(a);
      if (!p || p.kind !== 'guest') throw new HttpError(404, 'not_found');
    }
    return a;
  }
  const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

  function counts() {
    return {
      live: stmts.count.get('approved').n, removed: stmts.count.get('removed').n,
      banned: stmts.bannedCount.get().n, blocked: stmts.blockedCount.get().n,
    };
  }

  function adminList(ctx) {
    const q = ctx.query;
    for (const k of new Set(q.keys())) if (!['state', 'q'].includes(k) || q.getAll(k).length > 1) throw bad(k);
    const st = q.get('state') === null ? 'live' : q.get('state');
    if (!['live', 'removed'].includes(st)) throw bad('state');
    const state = st === 'live' ? 'approved' : 'removed';
    const text = q.get('q') === null ? '' : q.get('q').trim();
    if (text.length > Q_MAX) throw bad('q');
    let rows;
    if (text === '') rows = stmts.list.all(state, LIST_MAX);
    else if (/^t?grin1/i.test(text)) rows = stmts.listAddr.all(state, `${likeEscape(text.toLowerCase())}%`, LIST_MAX);
    else if (/^g[:.][a-z2-7]/i.test(text)) rows = stmts.listAddr.all(state, `g:${likeEscape(text.slice(2).toLowerCase())}%`, LIST_MAX);
    else {
      const norm = rule.matchForm(text);
      if (norm === '') throw bad('q');
      rows = stmts.listNorm.all(state, `%${likeEscape(norm)}%`, LIST_MAX);
    }
    return { ok: true, state: st, q: text, enabled: enabled(), counts: counts(), nicknames: rows.map(adminRow) };
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

  function bannedView() {
    return stmts.bannedList.all(BANNED_MAX);
  }

  function adminBanned() {
    return { ok: true, counts: counts(), banned: bannedView() };
  }

  // Ban a matching form: no spelling of it can be taken again, and its current holder loses it.
  // The name may be anything that folds to 1–32 of a–z 0–9 (the operator can ban a spelling the
  // rule would refuse anyway — it costs nothing and survives a later rule change).
  function adminBan(ctx) {
    const b = onlyKeys(ctx.body, ['name', 'reason']);
    if (typeof b.name !== 'string' || b.name.trim() === '' || b.name.length > 40) throw bad('name');
    const name = b.name.trim();
    const norm = rule.matchForm(name);
    if (!/^[a-z0-9]{1,32}$/.test(norm)) throw bad('name');
    const reason = reasonOf(b);
    const t = now();
    const out = db.transaction(() => {
      const changed = stmts.ban.run(norm, name, t, ctx.admin.user, reason).changes === 1;
      const holder = stmts.liveByNorm.get(norm);
      if (holder) removeLive(holder, ctx.admin.user, reason || 'This name is no longer allowed on this pool.', t);
      if (changed || holder) admin.audit(ctx, 'nickname_ban_name', norm, { name, reason, removed: holder ? { address: holder.address, name: holder.name } : null });
      return { changed, removed: holder ? { address: holder.address, name: holder.name } : null };
    });
    invalidate();
    return { ok: true, ...out, counts: counts(), banned: bannedView() };
  }

  function adminUnban(ctx) {
    const norm = ctx.params.norm;
    if (typeof norm !== 'string' || !/^[a-z0-9]{1,32}$/.test(norm)) throw new HttpError(404, 'not_found');
    onlyKeys(ctx.body, []);
    const changed = db.transaction(() => {
      const c = stmts.unban.run(norm).changes === 1;
      if (c) admin.audit(ctx, 'nickname_unban_name', norm, null);
      return c;
    });
    return { ok: true, changed, counts: counts(), banned: bannedView() };
  }

  function adminBlockedList() {
    return { ok: true, counts: counts(), blocked: stmts.blocked.all(LIST_MAX).map((r) => ({ address: r.address, changed_at: r.nick_changed_at })) };
  }

  function adminBlock(ctx) {
    const a = addressParam(ctx);
    const reason = reasonOf(onlyKeys(ctx.body, ['reason']));
    const t = now();
    const out = db.transaction(() => {
      ledger.ensurePlayer(a, t);
      const changed = stmts.setBlocked.run(1, a, 1).changes === 1;
      const l = stmts.liveOf.get(a);
      if (l) removeLive(l, ctx.admin.user, reason, t);
      if (changed || l) admin.audit(ctx, 'nickname_block', a, { reason, removed: l ? l.name : null });
      return { changed, removed: l ? l.name : null };
    });
    invalidate();
    return { ok: true, ...out, nickname: adminFor(a) };
  }

  function adminUnblock(ctx) {
    const a = addressParam(ctx);
    onlyKeys(ctx.body, []);
    const changed = db.transaction(() => {
      const c = stmts.setBlocked.run(0, a, 0).changes === 1;
      if (c) admin.audit(ctx, 'nickname_unblock', a, null);
      return c;
    });
    return { ok: true, changed, nickname: adminFor(a) };
  }

  // For moderation.js: a ban ends the nickname (in the ban's own transaction), and a moderator
  // may remove one. → the row as it was, or null. Neither audits — the caller's row says so.
  function removeLive(n, by, reason, t = now()) {
    stmts.decide.run('removed', t, by, reason, n.id, 'approved');
    invalidate();
    return n;
  }
  function removeLiveOf(address, by, reason) {
    const l = stmts.liveOf.get(address);
    const p = stmts.pendingOf.get(address);           // none since v4; a leftover is closed too
    const t = now();
    if (p) stmts.decide.run('rejected', t, by, reason, p.id, 'pending');
    return l ? removeLive(l, by, reason, t) : null;
  }

  // Hourly: decided rows past 180 days are dropped. The live rows are never touched.
  function purge(t = now()) {
    const ids = stmts.oldIds.all(t - KEEP_DECIDED_S, PURGE_BATCH);
    if (!ids.length) return 0;
    return db.transaction(() => ids.reduce((n, { id }) => n + stmts.del.run(id).changes, 0));
  }

  if (admin) {
    admin.add('GET', 'nicknames', adminList);
    admin.add('POST', 'nicknames/:id/remove', adminRemove, { bodyLimit: 1024 });
    admin.add('GET', 'banned-names', adminBanned);
    admin.add('POST', 'banned-names', adminBan, { bodyLimit: 1024 });
    admin.add('POST', 'banned-names/:norm/unban', adminUnban, { bodyLimit: 256 });
    admin.add('GET', 'nick-blocked', adminBlockedList);
    admin.add('POST', 'players/:addr/nick-block', adminBlock, { bodyLimit: 1024 });
    admin.add('POST', 'players/:addr/nick-unblock', adminUnblock, { bodyLimit: 256 });
  }

  return {
    label, meView, adminFor, removeLiveOf, modRemove: removeLiveOf, purge, invalidate, updatePoolLists,
    checkSignupName, availableForSignup, setSignupName,
    poolLists: () => poolLists,
    routes: [
      ['POST', '/play/api/nickname', submit, { bodyLimit: 1024 }],
      ['POST', '/play/api/nickname/remove', removeOwn, { bodyLimit: 256 }],
    ],
  };
}

// The fallback every module uses when it is built without names (the Part 1–10 tests
// construct some directly): the mask, exactly as before Part 12.
const MASK_ONLY = Object.freeze({ label: maskAddr });

module.exports = {
  createNames, MASK_ONLY, REFUSED_PER_DAY, KEEP_DECIDED_S, POOL_LISTS_KEY, DELETED_GUEST,
  // Re-exported so existing callers keep one import site.
  matchForm: rule.matchForm, NAME_MIN: rule.NAME_MIN, NAME_MAX: rule.NAME_MAX, NAME_RULE: rule.NAME_RULE,
};
