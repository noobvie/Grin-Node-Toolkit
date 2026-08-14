'use strict';
/**
 * money_rails.test.js — the inbound rail's four money-relevant rules (R7).
 *
 * guard.test.js covers the SSRF boundary on the way OUT. This covers the way IN,
 * which is where a mistake costs a payment rather than a circuit: who is handed
 * an arriving slate, what an arriving slate is allowed to cost us before we know
 * the address exists, and what keeps an address alive.
 *
 * Every test here was written against a defect R7 found in code that already
 * looked right and already passed `node --check`. The negative controls are
 * recorded in each block: revert the fix and the named assertion fails.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Store } = require('../store');
const { ListenHub } = require('../listen_route');
const walletRoute = require('../wallet_route');
const { makeCfg, makeLog, bodyReq, tick, makeRes, attachSocket, cleanup } = require('./helpers');

test.after(cleanup);

/** The counters server.js keeps. Shape-checked against it by the last test. */
function makeStats() {
	return {
		listen_connections: 0, listen_open: 0, listen_refused: 0, suffixes_minted: 0,
		inbound_requests: 0, inbound_delivered: 0, inbound_unknown: 0, inbound_offline: 0,
		inbound_unclaimed: 0, inbound_busy: 0, inbound_timeout: 0, inbound_abandoned: 0,
		inbound_too_large: 0, inbound_in_flight: 0,
	};
}

function makeHub(overrides = {}) {
	const cfg = makeCfg(overrides);
	const log = makeLog();
	const stats = makeStats();
	const store = new Store(cfg, log);
	const hub = new ListenHub(cfg, log, store, stats);
	return { cfg, log, stats, store, hub };
}

// ─────────────────────────────────────────────────────────────────────────────
test('inbound money goes only to a socket that claimed that address', (t) => {
	const { cfg, log, stats, store, hub } = makeHub();
	t.after(() => hub.shutdown());

	const sid = store.createSession();
	const suffix = store.mint(sid);

	// The attacker holds the session cookie — a tossed cookie from a sibling host,
	// a stolen one — so they are in the same session as the payee. What they do
	// NOT have is the address: a suffix is 80 bits and they cannot name it. They
	// connect, say nothing at all, and wait.
	const attacker = attachSocket(hub, sid, { opened: Date.now() + 10000 });

	const res1 = makeRes();
	hub.deliver({ suffix, body: Buffer.from('{}'), res: res1 });

	// ⚠ THE NEGATIVE CONTROL. Restore the deleted `pool = claimants.length ?
	// claimants : live` fallback and this assertion fails: the request is held
	// open pending the ATTACKER's answer, their wallet answers with their own
	// output, and neither UI shows anything wrong.
	assert.equal(res1.status, 503, 'a cookie-only socket must not be handed the slate');
	assert.equal(attacker.sent.length, 0, 'nothing at all is forwarded to it');
	assert.equal(stats.inbound_unclaimed, 1, 'counted as unclaimed, distinctly from offline');
	assert.equal(hub.inFlight, 0, 'and no delivery slot was consumed');

	// The real payee: same session, an OLDER socket, but it has claimed the
	// suffix — which §10 says every real client does on every reconnect.
	const payee = attachSocket(hub, sid, { opened: Date.now() });
	payee.owned.add(suffix);

	const res2 = makeRes();
	hub.deliver({ suffix, body: Buffer.from('{"jsonrpc":"2.0"}'), res: res2 });

	assert.equal(payee.sent.length, 1, 'the claiming socket receives the interaction');
	assert.equal(attacker.sent.length, 0,
		'the NEWER unclaiming socket still gets nothing — it would have won the old "newest" rule');
	assert.equal(payee.sent[0].URL, suffix);
	assert.equal(payee.sent[0].API, '/v2/foreign');
	assert.equal(payee.sent[0].Type, 'application/json',
		'the BARE type, never the sender header — a charset would make the tab answer 415');

	// Settle it so nothing is left parked on a 180 s timer.
	hub._onInteractionResponse(payee, {
		Interaction: payee.sent[0].Interaction,
		Status: 0, Type: 'application/json', Data: Buffer.from('{"ok":1}').toString('base64'),
	});
	assert.equal(res2.status, 200);
	assert.equal(cfg.listen_enabled, true);
	assert.equal(log.lines.error.length, 0, 'nothing on this path is an error');
});

