#!/usr/bin/env node
/**
 * nuke.js — DESTRUCTIVE local dev reset. Never run this on a live pool.
 *
 * Two things to know before running it:
 *   1. It deletes `<back-end-pool>/pool.sqlite` — the DEV fallback DB path only. An
 *      INSTALLED pool keeps its ledger at config.db_path (/opt/grin/pubpool/<net>/pool.db),
 *      which this does not touch, so on a real box it reports success having deleted nothing.
 *   2. It runs `pkill -f "node.*pool"`, which DOES match the installed grin-pool-manager
 *      service — so on a real box it stops the pool while leaving the database intact.
 *
 * The wallet directory is deliberately left alone (the seed is the one irreplaceable thing).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🔥 NUKING POOL STATE...\n');

try {
  console.log('1. Killing pool processes...');
  try {
    if (process.platform === 'win32') {
      execSync('taskkill /F /IM node.exe /FI "WINDOWTITLE eq*pool*" 2>nul', { stdio: 'inherit' });
    } else {
      execSync('pkill -f "node.*pool" 2>/dev/null || true', { stdio: 'inherit' });
    }
    console.log('   ✓ Killed pool processes');
  } catch (e) {
    console.log('   (no processes running)');
  }

  console.log('\n2. Deleting database...');
  const dbPath = path.join(__dirname, '..', 'pool.sqlite');
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    console.log(`   ✓ Deleted ${dbPath}`);
  } else {
    console.log('   (database does not exist)');
  }

  console.log('\n3. Checking wallet state...');
  const walletDir = process.env.POOL_WALLET_DIR || '/opt/grin/pool-test/';
  if (fs.existsSync(walletDir)) {
    console.log(`   Wallet dir exists: ${walletDir}`);
    console.log('   (keeping wallet state — run grin-wallet init if needed)');
  } else {
    console.log(`   (wallet dir does not exist: ${walletDir})`);
  }

  console.log('\n✅ Pool state reset. Run "npm start" to reinitialize.\n');
} catch (err) {
  console.error(`\n❌ Error during nuke: ${err.message}`);
  process.exit(1);
}
