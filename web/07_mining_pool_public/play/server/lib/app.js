'use strict';

// App assembly: routes, the HTTP server, graceful shutdown. index.js only wires these to
// the process (env, signals, exit codes), so the tests exercise the real pieces without
// booting the service.

const http = require('node:http');
const { createRouter, createRequestHandler, HttpError, sameOriginOk } = require('./http');
const { createPoolLink } = require('./pool-link');
const { createSettings } = require('./settings');
const { createLedger } = require('./ledger');
const { createSessions, CHAT_MIN_AGE_FLOOR } = require('./sessions');
const { createModeCache } = require('./mode');
const { createActivitySync } = require('./plays');
const { createAuth } = require('./auth');
const { loadGames } = require('./registry');
const { createMatches } = require('./matches');
const { createAdmin } = require('./admin');
const { createLeaderboard } = require('./leaderboard');
const { createEvents } = require('./events');
const { createChat } = require('./chat');
const { createModeration } = require('./moderation');
const { createNames } = require('./names');

// mod_actions is kept a year (§19.10), then dropped by the hourly tier.
const MOD_ACTIONS_KEEP_S = 365 * 86400;

// poolLink / mode / registry may be passed in (tests stub the pool and plant games);
// otherwise they are built from config. Nothing here calls the pool until start() or a
// request. The registry loads the game folders once, at build time (§19.7).
function buildApp({ config, db, log, startedAt = Date.now(), clock = () => Date.now(), poolLink, mode, registry }) {
  const router = createRouter();
  let shuttingDown = false;
  const nowS = () => Math.floor(clock() / 1000);

  const link = poolLink || createPoolLink({ config, clock });
  const modeCache = mode || createModeCache({ poolLink: link, log, clock });
  const settings = createSettings({ db, log, clock });
  const ledger = createLedger({ db, now: nowS });
  const sessions = createSessions({ db, settings, now: nowS });
  const activity = createActivitySync({ db, poolLink: link, ledger, settings, log, now: nowS });
  const auth = createAuth({ config, db, sessions, settings, poolLink: link, mode: modeCache, log, clock });
  const games = registry || loadGames({ gamesDir: config.gamesDir, log });
  // Admin routes (/internal/admin/*) register themselves on the router through admin.add(),
  // behind the link-secret guard — never through publicRoute() below.
  const admin = createAdmin({ router, poolLink: link, db, now: nowS });
  // Approved nicknames (§19.16): every public name below goes through names.label. The word
  // list is chat's; it is read at queue time, after `chat` exists.
  const names = createNames({ db, auth, sessions, settings, admin, ledger, config, words: () => chat.words(), now: nowS });
  auth.setNames(names);
  const matches = createMatches({ db, registry: games, ledger, settings, sessions, auth, admin, config, log, names, now: nowS });
  const leaderboard = createLeaderboard({ db, registry: games, sessions, names, now: nowS, clock });
  const events = createEvents({ db, registry: games, ledger, sessions, admin, log, names, now: nowS, clock });
  const chat = createChat({ db, sessions, settings, auth, mode: modeCache, log, names, now: nowS });
  const moderation = createModeration({ db, chat, sessions, settings, auth, admin, ledger, log, config, names, now: nowS });

  // The live rules a player can see (§19.15 Part 6 #10): how plays are earned and what chat
  // asks for. Settings only — nothing per player, nothing the operator would not publish.
  function rules() {
    const v = settings.all();
    return {
      ok: true,
      plays: { minutes_per_play: v.minutes_per_play, daily_cap: v.plays_daily_cap, balance_cap: v.plays_balance_cap, bot_play_cost: v.bot_play_cost, pvp_play_cost: v.pvp_play_cost },
      pvp: { pair_rated_daily: v.pair_rated_daily, active_max: v.pvp_active_max, open_max: v.pvp_open_max },
      points: { daily_cap: v.points_daily_cap },
      chat: {
        enabled: modeCache.get().chat_enabled === true,
        min_minutes: v.chat_min_minutes, recent_days: v.chat_recent_days,
        min_proof_age_s: Math.max(CHAT_MIN_AGE_FLOOR, v.chat_min_proof_age),
        requires_password: v.chat_requires_password, hold_links: v.chat_hold_links,
        slow_seconds: v.chat_slow_seconds, posts_per_hour: v.chat_posts_per_hour, retention_days: v.chat_retention_days,
      },
    };
  }

  // Every PUBLIC route except health goes through this (§19.5, D12):
  //   - mode 'off' → 404, as if /play/ did not exist. Nothing public is served on a guess:
  //     until the pool has answered once, and after 10 min without an answer, the mode is off.
  //   - a write must be same-origin (CSRF layer 3; layers 1–2 are SameSite=Strict and the JSON
  //     content type, enforced by the cookie and http.js).
  // Admin routes (/internal/admin/*, Part 7+) do NOT use this: they are gated by the link
  // secret and must keep working while the games are off, so the operator can prepare them.
  function publicRoute(method, pattern, handler, opts) {
    router.add(method, pattern, (ctx) => {
      if (modeCache.isOff()) throw new HttpError(404, 'not_found');
      if (method !== 'GET' && !sameOriginOk(ctx.req)) throw new HttpError(403, 'cross_origin');
      return handler(ctx);
    }, opts);
  }
  for (const [method, pattern, handler, opts] of [...auth.routes, ...matches.routes, ...leaderboard.routes, ...events.routes, ...chat.routes, ...moderation.routes, ...names.routes, ['GET', '/play/api/rules', rules]]) {
    publicRoute(method, pattern, handler, opts);
  }

  // The pool's probe target (§19.3): { ok, net, schema, uptime_s } — no secrets, no counts.
  // It reads the schema version live, so a DB that stopped answering reports unhealthy
  // (503) instead of a cached "fine". It stays up whatever the games mode is (§19.3, D12).
  router.add('GET', '/play/api/health', () => {
    let schema;
    try { schema = db.schemaVersion(); } catch { throw new HttpError(503, 'db_unavailable'); }
    return {
      ok: true,
      net: config.net,
      schema,
      uptime_s: Math.max(0, Math.floor((clock() - startedAt) / 1000)),
    };
  });

  const handler = createRequestHandler({ router, log, isShuttingDown: () => shuttingDown });

  // Maintenance jobs owned by this part (§19.12). Later parts register theirs the same way.
  function registerJobs(maintenance) {
    maintenance.register('activity_sync', async () => {
      const r = await activity.syncOnce();
      if (r.stopped && r.stopped !== 'link_not_configured') {
        log.warn(`[plays] sync stopped early: ${r.stopped} (${r.windows} window(s) done) — retrying next tick`);
      }
      if (r.windows || r.skipped) {
        log.info(`[plays] synced ${r.windows} window(s), skipped ${r.skipped}, ${r.plays} play(s) to ${r.credited} address(es)`);
      }
    }, { tier: '5m', budgetMs: 15000 });
    maintenance.register('session_purge', () => {
      const n = sessions.purge();
      if (n) log.info(`[sessions] purged ${n} expired/revoked session(s)`);
    }, { tier: '1h' });
    maintenance.register('limiter_sweep', () => { auth.sweep(); }, { tier: '1h' });
    maintenance.register('ledger_verify', () => {
      const drift = ledger.verify();
      // Logged, never fixed (§19.6): a "repair" would hide the bug that caused it.
      for (const d of drift.slice(0, 20)) {
        log.error(`[ledger] DRIFT ${d.kind} ${d.address}: balance ${d.balance} vs ledger ${d.ledger}`);
      }
      if (drift.length > 20) log.error(`[ledger] DRIFT … and ${drift.length - 20} more`);
    }, { tier: '1h', budgetMs: 5000 });
    maintenance.register('match_timeouts', () => {
      const r = matches.sweepTimeouts();
      if (r.finalised || r.errors) log.info(`[matches] timeouts: ${r.finalised} finalised, ${r.errors} failed`);
    }, { tier: '5m' });
    maintenance.register('bot_moves_purge', () => {
      const r = matches.purgeBotMoves();
      if (r.purged) log.info(`[matches] purged ${r.purged} bot move row(s), through match ${r.through}`);
    }, { tier: '1h' });
    // After activity_sync in the same tier, so a window that just closed is already synced
    // when its event finalises.
    maintenance.register('event_transitions', () => {
      const r = events.tick();
      if (r.started || r.closed || r.errors) log.info(`[events] ${r.started} started, ${r.closed} closed, ${r.finalised} finalised, ${r.errors} failed`);
    }, { tier: '5m' });
    maintenance.register('chat_retention', () => {
      const n = chat.purgeRetention();
      if (n) log.info(`[chat] retention removed ${n} message(s)`);
    }, { tier: '1h' });
    maintenance.register('nickname_purge', () => {
      const n = names.purge();
      if (n) log.info(`[names] purged ${n} decided nickname row(s) older than 180 days`);
    }, { tier: '1h' });
    maintenance.register('mod_actions_purge', () => {
      const n = db.raw.prepare('DELETE FROM mod_actions WHERE created_at < ?').run(nowS() - MOD_ACTIONS_KEEP_S).changes;
      if (n) log.info(`[admin] purged ${n} mod_actions row(s) older than 365 days`);
    }, { tier: '1h' });
  }

  return {
    router,
    handler,
    markShuttingDown: () => { shuttingDown = true; },
    registerJobs,
    start: () => modeCache.start(),
    stop: () => modeCache.stop(),
    services: { poolLink: link, mode: modeCache, settings, ledger, sessions, activity, auth, games, matches, admin, leaderboard, events, chat, moderation, names },
  };
}

