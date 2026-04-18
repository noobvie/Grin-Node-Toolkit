'use strict';
/**
 * app.js — Grin Drop — Express application
 * =========================================
 *
 * Public endpoints:
 *   GET  /api/status          wallet balance + site config + ?addr= next_claim_at
 *   GET  /api/public-stats    total given/received, claim/donation counts
 *   GET  /api/qr              PNG QR code for drop wallet address
 *   GET  /api/nodes           online/offline status of public Grin nodes
 *   POST /api/claim           {grin_address} → {claim_id, slatepack, expires_at}
 *   POST /api/finalize        {claim_id, response_slate} → {status, tx_slate_id}
 *
 * Donation endpoints:
 *   POST /api/donate/receive  {send_slate} → {response_slatepack}          Tab 2
 *   POST /api/donate/invoice  {amount, address} → {invoice_id, slatepack}  Tab 3 step 1
 *   POST /api/donate/finalize {invoice_id, response_slate} → {status}      Tab 3 step 2
 *
 * Background intervals:
 *   Every 30s  — cancel expired waiting_finalize claims
 *   Every 60s  — expire timed-out pending invoices
 */

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const express = require('express');
const QRCode  = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const { loadConfig, writeConfigKey } = require('./config');
const db = require('./db');
const {
  foreignApiCall,
  ownerApiSession,
  encryptedOwnerCall,
} = require('./wallet');

// ── App setup ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '16kb' }));

// Static web files (public_html/ is one level up from server/)
const PUBLIC_DIR = path.join(__dirname, '..', 'public_html');
app.use(express.static(PUBLIC_DIR));


// ── Activity log ───────────────────────────────────────────────────────────────

let _logStream = null;

function _getLogStream() {
  if (_logStream) return _logStream;
  const cfg = loadConfig();
  const logPath = cfg.log_path || '/opt/grin/drop-test/grin_drop_test.log';
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  _logStream = fs.createWriteStream(logPath, { flags: 'a' });
  return _logStream;
}

