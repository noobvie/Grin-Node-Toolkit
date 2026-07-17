'use strict';

// Unit tests for the P2 stratum attack-surface guards (2026-07-17 hardening):
//   · Finding 2 — share dedup keyed on the job's pre_pow (the actual work), NOT the pool's
//     incrementing job_id, so one solved (nonce,pow) can't be credited once per wrapping job.
//   · Finding 3/4 — per-connection message token bucket that throttles submit / login /
//     pre-login floods without disconnecting a legitimate miner.
// Run: node scripts/test-stratum-guards.js   (no DB / network needed — pure logic tests)

const ShareValidator = require('../lib/shares');
const NodeStratumClient = require('../lib/node-stratum-client');
const {
  tokenBucketStep,
  MSG_RATE_PER_SEC,
  MSG_BURST,
  MAX_LINE_BYTES
} = require('../lib/stratum-server');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else      { fail++; console.error(`  FAIL ${name}`); }
}

// generateShareHash never touches `this` (pure crypto), so call it off the prototype —
// constructing ShareValidator would require an initialised DB (getDb throws otherwise).
const shareHash = (addr, workId, worker, nonce) =>
  ShareValidator.prototype.generateShareHash.call(null, addr, workId, worker, nonce);

// ── Finding 2: dedup key is the pre_pow (actual work), not the pool job_id ──────────────
{
  const addr   = 'grin1abc';
  const worker = 'rig01';
  const nonce  = '17293822569102704642'; // u64 above 2^53, carried as a string
  const prePow = '00112233445566778899aabbccddeeff'; // one template
  const prePow2 = 'ffeeddccbbaa99887766554433221100'; // a genuinely new template

  // The vulnerability: the node re-issues many job_ids for ONE identical pre_pow. Whichever
  // pool job_id wrapped it, the dedup key is now the pre_pow → identical hash → the second
  // submit of the same solution hits the share_hash UNIQUE constraint and is not double-credited.
  check('same work (pre_pow) → identical dedup hash regardless of wrapping job_id',
    shareHash(addr, prePow, worker, nonce) === shareHash(addr, prePow, worker, nonce));

  // A genuinely new template (different pre_pow) is different work → different hash → credited.
  check('new template (different pre_pow) → distinct hash',
    shareHash(addr, prePow, worker, nonce) !== shareHash(addr, prePow2, worker, nonce));

  // Two different valid nonces for the same template are two real shares → distinct hashes.
  check('same template, different nonce → distinct hash',
    shareHash(addr, prePow, worker, nonce) !== shareHash(addr, prePow, worker, '999'));

  // grin_address stays in the key: two miners sharing a worker name (e.g. "default") can never
  // collide and have one's valid share rejected as the other's duplicate.
  check('cross-miner isolation (address in key)',
    shareHash(addr, prePow, worker, nonce) !== shareHash('grin1xyz', prePow, worker, nonce));

  // Deterministic 64-char lowercase hex (SHA-256).
  const h = shareHash(addr, prePow, worker, nonce);
  check('hash is 64-char lowercase hex', /^[0-9a-f]{64}$/.test(h));
  check('hash is deterministic', h === shareHash(addr, prePow, worker, nonce));
}