function createServer(handler) {
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, handler);
  // nginx fronts every request, so these only bound a local caller or a stuck upstream
  // connection; none of our requests needs anywhere near them.
  server.headersTimeout = 10 * 1000;
  server.requestTimeout = 15 * 1000;
  server.keepAliveTimeout = 5 * 1000;
  server.maxHeadersCount = 64;
  return server;
}

// Loopback only (§19.2, D2). The bound address is read back and checked, rather than
// trusting what was asked for.
function listen(server, port, host) {
  if (host !== '127.0.0.1' && host !== '::1') return Promise.reject(new Error(`refusing to bind non-loopback ${host}`));
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => {
      server.removeListener('error', onError);
      const addr = server.address();
      if (!addr || addr.address !== host) {
        server.close();
        reject(new Error(`bound ${addr && addr.address} instead of ${host}`));
        return;
      }
      resolve(addr);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// Stop accepting, let in-flight requests finish (graceMs cap, §19 Part 1: 5 s), then stop
// maintenance and close the DB. New requests on a kept-alive socket get 503 + close.
function shutdown({ server, app, maintenance, db, log, graceMs = 5000 }) {
  app.markShuttingDown();
  if (typeof app.stop === 'function') app.stop();
  return new Promise((resolve) => {
    let forced = false;
    const force = setTimeout(() => {
      forced = true;
      log.warn(`[shutdown] requests still open after ${graceMs}ms — closing their connections`);
      server.closeAllConnections();
    }, graceMs);
    force.unref();
    server.close(async () => {
      clearTimeout(force);
      // A maintenance job mid-await gets the rest of the grace period, not forever.
      await Promise.race([
        maintenance ? maintenance.stop() : Promise.resolve(),
        new Promise((r) => setTimeout(r, graceMs).unref()),
      ]);
      try { db.close(); } catch (e) { log.warn(`[shutdown] db close: ${e.message}`); }
      resolve({ forced });
    });
    server.closeIdleConnections();
  });
}

module.exports = { buildApp, createServer, listen, shutdown };