function actLog(level, msg) {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] [${level}] ${msg}\n`;
  process.stdout.write(line);
  try { _getLogStream().write(line); } catch {}
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function err(res, msg, code = 400) {
  return res.status(code).json({ error: msg });
}

function truncAddr(addr) {
  return addr.length > 12 ? addr.slice(0, 6) + '...' + addr.slice(-4) : addr;
}

const GRIN_ADDR_RE    = /^(grin1|tgrin1)[a-z0-9]{40,}$/;
const ANON_CLAIM_GRIN = loadConfig().network === 'mainnet' ? 0.009 : 0.09;

// IP helpers — nginx must set: proxy_set_header X-Real-IP $remote_addr;
// Only X-Real-IP is trusted — X-Forwarded-For is client-controlled and spoofable.
function getClientIp(req) {
  return (req.headers['x-real-ip'] || '').trim();
}

function hashIp(ip, salt) {
  const s = salt || process.env.IP_SALT || 'grin-anon-claim';
  return 'anon:' + crypto.createHash('sha256').update(ip + s).digest('hex').slice(0, 24);
}

function validateSlatepack(input) {
  if (!input || typeof input !== 'string') return false;
  if (input.length > 8192) return false;
  return input.includes('BEGINSLATEPACK') && input.includes('ENDSLATEPACK');
}

function nextClaimIso(address) {
  const last = db.lastActiveClaim(address);
  if (!last) return null;
  const cfg = loadConfig();
  const windowMs = (cfg.claim_cooldown_minutes ?? 240) * 60_000;
  const created  = new Date(last.created_at).getTime();
  const nextAllowed = new Date(created + windowMs);
  if (Date.now() >= nextAllowed.getTime()) return null;
  return nextAllowed.toISOString();
}

// ── Maintenance middleware ──────────────────────────────────────────────────────

app.use((req, res, next) => {
  const cfg = loadConfig();
  if (!cfg.maintenance_mode) return next();
  // Allow status endpoints so the frontend can display the maintenance overlay
  if (req.path === '/api/status' || req.path === '/api/public-stats') return next();
  // For HTML requests return 503 with maintenance message
  if (req.accepts('html')) {
    return res.status(503).send(`<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:4rem">
      <h1>${cfg.drop_name || 'Grin Drop'}</h1>
      <p>${cfg.maintenance_message || 'We\'ll be back soon.'}</p>
    </body></html>`);
  }
  return res.status(503).json({ error: cfg.maintenance_message || 'Maintenance mode' });
});


// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/status ──────────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const cfg = loadConfig();

  // Wallet balance + address via Owner API (non-fatal if wallet is down)
  // balance stays null when wallet is unreachable — frontend shows "—" not "0"
  // Balance and address are fetched in separate inner try/catch blocks so that
  // a node-timeout on retrieve_summary_info never prevents the address from
  // being fetched and persisted.
  let balance     = null;
  let lowBalance  = false;
  let walletAddress = cfg.wallet_address || '';
  try {
    const session = await ownerApiSession();
    const { headers, sharedKey, ownerUrl, token } = session;

    // Balance (non-fatal — may fail when the grin node is unreachable)
    // retrieve_summary_info returns [refreshed_from_node, WalletInfo] — summary is at [1]
    // Use refresh_from_node: false to read from local cache — avoids triggering a node
    // scan that holds LMDB write locks and blocks concurrent donate/receive calls.
    try {
      const infoResult = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'retrieve_summary_info', {
        token,
        minimum_confirmations: 1,
        refresh_from_node: false,
      });
      const info    = Array.isArray(infoResult) ? infoResult[1] : infoResult;
      balance       = parseInt(info?.amount_currently_spendable || '0', 10) / 1_000_000_000;
      const cfgVal  = parseFloat(cfg.low_balance_alert_grin);
      const alertThreshold = cfgVal > 0  ? cfgVal
                           : cfgVal === 0 ? 0
                           : (cfg.network === 'mainnet' ? 100 : 1000); // -1 = auto
      if (alertThreshold > 0 && balance < alertThreshold) {
        lowBalance = true;
        actLog('WARN', `LOW_BALANCE spendable=${balance} threshold=${alertThreshold} network=${cfg.network}`);
      }
    } catch (balErr) {
      actLog('WARN', `BALANCE_FAIL err=${balErr.message}`);
    }

    // Address — independent of balance, persisted to config so the donate tab
    // continues to show the address even when the Owner API is temporarily down.
    try {
      const addrResult = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'get_slatepack_address', {
        token,
        derivation_index: 0,
      });
      if (addrResult) {
        walletAddress = addrResult;
        if (addrResult !== cfg.wallet_address) {
          writeConfigKey('wallet_address', addrResult);
        }
      }
    } catch (addrErr) {
      actLog('WARN', `ADDR_FAIL err=${addrErr.message}`);
    }
  } catch (e) {
    actLog('WARN', `WALLET_FAIL cmd=status err=${e.message}`);
  }

  const payload = {
    drop_name:           cfg.drop_name,
    claim_grin_per_tx:    cfg.claim_grin_per_tx,
    claim_cooldown_minutes: cfg.claim_cooldown_minutes,
    global_daily_claims_cap:     cfg.global_daily_claims_cap,
    global_hourly_claims_cap:    cfg.global_hourly_claims_cap,
    claims_this_hour:     db.countClaimsThisHour(),
    daily_cap_reached:    cfg.global_daily_claims_cap  > 0 && db.countClaimsToday()      >= cfg.global_daily_claims_cap,
    hourly_cap_reached:   cfg.global_hourly_claims_cap > 0 && db.countClaimsThisHour()   >= cfg.global_hourly_claims_cap,
    wallet_address:      walletAddress,
    wallet_balance:      balance !== null ? Math.round(balance * 1e9) / 1e9 : null,
    low_balance:         lowBalance,
    claims_today:        db.countClaimsToday(),
    claims_total:        db.countClaimsTotal(),
    donations_today:     db.countDonationsToday(),
    donations_total:     db.countDonationsTotal(),
    next_claim_at:       null,
    giveaway_enabled:    cfg.giveaway_enabled,
    donation_enabled:    cfg.donation_enabled,
    show_public_stats:   cfg.show_public_stats,
    maintenance_mode:    cfg.maintenance_mode,
    maintenance_message: cfg.maintenance_message,
    theme_default:       cfg.theme_default,
  };

  if (cfg.show_public_stats) {
    payload.total_given    = Math.round(db.getTotalGivenGrin() * 1e9) / 1e9;
    payload.total_received = Math.round(db.getTotalReceivedGrin() * 1e9) / 1e9;
  }

  const addr = (req.query.addr || '').trim();
  if (addr) payload.next_claim_at = nextClaimIso(addr);

  res.json(payload);
});

// GET /api/public-stats ────────────────────────────────────────────────────────
app.get('/api/public-stats', (_req, res) => {
  const cfg = loadConfig();
  if (!cfg.show_public_stats) {
    return res.status(403).json({ error: 'Public stats are disabled' });
  }
  const stats = db.getPublicStats();
  res.json({
    total_given:     Math.round(stats.total_given    * 1e9) / 1e9,
    total_received:  Math.round(stats.total_received * 1e9) / 1e9,
    claims_total:    stats.claims_total,
    donations_total: stats.donations_total,
  });
});

// GET /api/nodes ───────────────────────────────────────────────────────────────
// Returns online/offline status for all known public Grin nodes.
// Technique: GET https://<node>/v2/foreign — 2xx/3xx/404/405 = online.
const NODES_MAINNET = ['api.grin.money', 'api.grinily.com', 'api.grinnode.org', 'main.gri.mw', 'grincoin.org'];
const NODES_TESTNET = ['testapi.grin.money', 'testapi.grinily.com', 'testnet.grincoin.org', 'test.gri.mw'];

app.get('/api/nodes', async (_req, res) => {
  const cfg  = loadConfig();
  const list = cfg.network === 'mainnet' ? NODES_MAINNET : NODES_TESTNET;

  const results = await Promise.all(list.map(async (node) => {
    const t0 = Date.now();
    try {
      const r = await fetch(`https://${node}/v2/foreign`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      const online = (r.status >= 200 && r.status < 400) || r.status === 404 || r.status === 405;
      return { url: `https://${node}`, online, ms: Date.now() - t0 };
    } catch {
      return { url: `https://${node}`, online: false, ms: null };
    }
  }));

  res.json({ nodes: results, network: cfg.network });
});

