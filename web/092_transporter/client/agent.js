'use strict';
/**
 * agent.js — Grin Transporter client agent (Script 092).
 *
 * Runs NEXT TO a grin-wallet (same box), talking to its Owner API v3 (ECDH)
 * and Foreign API v2 — the same session model as Grin Drop's server.js. The
 * Transporter server itself never sees keys or plaintext; all wallet crypto
 * happens here at the edge.
 *
 * Commands (config via --config <agent.json> or TRANSPORTER_AGENT_CONF env):
 *   address                  print this wallet's slatepack address (index 0)
 *   status                   transporter /health + own queue depth
 *   send <addr> <grin>       init_send_tx → tx_lock_outputs →
 *                            create_slatepack_message → PUT to recipient queue
 *   poll                     fetch own queue; for each slate:
 *                              S1 → Foreign receive_tx → encrypted reply →
 *                                   PUT to sender's queue → DELETE original
 *                              S2 → finalize_tx → post_tx → DELETE
 *   cancel <tx_slate_id>     cancel_tx — unlock outputs of an unanswered send
 *
 * Output lock policy: this agent locks outputs at SEND time (official
 * tutorial order: init → lock → deliver S1). The reply may arrive days later
 * and the wallet must not re-select the same inputs for another send in the
 * meantime. If a send is never answered, `cancel <tx_slate_id>` releases the
 * outputs.
 *
 * Auth to the Transporter (R8): GET /auth/challenge → sign the nonce string
 * locally with the wallet's ed25519 key (get_slatepack_secret_key, index 0)
 * → POST /auth → bearer token. The key never leaves this process.
 *
 * agent.json:
 *   { "network": "testnet",
 *     "transporter_url": "http://127.0.0.1:7466",
 *     "wallet_owner_url": "http://127.0.0.1:13420/v3/owner",
 *     "wallet_foreign_url": "http://127.0.0.1:13420/v2/foreign",
 *     "wallet_owner_secret": "/path/.owner_api_secret",
 *     "wallet_foreign_secret": "",
 *     "wallet_pass_file": "/path/.wallet_pass",
 *     "min_confirmations": 10 }
 */

const crypto = require('crypto');
const fs     = require('fs');

// ── CLI / config ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function takeFlag(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
const CONF_PATH = takeFlag('--config') || process.env.TRANSPORTER_AGENT_CONF;
const CMD       = argv.shift() || 'help';

function loadConf() {
  if (!CONF_PATH) die('No config: pass --config <agent.json> or set TRANSPORTER_AGENT_CONF');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8')); }
  catch (e) { die(`Cannot read config ${CONF_PATH}: ${e.message}`); }
  for (const k of ['transporter_url', 'wallet_owner_url', 'wallet_foreign_url', 'wallet_pass_file']) {
    if (!raw[k]) die(`Config missing "${k}" in ${CONF_PATH}`);
  }
  raw.min_confirmations = parseInt(raw.min_confirmations, 10) || 10;
  raw.transporter_url   = String(raw.transporter_url).replace(/\/+$/, '');
  return raw;
}

function ts()          { return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC'); }
function log(msg)      { console.log(`[${ts()}] ${msg}`); }
function die(msg)      { console.error(`[${ts()}] ERROR: ${msg}`); process.exit(1); }

// ── Wallet Owner API v3 — ECDH session (same shape as 052 server/wallet.js) ───

function _basicAuth(secretPath) {
  if (!secretPath) return {};
  const secret = fs.readFileSync(secretPath, 'utf8').trim();
  return { Authorization: 'Basic ' + Buffer.from('grin:' + secret).toString('base64') };
}

async function ownerApiSession(cfg) {
  const headers  = { 'Content-Type': 'application/json', ..._basicAuth(cfg.wallet_owner_secret) };
  const ownerUrl = cfg.wallet_owner_url;

  const ecdh = crypto.createECDH('secp256k1');
  ecdh.generateKeys();
  const initRes = await fetch(ownerUrl, {
    method:  'POST',
    headers,
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'init_secure_api',
                              params: { ecdh_pubkey: ecdh.getPublicKey('hex', 'compressed') } }),
    signal:  AbortSignal.timeout(10000),
  }).catch((e) => {
    if (e.cause?.code === 'ECONNREFUSED' || e.code === 'ECONNREFUSED') {
      die(`Wallet owner API not reachable at ${ownerUrl} — is the owner_api session running?`);
    }
    throw e;
  });
  const initJson = JSON.parse(await initRes.text());
  if (initJson.error) die('init_secure_api: ' + (initJson.error.message || JSON.stringify(initJson.error)));
  const serverPub = initJson.result.Ok || initJson.result;
  const sharedKey = ecdh.computeSecret(Buffer.from(serverPub, 'hex'));

  let pass = '';
  try { pass = fs.readFileSync(cfg.wallet_pass_file, 'utf8').replace(/[\r\n]/g, ''); }
  catch { die(`Cannot read wallet pass file ${cfg.wallet_pass_file}`); }

  const token = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'open_wallet',
                                         { name: null, password: pass });
  return { headers, sharedKey, ownerUrl, token };
}

