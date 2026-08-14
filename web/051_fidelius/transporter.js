'use strict';
/**
 * transporter.js — Grin Transporter (Script 093) client, embedded in Fidelius (051).
 *
 * WHY THIS IS NOT web/093_transporter/client/agent.js
 * ---------------------------------------------------
 * The standalone agent opens its own Owner API session and reads the passphrase
 * from `wallet_pass_file`. Fidelius deliberately keeps the passphrase in PROCESS
 * MEMORY ONLY (see the getPassphrase() comment in server.js) — there is no
 * `.wallet_pass` on disk, and adding one to satisfy the agent would throw away
 * the single property that makes Fidelius safer than a daemon. So the agent's
 * protocol logic is ported here instead, and every wallet call is made through a
 * caller-supplied closure bound to the session server.js already holds.
 *
 * This module therefore knows NOTHING about passphrases, the registry, or HTTP
 * routing. It is handed:
 *   call(method, params)       → encryptedOwnerCall bound to an open session
 *   foreign(method, params)    → wallet Foreign API v2 call bound to a wallet
 * and it returns plain data. That keeps it unit-testable without a wallet.
 *
 * ─── Protocol deltas vs Fidelius's own copy-paste send (all deliberate) ───────
 * 1. sender_index 0 + recipients [dest]. Fidelius's manual send uses
 *    `sender_index: null, recipients: []`, which produces an UNENCRYPTED slate
 *    with no sender field. Over a relay that is wrong twice: the blob is
 *    readable by the server, and the payee's poll cannot learn where to send S2
 *    back — it would log "no sender address", skip, and eventually REAP the
 *    payment. Routing the reply requires an embedded sender, full stop.
 * 2. Outputs are locked at SEND, not at finalize. The manual flow can lock late
 *    because the human is holding the slate; here the reply may land days later
 *    and the wallet must not re-select those inputs for another send meanwhile.
 *    An unanswered send is released with cancel_tx (Fidelius already exposes it).
 * 3. payment_proof_recipient_address is ALWAYS null on this path. A proof embeds
 *    our address in the slate and newer wallets then auto-dial the sender's
 *    Foreign API on receive, corrupting the context (KernelSumMismatch — the
 *    same trap documented in 059). The UI must not offer a proof field here.
 */

const crypto = require('crypto');

// Bech32 slatepack address. Fidelius's own ADDR_RE is deliberately loose (it
// accepts mixed case for address-book display); this one is strict and lower
// only, because it guards what we hand to a remote queue. The Transporter
// lowercases and re-validates server-side anyway — matching it here means a bad
// address fails locally with a clear message instead of as a remote 400.
const ADDR_RE = /^(grin1|tgrin1)[ac-hj-np-z02-9]{58}$/;

// Deliveries after which a slate we have never been able to act on is retired.
// Anyone may deposit into an open queue, so some entries are simply junk; left
// alone they are re-decoded on every poll until the TTL, and — because the
// Transporter serves oldest-undelivered-first — they would also hold the head
// of the delivery window. `picked_up` counts deliveries BEFORE this one, so
// this fires on the 6th sighting.
//
// Reaping is only safe when the WALLET is demonstrably healthy: a wallet down
// for six polls would otherwise delete real, payable slates. A raw error cannot
// tell "junk blob" from "my wallet is broken", so a failure path re-probes the
// wallet and only reaps when the probe succeeds.
const REAP_AFTER_PICKUPS = 5;

// Re-auth this long before the server's 15-minute token expiry, so a poll that
// starts near the boundary doesn't 401 halfway through.
const TOKEN_REUSE_MS = 12 * 60 * 1000;