// GET /api/qr ──────────────────────────────────────────────────────────────────
app.get('/api/qr', async (_req, res) => {
  const cfg = loadConfig();
  const address = cfg.wallet_address || '';
  if (!address) return res.status(404).end();
  try {
    const png = await QRCode.toBuffer(address, { errorCorrectionLevel: 'M', scale: 6, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(png);
  } catch (e) {
    actLog('ERROR', `QR_FAIL err=${e.message}`);
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// POST /api/claim ──────────────────────────────────────────────────────────────
app.post('/api/claim', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.giveaway_enabled) return err(res, 'Giveaway is currently disabled', 503);

  const body = req.body || {};
  const address = (body.grin_address || '').trim();

  if (!address) return err(res, 'grin_address is required');
  if (!GRIN_ADDR_RE.test(address)) return err(res, 'Invalid grin address — expected grin1... or tgrin1... (52+ chars)');

  const ownAddress = cfg.wallet_address || '';
  if (ownAddress && address === ownAddress) {
    actLog('WARN', `CLAIM_SELF_ADDR addr=${truncAddr(address)}`);
    return err(res, 'Invalid address — you cannot use the drop wallet address to claim');
  }

  const nextAt = nextClaimIso(address);
  if (nextAt) {
    actLog('WARN', `RATE_LIMIT addr=${truncAddr(address)} next_claim=${nextAt}`);
    return err(res, `Already claimed. Next claim available at ${nextAt}`, 429);
  }

  const dailyCap  = parseInt(cfg.global_daily_claims_cap,  10) || 0;
  const hourlyCap = parseInt(cfg.global_hourly_claims_cap, 10) || 0;
  if (dailyCap  > 0 && db.countClaimsToday()     >= dailyCap)  {
    actLog('WARN', `DAILY_CAP_REACHED cap=${dailyCap}`);
    return err(res, 'Daily claim limit reached. Try again tomorrow.', 503);
  }
  if (hourlyCap > 0 && db.countClaimsThisHour()  >= hourlyCap) {
    actLog('WARN', `HOURLY_CAP_REACHED cap=${hourlyCap}`);
    return err(res, 'Hourly claim limit reached. Try again in a few minutes.', 503);
  }

  const maxAmount       = parseFloat(cfg.claim_grin_per_tx) || 2.0;
  const requestedAmount = body.amount != null ? parseFloat(body.amount) : null;
  const amount = (requestedAmount != null && requestedAmount > 0)
    ? Math.min(Math.max(requestedAmount, 0.001), maxAmount)
    : maxAmount;

  const timeoutMin = parseInt(cfg.slatepack_expire_min, 10) || 5;
  const claimId    = db.createClaim(address, amount, timeoutMin);
  actLog('INFO', `CLAIM_INIT addr=${truncAddr(address)} claim_id=${claimId}`);

  let slatepack = '';
  try {
    const session = await ownerApiSession();
    const { headers, sharedKey, ownerUrl, token } = session;

    // init_send_tx — create the outgoing slate
    const slate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'init_send_tx', {
      token,
      args: {
        src_acct_name:                    null,
        amount:                           String(Math.round(amount * 1_000_000_000)),
        minimum_confirmations:            10,
        max_outputs:                      500,
        num_change_outputs:               1,
        selection_strategy_is_use_all:    false,
        target_slate_version:             null,
        // payment_proof_recipient_address: null — omit proof entirely.
        // A proof embeds payment_proof.sender_address (our key) inside the slate
        // content itself.  Newer grin-wallet builds extract that address and call
        // our Foreign API with receive_tx even when sender_index is null in the
        // slatepack envelope.  That receive_tx on our own outgoing tx corrupts the
        // LMDB context and causes KernelSumMismatch on finalize_tx.  For a giveaway
        // faucet a cryptographic receipt is unnecessary — drop it.
        payment_proof_recipient_address:  null,
        ttl_blocks:                       null,
        send_args:                        null,
      },
    });

    // create_slatepack_message — encode to BEGINSLATEPACK...ENDSLATEPACK
    // sender_index: null — omit the server's slatepack address from the envelope.
    // Without payment_proof, the slate contains no server address at all, so the
    // receiver's wallet has nothing to auto-respond to via Tor.
    slatepack = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'create_slatepack_message', {
      token,
      sender_index: null,
      recipients:   [],
      slate,
    });
  } catch (e) {
    db.setClaimStatus(claimId, 'failed');
    actLog('ERROR', `WALLET_FAIL cmd=init_send claim_id=${claimId} err=${e.message}`);
    return err(res, 'Wallet temporarily unavailable — try again shortly', 503);
  }

  db.setSlatepackOut(claimId, slatepack);
  actLog('INFO', `SLATEPACK_OUT claim_id=${claimId}`);

  const claim = db.getClaim(claimId);
  res.json({
    claim_id:   claimId,
    slatepack,
    amount,
    expires_at: claim.expires_at,
  });
});

// POST /api/claim/anonymous ────────────────────────────────────────────────────
// No address required — rate-limited by hashed client IP.
// Amount is capped to ANON_CLAIM_GRIN max (0.009 mainnet / 0.09 testnet); min 0.001.
app.post('/api/claim/anonymous', async (req, res) => {
  const cfg  = loadConfig();
  const body = req.body || {};
  if (!cfg.giveaway_enabled) return err(res, 'Giveaway is currently disabled', 503);

  const ip = getClientIp(req);
  if (!ip) return err(res, 'Could not determine client IP', 400);
  const anonAddr = hashIp(ip, cfg.ip_salt);

  const nextAt = nextClaimIso(anonAddr);
  if (nextAt) {
    actLog('WARN', `ANON_RATE_LIMIT ip_hash=${anonAddr.slice(0, 12)} next_claim=${nextAt}`);
    return err(res, `Already claimed. Next claim available at ${nextAt}`, 429);
  }

  const dailyCap  = parseInt(cfg.global_daily_claims_cap,  10) || 0;
  const hourlyCap = parseInt(cfg.global_hourly_claims_cap, 10) || 0;
  if (dailyCap  > 0 && db.countClaimsToday()    >= dailyCap)  {
    actLog('WARN', `DAILY_CAP_REACHED cap=${dailyCap}`);
    return err(res, 'Daily claim limit reached. Try again tomorrow.', 503);
  }
  if (hourlyCap > 0 && db.countClaimsThisHour() >= hourlyCap) {
    actLog('WARN', `HOURLY_CAP_REACHED cap=${hourlyCap}`);
    return err(res, 'Hourly claim limit reached. Try again in a few minutes.', 503);
  }

  const requestedAnonAmount = body.amount != null ? parseFloat(body.amount) : null;
  const anonAmount = (requestedAnonAmount != null && requestedAnonAmount > 0)
    ? Math.min(Math.max(requestedAnonAmount, 0.001), ANON_CLAIM_GRIN)
    : ANON_CLAIM_GRIN;

  const timeoutMin = parseInt(cfg.slatepack_expire_min, 10) || 5;
  const claimId    = db.createClaim(anonAddr, anonAmount, timeoutMin);
  actLog('INFO', `ANON_CLAIM_INIT ip_hash=${anonAddr.slice(0, 12)} claim_id=${claimId} amount=${anonAmount}`);

  let slatepack = '';
  try {
    const session = await ownerApiSession();
    const { headers, sharedKey, ownerUrl, token } = session;

    const slate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'init_send_tx', {
      token,
      args: {
        src_acct_name:                   null,
        amount:                          String(Math.round(anonAmount * 1_000_000_000)),
        minimum_confirmations:           10,
        max_outputs:                     500,
        num_change_outputs:              1,
        selection_strategy_is_use_all:   false,
        target_slate_version:            null,
        payment_proof_recipient_address: null,
        ttl_blocks:                      null,
        send_args:                       null,
      },
    });

    slatepack = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'create_slatepack_message', {
      token,
      sender_index: null,
      recipients:   [],
      slate,
    });
  } catch (e) {
    db.setClaimStatus(claimId, 'failed');
    actLog('ERROR', `WALLET_FAIL cmd=anon_claim claim_id=${claimId} err=${e.message}`);
    return err(res, 'Wallet temporarily unavailable — try again shortly', 503);
  }

  db.setSlatepackOut(claimId, slatepack);
  actLog('INFO', `ANON_SLATEPACK_OUT claim_id=${claimId}`);

  const claim = db.getClaim(claimId);
  res.json({ claim_id: claimId, slatepack, amount: anonAmount, expires_at: claim.expires_at });
});

