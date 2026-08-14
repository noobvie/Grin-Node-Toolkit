'use strict';
/**
 * ws.js — a minimal RFC 6455 WebSocket server, hand-written (packet S4b).
 *
 * ─── Why this is not `ws` from npm ───────────────────────────────────────────
 * The same rule that produced socks5.js: this gateway has ZERO npm
 * dependencies, and that is a rule rather than an accident. S0 spent an entire
 * packet making Accio's source pinned, offline and rebuildable from our own
 * repo; adding a package with its own transitive tree hands that back. The
 * client we serve is upstream's `listener.js`, and it uses a deliberately small
 * corner of the protocol (see docs §"Listen protocol" §1):
 *
 *   · text frames only — every send is JSON.stringify, every receive JSON.parse
 *   · no subprotocol   — `new WebSocket(addr)` is called with ONE argument, so
 *                        we must not select one
 *   · no extensions    — we never negotiate permessage-deflate, so RSV bits
 *                        must be zero and we must not echo the
 *                        Sec-WebSocket-Extensions header nginx forwards
 *   · no client ping   — the browser WebSocket API exposes no ping to page JS
 *                        at all, so liveness is entirely OUR job (§11.8)
 *
 * What is still implemented in full, because a wire format you implement
 * halfway is a parser bug waiting to happen: masking, all three payload-length
 * encodings, continuation frames, interleaved control frames, and the close
 * handshake.
 *
 * ─── The one thing that must not be skipped ──────────────────────────────────
 * Every frame from a client MUST be masked (RFC 6455 §5.1). An unmasked client
 * frame is a protocol violation and is also the signature of a cache-poisoning
 * probe, so it is a hard close, not a warning.
 *
 * Sizes are capped at the header, BEFORE any buffering: a peer that declares a
 * 2 GB payload must cost us nothing but the close frame.
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

// RFC 6455 §1.3. Not a secret and not configurable — it is part of the format.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = {
	CONTINUATION: 0x0,
	TEXT: 0x1,
	BINARY: 0x2,
	CLOSE: 0x8,
	PING: 0x9,
	PONG: 0xa,
};

// The subset of RFC 6455 §7.4.1 close codes this server actually sends.
const CLOSE = {
	NORMAL: 1000,
	GOING_AWAY: 1001,
	PROTOCOL_ERROR: 1002,
	UNSUPPORTED_DATA: 1003,
	POLICY_VIOLATION: 1008,
	TOO_BIG: 1009,
	INTERNAL_ERROR: 1011,
};

/** Raised by handshake() when the request is not a valid upgrade for us. */
class HandshakeError extends Error {
	constructor(status, message) {
		super(message);
		this.name = 'HandshakeError';
		this.status = status;
	}
}

