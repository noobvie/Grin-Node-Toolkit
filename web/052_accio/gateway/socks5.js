'use strict';
/**
 * socks5.js — a SOCKS5 CONNECT client (RFC 1928 + RFC 1929), zero dependencies.
 *
 * ─── Why this is hand-written rather than `socks-proxy-agent` ────────────────
 * The design (script052_design.md §S3) named socks-proxy-agent. It is a fine
 * package; this is a deliberate deviation, for reasons specific to what this
 * file is:
 *
 *   · This process is the one part of Accio that touches attacker-influenced
 *     bytes from an arbitrary hidden service. socks-proxy-agent pulls in a
 *     transitive tree (agent-base, socks, smart-buffer, ip-address, debug) and
 *     every one of those becomes supply chain on a *wallet* front end.
 *   · S0 spent a whole packet making this product's source pinned, offline and
 *     byte-verifiable. Reintroducing an unpinned npm fetch at install time on
 *     the VPS gives that back for ~90 lines of protocol we can read in full.
 *   · We only ever need one command (CONNECT), one address type (domain name,
 *     because Tor must do the resolving) and one optional auth method. The
 *     package's generality is surface we do not use.
 *
 * The gateway therefore has NO npm dependencies at all, and its install step
 * makes no network request. If a later packet genuinely needs a package (S4b
 * may want `ws`), that is a decision to take then, on its own merits.
 *
 * ─── Why ATYP 0x03 (domain name) and never an IP ─────────────────────────────
 * Passing the hostname to Tor and letting Tor resolve it is what makes .onion
 * work at all — there is no A record to look up. It also removes a whole class
 * of SSRF: because this process never resolves a name, there is no window
 * between "the guard checked the host" and "the socket connected to an
 * address", so DNS rebinding has nothing to rebind. The guard's decision and
 * the connection are about the same string.
 */

const net = require('node:net');

const VERSION = 0x05;
const CMD_CONNECT = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV4 = 0x01;
const ATYP_IPV6 = 0x04;

const METHOD_NONE = 0x00;
const METHOD_USERPASS = 0x02;
const METHOD_UNACCEPTABLE = 0xff;

// RFC 1928 §6. Tor reuses these; 0x04 is what an unreachable or unpublished
// onion descriptor comes back as, which is the failure operators actually hit.
const REPLY_TEXT = {
	0x00: 'succeeded',
	0x01: 'general SOCKS server failure',
	0x02: 'connection not allowed by ruleset',
	0x03: 'network unreachable',
	0x04: 'host unreachable (onion descriptor not found, or the service is offline)',
	0x05: 'connection refused (the onion is reachable but nothing is listening on that port)',
	0x06: 'TTL expired',
	0x07: 'command not supported',
	0x08: 'address type not supported',
};

class SocksError extends Error {
	constructor(message, code) {
		super(message);
		this.name = 'SocksError';
		this.code = code;            // SOCKS reply byte, or null for local failures
	}
}

/**
 * Read exactly `n` bytes from a socket, without ever putting it in flowing mode.
 *
 * ⚠ This uses 'readable' + socket.read(n), NOT a 'data' handler, and that is
 * load-bearing rather than stylistic. The socket does not belong to us — it is
 * handed straight to Node's HTTP client the moment the handshake ends, and the
 * client attaches its own 'data' parser. Three facts collide:
 *
 *   · attaching a 'data' handler puts the stream in flowing mode;
 *   · removing that handler does NOT take it back out, so bytes keep being
 *     emitted to nobody and are lost;
 *   · calling pause() to stop that sets flowing = false PERMANENTLY as far as
 *     the next consumer is concerned — Readable.on('data') only auto-resumes
 *     when flowing !== false, so the HTTP client attaches its parser to a
 *     socket that never delivers a byte and the request hangs until the read
 *     timeout. (Observed exactly that: every forward returned 504.)
 *
 * Reading in paused mode sidesteps all three. Anything the proxy sent past the
 * handshake simply stays in the stream's own buffer, so there is nothing to
 * unshift and nothing to lose, and removing the 'readable' listener leaves
 * flowing = null — the neutral state the HTTP client expects.
 */
function createReader(socket) {
	let want = 0;
	let resolveFn = null;
	let rejectFn = null;

	const tryRead = () => {
		if (!resolveFn) return;
		const chunk = socket.read(want);
		if (chunk === null) return;          // fewer than `want` bytes so far
		const done = resolveFn;
		resolveFn = rejectFn = null;
		want = 0;
		done(chunk);
	};
	const fail = (err) => {
		if (!rejectFn) return;
		const done = rejectFn;
		resolveFn = rejectFn = null;
		done(err);
	};

	socket.on('readable', tryRead);
	socket.once('error', fail);
	socket.once('close', () => fail(new SocksError('SOCKS proxy closed the connection during the handshake', null)));

	return {
		read(n) {
			return new Promise((resolve, reject) => {
				want = n;
				resolveFn = resolve;
				rejectFn = reject;
				tryRead();
			});
		},
		detach() {
			socket.removeListener('readable', tryRead);
			socket.removeListener('error', fail);
		},
	};
}

