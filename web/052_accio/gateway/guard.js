'use strict';
/**
 * guard.js — everything that says NO on the /tor/ route.
 *
 * This file replaces upstream's `Block-Access` nginx C module. That module was
 * a battle-tested filter and this is not, so it is deliberately kept in one
 * small, pure, side-effect-free file: no sockets, no I/O, no config writes —
 * inputs in, a verdict out. S8 audits this file specifically, and it is the
 * only part of the gateway that is worth unit-testing exhaustively.
 *
 * ─── The directives being replaced, and their exact semantics ────────────────
 * From web/052_accio/docs/upstream-nginx.conf.reference (the `/tor/` location):
 *
 *     unblock ^(?:/.+)?/v2/foreign$;
 *     allow_top_level_domain ".onion";
 *     allow_method POST;
 *     allow_method OPTIONS;
 *     require_header !Origin "^https://mwcwallet\.com$";
 *     require_header !Origin "^null$";
 *     require_header !Origin "^.+-extension://.+$";
 *     require_header Content-Type "^application/json(?:;.*)?$" POST;
 *     block_access $1://$2;
 *
 * Two of those need the module source to read correctly, so they are recorded
 * here rather than re-derived by whoever next touches this:
 *   · a leading `!` on the header name means the header is OPTIONAL — absent
 *     passes; present must match.
 *   · several `require_header` lines for the SAME header are OR-ed, not AND-ed.
 *     Three alternatives for Origin, any one of which satisfies it.
 * Getting either backwards inverts the rule: AND-ing the three Origin patterns
 * would reject every request ever made, and treating `!` as "must be absent"
 * would reject every browser request.
 *
 * ─── Where we are STRICTER than upstream, and why ────────────────────────────
 *   · Upstream checks only the top-level domain (`.onion`). We additionally
 *     require the onion label to be a well-formed v3 address — 56 base32
 *     characters. `evil.onion` is not a reachable onion but it IS a name Tor
 *     would try to resolve, and a name is the one thing our SSRF story rests
 *     on. Narrow it to the shape that can only be an onion service.
 *   · Upstream dials any port the caller names. We allow 80 and 443 by default
 *     (`allowed_destination_ports`), because a Grin wallet address never carries
 *     a port and an arbitrary one turns this route into a port scanner for
 *     hidden services — run from our box, on our circuits.
 *   · We reject userinfo (`user@host`), IPv6 literals and any byte outside
 *     printable ASCII anywhere in the destination. Node's HTTP parser will not
 *     hand us a CR or LF in a URL, but this file is the thing standing between
 *     an attacker-chosen string and a request line we write onto a socket, so
 *     it does not delegate that to the parser.
 */

// A v3 onion is 56 chars of RFC 4648 base32 (a-z and 2-7), optionally under
// subdomains, which Tor permits and some services use for virtual hosting.
const ONION_HOST = /^(?:[a-z0-9-]+\.)*[a-z2-7]{56}\.onion$/;

