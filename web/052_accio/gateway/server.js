'use strict';
/**
 * server.js — grin-accio-gateway (Script 052, packet S3).
 *
 * The one server-side process Accio needs. Accio is a self-custodial browser
 * wallet: the seed is generated in the visitor's tab and never leaves it, so
 * this service holds no key, no wallet file and no balance. What it does hold
 * is the two things a tab physically cannot do —
 *
 *   S3   outbound:  POST a slate to a payee's .onion   → /tor/
 *   S4b  inbound:   own a listening address            → /listen
 *                                                      → /wallet/<suffix>/v2/foreign
 *
 * A browser cannot open a TCP connection to a hidden service and cannot listen
 * for one. That, and nothing else, is why Accio is not a static site.
 *
 * ─── What this replaces ──────────────────────────────────────────────────────
 * Upstream ships three custom nginx C modules for the outbound route
 * (SOCKS-Proxy, Block-Access, Allow-Headers) and one unlicensed C++ daemon for
 * the inbound one (WebSocket-Listener). The modules build as .so files against
 * the exact installed nginx, so an `apt upgrade nginx` makes `load_module` fail
 * — and nginx then refuses to start AT ALL, taking every other vhost on the box
 * down with it (Fidelius, GrinScan, the pool, Drop, the node API). The daemon
 * carries no licence at all, so we may not ship it. Collapsing all four into
 * this process is what lets Accio run behind stock nginx from apt, with no
 * apt-mark hold and no coupling of the other products to this one.
 *
 * ─── Two ports, because the port IS the trust boundary ───────────────────────
 * nginx and tor both arrive on 127.0.0.1, so the peer address cannot tell them
 * apart — and a Tor client writes its own headers, so it could forge
 * X-Forwarded-For and mint a fresh identity per request, voiding every
 * per-client limit. So:
 *
 *     127.0.0.1:port      ← the clearnet nginx server block.  Rate limiting is
 *                           nginx's (limit_req zone=accio_tor, keyed on the
 *                           real client IP, which only nginx knows).
 *     127.0.0.1:tor_port  ← the onion nginx server block (S7). Every caller is
 *                           the same 127.0.0.1 with no identity at all, so the
 *                           only honest limit is one shared bucket, applied
 *                           here. Forwarding headers are ignored on this port.
 *
 * Note the onion front is fed by a SECOND nginx server block, not by tor
 * directly: the wallet is ~7 MB of WASM and static assets that nginx should
 * serve over the onion exactly as it does over TLS, while /tor/, /listen and
 * /wallet/ proxy through to this port. Classification by localPort survives
 * that intact. tor_port = 0 keeps the second listener closed, which is the
 * state until S7 mints the onion.
 *
 * The two fronts are also two COOKIE JARS, and that is worth stating rather
 * than discovering: http://<onion> and https://<domain> are different origins,
 * so the same wallet reached both ways holds two sessions and therefore two
 * receiving addresses. That is accepted — arguably it is a privacy gain — but
 * it means an address minted over the onion is not the one shown over TLS.
 *
 * ─── Deliberate deviations from upstream's nginx.conf, all in one place ──────
 *  1. read timeout 3 min, not 208 weeks. Upstream's socks_proxy_read_timeout is
 *     208w, i.e. an unbounded resource hold any client can take out for free.
 *  2. Transfer-Encoding is not copied back (this process re-frames the body).
 *  3. Cache-Control is emitted here rather than by nginx `add_header`, because
 *     an add_header inside the /tor/ location would discard the inherited CSP
 *     and HSTS from the server block. See tor_route.js buildResponseHeaders().
 *  4. Destination hosts must be well-formed v3 onions, not merely *.onion.
 *  5. SOCKS5 is implemented here rather than pulled from npm — socks5.js says
 *     why. The gateway has no npm dependencies and its install is offline.
 *  6. Every response carries X-Content-Type-Options: nosniff, which upstream's
 *     response allowlist has no way to add. A hidden service chooses its own
 *     Content-Type, so refusing to let the browser sniff past it is cheap.
 */

const http = require('node:http');
const { loadConfig } = require('./config');
const guard = require('./guard');
const torRoute = require('./tor_route');
const { Store } = require('./store');
const { ListenHub } = require('./listen_route');
const walletRoute = require('./wallet_route');

const CONF_PATH = process.env.ACCIO_GATEWAY_CONF || '';

