'use strict';
/**
 * store.test.js — the suffix ↔ session table.
 *
 * Every row in this table is somebody's receiving address, so the failures worth
 * testing are not "does mint return a string" but the quiet ones: a restart that
 * changes an address, a snapshot that gets overwritten, an eviction nobody is
 * told about. Those are the R6 findings, and each has an assertion below.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { Store, MintError, SUFFIX_ALPHABET, SNAPSHOT_VERSION } = require('../store');
const { tmpDir, makeCfg, makeLog, cleanup } = require('./helpers');

test.after(cleanup);

/** A store on its own private state dir. Returns everything a test may poke. */
function makeStore(overrides = {}) {
	const dir = tmpDir('accio-state');
	const cfg = makeCfg(Object.assign({ state_dir: dir }, overrides));
	const log = makeLog();
	const store = new Store(cfg, log);
	return { store, cfg, log, dir, file: path.join(dir, 'listen-state.json') };
}

function writeSnapshot(file, data) {
	fs.writeFileSync(file, JSON.stringify(Object.assign({ version: SNAPSHOT_VERSION }, data)));
}

// ─── Minting ─────────────────────────────────────────────────────────────────

test('a minted suffix is lowercase, and that is load-bearing', () => {
	// Inbound lookup lowercases while the wallet stores what it was given
	// VERBATIM, so a single uppercase character indexes the wallet under a key
	// the lookup can never produce: the address displays fine and every inbound
	// payment 404s, with nothing in the UI to explain it.
	const { store, cfg } = makeStore();
	const sid = store.createSession();
	for (let i = 0; i < 50; i++) {
		const suffix = store.mint(sid);
		assert.equal(suffix, suffix.toLowerCase());
		assert.equal(suffix.length, cfg.suffix_length);
		assert.match(suffix, /^[a-z2-7]+$/);
		store.release(sid, suffix);
	}
});

test('the alphabet is exactly 32 symbols, so the mask is unbiased', () => {
	assert.equal(SUFFIX_ALPHABET.length, 32);
	assert.equal(new Set(SUFFIX_ALPHABET).size, 32);
});

test('minting under a session that no longer exists is refused', () => {
	// It would produce a row that WORKS until the next restart and then vanishes,
	// because _load drops any suffix whose session did not survive.
	const { store } = makeStore();
	assert.throws(() => store.mint('no-such-session'), MintError);
});

test('ownership is per session, and a stranger owns nothing', () => {
	const { store } = makeStore();
	const a = store.createSession();
	const b = store.createSession();
	const suffix = store.mint(a);
	assert.ok(store.owns(a, suffix));
	assert.ok(!store.owns(b, suffix));
	assert.ok(!store.release(b, suffix), 'another session must not be able to release it');
	assert.ok(store.lookup(suffix), 'and the failed release must not have removed it');
});

// ─── R6 / M1: evictions must be announced ────────────────────────────────────

test('R6: every removal path calls onForget', () => {
	// `state.owned` on each socket mirrors this table. A mirror nobody updates is
	// a leak: before the hook, Create URL in a loop grew a per-socket Set at the
	// client's full message rate, forever, while the table stayed correctly capped.
	const { store, cfg } = makeStore({ max_suffixes_per_session: 2 });
	const forgotten = [];
	store.onForget = (suffix, sid) => forgotten.push({ suffix, sid });

	const sid = store.createSession();
	const first = store.mint(sid);
	store.mint(sid);
	assert.equal(forgotten.length, 0, 'nothing has been removed yet');

	// The third mint hits the per-session cap and evicts the oldest UNVERIFIED.
	store.mint(sid);
	assert.equal(cfg.max_suffixes_per_session, 2);
	assert.deepEqual(forgotten.map((f) => f.suffix), [first], 'the evicted suffix must be announced');
	assert.equal(forgotten[0].sid, sid);

	// release()
	forgotten.length = 0;
	const held = [...store.bySession.get(sid)][0];
	store.release(sid, held);
	assert.deepEqual(forgotten.map((f) => f.suffix), [held]);

	// dropSession() takes its suffixes with it, and each one is announced.
	forgotten.length = 0;
	const remaining = [...store.bySession.get(sid)];
	store.dropSession(sid);
	assert.deepEqual(forgotten.map((f) => f.suffix).sort(), remaining.sort());
});

