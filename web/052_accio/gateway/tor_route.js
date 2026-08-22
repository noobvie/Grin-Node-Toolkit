'use strict';
/**
 * tor_route.js — the /tor/ forwarder.
 *
 * Replaces upstream's `SOCKS-Proxy` nginx module (the tunnel) and its
 * `Allow-Headers` module (the response-header allowlist). The destination and
 * request policy live next door in guard.js.
 *
 * ─── The two allowlists, copied verbatim from upstream's conf ────────────────
 * REQUEST headers forwarded (socks_proxy_pass_request_headers is OFF upstream;
 * only these are re-added):
 *     Accept-Encoding, Content-Type, Content-Length, Authorization,
 *     Access-Control-Request-Headers, Access-Control-Request-Method
 * RESPONSE headers copied back (allow_headers on; allow_header × 7):
 *     Content-Type, Transfer-Encoding, Content-Length, Content-Encoding,
 *     Access-Control-Allow-Headers, Access-Control-Allow-Methods,
 *     Access-Control-Allow-Origin
 *
 * The request list is a privacy control as much as a security one. Cookie,
 * Referer, User-Agent, Accept-Language and every X-Forwarded-* header are
 * absent by construction, so the payee's wallet learns nothing about the payer
 * beyond the slate it was sent. Do not "just add one" to debug something.
 *
 * The response list is the part `add_header` genuinely cannot do: a hostile
 * hidden service answers with headers of its own choosing, and without an
 * allowlist it could set cookies on our domain, redirect the browser, or fold
 * its own CSP over ours. Everything not on the list is dropped.
 */

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const socks5 = require('./socks5');
const { Denied } = require('./guard');

const REQUEST_HEADER_ALLOWLIST = [
	'accept-encoding',
	'content-type',
	'content-length',
	'authorization',
	'access-control-request-headers',
	'access-control-request-method',
];

const RESPONSE_HEADER_ALLOWLIST = [
	'content-type',
	'content-length',
	'content-encoding',
	'access-control-allow-headers',
	'access-control-allow-methods',
	'access-control-allow-origin',
	// NOTE: upstream also allows Transfer-Encoding. We deliberately do not copy
	// it — see buildResponseHeaders() below. It is a hop-by-hop framing header,
	// and this process re-frames the response.
];

function pickRequestHeaders(req, dest) {
	// Host is not on upstream's allowlist because nginx supplies it from the
	// proxy target automatically; HTTP/1.1 requires it, so we set it ourselves
	// from the destination — never from the client's own Host header.
	const out = { host: dest.port === (dest.scheme === 'https' ? 443 : 80) ? dest.host : `${dest.host}:${dest.port}` };
	for (const name of REQUEST_HEADER_ALLOWLIST) {
		const v = req.headers[name];
		if (v !== undefined) out[name] = v;
	}
	// Upstream sets `Connection: close` explicitly. Keeping a pooled connection
	// open to an arbitrary hidden service buys nothing (each request is a fresh
	// circuit-bound socket) and costs a held Tor stream per payee.
	out.connection = 'close';
	return out;
}

function buildResponseHeaders(upstreamHeaders) {
	const out = Object.create(null);
	for (const name of RESPONSE_HEADER_ALLOWLIST) {
		const v = upstreamHeaders[name];
		if (v !== undefined) out[name] = v;
	}
	// Content-Length is only trustworthy alongside our own framing. If the
	// hidden service answered chunked, there is no length to copy and Node will
	// chunk our response too; if it answered with a length, the body we pipe is
	// byte-identical so the length still holds.
	if (upstreamHeaders['transfer-encoding'] !== undefined) delete out['content-length'];

	// Upstream adds this with nginx `add_header` in the /tor/ location. We emit
	// it from here instead, and that is a deliberate choice, not a shortcut:
	// an `add_header` anywhere in a location block DISCARDS every add_header
	// inherited from the server block, so putting one in the /tor/ location
	// would silently strip CSP and HSTS from exactly the route that talks to
	// untrusted hidden services. The nginx snippet this route is served behind
	// therefore contains no add_header at all.
	out['cache-control'] = 'no-store, no-transform';
	return out;
}

/**
 * forward(req, res, dest, cfg, log) → Promise<void>
 * Resolves once the exchange is over, one way or the other. Never throws to the
 * caller for a remote-side failure; it answers the client and resolves.
 */