// ─── Logging ─────────────────────────────────────────────────────────────────
// journald takes stdout/stderr; systemd stamps the time, so we do not.
// NOTHING here logs a destination unless log_destinations is explicitly on: the
// destination of a /tor/ request is the payee's wallet address, and a journal
// full of those is the payment graph Grin exists in order not to have.
function makeLog(cfg) {
	const line = (level, msg) => console.log(`[${level}] ${msg}`);
	return {
		info: (m) => line('info', m),
		warn: (m) => console.error(`[warn] ${m}`),
		error: (m) => console.error(`[error] ${m}`),
		dest: (m) => { if (cfg.log_destinations) line('dest', m); },
	};
}

// ─── Counters (what /health reports; no addresses, ever) ─────────────────────
const stats = {
	started: new Date().toISOString(),
	// outbound (/tor/, S3)
	tor_requests: 0,
	tor_denied: 0,
	tor_failed: 0,
	tor_ok: 0,
	rejected_rate_limit: 0,
	rejected_busy: 0,
	in_flight: 0,
	// inbound (/listen + /wallet/, S4b). Counts only — never a suffix, never an
	// address, never a peer. /health is a `curl` on the box, but it should stay
	// cheap to expose, and a payment graph is not a health metric.
	listen_connections: 0,
	listen_open: 0,
	listen_refused: 0,
	suffixes_minted: 0,
	inbound_requests: 0,
	inbound_delivered: 0,
	inbound_unknown: 0,
	inbound_offline: 0,
	// R7. A live socket in the session, but not one that has CLAIMED the address
	// the payment is for. Deliberately its own counter rather than folded into
	// inbound_offline: during the acceptance session a non-zero value here means
	// real clients are being paid inside the window between a reconnect and their
	// first `Own URL`, which is the one legitimate cause and the only reason the
	// deleted fallback existed. A count that keeps climbing in steady state means
	// something is NOT claiming its addresses, and that is worth knowing before
	// mainnet rather than after. See listen_route.js deliver().
	inbound_unclaimed: 0,
	inbound_busy: 0,
	inbound_timeout: 0,
	inbound_abandoned: 0,
	inbound_too_large: 0,
	inbound_in_flight: 0,
};

/**
 * A token bucket, used for the onion front only.
 *
 * Deliberately ONE bucket rather than one per client: on the onion path there
 * is no client to key on, and inventing a key (a header, a cookie) would let
 * the caller mint identities at will — which is the whole reason the onion has
 * its own port. A single shared bucket is a weaker control, and an honest one.
 */
function makeBucket(ratePerSecond, burst) {
	let tokens = burst;
	let last = Date.now();
	return function take() {
		const now = Date.now();
		// ⚠ R6. `Date.now()` is not monotonic and this box runs a time daemon.
		// Math.min clamped the top and nothing clamped the bottom, so a BACKWARD
		// step made the elapsed term negative and drove the balance arbitrarily far
		// below zero — an hour's correction at 10/s left −36,000 tokens, i.e. the
		// onion front refusing every request for the next hour with nothing in the
		// journal to explain it. A clock step is not credit and it is not a debt.
		const elapsed = Math.max(0, now - last);
		tokens = Math.min(burst, Math.max(0, tokens) + (elapsed / 1000) * ratePerSecond);
		last = now;
		if (tokens < 1) return false;
		tokens -= 1;
		return true;
	};
}

