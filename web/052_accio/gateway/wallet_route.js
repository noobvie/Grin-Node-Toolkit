'use strict';
/**
 * wallet_route.js — the per-wallet inbound URL, `/wallet/<suffix>/v2/foreign`
 * (packet S4b).
 *
 * This is the address side of the listen rail. A browser tab cannot open a
 * listening socket, so the gateway holds one public HTTPS Foreign-API URL per
 * browser wallet and relays each POST down that wallet's open WebSocket. The
 * wallet composes its own displayed address from the suffix we mint (design
 * §9):
 *
 *     https://<host>/wallet/<suffix>          ← the address the payer sees
 *     https://<host>/wallet/<suffix>/v2/foreign   ← what they actually POST to
 *
 * ─── Normalise the id HERE, in exactly one place ─────────────────────────────
 * 093 Transporter's second lesson was that Express rebuilds `req.params` per
 * layer, so a mounted middleware's normalisation is silently discarded. There
 * is no Express in this gateway, so the lesson lands as a rule instead: the
 * suffix is extracted and lowercased by `parsePath()` and by nothing else, and
 * no code downstream re-derives it from `req.url`.
 *
 * Lowercasing is not cosmetic. We mint lowercase (store.js says why), but a
 * sender who upper-cased an address by hand or through a QR round-trip would
 * otherwise be answered 404 for an address that exists. Upstream's nginx
 * accepts `[a-zA-Z0-9]+` and hands it straight through; we accept the same and
 * then fold the case, which is strictly more forgiving and cannot mis-route —
 * the minted set contains no uppercase for a folded string to collide with.
 *
 * ─── What is deliberately refused here rather than in the tab ────────────────
 * The protocol carries no HTTP method and no headers (§5) — the tab sees a body
 * and a content type, and nothing else. So the gateway is the only place a
 * preflight can be answered, and the only place a wrong method or a wrong
 * media type can be refused without spending a round trip through someone's
 * browser tab to be told 415.
 */

const listen = require('./listen_route');
const torRoute = require('./tor_route');

// Length-bounded on purpose: the nginx location carries the same bound, and an
// unbounded `+` here would let a multi-kilobyte path reach the store's key
// space. 4 is below anything we mint; 64 is well above it.
const WALLET_PATH = /^\/wallet\/([A-Za-z0-9]{4,64})\/v2\/foreign$/;

/**
 * parsePath(url) → suffix (lowercased) or null.
 * `url` is req.url — a path plus an optional query, never an absolute URL.
 */
function parsePath(url) {
	const q = url.indexOf('?');
	const path = q === -1 ? url : url.slice(0, q);
	const m = WALLET_PATH.exec(path);
	return m ? m[1].toLowerCase() : null;
}

function isWalletPath(url) {
	return parsePath(url) !== null;
}