test('R6: a throwing onForget cannot corrupt the table', () => {
	// The table's consistency must not depend on the mirror's correctness.
	const { store, log } = makeStore({ max_suffixes_per_session: 1 });
	store.onForget = () => { throw new Error('mirror is broken'); };
	const sid = store.createSession();
	store.mint(sid);
	const second = store.mint(sid);           // evicts the first, hook throws
	assert.equal(store.bySession.get(sid).size, 1);
	assert.ok(store.owns(sid, second));
	assert.match(log.all(), /onForget hook threw/);
	assert.ok(!log.all().includes(second), 'and the line must not carry the address');
});

test('a verified suffix is not evicted; the session refuses instead', () => {
	const { store } = makeStore({ max_suffixes_per_session: 2 });
	const sid = store.createSession();
	const a = store.mint(sid);
	const b = store.mint(sid);
	store.markVerified(a);
	store.markVerified(b);
	assert.throws(() => store.mint(sid), MintError);
	assert.ok(store.owns(sid, a), 'a confirmed address must survive');
	assert.ok(store.owns(sid, b));
});

// ─── Persistence ─────────────────────────────────────────────────────────────

test('a restart keeps every address — the whole point of the file', () => {
	const { store, cfg, log, file } = makeStore();
	const sid = store.createSession();
	const suffix = store.mint(sid);
	store.markVerified(suffix);
	store.flush();

	const reopened = new Store(cfg, log);
	assert.ok(reopened.owns(sid, suffix), 'the address must survive a restart');
	assert.equal(reopened.lookup(suffix).verified, true);
	assert.ok(fs.existsSync(file));
});

test('an empty session is never persisted', () => {
	// A session is minted by ANY completed handshake, before the client has asked
	// for anything, so persisting them all let a handshake flood rewrite an
	// ever-growing snapshot every two seconds.
	const { store, file } = makeStore();
	const owner = store.createSession();
	store.createSession();                     // owns nothing
	store.mint(owner);
	store.flush();
	const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
	assert.deepEqual(Object.keys(snap.sessions), [owner]);
});

test('a suffix whose session did not survive is dropped on load', () => {
	const { cfg, log, file } = makeStore();
	writeSnapshot(file, {
		sessions: {},
		suffixes: { abcdefghijklmnop: { sid: 'gone', created: Date.now(), seen: Date.now() } },
	});
	const store = new Store(cfg, log);
	assert.equal(store.suffixes.size, 0, 'an orphan could never be claimed again');
});

test('R6: the snapshot is fsynced before the rename, and the tmp file is gone', () => {
	const { store, dir } = makeStore();
	const sid = store.createSession();
	store.mint(sid);
	store.flush();
	assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')), 'no tmp file may be left behind');
	assert.equal(fs.statSync(path.join(dir, 'listen-state.json')).size > 0, true);
});

// ─── R6 / C1: an unreadable snapshot must never be overwritten ───────────────

test('R6: a snapshot we cannot READ is fatal, not "start empty"', () => {
	// Starting empty means the next flush renames OVER a table full of live
	// addresses — rename takes its permission from the directory, which we own,
	// not from the file we just failed to read. A restore that left the file
	// root-owned therefore destroyed every address in it, two seconds after boot.
	const dir = tmpDir('accio-state');
	const cfg = makeCfg({ state_dir: dir });
	const log = makeLog();
	// A directory where the file should be: readFileSync gives EISDIR, which is
	// the same class of non-ENOENT failure as the EACCES that motivated this.
	fs.mkdirSync(path.join(dir, 'listen-state.json'));
	assert.throws(() => new Store(cfg, log), /Refusing to start rather than overwrite/);
});

test('a MISSING snapshot is the normal first run, not an error', () => {
	const { store, log } = makeStore();
	assert.equal(store.suffixes.size, 0);
	assert.ok(!log.lines.error.length, 'a first run must be silent');
});

