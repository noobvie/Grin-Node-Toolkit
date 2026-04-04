'use strict';
/**
 * app.js — Grin Drop — Express application
 * =========================================
 *
 * Public endpoints:
 *   GET  /api/status          wallet balance + site config + ?addr= next_claim_at
 *   GET  /api/public-stats    total given/received, claim/donation counts
 *   GET  /api/qr              PNG QR code for drop wallet address
 *   GET  /api/csrf            ephemeral CSRF token for frontend forms
 *   POST /api/claim           {grin_address} → {claim_id, slatepack, expires_at}
 *   POST /api/finalize        {claim_id, response_slate} → {status, tx_slate_id}
 *
 * Donation endpoints:
 *   POST /api/donate/receive  {send_slate} → {response_slatepack}          Tab 2
 *   POST /api/donate/invoice  {amount, address} → {invoice_id, slatepack}  Tab 3 step 1
 *   POST /api/donate/finalize {invoice_id, response_slate} → {status}      Tab 3 step 2
 *
 * Admin endpoints (all under /<admin_secret_path>/):
 *   GET  /<secret>/                       redirect → /<secret>/admin/
 *   GET  /<secret>/admin/:page            serve static admin HTML (secret validated)
 *   GET  /<secret>/api/stats              JSON stats summary
 *   GET  /<secret>/api/transactions       JSON paginated claims
 *   GET  /<secret>/api/donations          JSON donations list
 *   GET  /<secret>/api/settings           JSON current settings
 *   POST /<secret>/api/settings           save settings
 *   POST /<secret>/api/maintenance        toggle maintenance mode
 *   POST /<secret>/api/add-donation       record manual donation
 *   POST /<secret>/api/expire-invoices    manually expire old pending invoices
 *   GET  /<secret>/export/claims.csv      CSV export of confirmed claims
 *
 * Background intervals:
 *   Every 30s  — cancel expired waiting_finalize claims
 *   Every 60s  — expire timed-out pending invoices
 */

const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const QRCode  = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const { loadConfig, writeConfigKey, saveConfig } = require('./config');
const db = require('./db');
const {
  foreignApiCall,
  ownerApiSession,
  encryptedOwnerCall,
  checkWalletPort,
} = require('./wallet');

// ── App setup ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '16kb' }));

// Static web files (public_html/ is one level up from server/)
const PUBLIC_DIR = path.join(__dirname, '..', 'public_html');
app.use(express.static(PUBLIC_DIR));

// ── CSRF ────────────────────────────────────────────────────────────────────────

// Ephemeral token — regenerated on each process restart. Frontend fetches it
// from GET /api/csrf before any state-changing request.
const CSRF_TOKEN = crypto.randomBytes(16).toString('hex');

function csrfOk(req) {
  const token = String((req.body && req.body._csrf) || req.headers['x-csrf-token'] || '');
  if (token.length !== CSRF_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(CSRF_TOKEN));
  } catch { return false; }
}

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

const GRIN_ADDR_RE = /^(grin1|tgrin1)[a-z0-9]{40,}$/;

function validateSlatepack(input) {
  if (!input || typeof input !== 'string') return false;
  if (input.length > 4096) return false;
  return input.includes('BEGINSLATEPACK') && input.includes('ENDSLATEPACK');
}

function nextClaimIso(address) {
  const last = db.lastActiveClaim(address);
  if (!last) return null;
  const cfg = loadConfig();
  const windowMs = (cfg.claim_window_hours || 24) * 3_600_000;
  const created  = new Date(last.created_at).getTime();
  const nextAllowed = new Date(created + windowMs);
  if (Date.now() >= nextAllowed.getTime()) return null;
  return nextAllowed.toISOString();
}

// ── Maintenance middleware ──────────────────────────────────────────────────────