function computeAccept(key) {
	return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/**
 * handshake(req, socket, head, options) → WsConnection
 *
 * Validates the upgrade, writes the 101, and returns a live connection.
 * Throws HandshakeError; the CALLER decides what to write on the socket for a
 * failure, because only the caller knows whether this front is allowed to say
 * anything at all.
 *
 * options.extraHeaders — array of raw "Name: value" lines added to the 101.
 *   This is how the session cookie is set: `Set-Cookie` on the handshake
 *   response is the ONLY place the ownership session can be established, since
 *   the page JS never touches document.cookie for it (design §10). Upstream
 *   proves the same thing from the other side — `/listen` is the one location
 *   in its whole nginx conf that forwards Cookie and allow-lists Set-Cookie.
 */
function handshake(req, socket, head, options) {
	const opts = options || {};

	if (req.method !== 'GET') {
		throw new HandshakeError(405, 'websocket upgrade must be a GET');
	}
	const upgrade = String(req.headers['upgrade'] || '').toLowerCase();
	if (upgrade !== 'websocket') {
		throw new HandshakeError(400, 'not a websocket upgrade');
	}
	// A comma list: nginx sends exactly "upgrade", but a direct client may send
	// "keep-alive, Upgrade".
	const connection = String(req.headers['connection'] || '').toLowerCase();
	if (!connection.split(',').some((t) => t.trim() === 'upgrade')) {
		throw new HandshakeError(400, 'Connection header does not request an upgrade');
	}
	if (String(req.headers['sec-websocket-version'] || '') !== '13') {
		// The RFC says answer with the versions we do support. There is one.
		const err = new HandshakeError(426, 'only websocket version 13 is supported');
		err.extraHeaders = ['Sec-WebSocket-Version: 13'];
		throw err;
	}
	const key = req.headers['sec-websocket-key'];
	// 16 random bytes, base64 — 24 characters ending in "==". Checked because
	// the value is echoed through a hash into a response header, and a header
	// value is the wrong place to be relaxed about input shape.
	if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
		throw new HandshakeError(400, 'missing or malformed Sec-WebSocket-Key');
	}

	const lines = [
		'HTTP/1.1 101 Switching Protocols',
		'Upgrade: websocket',
		'Connection: Upgrade',
		`Sec-WebSocket-Accept: ${computeAccept(key)}`,
	];
	// NOTE what is deliberately absent: Sec-WebSocket-Protocol and
	// Sec-WebSocket-Extensions. nginx forwards the client's Extensions header,
	// and echoing it would claim we implement permessage-deflate — after which
	// every frame the client sent would be deflated and our parser would read
	// compressed bytes as JSON. Selecting a subprotocol the client never offered
	// makes a browser abort the connection outright.
	for (const line of (opts.extraHeaders || [])) lines.push(line);
	socket.write(lines.join('\r\n') + '\r\n\r\n');

	return new WsConnection(socket, head, opts);
}

/**
 * One live socket. Events:
 *   'message' (string)   — a complete text message
 *   'close'   (code, reason)
 *   'error'   (Error)    — informational; 'close' always follows
 */
class WsConnection extends EventEmitter {
	constructor(socket, head, opts) {
		super();
		const o = opts || {};
		this.socket = socket;
		this.closed = false;
		this.maxMessageBytes = o.maxMessageBytes || 262144;
		this.pingIntervalMs = o.pingIntervalMs || 25000;
		this.pongTimeoutMs = o.pongTimeoutMs || 20000;

		// `head` is whatever arrived in the same packet as the upgrade request. It
		// is BUFFERED here and PARSED a tick later — see the bottom of this
		// constructor for why that separation is not cosmetic.
		this._buf = (head && head.length) ? Buffer.from(head) : Buffer.alloc(0);
		this._fragments = null;      // Buffer[] while a fragmented message is open
		this._fragmentOpcode = 0;
		this._fragmentBytes = 0;
		this._awaitingPong = false;
		this._closeSent = false;

		socket.setNoDelay(true);
		// The HTTP server's socket timeouts stop applying the moment we take the
		// socket over, and they SHOULD: an idle /listen socket is the normal
		// state, not a slowloris. Liveness is the ping loop below instead.
		socket.setTimeout(0);

		socket.on('data', (chunk) => this._onData(chunk));
		socket.on('error', (err) => {
			this._emitError(err);
			this._teardown(CLOSE.INTERNAL_ERROR, 'socket error');
		});
		socket.on('close', () => this._teardown(CLOSE.GOING_AWAY, 'socket closed'));
		// ⚠ 'end' is NOT redundant with 'close', and leaving it out is a real
		// leak. A peer that half-closes — a TCP FIN, which is exactly what a
		// browser sends when its tab is closed — produces 'end' and NOTHING
		// ELSE: the socket stays writable from our side, so 'close' does not
		// fire and the connection sits on the books until the pong timeout
		// eventually notices, up to ping+pong (45 s on the defaults) later. For
		// that whole window the session's socket slot is held by a tab that no
		// longer exists, and /health over-reports the live count. Verified by
		// watching listen_open refuse to fall after a clean end().
		socket.on('end', () => this._teardown(CLOSE.GOING_AWAY, 'peer closed the connection'));

		// ─── Liveness (design §11.8) ─────────────────────────────────────────
		// The client never pings — the browser API gives page JS no way to. If
		// nothing crosses the socket, every proxy in the path eventually reaps
		// it (upstream's own /listen sets proxy_read_timeout 60s), the client
		// reconnects, and EVERY reconnect costs one `Own URL` per wallet. So the
		// server pings well inside any plausible proxy timeout. Without this the
		// whole population re-handshakes on a fixed cycle forever.
		this._pingTimer = setInterval(() => this._heartbeat(), this.pingIntervalMs);
		this._pongTimer = null;

		// ⚠ Do NOT parse `head` here. A client may pipeline complete frames into
		// the same packet as the upgrade request — an attacker certainly will —
		// and parsing them inside the constructor runs them BEFORE the caller has
		// attached its listeners, because handshake() has not returned yet. Two
		// distinct failures follow: a valid first message is emitted into the void
		// (the client's opening `Own URL` disappears and it waits out its 120 s
		// timeout), and a BAD frame calls _fail(), whose emit('error') on an
		// EventEmitter with no 'error' listener THROWS — out of handshake(), after
		// the 101 has already gone on the wire, so the caller's failure path then
		// writes an HTTP error response into a stream that is no longer HTTP.
		// process.nextTick runs before any socket I/O callback, so deferring the
		// parse cannot reorder head ahead of, or behind, real inbound data.
		if (this._buf.length) process.nextTick(() => this._parse());
	}