function buildGreeting(withAuth) {
	const methods = withAuth ? [METHOD_NONE, METHOD_USERPASS] : [METHOD_NONE];
	return Buffer.from([VERSION, methods.length, ...methods]);
}

function buildUserPass(username, password) {
	const u = Buffer.from(username, 'utf8').subarray(0, 255);
	const p = Buffer.from(password, 'utf8').subarray(0, 255);
	return Buffer.concat([
		Buffer.from([0x01, u.length]), u,
		Buffer.from([p.length]), p,
	]);
}

function buildConnect(host, port) {
	const h = Buffer.from(host, 'ascii');
	if (h.length === 0 || h.length > 255) {
		throw new SocksError(`destination host length ${h.length} is not addressable over SOCKS5`, null);
	}
	return Buffer.concat([
		Buffer.from([VERSION, CMD_CONNECT, 0x00, ATYP_DOMAIN, h.length]), h,
		Buffer.from([(port >> 8) & 0xff, port & 0xff]),
	]);
}

/**
 * connect({ socksHost, socksPort, host, port, timeoutMs, isolationTag })
 *   → Promise<net.Socket> already tunnelled to host:port.
 *
 * `isolationTag`, when set, is sent as the SOCKS username. Tor's default
 * SocksPort has IsolateSOCKSAuth on, so distinct credentials get distinct
 * circuits: pass the destination host and two payees never share one, while a
 * retry to the same payee reuses the circuit instead of paying a fresh build.
 * The value is not a secret and Tor does not authenticate it — it is a circuit
 * selector, nothing more.
 */
function connect(opts) {
	const {
		socksHost, socksPort, host, port,
		timeoutMs = 60000, isolationTag = null,
	} = opts;

	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: socksHost, port: socksPort });
		let settled = false;

		const done = (err, value) => {
			if (settled) return;
			settled = true;
			socket.setTimeout(0);
			if (err) {
				socket.destroy();
				reject(err);
			} else {
				resolve(value);
			}
		};

		socket.setTimeout(timeoutMs, () => {
			done(new SocksError(`timed out after ${timeoutMs}ms connecting through the Tor SOCKS proxy`, null));
		});
		socket.once('error', (err) => {
			// The overwhelmingly common one: ECONNREFUSED because tor is not
			// running. Say so rather than leaving an operator to guess.
			const hint = err.code === 'ECONNREFUSED'
				? ` — is tor running and listening on ${socksHost}:${socksPort}?`
				: '';
			done(new SocksError(`SOCKS proxy connection failed: ${err.message}${hint}`, null));
		});

		socket.once('connect', () => {
			const reader = createReader(socket);
			handshake(socket, reader, { host, port, isolationTag })
				.then(() => {
					reader.detach();
					done(null, socket);
				})
				.catch((err) => done(err instanceof SocksError ? err : new SocksError(err.message, null)));
		});
	});
}

async function handshake(socket, reader, { host, port, isolationTag }) {
	socket.write(buildGreeting(Boolean(isolationTag)));

	const greeting = await reader.read(2);
	if (greeting[0] !== VERSION) {
		throw new SocksError(`SOCKS proxy answered version ${greeting[0]}, expected 5`, null);
	}
	if (greeting[1] === METHOD_UNACCEPTABLE) {
		throw new SocksError('SOCKS proxy rejected every authentication method we offered', null);
	}
	if (greeting[1] === METHOD_USERPASS) {
		socket.write(buildUserPass(isolationTag || 'accio', 'accio'));
		const auth = await reader.read(2);
		if (auth[1] !== 0x00) {
			throw new SocksError(`SOCKS proxy rejected the isolation credential (status ${auth[1]})`, null);
		}
	} else if (greeting[1] !== METHOD_NONE) {
		throw new SocksError(`SOCKS proxy selected unsupported method ${greeting[1]}`, null);
	}

	socket.write(buildConnect(host, port));

	const head = await reader.read(4);
	if (head[0] !== VERSION) {
		throw new SocksError(`SOCKS reply had version ${head[0]}, expected 5`, null);
	}
	const rep = head[1];
	// The bound address must be consumed whatever the reply says, or its bytes
	// would be mistaken for the start of the HTTP response.
	const atyp = head[3];
	if (atyp === ATYP_IPV4) {
		await reader.read(4 + 2);
	} else if (atyp === ATYP_IPV6) {
		await reader.read(16 + 2);
	} else if (atyp === ATYP_DOMAIN) {
		const len = await reader.read(1);
		await reader.read(len[0] + 2);
	} else {
		throw new SocksError(`SOCKS reply used unknown address type ${atyp}`, rep);
	}
	if (rep !== 0x00) {
		throw new SocksError(REPLY_TEXT[rep] || `SOCKS connect failed with reply code ${rep}`, rep);
	}
}

module.exports = { connect, SocksError, REPLY_TEXT };
