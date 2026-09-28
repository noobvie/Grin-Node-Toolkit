'use strict';

// Events — competitions between addresses (design §19.9, D15, D17).
//
//   public (mode ≠ off):  GET /play/api/events            the list
//                         GET /play/api/events/:id        one event + top 50 + the caller's rank
//   admin (proxy only):   GET  /internal/admin/event-kinds          kinds, badges, games (the form)
//                         GET  /internal/admin/events               every event, newest first
//                         GET  /internal/admin/events/:id           one event + FULL results
//                         POST /internal/admin/events               create        (fast)
//                         POST /internal/admin/events/:id           update        (fast)
//                         POST /internal/admin/events/:id/cancel    cancel        (step-up)
//                         POST /internal/admin/events/:id/finalise  finalise now  (step-up)
//
// An event KIND is one module in lib/events/<kind>.js exporting validate / compute /
// describe, listed in lib/events/index.js (D17): adding a kind never touches this file. Kinds read ROLLUPS only
// (results_daily, activity_daily) — never matches or the ledger.
//
// Windows are WHOLE UTC DAYS: starts_at and ends_at are midnights, ends_at exclusive, because
// results and activity are rolled up per UTC day and a window cutting a day in half could not
// be computed honestly.
//
// Lifecycle (the 5-min tick): scheduled → running at starts_at → finalising at ends_at + 10
// min (the last activity sync lands) → done, in the same tick when it can. `done` is ONE
// transaction: the state flip (an UPDATE that must change exactly one row), the ranked
// event_results, the reward points and the badges. So:
//   - rewards are paid at most once: a second finalise finds the state already `done` and
//     does nothing; the ledger rows also carry the unique ref `e:<id>` (uq_ledger_ref), and
//     event_results' primary key refuses a second row per address — three guards, not one;
//   - a cancelled event never pays: cancel and finalise both flip the state under the
//     transaction lock, and finalise only acts on `finalising`;
//   - a failed compute rolls back whole: the event stays `finalising` and the next tick
//     retries it.
// Cancelling a `done` event is refused: nothing is clawed back (use admin_adjust).
//
// Rewards are points + an optional badge, never GRIN (D1, D15), and exempt from the daily
// points cap (§19.6) — each event's own reward config is its bound.

const { HttpError, parseIntStrict } = require('./http');
const { maskAddr } = require('./mask');
const { MASK_ONLY } = require('./names');
const { utcDay } = require('./plays');
const { BADGES, isBadge, parseBadges, MAX_BADGES_PER_PLAYER } = require('./badges');
const { RulesError } = require('./events/_rules');
const KIND_MODULES = require('./events/index');

const DAY = 86400;
const GRACE_S = 10 * 60;             // §19.9: finalise at ends_at + 10 min
const MAX_EVENT_DAYS = 366;
const MAX_LEAD_DAYS = 366;           // an event may be scheduled at most this far ahead
const TITLE_MAX = 60;
const MAX_TIERS = 10;
const RANK_MAX = 1000;
const TIER_POINTS_MAX = 10000;
const PART_POINTS_MAX = 1000;
const MIN_VALUE_MAX = 1e9;
const CACHE_MS = 60 * 1000;
const CACHE_MAX = 64;
const PUBLIC_TOP = 50;
const PUBLIC_LIST_MAX = 50;
const PUBLIC_DONE_DAYS = 90;         // finished events stay in the public LIST this long
const ADMIN_LIST_MAX = 200;
const ADMIN_RESULTS_MAX = 1000;
const FINALISE_PER_TICK = 20;
const STATES = ['scheduled', 'running', 'finalising', 'done', 'cancelled'];
const BODY_KEYS = ['kind', 'title', 'starts_at', 'ends_at', 'rules', 'reward'];
// Control characters, bidi overrides/isolates and zero-width characters. Refused in a title
// (not stripped): the operator typed it and should see why it did not save.
const BAD_TITLE_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/;

// ── Kinds ─────────────────────────────────────────────────────────────────────────────
// The modules listed in lib/events/index.js. A malformed one refuses the start: kinds are
// our own code, shipped with the service, so a broken one is a build error, not a runtime
// condition to route around (unlike a game folder, which the registry skips).
function loadKinds(list = KIND_MODULES) {
  const kinds = new Map();
  for (const mod of list) {
    const kind = mod && mod.kind;
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(kind)) throw new Error('events: a kind module has no valid `kind`');
    for (const fn of ['validate', 'compute', 'describe', 'gameId']) {
      if (typeof mod[fn] !== 'function') throw new Error(`events: kind ${kind} has no ${fn}()`);
    }
    if (kinds.has(kind)) throw new Error(`events: kind ${kind} is listed twice`);
    kinds.set(kind, mod);
  }
  return kinds;
}

