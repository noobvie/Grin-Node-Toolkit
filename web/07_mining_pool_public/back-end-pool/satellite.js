#!/usr/bin/env node
'use strict';

// Satellite entrypoint (SATELLITE role) — multi-region mining pool.
//
// Runs mining ingress + relay ONLY: a stratum proxy (miners connect here),
// an upstream client to the local Grin node's built-in stratum, and a share
// relay that forwards accepted shares / found blocks to the Central Hub.
//
// NO web server, admin panel, wallet, payouts, or pool accounting — that all
// lives on the hub (index.js). The local SQLite here is just a lean staging /
// failover store, kept bounded by the retention job.
//
// Config: GRIN_POOL_CONF (defaults ./pool.json). Must set hub_url +
// hub_shared_secret + region (+ pool_address for the node stratum login).
// See docs/generated/script07_multi_region_design.md §8.

const { loadConfig } = require('./lib/config');
const { initDb } = require('./lib/db');
const StratumServer = require('./lib/stratum-server');
const NodeStratumClient = require('./lib/node-stratum-client');
const ShareRelay = require('./lib/share-relay');
const RetentionManager = require('./lib/retention');

function main() {
  const configPath = process.env.GRIN_POOL_CONF || './pool.json';
  const config = loadConfig(configPath);

  if (!config.hub_url || !config.hub_shared_secret) {
    console.error('[Satellite] hub_url and hub_shared_secret are required in config. Exiting.');
    process.exit(1);
  }

  // Lean local DB: stratum sessions + share staging + relay failover. Not authoritative.
  initDb(config.db_path);

  const relay = new ShareRelay(config).start();

  const stratumServer = new StratumServer(config);
  stratumServer.setShareRelay(relay);
  stratumServer.start();

  const nodeStratumClient = new NodeStratumClient(config, stratumServer);
  stratumServer.setNodeStratumClient(nodeStratumClient);
  nodeStratumClient.start();

  // Keep the local staging DB bounded (shares are authoritative on the hub).
  new RetentionManager(config).start();

  console.log(
    `[Satellite] region='${config.region}' stratum :${config.stratum_port} ` +
    `→ node :${config.node_stratum_port} → hub ${config.hub_url}`
  );

  const shutdown = () => {
    try { relay.stop(); stratumServer.stop(); nodeStratumClient.stop(); } catch (e) { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
