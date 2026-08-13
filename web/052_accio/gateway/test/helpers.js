'use strict';
/**
 * helpers.js — shared scaffolding for the gateway's offline assertions.
 *
 * These tests drive the REAL modules. Nothing here re-implements a rule, mocks a
 * guard or stubs a store: a test that asserts against its own copy of the logic
 * is the failure mode this suite exists because of (see the S9 note in
 * script052_implementation.md about a green suite hiding a wrong assertion).
 *
 * Everything is offline and one-shot — no sockets, no listeners, no timers left
 * running. `node --test test/` must exit on its own.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../config');

let n = 0;
const roots = [];

/** A throwaway directory, removed by cleanup(). */
function tmpDir(label = 'accio') {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
	roots.push(dir);
	return dir;
}

/**
 * A REAL config object, built by the real loader, so tests see the derived
 * fields (destinationPorts, allowedOrigins, destinationPathRegExp) exactly as
 * the service does. Overrides are written to a file and loaded — never poked in
 * afterwards, which would skip the validation that is half of what we test.
 */
function makeCfg(overrides = {}) {
	const dir = roots.length ? roots[0] : tmpDir('accio-cfg');
	const file = path.join(dir, `cfg-${n++}.json`);
	fs.writeFileSync(file, JSON.stringify(overrides));
	return loadConfig(file);
}

/** loadConfig() against a literal JSON string, for the malformed-input tests. */
function loadRaw(text) {
	const dir = roots.length ? roots[0] : tmpDir('accio-cfg');
	const file = path.join(dir, `raw-${n++}.json`);
	fs.writeFileSync(file, text);
	return loadConfig(file);
}

/** A log that records instead of printing, so a failing test can show why. */
function makeLog() {
	const lines = { info: [], warn: [], error: [], dest: [] };
	return {
		lines,
		info: (m) => lines.info.push(m),
		warn: (m) => lines.warn.push(m),
		error: (m) => lines.error.push(m),
		dest: (m) => lines.dest.push(m),
		all: () => [...lines.info, ...lines.warn, ...lines.error].join('\n'),
	};
}

/** A minimal request, shaped the way Node's parser hands one to the handler. */
function req(url, { method = 'POST', headers = {} } = {}) {
	return {
		method,
		url,
		headers: Object.assign({ 'content-type': 'application/json' }, headers),
	};
}

/**
 * A response double good enough for listen_route's sendJson() and
 * writeAndFlush(). It records the status rather than asserting on it, so a
 * failing test can say what it actually got; `end()` fires 'finish' because
 * writeAndFlush treats that as the flush that licenses the ack, and the ack is
 * the money-relevant commit point this whole rail is built around.
 */
function makeRes() {
	const handlers = {};
	return {
		status: null, body: null, headers: null,
		writableEnded: false, headersSent: false, writableFinished: false, destroyed: false,
		once(ev, cb) { (handlers[ev] = handlers[ev] || []).push(cb); },
		emit(ev) { for (const cb of (handlers[ev] || [])) cb(); },
		writeHead(s, h) { this.status = s; this.headers = h; this.headersSent = true; },
		end(b) {
			this.body = b; this.writableEnded = true; this.writableFinished = true;
			this.emit('finish'); this.emit('close');
		},
		destroy() { this.destroyed = true; },
	};
}

/**
 * A request double that is also a body stream, for the /wallet/ route.
 *
 * ⚠ The flow semantics are the point, not a detail. Attaching a 'data' listener
 * is what puts a real stream into flowing mode, and the bytes then arrive on a
 * LATER tick — never inside the call that subscribed, which is why readBody can
 * register 'data' and then 'end' and still see both. A double that delivered the
 * body synchronously on subscribe would fire 'end' into a listener that did not
 * exist yet, and a double that only flowed on resume() would never deliver a
 * body at all on the success path, since nothing there calls resume(). Tests
 * that stream a body therefore have to await a tick; the refusal paths call
 * resume() themselves (drain) and stay synchronous.
 */
function bodyReq(url, { method = 'POST', headers = {}, chunks = [] } = {}) {
	const handlers = {};
	let flowed = false;
	const r = {
		method, url,
		headers: Object.assign({ 'content-type': 'application/json' }, headers),
		resumed: false, destroyed: false,
		on(ev, cb) {
			(handlers[ev] = handlers[ev] || []).push(cb);
			if (ev === 'data') process.nextTick(flow);
			return r;
		},
		once(ev, cb) { return r.on(ev, cb); },
		emit(ev, ...a) { for (const cb of (handlers[ev] || [])) cb(...a); },
		resume() { r.resumed = true; flow(); },
		destroy() { r.destroyed = true; },
	};
	function flow() {
		if (flowed || r.destroyed) return;
		flowed = true;
		for (const c of chunks) r.emit('data', c);
		r.emit('end');
	}
	return r;
}

/** One turn of the event loop — see bodyReq() for why a body needs it. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Attach a fake WebSocket to a REAL ListenHub session and return the connection
 * state the hub built for it.
 *
 * Note what this deliberately does NOT do: construct that state itself. The
 * shape (owned, pending, opened, nextInteraction…) belongs to listen_route, and
 * a test carrying its own copy of it would go on passing while the real one
 * drifted — the exact failure this suite's header warns about. Only the socket
 * is a double, and it carries a real 'close' so the hub's own teardown, which is
 * what fails parked payments and clears their timers, actually runs.
 */
function attachSocket(hub, sid, { front = 'nginx', opened = null } = {}) {
	const sent = [];
	const handlers = {};
	const wsDouble = {
		closed: false,
		sent,
		on(ev, cb) { (handlers[ev] = handlers[ev] || []).push(cb); },
		emit(ev, ...args) { for (const cb of (handlers[ev] || [])) cb(...args); },
		send(text) { if (this.closed) return false; sent.push(JSON.parse(text)); return true; },
		close(code, reason) {
			if (this.closed) return;
			this.closed = true;
			this.emit('close', code, reason);
		},
	};
	hub._register(wsDouble, sid, front, false);
	const set = hub.bySession.get(sid);
	const state = [...set][set.size - 1];
	// Delivery picks the most recently OPENED claimant, so a test that wants a
	// deterministic winner has to be able to say which socket that is.
	if (opened !== null) state.opened = opened;
	state.sent = sent;
	return state;
}

/**
 * A v3 onion. ONION_LABEL is the 56 base32 characters; ONION is the host.
 * Self-checked, because a fixture that is quietly the wrong shape turns a
 * boundary test into a test that the boundary rejects malformed fixtures.
 */
const ONION_LABEL = 'sp3k262uwy4r2k3ycr5awluarykdpag6a7y33jxop4cs2lu5uz5sseqd';
const ONION = `${ONION_LABEL}.onion`;
if (ONION_LABEL.length !== 56 || !/^[a-z2-7]{56}$/.test(ONION_LABEL)) {
	throw new Error('test fixture ONION_LABEL is not 56 base32 characters');
}

function cleanup() {
	for (const dir of roots.splice(0)) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	}
}

module.exports = {
	tmpDir, makeCfg, loadRaw, makeLog, req, bodyReq, tick, makeRes, attachSocket,
	ONION, ONION_LABEL, cleanup,
};