// ── ed25519 signing — wrap the wallet's raw 32-byte seed as PKCS8 DER ─────────

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function signWithSeed(seedHex, message) {
    // get_slatepack_secret_key returns hex; the dalek SecretKey is the first 32
    // bytes even if a 64-byte expanded/keypair form ever comes back.
    const clean = String(seedHex).replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{64,128}$/.test(clean)) throw new Error('Unexpected secret key format from wallet');
    const seed   = Buffer.from(clean.slice(0, 64), 'hex');
    const keyObj = crypto.createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8',
    });
    const sig = crypto.sign(null, Buffer.from(message, 'utf8'), keyObj);
    seed.fill(0);
    return sig.toString('hex');
}

// ── Amount: GRIN decimal string → nanogrin string (exact, never float) ───────
// The UI's number input hands us a string; parsing it as a float and multiplying
// by 1e9 loses precision at 9 decimals. Keep it in BigInt the whole way.
function grinToNano(s) {
    const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(String(s).trim());
    if (!m) throw new Error('Invalid amount "' + s + '" — use e.g. 1.25 (max 9 decimals)');
    const nano = BigInt(m[1]) * 1000000000n + BigInt((m[2] || '').padEnd(9, '0'));
    if (nano <= 0n) throw new Error('Amount must be greater than zero');
    return nano.toString();
}

function nanoStr(amt) {
    try {
        const n = BigInt(String(amt || 0));
        const whole = n / 1000000000n;
        const frac  = (n % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
        return frac ? whole + '.' + frac : String(whole);
    } catch { return '?'; }
}

function addressNetwork(addr) {
    if (/^tgrin1/.test(addr)) return 'testnet';
    if (/^grin1/.test(addr))  return 'mainnet';
    return null;
}

// ── Transporter HTTP ─────────────────────────────────────────────────────────

async function tspFetch(url, opts = {}) {
    let res;
    try {
        res = await fetch(url, { signal: AbortSignal.timeout(20000), ...opts });
    } catch (e) {
        if (e.name === 'TimeoutError') throw new Error('Transporter did not respond within 20s — is ' + url.split('/').slice(0, 3).join('/') + ' reachable?');
        if (e.cause?.code === 'ECONNREFUSED' || e.code === 'ECONNREFUSED')
            throw new Error('Transporter refused the connection — check the URL and that the service is running');
        throw new Error('Transporter unreachable: ' + (e.message || String(e)));
    }
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* non-JSON error page (nginx, etc.) */ }
    if (!res.ok) {
        const e = new Error('Transporter ' + res.status + ': ' + (json.error || text.slice(0, 200)));
        e.status = res.status;
        throw e;
    }
    return json;
}

/**
 * A Transporter endpoint bound to one base URL.
 *
 * Token caching matters here: without it every poll costs a challenge, a
 * signature and an /auth. But the server's HMAC secret is PER BOOT, so a
 * Transporter restart silently invalidates a cached token — every authenticated
 * call retries ONCE through a fresh handshake on 401 rather than surfacing a
 * spurious "expired" error to the operator.
 */