test('a session with no live socket is still offline, not unclaimed', (t) => {
	const { stats, store, hub } = makeHub();
	t.after(() => hub.shutdown());

	const sid = store.createSession();
	const suffix = store.mint(sid);
	const payee = attachSocket(hub, sid);
	payee.owned.add(suffix);
	payee.ws.close();          // the tab goes away, and the hub's teardown runs

	const res = makeRes();
	hub.deliver({ suffix, body: Buffer.from('{}'), res });
	assert.equal(res.status, 503);
	assert.equal(stats.inbound_offline, 1, 'the payee is offline');
	assert.equal(stats.inbound_unclaimed, 0, 'which is a different thing from unclaimed');
	assert.equal(res.headers['retry-after'], '30', 'and it is worth waiting longer for');
});

// ─────────────────────────────────────────────────────────────────────────────
test('an unknown address is refused before a byte of body is buffered', (t) => {
	const { cfg, log, stats, hub } = makeHub();
	t.after(() => hub.shutdown());

	assert.equal(hub.knows('aaaaaaaaaaaaaaaa'), false, 'a suffix nobody minted is unknown');

	let delivered = false;
	hub.deliver = () => { delivered = true; };

	const req = bodyReq('/wallet/aaaaaaaaaaaaaaaa/v2/foreign', { chunks: [Buffer.alloc(64)] });
	const res = makeRes();
	walletRoute.handle(req, res, { cfg, log, hub, stats });

	assert.equal(res.status, 404, 'answered 404');
	assert.equal(delivered, false, 'deliver() was never reached, so no body was buffered for it');
	// ⚠ THE NEGATIVE CONTROL. Move the knows() check back below readBody and this
	// fails: a stranger with no address and no session gets to spend a full
	// inbound_body_bytes of this process's heap, max_inbound_in_flight times over.
	assert.equal(hub.reading, 0, 'no read slot was reserved from the inbound budget');
	assert.equal(req.resumed, true, 'the refused body is still drained, so the socket closes cleanly');
	assert.equal(stats.inbound_unknown, 1);
	assert.equal(stats.inbound_requests, 1, '/health counts it exactly as deliver() used to');
});

test('a known address still reaches deliver(), and releases its read slot', async (t) => {
	const { cfg, log, stats, store, hub } = makeHub();
	t.after(() => hub.shutdown());

	const sid = store.createSession();
	const suffix = store.mint(sid);

	let seen = null;
	hub.deliver = (arg) => { seen = arg; };

	const req = bodyReq(`/wallet/${suffix}/v2/foreign`, { chunks: [Buffer.from('{"a":1}')] });
	walletRoute.handle(req, makeRes(), { cfg, log, hub, stats });
	assert.equal(hub.reading, 1, 'a read slot is held WHILE the body is streaming in');
	await tick();

	assert.ok(seen, 'the doorman lets a real address through');
	assert.equal(seen.suffix, suffix);
	assert.equal(seen.body.toString(), '{"a":1}', 'with the body intact');
	assert.equal(hub.reading, 0, 'and the read reservation is released, not leaked');
});