app.use((req, res, next) => {
  const cfg = loadConfig();
  if (!cfg.maintenance_mode) return next();
  const adminP = cfg.admin_secret_path || '';
  // Always allow: /api/*, /<secret>/*
  if (req.path.startsWith('/api/') || (adminP && req.path.startsWith('/' + adminP + '/'))) {
    return next();
  }
  // For HTML requests return 503 with maintenance message
  if (req.accepts('html')) {
    return res.status(503).send(`<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:4rem">
      <h1>${cfg.drop_name || 'Grin Drop'}</h1>
      <p>${cfg.maintenance_message || 'We\'ll be back soon.'}</p>
    </body></html>`);
  }
  return res.status(503).json({ error: cfg.maintenance_message || 'Maintenance mode' });
});

// ── Admin path guard ────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const cfg = loadConfig();
  const expected = cfg.admin_secret_path || '';
  const provided  = req.params.secret || '';
  if (!expected || !crypto.timingSafeEqual(
    Buffer.from(provided.padEnd(64)),
    Buffer.from(expected.padEnd(64)),
  )) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/csrf ────────────────────────────────────────────────────────────────
app.get('/api/csrf', (req, res) => {
  res.json({ token: CSRF_TOKEN });
});

// GET /api/status ──────────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const cfg = loadConfig();

  // Wallet balance via Owner API (non-fatal if wallet is down)
  let balance = 0.0;
  let walletAddress = cfg.wallet_address || '';
  try {
    const session = await ownerApiSession();
    const { headers, sharedKey, ownerUrl, token } = session;
    const info = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'retrieve_summary_info', {
      token,
      minimum_confirmations: 1,
      refresh_from_node: false,
    });
    balance = (parseInt(info.amount_currently_spendable || 0, 10)) / 1_000_000_000;
    // Also refresh address
    try {
      const addrResult = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'get_slatepack_address', {
        token,
        derivation_index: 0,
      });
      if (addrResult) walletAddress = addrResult;
    } catch {}
  } catch (e) {
    actLog('WARN', `WALLET_FAIL cmd=status err=${e.message}`);
  }

  const payload = {
    drop_name:           cfg.drop_name,
    claim_amount:        cfg.claim_amount_grin,
    wallet_address:      walletAddress,
    wallet_balance:      Math.round(balance * 1e9) / 1e9,
    claims_today:        db.countClaimsToday(),
    claims_total:        db.countClaimsTotal(),
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
app.get('/api/public-stats', (req, res) => {
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

// GET /api/qr ──────────────────────────────────────────────────────────────────
app.get('/api/qr', async (req, res) => {
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

  const nextAt = nextClaimIso(address);
  if (nextAt) {
    actLog('WARN', `RATE_LIMIT addr=${truncAddr(address)} next_claim=${nextAt}`);
    return err(res, `Already claimed. Next claim available at ${nextAt}`, 429);
  }

  const amount     = parseFloat(cfg.claim_amount_grin) || 2.0;
  const timeoutMin = parseInt(cfg.finalize_timeout_min, 10) || 5;
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
        payment_proof_recipient_address:  address,
        ttl_blocks:                       null,
        send_args:                        null,
      },
    });

    // create_slatepack_message — encode to BEGINSLATEPACK...ENDSLATEPACK
    slatepack = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'create_slatepack_message', {
      token,
      sender_index: 0,
      recipients:   [],
      slate,
    });
  } catch (e) {
    db.setClaimStatus(claimId, 'failed');
    actLog('ERROR', `WALLET_FAIL cmd=init_send claim_id=${claimId} err=${e.message}`);
    return err(res, `Wallet error: ${e.message}`, 503);
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

    // Decode user's response slatepack
    const slate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'slate_from_slatepack_message', {
      token,
      secret_indices: [0],
      message:        responseSplate,
    });

    // Finalize and broadcast
    const finalResult = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'finalize_tx', {
      token,
      slate,
    });
    txSlateId = (finalResult && finalResult.id) ? String(finalResult.id) : '';
  } catch (e) {
    actLog('ERROR', `WALLET_FAIL cmd=finalize claim_id=${claimId} err=${e.message}`);
    return err(res, `Wallet error: ${e.message}`, 503);
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
  if (!validateSlatepack(sendSlate)) return err(res, 'Invalid slatepack — must be BEGINSLATEPACK...ENDSLATEPACK (max 4096 bytes)');

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

    // 2. Foreign API receive_tx — no LMDB conflict with Owner API calls
    const responseSlate = await foreignApiCall('receive_tx', [slate, null, null]);

    // 3. Encode response slate → slatepack
    const responseSlatepack = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'create_slatepack_message', {
      token,
      sender_index: 0,
      recipients:   [],
      slate:        responseSlate,
    });

    // Record pending donation — amount confirmed manually by admin
    db.createSlatepackDonation('');
    actLog('INFO', 'DONATE_RECEIVE_OK (pending admin confirmation)');

    res.json({ response_slatepack: responseSlatepack });
  } catch (e) {
    actLog('ERROR', `DONATE_RECEIVE_FAIL err=${e.message}`);
    return err(res, `Wallet error: ${e.message}`, 503);
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
  if (!address || !GRIN_ADDR_RE.test(address)) return err(res, 'Invalid grin address');

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
    return err(res, `Wallet error: ${e.message}`, 503);
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

    // 2. Finalize and broadcast
    const finalResult = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'finalize_tx', {
      token,
      slate,
    });
    txId = (finalResult && finalResult.id) ? String(finalResult.id) : '';
  } catch (e) {
    actLog('ERROR', `DONATE_FINALIZE_FAIL invoice_id=${invoiceId} err=${e.message}`);
    return err(res, `Wallet error: ${e.message}`, 503);
  }

  db.confirmInvoiceDonation(invoiceId, txId);
  actLog('INFO', `DONATE_FINALIZE_OK invoice_id=${invoiceId} tx=${txId || '(unknown)'}`);

  res.json({ status: 'confirmed', tx_id: txId });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ENDPOINTS  (all require /:secret/ prefix, timing-safe comparison)