function makeClient(baseUrl) {
    const base = String(baseUrl).replace(/\/+$/, '');
    // Keyed BY ADDRESS, not a single slot: Fidelius is multi-wallet and several
    // wallets normally share one Transporter, so a one-entry cache would evict
    // on every alternation and re-run the full challenge/sign/auth handshake for
    // each call — the exact case of two wallets paying each other.
    const tokens = new Map();   // addr → { token, at }

    async function health() { return tspFetch(base + '/health'); }

    async function authenticate(call, myAddr) {
        const { nonce } = await tspFetch(base + '/auth/challenge?addr=' + encodeURIComponent(myAddr));
        const secretHex = await call('get_slatepack_secret_key', { derivation_index: 0 });
        const signature = signWithSeed(secretHex, nonce);
        const { token } = await tspFetch(base + '/auth', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ addr: myAddr, nonce, signature }),
        });
        tokens.set(myAddr, { token, at: Date.now() });
        return token;
    }

    async function token(call, myAddr) {
        const c = tokens.get(myAddr);
        if (c && (Date.now() - c.at) < TOKEN_REUSE_MS) return c.token;
        return authenticate(call, myAddr);
    }

    // Run an authenticated request; on 401 drop the cached token and retry once.
    async function withAuth(call, myAddr, fn) {
        try {
            return await fn(await token(call, myAddr));
        } catch (e) {
            if (e.status !== 401) throw e;
            tokens.delete(myAddr);
            return fn(await authenticate(call, myAddr));
        }
    }

    // Deposits are UNAUTHENTICATED by design — anyone may write to any queue,
    // which is what lets a stranger pay you. Reads and deletes are not.
    async function deposit(addr, slatepack) {
        return tspFetch(base + '/queue/' + encodeURIComponent(addr), {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ slatepack }),
        });
    }

    async function list(call, myAddr) {
        return withAuth(call, myAddr, (t) =>
            tspFetch(base + '/queue/' + encodeURIComponent(myAddr), { headers: { Authorization: 'Bearer ' + t } }));
    }

    async function remove(call, myAddr, id) {
        return withAuth(call, myAddr, (t) =>
            tspFetch(base + '/queue/' + encodeURIComponent(myAddr) + '/' + encodeURIComponent(id),
                     { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } }));
    }

    function forgetToken(addr) { if (addr) tokens.delete(addr); else tokens.clear(); }

    return { base, health, deposit, list, remove, forgetToken };
}

// ── Own address ──────────────────────────────────────────────────────────────

async function ownAddress(call) {
    return call('get_slatepack_address', { derivation_index: 0 });
}

/**
 * Confirm the endpoint really is a Transporter for this wallet's network.
 *
 * A queue is keyed by address and an address carries its own HRP, so a testnet
 * wallet pointed at a mainnet Transporter does not error — it deposits into a
 * queue on a server whose owner-side validator rejects the HRP, or worse, sits
 * in a queue nobody polls. Catching the mismatch at CONFIG time is the whole
 * point of this check; do not make it advisory.
 */
async function checkEndpoint(client, network) {
    const h = await client.health();
    if (!h || typeof h !== 'object' || !('network' in h))
        throw new Error('That URL answered, but it is not a Grin Transporter (no /health network field)');
    if (h.network !== network)
        throw new Error('NETWORK_MISMATCH: this Transporter serves ' + String(h.network).toUpperCase()
                      + ' but the wallet is ' + network.toUpperCase() + '. Use the ' + network + ' Transporter.');
    return h;
}

// ── Send ─────────────────────────────────────────────────────────────────────

/**
 * Build S1 and drop it in the recipient's queue.
 *
 * Ordering is load-bearing and follows the official tutorial: init → LOCK →
 * armor → deposit. Locking before the deposit means that even if the deposit
 * fails we are in a consistent, recoverable state (funds reserved, tx visible
 * in history, cancellable). Locking after a successful deposit would leave a
 * window where the payee can reply to a slate whose inputs we might already
 * have spent elsewhere.
 */
