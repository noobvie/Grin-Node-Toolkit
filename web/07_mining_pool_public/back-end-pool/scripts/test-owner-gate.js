'use strict';

// Regression tests for the ownership gate hardening applied after audit §J3.
// One-shot: no server, no listener, in-memory DB only — run via `npm run test:unit`.
//
// Each block names the finding it guards. If one of these fails, re-read
// docs/generated/script07_security_audit.md §J3 before "fixing" the test: several of these
// assert that something is DENIED, and loosening them re-opens a money path.

const assert = require('assert');
const path = require('path');
// The SAME driver wrapper production uses — not a bare node:sqlite DatabaseSync. That one has
// no .transaction(), so a migration that opens one would throw here and pass in production,
// which is the wrong way round for a test to be wrong.
const Database = require(path.join(__dirname, '..', 'lib', 'sqlite-compat.js'));

const LIB = path.join(__dirname, '..', 'lib');
const op = require(path.join(LIB, 'owner-proof.js'));

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

// The schema these tests run against. The ten legacy window columns are still here because
// migrateProofSet() has to be able to READ them — a fresh DB gets them from db.js too, which
// never DROPs a column. Keep this in step with lib/db.js: a column missing here makes a real
// bug pass, and one missing there makes a green test lie.
function freshDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE miner_accounts (
    grin_address TEXT NOT NULL UNIQUE, balance REAL DEFAULT 0, balance_locked REAL DEFAULT 0,
    proof_salt TEXT DEFAULT NULL,
    last_ip TEXT, prev_ip TEXT, last_pass_hash TEXT, prev_pass_hash TEXT,
    last_ip_at INTEGER, prev_ip_at INTEGER, last_pass_at INTEGER, prev_pass_at INTEGER,
    anchor_ip TEXT, anchor_pass_hash TEXT, anchor_set_at INTEGER,
    pass_proof_state TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE miner_proofs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grin_address TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('ip','pass')),
    hash TEXT NOT NULL,
    first_seen_at INTEGER DEFAULT NULL,
    last_seen_at INTEGER NOT NULL,
    is_anchor INTEGER NOT NULL DEFAULT 0,
    evicted_at INTEGER DEFAULT NULL,
    UNIQUE (grin_address, kind, hash))`);
  db.exec(`CREATE INDEX idx_miner_proofs_lru ON miner_proofs (grin_address, kind, evicted_at, last_seen_at)`);
  db.exec(`CREATE TABLE pool_config (section TEXT, key TEXT, value TEXT)`);
  db.exec(`CREATE TABLE admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER, action TEXT, target_type TEXT,
    target_id TEXT, details TEXT, ip TEXT, created_at INTEGER DEFAULT 0)`);
  return db;
}

// Proof-set readers the checks below share. `live` is the set the cap and the LRU range over.
const setRows = (db, a, kind) => db.prepare(
  `SELECT id, hash, first_seen_at, last_seen_at, is_anchor, evicted_at FROM miner_proofs
    WHERE grin_address = ? AND kind = ? ORDER BY id ASC`).all(a, kind);
const liveRows = (db, a, kind) => setRows(db, a, kind).filter((r) => r.evicted_at === null);
const auditRows = (db, a) => db.prepare(
  'SELECT action, details FROM admin_audit_log WHERE target_id = ? ORDER BY id ASC').all(a);

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
// Age a whole set. first_seen_at is what the destination gate reads and production only ever
// moves it FORWARD (a returning anchor), so a test that needs an "old" proof has to reach into
// the table like this.
const backdate = (db, a, secs) => db.prepare(
  `UPDATE miner_proofs SET first_seen_at = first_seen_at - ? WHERE grin_address = ?`
).run(secs, a);

(async () => {
  // ── §J3-1 — one accepted share must not yield a destination change ──────────────────────
  {
    const db = freshDb();
    const V = ADDR('q'); mk(db, V);
    await op.recordOwnerEvidence(db, V, '203.0.113.9', 'victim-rig-secret');
    backdate(db, V, 30 * 86400); // the victim has been mining for a month

    const vIp = await op.verifyOwnerProof(db, V, '203.0.113.9', '203.0.113.9');
    const vPw = await op.verifyOwnerProof(db, V, 'victim-rig-secret', '203.0.113.9');
    assert.strictEqual(vIp.slot, 'set', 'a live row reports slot "set", never "anchor"');
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

    // ...and the owner is not displaced at all: the attacker's values sit BESIDE theirs. This
    // is the §17.1 fix — under the 2-slot window this same sequence rotated the owner down a
    // slot and re-stamped the age the gate reads, refusing the owner's own destination change.
    const ownerFirstSeen = liveRows(db, V, 'ip').map((r) => r.first_seen_at).sort()[0];
    const vStill = await op.verifyOwnerProof(db, V, '203.0.113.9', '203.0.113.9');
    assert.strictEqual(vStill.slot, 'set');
    assert.ok(destinationLegOk(vStill), 'the owner keeps their aged proof when a stranger adds one');
    assert.strictEqual(liveRows(db, V, 'ip').map((r) => r.first_seen_at).sort()[0], ownerFirstSeen,
      'first_seen_at must not move — it is the only thing separating owner from stranger');
    assert.strictEqual(liveRows(db, V, 'ip').length, 2, 'both values are on record');
    ok('J3-1 a stranger\'s capture sits beside the owner\'s instead of displacing it');

    // The insert into a non-empty set is the hostile signature, so it IS audited — and the
    // audit row carries the kind and the counts, never the value.
    const added = auditRows(db, V).filter((r) => /evidence_added/.test(r.action));
    assert.ok(added.length >= 2, 'both kinds audited the stranger\'s insert');
    const det = JSON.parse(added[0].details);
    assert.ok(['ip', 'pass'].includes(det.kind) && typeof det.live_after === 'number' &&
      typeof det.evicted === 'boolean', 'evidence_added carries { kind, live_after, evicted }');
    assert.ok(!/203\.0\.113|victim-rig-secret|attacker-chosen-pw|v1\$|v2\$/.test(added[0].details),
      'no proof value or digest may appear in an audit row');
    ok('the audit row for an insert names the kind and the counts, never the value');
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

  // ── §17.2 #9 — the 2-slot window migrates into the set, once ────────────────────────────
  {
    const db = freshDb();
    const V = ADDR('y');
    // A pre-§17 row as an upgrading pool actually holds one: an anchor outside the window
    // (the address rotated twice since), plus last and prev with their own capture times.
    db.prepare(`INSERT INTO miner_accounts
      (grin_address, balance, created_at,
       anchor_ip, anchor_set_at, last_ip, last_ip_at, prev_ip, prev_ip_at,
       anchor_pass_hash, last_pass_hash, last_pass_at)
      VALUES (?, 10, 1700000000,
       'v1$anchor-ip', 1700000000, 'v1$last-ip', 1800000000, 'v1$prev-ip', 1750000000,
       'v1$anchor-pass', 'v1$last-pass', 1800000000)`).run(V);

    assert.strictEqual(op.migrateProofSet(db), 1, 'one account migrated');
    const ip = setRows(db, V, 'ip');
    assert.strictEqual(ip.length, 3, 'anchor + last + prev each become a row');
    const byHash = Object.fromEntries(ip.map((r) => [r.hash, r]));
    assert.strictEqual(byHash['v1$anchor-ip'].is_anchor, 1, 'the anchor value carries the flag');
    assert.strictEqual(byHash['v1$anchor-ip'].evicted_at, 1700000000,
      'an anchor outside the window arrives EVICTED, stamped with anchor_set_at');
    assert.strictEqual(byHash['v1$last-ip'].first_seen_at, 1800000000, 'last keeps last_ip_at');
    assert.strictEqual(byHash['v1$prev-ip'].first_seen_at, 1750000000, 'prev keeps prev_ip_at');
    assert.strictEqual(byHash['v1$last-ip'].evicted_at, null, 'the window values are live');
    assert.strictEqual(liveRows(db, V, 'ip').length, 2);
    assert.ok(ip[0].id < ip[1].id && ip[1].id < ip[2].id, 'inserted anchor → prev → last');
    ok('§17.2 #9 anchor/last/prev map to rows with the right flags and timestamps');

    // Same rules for the password kind: an anchor that differs from both window slots arrives
    // evicted. (The EQUAL case — the common one — is asserted separately below.)
    const pass = setRows(db, V, 'pass');
    assert.strictEqual(pass.length, 2, 'two distinct password values');
    const pAnchor = pass.find((r) => r.is_anchor === 1);
    assert.strictEqual(pAnchor.hash, 'v1$anchor-pass');
    assert.strictEqual(pAnchor.evicted_at, 1700000000);
    ok('§17.2 #9 the password set migrates on the same rules');

    const after = db.prepare(
      `SELECT last_ip, prev_ip, anchor_ip, last_ip_at, prev_ip_at, anchor_set_at,
              last_pass_hash, prev_pass_hash, anchor_pass_hash, last_pass_at, prev_pass_at
         FROM miner_accounts WHERE grin_address = ?`).get(V);
    assert.ok(Object.values(after).every((v) => v === null),
      'every legacy column is NULLed — that NULL is the idempotency proof, there is no marker');
    ok('§17.2 #9 the legacy columns are cleared, not left as a second source of truth');

    assert.strictEqual(op.migrateProofSet(db), 0, 'second run finds nothing to do');
    assert.strictEqual(setRows(db, V, 'ip').length, 3, 'and inserts nothing on a second run');
    ok('§17.2 #9 migrateProofSet is idempotent');

    // The COMMON pre-§17 shape: backfillProofAnchors seeded the anchor FROM `last`, so on most
    // upgrading accounts anchor == last (same stored string). That must be ONE row, LIVE, still
    // flagged, carrying the older stamp. Without the merge the anchor row lands evicted, the
    // `last` insert is IGNOREd by the UNIQUE index, and the owner's current proof migrates as
    // an evicted anchor — refused by the destination gate on every account that upgraded.
    // (Part 4 review: this path had no test; the check above claimed to be it and was not.)
    const dbE = freshDb();
    const E = ADDR('e');
    dbE.prepare(`INSERT INTO miner_accounts
      (grin_address, balance, anchor_ip, anchor_set_at, last_ip, last_ip_at, prev_ip, prev_ip_at)
      VALUES (?, 1, 'v1$same-ip', 1800000000, 'v1$same-ip', 1700000000, 'v1$older-ip', 1650000000)`).run(E);
    op.migrateProofSet(dbE);
    const eIp = setRows(dbE, E, 'ip');
    assert.strictEqual(eIp.length, 2, 'anchor == last is ONE row, plus prev');
    const merged = eIp.find((r) => r.hash === 'v1$same-ip');
    assert.strictEqual(merged.is_anchor, 1, 'the merged row keeps the anchor flag');
    assert.strictEqual(merged.evicted_at, null, 'and is LIVE — the address is still mining from it');
    assert.strictEqual(merged.first_seen_at, 1700000000, 'carrying the OLDER of the two stamps');
    ok('§17.2 #9 an anchor equal to a window slot migrates as one live anchor row');

    // A migrated v1 row still verifies, and a capture that matches it rewrites it as v2 so it
    // stops costing its own scrypt. Built through op.hashProof so the test cannot invent a
    // format the parser does not actually accept.
    const db2 = freshDb();
    const W = ADDR('z'); mk(db2, W);
    const legacy = await op.hashProof('203.0.113.42');
    db2.prepare(`UPDATE miner_accounts SET last_ip = ?, last_ip_at = 1700000000 WHERE grin_address = ?`)
      .run(legacy, W);
    op.migrateProofSet(db2);
    const v1row = setRows(db2, W, 'ip')[0];
    assert.ok(v1row.hash.startsWith('v1$'), 'carried across as-is, not re-hashed');
    const v1verify = await op.verifyOwnerProof(db2, W, '203.0.113.42', '203.0.113.42');
    assert.ok(v1verify.ok && v1verify.slot === 'set', 'a legacy row still proves ownership');
    assert.ok(v1verify.age_seconds > 0, 'and reports the age the migration gave it');
    await op.recordOwnerEvidence(db2, W, '203.0.113.42', null);
    const upgraded = setRows(db2, W, 'ip');
    assert.strictEqual(upgraded.length, 1, 'a matching capture must not add a second row');
    assert.ok(upgraded[0].hash.startsWith('v2$'), 'and rewrites the v1 row in place as v2');
    assert.strictEqual(upgraded[0].first_seen_at, 1700000000, 'without moving first_seen_at');
    assert.ok((await op.verifyOwnerProof(db2, W, '203.0.113.42', '203.0.113.42')).ok,
      'and it still verifies afterwards');
    ok('a v1 row verifies, and a matching capture upgrades it to v2 in place');
  }

  // ── §17.2 #2/#4 — the cap, LRU eviction, and an anchor that is flagged not deleted ──────
  // Every capture below lands in the same wall-clock second, so last_seen_at ties and the LRU
  // pick falls through to the `id` tiebreaker — insertion order. That is deliberate: it makes
  // the eviction ORDER assertable instead of timing-dependent.
  {
    const db = freshDb();
    const V = ADDR('r'); mk(db, V);
    const MAX = op.PROOF_SET_MAX;
    assert.strictEqual(MAX, 10, 'the cap the account page quotes to the miner');

    await op.recordOwnerEvidence(db, V, '203.0.113.9', 'victim-rig-secret');
    const first = setRows(db, V, 'ip');
    assert.strictEqual(first.length, 1);
    assert.strictEqual(first[0].is_anchor, 1, 'first capture into an empty set becomes the anchor');
    assert.strictEqual(first[0].evicted_at, null, 'and it is an ordinary LIVE member');
    assert.strictEqual(setRows(db, V, 'pass')[0].is_anchor, 1, 'the anchor is per KIND, not per address');
    assert.strictEqual((await op.verifyOwnerProof(db, V, '203.0.113.9', '203.0.113.9')).slot, 'set',
      'a live anchor must NOT be labelled anchor, or an active miner is barred from the gate');
    ok('§17.2 #4/#5 first capture anchors, and a live anchor is an ordinary set member');

    const anchorId = first[0].id;
    const anchorFirstSeen = first[0].first_seen_at;
    for (let i = 1; i < MAX; i++) await op.recordOwnerEvidence(db, V, '198.51.100.' + i, null);
    assert.strictEqual(liveRows(db, V, 'ip').length, MAX, 'the set fills exactly to the cap');
    assert.strictEqual(setRows(db, V, 'ip').length, MAX, 'nothing evicted before the cap is reached');
    ok('§17.2 #1 the set grows to PROOF_SET_MAX without evicting anything');

    // One past the cap. The least-recently-seen live row is the anchor — so it must be FLAGGED.
    await op.recordOwnerEvidence(db, V, '198.51.100.201', null);
    const anchorRow = setRows(db, V, 'ip').find((r) => r.id === anchorId);
    assert.ok(anchorRow, 'the anchor row must still EXIST — §J3-4, a departed miner needs it');
    assert.notStrictEqual(anchorRow.evicted_at, null, 'it is evicted…');
    assert.strictEqual(anchorRow.is_anchor, 1, '…and still flagged as the anchor');
    assert.strictEqual(anchorRow.first_seen_at, anchorFirstSeen, 'eviction does not touch first_seen_at');
    assert.strictEqual(liveRows(db, V, 'ip').length, MAX, 'the live set is back at the cap');
    ok('§17.2 #4 a full set evicts the LRU row, and an anchor is FLAGGED rather than deleted');

    // The next one past the cap picks a NON-anchor LRU row, which is deleted outright.
    const victimId = liveRows(db, V, 'ip')[0].id;
    const totalBefore = setRows(db, V, 'ip').length;
    await op.recordOwnerEvidence(db, V, '198.51.100.202', null);
    assert.strictEqual(setRows(db, V, 'ip').find((r) => r.id === victimId), undefined,
      'a non-anchor LRU row is removed, not flagged');
    assert.strictEqual(setRows(db, V, 'ip').length, totalBefore, 'one out, one in');
    assert.strictEqual(liveRows(db, V, 'ip').length, MAX, 'still exactly at the cap');
    ok('§17.2 #2 eviction is least-recently-SEEN, and only the anchor survives it');

    // The departed miner's route to their own wallet: the evicted anchor still verifies, and
    // is still refused for a destination change (an unrevocable credential must not redirect).
    const rescue = await op.verifyOwnerProof(db, V, '203.0.113.9', '203.0.113.9');
    assert.ok(rescue.ok, 'the departed miner can still reach their own money');
    assert.strictEqual(rescue.slot, 'anchor', 'an EVICTED anchor is what earns the anchor label');
    assert.strictEqual(destinationLegOk(rescue), false);
    ok('J3-4 the evicted anchor proves ownership for withdrawal and nothing more');

    // …and allowAnchor:false must refuse it outright rather than reporting a hit.
    const refused = await op.verifyOwnerProof(db, V, '203.0.113.9', '203.0.113.9', { allowAnchor: false });
    assert.strictEqual(refused.ok, false, 'allowAnchor:false must not accept an evicted anchor');
    assert.strictEqual(refused.reason, 'no_match');
    ok('opts.allowAnchor=false refuses the evicted-anchor row');

    // Re-activating it is an INSERT into a non-empty set, so it needs sustained work (§17.2 #5).
    await op.recordOwnerEvidence(db, V, '203.0.113.9', null, { mayDisplace: false });
    assert.notStrictEqual(setRows(db, V, 'ip').find((r) => r.id === anchorId).evicted_at, null,
      'a one-share session must not bring the anchor back into the live set');
    ok('§17.2 #5 re-activating an evicted anchor counts as an insert, and is gated');

    // Age it first, so the assertion below can tell "restarted" from "never old".
    db.prepare('UPDATE miner_proofs SET first_seen_at = first_seen_at - ? WHERE id = ?').run(30 * 86400, anchorId);
    await op.recordOwnerEvidence(db, V, '203.0.113.9', null);
    const back = setRows(db, V, 'ip').find((r) => r.id === anchorId);
    assert.strictEqual(back.evicted_at, null, 'with mayDisplace it returns to the live set');
    assert.strictEqual(back.is_anchor, 1, 'still the anchor row, not a copy');
    assert.strictEqual(liveRows(db, V, 'ip').length, MAX, 'and the cap still holds');
    const reborn = await op.verifyOwnerProof(db, V, '203.0.113.9', '203.0.113.9');
    assert.strictEqual(reborn.slot, 'set', 'a re-activated anchor is live again, so it is an ordinary member again');
    ok('§17.2 #5 a re-activated anchor rejoins the set without breaking the cap');

    // …which is exactly why its age must RESTART (Part 4 review). Once live it is labelled
    // 'set', so an old stamp would turn four shares from whoever now holds the value — the
    // owner's former CGNAT or re-leased IP — into an AGED destination leg: the evicted-anchor
    // refusal above, laundered. Before the fix this row kept the month-old stamp and passed.
    assert.ok(reborn.age_seconds < MIN_PROOF_AGE_SEC, 'a returning anchor starts a fresh age');
    assert.strictEqual(destinationLegOk(reborn), false,
      'a re-activated anchor must not be an aged leg for the destination gate');
    ok('Part 4 a re-activated anchor cannot be laundered into an aged destination leg');
  }

  // ── §17.2 #2 — a multi-site owner keeps every proof across reconnects ───────────────────
  // The §17.1 defect, asserted directly: under the 2-slot window this loop rotated the set on
  // every reconnect, re-stamped the age the destination gate reads, and evicted a site.
  {
    const db = freshDb();
    const V = ADDR('m'); mk(db, V);
    const sites = [['203.0.113.10', 'site-a-rig-pass'], ['198.51.100.10', 'site-b-rig-pass'],
                   ['192.0.2.10', 'site-c-rig-pass']];
    for (const [ip, pw] of sites) await op.recordOwnerEvidence(db, V, ip, pw);
    const seenAfterFirst = setRows(db, V, 'ip').map((r) => r.first_seen_at);

    // Six reconnects, round-robin across the three sites — the exact churn that broke before.
    for (let round = 0; round < 2; round++) {
      for (const [ip, pw] of sites) await op.recordOwnerEvidence(db, V, ip, pw);
    }
    assert.strictEqual(liveRows(db, V, 'ip').length, 3, 'three sites, three rows, no churn');
    assert.strictEqual(liveRows(db, V, 'pass').length, 3, 'three different rig passwords all kept');
    assert.deepStrictEqual(setRows(db, V, 'ip').map((r) => r.first_seen_at), seenAfterFirst,
      'a reconnect from a KNOWN value must not move first_seen_at');
    backdate(db, V, 30 * 86400);
    for (const [ip, pw] of sites) {
      const a = await op.verifyOwnerProof(db, V, ip, ip);
      const b = await op.verifyOwnerProof(db, V, pw, ip);
      assert.ok(a.ok && b.ok, `site ${ip} must still verify on both kinds`);
      assert.ok(destinationLegOk(a) && destinationLegOk(b), `site ${ip} keeps its age`);
    }
    // A refresh is not news, so it writes no audit row — that silence is the point of §17.
    assert.strictEqual(auditRows(db, V).filter((r) => /evidence_added/.test(r.action)).length, 4,
      'audited the two later sites (2 kinds each) and nothing for the six reconnects');
    ok('§17.2 #2 three sites survive repeated reconnects with their ages intact');
  }

  // ── §17.2 #5 — one share may establish a proof, not add one beside somebody else's ──────
  {
    const db = freshDb();
    const V = ADDR('s'); mk(db, V);
    await op.recordOwnerEvidence(db, V, '203.0.113.9', 'victim-rig-secret');
    const beforeIp = setRows(db, V, 'ip').length;
    const beforePass = setRows(db, V, 'pass').length;

    await op.recordOwnerEvidence(db, V, '198.51.100.7', 'attacker-chosen-pw', { mayDisplace: false });
    assert.strictEqual(setRows(db, V, 'ip').length, beforeIp, 'a low-work session adds no IP row');
    assert.strictEqual(setRows(db, V, 'pass').length, beforePass, 'nor a password row');
    assert.strictEqual((await op.verifyOwnerProof(db, V, '198.51.100.7', '198.51.100.7')).ok, false);
    ok('§17.2 #5 mayDisplace=false cannot add to a non-empty set');

    // A refresh of a value already on record is ALWAYS allowed — an honest rig reconnecting
    // has one accepted share too, and must not have to re-earn PROOF_MIN_SHARES to be seen.
    const before = liveRows(db, V, 'ip')[0];
    await op.recordOwnerEvidence(db, V, '203.0.113.9', 'victim-rig-secret', { mayDisplace: false });
    const after = liveRows(db, V, 'ip')[0];
    assert.strictEqual(after.id, before.id, 'the same row');
    assert.strictEqual(after.first_seen_at, before.first_seen_at, 'first_seen_at never moves');
    ok('§17.2 #5 a low-work session may still refresh a value already on record');

    // But an EMPTY set still fills on the first share — a new address has nothing to protect.
    const N = ADDR('t'); mk(db, N);
    await op.recordOwnerEvidence(db, N, '198.51.100.7', 'newcomer-secret', { mayDisplace: false });
    assert.ok((await op.verifyOwnerProof(db, N, '198.51.100.7', '198.51.100.7')).ok);
    assert.strictEqual(setRows(db, N, 'ip')[0].is_anchor, 1);
    ok('§17.2 #5 first capture into an empty set is not gated');
  }

  // ── §17.2 #3 — two first captures landing together must share ONE salt ──────────────────
  // Two rigs' first accepted shares for a brand-new address. If each minted its own salt, one
  // of the rows written here could never be matched again — a proof the owner cannot use.
  {
    const db = freshDb();
    const V = ADDR('n'); mk(db, V);
    await Promise.all([
      op.recordOwnerEvidence(db, V, '203.0.113.21', 'rig-one-password'),
      op.recordOwnerEvidence(db, V, '203.0.113.22', 'rig-two-password')
    ]);
    const salts = db.prepare('SELECT proof_salt FROM miner_accounts WHERE grin_address = ?').all(V);
    assert.strictEqual(salts.length, 1);
    assert.ok(salts[0].proof_salt, 'a salt was minted');
    assert.strictEqual(op.getOrCreateSalt(db, V), salts[0].proof_salt,
      'getOrCreateSalt returns the STORED value, never the one it just generated');
    for (const v of ['203.0.113.21', '203.0.113.22', 'rig-one-password', 'rig-two-password']) {
      assert.ok((await op.verifyOwnerProof(db, V, v, '203.0.113.21')).ok,
        `${v} must verify — a row hashed under a losing salt would not`);
    }
    for (const kind of ['ip', 'pass']) {
      assert.strictEqual(setRows(db, V, kind).filter((r) => r.is_anchor === 1).length, 1,
        'exactly ONE anchor per kind, even when both captures saw an empty set');
    }
    ok('§17.2 #3 concurrent first captures share one salt and produce one anchor');
  }

  // ── Part 4 — two captures of the SAME new value must cost a full set ONE row ────────────
  // Ten rigs behind one NAT reach PROOF_MIN_SHARES together after a pool restart. While a
  // capture awaits the v1 checks of a migrated account, the other one inserts the value; the
  // first then re-read the table without recognising it, took the insert path, evicted an
  // owner's proof, and had its INSERT ignored — one proof lost for nothing, set left at 9.
  // Reproduced against the unfixed code before the fix (2 rows lost, not 1).
  {
    const db = freshDb();
    const V = ADDR('g'); mk(db, V);
    db.prepare('UPDATE miner_accounts SET last_ip = ?, last_ip_at = 1700000000 WHERE grin_address = ?')
      .run(await op.hashProof('192.0.2.1'), V);
    op.migrateProofSet(db); // one v1 row: that is what gives the race its await window
    for (let i = 0; i < 9; i++) await op.recordOwnerEvidence(db, V, '198.51.100.' + i, null);
    const before = liveRows(db, V, 'ip').map((r) => r.id);
    assert.strictEqual(before.length, op.PROOF_SET_MAX, 'a full set');
    await Promise.all([
      op.recordOwnerEvidence(db, V, '203.0.113.7', null),
      op.recordOwnerEvidence(db, V, '203.0.113.7', null)
    ]);
    const after = liveRows(db, V, 'ip').map((r) => r.id);
    assert.strictEqual(after.length, op.PROOF_SET_MAX, 'the set is still full, not one short');
    assert.strictEqual(before.filter((id) => !after.includes(id)).length, 1,
      'exactly one owner proof made room for the one new value');
    ok('Part 4 a racing duplicate capture refreshes instead of evicting a second proof');
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

  // ── §17.2 #9 — the migration must run BEFORE the stratum listener starts ─────────────────
  // Source order, because it cannot be observed any other way without booting the pool. The
  // §J3 backfill and then migrateProofSet both sat AFTER stratumServer.start() with an
  // `await nostrBridge.start()` between them, so on a pool with Nostr payouts on, shares were
  // being accepted — and captures anchoring whoever mined them — while the relays answered.
  // Every other check in this file passed throughout (Part 4 review).
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    // Anchored on the STATEMENTS, not the names — comments mention both.
    const at = (re) => { const m = re.exec(src); return m ? m.index : -1; };
    const mig = at(/^[ \t]*migrateProofSet\(db\);/m);
    const start = at(/^[ \t]*stratumServer\.start\(\);/m);
    assert.ok(mig > 0 && start > 0, 'both call sites exist');
    assert.ok(mig < start, 'migrateProofSet(db) must come before stratumServer.start()');
    const between = src.slice(mig, start);
    assert.strictEqual(/\bawait\b/.test(between.replace(/\/\/.*$/gm, '')), false,
      'and no await may sit between them');
    ok('§17.2 #9 the proof-set migration runs before the stratum listener, with no await between');
  }

  // ── §17.4 / audit §F2 — what a FAILED verify costs in KDF calls ─────────────────────────
  // The per-IP throttle (FAIL_MAX_IP = 20 per 10 min) is sized against this number, so it is
  // asserted rather than reasoned about: the old 2-slot code cost up to 6 scrypts per failed
  // guess, and a set of ten would have cost 20 if the salt were per-row. Counted by wrapping
  // crypto.scrypt/scryptSync, which is the only way to see a cost that has no other symptom.
  {
    const crypto = require('crypto');
    const realAsync = crypto.scrypt;
    const realSync = crypto.scryptSync;
    let calls = 0;
    crypto.scrypt = function (...a) { calls++; return realAsync.apply(crypto, a); };
    crypto.scryptSync = function (...a) { calls++; return realSync.apply(crypto, a); };
    try {
      const db = freshDb();
      const V = ADDR('p'); mk(db, V);
      // A full set of ten v2 rows — the state a busy farm converges on.
      for (let i = 0; i < 10; i++) await op.recordOwnerEvidence(db, V, '198.51.100.' + i, null);
      assert.strictEqual(liveRows(db, V, 'ip').length, 10);

      calls = 0;
      const miss = await op.verifyOwnerProof(db, V, '203.0.113.200', '203.0.113.200');
      assert.strictEqual(miss.ok, false);
      assert.strictEqual(calls, 1,
        'a failed verify against a fully-migrated set must cost ONE scrypt, whatever its size');
      ok('§17.4 one KDF call per failed verify on a v2-only set');

      calls = 0;
      assert.ok((await op.verifyOwnerProof(db, V, '198.51.100.4', '203.0.113.200')).ok);
      assert.strictEqual(calls, 1, 'and a SUCCESSFUL verify costs one too');
      ok('§17.4 one KDF call per successful verify, regardless of which row matches');

      // The exception the old comment denied (Part 4 review): an IP whose canonical form
      // differs from what was typed AND which is password-shaped needs two digests — the IP
      // set is keyed on the canonical form, the password set on the raw one.
      calls = 0;
      assert.strictEqual((await op.verifyOwnerProof(db, V, '2001:db8::1', '203.0.113.202')).ok, false);
      assert.strictEqual(calls, 2, 'a compressed IPv6 costs two digests, not one');
      ok('§17.4 a non-canonical, password-shaped IP costs two KDF calls');

      // A migrated account still carrying v1 rows pays one extra per v1 row — bounded by the
      // three the old window could hold, and it falls away as captures rewrite them.
      const L = ADDR('l'); mk(db, L);
      const legacy = await op.hashProof('192.0.2.77');
      db.prepare('UPDATE miner_accounts SET last_ip = ?, last_ip_at = 1700000000 WHERE grin_address = ?')
        .run(legacy, L);
      op.migrateProofSet(db);
      calls = 0;
      assert.strictEqual((await op.verifyOwnerProof(db, L, '203.0.113.201', '203.0.113.201')).ok, false);
      assert.strictEqual(calls, 1,
        'an account whose rows are ALL legacy has no salt yet, so verify skips the v2 hash');
      // Once it captures anything under the new scheme it has a salt, and then a failed verify
      // pays for the v2 digest PLUS each surviving legacy row. Three was the old window's
      // maximum, so this is the ceiling §F2's per-IP throttle is sized against.
      await op.recordOwnerEvidence(db, L, '192.0.2.88', null);
      calls = 0;
      assert.strictEqual((await op.verifyOwnerProof(db, L, '203.0.113.201', '203.0.113.201')).ok, false);
      assert.strictEqual(calls, 2, 'one for the v2 digest, one for the single legacy row');
      // ...and the legacy row stops costing anything once a capture matches and rewrites it.
      await op.recordOwnerEvidence(db, L, '192.0.2.77', null);
      assert.ok(setRows(db, L, 'ip').every((r) => r.hash.startsWith('v2$')), 'no v1 rows left');
      calls = 0;
      assert.strictEqual((await op.verifyOwnerProof(db, L, '203.0.113.201', '203.0.113.201')).ok, false);
      assert.strictEqual(calls, 1, 'back to one KDF call once the set is fully v2');
      ok('§17.4 a legacy row adds exactly one KDF call, and only until it is rewritten');

      // The transitional CEILING, which is what §F2 has to be sized against: a migrated
      // account holding anchor/last/prev of BOTH kinds (six v1 rows) and a salt, probed with
      // an input that is both a non-canonical IP and password-shaped. 2 + 6 = 8 — above the
      // old window's 6. §17.4 said "1 + n_v1, n_v1 ≤ 3"; both halves were under-counted.
      const W = ADDR('h');
      const [a1, a2, a3, p1, p2, p3] = await Promise.all(
        ['192.0.2.1', '192.0.2.2', '192.0.2.3', 'pw-anchor-1', 'pw-last-22', 'pw-prev-333'].map((v) => op.hashProof(v)));
      db.prepare(`INSERT INTO miner_accounts (grin_address, balance, anchor_ip, last_ip, prev_ip,
        anchor_pass_hash, last_pass_hash, prev_pass_hash, anchor_set_at, last_ip_at, prev_ip_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1, 3, 2)`).run(W, a1, a2, a3, p1, p2, p3);
      op.migrateProofSet(db);
      await op.recordOwnerEvidence(db, W, '198.51.100.250', null); // mints the salt
      calls = 0;
      assert.strictEqual((await op.verifyOwnerProof(db, W, '2001:db8::1', '203.0.113.203')).ok, false);
      assert.strictEqual(calls, 8, '2 v2 digests + 6 legacy rows is the transitional ceiling');
      ok('§17.4 the transitional worst case is 8 KDF calls, and is asserted');
    } finally {
      crypto.scrypt = realAsync;
      crypto.scryptSync = realSync;
    }
  }

  // ── reason strings the callers map — index.js and the account page key off these ────────
  {
    const db = freshDb();
    const E = ADDR('k'); mk(db, E);
    assert.strictEqual((await op.verifyOwnerProof(db, E, '203.0.113.5', '203.0.113.5')).reason,
      'no_recorded_proof', 'an account that has never mined a share has no proof, not no match');
    assert.strictEqual((await op.verifyOwnerProof(db, E, '', '203.0.113.5')).reason, 'proof_required');
    assert.strictEqual((await op.verifyOwnerProof(db, ADDR('j'), 'x'.repeat(12), '203.0.113.5')).reason,
      'account_not_found');
    await op.recordOwnerEvidence(db, E, '203.0.113.5', 'real-rig-password');
    assert.strictEqual((await op.verifyOwnerProof(db, E, 'short', '203.0.113.5')).reason,
      'password_too_short', 'a rejected password reports WHY and costs no KDF call');
    assert.strictEqual((await op.verifyOwnerProof(db, E, 'antminer', '203.0.113.5')).reason,
      'trivial_password', 'long enough to reach the blocklist, and on it');
    assert.strictEqual((await op.verifyOwnerProof(db, E, 'not-the-password', '203.0.113.5')).reason,
      'no_match');
    ok('the reason strings index.js and the account page map are unchanged');
  }

  console.log(`\n${passed} ownership-gate checks passed (audit §J3 + design §17).`);
})().catch((err) => {
  console.error('\nFAILED:', err && err.message);
  process.exit(1);
});