function main() {
	let cfg;
	try {
		// An absent ACCIO_GATEWAY_CONF is fatal, not "use the defaults". The
		// defaults do not know which network this instance is, so a unit file
		// that lost its Environment= line would silently start the MAINNET
		// gateway on the testnet port — running, healthy-looking, and wrong.
		if (!CONF_PATH) {
			throw new Error('ACCIO_GATEWAY_CONF is not set (the systemd unit supplies it)');
		}
		cfg = loadConfig(CONF_PATH);
	} catch (err) {
		console.error(`[error] ${err.message}`);
		console.error('[error] refusing to start on a config this service cannot understand');
		process.exit(1);
		return;
	}
	const log = makeLog(cfg);
	const onionBucket = makeBucket(cfg.onion_rate_per_second, cfg.onion_burst);
	// A SECOND bucket for the inbound rail on the onion front, not a share of
	// the first: a flood of outbound sends must not starve receives, and the two
	// have nothing to do with each other.
	const onionInboundBucket = makeBucket(cfg.onion_inbound_rate_per_second, cfg.onion_inbound_burst);

	let store;
	try {
		// The Store refuses to start on a snapshot it can see but cannot read —
		// starting empty would let the first flush rename over every live receiving
		// address. Same treatment as an unreadable config: one line, then stop.
		store = new Store(cfg, log);
	} catch (err) {
		log.error(err.message);
		log.error('refusing to start on an address table this service cannot read');
		process.exit(1);
		return;
	}
	const hub = new ListenHub(cfg, log, store, stats);

	const handler = (front) => (req, res) => {
		// Never leak our stack or version to a hidden service's error page or
		// to a browser. Node sends no Server header of its own; nginx adds one
		// we cannot remove without the headers-more module, and `server_tokens
		// off` shortens it to "nginx", which is where that story ends.
		res.setHeader('X-Content-Type-Options', 'nosniff');

		if (req.method === 'GET' && (req.url === '/health' || req.url === '/health/')) {
			return health(res, cfg, front, store);
		}

		// ── Inbound rail: /wallet/<suffix>/v2/foreign ────────────────────────
		//
		// ⚠ R6. Both refusals below answer through walletRoute.refuse, not
		// torRoute.sendError, because this route is reached CROSS-ORIGIN by another
		// wallet's tab. sendError emits no CORS headers, so a sender's JS could not
		// read either status — "the payee's listen rail is off" and "you are being
		// rate limited" both surfaced as the same opaque network error, in exactly
		// the two conditions where the sender most needs to be told which. Every
		// other refusal on this route already goes through listen.sendJson.
		if (req.url.startsWith('/wallet/')) {
			if (!cfg.listen_enabled) {
				torRoute.drain(req, cfg.inbound_body_bytes);
				return walletRoute.refuse(res, 404, 'the listen rail is disabled on this gateway');
			}
			if (front === 'onion' && !onionInboundBucket()) {
				stats.rejected_rate_limit += 1;
				torRoute.drain(req, cfg.inbound_body_bytes);
				return walletRoute.refuse(res, 429, 'too many requests', { 'retry-after': '5' });
			}
			try {
				return walletRoute.handle(req, res, { cfg, log, hub, stats });
			} catch (err) {
				// The same reasoning the guard.inspect catch below spells out: an
				// uncaught throw out of a request listener kills the process, and
				// this route parses considerably more attacker-shaped input than
				// guard.js does. One malformed request must not take every live
				// wallet socket down with it.
				stats.inbound_unknown += 1;
				log.error(`wallet route threw: ${err.stack || err.message}`);
				if (!res.headersSent) walletRoute.refuse(res, 500, 'internal error');
				else res.destroy();
				return;
			}
		}

		// A plain GET on /listen never reaches the upgrade handler — Node only
		// emits 'upgrade' when the request actually carries the Upgrade header.
		// Answering the generic 404 below would read as "the route is missing"
		// when the route is fine and the request is not; 426 is both the correct
		// status and a self-explaining one for whoever is holding the curl.
		if (req.url.split('?')[0] === '/listen') {
			torRoute.drain(req, cfg.max_body_bytes);
			res.setHeader('upgrade', 'websocket');
			return torRoute.sendError(res, 426, 'this endpoint requires a WebSocket upgrade');
		}

		if (!req.url.startsWith('/tor/')) {
			// Everything else on this port is nginx's job (the static site). A
			// request reaching here for one of those means the nginx snippet is
			// routing more than it should, so say what happened rather than
			// 404-ing blankly. /listen never lands here — it arrives as an
			// 'upgrade' event, which bypasses the request handler entirely.
			torRoute.drain(req, cfg.max_body_bytes);
			return torRoute.sendError(res, 404, 'this gateway serves /tor/, /listen and /wallet/ only');
		}

		stats.tor_requests += 1;

		if (front === 'onion' && !onionBucket()) {
			stats.rejected_rate_limit += 1;
			torRoute.drain(req, cfg.max_body_bytes);
			return torRoute.sendError(res, 429, 'too many requests');
		}
		if (stats.in_flight >= cfg.max_concurrent) {
			// A hard ceiling on concurrent Tor circuits. Without it, a few
			// hundred requests to unreachable onions each hold a socket for the
			// full connect timeout and the box runs out of file descriptors —
			// which would take down the products sharing it, not just Accio.
			stats.rejected_busy += 1;
			torRoute.drain(req, cfg.max_body_bytes);
			return torRoute.sendError(res, 503, 'gateway busy, retry shortly');
		}

		let dest;
		try {
			dest = guard.inspect(req, cfg);
		} catch (err) {
			torRoute.drain(req, cfg.max_body_bytes);
			if (err instanceof guard.Denied) {
				stats.tor_denied += 1;
				log.warn(`/tor/ denied (${err.status}): ${err.message}`);
				return torRoute.sendError(res, err.status, err.message);
			}
			// Anything else is a bug in guard.js, which is pure and should only
			// ever raise Denied. Answer 500 rather than rethrowing: an uncaught
			// throw out of a request listener kills the process, so one malformed
			// request that found a bug would take the gateway down for everyone
			// and systemd would restart it straight into the next one.
			stats.tor_failed += 1;
			log.error(`guard raised a non-Denied error: ${err.stack || err.message}`);
			return torRoute.sendError(res, 500, 'internal error');
		}

		log.dest(`${req.method} ${dest.scheme}://${dest.host}:${dest.port}${dest.path}`);
		stats.in_flight += 1;
		torRoute.forward(req, res, dest, cfg, log)
			.then(() => {
				stats.in_flight -= 1;
				// headersSent, not statusCode alone: a client that vanished before
				// the circuit answered leaves statusCode at its default 200, and
				// counting that as a success would make /health report deliveries
				// that never happened.
				if (res.headersSent && res.statusCode < 400) stats.tor_ok += 1;
				else stats.tor_failed += 1;
			})
			.catch((err) => {
				// forward() answers the client itself and resolves; landing here
				// means a bug in this file, not a remote failure.
				stats.in_flight -= 1;
				stats.tor_failed += 1;
				log.error(`internal forward error: ${err.stack || err.message}`);
				if (!res.headersSent) torRoute.sendError(res, 500, 'internal error');
				else res.destroy();
			});
	};

	// The upgrade handler is registered per front for the same reason the
	// request handler is: /listen mints a session cookie, and whether that
	// cookie may carry `Secure` depends on which front the handshake arrived on.
	const upgrade = (front) => (req, socket, head) => {
		socket.on('error', () => { /* a peer that vanishes mid-handshake is not an event */ });
		if (front === 'onion' && !onionInboundBucket()) {
			stats.listen_refused += 1;
			try { socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); } catch { /* gone */ }
			socket.destroy();
			return;
		}
		// ⚠ R6. Wrapped for the same reason the /tor/ and /wallet/ entry points are.
		// A throw here is not caught by anything — an 'upgrade' listener is called
		// from the parser, so the exception goes straight to uncaughtException and
		// takes the process, i.e. every OTHER wallet's live socket, with it. The
		// handshake code reads attacker-supplied headers, which is precisely the
		// input that finds a bug.
		try {
			hub.handleUpgrade(req, socket, head, front);
		} catch (err) {
			stats.listen_refused += 1;
			log.error(`/listen upgrade threw: ${err.stack || err.message}`);
			try { socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n'); } catch { /* gone */ }
			socket.destroy();
		}
	};

	const servers = [];
	servers.push(listen(cfg.port, handler('nginx'), upgrade('nginx'), log, cfg, 'nginx front'));
	if (cfg.tor_port > 0) {
		servers.push(listen(cfg.tor_port, handler('onion'), upgrade('onion'), log, cfg, 'onion front'));
	}

	log.info(`grin-accio-gateway [${cfg.network}] ready — /tor/ + /listen + /wallet/ (S4b)`);
	log.info(`  Tor SOCKS5      ${cfg.socks_host}:${cfg.socks_port}` +
		(cfg.socks_isolate_per_destination ? ' (circuit isolated per destination)' : ''));
	log.info(`  destinations    ${cfg.allow_clearnet_destinations ? 'onion + clearnet' : '.onion only'}, path ${cfg.destination_path_pattern}`);
	log.info(`  origins         ${[...cfg.allowedOrigins].join(' ') || '(none configured — absent Origin still allowed)'}`);
	log.info(`  listen rail     ${cfg.listen_enabled ? 'ON' : 'off'} — ping every ${cfg.ws_ping_interval_ms}ms, inbound wait ${cfg.inbound_timeout_ms}ms`);
	log.info(`  address state   ${store.durable ? `${cfg.state_dir} (durable)` : 'IN MEMORY — addresses change on every restart'}`);
	log.info(`  address ttl     ${cfg.session_ttl_days} days, rolling — this IS the address lifetime`);
	log.info(`  destination log ${cfg.log_destinations ? 'ON — payee addresses are being written to the journal' : 'off'}`);

	const shutdown = (signal) => {
		log.info(`${signal} — closing listeners`);
		for (const s of servers) s.close();
		// Closes every /listen socket with a going-away, and FLUSHES the suffix
		// table. That flush is why a restart does not change everybody's
		// receiving address, so it must not be left to the debounce timer.
		hub.shutdown();
		// Do not wait on in-flight Tor requests or parked inbound payments: a
		// stuck circuit would hold the restart open for the full read timeout
		// during a routine deploy.
		setTimeout(() => process.exit(0), 2000).unref();
	};
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));

	// ⚠ R6. The last resort, and it deliberately does NOT exit. Node's default is
	// to print the stack and die; here that means dropping every live /listen
	// socket and failing every parked inbound payment because one request found
	// one bug. The three entry points above each catch their own throws, so
	// anything arriving here is from a callback we could not wrap — log it loudly
	// and keep the other wallets connected. If the process is genuinely wedged,
	// systemd's own health checks are the thing that should restart it, not an
	// exception handler with no idea what state it is in.
	process.on('uncaughtException', (err) => {
		log.error(`UNCAUGHT EXCEPTION (service continues): ${err.stack || err.message}`);
	});
	process.on('unhandledRejection', (reason) => {
		log.error(`UNHANDLED REJECTION (service continues): ${(reason && reason.stack) || reason}`);
	});
}