// POST /api/finalize ───────────────────────────────────────────────────────────
app.post('/api/finalize', async (req, res) => {
  const body           = req.body || {};
  const claimId        = parseInt(body.claim_id, 10);
  const responseSplate = (body.response_slate || '').trim();

  if (!claimId || !responseSplate) return err(res, 'claim_id and response_slate are required');
  if (!validateSlatepack(responseSplate)) return err(res, 'Invalid slatepack format');

  const claim = db.getClaim(claimId);
  if (!claim) return err(res, 'Claim not found', 404);
  if (claim.status === 'confirmed') {
    return res.json({ status: 'confirmed', tx_slate_id: claim.tx_slate_id || '' });
  }
  if (claim.status === 'cancelled') return err(res, 'Claim expired — please start a new claim', 410);
  if (!['waiting_finalize', 'pending'].includes(claim.status)) {
    return err(res, `Claim is in state '${claim.status}'`, 409);
  }
  if (Date.now() > new Date(claim.expires_at).getTime()) {
    db.cancelExpiredClaim(claimId);
    actLog('WARN', `TIMEOUT claim_id=${claimId} (expired on finalize attempt)`);
    return err(res, 'Claim expired — please start a new claim', 410);
  }

  actLog('INFO', `FINALIZE_ATTEMPT claim_id=${claimId}`);

  let txSlateId = '';
  try {
    const session = await ownerApiSession();
    const { headers, sharedKey, ownerUrl, token } = session;

    // Decode user's response slatepack.
    // secret_indices: [0] — try key at derivation index 0 first, then fall through
    // to unencrypted.  Use [0] (not []) so that if the receiver's wallet happened to
    // encrypt S2 back to us the decryption still works.
    const slate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'slate_from_slatepack_message', {
      token,
      secret_indices: [0],
      message:        responseSplate,
    });

    // Lock outputs — REQUIRED before finalize_tx when the server is the SENDER.
    // init_send_tx selects inputs but leaves the transaction "pending/unlocked" in LMDB.
    // tx_lock_outputs commits that input selection so finalize_tx can derive the signing
    // key.  Skipping this call leaves the context unlocked → "keychain error" →
    // KernelSumMismatch.  (Official API tutorial: init_send_tx → tx_lock_outputs → finalize_tx)
    await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'tx_lock_outputs', {
      token,
      slate,
    });

    // Finalize — signs the transaction but does NOT broadcast (per grin-wallet docs).
    const finalResult = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'finalize_tx', {
      token,
      slate,
    });
    txSlateId = (finalResult && finalResult.id) ? String(finalResult.id) : '';

    // Post (broadcast) to network — separate required step.
    // fluff: true  →  skip Dandelion++ stem phase and broadcast immediately.
    // Non-fatal: if the node is temporarily unreachable the tx is fully signed in
    // the wallet's LMDB and can be re-broadcast manually; the claim is still recorded.
    try {
      actLog('INFO', `POST_TX_ATTEMPT claim_id=${claimId} has_slate=${!!finalResult}`);
      await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'post_tx', {
        token,
        slate: finalResult,
        fluff: true,
      });
      actLog('INFO', `BROADCAST_OK claim_id=${claimId} tx=${txSlateId || '(unknown)'}`);
    } catch (postErr) {
      actLog('WARN', `BROADCAST_FAIL claim_id=${claimId} tx=${txSlateId} err=${postErr.message} — tx signed in wallet, re-broadcast manually`);
    }
  } catch (e) {
    actLog('ERROR', `WALLET_FAIL cmd=finalize claim_id=${claimId} err=${e.message}`);
    return err(res, 'Wallet temporarily unavailable — try again shortly', 503);
  }

  db.setClaimFinalized(claimId, responseSplate, txSlateId);
  actLog('INFO', `FINALIZE_OK claim_id=${claimId} tx=${txSlateId || '(unknown)'}`);
  actLog('INFO', `CONFIRMED claim_id=${claimId} amount=${claim.amount} GRIN`);

  res.json({
    status:      'confirmed',
    tx_slate_id: txSlateId,
    amount:      claim.amount,
    message:     'Transaction submitted — confirmed after ~10 blocks (~10 min)',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DONATION ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/donate/receive ─────────────────────────────────────────────────────
// Tab 2: user ran `grin-wallet send -d <our_address> -a <amount>` and pastes slate.
// Flow:  Owner slate_from_slatepack_message → Foreign receive_tx → Owner create_slatepack_message
// User then finalizes in their own wallet — Node.js never calls finalize.
app.post('/api/donate/receive', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.donation_enabled) return err(res, 'Donations are currently disabled', 503);

  const sendSlate = (req.body.send_slate || '').trim();
  if (!validateSlatepack(sendSlate)) return err(res, 'Invalid slatepack — must be BEGINSLATEPACK...ENDSLATEPACK (max 8192 bytes)');

  actLog('INFO', 'DONATE_RECEIVE_ATTEMPT');

  try {
    const session = await ownerApiSession();
    const { headers, sharedKey, ownerUrl, token } = session;

    // 1. Decode incoming slatepack → slate JSON
    const slate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'slate_from_slatepack_message', {
      token,
      secret_indices: [0],
      message:        sendSlate,
    });

    // Sanity cap — reject absurdly large slates before touching wallet state
    const slateAmountGrin = slate && slate.amount ? parseInt(slate.amount) / 1_000_000_000 : 0;
    if (slateAmountGrin > 10000) {
      return err(res, 'Donation amount exceeds maximum of 10000 GRIN');
    }

    // 2. Foreign API receive_tx — no LMDB conflict with Owner API calls
    const responseSlate = await foreignApiCall('receive_tx', [slate, null, null]);

    // 3. Encode response slate → slatepack
    const responseSlatepack = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'create_slatepack_message', {
      token,
      sender_index: 0,
      recipients:   [],
      slate:        responseSlate,
    });

    // Record donation as confirmed — receive_tx succeeded so the wallet has accepted it.
    // Amount is in nanogrin in the slate; convert to GRIN for storage.
    const amountGrin = slate && slate.amount ? parseInt(slate.amount) / 1_000_000_000 : 0;
    db.createSlatepackDonation('', amountGrin);
    actLog('INFO', `DONATE_RECEIVE_OK amount=${amountGrin} GRIN`);

    res.json({ response_slatepack: responseSlatepack });
  } catch (e) {
    actLog('ERROR', `DONATE_RECEIVE_FAIL err=${e.message}`);
    return err(res, 'Wallet temporarily unavailable — try again shortly', 503);
  }
});

