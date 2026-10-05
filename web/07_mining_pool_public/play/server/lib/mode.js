'use strict';

// The pool's master switch, as the games service sees it (design D12, §19.2).
//
// games.mode (off | preview | on) and chat_enabled are POOL settings: the operator sets them
// in the pool admin panel, and this service fetches them from GET /internal/games/config
// every 60 s. Rules:
//   - Until the first successful fetch the mode is 'off'. Nothing public is served on a guess.
//   - When a fetch fails, the LAST KNOWN value is kept for ≤ 10 min, then the mode reads as
//     'off'. (The sketch had "link down = off", which would take /play/ offline for every
//     pool restart; §19.2 refined it.)
//   - A request never waits for the pool: get() reads the cache, and the refresh runs on its
//     own unref'd timer. refresh() is single-flight — a slow pool never stacks up calls.
//   - Only transitions are logged, so a pool that is down for an hour is one line, not sixty.

const { HttpError } = require('./http');

const REFRESH_MS = 60 * 1000;
const STALE_MAX_MS = 10 * 60 * 1000;

// onConfig(c) is handed every successful answer (the name lists ride on the same fetch, §19.17.5
// — no second call); it must not throw, and a throw is caught so it can never stale the mode.
function createModeCache({ poolLink, log, clock = () => Date.now(), refreshMs = REFRESH_MS, staleMaxMs = STALE_MAX_MS, onConfig = null }) {
  let last = null;          // { mode, chat_enabled } from the last successful fetch
  let lastOkAt = -Infinity;
  let failing = null;       // the error code while fetches fail, for transition logging
  let inflight = null;
  let timer = null;
  let reported = null;      // the effective mode last logged

  function effective() {
    if (last && clock() - lastOkAt <= staleMaxMs) return last;
    return { mode: 'off', chat_enabled: false };
  }

  function logTransition() {
    const e = effective();
    const key = `${e.mode}/${e.chat_enabled ? 'chat' : 'nochat'}`;
    if (key !== reported) {
      // The POOL's switch as this cache holds it — not the effective mode, which the launch
      // state (below) may lower; the admin Overview shows both.
      log.info(`[mode] the pool's games mode is now ${e.mode}, chat ${e.chat_enabled ? 'enabled' : 'disabled'}`);
      reported = key;
    }
  }

  function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const c = await poolLink.config();
        last = { mode: c.mode, chat_enabled: c.chat_enabled };
        lastOkAt = clock();
        if (failing) { log.info(`[mode] pool link recovered (was ${failing})`); failing = null; }
        if (onConfig) {
          try { onConfig(c); } catch (e) { log.warn(`[mode] config consumer failed: ${e && e.message}`); }
        }
      } catch (e) {
        const code = (e && e.code) || 'error';
        if (failing !== code) {
          const kept = last && clock() - lastOkAt <= staleMaxMs;
          log.warn(`[mode] cannot read the games mode from the pool (${code}) — ${kept ? `keeping ${last.mode} for up to ${Math.round(staleMaxMs / 60000)} min` : 'treating it as off'}`);
          failing = code;
        }
      } finally {
        inflight = null;
        logTransition();
      }
    })();
    return inflight;
  }

  function start() {
    if (timer) return;
    refresh();
    timer = setInterval(() => { refresh(); }, refreshMs);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    get: effective,
    isOff: () => effective().mode === 'off',
    refresh,
    start,
    stop,
  };
}

// ── Launch state + the effective mode (design §19.17.2, D30) ─────────────────────────────
// The pool's switch now defaults to 'on', so a second switch, owned by THIS service, keeps a
// fresh install hidden until the operator has tried it: meta.launch in grinium-games.db,
// 'preview' | 'on'. A fresh DB writes 'preview' (db.js, v1); an absent key or any value other
// than the exact string 'on' reads as 'preview'. There is no 'off' launch value — off is the
// pool's. It lives in the DB, so a restored backup keeps its launch state.
//
//   effective = min(pool mode, launch)   with off < preview < on
//
// Every public route gates on the effective mode (app.js publicRoute), health reports the
// launch state so the pool can compute the same answer for its nav (lib/games-link.js), and
// admin routes stay outside both — they must work in every state.

const LAUNCH_STATES = ['preview', 'on'];
const RANK = { off: 0, preview: 1, on: 2 };

function effectiveMode(poolMode, launch) {
  const p = Object.prototype.hasOwnProperty.call(RANK, poolMode) ? poolMode : 'off';
  const l = launch === 'on' ? 'on' : 'preview';
  return RANK[p] <= RANK[l] ? p : l;
}

// createLaunchState({ db, admin?, poolMode? }) — get() reads meta.launch; when `admin` is
// given, the two admin routes below are registered on it. poolMode() is the cached pool answer
// (createModeCache().get), shown on the admin Overview beside the launch state.
function createLaunchState({ db, admin, poolMode = () => ({ mode: 'off', chat_enabled: false }) }) {
  const readStmt = db.raw.prepare("SELECT value FROM meta WHERE key = 'launch'");
  const writeStmt = db.raw.prepare(
    "INSERT INTO meta (key, value) VALUES ('launch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  // Read live (one meta row by primary key), never cached: a restore or a second admin tab
  // must never leave this process answering with a state the DB no longer holds.
  const get = () => {
    const row = readStmt.get();
    return row && row.value === 'on' ? 'on' : 'preview';
  };
  const bad = (field) => new HttpError(400, 'bad_request', { field });

  // The Overview card: the launch state, the pool's mode as this service last read it, and
  // the result. pool_mode 'off' while the pool has not answered for > 10 min (or ever).
  function view(extra) {
    const p = poolMode();
    const launch = get();
    const effective = effectiveMode(p.mode, launch);
    return { ok: true, launch, pool_mode: p.mode, pool_chat: p.chat_enabled === true, effective, ...extra };
  }

  if (admin) {
    admin.add('GET', 'launch', () => view());
    // Go live / Back to preview. Step-up (it is not one of the six FAST writes), one
    // mod_actions row per real change, idempotent: the same state is 200 and writes no row.
    admin.add('POST', 'launch', (ctx) => {
      const b = ctx.body;
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('state');
      for (const k of Object.keys(b)) if (k !== 'state') throw bad(k);
      if (typeof b.state !== 'string' || !LAUNCH_STATES.includes(b.state)) throw bad('state');
      const changed = db.transaction(() => {
        const from = get();
        if (from === b.state) return false;
        writeStmt.run(b.state);
        admin.audit(ctx, 'launch', 'launch', { from, to: b.state });
        return true;
      });
      return view({ changed });
    }, { bodyLimit: 256 });
  }

  return { get };
}

// Wraps the pool-mode cache so every consumer (publicRoute, auth.chatStatus, chat.read, the
// rules) sees the EFFECTIVE mode through the same { get, isOff } it always used. pool() is the
// raw cached pool answer, for the admin Overview.
function withLaunch(modeCache, launchState) {
  function get() {
    const p = modeCache.get();
    const mode = effectiveMode(p.mode, launchState.get());
    return { mode, chat_enabled: mode !== 'off' && p.chat_enabled === true };
  }
  return {
    get,
    isOff: () => get().mode === 'off',
    pool: () => modeCache.get(),
    launch: () => launchState.get(),
    refresh: () => modeCache.refresh(),
    start: () => modeCache.start(),
    stop: () => modeCache.stop(),
  };
}

module.exports = { createModeCache, createLaunchState, withLaunch, effectiveMode, LAUNCH_STATES, REFRESH_MS, STALE_MAX_MS };