	/** send(text) — one unfragmented text frame. */
	send(text) {
		if (this.closed) return false;
		try {
			this.socket.write(encodeFrame(OPCODE.TEXT, Buffer.from(text, 'utf8')));
			return true;
		} catch (err) {
			this._emitError(err);
			this._teardown(CLOSE.INTERNAL_ERROR, 'write failed');
			return false;
		}
	}

	/** close(code, reason) — polite close frame, then drop the socket. */
	close(code, reason) {
		if (this.closed) return;
		this._sendClose(code || CLOSE.NORMAL, reason || '');
		// Do not wait for the peer's close frame. A client that has already gone
		// away would otherwise hold the socket until the OS notices, and this
		// process may be shutting down.
		this._teardown(code || CLOSE.NORMAL, reason || '');
	}

	_heartbeat() {
		if (this.closed) return;
		if (this._awaitingPong) {
			// A missed pong is the only evidence we can get that a socket is
			// dead but not closed — a laptop that slept, a NAT that dropped the
			// mapping. Dropping it frees the session slot; the client's own
			// retry ladder brings it straight back.
			this.close(CLOSE.GOING_AWAY, 'no pong');
			return;
		}
		this._awaitingPong = true;
		try {
			this.socket.write(encodeFrame(OPCODE.PING, Buffer.alloc(0)));
		} catch { /* the 'error' handler above deals with it */ }
		clearTimeout(this._pongTimer);
		this._pongTimer = setTimeout(() => {
			if (this._awaitingPong) this.close(CLOSE.GOING_AWAY, 'no pong');
		}, this.pongTimeoutMs);
		this._pongTimer.unref?.();
	}

	_fail(code, message) {
		this._sendClose(code, message);
		this._emitError(new Error(message));
		this._teardown(code, message);
	}

	/**
	 * ⚠ Never `this.emit('error', …)` directly. EventEmitter THROWS when an
	 * 'error' is emitted with no listener attached, so a malformed frame from a
	 * peer would take the whole gateway down — every other wallet's socket with
	 * it — and systemd would restart it straight into the next one. There is a
	 * real window where no listener exists: the parse of a pipelined `head`
	 * frame is scheduled inside the constructor, before handshake() has returned
	 * and before the caller could possibly have subscribed. 'close' always
	 * follows and always carries the reason, so nothing is lost by staying quiet.
	 */
	_emitError(err) {
		if (this.listenerCount('error') > 0) this.emit('error', err);
	}