async function encryptedOwnerCall(headers, sharedKey, ownerUrl, method, params) {
  const nonce    = crypto.randomBytes(12);
  const nonceHex = nonce.toString('hex');
  const inner    = JSON.stringify({ jsonrpc: '2.0', id: nonceHex, method, params });
  const cipher   = crypto.createCipheriv('aes-256-gcm', sharedKey, nonce);
  const enc      = Buffer.concat([cipher.update(inner, 'utf8'), cipher.final()]);
  const body_enc = Buffer.concat([enc, cipher.getAuthTag()]).toString('base64');

  const res = await fetch(ownerUrl, {
    method:  'POST',
    headers,
    body:    JSON.stringify({ jsonrpc: '2.0', id: nonceHex, method: 'encrypted_request_v3',
                              params: { nonce: nonceHex, body_enc } }),
    signal:  AbortSignal.timeout(30000),
  });
  const outer = JSON.parse(await res.text());
  if (outer.error) throw new Error(`encrypted_request_v3 (${method}): ${outer.error.message || JSON.stringify(outer.error)}`);

  const { nonce: rNonce, body_enc: rBodyEnc } = outer.result.Ok || outer.result;
  const rBuf     = Buffer.from(rBodyEnc, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', sharedKey, Buffer.from(rNonce, 'hex'));
  decipher.setAuthTag(rBuf.slice(-16));
  const plain    = Buffer.concat([decipher.update(rBuf.slice(0, -16)), decipher.final()]).toString('utf8');

  const innerRes = JSON.parse(plain);
  if (innerRes.error) throw new Error(`Owner API ${method}: ${innerRes.error.message || JSON.stringify(innerRes.error)}`);
  if (innerRes.result && innerRes.result.Err) throw new Error(`Owner API ${method}: ${JSON.stringify(innerRes.result.Err)}`);
  return innerRes.result && innerRes.result.Ok !== undefined ? innerRes.result.Ok : innerRes.result;
}

async function foreignApiCall(cfg, method, params = []) {
  const res = await fetch(cfg.wallet_foreign_url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ..._basicAuth(cfg.wallet_foreign_secret) },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal:  AbortSignal.timeout(30000),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Foreign API ${method}: ${json.error.message || JSON.stringify(json.error)}`);
  if (json.result && json.result.Err) throw new Error(`Foreign API ${method}: ${JSON.stringify(json.result.Err)}`);
  return json.result && json.result.Ok !== undefined ? json.result.Ok : json.result;
}

// ── ed25519 signing — wrap the wallet's raw 32-byte seed as PKCS8 DER ─────────

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function signWithSeed(seedHex, message) {
  // get_slatepack_secret_key returns hex; the dalek SecretKey is the first
  // 32 bytes even if a 64-byte expanded/keypair form ever comes back.
  const clean = String(seedHex).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64,128}$/.test(clean)) throw new Error('Unexpected secret key format from wallet');
  const seed   = Buffer.from(clean.slice(0, 64), 'hex');
  const keyObj = crypto.createPrivateKey({
    key:    Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type:   'pkcs8',
  });
  const sig = crypto.sign(null, Buffer.from(message, 'utf8'), keyObj);
  seed.fill(0);
  return sig.toString('hex');
}

// ── Transporter HTTP helpers ──────────────────────────────────────────────────

async function tspFetch(url, opts = {}) {
  const res  = await fetch(url, { signal: AbortSignal.timeout(20000), ...opts });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(`Transporter ${res.status} ${url}: ${json.error || text.slice(0, 200)}`);
  return json;
}

async function tspAuth(cfg, session, myAddr) {
  const { nonce } = await tspFetch(`${cfg.transporter_url}/auth/challenge?addr=${encodeURIComponent(myAddr)}`);
  const secretHex = await encryptedOwnerCall(session.headers, session.sharedKey, session.ownerUrl,
                                             'get_slatepack_secret_key',
                                             { token: session.token, derivation_index: 0 });
  const signature = signWithSeed(secretHex, nonce);
  const { token } = await tspFetch(`${cfg.transporter_url}/auth`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ addr: myAddr, nonce, signature }),
  });
  return token;
}

async function tspDeposit(cfg, addr, slatepack) {
  return tspFetch(`${cfg.transporter_url}/queue/${encodeURIComponent(addr)}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ slatepack }),
  });
}

