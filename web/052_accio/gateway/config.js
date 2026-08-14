'use strict';
/**
 * config.js — grin-accio-gateway configuration loader.
 *
 * The gateway is installed by scripts/lib/052_lib_gateway.sh, which writes
 * /opt/grin/accio-<net>/gateway.json and points the systemd unit at it with
 * ACCIO_GATEWAY_CONF. Every value has a default here as well, so the service
 * still starts (in a safe configuration) if the file is missing a key that a
 * later packet added.
 *
 * Two rules for anything added to this file:
 *   1. The DEFAULT must be the safe value. An operator who never edits the
 *      config must not end up with a more permissive gateway than one who does.
 *   2. Nothing here is a secret. The gateway holds no keys, no wallet data and
 *      no credentials — the seed lives in the visitor's browser tab. If a
 *      future packet wants a secret here, that is a design smell, not a config
 *      addition.
 */

const fs = require('node:fs');

// Everything the gateway understands, with its safe default.
const DEFAULTS = {
	// ─── Identity ────────────────────────────────────────────────────────────
	network: 'testnet',              // testnet | mainnet — labelling only
	domain: '',                      // our own clearnet host, e.g. wallet.grin.money
	onion: '',                       // our own .onion, once S7 mints one

	// ─── Listeners (both loopback; nginx and tor are the only reachable fronts)
	port: 7490,                      // nginx front   — mainnet 7480 / testnet 7490
	tor_port: 0,                     // onion front   — mainnet 7580 / testnet 7590
	                                 // 0 disables the second listener entirely.
	                                 // See server.js for WHY it is a second PORT
	                                 // and not a header check.

	// ─── Tor SOCKS5 (the only way out of this process) ───────────────────────
	socks_host: '127.0.0.1',
	socks_port: 9050,
	// Tor isolates circuits per SOCKS username/password (IsolateSOCKSAuth is on
	// by default). We send one credential per destination host, so two different
	// onions never share a circuit, while repeated requests to the same onion
	// reuse theirs instead of paying a fresh circuit build every time.
	socks_isolate_per_destination: true,

	// ─── Destination policy (this is the SSRF guard; S8 tests it hard) ───────
	allow_clearnet_destinations: false,  // .onion only. Leave this false.
	destination_path_pattern: '^(?:/.+)?/v2/foreign$',  // upstream's `unblock`
	// ⚠ R6. Which destination PORTS may be dialled. Upstream allows any, which
	// makes this gateway a port-scanner for hidden services: the caller learns
	// open-vs-closed from connect-success-vs-timeout, and the scan runs from our
	// box and our circuits. A Grin wallet address never carries a port — the
	// client composes `http://<onion>/v2/foreign`, i.e. 80 — so the default costs
	// nothing real. An empty array means "any port", for an operator who knows
	// they are dialling a payee on a non-standard one.
	allowed_destination_ports: [80, 443],

	// ─── Request policy (mirrors upstream's Block-Access directives) ─────────
	allow_null_origin: true,         // standalone build / file:// wallets
	allow_extension_origins: true,   // chrome-extension:// , moz-extension:// …
	extra_allowed_origins: [],       // exact origins, e.g. a staging host

	// ─── Limits ──────────────────────────────────────────────────────────────
	max_body_bytes: 10485760,        // 10 MB — upstream's client_max_body_size
	connect_timeout_ms: 60000,       // upstream socks_proxy_connect_timeout 60s
	send_timeout_ms: 120000,         // upstream socks_proxy_send_timeout 2m
	read_timeout_ms: 180000,         // DELIBERATE deviation — see server.js header
	max_concurrent: 64,              // in-flight forwards, whole process
	onion_rate_per_second: 10,       // onion front only (nginx owns the clearnet
	onion_burst: 40,                 //  front's limit_req zone=accio_tor)

	// ─── The listen rail (S4b): /listen + /wallet/<suffix>/v2/foreign ────────
	listen_enabled: true,

	// Where the suffix ↔ session table is kept. EMPTY means in-memory only,
	// which is safe but means every restart changes every wallet's receiving
	// address (store.js explains the mechanism). The installer always writes a
	// real path; the empty default exists so a hand-run gateway still starts.
	state_dir: '',
	state_flush_ms: 2000,            // debounce on the snapshot writer
	state_sweep_ms: 600000,          // expired-session sweep, every 10 min

	// ─── Sessions — and therefore ADDRESS LIFETIME ───────────────────────────
	// The client discards a suffix the moment `Own URL` answers false and mints
	// a new one, so a session expiring IS the user's receiving address changing.
	// Rolling: every handshake refreshes it.
	session_ttl_days: 90,
	// ⚠ S8. Both of these bound a table that used to have no bound at all. A
	// session is minted by ANY completed /listen handshake, before the client
	// has asked for a single address, so without a cap a handshake flood grows
	// the table — and the snapshot writer rewrites the WHOLE table on a 2 s
	// debounce, which turns a cheap flood into disk amplification. Empty
	// sessions are now never persisted and are the first thing evicted; see
	// store.js createSession()/sweep()/flush().
	max_sessions: 20000,
	// How long a session that owns no address is kept. It only has to outlive
	// the gap between the handshake and the client's first `Create URL`.
	empty_session_ttl_ms: 3600000,
	session_cookie_name: 'accio_session',
	// true | false | "auto". "auto" sets Secure only when nginx reports
	// X-Forwarded-Proto: https — see listen_route.js cookieSecure(). A hard
	// `true` during the HTTP-only window of a first deploy means the cookie is
	// never stored and every reconnect mints a new address.
	session_cookie_secure: 'auto',

	// ─── Address suffixes ────────────────────────────────────────────────────
	// 16 characters over a 32-symbol alphabet = 80 bits. A suffix is a bearer
	// name for a receiving address, so it has to resist enumeration outright.
	suffix_length: 16,
	max_suffixes_per_session: 16,    // a browser may hold several wallets
	max_suffixes_total: 100000,      // bounds the snapshot and the memory

	// ─── Sockets ─────────────────────────────────────────────────────────────
	// Comfortably above any plausible number of real tabs. When the cap bites,
	// the NEW handshake is refused and no existing socket is ever touched —
	// listen_route.js explains why evicting instead is a way to disconnect a
	// live wallet mid-payment.
	max_sockets_per_session: 8,
	max_sockets_total: 512,
	ws_max_message_bytes: 262144,
	// Well inside any plausible proxy read timeout (upstream's own /listen uses
	// 60 s). The client never pings — the browser API gives page JS no way to —
	// so without this the whole population re-handshakes on a fixed cycle.
	ws_ping_interval_ms: 25000,
	ws_pong_timeout_ms: 20000,
	ws_message_rate_per_second: 20,
	ws_message_burst: 60,

	// ─── Inbound payments ────────────────────────────────────────────────────
	// ⚠ R7. NOT nginx's 1 MB, and not upstream's either (upstream sets none here
	// and silently inherits it). listen_route.deliver() base64-encodes an inbound
	// body into ONE WebSocket text frame bounded by ws_max_message_bytes, and
	// base64 costs 4 bytes per 3 — so at a 256 KB frame the real ceiling is about
	// 192 KB of body, and a 1 MB cap only meant the extra 800 KB was buffered and
	// then answered 413. It also set the process's inbound memory budget at
	// max_inbound_in_flight × 1 MB = 256 MB, on a box that is also running a Grin
	// node. A slate is a few KB; 128 KB is generous, forwardable, and puts that
	// budget at 32 MB. loadConfig() clamps whatever is configured here down to
	// the forwardable maximum, so the two limits cannot silently disagree again.
	inbound_body_bytes: 131072,
	// Bounded, unlike upstream's `proxy_read_timeout 208w`, but generous: the
	// tab may be waiting on a human to approve the receive.
	inbound_timeout_ms: 180000,
	max_inbound_in_flight: 256,
	max_inbound_per_suffix: 8,       // a backstop, deliberately generous — see listen_route.js
	// The onion front has no nginx and therefore no per-IP limit_req, and every
	// caller looks like the same 127.0.0.1. One shared bucket is the only honest
	// control there; it is separate from the /tor/ one so a send flood cannot
	// starve receives.
	onion_inbound_rate_per_second: 5,
	onion_inbound_burst: 20,

	// ─── Privacy ─────────────────────────────────────────────────────────────
	// OFF by default and it should stay off in production. It governs BOTH
	// rails: the destination of a /tor/ request is the payee's wallet address,
	// and a /wallet/<suffix> is one of our own users' addresses. Logging either
	// alongside a timestamp builds, in the journal, exactly the payment graph
	// Grin exists in order not to have.
	log_destinations: false,
};