const dayStart = (t) => t - (((t % DAY) + DAY) % DAY);

function createEvents({ db, registry, ledger, sessions, admin, log, names = MASK_ONLY, now = () => Math.floor(Date.now() / 1000), clock = () => Date.now(), kinds = loadKinds() }) {
  const raw = db.raw;
  const cols = 'id, kind, title, game_id, starts_at, ends_at, rules_json, reward_json, state, created_by, created_at';
  const stmts = {
    get: raw.prepare(`SELECT ${cols} FROM events WHERE id = ?`),
    insert: raw.prepare(
      'INSERT INTO events (kind, title, game_id, starts_at, ends_at, rules_json, reward_json, state, created_by, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    update: raw.prepare(
      'UPDATE events SET kind = ?, title = ?, game_id = ?, starts_at = ?, ends_at = ?, rules_json = ?, reward_json = ?, state = ? ' +
      'WHERE id = ? AND state = ?'),
    setState: raw.prepare('UPDATE events SET state = ? WHERE id = ? AND state = ?'),
    // idx_events_state (state, ends_at)
    toRunning: raw.prepare("SELECT id FROM events WHERE state = 'scheduled' AND starts_at <= ?"),
    toFinalising: raw.prepare("SELECT id FROM events WHERE state = 'running' AND ends_at <= ?"),
    finalising: raw.prepare(`SELECT id FROM events WHERE state = 'finalising' ORDER BY ends_at LIMIT ${FINALISE_PER_TICK}`),
    publicLive: raw.prepare(`SELECT ${cols} FROM events WHERE state IN ('scheduled', 'running', 'finalising') ORDER BY starts_at, id LIMIT ${PUBLIC_LIST_MAX}`),
    publicPast: raw.prepare(`SELECT ${cols} FROM events WHERE state IN ('done', 'cancelled') AND ends_at >= ? ORDER BY ends_at DESC, id DESC LIMIT ${PUBLIC_LIST_MAX}`),
    adminList: raw.prepare(`SELECT ${cols} FROM events ORDER BY id DESC LIMIT ${ADMIN_LIST_MAX}`),
    adminListState: raw.prepare(`SELECT ${cols} FROM events WHERE state = ? ORDER BY id DESC LIMIT ${ADMIN_LIST_MAX}`),
    resultsTop: raw.prepare('SELECT address, value, rank, reward_points, badge FROM event_results WHERE event_id = ? ORDER BY rank LIMIT ?'),
    resultsOne: raw.prepare('SELECT address, value, rank, reward_points, badge FROM event_results WHERE event_id = ? AND address = ?'),
    resultsCount: raw.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(reward_points), 0) AS pts FROM event_results WHERE event_id = ?'),
    insertResult: raw.prepare(
      'INSERT INTO event_results (event_id, address, value, rank, reward_points, badge) VALUES (?, ?, ?, ?, ?, ?)'),
    banned: raw.prepare('SELECT banned_until FROM players WHERE address = ?'),
    badges: raw.prepare('SELECT badges_json FROM players WHERE address = ?'),
    setBadges: raw.prepare('UPDATE players SET badges_json = ? WHERE address = ?'),
  };
  const cache = new Map();   // event id → { at, rows } provisional standings

  // ── Rows ────────────────────────────────────────────────────────────────────────────
  function parse(row) {
    let rules, reward;
    try { rules = JSON.parse(row.rules_json); reward = JSON.parse(row.reward_json); } catch {
      log.error(`[events] event ${row.id} has unreadable rules/reward JSON`);
      throw new HttpError(500, 'internal');
    }
    return { ...row, rules, reward };
  }
  function load(id) {
    const row = stmts.get.get(id);
    return row ? parse(row) : null;
  }

  // UTC days covered, inclusive. `upTo` clips a live window at today.
  function daysOf(ev, upTo) {
    const fromDay = utcDay(ev.starts_at);
    let toDay = utcDay(ev.ends_at - 1);
    if (upTo !== undefined) { const d = utcDay(upTo); if (d < toDay) toDay = d; }
    return { fromDay, toDay };
  }

  // Compute + filter + rank. value DESC, then address ASC (§19.9's tie-break); a zero value is
  // not ranked; a banned address is not ranked. → [{ address, value, rank }]
  function standings(ev, t, upTo) {
    const kind = kinds.get(ev.kind);
    if (!kind) throw new Error(`events: event ${ev.id} has unknown kind ${ev.kind}`);
    const rows = kind.compute(db, ev, daysOf(ev, upTo));
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      if (!r || typeof r.address !== 'string' || seen.has(r.address)) continue;
      if (!Number.isSafeInteger(r.value) || r.value <= 0) continue;
      const p = stmts.banned.get(r.address);
      if (p && p.banned_until !== null && p.banned_until > t) continue;
      seen.add(r.address);
      out.push({ address: r.address, value: r.value });
    }
    out.sort((a, b) => (b.value - a.value) || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
    return out.map((r, i) => ({ ...r, rank: i + 1 }));
  }

  // The reward for one ranked row: the first tier whose range holds the rank, else the
  // participation reward if the value reaches it. A tier winner does not ALSO get the
  // participation reward.
  function rewardFor(reward, rank, value) {
    for (const tier of reward.tiers) {
      if (rank >= tier.rank_from && rank <= tier.rank_to) return { points: tier.points, badge: tier.badge };
    }
    const p = reward.participation;
    if (p && value >= p.min_value) return { points: p.points, badge: p.badge };
    return { points: 0, badge: null };
  }

  // Provisional standings for a running/finalising event, cached 60 s.
  function live(ev, t) {
    const hit = cache.get(ev.id);
    if (hit && clock() - hit.at < CACHE_MS) return hit.rows;
    if (cache.size >= CACHE_MAX) cache.clear();
    const rows = standings(ev, t, t);
    cache.set(ev.id, { at: clock(), rows });
    return rows;
  }

  // ── Validation ──────────────────────────────────────────────────────────────────────
  const bad = (field) => new HttpError(400, 'bad_request', { field });

  function validTitle(v) {
    if (typeof v !== 'string') throw bad('title');
    const s = v.normalize('NFC').replace(/ +/g, ' ').trim();
    if (s === '' || s.length > TITLE_MAX || BAD_TITLE_CHARS.test(s)) throw bad('title');
    return s;
  }

  function validReward(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw bad('reward');
    for (const k of Object.keys(r)) if (k !== 'tiers' && k !== 'participation') throw bad('reward');
    const tiersIn = r.tiers === undefined ? [] : r.tiers;
    if (!Array.isArray(tiersIn) || tiersIn.length > MAX_TIERS) throw bad('reward.tiers');
    const int = (v, min, max, field) => {
      if (!Number.isSafeInteger(v) || v < min || v > max) throw bad(field);
      return v;
    };
    const badge = (v, field) => {
      if (v === undefined || v === null || v === '') return null;
      if (!isBadge(v)) throw bad(field);
      return v;
    };
    const tiers = [];
    let lastTo = 0;
    for (const t of tiersIn) {
      if (!t || typeof t !== 'object' || Array.isArray(t)) throw bad('reward.tiers');
      for (const k of Object.keys(t)) if (!['rank_from', 'rank_to', 'points', 'badge'].includes(k)) throw bad('reward.tiers');
      const from = int(t.rank_from, 1, RANK_MAX, 'reward.tiers.rank_from');
      const to = int(t.rank_to, from, RANK_MAX, 'reward.tiers.rank_to');
      // In rank order and non-overlapping, so "the first tier that holds the rank" is also
      // the only one.
      if (from <= lastTo) throw bad('reward.tiers.rank_from');
      lastTo = to;
      tiers.push({ rank_from: from, rank_to: to, points: int(t.points, 0, TIER_POINTS_MAX, 'reward.tiers.points'), badge: badge(t.badge, 'reward.tiers.badge') });
    }
    let participation = null;
    if (r.participation !== undefined && r.participation !== null) {
      const p = r.participation;
      if (typeof p !== 'object' || Array.isArray(p)) throw bad('reward.participation');
      for (const k of Object.keys(p)) if (!['min_value', 'points', 'badge'].includes(k)) throw bad('reward.participation');
      participation = {
        min_value: int(p.min_value, 1, MIN_VALUE_MAX, 'reward.participation.min_value'),
        points: int(p.points, 0, PART_POINTS_MAX, 'reward.participation.points'),
        badge: badge(p.badge, 'reward.participation.badge'),
      };
    }
    return { tiers, participation };
  }

  function validRules(kindName, rules) {
    const kind = kinds.get(kindName);
    try {
      return kind.validate(rules === undefined ? {} : rules, { registry });
    } catch (e) {
      if (e instanceof RulesError) throw bad(e.field === 'rules' ? 'rules' : `rules.${e.field}`);
      throw e;
    }
  }

  // Window checks shared by create and update. `t` = now.
  function validWindow(startsAt, endsAt, t, { startFree }) {
    if (!Number.isSafeInteger(startsAt) || startsAt % DAY !== 0) throw bad('starts_at');
    if (!Number.isSafeInteger(endsAt) || endsAt % DAY !== 0) throw bad('ends_at');
    if (startFree) {
      if (startsAt < dayStart(t)) throw bad('starts_at');                 // no backdated events
      if (startsAt > dayStart(t) + MAX_LEAD_DAYS * DAY) throw bad('starts_at');
    }
    if (endsAt <= startsAt || endsAt - startsAt > MAX_EVENT_DAYS * DAY) throw bad('ends_at');
  }

  function body(ctx, required) {
    const b = ctx.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body');
    for (const k of Object.keys(b)) if (!BODY_KEYS.includes(k)) throw bad('body');
    if (required) for (const k of ['kind', 'title', 'starts_at', 'ends_at']) if (b[k] === undefined) throw bad(k);
    return b;
  }

  const stateAt = (startsAt, t) => (startsAt <= t ? 'running' : 'scheduled');
  const eventId = (ctx) => {
    const id = parseIntStrict(ctx.params.id, { min: 1 });
    if (id === null) throw new HttpError(404, 'not_found');
    return id;
  };

  // ── Views ───────────────────────────────────────────────────────────────────────────
  function rewardView(reward) {
    const b = (id) => (id ? { badge: id, badge_label: BADGES[id] || null } : { badge: null, badge_label: null });
    return {
      tiers: reward.tiers.map((t) => ({ rank_from: t.rank_from, rank_to: t.rank_to, points: t.points, ...b(t.badge) })),
      participation: reward.participation ? { min_value: reward.participation.min_value, points: reward.participation.points, ...b(reward.participation.badge) } : null,
    };
  }

  function publicEvent(ev) {
    const kind = kinds.get(ev.kind);
    const game = ev.game_id ? registry.get(ev.game_id) : null;
    let description = '';
    try { description = kind ? kind.describe(ev.rules, { registry }) : ''; } catch { description = ''; }
    return {
      id: ev.id,
      kind: ev.kind,
      kind_label: kind ? kind.label : ev.kind,
      title: ev.title,
      description,
      unit: kind ? (typeof kind.unitFor === 'function' ? kind.unitFor(ev.rules) : kind.unit) : null,
      game_id: ev.game_id,
      game_title: game ? game.manifest.title : null,
      rules: ev.rules,
      starts_at: ev.starts_at,
      ends_at: ev.ends_at,
      first_day: utcDay(ev.starts_at),
      last_day: utcDay(ev.ends_at - 1),
      finalises_at: ev.ends_at + GRACE_S,
      state: ev.state,
      reward: rewardView(ev.reward),
    };
  }

  // A cancelled event that never started was never announced as running: it stays out of
  // public view entirely.
  const isPublic = (ev, t) => ev.state !== 'cancelled' || ev.starts_at <= t;

  // ── Public handlers ─────────────────────────────────────────────────────────────────
  function listPublic() {
    const t = now();
    const live = stmts.publicLive.all().map(parse);
    const past = stmts.publicPast.all(t - PUBLIC_DONE_DAYS * DAY).map(parse).filter((ev) => isPublic(ev, t));
    return { ok: true, events: [...live, ...past].map(publicEvent) };
  }

  function getPublic(ctx) {
    const t = now();
    const ev = load(eventId(ctx));
    if (!ev || !isPublic(ev, t)) throw new HttpError(404, 'not_found');
    const s = sessions.lookup(ctx.cookies.grin_play);
    const me = s ? s.address : null;
    let standingsView = null;
    let you = null;
    if (ev.state === 'done') {
      const top = stmts.resultsTop.all(ev.id, PUBLIC_TOP);
      const n = stmts.resultsCount.get(ev.id).n;
      standingsView = {
        final: true,
        total: n,
        rows: top.map((r) => ({ rank: r.rank, name: names.label(r.address), value: r.value, reward_points: r.reward_points,
          badge: r.badge, badge_label: r.badge ? BADGES[r.badge] || null : null, ...(r.address === me ? { own: true } : {}) })),
      };
      if (me !== null) {
        const mine = stmts.resultsOne.get(ev.id, me);
        you = mine ? { rank: mine.rank, value: mine.value, reward_points: mine.reward_points, badge: mine.badge }
          : { rank: null, value: null, reward_points: 0, badge: null };
      }
    } else if (ev.state === 'running' || ev.state === 'finalising') {
      const rows = live(ev, t);
      standingsView = {
        final: false,
        total: rows.length,
        rows: rows.slice(0, PUBLIC_TOP).map((r) => ({ rank: r.rank, name: names.label(r.address), value: r.value, ...(r.address === me ? { own: true } : {}) })),
      };
      if (me !== null) {
        const mine = rows.find((r) => r.address === me);
        you = mine ? { rank: mine.rank, value: mine.value } : { rank: null, value: null };
      }
    }
    return { ok: true, event: publicEvent(ev), standings: standingsView, you };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────────────
  function appendBadge(address, badge, eventIdNum) {
    ledger.ensurePlayer(address);
    const cur = parseBadges(stmts.badges.get(address).badges_json);
    if (cur.some((b) => b.event === eventIdNum)) return;          // one badge per event per address
    if (cur.length >= MAX_BADGES_PER_PLAYER) {
      log.warn(`[events] ${maskAddr(address)} has ${cur.length} badges — event ${eventIdNum}'s is recorded in its results only`);
      return;
    }
    cur.push({ id: badge, event: eventIdNum });
    stmts.setBadges.run(JSON.stringify(cur), address);
  }

  // finalising → done. → { done, ranked, points } ; done=false when the event is not
  // `finalising` (already done, cancelled, …) — then NOTHING is written.
  function finalise(id, t = now()) {
    return db.transaction(() => {
      const ev = load(id);
      if (!ev || ev.state !== 'finalising') return { done: false, ranked: 0, points: 0 };
      const rows = standings(ev, t);
      if (stmts.setState.run('done', id, 'finalising').changes !== 1) throw new Error(`events: event ${id} changed under a held write lock`);
      let points = 0;
      for (const r of rows) {
        const rw = rewardFor(ev.reward, r.rank, r.value);
        stmts.insertResult.run(id, r.address, r.value, r.rank, rw.points, rw.badge);
        if (rw.points > 0) {
          const p = ledger.post({ address: r.address, kind: 'points', delta: rw.points, reason: 'event', ref: `e:${id}` });
          if (!p.duplicate) points += rw.points;
        }
        if (rw.badge) appendBadge(r.address, rw.badge, id);
      }
      cache.delete(id);
      return { done: true, ranked: rows.length, points };
    });
  }

  // The 5-min tick. Each transition is its own statement/transaction, so one broken event
  // cannot hold back the rest.
  function tick() {
    const t = now();
    let started = 0, closed = 0, finalised = 0, errors = 0;
    for (const { id } of stmts.toRunning.all(t)) started += stmts.setState.run('running', id, 'scheduled').changes;
    for (const { id } of stmts.toFinalising.all(t - GRACE_S)) closed += stmts.setState.run('finalising', id, 'running').changes;
    for (const { id } of stmts.finalising.all()) {
      try {
        const r = finalise(id, t);
        if (r.done) {
          finalised++;
          log.info(`[events] event ${id} finalised: ${r.ranked} ranked, ${r.points} point(s) paid`);
        }
      } catch (e) {
        errors++;
        log.error(`[events] finalising event ${id} failed (it stays finalising, retried next tick): ${e && e.message ? e.message : e}`);
      }
    }
    return { started, closed, finalised, errors };
  }

  // ── Admin handlers ──────────────────────────────────────────────────────────────────
  function adminEvent(ev) {
    const c = stmts.resultsCount.get(ev.id);
    return { ...publicEvent(ev), created_by: ev.created_by, created_at: ev.created_at, results: c.n, points_paid: c.pts };
  }

  function adminKinds() {
    return {
      ok: true,
      kinds: [...kinds.values()].map((k) => ({ kind: k.kind, label: k.label, unit: k.unit, fields: k.fields || [] })),
      badges: Object.entries(BADGES).map(([id, label]) => ({ id, label })),
      games: registry.list().map((g) => ({ id: g.id, title: g.title, modes: g.modes })),
      limits: { title_max: TITLE_MAX, max_days: MAX_EVENT_DAYS, max_tiers: MAX_TIERS, rank_max: RANK_MAX,
        tier_points_max: TIER_POINTS_MAX, participation_points_max: PART_POINTS_MAX, grace_s: GRACE_S },
    };
  }

  function adminList(ctx) {
    const st = ctx.query.getAll('state');
    if (st.length > 1 || (st.length === 1 && !STATES.includes(st[0]))) throw bad('state');
    const rows = st.length ? stmts.adminListState.all(st[0]) : stmts.adminList.all();
    return { ok: true, events: rows.map(parse).map(adminEvent) };
  }

  function adminGet(ctx) {
    const t = now();
    const ev = load(eventId(ctx));
    if (!ev) throw new HttpError(404, 'not_found');
    let results = [];
    let provisional = false;
    if (ev.state === 'done') {
      results = stmts.resultsTop.all(ev.id, ADMIN_RESULTS_MAX);
    } else if (ev.state === 'running' || ev.state === 'finalising') {
      provisional = true;
      // Fresh, not the public 60 s cache: the operator checking an event right after a
      // change should see it (and an admin read must not pin a stale board for players).
      results = standings(ev, t, t).slice(0, ADMIN_RESULTS_MAX).map((r) => {
        const rw = rewardFor(ev.reward, r.rank, r.value);
        return { address: r.address, value: r.value, rank: r.rank, reward_points: rw.points, badge: rw.badge };
      });
    }
    return { ok: true, event: adminEvent(ev), provisional, results };
  }

  function adminCreate(ctx) {
    const b = body(ctx, true);
    const t = now();
    if (typeof b.kind !== 'string' || !kinds.has(b.kind)) throw bad('kind');
    const title = validTitle(b.title);
    validWindow(b.starts_at, b.ends_at, t, { startFree: true });
    const rules = validRules(b.kind, b.rules);
    const reward = validReward(b.reward === undefined ? {} : b.reward);
    const gameId = kinds.get(b.kind).gameId(rules) || null;
    const id = db.transaction(() => {
      const r = stmts.insert.run(b.kind, title, gameId, b.starts_at, b.ends_at, JSON.stringify(rules), JSON.stringify(reward),
        stateAt(b.starts_at, t), ctx.admin.user, t);
      const newId = Number(r.lastInsertRowid);
      admin.audit(ctx, 'event_create', `event:${newId}`, { kind: b.kind, title, starts_at: b.starts_at, ends_at: b.ends_at });
      return newId;
    });
    return { ok: true, event: adminEvent(load(id)) };
  }

  // scheduled: everything may change. running: title, ends_at and reward only — kind, rules
  // and starts_at are what players are already competing on, so changing them is refused
  // (sending them UNCHANGED is fine: the form posts every field). Later states: refused.
  function adminUpdate(ctx) {
    const id = eventId(ctx);
    const b = body(ctx, false);
    const t = now();
    const out = db.transaction(() => {
      const ev = load(id);
      if (!ev) throw new HttpError(404, 'not_found');
      if (ev.state !== 'scheduled' && ev.state !== 'running') throw new HttpError(409, 'not_editable');
      const kind = b.kind === undefined ? ev.kind : b.kind;
      if (typeof kind !== 'string' || !kinds.has(kind)) throw bad('kind');
      const rules = b.rules === undefined && kind === ev.kind ? ev.rules : validRules(kind, b.rules);
      const startsAt = b.starts_at === undefined ? ev.starts_at : b.starts_at;
      const endsAt = b.ends_at === undefined ? ev.ends_at : b.ends_at;
      const title = b.title === undefined ? ev.title : validTitle(b.title);
      const reward = b.reward === undefined ? ev.reward : validReward(b.reward);
      if (ev.state === 'running') {
        if (kind !== ev.kind) throw new HttpError(409, 'not_editable', { field: 'kind' });
        if (JSON.stringify(rules) !== JSON.stringify(ev.rules)) throw new HttpError(409, 'not_editable', { field: 'rules' });
        if (startsAt !== ev.starts_at) throw new HttpError(409, 'not_editable', { field: 'starts_at' });
        validWindow(startsAt, endsAt, t, { startFree: false });
        // A running event may be shortened, but not to a day that is already over.
        if (endsAt < dayStart(t)) throw bad('ends_at');
      } else {
        validWindow(startsAt, endsAt, t, { startFree: startsAt !== ev.starts_at });
      }
      const state = ev.state === 'scheduled' ? stateAt(startsAt, t) : ev.state;
      const gameId = kinds.get(kind).gameId(rules) || null;
      const r = stmts.update.run(kind, title, gameId, startsAt, endsAt, JSON.stringify(rules), JSON.stringify(reward), state, id, ev.state);
      if (r.changes !== 1) throw new Error(`events: event ${id} changed under a held write lock`);
      const changed = ['kind', 'title', 'starts_at', 'ends_at', 'rules', 'reward'].filter((k) => {
        const before = { kind: ev.kind, title: ev.title, starts_at: ev.starts_at, ends_at: ev.ends_at, rules: ev.rules, reward: ev.reward }[k];
        const after = { kind, title, starts_at: startsAt, ends_at: endsAt, rules, reward }[k];
        return JSON.stringify(before) !== JSON.stringify(after);
      });
      admin.audit(ctx, 'event_update', `event:${id}`, { changed, state });
      return id;
    });
    cache.delete(out);
    return { ok: true, event: adminEvent(load(out)) };
  }

  function adminCancel(ctx) {
    const id = eventId(ctx);
    const b = ctx.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body');
    for (const k of Object.keys(b)) if (k !== 'reason') throw bad('body');
    if (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > 200 || BAD_TITLE_CHARS.test(b.reason))) throw bad('reason');
    db.transaction(() => {
      const ev = load(id);
      if (!ev) throw new HttpError(404, 'not_found');
      if (!['scheduled', 'running', 'finalising'].includes(ev.state)) throw new HttpError(409, 'not_cancellable');
      if (stmts.setState.run('cancelled', id, ev.state).changes !== 1) throw new Error(`events: event ${id} changed under a held write lock`);
      admin.audit(ctx, 'event_cancel', `event:${id}`, { from_state: ev.state, reason: b.reason || null });
    });
    cache.delete(id);
    return { ok: true, event: adminEvent(load(id)) };
  }

  // Skips the 10-min grace (and retries a stuck finalise). Only once the window is over:
  // finalising early would rank a competition that is still going.
  function adminFinalise(ctx) {
    const id = eventId(ctx);
    const b = ctx.body;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length) throw bad('body');
    const t = now();
    const r = db.transaction(() => {
      const ev = load(id);
      if (!ev) throw new HttpError(404, 'not_found');
      if (ev.state === 'done' || ev.state === 'cancelled') throw new HttpError(409, 'not_editable');
      if (ev.state === 'scheduled' || t < ev.ends_at) throw new HttpError(409, 'not_ended');
      if (ev.state === 'running' && stmts.setState.run('finalising', id, 'running').changes !== 1) throw new Error(`events: event ${id} changed under a held write lock`);
      const res = finalise(id, t);
      admin.audit(ctx, 'event_finalise', `event:${id}`, { ranked: res.ranked, points: res.points });
      return res;
    });
    log.info(`[events] event ${id} finalised by ${ctx.admin.user}: ${r.ranked} ranked, ${r.points} point(s) paid`);
    return { ok: true, event: adminEvent(load(id)), ranked: r.ranked, points: r.points };
  }

  if (admin) {
    admin.add('GET', 'event-kinds', adminKinds);
    admin.add('GET', 'events', adminList);
    admin.add('POST', 'events', adminCreate);
    admin.add('GET', 'events/:id', adminGet);
    admin.add('POST', 'events/:id', adminUpdate);
    admin.add('POST', 'events/:id/cancel', adminCancel, { bodyLimit: 1024 });
    admin.add('POST', 'events/:id/finalise', adminFinalise, { bodyLimit: 1024 });
  }

  return {
    routes: [
      ['GET', '/play/api/events', listPublic],
      ['GET', '/play/api/events/:id', getPublic],
    ],
    tick,
    finalise,
    kinds,
    _internal: { standings, rewardFor, validReward, cache },
  };
}

module.exports = { createEvents, loadKinds, GRACE_S, MAX_EVENT_DAYS, TITLE_MAX, PUBLIC_TOP, dayStart };