function forward(req, res, dest, cfg, log) {
	return new Promise((resolve) => {
		let finished = false;
		let upstream = null;
		// Armed AFTER proxyReq exists, deliberately — see below.
		let deadline = null;
		const finish = () => {
			if (finished) return;
			finished = true;
			if (deadline) clearTimeout(deadline);
			resolve();
		};

		const fail = (status, message) => {
			// Idempotent on purpose. Destroying the proxy request to enforce a
			// cap or a timeout also raises 'error' on it, so fail() reliably
			// runs twice for one failure; without this guard the second call
			// writes to an already-ended response and takes the process down
			// with ERR_STREAM_WRITE_AFTER_END.
			if (finished) return;
			// Once a byte of the body is out the door there is no status left to
			// send; all we can do is cut the response so the browser sees a
			// truncated transfer rather than a silently short one.
			if (res.headersSent) {
				res.destroy();
			} else {
				sendError(res, status, message);
			}
			finish();
		};

		const isTls = dest.scheme === 'https';
		const transport = isTls ? https : http;

		const createConnection = (_opts, callback) => {
			socks5.connect({
				socksHost: cfg.socks_host,
				socksPort: cfg.socks_port,
				host: dest.host,
				port: dest.port,
				timeoutMs: cfg.connect_timeout_ms,
				isolationTag: cfg.socks_isolate_per_destination ? dest.host : null,
			}).then((socket) => {
				if (!isTls) return callback(null, socket);
				const tlsSocket = tls.connect({
					socket,
					servername: dest.host,
					// An onion address IS its public key: the destination is
					// authenticated by Tor before a byte of TLS is exchanged, and
					// hidden services essentially always carry a self-signed cert.
					// Verifying a CA chain here would reject every real wallet and
					// would add nothing Tor has not already proved. Clearnet
					// destinations (off by default) keep normal verification.
					rejectUnauthorized: !dest.host.endsWith('.onion'),
				});
				tlsSocket.once('error', (err) => callback(err));
				tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
			}).catch((err) => callback(err));
		};

		const proxyReq = transport.request({
			method: req.method,
			path: dest.path + dest.query,
			headers: pickRequestHeaders(req, dest),
			// `agent: null`, NOT `agent: false`. In Node, `false` means "build me
			// a fresh default Agent" — an agent that dials the destination
			// itself — and http.request only consults createConnection when
			// there is NO agent. With `false` the SOCKS tunnel below is built,
			// handed back, and then silently ignored while Node opens its own
			// direct socket to the .onion, which fails DNS resolution and
			// surfaces as a bare ECONNREFUSED with an empty message. That is
			// the whole Tor rail bypassed by one wrong falsy value.
			agent: null,
			createConnection,
			// setHost would append a second Host header derived from `host`/`port`
			// options we are not passing; ours is already in the header set.
			setHost: false,
		});

		// A TOTAL budget for the exchange, separate from the idle timeout below.
		// proxyReq.setTimeout() only fires on INACTIVITY, so a hidden service that
		// trickles one byte every two minutes would hold its concurrency slot
		// indefinitely and a handful of them would exhaust max_concurrent. A slate
		// is a few KB; the same budget as a total deadline is generous.
		//
		// Armed HERE, after the request object exists, not at the top of forward().
		// transport.request() can throw synchronously (an unencodable header value
		// is enough), and a timer armed before it would then survive the throw and
		// fire into a `proxyReq` that was never assigned — a ReferenceError raised
		// from a timer callback is uncaught and takes the whole gateway down. Armed
		// here, that path leaves no timer at all: the throw propagates out of the
		// executor, the promise rejects, and server.js answers 500.
		deadline = setTimeout(() => {
			const err = new Error(`exchange exceeded ${cfg.read_timeout_ms}ms`);
			err.accioTimeout = true;
			proxyReq.destroy(err);
		}, cfg.read_timeout_ms);

		// The INACTIVITY timeout (the deadline above is the total one). Upstream
		// sets socks_proxy_read_timeout to 208 WEEKS, which on a shared box is
		// an unbounded resource hold any client can take out for free. A wallet
		// Foreign API call answers in milliseconds.
		proxyReq.setTimeout(cfg.read_timeout_ms, () => {
			const err = new Error(`no response within ${cfg.read_timeout_ms}ms`);
			err.accioTimeout = true;
			proxyReq.destroy(err);
		});

		proxyReq.once('error', (err) => {
			// A destination that is offline is the common outcome here and it is
			// not a fault of this server — 502/504, never 500. The SOCKS reply
			// text carries which kind of offline it was (no descriptor vs.
			// nothing listening), which is the one detail an operator needs.
			log.warn(`/tor/ forward failed: ${err.message}`);
			fail(err.accioTimeout ? 504 : 502, err.message);
		});

		// Registered at the TOP, not inside the 'response' handler, and that is
		// the point: a client that disconnects while we are still waiting on the
		// circuit would otherwise hold its concurrency slot until the timeout —
		// minutes after it stopped existing. 'close' fires on the normal path
		// too, where `finished` is already set and this is a no-op.
		res.once('close', () => {
			if (upstream) upstream.destroy();
			if (!finished) { proxyReq.destroy(); finish(); }
		});

		proxyReq.once('response', (upstreamRes) => {
			upstream = upstreamRes;
			res.writeHead(upstreamRes.statusCode, buildResponseHeaders(upstreamRes.headers));
			upstreamRes.pipe(res);
			upstreamRes.once('error', () => { res.destroy(); finish(); });
			upstreamRes.once('end', finish);
		});

		// ── Request body: streamed, with our own byte cap ────────────────────
		// nginx enforces client_max_body_size on the clearnet front, but the
		// onion front has no nginx in front of it at all, so the cap has to
		// exist here too or it does not exist for half the traffic.
		let seen = 0;
		let drained = 0;
		let overflowed = false;
		req.on('data', (chunk) => {
			if (overflowed) {
				// Drain, do NOT destroy. Destroying the client socket the moment
				// the 413 is written races the response out of the client's
				// receive buffer, and the browser reports a connection reset
				// instead of the status we just took the trouble to send. Read
				// the rest of the body into nothing and let the connection close
				// normally — with a hard stop so an endless stream still costs
				// the sender the connection.
				drained += chunk.length;
				if (drained > cfg.max_body_bytes) req.destroy();
				return;
			}
			seen += chunk.length;
			if (seen > cfg.max_body_bytes) {
				overflowed = true;
				proxyReq.destroy();
				fail(413, 'request body too large');
				req.resume();
				return;
			}
			if (!proxyReq.write(chunk)) req.pause();
		});
		proxyReq.on('drain', () => req.resume());
		req.once('end', () => { if (!overflowed) proxyReq.end(); });
		req.once('aborted', () => { proxyReq.destroy(); finish(); });
		req.once('error', () => { proxyReq.destroy(); finish(); });
	});
}