// POST /api/donate/invoice ────────────────────────────────────────────────────
// Tab 3 step 1: we create an invoice for <amount> GRIN the user will pay.
// Returns invoice slatepack for user to run: grin-wallet pay -i invoice.slatepack
app.post('/api/donate/invoice', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.donation_enabled) return err(res, 'Donations are currently disabled', 503);

  const amount  = parseFloat(req.body.amount);
  const address = (req.body.address || '').trim();

  if (!amount || isNaN(amount) || amount < 0.1) return err(res, 'Amount must be at least 0.1 GRIN');
  if (amount > 10000) return err(res, 'Amount exceeds maximum of 10000 GRIN');
  if (!address || !GRIN_ADDR_RE.test(address)) return err(res, 'Invalid grin address');

  // Security: block our own wallet address — invoice must be directed to the payer, not ourselves
  const ownAddress = cfg.wallet_address || '';
  if (ownAddress && address === ownAddress) {
    actLog('WARN', `DONATE_INVOICE_SELF_ADDR addr=${truncAddr(address)}`);
    return err(res, 'Invalid address — you cannot use the drop wallet address as the payer');
  }

  const invoiceId  = uuidv4();
  const timeoutMin = parseInt(cfg.donation_invoice_timeout, 10) || 30;

  actLog('INFO', `DONATE_INVOICE_ATTEMPT amount=${amount} addr=${truncAddr(address)}`);

  try {
    const session = await ownerApiSession();
    const { headers, sharedKey, ownerUrl, token } = session;

    // 1. Create invoice slate (amount in nanogrin)
    const slate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'issue_invoice_tx', {
      token,
      args: {
        amount:              String(Math.round(amount * 1_000_000_000)),
        dest_acct_name:      null,
        target_slate_version: null,
        address:             address,
      },
    });

    // 2. Encode invoice → slatepack
    // sender_index: 0 — embeds the server's slatepack address in the envelope.
    // NOTE: wallets with TOR enabled (grin-wallet default) will detect this address
    // and automatically attempt to send the payment response via TOR directly to
    // the server's grin-wallet listener — the donor WON'T need to paste a response
    // slatepack back to the website.  If TOR fails or is disabled, the wallet will
    // fall back to outputting a slatepack for the donor to paste manually.
    const invoiceSlatepack = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'create_slatepack_message', {
      token,
      sender_index: 0,
      recipients:   [],
      slate,
    });

    // 3. Store pending invoice in DB
    db.createInvoiceDonation(amount, address, invoiceId, timeoutMin);
    actLog('INFO', `DONATE_INVOICE_OK invoice_id=${invoiceId} amount=${amount}`);

    res.json({ invoice_id: invoiceId, invoice_slatepack: invoiceSlatepack });
  } catch (e) {
    actLog('ERROR', `DONATE_INVOICE_FAIL err=${e.message}`);
    return err(res, 'Wallet temporarily unavailable — try again shortly', 503);
  }
});