// ── Amount: GRIN decimal string → nanogrin string (precise, no float) ─────────

function grinToNano(s) {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(String(s).trim());
  if (!m) die(`Invalid amount "${s}" — use e.g. 1.25 (max 9 decimals)`);
  return (BigInt(m[1]) * 1000000000n + BigInt((m[2] || '').padEnd(9, '0'))).toString();
}

const ADDR_RE = /^(grin1|tgrin1)[ac-hj-np-z02-9]{58}$/;

// ── Commands ──────────────────────────────────────────────────────────────────

async function getOwnAddress(session) {
  return encryptedOwnerCall(session.headers, session.sharedKey, session.ownerUrl,
                            'get_slatepack_address', { token: session.token, derivation_index: 0 });
}

async function cmdAddress(cfg) {
  const session = await ownerApiSession(cfg);
  console.log(await getOwnAddress(session));
}

async function cmdStatus(cfg) {
  const health = await tspFetch(`${cfg.transporter_url}/health`);
  log(`Transporter ${cfg.transporter_url} — ok=${health.ok} network=${health.network} queued(total)=${health.queued} v${health.version}`);
  const session = await ownerApiSession(cfg);
  const myAddr  = await getOwnAddress(session);
  const token   = await tspAuth(cfg, session, myAddr);
  const { slates } = await tspFetch(`${cfg.transporter_url}/queue/${encodeURIComponent(myAddr)}`,
                                    { headers: { Authorization: `Bearer ${token}` } });
  log(`Own address ${myAddr} — ${slates.length} slate(s) waiting`);
}

async function cmdSend(cfg) {
  const dest   = (argv[0] || '').trim().toLowerCase();
  const amount = argv[1];
  if (!ADDR_RE.test(dest)) die('send <recipient slatepack address> <amount GRIN>');
  if (!amount) die('send: amount required (GRIN, e.g. 0.5)');

  const session = await ownerApiSession(cfg);
  const { headers, sharedKey, ownerUrl, token } = session;

  const slate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'init_send_tx', {
    token,
    args: {
      src_acct_name:                   null,
      amount:                          grinToNano(amount),
      minimum_confirmations:           cfg.min_confirmations,
      max_outputs:                     500,
      num_change_outputs:              1,
      selection_strategy_is_use_all:   false,
      target_slate_version:            null,
      // No payment proof: a proof embeds our address inside the slate content
      // and newer wallets then auto-dial our Foreign API on receive, corrupting
      // the context (KernelSumMismatch — see 052 app.js for the war story).
      payment_proof_recipient_address: null,
      ttl_blocks:                      null,
      send_args:                       null,
    },
  });

  // Lock NOW — the reply may take days and the wallet must not re-select these
  // inputs for another send meanwhile. `cancel <tx_slate_id>` releases them.
  await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'tx_lock_outputs', { token, slate });

  // sender_index 0 — embed our address so the payee's agent can route S2 back.
  const slatepack = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'create_slatepack_message', {
    token,
    sender_index: 0,
    recipients:   [dest],
    slate,
  });

  const dep = await tspDeposit(cfg, dest, slatepack);
  log(`SENT ${amount} GRIN → ${dest}`);
  log(`  tx_slate_id=${slate.id}  queue_id=${dep.id}  (expires ${dep.expires_at})`);
  log(`  Outputs are locked until the reply is finalized — release with: agent.js cancel ${slate.id}`);
}

async function cmdCancel(cfg) {
  const txId = (argv[0] || '').trim();
  if (!txId) die('cancel <tx_slate_id>');
  const session = await ownerApiSession(cfg);
  await encryptedOwnerCall(session.headers, session.sharedKey, session.ownerUrl, 'cancel_tx',
                           { token: session.token, tx_id: null, tx_slate_id: txId });
  log(`CANCELLED tx_slate_id=${txId} — locked outputs released.`);
}

