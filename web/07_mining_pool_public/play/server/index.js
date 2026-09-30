'use strict';

// grin-games — the pool's games service (design §19). A separate process, OS user and
// database from the pool, so nothing here can slow, restart or endanger mining (§19.2).
//
// Boot order: Node version → config → database (open + migrate) → routes → listen on
// 127.0.0.1 → maintenance timers. Any failure before listening exits non-zero with one
// line saying why; systemd restarts only this unit.
//
// Exit codes: 0 clean shutdown · 1 runtime/boot failure · 78 (EX_CONFIG) bad
// configuration — a restart cannot fix that one, so the unit should not loop on it
// (RestartPreventExitStatus=78, Part 3).

const { createLogger } = require('./lib/log');
const { loadConfig, ConfigError } = require('./lib/config');
const { openDb } = require('./lib/db');
const { buildApp, createServer, listen, shutdown } = require('./lib/app');
const { createMaintenance } = require('./lib/maintenance');

const EX_CONFIG = 78;

function main() {
  const log = createLogger();

  const major = Number(process.versions.node.split('.')[0]);
  if (!(major >= 24)) {
    log.error(`[boot] Node >= 24 is required (node:sqlite); this is ${process.versions.node}`);
    process.exit(1);
  }

  // A rejection nobody handled means state we did not plan for. Log it and exit: systemd
  // restarts this unit, and only this unit.
  process.on('unhandledRejection', (reason) => {
    log.error(`[fatal] unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    log.error(`[fatal] uncaught exception: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });

  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      log.error(`[boot] config: ${e.message}`);
      process.exit(EX_CONFIG);
    }
    throw e;
  }

  let db;
  try {
    db = openDb(config.dbPath, { net: config.net, log });
  } catch (e) {
    log.error(`[boot] database ${config.dbPath}: ${e.message}`);
    process.exit(1);
  }

  const maintenance = createMaintenance({ log });
  const app = buildApp({ config, db, log });
  app.registerJobs(maintenance);
  const server = createServer(app.handler);

  listen(server, config.port, config.host).then((addr) => {
    log.info(`[boot] grin-games ${config.net} listening on ${addr.address}:${addr.port} · schema v${db.schemaVersion()} · pid ${process.pid}`);
    // The mode starts as 'off' and turns on at the pool's first answer (lib/mode.js).
    app.start();
    maintenance.start();
  }, (err) => {
    log.error(`[boot] listen ${config.host}:${config.port}: ${err.code || err.message}`);
    db.close();
    process.exit(1);
  });

  let stopping = false;
  const onSignal = (sig) => {
    if (stopping) return;
    stopping = true;
    log.info(`[shutdown] ${sig} — draining`);
    shutdown({ server, app, maintenance, db, log }).then(({ forced }) => {
      log.info(`[shutdown] done${forced ? ' (forced)' : ''}`);
      process.exit(0);
    }, (err) => {
      log.error(`[shutdown] failed: ${err && err.message ? err.message : err}`);
      process.exit(1);
    });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

if (require.main === module) main();

module.exports = { main, EX_CONFIG };