async function send({ call, client, network, dest, amount, minConfirmations = 10 }) {
    const to = String(dest || '').trim().toLowerCase();
    if (!ADDR_RE.test(to)) throw new Error('Invalid recipient address (expected grin1… for mainnet or tgrin1… for testnet)');

    const destNet = addressNetwork(to);
    if (destNet && destNet !== network)
        throw new Error('NETWORK_MISMATCH: this wallet is ' + network.toUpperCase()
                      + ' but the recipient address is ' + destNet.toUpperCase()
                      + '. Refusing to send — these funds would be unrecoverable.');

    const amountNano = grinToNano(amount);

    // Verify the endpoint BEFORE touching the wallet. A failed health check
    // after init_send_tx would leave outputs locked for a send that never left.
    await checkEndpoint(client, network);

    const slate = await call('init_send_tx', {
        args: {
            src_acct_name:                   null,
            amount:                          amountNano,
            minimum_confirmations:           minConfirmations,
            max_outputs:                     500,
            num_change_outputs:              1,
            selection_strategy_is_use_all:   false,
            target_slate_version:            null,
            payment_proof_recipient_address: null,   // see header note 3
            ttl_blocks:                      null,
            send_args:                       null,
        },
    });

    // Lock now — the reply may take days. cancel_tx releases these.
    await call('tx_lock_outputs', { slate, participant_id: 0 });

    // sender_index 0 → encrypt to `dest` AND embed our address so the payee's
    // poll can route S2 home. Without this the payment is undeliverable.
    const slatepack = await call('create_slatepack_message', {
        sender_index: 0, recipients: [to], slate,
    });

    let dep;
    try {
        dep = await client.deposit(to, slatepack);
    } catch (e) {
        // Outputs are locked and the tx is in history; the operator can cancel.
        const err = new Error('Send prepared but the Transporter would not accept it: ' + e.message
                            + ' — outputs are locked, cancel tx ' + slate.id + ' to release them.');
        err.txSlateId = slate.id;
        err.locked = true;
        throw err;
    }

    return {
        txSlateId:  slate.id,
        queueId:    dep.id,
        expiresAt:  dep.expires_at || null,
        duplicate:  !!dep.duplicate,
        amount:     nanoStr(amountNano),
        dest:       to,
    };
}

// ── Poll ─────────────────────────────────────────────────────────────────────

/**
 * Drain our own queue once.
 *
 * `log` is a per-line sink so the caller decides where this goes (server log,
 * SSE, a UI transcript). Returns counters plus the lines, so a manual "Check
 * now" from the browser can show exactly what happened.
 */