function sendError(res, status, message) {
	// Plain text, no HTML, no upstream detail beyond the message we chose. The
	// wallet's JSON-RPC client treats any non-JSON answer as a failed call, so
	// the body is for the operator reading a curl, not for the page.
	const body = `${status} ${message}\n`;
	res.writeHead(status, {
		'content-type': 'text/plain; charset=utf-8',
		'content-length': Buffer.byteLength(body),
		'cache-control': 'no-store, no-transform',
		// Every path that reaches here is refusing a request, and several refuse
		// it with the body still arriving. Closing rather than keeping the
		// connection alive is both what the client should do next and what keeps
		// a half-read body from being mistaken for the next request on the wire.
		'connection': 'close',
	});
	res.end(body);
}

/**
 * A refused request still has a body on the wire. Reading and discarding it lets
 * the connection close cleanly; not doing so makes some clients report a
 * connection reset instead of the status we just sent them.
 *
 * It is CAPPED, though. nginx enforces client_max_body_size on the clearnet
 * front, but the onion front has no nginx at all, so an unbounded drain would let
 * anyone stream gigabytes into a route that already said no.
 *
 * ⚠ R6. ONE implementation, with the cap passed in. There were two — server.js
 * drained to `max_body_bytes` (10 MB) and wallet_route.js to `inbound_body_bytes`
 * (1 MB at the time; R7 clamped it to 128 KB) — so a refused /wallet/ request
 * could stream ten times the cap that route enforces on an accepted one. Each
 * rail still chooses its own budget; it just no longer chooses it by which copy
 * of this function it happened to call.
 */
function drain(req, maxBytes) {
	let seen = 0;
	req.on('data', (chunk) => {
		seen += chunk.length;
		if (seen > maxBytes) req.destroy();
	});
	req.resume();
}

module.exports = {
	forward, sendError, drain, Denied,
	REQUEST_HEADER_ALLOWLIST, RESPONSE_HEADER_ALLOWLIST,
	pickRequestHeaders, buildResponseHeaders,
};