function listen(port, handler, onUpgrade, log, cfg, label) {
	const server = http.createServer(handler);
	// Registering an 'upgrade' listener also detaches the socket from the
	// server's own connection handling, which is what we want: an idle /listen
	// socket is the normal state and must not be reaped as a slow request.
	server.on('upgrade', onUpgrade);
	// Both fronts are loopback-only and always will be. nginx and tor are the
	// only things that may reach this process; binding anywhere else would put
	// an open Tor proxy on the internet.
	server.listen(port, '127.0.0.1', () => {
		log.info(`listening on 127.0.0.1:${port} (${label})`);
	});
	server.on('error', (err) => {
		log.error(`listener ${port} failed: ${err.message}`);
		process.exit(1);
	});
	// Guards a slowloris on the loopback port: headers must arrive promptly and
	// the whole request must complete inside the send budget, even though only
	// nginx and tor can knock. requestTimeout is where send_timeout_ms lives —
	// it is upstream's socks_proxy_send_timeout applied at the near end, which
	// is the end we can actually enforce it at.
	server.headersTimeout = 30000;
	server.requestTimeout = cfg.send_timeout_ms;
	return server;
}

// ⚠ R6. The store is a PARAMETER. It used to be reached through a module-level
// `healthExtra` that main() assigned at its very last line — after both listeners
// were already accepting — so a /health arriving in that window answered
// `listen: {}` and read as "the listen rail has no state" rather than "ask again
// in a millisecond". A mutable global written from inside main() is a race with
// no upside when the value is simply an argument.
function health(res, cfg, front, store) {
	// Deliberately thin, and deliberately reachable only on the loopback port —
	// the nginx snippet routes /tor/ and nothing else, so this is a `curl` on
	// the box for the Status action, not a public endpoint. It still reports no
	// address, no origin and no destination, so exposing it later stays cheap.
	const body = JSON.stringify({
		service: 'grin-accio-gateway',
		packet: 'S4b',
		network: cfg.network,
		front,
		routes: cfg.listen_enabled
			? ['/tor/', '/listen', '/wallet/<suffix>/v2/foreign']
			: ['/tor/'],
		clearnet_destinations: cfg.allow_clearnet_destinations,
		socks: `${cfg.socks_host}:${cfg.socks_port}`,
		// Counts, not contents — there is no endpoint anywhere in this service
		// that lists addresses, and there must not be.
		listen: store.counts(),
		stats,
	}, null, 2) + '\n';
	res.writeHead(200, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body),
		'cache-control': 'no-store',
	});
	res.end(body);
}

main();
