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

const REFRESH_MS = 60 * 1000;
const STALE_MAX_MS = 10 * 60 * 1000;

function createModeCache({ poolLink, log, clock = () => Date.now(), refreshMs = REFRESH_MS, staleMaxMs = STALE_MAX_MS }) {
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
      log.info(`[mode] games mode is now ${e.mode}, chat ${e.chat_enabled ? 'enabled' : 'disabled'}`);
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

module.exports = { createModeCache, REFRESH_MS, STALE_MAX_MS };