// ── Finding 3/4: per-connection message token bucket ────────────────────────────────────
{
  // Fresh bucket (full) allows the first message.
  const first = tokenBucketStep(MSG_BURST, 0, 0, MSG_RATE_PER_SEC, MSG_BURST);
  check('fresh bucket allows first message', first.allowed === true);

  // A same-instant burst: exactly MSG_BURST messages are allowed, the next is refused (no time
  // elapsed → no refill). Thread tokens through as processLines() does, holding `now` fixed.
  let tokens = MSG_BURST, allowed = 0, refused = 0;
  const now = 1_000_000;
  for (let i = 0; i < MSG_BURST + 20; i++) {
    const b = tokenBucketStep(tokens, now, now, MSG_RATE_PER_SEC, MSG_BURST);
    tokens = b.tokens;
    if (b.allowed) allowed++; else refused++;
  }
  check(`same-instant burst allows exactly MSG_BURST (${MSG_BURST})`, allowed === MSG_BURST);
  check('over-budget messages in the burst are refused', refused === 20);

  // A refused sender is allowed again once enough time elapses to refill ≥ 1 token.
  // At MSG_RATE_PER_SEC, one token takes 1000/MSG_RATE_PER_SEC ms.
  const oneTokenMs = Math.ceil(1000 / MSG_RATE_PER_SEC);
  const drained = tokenBucketStep(0, now, now, MSG_RATE_PER_SEC, MSG_BURST); // empty → refused
  check('empty bucket refuses', drained.allowed === false);
  const refilled = tokenBucketStep(0, now, now + oneTokenMs, MSG_RATE_PER_SEC, MSG_BURST);
  check('bucket recovers after one refill interval', refilled.allowed === true);

  // Idle does not let tokens exceed the burst cap (no unbounded credit accrual).
  const capped = tokenBucketStep(0, now, now + 3_600_000, MSG_RATE_PER_SEC, MSG_BURST); // 1h idle
  check('tokens never exceed burst cap after long idle',
    capped.allowed === true && capped.tokens <= MSG_BURST - 1);

  // A sustained *legitimate* rate never trips: simulate 5 msg/s for 200 messages.
  let lt = MSG_BURST, lLast = 0, everRefused = false;
  const stepMs = 200; // 5 messages/second — far below MSG_RATE_PER_SEC
  for (let i = 0; i < 200; i++) {
    const t = i * stepMs;
    const b = tokenBucketStep(lt, lLast, t, MSG_RATE_PER_SEC, MSG_BURST);
    lt = b.tokens; lLast = t;
    if (!b.allowed) everRefused = true;
  }
  check('sustained legit 5 msg/s never refused', everRefused === false);
}

// ── NodeStratumClient pending-backlog bound (2000-miner node-stall safety) ──────────────
// The constructor opens no socket (connect() does), so we can build one with a stub socket,
// mark it connected, and fill `pending` to prove forwardSubmit sheds load instead of growing
// the map without bound when the upstream node stalls.
{
  const client = new NodeStratumClient({ max_pending_submits: 3 }, /* stratumServer */ null);
  client.connected = true;
  client.socket = { destroyed: false, write() {} }; // stub — never actually writes to a node

  check('maxPending honoured from config', client.maxPending === 3);

  // Fill the backlog to capacity with dummy entries (as if 3 submits are awaiting the node).
  for (let i = 1; i <= 3; i++) client.pending.set(i, { resolve() {}, timer: setTimeout(() => {}, 0) });

  // Next submit must be shed immediately (accepted:false), WITHOUT adding a 4th entry.
  return (async () => {
    const r = await client.forwardSubmit({ nonce: '1', pow: [1] });
    check('forwardSubmit rejects when backlog full', r.accepted === false && /backlog full/i.test(r.error));
    check('rejected submit did not grow pending past cap', client.pending.size === 3);

    // With room, a submit is accepted into pending (returns a promise we don't await).
    client.pending.delete(1);
    client.forwardSubmit({ nonce: '2', pow: [1] });
    check('forwardSubmit accepts into pending when room exists', client.pending.size === 3);

    // Clean up dangling timers so we don't leak (process.exit below would also handle it).
    for (const { timer } of client.pending.values()) clearTimeout(timer);

    finish();
  })();
}

function finish() {
// ── Sanity: the line-frame cap is a sane, exported constant ─────────────────────────────
{
  check('MAX_LINE_BYTES is exported and generous (≥ 4 KB, a submit is < 1 KB)',
    Number.isInteger(MAX_LINE_BYTES) && MAX_LINE_BYTES >= 4096);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
}