async function cmdPoll(cfg) {
  const session = await ownerApiSession(cfg);
  const { headers, sharedKey, ownerUrl, token } = session;
  const myAddr   = await getOwnAddress(session);
  const tspToken = await tspAuth(cfg, session, myAddr);
  const authHdr  = { Authorization: `Bearer ${tspToken}` };

  const { slates } = await tspFetch(`${cfg.transporter_url}/queue/${encodeURIComponent(myAddr)}`,
                                    { headers: authHdr });
  if (!slates.length) { log(`POLL ${myAddr} — queue empty`); return; }
  log(`POLL ${myAddr} — ${slates.length} slate(s)`);

  let done = 0, skipped = 0, failed = 0;
  for (const item of slates) {
    const del = () => tspFetch(`${cfg.transporter_url}/queue/${encodeURIComponent(myAddr)}/${item.id}`,
                               { method: 'DELETE', headers: authHdr });
    try {
      const meta = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'decode_slatepack_message',
                                            { token, message: item.slatepack, secret_indices: [0] });
      const slate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'slate_from_slatepack_message',
                                             { token, message: item.slatepack, secret_indices: [0] });
      const state = slate.sta || '';

      if (state === 'S1') {
        // Incoming payment. Need the sender's address to route the reply.
        const sender = typeof meta.sender === 'string' && ADDR_RE.test(meta.sender) ? meta.sender : null;
        if (!sender) {
          log(`  #${item.id} S1 has no sender address — cannot route reply, skipping (will expire by TTL)`);
          skipped++;
          continue;
        }
        let reply;
        try {
          reply = await foreignApiCall(cfg, 'receive_tx', [slate, null, null]);
        } catch (e) {
          if (/already/i.test(e.message)) {
            // Crash-recovery dupe: received on an earlier run but never consumed.
            log(`  #${item.id} S1 already received earlier — removing from queue`);
            await del();
            done++;
            continue;
          }
          throw e;
        }
        const replyPack = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'create_slatepack_message',
                                                   { token, sender_index: 0, recipients: [sender], slate: reply });
        // Deposit the reply BEFORE consuming the original. If this PUT fails we
        // keep the original; the retry path lands in the /already/ branch above,
        // so log the armored reply for manual delivery as a last resort.
        try {
          await tspDeposit(cfg, sender, replyPack);
        } catch (e) {
          log(`  #${item.id} CRITICAL: received ${nanoStr(slate.amt)} GRIN but reply deposit failed: ${e.message}`);
          log(`  Deliver this reply slatepack to ${sender} manually:\n${replyPack}`);
          failed++;
          continue;
        }
        await del();
        log(`  #${item.id} S1 received ${nanoStr(slate.amt)} GRIN from ${sender.slice(0, 12)}… — reply queued`);
        done++;

      } else if (state === 'S2') {
        // Reply to our earlier send — finalize + broadcast.
        // Outputs were locked at send time; a second lock errors harmlessly on
        // some builds, so tolerate it (covers a crash between init and lock).
        try {
          await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'tx_lock_outputs', { token, slate });
        } catch { /* already locked */ }
        const finalSlate = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'finalize_tx', { token, slate });
        try {
          await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'post_tx',
                                   { token, slate: finalSlate, fluff: true });
          log(`  #${item.id} S2 finalized + broadcast tx=${finalSlate.id || slate.id}`);
        } catch (e) {
          // Signed in the wallet either way — re-broadcast manually if needed.
          log(`  #${item.id} S2 finalized but broadcast failed (${e.message}) — tx is signed, re-post manually`);
        }
        await del();
        done++;

      } else {
        log(`  #${item.id} unsupported slate state "${state}" — leaving in queue`);
        skipped++;
      }
    } catch (e) {
      log(`  #${item.id} FAILED: ${e.message} — leaving in queue for retry`);
      failed++;
    }
  }
  log(`POLL done — processed=${done} skipped=${skipped} failed=${failed}`);
  if (failed) process.exitCode = 1;
}

function nanoStr(amt) {
  try {
    const n = BigInt(String(amt || 0));
    const whole = n / 1000000000n, frac = (n % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : `${whole}`;
  } catch { return '?'; }
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

const HELP = `Grin Transporter agent — usage:
  agent.js [--config agent.json] address
  agent.js [--config agent.json] status
  agent.js [--config agent.json] send <recipient_address> <amount_grin>
  agent.js [--config agent.json] poll
  agent.js [--config agent.json] cancel <tx_slate_id>
Config path may also come from the TRANSPORTER_AGENT_CONF env variable.`;

(async () => {
  if (CMD === 'help' || CMD === '--help' || CMD === '-h') { console.log(HELP); return; }
  const cfg = loadConf();
  switch (CMD) {
    case 'address': await cmdAddress(cfg); break;
    case 'status':  await cmdStatus(cfg);  break;
    case 'send':    await cmdSend(cfg);    break;
    case 'poll':    await cmdPoll(cfg);    break;
    case 'cancel':  await cmdCancel(cfg);  break;
    default: console.log(HELP); process.exitCode = 2;
  }
})().catch((e) => die(e.message));