async function poll({ call, foreign, client, myAddr, onLog, onProven }) {
    const lines = [];
    const log = (m) => { lines.push(m); if (onLog) onLog(m); };

    const { slates } = await client.list(call, myAddr);
    if (!slates || !slates.length) return { processed: 0, skipped: 0, failed: 0, removed: 0, depth: 0, lines };

    log(slates.length + ' slate(s) waiting');
    let processed = 0, skipped = 0, failed = 0, removed = 0;

    // Health probe for the reaper. BOTH halves of the wallet must answer.
    //
    // Probing only the Owner API was a money bug: an S1 fails at foreign
    // receive_tx, which needs the FOREIGN LISTENER, but the probe asked the
    // OWNER API — which is necessarily up, because the poll itself got this far
    // through it. Owner up + listener down is the ordinary state of an unlocked
    // wallet whose listener was never started (the UI has a dedicated warning
    // for it), so every real incoming payment was reaped after 5 deliveries —
    // about six minutes at the default interval. Never narrow this back to one
    // call: the probe has to cover whatever the failing step actually used.
    const walletHealthy = async () => {
        try { await ownAddress(call); } catch { return false; }
        try { await foreign('check_version', []); } catch { return false; }
        return true;
    };

    for (const item of slates) {
        const del = () => client.remove(call, myAddr, item.id);
        // Both must hold before deleting something we could not read: enough
        // deliveries AND a wallet that answers right now.
        const reapable = async () => {
            if ((item.picked_up || 0) < REAP_AFTER_PICKUPS) return false;
            return walletHealthy();
        };

        try {
            const meta  = await call('decode_slatepack_message', { message: item.slatepack, secret_indices: [0] });
            const slate = await call('slate_from_slatepack_message', { message: item.slatepack, secret_indices: [0] });
            const state = slate.sta || '';

            if (state === 'S1') {
                const sender = typeof meta.sender === 'string' && ADDR_RE.test(meta.sender) ? meta.sender : null;
                if (!sender) {
                    // Decode SUCCEEDED, so the wallet is fine and this can never
                    // become routable — unusable by construction, no probe needed.
                    if ((item.picked_up || 0) >= REAP_AFTER_PICKUPS) {
                        log('#' + item.id + ' S1 still has no sender address after ' + item.picked_up + ' deliveries — removing');
                        await del(); removed++;
                    } else {
                        log('#' + item.id + ' S1 has no sender address — cannot route the reply, skipping');
                        skipped++;
                    }
                    continue;
                }

                let reply;
                try {
                    reply = await foreign('receive_tx', [slate, null, null]);
                } catch (e) {
                    if (/already/i.test(e.message)) {
                        // Crash-recovery dupe: received on an earlier run, never consumed.
                        log('#' + item.id + ' S1 was already received earlier — removing from queue');
                        await del(); processed++;
                        continue;
                    }
                    throw e;
                }

                const replyPack = await call('create_slatepack_message', {
                    sender_index: 0, recipients: [sender], slate: reply,
                });

                // Deposit the reply BEFORE consuming the original: if this PUT
                // fails we still hold the original, and the retry lands in the
                // /already/ branch above. Log the armored reply so a stuck one
                // can still be delivered by hand.
                try {
                    await client.deposit(sender, replyPack);
                } catch (e) {
                    log('#' + item.id + ' CRITICAL: received ' + nanoStr(slate.amt) + ' GRIN but the reply deposit failed: ' + e.message);
                    log('Deliver this reply slatepack to ' + sender + ' manually:\n' + replyPack);
                    failed++;
                    continue;
                }
                await del();
                log('#' + item.id + ' received ' + nanoStr(slate.amt) + ' GRIN from ' + sender.slice(0, 12) + '… — reply queued');
                processed++;

            } else if (state === 'S2') {
                // Reply to our earlier send. Outputs were locked at send time; a
                // second lock errors harmlessly on some builds, so tolerate it
                // (covers a crash between init and lock).
                try { await call('tx_lock_outputs', { slate, participant_id: 0 }); } catch { /* already locked */ }
                const finalSlate = await call('finalize_tx', { slate });
                // Their reply finalized, so the address we sent to is real and
                // actively polled — the first hard evidence we get on this rail.
                if (onProven && typeof meta.sender === 'string' && ADDR_RE.test(meta.sender)) {
                    try { onProven(meta.sender); } catch { /* bookkeeping only */ }
                }
                try {
                    await call('post_tx', { slate: finalSlate, fluff: true });
                    log('#' + item.id + ' finalized + broadcast tx=' + (finalSlate.id || slate.id));
                } catch (e) {
                    // Signed either way — re-broadcast from History if needed.
                    log('#' + item.id + ' finalized but the broadcast failed (' + e.message + ') — the tx is signed, re-post it manually');
                }
                await del();
                processed++;

            } else {
                // Decode succeeded; the state is simply not one we act on, and it
                // never will be. Retire it once it has had its chances.
                if ((item.picked_up || 0) >= REAP_AFTER_PICKUPS) {
                    log('#' + item.id + ' slate state "' + state + '" still unsupported after ' + item.picked_up + ' deliveries — removing');
                    await del(); removed++;
                } else {
                    log('#' + item.id + ' unsupported slate state "' + state + '" — leaving in queue');
                    skipped++;
                }
            }
        } catch (e) {
            if (await reapable()) {
                log('#' + item.id + ' unreadable after ' + item.picked_up + ' deliveries (' + e.message + ') — wallet healthy, removing');
                try { await del(); removed++; }
                catch (de) { log('#' + item.id + ' could not remove: ' + de.message); failed++; }
            } else {
                log('#' + item.id + ' FAILED: ' + e.message + ' — leaving in queue for retry');
                failed++;
            }
        }
    }

    return { processed, skipped, failed, removed, depth: slates.length, lines };
}

module.exports = {
    ADDR_RE, REAP_AFTER_PICKUPS,
    signWithSeed, grinToNano, nanoStr, addressNetwork,
    makeClient, checkEndpoint, ownAddress, send, poll,
};