test('an UPPERCASED address still routes — the suffix is folded at the route', async (t) => {
	const { cfg, log, stats, store, hub } = makeHub();
	t.after(() => hub.shutdown());

	const sid = store.createSession();
	const suffix = store.mint(sid);

	let seen = null;
	hub.deliver = (arg) => { seen = arg; };
	const req = bodyReq(`/wallet/${suffix.toUpperCase()}/v2/foreign`, { chunks: [Buffer.from('{}')] });
	walletRoute.handle(req, makeRes(), { cfg, log, hub, stats });
	await tick();

	assert.ok(seen, 'a QR round-trip that upper-cased the address is not a lost payment');
	assert.equal(seen.suffix, suffix, 'and the doorman sees the same folded key deliver() will');
});

// ─────────────────────────────────────────────────────────────────────────────
test('an accepted payment refreshes the session, which IS the address lifetime', (t) => {
	const { store, hub } = makeHub();
	t.after(() => hub.shutdown());

	const sid = store.createSession();
	const suffix = store.mint(sid);
	const payee = attachSocket(hub, sid);
	payee.owned.add(suffix);

	const res = makeRes();
	hub.deliver({ suffix, body: Buffer.from('{}'), res });

	// Wind both marks back, so "refreshed" cannot be satisfied by them simply
	// already being now.
	const drift = 5000;
	const sessionBefore = store.sessions.get(sid).seen - drift;
	const suffixBefore = store.suffixes.get(suffix).seen - drift;
	store.sessions.get(sid).seen = sessionBefore;
	store.suffixes.get(suffix).seen = suffixBefore;

	hub._onInteractionResponse(payee, {
		Interaction: payee.sent[0].Interaction,
		Status: 0, Type: 'application/json', Data: Buffer.from('{"ok":1}').toString('base64'),
	});

	assert.equal(res.status, 200, 'the sender gets the answer it was waiting for');
	// ⚠ THE NEGATIVE CONTROL. Remove the touchSession/touchSuffix pair and these
	// fail: a tab held open across the ttl has its session swept out from under a
	// LIVE socket, its suffixes deleted with it, and its payments start answering
	// 404 while the UI goes on displaying the old address.
	assert.ok(store.sessions.get(sid).seen > sessionBefore, 'the session ttl was refreshed');
	assert.ok(store.suffixes.get(suffix).seen > suffixBefore, 'and so was the suffix seen-mark');

	const ack = payee.sent[payee.sent.length - 1];
	assert.equal(ack.Status, 'Succeeded',
		'"Succeeded" and nothing else — any other string commits the tx client-side just the same');
	assert.equal(ack.Interaction, payee.sent[0].Interaction);
});

test('a payment the tab never answers is failed, not acked', (t) => {
	const { store, hub } = makeHub();
	t.after(() => hub.shutdown());

	const sid = store.createSession();
	const suffix = store.mint(sid);
	const payee = attachSocket(hub, sid);
	payee.owned.add(suffix);

	const res = makeRes();
	hub.deliver({ suffix, body: Buffer.from('{}'), res });
	assert.equal(hub.inFlight, 1);

	payee.ws.close();          // the tab is closed mid-payment

	assert.equal(res.status, 503, 'the sender is told, rather than left to time out');
	assert.equal(hub.inFlight, 0, 'and the slot is returned');
	const acks = payee.sent.filter((m) => m.Status === 'Succeeded');
	assert.equal(acks.length, 0, 'nothing was acked — an ack would have it record a payment it lost');
});

// ─────────────────────────────────────────────────────────────────────────────
test('the inbound body cap is reconciled with what one listen frame can carry', () => {
	// ⚠ THE NEGATIVE CONTROL. Remove the clamp in config.js and the first
	// assertion fails: the two limits only meet at runtime, where the oversize
	// body is read in full, buffered, and then answered 413 by a check it could
	// never have passed.
	const legacy = makeCfg({ inbound_body_bytes: 1048576 });
	assert.equal(legacy.inbound_body_bytes, 195840,
		'a gateway.json from an earlier packet is clamped, not rejected');
	assert.ok(legacy.inbound_body_bytes <= Math.floor(legacy.ws_max_message_bytes / 4) * 3,
		'the clamped value survives base64 into one frame');

	const dflt = makeCfg();
	assert.equal(dflt.inbound_body_bytes, 131072, 'the default is 128 KiB, well inside the frame');
	assert.equal(dflt.inbound_body_bytes * dflt.max_inbound_in_flight, 33554432,
		'so the whole inbound read budget is 32 MB, not the 256 MB it used to be');

	const roomy = makeCfg({ ws_max_message_bytes: 1048576, inbound_body_bytes: 500000 });
	assert.equal(roomy.inbound_body_bytes, 500000,
		'a value that DOES fit a larger frame is left exactly as configured');
});

