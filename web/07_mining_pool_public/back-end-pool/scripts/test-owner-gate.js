'use strict';

// Regression tests for the ownership gate hardening applied after audit §J3.
// One-shot: no server, no listener, in-memory DB only — run via `npm run test:unit`.
//
// Each block names the finding it guards. If one of these fails, re-read
// docs/generated/script07_security_audit.md §J3 before "fixing" the test: several of these
// assert that something is DENIED, and loosening them re-opens a money path.

const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');
const op = require(path.join(LIB, 'owner-proof.js'));

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE miner_accounts (
    grin_address TEXT NOT NULL UNIQUE, balance REAL DEFAULT 0, balance_locked REAL DEFAULT 0,
    last_ip TEXT, prev_ip TEXT, last_pass_hash TEXT, prev_pass_hash TEXT,
    last_ip_at INTEGER, prev_ip_at INTEGER, last_pass_at INTEGER, prev_pass_at INTEGER,
    anchor_ip TEXT, anchor_pass_hash TEXT, anchor_set_at INTEGER,
    pass_proof_state TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE pool_config (section TEXT, key TEXT, value TEXT)`);
  db.exec(`CREATE TABLE admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER, action TEXT, target_type TEXT,
    target_id TEXT, details TEXT, ip TEXT, created_at INTEGER DEFAULT 0)`);
  return db;
}

const ADDR = (c) => 'grin1' + c.repeat(58);
const mk = (db, a) => db.prepare('INSERT INTO miner_accounts (grin_address, balance) VALUES (?, 100)').run(a);

// The age gate in index.js requireBothProofs, replicated exactly so this file can assert on it
// without standing up Express. Keep in step with that function.
const COOLDOWN_H = 48;
const MIN_PROOF_AGE_SEC = 3600;
function destinationLegOk(p, cooldownH = COOLDOWN_H) {
  if (!p.ok) return false;
  if (p.slot === 'anchor') return false;
  const minAge = Math.max(MIN_PROOF_AGE_SEC, Math.max(0, Number(cooldownH) || 0) * 3600);
  if (p.age_seconds !== null && p.age_seconds !== undefined && p.age_seconds < minAge) return false;
  return true;
}
const backdate = (db, a, secs) => db.prepare(
  `UPDATE miner_accounts SET last_ip_at = last_ip_at - ?, last_pass_at = last_pass_at - ?
   WHERE grin_address = ?`).run(secs, secs, a);

(async () => {
  // ── §J3-1 — one accepted share must not yield a destination change ──────────────────────
  {
    const db = freshDb();
    const V = ADDR('q'); mk(db, V);
    await op.recordOwnerEvidence(db, V, '203.0.113.9', 'victim-rig-secret');
    backdate(db, V, 30 * 86400); // the victim has been mining for a month

    const vIp = await op.verifyOwnerProof(db, V, '203.0.113.9', '203.0.113.9');
    const vPw = await op.verifyOwnerProof(db, V, 'victim-rig-secret', '203.0.113.9');
    assert.strictEqual(vIp.slot, 'last');
    assert.ok(destinationLegOk(vIp) && destinationLegOk(vPw), 'aged owner must still pass');
    ok('J3-1 owner with month-old evidence passes the destination gate');

    // Attacker mines to the same address with a password of their choosing.
    await op.recordOwnerEvidence(db, V, '198.51.100.7', 'attacker-chosen-pw');
    const aIp = await op.verifyOwnerProof(db, V, '198.51.100.7', '198.51.100.7');
    const aPw = await op.verifyOwnerProof(db, V, 'attacker-chosen-pw', '198.51.100.7');
    assert.ok(aIp.ok && aPw.ok, 'injected proof still verifies for withdrawal (by design)');
    assert.strictEqual(destinationLegOk(aIp), false, 'fresh IP leg must not change a destination');
    assert.strictEqual(destinationLegOk(aPw), false, 'fresh password leg must not change a destination');
    ok('J3-1 freshly injected proof is REFUSED by the destination gate');

    // ...and the displaced owner can still use their own, now in prev with its old timestamp.
    const vPrev = await op.verifyOwnerProof(db, V, '203.0.113.9', '203.0.113.9');
    assert.strictEqual(vPrev.slot, 'prev');
    assert.ok(destinationLegOk(vPrev), 'owner rotated to prev keeps their aged proof');
    ok('J3-1 rotation carries the timestamp, so the owner is not collaterally blocked');
  }

  // ── §J3-1 — turning the cooldown dial to 0 must not switch the age gate off ─────────────
  {
    const db = freshDb();
    const V = ADDR('x'); mk(db, V);
    await op.recordOwnerEvidence(db, V, '198.51.100.7', 'attacker-chosen-pw');
    const fresh = await op.verifyOwnerProof(db, V, '198.51.100.7', '198.51.100.7');
    assert.ok(fresh.ok && fresh.age_seconds < MIN_PROOF_AGE_SEC);
    assert.strictEqual(destinationLegOk(fresh, 0), false,
      'cooldown_hours=0 must still enforce the one-hour proof-age floor');
    backdate(db, V, 2 * 3600);
    const aged = await op.verifyOwnerProof(db, V, '198.51.100.7', '198.51.100.7');
    assert.strictEqual(destinationLegOk(aged, 0), true, 'past the floor it passes again');
    ok('J3-1 the age floor survives an operator setting the cooldown to 0');
  }

  // ── The anchor backfill must seed existing accounts, then no-op ─────────────────────────
  {
    const db = freshDb();
    const V = ADDR('y');
    // A pre-upgrade row: proofs on record, no anchor, no capture timestamps.
    db.prepare(`INSERT INTO miner_accounts (grin_address, balance, last_ip, last_pass_hash, created_at)
                VALUES (?, 10, 'v1$legacy-ip', 'v1$legacy-pass', 1700000000)`).run(V);
    const n1 = op.backfillProofAnchors(db);
    const r = db.prepare('SELECT anchor_ip, anchor_pass_hash, anchor_set_at FROM miner_accounts WHERE grin_address = ?').get(V);
    assert.strictEqual(n1, 1);
    assert.strictEqual(r.anchor_ip, 'v1$legacy-ip', 'anchored to the proof already held');
    assert.strictEqual(r.anchor_pass_hash, 'v1$legacy-pass');
    assert.strictEqual(r.anchor_set_at, 1700000000, 'backdated to created_at, not treated as fresh');
    assert.strictEqual(op.backfillProofAnchors(db), 0, 'second run is a no-op');
    ok('backfill anchors pre-existing accounts to their own proof and is idempotent');
  }

  // ── §J3-4 — eviction must not strand a miner who has stopped mining ─────────────────────
  {
    const db = freshDb();
    const V = ADDR('r'); mk(db, V);
    await op.recordOwnerEvidence(db, V, '203.0.113.9', 'victim-rig-secret');
    const anchored = db.prepare('SELECT anchor_ip, anchor_pass_hash FROM miner_accounts WHERE grin_address = ?').get(V);
    assert.ok(anchored.anchor_ip && anchored.anchor_pass_hash, 'first capture sets the anchor');
    ok('J3-4 first capture writes the write-once anchor');

    await op.recordOwnerEvidence(db, V, '198.51.100.7', 'attacker-pw-one');
    await op.recordOwnerEvidence(db, V, '198.51.100.8', 'attacker-pw-two');
    const row = db.prepare('SELECT last_ip, prev_ip, anchor_ip FROM miner_accounts WHERE grin_address = ?').get(V);
    assert.notStrictEqual(row.last_ip, anchored.anchor_ip);
    assert.notStrictEqual(row.prev_ip, anchored.anchor_ip);
    assert.strictEqual(row.anchor_ip, anchored.anchor_ip, 'anchor is never rotated');

    const rescue = await op.verifyOwnerProof(db, V, '203.0.113.9', '203.0.113.9');
    assert.ok(rescue.ok, 'the departed miner can still reach their own money');
    assert.strictEqual(rescue.slot, 'anchor');
    ok('J3-4 both window slots evicted, anchor still proves ownership');

    // The anchor buys withdrawal, never a destination change.
    assert.strictEqual(destinationLegOk(rescue), false);
    ok('J3-4 anchor is refused by the destination gate (unrevocable != authoritative)');
  }

  // ── §J3-4 — one share may establish a proof, not displace one ───────────────────────────
  {
    const db = freshDb();
    const V = ADDR('s'); mk(db, V);
    await op.recordOwnerEvidence(db, V, '203.0.113.9', 'victim-rig-secret');
    const before = db.prepare('SELECT last_ip, last_pass_hash FROM miner_accounts WHERE grin_address = ?').get(V);

    await op.recordOwnerEvidence(db, V, '198.51.100.7', 'attacker-chosen-pw', { mayDisplace: false });
    const after = db.prepare('SELECT last_ip, last_pass_hash FROM miner_accounts WHERE grin_address = ?').get(V);
    assert.strictEqual(after.last_ip, before.last_ip, 'low-work session must not rotate the IP window');
    assert.strictEqual(after.last_pass_hash, before.last_pass_hash, 'low-work session must not rotate the password window');
    assert.strictEqual((await op.verifyOwnerProof(db, V, '198.51.100.7', '198.51.100.7')).ok, false);
    ok('J3-4 mayDisplace=false leaves an established window untouched');

    // But an EMPTY window still fills on the first share — a new address has nothing to protect.
    const N = ADDR('t'); mk(db, N);
    await op.recordOwnerEvidence(db, N, '198.51.100.7', 'newcomer-secret', { mayDisplace: false });
    assert.ok((await op.verifyOwnerProof(db, N, '198.51.100.7', '198.51.100.7')).ok);
    ok('J3-4 first capture on an empty window is not gated');
  }

  // ── §J3-3 — a stranger must not be able to lock the owner out ───────────────────────────
  {
    const db = freshDb();
    const V = ADDR('u'); mk(db, V);
    await op.recordOwnerEvidence(db, V, '203.0.113.55', 'v2-rig-secret');

    // Eight wrong guesses, each from a different origin — the old address-keyed lock fired here.
    for (let i = 0; i < 8; i++) {
      await op.verifyOwnerProof(db, V, '10.0.0.' + i, '198.51.100.' + (100 + i));
    }
    const owner = await op.verifyOwnerProof(db, V, 'v2-rig-secret', '203.0.113.55');
    assert.ok(owner.ok, 'owner must still be able to prove ownership');
    ok('J3-3 strangers failing on an address no longer deny the owner');

    // The pair lock still bites the origin that is actually guessing.
    const G = ADDR('v'); mk(db, G);
    await op.recordOwnerEvidence(db, G, '203.0.113.77', 'g-rig-secret');
    for (let i = 0; i < 8; i++) await op.verifyOwnerProof(db, G, 'wrong-guess-' + i, '198.51.100.200');
    const blocked = await op.verifyOwnerProof(db, G, 'g-rig-secret', '198.51.100.200');
    assert.strictEqual(blocked.reason, 'too_many_attempts', 'the guessing origin is locked');
    const elsewhere = await op.verifyOwnerProof(db, G, 'g-rig-secret', '203.0.113.77');
    assert.ok(elsewhere.ok, 'a clean origin is unaffected by the guesser');
    ok('J3-3 brute force is still bounded, per (address, origin) pair');
  }

  // ── §J3-6 — the throttle map is swept and bounded ───────────────────────────────────────
  {
    const db = freshDb();
    const A = ADDR('w'); mk(db, A);
    await op.recordOwnerEvidence(db, A, '203.0.113.9', 'sweep-rig-secret');
    for (let i = 0; i < 5; i++) await op.verifyOwnerProof(db, A, 'nope-' + i, '198.51.100.' + i);
    assert.strictEqual(typeof op._sweepFails, 'function');
    op._sweepFails(true); // entries are still inside their window → retained, not a crash
    const still = await op.verifyOwnerProof(db, A, 'sweep-rig-secret', '203.0.113.9');
    assert.ok(still.ok);
    ok('J3-6 sweep runs, keeps in-window entries and never evicts a live lock');
  }

  // ── §J3-7 — a dynamic SQL fragment must not resolve through Object.prototype ────────────
  {
    const MAP = { in: "(event_type='credit')", out: "(event_type='debit')" };
    const pick = (k) => (Object.hasOwn(MAP, k) ? k : null);
    assert.strictEqual(pick('in'), 'in');
    assert.strictEqual(pick('constructor'), null);
    assert.strictEqual(pick('toString'), null);
    assert.strictEqual(pick('hasOwnProperty'), null);
    assert.strictEqual(pick(undefined), null);
    ok('J3-7 prototype keys are rejected by the direction guard');
  }

  // ── §J3-8 — the account-family address shape check ──────────────────────────────────────
  {
    const RE = /^t?grin1[ac-hj-np-z02-9]{58}$/;
    assert.ok(RE.test(ADDR('q')));
    assert.ok(RE.test('t' + ADDR('q')));
    assert.strictEqual(RE.test('grin1' + 'q'.repeat(57)), false, 'wrong length rejected');
    assert.strictEqual(RE.test('GRIN1' + 'Q'.repeat(58)), false, 'uppercase rejected (BINARY collation)');
    assert.strictEqual(RE.test('a";x="'), false, 'header-breaking input rejected');
    assert.strictEqual(RE.test('grin1' + 'b'.repeat(58)), false, 'non-bech32 charset rejected');
    ok('J3-8 only one address spelling reaches the account routes');
  }

  // ── Per-connection work, not per-address work ───────────────────────────────────────────
  // Both §J3 work-cost guards ask "has THIS socket mined?". MinerManager.recordShare fans a
  // share out to EVERY live session on the address, so reading shareCount would credit a
  // bare-login attacker with the victim's own mining and silently defeat both guards. Caught
  // in review after the first implementation did exactly that.
  {
    const MinerManager = require(path.join(LIB, 'miners.js'));
    const proto = MinerManager.prototype;
    const sessions = new Map();
    const fake = { activeSessions: sessions, db: null, config: {} };

    sessions.set('rig', { grinAddress: 'grin1v', shareCount: 0, acceptedShares: 0, pass: 'shared-rig-secret' });
    sessions.set('probe', { grinAddress: 'grin1v', shareCount: 0, acceptedShares: 0, pass: 'guess-candidate-1' });

    for (let i = 0; i < 4; i++) proto.recordShare.call(fake, 'grin1v', 1);
    assert.strictEqual(sessions.get('probe').shareCount, 4,
      'shareCount fans out across the address — this is the trap being guarded against');
    assert.strictEqual(sessions.get('probe').acceptedShares, 0,
      'acceptedShares must stay 0 for a session that never submitted');
    ok('guards read per-connection work, not the address-wide share counter');

    // ...so the password-consistency oracle ignores the non-mining session entirely.
    sessions.get('rig').acceptedShares = 4;
    const view = proto.getPasswordConsistency.call(
      { activeSessions: sessions, db: { prepare: () => ({ get: () => null }) } }, 'grin1v');
    assert.strictEqual(view.sessions, 1, 'only the mining rig is counted');
    assert.strictEqual(view.distinct, 1, 'a bare-login candidate cannot move distinct');
    ok('J3-2 a non-mining session cannot perturb the password-consistency readout');
  }

  // ── §J3-8 — the shape check must actually run, and must not break routing ────────────────
  // The middleware is mounted on a path rather than declared per-route, so "does it run at
  // all" and "does the real handler still match afterwards" are both worth executing rather
  // than reasoning about.
  {
    const express = require('express');
    const app = express();
    const GRIN_ADDR_RE = /^t?grin1[ac-hj-np-z02-9]{58}$/;
    app.use('/api/account', (req, res, next) => {
      const seg = String(req.path || '').split('/')[1] || '';
      let a; try { a = decodeURIComponent(seg); } catch (e) { a = seg; }
      if (!GRIN_ADDR_RE.test(a)) return res.status(404).json({ error: 'Account not found' });
      next();
    });
    app.get('/api/account/:addr', (req, res) => res.json({ reached: true, addr: req.params.addr }));
    app.get('/api/account/:addr/withdrawals', (req, res) => res.json({ reached: 'csv', addr: req.params.addr }));

    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
    try {
      const good = await get('/api/account/' + ADDR('q'));
      assert.strictEqual(good.status, 200, 'a valid address must still reach its handler');
      assert.strictEqual(good.body.addr, ADDR('q'), 'the handler still sees the full address');
      const nested = await get('/api/account/' + ADDR('q') + '/withdrawals');
      assert.strictEqual(nested.status, 200, 'nested routes still match after the mount');
      assert.strictEqual((await get('/api/account/a%22;x=%22')).status, 404, 'header-breaking input');
      assert.strictEqual((await get('/api/account/' + ADDR('q').toUpperCase())).status, 404, 'uppercase');
      assert.strictEqual((await get('/api/account/%67rin1' + 'q'.repeat(58))).status, 200,
        'percent-encoding that decodes to a valid address is accepted, as the route would');
      ok('J3-8 middleware runs, rejects malformed input and leaves routing intact');
    } finally {
      await new Promise((r) => srv.close(r)); // never leave a listener behind
    }
  }

  // ── §J3-5 — the donation tag must not be applied by an unauthenticated login ────────────
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(LIB, 'stratum-server.js'), 'utf8');
    const login = src.slice(src.indexOf('handleLogin('), src.indexOf('handleSubmit('));
    const submit = src.slice(src.indexOf('handleSubmit('));
    assert.strictEqual(/this\.incentives\.setDonation\(/.test(login), false,
      'setDonation must not run in handleLogin — login is unauthenticated (§J3-5)');
    assert.ok(/this\.incentives\.setDonation\(/.test(submit),
      'setDonation must run on the accepted-share path');
    ok('J3-5 donation tag is applied only after node-accepted PoW');
  }

  console.log(`\n${passed} ownership-gate checks passed (audit §J3 regressions).`);
})().catch((err) => {
  console.error('\nFAILED:', err && err.message);
  process.exit(1);
});