// ⚠ R6. Keys whose TYPE is the control. Before this list existed, `listen_enabled`
// was the only boolean anyone checked, and every other one was assigned raw and
// later read for truthiness — so `"allow_clearnet_destinations": "false"`, the
// commonest hand-edit slip there is, loaded happily and turned the SSRF guard
// OFF, because the non-empty string "false" is truthy. That inverts rule 1 at the
// top of this file: the operator who edits the config ended up with the more
// permissive gateway. A wrong type is now a refusal to start, which is the only
// way an operator finds out.
const BOOLEANS = [
	'socks_isolate_per_destination', 'allow_clearnet_destinations',
	'allow_null_origin', 'allow_extension_origins',
	'listen_enabled', 'log_destinations',
];

const STRINGS = [
	'network', 'domain', 'onion', 'socks_host', 'destination_path_pattern',
	'state_dir', 'session_cookie_name',
];

// Keys that must be a positive integer; a zero or a string here is a
// misconfiguration that would silently disable a limit.
const POSITIVE_INTS = [
	'port', 'socks_port', 'max_body_bytes', 'connect_timeout_ms',
	'send_timeout_ms', 'read_timeout_ms', 'max_concurrent',
	'onion_rate_per_second', 'onion_burst',
	// S4b
	'state_flush_ms', 'state_sweep_ms', 'session_ttl_days',
	'max_sessions', 'empty_session_ttl_ms',
	'suffix_length', 'max_suffixes_per_session', 'max_suffixes_total',
	'max_sockets_per_session', 'max_sockets_total', 'ws_max_message_bytes',
	'ws_ping_interval_ms', 'ws_pong_timeout_ms', 'ws_message_rate_per_second',
	'ws_message_burst', 'inbound_body_bytes', 'inbound_timeout_ms',
	'max_inbound_in_flight', 'max_inbound_per_suffix',
	'onion_inbound_rate_per_second', 'onion_inbound_burst',
];