// ─────────────────────────────────────────────────────────────────────────────

// GET /:secret/ — redirect to admin dashboard
app.get('/:secret/', requireAdmin, (req, res) => {
  res.redirect(`/${req.params.secret}/admin/`);
});

// GET /:secret/admin/:page — serve static admin HTML pages
app.get('/:secret/admin/:page?', requireAdmin, (req, res) => {
  const page = req.params.page || 'index.html';
  const adminDir = path.resolve(PUBLIC_DIR, 'admin');
  const file = path.resolve(adminDir, page.endsWith('.html') ? page : page + '.html');
  if (!file.startsWith(adminDir + path.sep)) return res.status(400).send('Bad request');
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  res.sendFile(file);
});

// GET /:secret/api/stats
app.get('/:secret/api/stats', requireAdmin, (req, res) => {
  const cfg   = loadConfig();
  const stats = db.getStatsSummary();
  res.json({ ...stats, network: cfg.network || 'testnet', drop_name: cfg.drop_name });
});

// GET /:secret/api/transactions
app.get('/:secret/api/transactions', requireAdmin, (req, res) => {
  const perPage = 25;
  const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
  const filter  = (req.query.status || '').trim();
  const search  = (req.query.search || '').trim();

  let rows, total;
  if (search) {
    const result = db.searchClaims(search, page, perPage);
    rows  = result.rows;
    total = result.total;
  } else {
    rows  = db.getClaimsPaginated(page, perPage, filter);
    total = db.countClaimsFiltered(filter);
  }

  res.json({ claims: rows, page, total_pages: Math.max(1, Math.ceil(total / perPage)), total });
});

// GET /:secret/api/donations
app.get('/:secret/api/donations', requireAdmin, (req, res) => {
  const donations = db.getDonationsList(100);
  res.json({ donations, total_received: db.getTotalReceivedGrin() });
});