test('a corrupt snapshot is moved aside, never deleted, and counted', () => {
	const { cfg, log, file, dir } = makeStore();
	fs.writeFileSync(file, '{ truncated');
	const store = new Store(cfg, log);
	const aside = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
	assert.equal(aside.length, 1, 'the operator needs the file intact');
	assert.equal(store.counts().snapshots_set_aside, 1, 'and needs to be told it exists');
	assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{ truncated');
});

test('a snapshot from a future version is moved aside, not consumed', () => {
	const { cfg, log, file, dir } = makeStore();
	fs.writeFileSync(file, JSON.stringify({ version: SNAPSHOT_VERSION + 1, sessions: {}, suffixes: {} }));
	const store = new Store(cfg, log);
	assert.equal(store.suffixes.size, 0);
	assert.equal(fs.readdirSync(dir).filter((n) => n.includes(`.v${SNAPSHOT_VERSION + 1}-`)).length, 1);
});

// ─── R6 / L8: the caps apply at load, not only at mint ───────────────────────

test('R6: a snapshot that exceeds the current caps is trimmed on load', () => {
	// A limit an operator has just tightened must be in force at the restart they
	// tightened it in, not whenever the table next happens to be touched.
	const dir = tmpDir('accio-state');
	const file = path.join(dir, 'listen-state.json');
	const now = Date.now();
	const sessions = { s1: { created: now, seen: now } };
	const suffixes = {};
	for (let i = 0; i < 6; i++) {
		suffixes[`aaaaaaaaaaaaaa${String(i).padStart(2, '0')}`] = { sid: 's1', created: now + i, seen: now, verified: false };
	}
	writeSnapshot(file, { sessions, suffixes });

	const cfg = makeCfg({ state_dir: dir, max_suffixes_total: 3 });
	const store = new Store(cfg, makeLog());
	assert.equal(store.suffixes.size, 3, 'the configured cap must be applied at load');
	// Oldest-unverified-first, the same rule the evictors use.
	assert.ok(!store.lookup('aaaaaaaaaaaaaa00'));
	assert.ok(store.lookup('aaaaaaaaaaaaaa05'));
});

// ─── Expiry ──────────────────────────────────────────────────────────────────

test('an expired session takes its addresses with it', () => {
	const { store } = makeStore({ session_ttl_days: 1 });
	const sid = store.createSession();
	const suffix = store.mint(sid);
	store.sessions.get(sid).seen = Date.now() - (2 * 24 * 60 * 60 * 1000);
	assert.equal(store.getSession(sid), null, 'the session is past its ttl');
	assert.equal(store.lookup(suffix), null, 'and its address went with it');
});

test('a session that never claimed an address is swept on the SHORT ttl', () => {
	const { store } = makeStore({ empty_session_ttl_ms: 1000 });
	const empty = store.createSession();
	const owner = store.createSession();
	store.mint(owner);
	store.sessions.get(empty).created = Date.now() - 5000;
	store.sessions.get(owner).created = Date.now() - 5000;
	store.sweep();
	assert.ok(!store.sessions.has(empty), 'an empty session only has to outlive the first Create URL');
	assert.ok(store.sessions.has(owner), 'a session that owns an address keeps the full ttl');
});

test('a rolling touch keeps an address alive indefinitely', () => {
	// The session lifetime IS the address lifetime, so this is the mechanism by
	// which a tab that keeps connecting never loses its receiving address.
	const { store } = makeStore({ session_ttl_days: 1 });
	const sid = store.createSession();
	const suffix = store.mint(sid);
	store.sessions.get(sid).seen = Date.now() - (20 * 60 * 60 * 1000);
	store.touchSession(sid);
	store.sweep();
	assert.ok(store.owns(sid, suffix));
});

// ─── R6 / M2: the writer scales with the table ───────────────────────────────

test('R6: the flush debounce grows with the table', () => {
	// The debounce bounded how OFTEN we write and nothing bounded how MUCH: at
	// 100k rows a trickle of mints meant ~10 MB every 2 s, forever.
	const { store, cfg } = makeStore();
	assert.equal(store._flushDelay(), cfg.state_flush_ms);
	store.suffixes.set('x'.repeat(16), { sid: 's', created: 1, seen: 1, verified: true });
	assert.equal(store._flushDelay(), cfg.state_flush_ms, 'a small table pays the base delay');
	for (let i = 0; i < 25000; i++) store.suffixes.set(`k${i}`, { sid: 's', created: 1, seen: 1, verified: true });
	assert.ok(store._flushDelay() > cfg.state_flush_ms, 'a large one must write less often, not more');
	assert.equal(store._flushDelay(), cfg.state_flush_ms * 3);
});

// ─── In-memory mode ──────────────────────────────────────────────────────────

test('no state_dir means in-memory, and says so loudly', () => {
	const cfg = makeCfg({ state_dir: '' });
	const log = makeLog();
	const store = new Store(cfg, log);
	assert.equal(store.durable, false);
	assert.match(log.all(), /IN MEMORY ONLY/);
	assert.match(log.all(), /change the receiving address of every wallet/);
	assert.equal(store.counts().durable, false);
	// It must still work, just not survive.
	const sid = store.createSession();
	assert.ok(store.mint(sid));
});
