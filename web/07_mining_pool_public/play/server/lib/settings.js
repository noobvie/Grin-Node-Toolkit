'use strict';

// Games-owned settings (design §19.6, §19.10, §19.11) — the `settings` table of
// grinium-games.db. These are the GAMES' knobs (plays rate, caps, chat gates); the
// switches the POOL owns (games.mode, chat_enabled) are not here — they come from the pool
// over the link (lib/mode.js).
//
// Every key is declared in SPEC with its type, default and bounds. A key that is not in
// SPEC can be neither read nor written, and a stored value that no longer validates (a
// hand edit, a bound tightened by a later build) reads as the DEFAULT with one warning —
// never as the bad value. Values are stored as JSON text, typed on the way out: a quoted
// "false" is a string, and a string is never a boolean here (memory
// project_config_loader_type_traps).
//
// Writes come from the admin proxy (Part 9); Part 4 only reads. A change applies from the
// next read — the 30 s memo bounds how stale a read can be — and never recomputes the past
// (§19.6).

const DAY = 86400;

// type: 'int' (safe integer in [min, max]) | 'bool'
const SPEC = Object.freeze({
  // §19.6 plays
  minutes_per_play:       { type: 'int', def: 10,  min: 1, max: 1440 },
  plays_daily_cap:        { type: 'int', def: 24,  min: 1, max: 1440 },
  plays_balance_cap:      { type: 'int', def: 100, min: 1, max: 10000 },
  // §19.5 / D9 chat gate. The 1 h FLOOR is not this setting: it is CHAT_MIN_AGE_FLOOR in
  // sessions.js, applied on top, so lowering this setting can never remove it.
  chat_min_proof_age:     { type: 'int', def: DAY, min: 0, max: 30 * DAY },
  chat_requires_password: { type: 'bool', def: false },
  // §19.6 spending + points (Part 5). 0 makes bot games free — and a free game pays no
  // points (matches.js pointsFor, §19.15 Part 5).
  bot_play_cost:          { type: 'int', def: 1,   min: 0, max: 10 },
  points_daily_cap:       { type: 'int', def: 100, min: 0, max: 100000 },
  // §19.6 / §19.8 PvP (Part 10). Each side pays pvp_play_cost (the creator at create, the
  // acceptor at accept); 0 makes PvP free, and a free match pays no points (as a free bot
  // game). pair_rated_daily 0 = no PvP match is rated (no ratings move, no PvP points).
  pvp_play_cost:          { type: 'int', def: 1,   min: 0, max: 10 },
  pvp_active_max:         { type: 'int', def: 10,  min: 1, max: 50 },
  pvp_open_max:           { type: 'int', def: 5,   min: 1, max: 20 },
  pair_rated_daily:       { type: 'int', def: 3,   min: 0, max: 20 },
  // §19.10 chat (Part 8). The fixed floors — 5 s between one address's posts, 60 posts an
  // hour per IP, the 24 h cap on a moderator's mute — are constants in chat.js, not here.
  chat_min_minutes:       { type: 'int', def: 60,  min: 0, max: 10080 },   // 0 = no mining gate
  chat_recent_days:       { type: 'int', def: 7,   min: 1, max: 30 },
  chat_posts_per_hour:    { type: 'int', def: 30,  min: 1, max: 60 },
  chat_slow_seconds:      { type: 'int', def: 0,   min: 0, max: 3600 },    // 0 = slow mode off
  chat_hold_links:        { type: 'bool', def: true },
  chat_report_threshold:  { type: 'int', def: 3,   min: 1, max: 50 },
  chat_retention_days:    { type: 'int', def: 7,   min: 1, max: 30 },
  chat_retention_max:     { type: 'int', def: 2000, min: 100, max: 20000 },
  // D21: a moderator acts only from a session opened with the rig PASSWORD proof (an IP
  // proof can be a CGNAT neighbour, §19.13 #7), unless the operator turns this off.
  mod_requires_password:  { type: 'bool', def: true },
  // §19.16 (Part 12) approved nicknames. Off = no new submissions AND every surface shows the
  // bare mask again (nothing is deleted; turning it back on restores the approved names).
  nicknames_enabled:      { type: 'bool', def: true },
});

const MEMO_MS = 30 * 1000;

function validate(key, value) {
  const s = SPEC[key];
  if (!s) return { ok: false, why: 'unknown key' };
  if (s.type === 'int') {
    if (!Number.isSafeInteger(value) || value < s.min || value > s.max) return { ok: false, why: `must be an integer ${s.min}-${s.max}` };
    return { ok: true, value };
  }
  if (s.type === 'bool') {
    if (value !== true && value !== false) return { ok: false, why: 'must be true or false' };
    return { ok: true, value };
  }
  return { ok: false, why: 'bad spec' };
}

function createSettings({ db, log, clock = () => Date.now() }) {
  let memo = null;
  let memoAt = -Infinity;
  const warned = new Set();

  function load() {
    const out = {};
    for (const [k, s] of Object.entries(SPEC)) out[k] = s.def;
    const rows = db.raw.prepare('SELECT key, value FROM settings').all();
    for (const r of rows) {
      if (!Object.prototype.hasOwnProperty.call(SPEC, r.key)) continue;   // a later build's key, or junk
      let v;
      try { v = JSON.parse(r.value); } catch { v = undefined; }
      const res = validate(r.key, v);
      if (res.ok) { out[r.key] = res.value; continue; }
      if (!warned.has(r.key)) {
        warned.add(r.key);
        log.warn(`[settings] stored ${r.key} is invalid (${res.why}) — using the default ${JSON.stringify(SPEC[r.key].def)}`);
      }
    }
    return Object.freeze(out);
  }

  function all() {
    const t = clock();
    if (!memo || t - memoAt >= MEMO_MS) { memo = load(); memoAt = t; }
    return memo;
  }

  function get(key) {
    if (!Object.prototype.hasOwnProperty.call(SPEC, key)) throw new Error(`settings: unknown key ${key}`);
    return all()[key];
  }

  // set(key, value, by) — validated; throws on a bad key or value. Clears the memo.
  function set(key, value, by = null) {
    const res = validate(key, value);
    if (!res.ok) throw new Error(`settings: ${key} ${res.why}`);
    db.raw.prepare(
      'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
    ).run(key, JSON.stringify(res.value), Math.floor(clock() / 1000), by);
    memo = null;
    warned.delete(key);
  }

  // setMany({ key: value, … }, by) — every value validated FIRST, then all written in one
  // transaction: a form save never lands half. → the keys whose value changed. Throws
  // { field } on the first bad key or value, having written nothing.
  function setMany(values, by = null) {
    const checked = [];
    for (const [k, v] of Object.entries(values)) {
      const res = validate(k, v);
      if (!res.ok) { const e = new Error(`settings: ${k} ${res.why}`); e.field = k; throw e; }
      checked.push([k, res.value]);
    }
    const before = all();
    const changed = checked.filter(([k, v]) => before[k] !== v).map(([k]) => k);
    db.transaction(() => { for (const [k, v] of checked) set(k, v, by); });
    return changed;
  }

  // Who changed what, when — for the admin form.
  function meta() {
    const out = {};
    for (const r of db.raw.prepare('SELECT key, updated_at, updated_by FROM settings').all()) {
      if (Object.prototype.hasOwnProperty.call(SPEC, r.key)) out[r.key] = { updated_at: r.updated_at, updated_by: r.updated_by };
    }
    return out;
  }

  return { get, all, set, setMany, meta, invalidate: () => { memo = null; } };
}

module.exports = { createSettings, SPEC, validate };