	_sendClose(code, reason) {
		if (this._closeSent || this.closed) return;
		this._closeSent = true;
		const text = Buffer.from(String(reason || '').slice(0, 100), 'utf8');
		const payload = Buffer.alloc(2 + text.length);
		payload.writeUInt16BE(code, 0);
		text.copy(payload, 2);
		try { this.socket.write(encodeFrame(OPCODE.CLOSE, payload)); } catch { /* gone */ }
	}

	_teardown(code, reason) {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this._pingTimer);
		clearTimeout(this._pongTimer);
		this._buf = Buffer.alloc(0);
		this._fragments = null;
		// end() rather than destroy(), so a close frame written a moment ago
		// actually reaches the peer — destroy() discards anything still queued,
		// which turns every deliberate close code ("no pong", "gateway
		// restarting", a protocol violation) into an unexplained reset at the far
		// end. The socket is dropped either way; only the diagnostic differs.
		// A short unref'd timer guarantees the fd is released even if the peer
		// never acknowledges, so nothing here can hold a shutdown open.
		try {
			this.socket.end();
			const t = setTimeout(() => { try { this.socket.destroy(); } catch { /* gone */ } }, 250);
			t.unref?.();
		} catch { /* already gone */ }
		this.emit('close', code, reason);
	}

	_onData(chunk) {
		if (this.closed) return;
		this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
		this._parse();
	}

	_parse() {
		if (this.closed) return;
		// A frame header is at most 14 bytes, so anything beyond one maximum
		// payload plus a header is a peer sending faster than we can parse —
		// which, given every frame is capped below, cannot happen honestly.
		if (this._buf.length > this.maxMessageBytes + 1024) {
			this._fail(CLOSE.TOO_BIG, 'inbound buffer overflow');
			return;
		}
		for (;;) {
			if (this.closed) return;
			const frame = this._readFrame();
			if (frame === null) return;      // need more bytes
			if (frame === false) return;     // _fail() already ran
			this._handleFrame(frame);
		}
	}

	/**
	 * Returns a frame, null (need more bytes), or false (connection failed).
	 * Every rejection here happens BEFORE the payload is buffered.
	 */
	_readFrame() {
		const buf = this._buf;
		if (buf.length < 2) return null;

		const b0 = buf[0];
		const b1 = buf[1];
		const fin = (b0 & 0x80) !== 0;
		const rsv = b0 & 0x70;
		const opcode = b0 & 0x0f;
		const masked = (b1 & 0x80) !== 0;
		let len = b1 & 0x7f;
		let offset = 2;

		if (rsv !== 0) {
			// We negotiated no extensions, so a reserved bit is either a peer
			// assuming permessage-deflate or a corrupt stream. Both are fatal.
			this._fail(CLOSE.PROTOCOL_ERROR, 'reserved bits set with no extension negotiated');
			return false;
		}
		if (!masked) {
			// RFC 6455 §5.1: a server MUST close on an unmasked client frame.
			this._fail(CLOSE.PROTOCOL_ERROR, 'client frame is not masked');
			return false;
		}

		const isControl = (opcode & 0x8) !== 0;
		if (isControl) {
			if (!fin) { this._fail(CLOSE.PROTOCOL_ERROR, 'fragmented control frame'); return false; }
			if (len > 125) { this._fail(CLOSE.PROTOCOL_ERROR, 'control frame too long'); return false; }
		}

		if (len === 126) {
			if (buf.length < offset + 2) return null;
			len = buf.readUInt16BE(offset);
			offset += 2;
		} else if (len === 127) {
			if (buf.length < offset + 8) return null;
			const hi = buf.readUInt32BE(offset);
			const lo = buf.readUInt32BE(offset + 4);
			// A 64-bit length that does not fit in 32 bits is already far past
			// any cap we would accept; refuse without doing the arithmetic.
			if (hi !== 0) { this._fail(CLOSE.TOO_BIG, 'frame too large'); return false; }
			len = lo;
			offset += 8;
		}
		if (len > this.maxMessageBytes) {
			this._fail(CLOSE.TOO_BIG, 'frame exceeds the message size limit');
			return false;
		}

		if (buf.length < offset + 4) return null;
		const mask = buf.subarray(offset, offset + 4);
		offset += 4;

		if (buf.length < offset + len) return null;
		const payload = Buffer.allocUnsafe(len);
		buf.copy(payload, 0, offset, offset + len);
		for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];

		this._buf = buf.subarray(offset + len);
		return { fin, opcode, payload };
	}

	_handleFrame(frame) {
		const { fin, opcode, payload } = frame;

		switch (opcode) {
			case OPCODE.PING:
				try { this.socket.write(encodeFrame(OPCODE.PONG, payload)); } catch { /* gone */ }
				return;
			case OPCODE.PONG:
				this._awaitingPong = false;
				clearTimeout(this._pongTimer);
				return;
			case OPCODE.CLOSE: {
				const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE.NORMAL;
				this._sendClose(CLOSE.NORMAL, '');
				this._teardown(code, 'peer closed');
				return;
			}
			case OPCODE.BINARY:
				// The client is JSON-over-text by construction (§1). A binary
				// frame means something other than the wallet is talking to us.
				this._fail(CLOSE.UNSUPPORTED_DATA, 'binary frames are not accepted');
				return;
			case OPCODE.TEXT:
				if (this._fragments) {
					this._fail(CLOSE.PROTOCOL_ERROR, 'new message started mid-fragment');
					return;
				}
				if (fin) { this._deliver(payload); return; }
				this._fragments = [payload];
				this._fragmentOpcode = OPCODE.TEXT;
				this._fragmentBytes = payload.length;
				return;
			case OPCODE.CONTINUATION: {
				if (!this._fragments) {
					this._fail(CLOSE.PROTOCOL_ERROR, 'continuation frame with no message open');
					return;
				}
				this._fragmentBytes += payload.length;
				// The per-frame cap above is not enough on its own: a peer could
				// send a thousand legal 250 KB fragments. The cap has to apply to
				// the reassembled message too.
				if (this._fragmentBytes > this.maxMessageBytes) {
					this._fail(CLOSE.TOO_BIG, 'message exceeds the size limit');
					return;
				}
				this._fragments.push(payload);
				if (!fin) return;
				const whole = Buffer.concat(this._fragments, this._fragmentBytes);
				this._fragments = null;
				this._fragmentBytes = 0;
				this._deliver(whole);
				return;
			}
			default:
				this._fail(CLOSE.PROTOCOL_ERROR, `unknown opcode 0x${opcode.toString(16)}`);
		}
	}

	_deliver(payload) {
		// Node decodes invalid UTF-8 to U+FFFD rather than throwing, so a
		// mis-encoded frame arrives here as text that will simply fail to parse
		// as JSON — which the caller already has to handle. The client does
		// exactly the same thing in the other direction (§2: anything that is
		// not valid JSON is dropped without a reply).
		this.emit('message', payload.toString('utf8'));
	}
}

/** Server→client frames are never masked (RFC 6455 §5.1). */
function encodeFrame(opcode, payload) {
	const len = payload.length;
	let header;
	if (len < 126) {
		header = Buffer.allocUnsafe(2);
		header[1] = len;
	} else if (len < 65536) {
		header = Buffer.allocUnsafe(4);
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.allocUnsafe(10);
		header[1] = 127;
		header.writeUInt32BE(0, 2);
		header.writeUInt32BE(len, 6);
	}
	header[0] = 0x80 | opcode;   // FIN set: we never fragment outbound
	return Buffer.concat([header, payload], header.length + len);
}

module.exports = {
	handshake, HandshakeError, WsConnection,
	computeAccept, encodeFrame, OPCODE, CLOSE, GUID,
};