test('a body over the cap is refused with 413, and the sender is told', async (t) => {
	const { cfg, log, stats, store, hub } = makeHub({ inbound_body_bytes: 2048 });
	t.after(() => hub.shutdown());

	const sid = store.createSession();
	const suffix = store.mint(sid);

	let delivered = false;
	hub.deliver = () => { delivered = true; };

	const req = bodyReq(`/wallet/${suffix}/v2/foreign`, { chunks: [Buffer.alloc(4096)] });
	const res = makeRes();
	walletRoute.handle(req, res, { cfg, log, hub, stats });
	await tick();

	assert.equal(res.status, 413);
	assert.equal(delivered, false);
	assert.equal(stats.inbound_too_large, 1);
	assert.equal(hub.reading, 0, 'the read reservation is released on the refusal path too');
});

// ─────────────────────────────────────────────────────────────────────────────
test('refuse() cannot throw on an error that carries no message', () => {
	// ⚠ THE NEGATIVE CONTROL, and it has to be refuse() directly: every message
	// handleUpgrade passes from its OWN code is a literal, so driving this through
	// the hub would exercise the safe path and prove nothing. The unsafe one is
	// the catch that forwards `err.message` from ws.handshake() verbatim.
	//
	// Before R7, refuse() called message.replace() on that value. An error with no
	// message raised a TypeError out of handleUpgrade — and an 'upgrade' listener
	// throws straight to uncaughtException, i.e. the whole gateway and every other
	// wallet's live socket gone, for one odd handshake.
	const { refuse } = require('../listen_route');

	for (const [label, message] of [
		['undefined', undefined],
		['null', null],
		['a non-string', { toString() { return 'objecty'; } }],
	]) {
		const writes = [];
		const socket = { write(s) { writes.push(s); }, destroy() {} };
		assert.doesNotThrow(() => refuse(socket, 400, message), `refuse() survives ${label}`);
		assert.equal(writes.length, 1, `${label}: something was still written`);
		assert.match(writes[0], /^HTTP\/1\.1 400 /, `${label}: a well-formed status line`);
		assert.match(writes[0], /Connection: close/, `${label}: and the connection is closed`);
	}

	// A CR/LF in the message must not open a second header line. Same value
	// channel, so the coercion above must not have cost the stripping.
	const writes = [];
	refuse({ write(s) { writes.push(s); }, destroy() {} }, 400, 'bad\r\nX-Injected: yes');
	const headerLines = writes[0].split('\r\n\r\n')[0].split('\r\n');
	assert.ok(!headerLines.some((l) => /^X-Injected:/i.test(l)),
		'a newline in the message cannot become a header of its own');
	assert.match(headerLines[0], /^HTTP\/1\.1 400 bad {2}X-Injected: yes$/,
		'it is folded into the status line as inert text instead — stripped, not dropped');
});

test('the counters this suite fakes still match the ones server.js keeps', () => {
	// A stats double that has drifted from the real object is how a counter
	// assertion goes green against a field nothing increments.
	const src = require('node:fs').readFileSync(require.resolve('../server.js'), 'utf8');
	for (const key of Object.keys(makeStats())) {
		assert.match(src, new RegExp(`\\b${key}\\s*:`), `server.js still declares ${key}`);
	}
});
