'use strict';

// Unit tests for the stratum attack-surface guards.
//
// 2026-07-17 hardening:
//   · share dedup keyed on the job's pre_pow (the actual work), NOT the pool's
//     incrementing job_id, so one solved (nonce,pow) can't be credited once per wrapping job.
//   · per-connection message token bucket that throttles submit / login /
//     pre-login floods without disconnecting a legitimate miner.
//
// Audit §J6 resolution (2026-09-01) — every one of these ASSERTS A DENIAL, which is what the
// original six could not do: they all held the worker name constant, so the multiplier below
// passed straight through them:
//   · §J6-1  the worker name is NOT in the dedup key
//   · §J6-5  a consecutive-reject ceiling exists and resets on an accepted share
//   · §J6-6  the bech32 CHECKSUM is verified, not just the charset
//   · §J6-10 isValidJob consults jobIdMap — bounded above, integers only
//   · §J6-11 the node payload is built from known fields; a decoy `nonce` key cannot win
//
// Run: node scripts/test-stratum-guards.js   (no DB / network needed — pure logic tests)

const ShareValidator = require('../lib/shares');
const NodeStratumClient = require('../lib/node-stratum-client');
const StratumServer = require('../lib/stratum-server');
const { validateUsername, bech32ChecksumValid } = require('../lib/stratum-protocol');
const {
  tokenBucketStep,
  MSG_RATE_PER_SEC,
  MSG_BURST,
  MAX_LINE_BYTES,
  MAX_CONSECUTIVE_REJECTS
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

// ── Dedup key is the pre_pow (actual work), not the pool job_id ─────────────────────────
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

  // ── §J6-1: the worker name must NOT change the dedup identity ──────────────────────────
  // The worker label is whatever the miner types after the dot. While it was in the key, ONE
  // solved (pre_pow, nonce, pow) re-submitted under N rig labels inserted N times and multiplied
  // that address's PPLNS weight N-fold — from one socket, inside the token bucket, at ~11x floor
  // (the node re-issues ~JOB_WINDOW distinct job_ids per identical pre_pow, so every copy looked
  // novel to the node too). This is the assertion the original six were missing: they all held
  // the worker name constant, so the control passed and the attack was invisible.
  check('§J6-1 worker name does NOT change the dedup hash (one solution = one share)',
    shareHash(addr, prePow, 'rig01', nonce) === shareHash(addr, prePow, 'rig02', nonce));
  check('§J6-1 ...and that holds for many labels, not just two',
    new Set(['a', 'b', 'c', 'd', 'default', 'x-1', 'z_9']
      .map(w => shareHash(addr, prePow, w, nonce))).size === 1);
  // The address still isolates miners, which is what the worker name was WRONGLY credited with.
  check('§J6-1 address alone already separates two miners sharing a worker name',
    shareHash(addr, prePow, 'default', nonce) !== shareHash('grin1xyz', prePow, 'default', nonce));

  // Deterministic 64-char lowercase hex (SHA-256).
  const h = shareHash(addr, prePow, worker, nonce);
  check('hash is 64-char lowercase hex', /^[0-9a-f]{64}$/.test(h));
  check('hash is deterministic', h === shareHash(addr, prePow, worker, nonce));
}

// ── Per-connection message token bucket ─────────────────────────────────────────────────
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