// POST /api/donate/finalize ───────────────────────────────────────────────────
// Tab 3 step 2: user ran `grin-wallet pay` and pastes their response slatepack.
app.post('/api/donate/finalize', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.donation_enabled) return err(res, 'Donations are currently disabled', 503);

  const invoiceId     = (req.body.invoice_id    || '').trim();
  const responseSplate = (req.body.response_slate || '').trim();

  if (!invoiceId)                              return err(res, 'invoice_id is required');
  if (!validateSlatepack(responseSplate))      return err(res, 'Invalid slatepack format');

  const donation = db.getDonationByInvoiceId(invoiceId);
  if (!donation) return err(res, 'Invoice not found or already finalised', 404);

  // Guard: check expiry before touching wallet
  if (donation.expires_at && Date.now() > new Date(donation.expires_at).getTime()) {
    actLog('WARN', `DONATE_FINALIZE_EXPIRED invoice_id=${invoiceId}`);
    return err(res, 'Invoice expired — please create a new one', 410);
  }

  actLog('INFO', `DONATE_FINALIZE_ATTEMPT invoice_id=${invoiceId}`);

  let txId = '';
  try {
    const session = await ownerApiSession();
    const { headers, sharedKey, ownerUrl, token } = session;

    // 1. Decode user's payment response slatepack
    const slate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'slate_from_slatepack_message', {
      token,
      secret_indices: [0],
      message:        responseSplate,
    });

    // 2. Finalize — signs the transaction.
    const finalResult = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'finalize_tx', {
      token,
      slate,
    });
    txId = (finalResult && finalResult.id) ? String(finalResult.id) : '';

    // 3. Broadcast — explicit post_tx for reliability across grin-wallet versions.
    // Non-fatal: tx is fully signed in wallet LMDB; can be re-broadcast manually.
    try {
      actLog('INFO', `DONATE_POST_TX_ATTEMPT invoice_id=${invoiceId} has_slate=${!!finalResult}`);
      await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'post_tx', {
        token,
        slate: finalResult,
        fluff: true,
      });
      actLog('INFO', `DONATE_BROADCAST_OK invoice_id=${invoiceId} tx=${txId || '(unknown)'}`);
    } catch (postErr) {
      actLog('WARN', `DONATE_BROADCAST_FAIL invoice_id=${invoiceId} tx=${txId} err=${postErr.message}`);
    }
  } catch (e) {
    actLog('ERROR', `DONATE_FINALIZE_FAIL invoice_id=${invoiceId} err=${e.message}`);
    return err(res, 'Wallet temporarily unavailable — try again shortly', 503);
  }

  db.confirmInvoiceDonation(invoiceId, txId);
  actLog('INFO', `DONATE_FINALIZE_OK invoice_id=${invoiceId} tx=${txId || '(unknown)'}`);

  res.json({ status: 'confirmed', tx_id: txId });
});