/** handle(req, res, ctx) — ctx = { cfg, log, hub, stats }. Answers res always. */
function handle(req, res, ctx) {
	const { cfg, hub, stats } = ctx;

	const suffix = parsePath(req.url);
	if (!suffix) {
		drain(req, cfg);
		return listen.sendJson(res, 404, { error: 'not a wallet foreign API path' });
	}

	if (req.method === 'OPTIONS') {
		// The preflight the tab structurally cannot answer. Kept cheap and
		// answered before any lookup: a preflight must not reveal whether an
		// address exists, and a sender's browser sends it before it has any
		// reason to believe the address is real.
		drain(req, cfg);
		res.writeHead(204, Object.assign(listen.corsHeaders(), {
			'access-control-max-age': '600',
			'cache-control': 'no-store, no-transform',
			'content-length': '0',
		}));
		return res.end();
	}

	if (req.method !== 'POST') {
		drain(req, cfg);
		res.setHeader('allow', 'POST, OPTIONS');
		return listen.sendJson(res, 405, { error: 'only POST and OPTIONS are accepted' });
	}

	// §5: the tab answers 415 for any Content-Type that is not exactly
	// application/json. Refusing here saves a round trip through a browser to
	// reach the same verdict — and it is why deliver() sends the BARE string
	// rather than this header, which legitimately carries `; charset=utf-8`.
	const contentType = req.headers['content-type'];
	if (Array.isArray(contentType) || typeof contentType !== 'string'
		|| !/^application\/json(?:;.*)?$/i.test(contentType.trim())) {
		drain(req, cfg);
		return listen.sendJson(res, 415, { error: 'body must be application/json' });
	}

	// ⚠ R7. The suffix is checked for EXISTENCE before a byte of body is read.
	// deliver() has always answered 404 for an address nobody owns, but it only
	// runs once readBody has buffered the whole request — and parsePath admits
	// any [A-Za-z0-9]{4,64}, so a POST to a suffix that has never existed was
	// costing a full inbound_body_bytes of heap, and the read budget below was
	// reachable by anyone at all: no address, no session, on either front. That
	// is the difference between a cap on people who can receive money here and a
	// cap on everybody with a socket.
	if (!hub.knows(suffix)) {
		// Counted exactly as deliver() would have counted it, so /health does not
		// change meaning just because the 404 now happens earlier.
		stats.inbound_requests += 1;
		stats.inbound_unknown += 1;
		drain(req, cfg);
		return listen.sendJson(res, 404, { error: 'unknown address' });
	}

	// ⚠ S8. The admission check happens BEFORE the body is read, not after.
	// max_inbound_in_flight used to be tested inside deliver(), by which point
	// this function had already buffered a whole inbound_body_bytes into the
	// process — so the cap bounded relays and not memory, and N senders could
	// hold N MB between them with nothing counting it. Reserving here makes the
	// same budget cover the read.
	if (!hub.beginRead()) {
		stats.inbound_busy += 1;
		drain(req, cfg);
		return listen.sendJson(res, 503, { error: 'gateway busy, retry shortly' }, { 'retry-after': '5' });
	}
	// Idempotent, and hooked to 'close' as well as to the callback. readBody
	// answers on 'end', 'aborted' or 'error', and Node emits one of those for
	// every request it finishes parsing — but a reservation that leaks even
	// rarely is a cap that tightens by itself until the rail refuses everything,
	// so the release does not depend on that being exhaustive. 'close' always
	// fires; by then the callback has normally released already and this is a
	// no-op.
	let released = false;
	const release = () => { if (!released) { released = true; hub.endRead(); } };
	res.once('close', release);

	// §11.7 was ours to decide: the client has no body cap and upstream's
	// /wallet/ location sets no client_max_body_size at all, so it silently
	// inherits nginx's 1 MB default. We set it explicitly, in both places, and
	// enforce it here too — the onion front has no nginx in front of it, so a
	// cap that lives only in the vhost does not exist for half the traffic.
	//
	// ⚠ R7. inbound_body_bytes is CLAMPED at load time (config.js) to what the
	// listen rail can actually carry: deliver() base64-encodes this body into ONE
	// WebSocket frame bounded by ws_max_message_bytes, and base64 is 4 bytes out
	// per 3 in — so at the defaults anything past ~192 KB was read in full and
	// then answered 413 by a check it could never have passed. The old 1 MB
	// default bought nothing but the right to hold max_inbound_in_flight × 1 MB
	// of buffer at once, which is a quarter of a gigabyte on a box that is also
	// running a node.
	readBody(req, cfg.inbound_body_bytes, (err, body) => {
		release();
		if (err === 'too-large') {
			stats.inbound_too_large += 1;
			return listen.sendJson(res, 413, { error: 'request body too large' });
		}
		if (err) return listen.sendJson(res, 400, { error: 'could not read the request body' });
		if (res.writableEnded || res.destroyed) return;   // sender hung up mid-body
		hub.deliver({ suffix, body, res });
	});
}

/**
 * Read the body with a hard cap. On overflow we DRAIN rather than destroy — the
 * same lesson as the /tor/ rail: destroying the socket the moment the 413 is
 * written races the response out of the client's receive buffer, and the sender
 * reports a connection reset instead of the status we took the trouble to send.
 */
function readBody(req, maxBytes, done) {
	const chunks = [];
	let seen = 0;
	let overflowed = false;
	let drained = 0;
	let finished = false;

	const finish = (err, body) => {
		if (finished) return;
		finished = true;
		done(err, body);
	};

	req.on('data', (chunk) => {
		if (overflowed) {
			drained += chunk.length;
			if (drained > maxBytes) req.destroy();
			return;
		}
		seen += chunk.length;
		if (seen > maxBytes) {
			overflowed = true;
			chunks.length = 0;
			finish('too-large');
			req.resume();
			return;
		}
		chunks.push(chunk);
	});
	req.once('end', () => { if (!overflowed) finish(null, Buffer.concat(chunks, seen)); });
	req.once('aborted', () => finish('aborted'));
	req.once('error', () => finish('error'));
}

/** Read and discard a body we have already refused, capped at this rail's budget. */
function drain(req, cfg) {
	torRoute.drain(req, cfg.inbound_body_bytes);
}

/**
 * ⚠ R6. Every refusal on this route, wherever it is raised, goes out through
 * here — including the two that server.js raises before this module is even
 * reached (listen rail disabled, onion bucket empty). This route is called
 * CROSS-ORIGIN by another wallet's tab, so a refusal without CORS headers is a
 * refusal the sender's JS cannot read: it surfaces as an opaque network error
 * rather than the status we chose. sendError() is right for /tor/, which is
 * same-origin, and wrong for this one.
 */
function refuse(res, status, message, extra) {
	listen.sendJson(res, status, { error: message }, extra);
}

module.exports = { handle, refuse, parsePath, isWalletPath, WALLET_PATH };