// GET /:secret/api/settings
app.get('/:secret/api/settings', requireAdmin, (req, res) => {
  res.json({ settings: loadConfig(), csrf: CSRF_TOKEN });
});

// POST /:secret/api/settings
app.post('/:secret/api/settings', requireAdmin, (req, res) => {
  if (!csrfOk(req)) return res.status(403).json({ error: 'CSRF validation failed' });
  const body = req.body || {};
  const cfg  = loadConfig();

  const strings = ['drop_name','site_description','og_image_url','maintenance_message','theme_default'];
  const numbers = ['claim_amount_grin','claim_window_hours','finalize_timeout_min','donation_invoice_timeout'];
  const bools   = ['giveaway_enabled','donation_enabled','maintenance_mode','show_public_stats'];

  for (const k of strings) if (body[k] !== undefined) cfg[k] = String(body[k]).trim();
  for (const k of numbers) if (body[k] !== undefined) { const n = parseFloat(body[k]); if (!isNaN(n)) cfg[k] = n; }
  for (const k of bools)   if (body[k] !== undefined) cfg[k] = (body[k] === true || body[k] === 'true' || body[k] === 'on');

  saveConfig(cfg);
  actLog('INFO', 'ADMIN_SETTINGS_SAVED');
  res.json({ saved: true, settings: cfg });
});

// POST /:secret/api/maintenance — toggle maintenance mode
app.post('/:secret/api/maintenance', requireAdmin, (req, res) => {
  if (!csrfOk(req)) return res.status(403).json({ error: 'CSRF validation failed' });
  const cfg = loadConfig();
  cfg.maintenance_mode = !cfg.maintenance_mode;
  saveConfig(cfg);
  actLog('INFO', `ADMIN_MAINTENANCE mode=${cfg.maintenance_mode}`);
  res.json({ maintenance_mode: cfg.maintenance_mode });
});

// POST /:secret/api/add-donation — record a manual donation
app.post('/:secret/api/add-donation', requireAdmin, (req, res) => {
  if (!csrfOk(req)) return res.status(403).json({ error: 'CSRF validation failed' });
  const body   = req.body || {};
  const amount = parseFloat(body.amount);
  if (!amount || amount <= 0) return err(res, 'amount must be > 0');
  const id = db.addManualDonation(
    amount,
    String(body.tx_id       || ''),
    String(body.from_address || ''),
    String(body.note        || ''),
  );
  actLog('INFO', `ADMIN_DONATION_ADDED id=${id} amount=${amount}`);
  res.json({ id, amount });
});

// POST /:secret/api/expire-invoices — manually expire stale pending invoices
app.post('/:secret/api/expire-invoices', requireAdmin, (req, res) => {
  if (!csrfOk(req)) return res.status(403).json({ error: 'CSRF validation failed' });
  const expired = db.expireOldInvoices();
  actLog('INFO', `ADMIN_EXPIRE_INVOICES count=${expired}`);
  res.json({ expired });
});

// GET /:secret/export/claims.csv
app.get('/:secret/export/claims.csv', requireAdmin, (req, res) => {
  const rows = db.getConfirmedClaimsForExport();
  const lines = [
    'id,address,amount,confirmed_at,tx_slate_id',
    ...rows.map(r =>
      [r.id, r.grin_address, r.amount, r.confirmed_at || '', r.tx_slate_id || ''].join(',')
    ),
  ];
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename=claims.csv');
  res.send(lines.join('\n'));
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

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────

const cfg  = loadConfig();
const PORT = parseInt(cfg.service_port, 10) || 3004;

app.listen(PORT, '127.0.0.1', () => {
  actLog('INFO', `Grin Drop [${(cfg.network || 'testnet').toUpperCase()}] listening on 127.0.0.1:${PORT}`);
});