function loadConfig(path) {
	const cfg = Object.assign({}, DEFAULTS);
	if (path) {
		let raw;
		try {
			raw = fs.readFileSync(path, 'utf8');
		} catch (err) {
			// A missing config is fatal rather than defaulted: the defaults do
			// not know which network or port this instance is, and two
			// instances silently sharing a port is worse than not starting.
			throw new Error(`cannot read config ${path}: ${err.message}`);
		}
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			throw new Error(`config ${path} is not valid JSON: ${err.message}`);
		}
		for (const key of Object.keys(parsed)) {
			// ⚠ R6. `hasOwn`, never `key in DEFAULTS`. `in` walks the prototype
			// chain, so "toString", "constructor", "valueOf", "hasOwnProperty" and
			// "__proto__" all satisfied it and were assigned straight onto cfg —
			// the one guard whose entire job is catching a typo had a hole in it
			// exactly where a typo is least likely to look like one.
			if (!Object.hasOwn(DEFAULTS, key)) {
				// Loud, but not fatal: a key we do not know is almost always a
				// typo in a key we do (max_body_byte, tor_ports…), and a typo
				// that silently keeps the default is how a limit goes missing.
				console.error(`[config] WARNING: unknown key "${key}" ignored`);
				continue;
			}
			cfg[key] = parsed[key];
		}
	}

	// Types first: every check below reads these values, and a check that runs
	// on the wrong type answers a question nobody asked.
	for (const key of BOOLEANS) {
		if (typeof cfg[key] !== 'boolean') {
			throw new Error(`config key "${key}" must be true or false (not a string), got ${JSON.stringify(cfg[key])}`);
		}
	}
	for (const key of STRINGS) {
		if (typeof cfg[key] !== 'string') {
			throw new Error(`config key "${key}" must be a string, got ${JSON.stringify(cfg[key])}`);
		}
	}
	for (const key of POSITIVE_INTS) {
		const v = cfg[key];
		if (!Number.isInteger(v) || v <= 0) {
			throw new Error(`config key "${key}" must be a positive integer, got ${JSON.stringify(v)}`);
		}
	}
	// Labelling only, but a typo'd network is how a testnet gateway comes to
	// report itself as mainnet on /health while the operator reads it as proof.
	if (cfg.network !== 'testnet' && cfg.network !== 'mainnet') {
		throw new Error(`config key "network" must be "testnet" or "mainnet", got ${JSON.stringify(cfg.network)}`);
	}
	if (!Number.isInteger(cfg.tor_port) || cfg.tor_port < 0) {
		throw new Error(`config key "tor_port" must be 0 (disabled) or a port number`);
	}
	// After the integer checks above, so these are known to be numbers.
	for (const key of ['port', 'socks_port', 'tor_port']) {
		if (cfg[key] > 65535) {
			throw new Error(`config key "${key}" is not a valid port: ${cfg[key]}`);
		}
	}
	if (cfg.tor_port === cfg.port) {
		// The two fronts are told apart by the port they arrived on. Collapsing
		// them would make every onion request look like an nginx request.
		throw new Error('config keys "port" and "tor_port" must differ — the port IS the trust boundary');
	}
	// ⚠ R6. Neither listener may sit on Tor's SOCKS port. Which of the two
	// processes loses depends on BOOT ORDER, and both outcomes are bad in a way
	// nothing reports: either the gateway loses the bind and systemd restart-loops
	// it, or tor loses its SocksPort and every /tor/ forward SOCKS-handshakes with
	// this process instead. R4 already paid for one collision that no `nginx -t`,
	// no reload and no status screen could see; this is the same lesson, one port
	// over.
	for (const key of ['port', 'tor_port']) {
		if (cfg[key] > 0 && cfg[key] === cfg.socks_port) {
			throw new Error(`config key "${key}" (${cfg[key]}) collides with "socks_port" — the gateway would proxy to itself`);
		}
	}
	if (!Array.isArray(cfg.extra_allowed_origins)) {
		throw new Error('config key "extra_allowed_origins" must be an array');
	}
	if (!Array.isArray(cfg.allowed_destination_ports)) {
		throw new Error('config key "allowed_destination_ports" must be an array ([] = any port)');
	}
	for (const p of cfg.allowed_destination_ports) {
		if (!Number.isInteger(p) || p < 1 || p > 65535) {
			throw new Error(`config key "allowed_destination_ports" holds a value that is not a port: ${JSON.stringify(p)}`);
		}
	}
	// ─── S4b validation ──────────────────────────────────────────────────────
	if (cfg.session_cookie_secure !== true && cfg.session_cookie_secure !== false
		&& cfg.session_cookie_secure !== 'auto') {
		throw new Error('config key "session_cookie_secure" must be true, false or "auto"');
	}
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(cfg.session_cookie_name))) {
		// It goes into a Set-Cookie header verbatim, so it is validated as a
		// cookie name rather than trusted — a space or a semicolon here would be
		// header injection from a config file.
		throw new Error('config key "session_cookie_name" is not a valid cookie name');
	}
	if (cfg.suffix_length < 8 || cfg.suffix_length > 64) {
		// Below 8 characters (40 bits) a receiving address becomes enumerable;
		// above 64 it stops matching the nginx location's own length bound.
		throw new Error('config key "suffix_length" must be between 8 and 64');
	}
	if (cfg.ws_ping_interval_ms >= 55000) {
		// Upstream's own /listen sets proxy_read_timeout 60s, and any proxy in
		// the path may be stricter. A ping slower than the reaper is no ping.
		throw new Error('config key "ws_ping_interval_ms" must be well under 60000 (proxies reap idle sockets)');
	}

	// ⚠ R7. Two limits that only meet at RUNTIME is how an operator raises one and
	// gets no change at all. listen_route.deliver() base64-encodes an inbound body
	// into ONE WebSocket text frame and checks that frame against
	// ws_max_message_bytes; base64 is 4 bytes out per 3 in, so any body past about
	// three quarters of the frame budget is read in full, buffered, and then
	// answered 413 by a check it could never have passed. Reconcile the pair here,
	// once, so wallet_route's read cap is by construction a cap on something
	// deliverable.
	//
	// CLAMP rather than throw. A gateway.json written by an earlier packet carries
	// 1048576, and refusing to start on it would take the whole rail down in order
	// to enforce a limit that was already being enforced — just late, and after
	// the memory had been spent.
	const FRAME_OVERHEAD_BYTES = 1024;   // the JSON envelope around Data, with headroom
	cfg.inbound_max_forwardable = Math.max(
		1024,
		Math.floor((cfg.ws_max_message_bytes - FRAME_OVERHEAD_BYTES) / 4) * 3,
	);
	if (cfg.inbound_body_bytes > cfg.inbound_max_forwardable) {
		console.error(`[config] inbound_body_bytes ${cfg.inbound_body_bytes} is larger than one`
			+ ` ${cfg.ws_max_message_bytes}-byte listen frame can carry — clamped to ${cfg.inbound_max_forwardable}.`);
		console.error('[config] anything above that was being buffered and then answered 413.'
			+ ' Raise ws_max_message_bytes too if a larger inbound body is genuinely wanted.');
		cfg.inbound_body_bytes = cfg.inbound_max_forwardable;
	}
	try {
		new RegExp(cfg.destination_path_pattern);
	} catch (err) {
		throw new Error(`config key "destination_path_pattern" is not a valid regex: ${err.message}`);
	}

	cfg.allowedOrigins = buildAllowedOrigins(cfg);
	cfg.destinationPathRegExp = new RegExp(cfg.destination_path_pattern);
	// An EMPTY set means "any port" — guard.js reads `.size` to decide, so the
	// distinction between "no ports allowed" and "no restriction" is made once,
	// here, rather than re-derived at every call site.
	cfg.destinationPorts = new Set(cfg.allowed_destination_ports);
	return cfg;
}

/**
 * The exact set of Origin values a browser may present.
 *
 * Upstream's nginx writes this as three OPTIONAL `require_header !Origin`
 * lines, which the Block-Access module ORs together: an absent Origin passes,
 * and a present one must match one of the alternatives. We keep both halves of
 * that — see guard.js checkOrigin().
 *
 * Both schemes of our own domain are listed because the vhost is HTTP-only
 * between S2's first reload and certbot finishing; dropping http:// would make
 * the wallet unusable in exactly that window, and the destination is a .onion
 * either way, so nothing is protected by refusing it.
 */
function buildAllowedOrigins(cfg) {
	const out = new Set();
	if (cfg.domain) {
		out.add(`https://${cfg.domain}`);
		out.add(`http://${cfg.domain}`);
	}
	if (cfg.onion) {
		out.add(`http://${cfg.onion}`);
		out.add(`https://${cfg.onion}`);
	}
	for (const o of cfg.extra_allowed_origins) {
		if (typeof o === 'string' && o.length) out.add(o);
	}
	return out;
}

module.exports = { loadConfig, DEFAULTS };