// The URL shape upstream's location matches:  ^/tor/(https?)://?(.+/.*)$
// The `:/{1,2}` is not sloppiness — it is required. nginx runs with
// `merge_slashes on` by default, so by the time the request reaches a proxied
// backend, `/tor/http://abc.onion/v2/foreign` has already become
// `/tor/http:/abc.onion/v2/foreign`. Upstream's own regex allows both for the
// same reason. A gateway that only accepted `//` would work when called
// directly on the loopback port and fail through nginx — i.e. it would pass
// every developer test and fail in production.
const TOR_URL = /^\/tor\/(https?):\/{1,2}([^/?#]+)(\/[^?#]*)$/;

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

// A syntactically valid DNS name (an IPv4 literal also satisfies it). Applied
// to EVERY destination, before any policy runs, so the policy checks only ever
// see a shape they can reason about. Without it, an unbracketed IPv6 literal
// like `::1` parses as host ":" + port "1" — which is not `.onion`, is not an
// IPv4 literal and is not `localhost`, so with clearnet enabled it would sail
// past all three checks as a "hostname".
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

// Anything an IP literal could be. Only consulted when clearnet destinations
// are enabled, which they are not by default.
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// ⚠ S8. IPV4_LITERAL only recognises the DOTTED-QUAD spelling, and that is not
// the only one a resolver accepts: `2130706433`, `127.1` and `0x7f000001` all
// mean 127.0.0.1 to inet_aton, and every one of them sails past both
// IPV4_LITERAL and the PRIVATE_V4 list below while still satisfying HOSTNAME.
// So the private-address rule is enforced on a shape instead: a real public
// destination has at least one dot and a final label that starts with a LETTER
// (RFC 3696 — a TLD is alphabetic, or punycode, and is never all-numeric).
// That covers every alternate IPv4 spelling in one rule, and it is the same
// answer for a form nobody has thought of yet.
const PUBLIC_NAME_SHAPE = /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/;
const PRIVATE_V4 = [
	/^0\./, /^10\./, /^127\./, /^169\.254\./,
	/^172\.(?:1[6-9]|2\d|3[01])\./, /^192\.168\./,
	/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,   // CGNAT 100.64/10
	/^198\.1[89]\./,                                 // benchmarking 198.18/15
	/^(?:22[4-9]|2[3-5]\d)\./,                       // multicast + reserved
];

class Denied extends Error {
	constructor(status, message) {
		super(message);
		this.name = 'Denied';
		this.status = status;
	}
}

/**
 * parseTorUrl(url) → { scheme, host, port, path, query }
 * Throws Denied(400) on anything that is not the exact shape above.
 * `url` is req.url — path plus query string, never a full URL.
 */
function parseTorUrl(url) {
	const qIndex = url.indexOf('?');
	const pathPart = qIndex === -1 ? url : url.slice(0, qIndex);
	const query = qIndex === -1 ? '' : url.slice(qIndex);

	const m = TOR_URL.exec(pathPart);
	if (!m) throw new Denied(400, 'not a /tor/<scheme>://<host>/<path> request');

	const scheme = m[1];
	const authority = m[2];
	const path = m[3];

	// path always starts with '/', so `path + query` is never empty and the
	// anchored + one-or-more regex cannot pass vacuously.
	if (!PRINTABLE_ASCII.test(authority) || !PRINTABLE_ASCII.test(path + query)) {
		throw new Denied(400, 'destination contains a non-printable byte');
	}
	if (authority.includes('@')) throw new Denied(403, 'destination carries userinfo');
	if (authority.includes('[') || authority.includes(']')) {
		throw new Denied(403, 'destination is an IPv6 literal');
	}

	let host = authority;
	let port = scheme === 'https' ? 443 : 80;
	const colon = authority.lastIndexOf(':');
	if (colon !== -1) {
		const portText = authority.slice(colon + 1);
		if (!/^\d{1,5}$/.test(portText)) throw new Denied(400, 'destination port is not a number');
		port = Number(portText);
		if (port < 1 || port > 65535) throw new Denied(400, 'destination port out of range');
		host = authority.slice(0, colon);
	}
	host = host.toLowerCase();
	if (!host) throw new Denied(400, 'destination has no host');
	if (host.length > 253 || !HOSTNAME.test(host)) {
		throw new Denied(400, 'destination host is not a valid hostname');
	}

	return { scheme, host, port, path, query };
}

/**
 * checkDestination(dest, cfg) — the SSRF guard proper.
 *
 * Note what this does NOT do: it never resolves a name. The connection is made
 * by handing this same string to Tor (socks5.js, ATYP 0x03), so there is no gap
 * between the decision and the connection for a rebind to slip through.
 */
function checkDestination(dest, cfg) {
	// ⚠ R6. The PORT is part of the destination, and upstream never looked at it.
	// A wallet address never carries one — the client composes
	// `http://<onion>/v2/foreign`, i.e. 80 — so an arbitrary port is not a payee,
	// it is a probe: the caller reads open-vs-closed off connect-success-vs-
	// timeout, and the scan runs from our box, on our circuits, against hidden
	// services chosen by them. Checked before the host rules because it applies
	// to onion and clearnet alike.
	if (cfg.destinationPorts.size && !cfg.destinationPorts.has(dest.port)) {
		throw new Denied(403, 'destination port is not allowed');
	}
	if (dest.host.endsWith('.onion')) {
		if (!ONION_HOST.test(dest.host)) {
			throw new Denied(403, 'destination is not a valid v3 onion address');
		}
		return;
	}
	if (!cfg.allow_clearnet_destinations) {
		throw new Denied(403, 'destination is not a .onion address');
	}
	// Clearnet is off by default. When an operator turns it on, the traffic
	// still leaves through Tor, so "reach our own LAN" is not on the table —
	// but an IP literal is never a legitimate wallet address here, and letting
	// one through would make this guard's story depend on Tor's exit policy
	// instead of on our own rule.
	if (IPV4_LITERAL.test(dest.host) && PRIVATE_V4.some((re) => re.test(dest.host))) {
		throw new Denied(403, 'destination is a private or reserved IPv4 address');
	}
	if (dest.host === 'localhost' || dest.host.endsWith('.localhost') || dest.host.endsWith('.local')) {
		throw new Denied(403, 'destination is a local name');
	}
	// The catch-all for every IP spelling the check above cannot see, and for
	// the single-label intranet names (`router`, `wiki`) that a resolver would
	// complete from a search domain. A wallet address is a public name.
	if (!PUBLIC_NAME_SHAPE.test(dest.host)) {
		throw new Denied(403, 'destination is not a public hostname');
	}
}

/** checkPath — upstream's `unblock`: only the wallet Foreign API is proxyable. */
function checkPath(dest, cfg) {
	if (!cfg.destinationPathRegExp.test(dest.path)) {
		throw new Denied(403, 'only the wallet Foreign API path may be proxied');
	}
}

/** checkMethod — upstream's two `allow_method` lines. */
function checkMethod(method) {
	if (method !== 'POST' && method !== 'OPTIONS') {
		throw new Denied(405, 'only POST and OPTIONS may be proxied');
	}
}

/**
 * checkOrigin — upstream's three OR-ed, OPTIONAL `require_header !Origin`.
 *
 * Absent is allowed on purpose and is the common case: the hosted wallet calls
 * its own origin, and a same-origin request need not carry Origin at all. This
 * header is therefore not an authorisation control — it is a cheap filter that
 * keeps a third-party page from quietly using our gateway as an open proxy.
 * The real controls are checkDestination and checkPath.
 */
function checkOrigin(origin, cfg) {
	if (origin === undefined || origin === '') return;
	// R6: belt-and-braces, not the duplicate-header defence it reads as. Node's
	// parser never hands us an array here — `origin` is not on its dedup list, so
	// two Origin headers arrive JOINED as "https://a, https://b", which fails the
	// exact-match Set below and is denied on that path instead. Kept because a
	// future header-source (a test harness, a rewritten front) could hand us one.
	if (Array.isArray(origin)) throw new Denied(403, 'multiple Origin headers');
	if (cfg.allow_null_origin && origin === 'null') return;
	if (cfg.allow_extension_origins && /^[a-z]+-extension:\/\/.+$/i.test(origin)) return;
	if (cfg.allowedOrigins.has(origin)) return;
	throw new Denied(403, 'Origin is not allowed to use this gateway');
}

/** checkContentType — upstream's `require_header Content-Type … POST`. */
function checkContentType(method, contentType) {
	if (method !== 'POST') return;
	// R6: unreachable via Node's parser for the opposite reason to Origin above —
	// `content-type` IS on the dedup list, so a duplicated header resolves to the
	// FIRST value and the second is discarded before we see it. That is first-wins,
	// not last-wins; the value checked here is the value tor_route.js forwards.
	if (Array.isArray(contentType)) throw new Denied(415, 'multiple Content-Type headers');
	if (!contentType || !/^application\/json(?:;.*)?$/i.test(contentType.trim())) {
		throw new Denied(415, 'POST body must be application/json');
	}
}

/**
 * inspect(req, cfg) → dest
 * The single entry point. Order matters only for which error a caller sees
 * first; every check is independent.
 */
function inspect(req, cfg) {
	checkMethod(req.method);
	const dest = parseTorUrl(req.url);
	checkDestination(dest, cfg);
	checkPath(dest, cfg);
	checkOrigin(req.headers['origin'], cfg);
	checkContentType(req.method, req.headers['content-type']);
	return dest;
}

module.exports = {
	Denied, inspect, parseTorUrl,
	checkDestination, checkPath, checkMethod, checkOrigin, checkContentType,
	ONION_HOST, PUBLIC_NAME_SHAPE,
};