// ─────────────────────────────────────────────────────────────────────────────
// BACKGROUND INTERVALS
// ─────────────────────────────────────────────────────────────────────────────

// Cancel expired waiting_finalize claims every 30 seconds
setInterval(() => {
  try {
    for (const claim of db.getExpiredClaims()) {
      db.cancelExpiredClaim(claim.id);
      actLog('WARN', `TIMEOUT claim_id=${claim.id} addr=${truncAddr(claim.grin_address)} (cancelled)`);
    }
  } catch (e) {
    actLog('ERROR', `TIMEOUT_CHECK_ERR err=${e.message}`);
  }
}, 30_000);

// Expire stale pending invoices every 60 seconds
setInterval(() => {
  try {
    const n = db.expireOldInvoices();
    if (n > 0) actLog('INFO', `INVOICE_EXPIRE_SWEEP expired=${n}`);
  } catch (e) {
    actLog('ERROR', `INVOICE_EXPIRE_ERR err=${e.message}`);
  }
}, 60_000);

// Cancel abandoned unfinalized wallet txs every 10 minutes.
// Targets TxSent (stuck claims) and TxReceived (unpaid invoices) older than
// wallet_cleanup_hours.  Frees locked inputs so the balance stays accurate.
async function cancelAbandonedWalletTxs() {
  const cfg           = loadConfig();
  const thresholdHours = parseFloat(cfg.wallet_cleanup_hours) || 0;
  if (!thresholdHours) return;                   // 0 = disabled

  const cutoff = new Date(Date.now() - thresholdHours * 3_600_000);

  const session = await ownerApiSession();
  const { headers, sharedKey, ownerUrl, token } = session;

  const result = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'retrieve_txs', {
    token,
    refresh_from_node: false,
    tx_id:             null,
    tx_slate_id:       null,
  });
  const txs = Array.isArray(result) ? result[1] : (result || []);

  const candidates = txs.filter(tx =>
    !tx.confirmed &&
    (tx.tx_type === 'TxSent' || tx.tx_type === 'TxReceived') &&
    new Date(tx.creation_ts) < cutoff
  );

  for (const tx of candidates) {
    try {
      await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'cancel_tx', {
        token,
        tx_id:       tx.id,
        tx_slate_id: null,
      });
      actLog('INFO', `WALLET_TX_CANCELLED id=${tx.id} slate=${tx.tx_slate_id} type=${tx.tx_type} created=${tx.creation_ts}`);
    } catch (e) {
      actLog('WARN', `WALLET_TX_CANCEL_FAIL id=${tx.id} err=${e.message}`);
    }
  }

  if (candidates.length > 0)
    actLog('INFO', `WALLET_CLEANUP_SWEEP cancelled=${candidates.length} threshold=${thresholdHours}h`);
}

setInterval(async () => {
  try { await cancelAbandonedWalletTxs(); }
  catch (e) { actLog('WARN', `WALLET_CLEANUP_ERR err=${e.message}`); }
}, 600_000);

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────

const cfg  = loadConfig();
const PORT = parseInt(cfg.service_port, 10) || 3004;

// ── Startup config visibility ──────────────────────────────────────────────────
{
  const confPath = process.env.DROP_CONF || '(default)';
  const addrSnip = cfg.wallet_address ? cfg.wallet_address.slice(0, 16) + '…' : '(empty)';
  actLog('INFO', `CONFIG_LOAD conf=${confPath} addr=${addrSnip} giveaway=${cfg.giveaway_enabled} donation=${cfg.donation_enabled}`);
  if (!cfg.wallet_address)
    actLog('WARN', `CONFIG_NO_ADDR conf=${confPath} — if conf exists, fix ownership: chown grin:grin ${process.env.DROP_CONF || confPath}`);
}

app.listen(PORT, '127.0.0.1', () => {
  actLog('INFO', `Grin Drop [${(cfg.network || 'testnet').toUpperCase()}] listening on 127.0.0.1:${PORT}`);
});