// ── §J6-6: bech32 CHECKSUM, not just the charset ────────────────────────────────────────
// A Grin Slatepack address is bech32(hrp, ed25519_pubkey) — classic bech32, checksum constant 1
// (grin-wallet pins the bech32 0.7 crate, which predates the bech32m split). validateUsername
// used to check the charset and the length and stop, so any 58 charset-valid characters were a
// working login: an unbounded supply of distinct addresses for an anonymous client (each taking
// a miner_accounts row + 3 synchronous statements on the shared DB), and a miner who mistyped one
// character of their own address mined to a key nobody holds.
{
  const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const split = (v) => { const i = v.lastIndexOf('1'); return [v.slice(0, i), v.slice(i + 1)]; };

  // BIP-173 official VALID vectors (lowercase forms — bech32 must not be mixed case).
  const valid = [
    'a12uel5l',
    'an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs',
    'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw',
    '11' + 'q'.repeat(82) + 'c8247j',
    'split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w',
    '?1ezyfcl'
  ];
  check('§J6-6 all BIP-173 valid vectors verify',
    valid.every(v => bech32ChecksumValid(...split(v)) === true));

  // BIP-173 INVALID-checksum vectors: one corrupted character each.
  const invalid = [
    'a1g7sgd8',
    'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxx',
    'split1checkupstagehandshakeupstreamerranterredcaperred2y9e2w'
  ];
  check('§J6-6 all BIP-173 invalid-checksum vectors are refused',
    invalid.every(v => bech32ChecksumValid(...split(v)) === false));

  // Independent encoder → real-shape Grin addresses, so the validator is checked against
  // something built from the spec rather than against itself.
  const poly = (vals) => {
    const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of vals) {
      const top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= G[i];
    }
    return chk >>> 0;
  };
  const expand = (h) => {
    const o = [];
    for (const c of h) o.push(c.charCodeAt(0) >> 5);
    o.push(0);
    for (const c of h) o.push(c.charCodeAt(0) & 31);
    return o;
  };
  const to5 = (bytes) => {
    let acc = 0, bits = 0; const out = [];
    for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); } }
    if (bits) out.push((acc << (5 - bits)) & 31);
    return out;
  };
  const encode = (hrp, bytes) => {
    const d = to5(bytes);
    const chk = poly(expand(hrp).concat(d).concat([0, 0, 0, 0, 0, 0])) ^ 1;
    const cs = []; for (let i = 0; i < 6; i++) cs.push((chk >> (5 * (5 - i))) & 31);
    return hrp + '1' + d.concat(cs).map(v => CS[v]).join('');
  };

  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff));
  const main = encode('grin', key);
  const test = encode('tgrin', key);
  check('§J6-6 a real-shape mainnet address is 63 chars and is ACCEPTED',
    main.length === 63 && !!validateUsername(main));
  check('§J6-6 a real-shape testnet address is 64 chars and is ACCEPTED',
    test.length === 64 && !!validateUsername(test));
  check('§J6-6 ...and the worker suffix still parses on a real address',
    (validateUsername(main + '.rig01') || {}).worker_name === 'rig01');
  check('§J6-6 ...and the donateN tag still parses on a real address',
    (validateUsername(main + '.rig01-donate10') || {}).donation_percent === 10);

  // The two cases the checksum exists for.
  const i = 20;
  const typo = main.slice(0, i) + CS[(CS.indexOf(main[i]) + 1) % 32] + main.slice(i + 1);
  check('§J6-6 a single-character typo in a real address is REFUSED',
    typo.length === 63 && validateUsername(typo) === null);
  check('§J6-6 charset-valid junk is REFUSED (this used to create a miner_accounts row)',
    validateUsername('grin1' + 'q'.repeat(58)) === null &&
    validateUsername('tgrin1' + 'a'.repeat(58)) === null);

  // ── §J17-4: ONE key, TWO valid spellings, and only one of them belongs to this pool ──
  // `main` and `test` above are the SAME 32-byte key under two hrps. Both pass the checksum —
  // bech32 computes it over the hrp, so neither is a corruption of the other — which is why
  // §J6-6's fix could not catch this and why the network has to be supplied.
  check('§J17-4 the two spellings really are one key with two valid checksums',
    main.slice(5, 57) === test.slice(6, 58) && main !== test);
  check('§J17-4 a mainnet pool ACCEPTS grin1… and REFUSES the tgrin1… twin',
    !!validateUsername(main, 'mainnet') && validateUsername(test, 'mainnet') === null);
  check('§J17-4 a testnet pool ACCEPTS tgrin1… and REFUSES the grin1… twin',
    !!validateUsername(test, 'testnet') && validateUsername(main, 'testnet') === null);
  check('§J17-4 the worker suffix still parses once the network is enforced',
    (validateUsername(main + '.rig01', 'mainnet') || {}).worker_name === 'rig01');
  check('§J17-4 the returned identity keeps its own prefix (no silent rewriting)',
    validateUsername(test, 'testnet').grin_address === test);
  check('§J17-4 control — with no network given, both are still accepted (BIP-173 vectors)',
    !!validateUsername(main) && !!validateUsername(test));
  check('§J17-4 a wrong-network address that is ALSO malformed is still refused',
    validateUsername(typo, 'mainnet') === null);
}

// ── §J6-10: isValidJob asks the authoritative window ────────────────────────────────────
// The old form was arithmetic over jobCounter with no upper bound and no integer check, so
// "valid" and "present in jobIdMap" could disagree — which is what made handleSubmit's dedup-key
// fallbacks reachable, the worst of them keying the share on the MINER'S OWN INTEGER.
{
  const isValidJob = (map, id) =>
    StratumServer.prototype.isValidJob.call({ jobIdMap: map }, id);
  const map = new Map([[5, { node: 50, pre_pow: 'aa' }], [6, { node: 51, pre_pow: 'bb' }]]);

  check('§J6-10 a job in the window is valid', isValidJob(map, 5) && isValidJob(map, 6));
  check('§J6-10 a job ABOVE the window is refused (there was no upper bound)',
    isValidJob(map, 7) === false && isValidJob(map, 1e9) === false);
  check('§J6-10 a job BELOW the window is refused', isValidJob(map, 4) === false);
  check('§J6-10 a non-integer job_id is refused',
    isValidJob(map, 5.5) === false && isValidJob(map, NaN) === false);
  check('§J6-10 a non-number job_id is refused',
    isValidJob(map, '5') === false && isValidJob(map, null) === false);
  check('§J6-10 nothing is valid before the first job arrives',
    isValidJob(new Map(), 1) === false);
}

// ── §J6-5: consecutive-reject ceiling ───────────────────────────────────────────────────
// Nothing used to penalise a session that produced only rejects: session.rejected was counted
// and then only ever DISPLAYED. Every rejected submit costs the node a full Cuckatoo
// verification and writes a log line, so one address inside the documented message budget could
// force ~8,000 verifications/s and ~1 MB/s of journal.
{
  const _stat = (srv, sid, field) => StratumServer.prototype._stat.call(srv, sid, field);
  const session = { grinAddress: 'grin1abc', ip: '198.51.100.1' };
  const srv = { minerManager: { getSession: () => session } };

  for (let i = 0; i < MAX_CONSECUTIVE_REJECTS - 1; i++) _stat(srv, 'sid', 'rejected');
  let destroyed = false;
  const socket = { destroy() { destroyed = true; } };
  const hit = () => StratumServer.prototype._rejectCeilingHit.call(srv, socket, session);
  check(`§J6-5 ${MAX_CONSECUTIVE_REJECTS - 1} consecutive rejects do NOT disconnect`,
    hit() === false && destroyed === false);

  _stat(srv, 'sid', 'rejected');
  check(`§J6-5 the ${MAX_CONSECUTIVE_REJECTS}th consecutive reject disconnects`,
    hit() === true && destroyed === true);

  // An accepted share clears the run — a real rig at ~1% rejects can never reach the ceiling.
  _stat(srv, 'sid', 'accepted');
  check('§J6-5 an accepted share resets the consecutive-reject counter',
    session.consecutiveRejects === 0);

  // `stale` is legitimate every time a new job lands mid-flight, so it must not count.
  session.consecutiveRejects = 0;
  for (let i = 0; i < MAX_CONSECUTIVE_REJECTS + 10; i++) _stat(srv, 'sid', 'stale');
  check('§J6-5 stale submits do NOT count toward the ceiling',
    (session.consecutiveRejects || 0) === 0);

  // The warn throttle emits once per window and folds the suppressed count into the next line.
  const warn = (sess, key, build) => StratumServer.prototype._warnThrottled.call({}, sess, key, build);
  const orig = console.warn; const lines = [];
  console.warn = (l) => lines.push(l);
  try {
    const sess = {};
    for (let i = 0; i < 500; i++) warn(sess, 'noderej', (n) => `line ${n}`);
    sess._warnState.noderej.last = 0;              // simulate the window elapsing
    warn(sess, 'noderej', (n) => `line ${n}`);
  } finally { console.warn = orig; }
  check('§J6-5 500 rejects emit 2 log lines, not 500', lines.length === 2);
  check('§J6-5 ...and the suppressed count is carried into the next line',
    lines[0] === 'line 0' && lines[1] === 'line 499');
}

// ── §J6-11: the node payload cannot be steered by a miner-chosen key ────────────────────
// The send-side quote-stripping used to be a NON-GLOBAL regex over the whole serialised blob
// while handleSubmit forwarded `{ ...params }` verbatim — so a nested object keyed `nonce`
// holding a quoted number won the first match, and the miner's real u64 stayed quoted on the
// node's wire. All shares from all miners share ONE upstream socket, which is what makes a
// malformed frame a pool-wide concern rather than self-harm.
{
  const client = new NodeStratumClient({}, null);
  const ser = (m) => client._serialize(m);
  const nonce = '17293822569102704642'; // u64 above 2^53

  const wire = ser({ id: 1, jsonrpc: '2.0', method: 'submit',
    params: { edge_bits: 32, height: 100, job_id: 7, nonce, pow: [1, 2, 3] } });
  check('§J6-11 a string nonce is emitted BARE on the node wire',
    wire.includes(`"nonce":${nonce}`) && !wire.includes(`"nonce":"${nonce}"`));
  check('§J6-11 ...and the u64 survives the round trip exactly',
    String(JSON.parse(wire.replace(`"nonce":${nonce}`, `"nonce":"${nonce}"`)).params.nonce) === nonce);

  // The decoy that used to win. handleSubmit's whitelist means it can no longer reach send()
  // at all; _serialize is nonetheless proof against it, because the substitution now targets a
  // placeholder this module injected rather than pattern-matching miner data.
  const decoy = ser({ id: 2, jsonrpc: '2.0', method: 'submit',
    params: { decoy: { nonce: '42' }, nonce, edge_bits: 32, pow: [1] } });
  check('§J6-11 a decoy `nonce` key does NOT capture the substitution',
    decoy.includes(`"nonce":${nonce}`) && decoy.includes('"nonce":"42"'));
  check('§J6-11 the real nonce is unquoted exactly once',
    (decoy.match(new RegExp(`"nonce":${nonce}`, 'g')) || []).length === 1);

  // Non-submit traffic and numeric nonces are untouched.
  check('§J6-11 a message with no nonce serialises unchanged',
    ser({ id: 3, method: 'login', params: { login: 'x', pass: 'y' } }) ===
      JSON.stringify({ id: 3, method: 'login', params: { login: 'x', pass: 'y' } }));
  check('§J6-11 a non-numeric nonce string is left alone (never a bare token on the wire)',
    ser({ id: 4, params: { nonce: 'abc' } }).includes('"nonce":"abc"'));
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
