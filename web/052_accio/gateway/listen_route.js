'use strict';
/**
 * listen_route.js — the /listen WebSocket rail (packet S4b).
 *
 * This replaces upstream's `WebSocket-Listener` C++ daemon, which we may not
 * ship: it carries no LICENSE, LICENSE.md, LICENSE.txt or COPYING and no licence
 * mention in its README, so it is all-rights-reserved. It is also the ONE
 * component that decides whether Accio can receive at all. Everything here is
 * written against the protocol spec in `docs/generated/script052_design.md`
 * §"Listen protocol", which packet S4a produced by reading the MIT *client*
 * (`listener.js`) alone. Section references below are to that spec.
 *
 * ─── The three traps that are silent when you get them wrong ─────────────────
 *  1. `Status` is a NUMBER client→server (an HTTP status for us to return) and
 *     the STRING "Succeeded" server→client (§6, §7). Same key, two types, two
 *     directions.
 *  2. One status message, two roles, decided purely by timing (§7). Before the
 *     tab replies it CANCELS the interaction and aborts the wallet operation;
 *     after the tab replies the same shape is the ACK the tab is blocking on.
 *  3. The ack is a COMMIT POINT and it is money-relevant. The tab records the
 *     received transaction only inside the success branch of its reply. A lost
 *     ack times out at 120 s and takes the rollback path, which saves only the
 *     key-derivation counter — so the receiver ends up with no record of a
 *     payment the sender may already be able to finalise and broadcast. Hence
 *     the rule this file is built around: ACK ONLY AFTER THE RESPONSE HAS
 *     ACTUALLY BEEN FLUSHED TO THE SENDER, and if it could not be, send an
 *     Error instead so the tab rolls back deliberately rather than by timeout.
 *
 * ─── Ownership, which the client does not implement at all ───────────────────
 * `Own URL` carries only the suffix, and a suffix is public — it IS the payee's
 * address. Read literally, any tab could claim any address. Upstream closes this
 * with a session cookie on the WebSocket handshake, visible only in its nginx
 * conf (the one location that forwards Cookie, allow-lists Set-Cookie and adds
 * Vary: Cookie). We do the same, and the consequences are stated in §10: losing
 * the cookie CHANGES THE USER'S RECEIVING ADDRESS, because the client's
 * `Own URL → false` path discards the suffix and mints a new one. The cookie
 * lifetime is therefore an address-lifetime policy, not a session detail.
 *
 * ─── 093 Transporter's two lessons, as they apply here ───────────────────────
 *  · "Partition capacity per writer; a per-victim cap is a DoS ON the victim."
 *    The victim here is a suffix, and anyone who knows an address can POST to
 *    it — so a tight per-suffix cap would let a stranger fill a payee's inbound
 *    slots and block real payments. The per-suffix cap below is therefore a
 *    backstop set generously, and the real partition is nginx's limit_req keyed
 *    on the sender's IP (zone accio_wallet) plus a shared bucket on the onion
 *    front, where no per-writer key exists to key on.
 *  · "Normalise the id at the route." See wallet_route.js — there is no Express
 *    here, so the rule lands as: the suffix is parsed and lowercased in exactly
 *    one place, and nothing downstream re-derives it.
 */

const ws = require('./ws');
const guard = require('./guard');
const { MintError } = require('./store');

// §6, mapped to what we return to the inbound sender. 401 and 403 are defined
// in the client's constant set but are never emitted by it; they are accepted
// here anyway, because a status set that silently drops two of its five values
// is a bug waiting for a future client version.
const CLIENT_STATUS_TO_HTTP = { 0: 200, 1: 401, 2: 403, 3: 404, 4: 415 };

// §6 again: the client answers `application/json` for an object payload and
// `text/plain` for anything else. Nothing else may reach a browser from here —
// the tab is ours, but the body it is relaying came off the network.
const RESPONSE_TYPES = new Set(['application/json', 'text/plain']);

// The only `API` value this client accepts; anything else makes it answer 404
// (§5). It is a constant, not a passthrough of the request path.
const FOREIGN_API = '/v2/foreign';

// A connection that keeps breaching its message-rate bucket is not a wallet.
// Well short of this, over-rate requests are answered with an Error rather than
// dropped, because silence costs the client a 120 s stall (§11.9).
const RATE_VIOLATIONS_BEFORE_CLOSE = 50;

class ListenHub {
	constructor(cfg, log, store, stats) {
		this.cfg = cfg;
		this.log = log;
		this.store = store;
		this.stats = stats;
		this.connections = new Set();
		this.bySession = new Map();      // sid → Set<conn>
		this.inFlight = 0;
		this.reading = 0;                // inbound bodies being buffered (S8)
		this.shuttingDown = false;

		// ⚠ R6. `state.owned` is a MIRROR of the store's table, and a mirror nobody
		// updates is a leak. The store removes suffixes on four paths we do not
		// call — the per-session evictor, the global evictor, an expiring session
		// and a load-time trim — and before this hook existed none of them reached
		// the sockets. `Create URL` in a loop therefore grew a per-socket Set at the
		// client's full message rate, forever: the TABLE stayed correctly capped at
		// 16 per session while the claim set beside it grew without any bound at
		// all, which is an OOM reachable by anyone who can complete a handshake.
		// One hook, so every current and future removal path is covered by
		// construction rather than by remembering.
		this.store.onForget = (suffix, sid) => this._forgetEverywhere(sid, suffix);

		this._sweepTimer = setInterval(() => {
			this.store.sweep();
			this.store.flush();
		}, cfg.state_sweep_ms);
		this._sweepTimer.unref?.();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Handshake
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * handleUpgrade(req, socket, head, front)
	 * `front` is 'nginx' or 'onion' — classified by the LISTENING PORT, never by
	 * a header, for the reason server.js gives at length: a Tor client writes
	 * its own headers and could otherwise mint a fresh identity per request.
	 */
	handleUpgrade(req, socket, head, front) {
		const cfg = this.cfg;
		if (this.shuttingDown) return refuse(socket, 503, 'shutting down');
		if (!cfg.listen_enabled) return refuse(socket, 404, 'the listen rail is disabled');

		// Exact path only. The client connects to `<host>/listen` with no query
		// and no trailing slash (§1); anything else reaching here means nginx is
		// routing more than the snippet should.
		const path = req.url.split('?')[0];
		if (path !== '/listen') return refuse(socket, 404, 'no such websocket endpoint');

		// A browser does not apply the same-origin policy to WebSockets, so this
		// check is the thing standing in for it. It is not the ownership control
		// — SameSite on the cookie is what stops a third-party page reaching a
		// live session — but it keeps a foreign page from opening sockets here.
		try {
			guard.checkOrigin(req.headers['origin'], cfg);
		} catch (err) {
			this.stats.listen_refused += 1;
			return refuse(socket, err.status || 403, err.message || 'origin not allowed');
		}

		if (this.connections.size >= cfg.max_sockets_total) {
			this.stats.listen_refused += 1;
			return refuse(socket, 503, 'too many open listeners');
		}

		// ── Session ──────────────────────────────────────────────────────────
		const presented = readCookie(req.headers['cookie'], cfg.session_cookie_name);
		let sid = null;
		let minted = false;
		if (presented && this.store.getSession(presented)) {
			sid = presented;
			this.store.touchSession(sid);
		} else {
			try {
				sid = this.store.createSession();
			} catch (err) {
				// The session table is full and every session in it owns a real
				// address (store.js). Refusing the handshake is the honest answer;
				// the client's retry ladder (§8) turns it into a delay, not a
				// failure, and an existing wallet with a cookie is unaffected
				// because it never reaches this branch.
				this.stats.listen_refused += 1;
				this.log.error(`/listen refused: ${err.message}`);
				return refuse(socket, 503, 'the gateway cannot take a new session right now');
			}
			minted = true;
		}

		// ── Per-session socket cap ───────────────────────────────────────────
		// Checked BEFORE the 101, because the only alternative — accept and then
		// evict something — is a trap. A socket the peer has closed stays on our
		// books until Node delivers the 'close' event, so a tab that reloads has,
		// for a moment, BOTH its old and its new socket counted. An evicting cap
		// then fires on a connection that is perfectly alive, and the victim is
		// whichever tab looks stalest — i.e. reload one tab and a DIFFERENT tab
		// gets disconnected, possibly mid-payment. (Written that way first, and
		// caught by this packet's own end-to-end run.)
		//
		// Refusing instead makes the same race harmless: the reloading tab may be
		// refused once and retries 250 ms later, by which time the corpse is
		// reaped. That is exactly what the client's retry ladder is for (§8), and
		// it can never disconnect a wallet that is in the middle of receiving.
		// The price is that a browser genuinely holding more than the cap gets one
		// handshake refused every 10 s — bounded, self-healing, and far cheaper
		// than dropping a live socket. Hence a generous cap rather than a tight one.
		const existing = this.bySession.get(sid);
		if (existing) {
			for (const c of existing) if (c.ws.closed) existing.delete(c);
			if (existing.size >= cfg.max_sockets_per_session) {
				this.stats.listen_refused += 1;
				return refuse(socket, 503, 'too many open listeners for this session');
			}
		}

		// The cookie is re-sent on EVERY handshake, not only when minted. That
		// is what makes the ttl rolling: a tab that reconnects keeps its address,
		// and a browser that dropped the cookie from disk gets it back before the
		// session itself expires.
		const extraHeaders = [
			`Set-Cookie: ${buildCookie(cfg, sid, front, req)}`,
			// Upstream sets both of these on /listen with nginx add_header. We
			// emit them here instead, by the rule S3 established: an add_header
			// anywhere inside a location block discards every add_header
			// inherited from the server block, which is how CSP and HSTS go
			// missing from exactly the routes that matter.
			'Cache-Control: no-store',
			'Vary: Cookie',
		];

		let conn;
		try {
			conn = ws.handshake(req, socket, head, {
				extraHeaders,
				maxMessageBytes: cfg.ws_max_message_bytes,
				pingIntervalMs: cfg.ws_ping_interval_ms,
				pongTimeoutMs: cfg.ws_pong_timeout_ms,
			});
		} catch (err) {
			this.stats.listen_refused += 1;
			return refuse(socket, err.status || 400, err.message, err.extraHeaders);
		}

		this._register(conn, sid, front, minted);
	}

	_register(wsConn, sid, front, minted) {
		const cfg = this.cfg;
		const now = Date.now();
		const state = {
			ws: wsConn,
			sid,
			front,
			opened: now,
			pending: new Map(),          // interaction id → pending inbound
			// ⚠ S8. The addresses THIS socket has claimed — minted on it, or
			// confirmed on it by `Own URL`. Delivery is routed by this set, not
			// by the session alone; see deliver().
			owned: new Set(),
			nextInteraction: 1,
			tokens: cfg.ws_message_burst,
			lastRefill: now,
			violations: 0,
		};

		// The cap itself was enforced before the handshake — see handleUpgrade.
		// Nothing here may ever close an existing connection.
		let set = this.bySession.get(sid);
		if (!set) { set = new Set(); this.bySession.set(sid, set); }
		set.add(state);
		this.connections.add(state);
		this.stats.listen_connections += 1;
		this.stats.listen_open = this.connections.size;
		// NOTE what is not logged: no suffix, no session id, no IP, no origin.
		// A suffix is a payee address and an interaction is a payment, so those
		// three must never meet in a log line (§11.11).
		this.log.info(`/listen open (${front}, ${minted ? 'new' : 'resumed'} session) — ${this.connections.size} live`);

		wsConn.on('message', (text) => this._onMessage(state, text));
		wsConn.on('close', () => this._onClose(state));
		wsConn.on('error', (err) => this.log.warn(`/listen socket error: ${err.message}`));
	}

	_onClose(state) {
		this.connections.delete(state);
		const set = this.bySession.get(state.sid);
		if (set) {
			set.delete(state);
			if (!set.size) this.bySession.delete(state.sid);
		}
		this.stats.listen_open = this.connections.size;
		// Every inbound request parked on this socket now has nobody to answer
		// it. Fail them explicitly rather than letting each burn its full
		// timeout: the sender learns the payee is gone, and the slot is freed.
		for (const pending of [...state.pending.values()]) {
			this._failPending(pending, 503, 'the payee wallet disconnected');
		}
		state.pending.clear();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Client → server
	// ─────────────────────────────────────────────────────────────────────────

	_onMessage(state, text) {
		let msg;
		try {
			msg = JSON.parse(text);
		} catch {
			// The client does exactly this to us in the other direction (§2):
			// anything that is not valid JSON is dropped without a reply. There
			// is no error channel on this protocol for a frame we cannot parse.
			return;
		}
		if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

		// The rate check runs AFTER the parse, not before, so that an over-rate
		// request can still be ANSWERED — §11.9's rule, which an earlier
		// return-before-parse quietly broke. Silence costs the client a 120 s
		// stall for a request it will never hear about; an Error is refused
		// immediately and its own retry brings it straight back. Parsing first is
		// affordable because the frame was already size-capped by ws.js, and the
		// error we send is 1:1 with the frame we refused, never an amplifier.
		if (!this._takeToken(state)) {
			if (typeof msg.Request === 'string' && typeof msg.Index === 'number'
				&& Number.isFinite(msg.Index)) {
				this._error(state, msg.Index, 'rate limit exceeded');
			}
			// An interaction response has no reply channel — nothing to send.
			return;
		}

		// Discrimination order matters and is fixed by the spec (§2). Only two
		// of the five message kinds travel in this direction.
		if (typeof msg.Request === 'string') return this._onRequest(state, msg);
		if (typeof msg.Interaction === 'number') return this._onInteractionResponse(state, msg);
		// Neither shape. Nothing to reply to — there is no Index to correlate.
	}

	_takeToken(state) {
		const cfg = this.cfg;
		const now = Date.now();
		// ⚠ R6, same clamp as server.js makeBucket(). `Date.now()` is not monotonic
		// and this box runs a time daemon: a BACKWARD step made the elapsed term
		// negative, and with only Math.min clamping the top the balance could go
		// arbitrarily far below zero. The socket would then be rate-limited into
		// silence long after the clock was right again — and at 50 violations it
		// closes, so a clock correction could disconnect every live wallet.
		const elapsed = Math.max(0, now - state.lastRefill);
		state.tokens = Math.min(
			cfg.ws_message_burst,
			Math.max(0, state.tokens) + (elapsed / 1000) * cfg.ws_message_rate_per_second,
		);
		state.lastRefill = now;
		if (state.tokens >= 1) { state.tokens -= 1; state.violations = 0; return true; }
		state.violations += 1;
		if (state.violations >= RATE_VIOLATIONS_BEFORE_CLOSE) {
			state.ws.close(ws.CLOSE.POLICY_VIOLATION, 'message rate exceeded');
		}
		return false;
	}

	_onRequest(state, msg) {
		const index = msg.Index;
		// Without a numeric Index there is nothing to correlate a reply to
		// (§4: a response is matched by Index alone and the request name is
		// never echoed), so there is no way to answer. Drop it.
		if (typeof index !== 'number' || !Number.isFinite(index)) return;

		// The sweep is time-based, not connection-based, so a session can expire
		// underneath a socket that is still open — and every request below needs
		// one. Touching it here is the fix for the common case: a tab that talks
		// to us is active by definition, and letting its session lapse would
		// change its receiving address while the user was watching it. If it has
		// already gone, close rather than answer: the client's retry ladder
		// reconnects within 250 ms and the handshake mints a fresh session and
		// cookie, which is the only way back to a state where anything it asks
		// for can be honoured.
		if (!this.store.getSession(state.sid)) {
			state.ws.close(ws.CLOSE.GOING_AWAY, 'session expired');
			return;
		}
		this.store.touchSession(state.sid);

		const url = msg.URL;
		switch (msg.Request) {
			case 'Create URL':
				return this._createUrl(state, index);
			case 'Change URL':
				return this._changeUrl(state, index, url);
			case 'Own URL':
				return this._ownUrl(state, index, url);
			case 'Delete URL':
				return this._deleteUrl(state, index, url);
			default:
				// §11.9 — answer rather than drop. Silence here costs the client
				// a 120 s stall for a request it will never get an answer to.
				return this._error(state, index, 'unknown request');
		}
	}

	_createUrl(state, index) {
		try {
			const suffix = this.store.mint(state.sid);
			state.owned.add(suffix);
			this.stats.suffixes_minted += 1;
			// §3: the success value is a STRING — the new suffix. A wrong-typed
			// Response is rejected client-side as a hard failure, so the type is
			// part of the contract, not a hint.
			this._respond(state, index, suffix);
		} catch (err) {
			if (err instanceof MintError) return this._error(state, index, err.message);
			this.log.error(`Create URL failed: ${err.stack || err.message}`);
			this._error(state, index, 'could not allocate an address');
		}
	}

	/**
	 * §3: "Change URL is a rotate, not a rename." The UI is a yes/no
	 * confirmation with no field for the user to propose a suffix; the client
	 * sends the suffix it currently holds and stores whatever string comes back.
	 */
	_changeUrl(state, index, url) {
		if (typeof url !== 'string') return this._error(state, index, 'URL must be a string');
		if (!this.store.owns(state.sid, url)) {
			// Ownership is checked on Change and Delete as well as on delivery
			// (§10): a stolen cookie is a denial-of-receipt, and these are the
			// two calls that would inflict it on someone else.
			return this._error(state, index, 'that address does not belong to this session');
		}
		let next;
		try {
			next = this.store.mint(state.sid);
		} catch (err) {
			// Mint FIRST, release second. If allocation fails the user keeps a
			// working address instead of ending up with none.
			return this._error(state, index, err instanceof MintError ? err.message : 'could not allocate an address');
		}
		this.store.release(state.sid, url);
		this._forgetEverywhere(state.sid, url);
		state.owned.add(next);
		this.stats.suffixes_minted += 1;
		this._respond(state, index, next);
	}

	_ownUrl(state, index, url) {
		if (typeof url !== 'string') return this._error(state, index, 'URL must be a string');
		const owned = this.store.owns(state.sid, url);
		// This is the call every client makes for every address it holds on
		// every reconnect (§10), so it is what makes the ownership set below
		// complete for a real wallet.
		if (owned) { this.store.markVerified(url); state.owned.add(url); }
		else state.owned.delete(url);
		// §3: the success value here is a BOOLEAN. A string would be rejected
		// client-side. And note what a `false` does: the wallet DISCARDS the
		// suffix and calls Create URL, i.e. the user's receiving address changes.
		this._respond(state, index, owned);
	}

	_deleteUrl(state, index, url) {
		if (typeof url !== 'string') return this._respond(state, index, false);
		const released = this.store.release(state.sid, url);
		if (released) this._forgetEverywhere(state.sid, url);
		// Always a well-formed response, never an Error and never silence
		// (§12): `deleteAddressSuffix` retries a REJECTED delete immediately and
		// recursively, so a connection-level failure here becomes a client-side
		// retry loop. A refusal is simply `false` — "not deleted", not an error.
		this._respond(state, index, released);
	}

	/**
	 * An address that has just been rotated away or deleted must stop being a
	 * delivery target on EVERY socket of the session, not only on the one that
	 * asked. Otherwise a second tab of the same session keeps claiming a suffix
	 * the store no longer knows, and deliver() would pick it for a lookup that
	 * has already 404-ed anyway — harmless today, and exactly the kind of stale
	 * claim that stops being harmless the moment a suffix is ever reissued.
	 *
	 * ⚠ R6. This is also the store's `onForget` target, wired in the constructor,
	 * so it now runs for EVERY removal — evictions and expiries included, not just
	 * the two calls below that name it directly. Those two are left in place as
	 * belt-and-braces on a money-relevant path; both are idempotent Set deletes.
	 */
	_forgetEverywhere(sid, suffix) {
		const set = this.bySession.get(sid);
		if (!set) return;
		for (const c of set) c.owned.delete(suffix);
	}

	// ─── Inbound admission (S8) ──────────────────────────────────────────────
	// max_inbound_in_flight used to be checked in deliver(), i.e. AFTER
	// wallet_route had buffered the whole body. It therefore capped relays and
	// not memory: N senders could each hold inbound_body_bytes (1 MB) in this
	// process before anything counted them. These two make the budget cover the
	// read as well, so the cap is a memory cap again.
	beginRead() {
		if (this.reading + this.inFlight >= this.cfg.max_inbound_in_flight) return false;
		this.reading += 1;
		return true;
	}

	endRead() {
		this.reading = Math.max(0, this.reading - 1);
	}

	/**
	 * ⚠ R7. Does this suffix exist at all?
	 *
	 * Asked by wallet_route BEFORE it reserves a read slot and starts buffering,
	 * so an address that has never existed costs the 404 and nothing else.
	 * deliver() has always answered 404 for an unowned address, but it only runs
	 * once the whole body is in memory — and parsePath admits any
	 * [A-Za-z0-9]{4,64}, so that 404 was being paid for at up to
	 * inbound_body_bytes of heap by anyone, with no address and no session.
	 *
	 * deliver() still does its own lookup and that is the authoritative one: the
	 * table can change while a body streams in, and only deliver()'s answer is
	 * money-relevant. This is a doorman, not a decision.
	 */
	knows(suffix) {
		return this.store.lookup(suffix) !== null;
	}

	_respond(state, index, value) {
		state.ws.send(JSON.stringify({ Index: index, Response: value }));
	}

	_error(state, index, message) {
		// §4: a response is invalid when it carries an Error key OR lacks a
		// Response key. The VALUE of Error is never read by the client, so there
		// is no error-code vocabulary to match — this string is for our journal
		// and for whoever is reading a packet capture.
		state.ws.send(JSON.stringify({ Index: index, Error: message }));
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Inbound delivery (called by wallet_route.js)
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * deliver({ suffix, body, res }) — relay one inbound Foreign-API POST to the
	 * tab that owns `suffix`, and answer `res` with whatever the tab says.
	 * Answers `res` itself on every path, including every failure.
	 */
	deliver({ suffix, body, res }) {
		const cfg = this.cfg;
		this.stats.inbound_requests += 1;

		const row = this.store.lookup(suffix);
		if (!row) {
			this.stats.inbound_unknown += 1;
			return sendJson(res, 404, { error: 'unknown address' });
		}

		const set = this.bySession.get(row.sid);
		const live = set ? [...set].filter((c) => !c.ws.closed) : [];
		if (!live.length) {
			// §11.5 was ours to decide. Upstream holds the request open for
			// `proxy_read_timeout 208w` — an unbounded resource hold any stranger
			// can take out for free, the same objection S3 raised on the /tor/
			// rail. We answer immediately instead: a self-custodial wallet that
			// is not open genuinely cannot receive, and telling the sender so
			// lets them retry when the payee is back.
			this.stats.inbound_offline += 1;
			return sendJson(res, 503, { error: 'the payee wallet is not connected' }, { 'retry-after': '30' });
		}

		// ⚠ S8 + R7, AND THIS IS THE MONEY-RELEVANT PART. Delivery is routed ONLY
		// to a socket that has CLAIMED this specific suffix — minted it here, or
		// confirmed it here with `Own URL`, which §10 says every client does for
		// every address on every reconnect.
		//
		// Routing by session alone made "newest socket in the session" the
		// receiver of every payment to every address that session owns. A cookie
		// is not proof of which ADDRESS a tab holds, only of which session it is
		// in — so anyone who obtained the cookie (a tossed cookie from a sibling
		// host, a stolen one) could open a socket, say nothing at all, and be
		// handed the next inbound slate for an address they never knew existed.
		// Their wallet then answers it with THEIR output: the payer pays, the
		// payee does not receive, and nothing in either UI looks wrong. An
		// attacker cannot claim what they cannot name, and a suffix is 80 bits.
		//
		// ⚠ R7 DELETED the "fall back to any live socket when nobody claims"
		// branch that used to stand here. It was written to cover the window
		// between a reconnect and that connection's first `Own URL` — but it did
		// not cover only that window. `claimants` is empty in EVERY case where
		// the legitimate tab is not connected, which for a browser wallet is the
		// ordinary state, so the cookie holder above never needed to win a race:
		// they only had to connect while the victim's tab was closed, and the
		// fallback handed them the slate. It restored, in full, the hole S8 was
		// written to close. Answering 503 costs a real client one retry inside a
		// sub-second window — the same 503 the branch above already gives every
		// payer whose payee is away, and their sender retries it.
		const claimants = live.filter((c) => c.owned.has(suffix));
		if (!claimants.length) {
			this.stats.inbound_unclaimed += 1;
			return sendJson(res, 503, { error: 'the payee wallet is not connected' }, { 'retry-after': '5' });
		}

		if (this.inFlight >= cfg.max_inbound_in_flight) {
			this.stats.inbound_busy += 1;
			return sendJson(res, 503, { error: 'gateway busy, retry shortly' }, { 'retry-after': '5' });
		}

		// The per-suffix backstop. Deliberately generous, for the 093 reason at
		// the top of this file: anyone who knows an address can POST to it, so a
		// tight cap here would be a DoS on the payee rather than on the attacker.
		let perSuffix = 0;
		for (const c of live) for (const p of c.pending.values()) if (p.suffix === suffix) perSuffix += 1;
		if (perSuffix >= cfg.max_inbound_per_suffix) {
			this.stats.inbound_busy += 1;
			return sendJson(res, 503, { error: 'too many requests in flight for this address' }, { 'retry-after': '5' });
		}

		// §11.10 was ours too: which socket owns delivery when several sockets of
		// one session have claimed the SAME suffix. The most recently opened one
		// — a user with two tabs is working in the one they just opened, and
		// broadcasting to all of them would ask several tabs to receive the same
		// payment.
		let conn = claimants[0];
		for (const c of claimants) if (c.opened > conn.opened) conn = c;

		// §5: `toFixed()` is called on this to build jQuery event namespaces, so
		// it MUST be a plain integer — 1.5 and 2 both render as "2" and would
		// cross-wire two live interactions. Wrap BEFORE taking the id, not after:
		// checking the value we have already handed out would use the unsafe one
		// exactly once and only then start again.
		if (!Number.isSafeInteger(conn.nextInteraction)) conn.nextInteraction = 1;
		const id = conn.nextInteraction++;

		const frame = JSON.stringify({
			Interaction: id,
			URL: suffix,
			API: FOREIGN_API,
			// ⚠ The bare string, NOT the sender's Content-Type header. The client
			// compares this for equality against "application/json" and answers
			// 415 for anything else (§5) — so passing through a perfectly ordinary
			// `application/json; charset=utf-8` would make every such payment fail
			// with a media-type error nobody could explain. wallet_route.js has
			// already verified the real header is JSON.
			Type: 'application/json',
			Data: body.toString('base64'),
		});

		if (Buffer.byteLength(frame) > cfg.ws_max_message_bytes) {
			// The tab could not receive this frame even if we sent it, and the
			// send would trip our own outbound cap. Say so with a status the
			// sender can act on.
			this.stats.inbound_too_large += 1;
			return sendJson(res, 413, { error: 'payload too large for the listen rail' });
		}

		const pending = {
			id, suffix, res, conn,
			answered: false,
			timer: null,
		};
		conn.pending.set(id, pending);
		this.inFlight += 1;
		this.stats.inbound_in_flight = this.inFlight;

		// §11.5: bounded, because unbounded is a resource hold. Generous, because
		// the tab may be waiting on a human to approve the receive.
		pending.timer = setTimeout(() => {
			this.stats.inbound_timeout += 1;
			this._cancel(pending, 'inbound request timed out');
			this._failPending(pending, 504, 'the payee wallet did not answer in time');
		}, cfg.inbound_timeout_ms);

		// The sender hung up before the tab answered. §7 documents exactly this
		// case as the natural use of the cancel role: a status carrying Error,
		// sent BEFORE the tab replies, aborts the in-progress wallet operation.
		// Without it the tab would go on to build and sign a response for a
		// connection that no longer exists.
		res.once('close', () => {
			if (pending.answered) return;
			this.stats.inbound_abandoned += 1;
			this._cancel(pending, 'inbound client disconnected');
			this._settle(pending);
		});

		if (!conn.ws.send(frame)) {
			this._failPending(pending, 503, 'the payee wallet disconnected');
		}
	}

	/**
	 * The CANCEL role of the status message (§7) — only meaningful before the
	 * tab has replied. Anything that is not the string "Succeeded" cancels, and
	 * an Error key is the unambiguous form of that.
	 */
	_cancel(pending, why) {
		if (pending.conn.ws.closed) return;
		pending.conn.ws.send(JSON.stringify({ Interaction: pending.id, Error: why }));
	}

	/** Remove a pending interaction from the books exactly once. */
	_settle(pending) {
		if (pending.settled) return;
		pending.settled = true;
		clearTimeout(pending.timer);
		pending.conn.pending.delete(pending.id);
		this.inFlight = Math.max(0, this.inFlight - 1);
		this.stats.inbound_in_flight = this.inFlight;
	}

	_failPending(pending, status, message) {
		if (pending.answered) { this._settle(pending); return; }
		pending.answered = true;
		this._settle(pending);
		sendJson(pending.res, status, { error: message });
	}

	_onInteractionResponse(state, msg) {
		const pending = state.pending.get(msg.Interaction);
		// No pending interaction under that id: the inbound request already gave
		// up, or this is a duplicate. There is nothing to answer and nothing to
		// ack — the tab's own 120 s timeout will roll it back.
		if (!pending || pending.answered) return;

		const status = CLIENT_STATUS_TO_HTTP[msg.Status];
		if (typeof msg.Status !== 'number' || status === undefined
			|| typeof msg.Type !== 'string' || typeof msg.Data !== 'string') {
			// Malformed. NACK rather than ack: the tab must NOT record this as a
			// received transaction, because we are about to tell the sender it
			// failed and the sender will not finalise.
			this._nack(pending, 'malformed interaction response');
			this._failPending(pending, 502, 'the payee wallet sent a malformed response');
			return;
		}

		let body;
		try {
			// Standard padded base64 of the UTF-8 bytes (§6); Node's decoder also
			// accepts the URL-safe alphabet, which costs nothing and matches what
			// the client's own decoder does in the other direction.
			body = Buffer.from(msg.Data, 'base64');
		} catch {
			this._nack(pending, 'undecodable interaction response');
			this._failPending(pending, 502, 'the payee wallet sent an undecodable response');
			return;
		}

		const type = RESPONSE_TYPES.has(msg.Type) ? msg.Type : 'text/plain';

		pending.answered = true;
		this._settle(pending);
		this.stats.inbound_delivered += 1;

		// ⚠ R7. The session ttl IS the address lifetime (store.js), and it was
		// refreshed only by a handshake or by a client Request — never by the one
		// activity that matters most. A tab held open across the ttl without
		// asking us for anything therefore had its session swept out from under a
		// LIVE socket, taking its suffixes with it: inbound payments start
		// answering 404 while the tab goes on displaying the old address, and
		// nothing tells the user until they happen to reconnect. A payment this
		// wallet has just ACCEPTED is the strongest evidence an address is in use,
		// so it counts as activity. Note it is the accepted response that counts,
		// not the arriving request — otherwise any stranger who knows an address
		// could hold its session open forever.
		this.store.touchSession(state.sid);
		this.store.touchSuffix(pending.suffix);

		// ⚠ The ordering below is the money-relevant part (§7). The response goes
		// to the sender FIRST; the ack goes to the tab only once the bytes have
		// actually been flushed. Acking first would let a failed write leave the
		// tab recording a payment that never reached the sender.
		//
		// Note also: a REJECTED payment is still HTTP 200. `respondWithError`
		// only leaves the 200 when the payload is a bare number, so a JSON-RPC
		// error object (user declined, invalid params) arrives here as Status 0
		// with an error body. That is correct JSON-RPC and we must not
		// "helpfully" translate it into a 4xx.
		writeAndFlush(pending.res, status, type, body,
			() => this._ack(pending),
			() => this._nack(pending, 'response could not be delivered to the sender'));
	}

	/**
	 * The ACK role (§7). "Succeeded" is the only value to send: in the ack
	 * window the client resolves on ANY string Status and only compares it to
	 * "Succeeded" to compute a boolean its caller then ignores — so
	 * {"Status":"Nope"} would commit the transaction exactly as a success does.
	 * Send "Succeeded", or send Error. Nothing else.
	 */
	_ack(pending) {
		if (pending.conn.ws.closed) return;
		pending.conn.ws.send(JSON.stringify({ Interaction: pending.id, Status: 'Succeeded' }));
	}

	_nack(pending, why) {
		if (pending.conn.ws.closed) return;
		pending.conn.ws.send(JSON.stringify({ Interaction: pending.id, Error: why }));
	}

	// ─────────────────────────────────────────────────────────────────────────

	shutdown() {
		this.shuttingDown = true;
		clearInterval(this._sweepTimer);
		for (const state of [...this.connections]) {
			state.ws.close(ws.CLOSE.GOING_AWAY, 'gateway restarting');
		}
		// The snapshot is what stops a restart from changing every user's
		// receiving address, so it is flushed on the way out and not left to the
		// debounce timer.
		this.store.flush();
	}
}

// ─── Small helpers ───────────────────────────────────────────────────────────

/** Refuse an upgrade with a plain HTTP response on the raw socket. */
function refuse(socket, status, message, extraHeaders) {
	// ⚠ R7. Coerced, never trusted to be a string. This is called from
	// handleUpgrade's catch blocks with whatever `err.message` happens to be, and
	// one of those calls passes it through unguarded — an error carrying no
	// message made `message.replace` raise a TypeError, which propagated out of
	// the 'upgrade' event handler. That is uncaught: the whole gateway down, and
	// every other wallet's live socket with it, because one handshake failed in
	// an unanticipated way. server.js now wraps the call as well; this is the
	// other half of the same fix.
	const text = String(message == null ? '' : message);
	const body = `${status} ${text}\n`;
	const lines = [
		`HTTP/1.1 ${status} ${text.replace(/[\r\n]/g, ' ')}`,
		'Content-Type: text/plain; charset=utf-8',
		`Content-Length: ${Buffer.byteLength(body)}`,
		'Cache-Control: no-store',
		'Connection: close',
	];
	for (const line of (extraHeaders || [])) lines.push(line);
	try {
		socket.write(lines.join('\r\n') + '\r\n\r\n' + body);
	} catch { /* the peer is already gone */ }
	socket.destroy();
}

function readCookie(header, name) {
	if (typeof header !== 'string' || !header) return null;
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() !== name) continue;
		const value = part.slice(eq + 1).trim();
		// Our own ids are base64url of 32 bytes. Anything else is not ours, and
		// refusing to look it up keeps arbitrary bytes out of the store's keys.
		return /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
	}
	return null;
}

function buildCookie(cfg, sid, front, req) {
	const parts = [
		`${cfg.session_cookie_name}=${sid}`,
		// Scoped to the one route that uses it. The inbound /wallet/ route is
		// deliberately credential-free — it is a public payment inbox — and a
		// cookie the browser never sends there cannot be reflected by it.
		'Path=/listen',
		'HttpOnly',
		// The page JS never reads this cookie (its only document.cookie write is
		// the language cookie), so SameSite is free to be strict-ish. Lax is what
		// stops a third-party page from opening a WebSocket that carries a live
		// session — the actual hijack path, since browsers do not apply the
		// same-origin policy to WebSockets.
		'SameSite=Lax',
		`Max-Age=${cfg.session_ttl_days * 24 * 60 * 60}`,
	];
	if (cookieSecure(cfg, front, req)) parts.push('Secure');
	return parts.join('; ');
}

/**
 * `Secure` is not a constant here, and that is not laziness.
 *  · The onion front is http://<onion> — an origin most browsers do not treat
 *    as secure — so a Secure cookie would simply never be stored, and the user
 *    would get a new receiving address on every reconnect.
 *  · Between S2's first vhost reload and certbot finishing, the clearnet front
 *    is http:// too, with the same effect.
 * Hence the "auto" default: trust X-Forwarded-Proto, but ONLY on the nginx
 * front, where nginx sets it and a client cannot. On the onion front the header
 * is ignored outright, exactly as the forwarding headers are on /tor/.
 */
function cookieSecure(cfg, front, req) {
	if (front !== 'nginx') return false;
	if (cfg.session_cookie_secure === true) return true;
	if (cfg.session_cookie_secure === false) return false;
	return String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

function corsHeaders() {
	// The inbound rail is a public payment inbox reached cross-origin by another
	// wallet's tab, so the sender's JS has to be able to READ the answer. `*` is
	// correct rather than lax: there is no credential on this route to protect —
	// the session cookie is scoped to /listen — and `*` is precisely what forbids
	// a browser from attaching credentials to the request in the first place.
	return {
		'access-control-allow-origin': '*',
		'access-control-allow-methods': 'POST, OPTIONS',
		'access-control-allow-headers': 'Content-Type',
	};
}

function sendJson(res, status, obj, extra) {
	if (res.writableEnded || res.headersSent) return;
	const body = JSON.stringify(obj) + '\n';
	res.writeHead(status, Object.assign({
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body),
		'cache-control': 'no-store, no-transform',
	}, corsHeaders(), extra || {}));
	res.end(body);
}

/**
 * Write the tab's answer to the sender and call back only once the bytes have
 * left this process. `finish` is as close to delivery as a server can observe;
 * `close` before `writableFinished` is the failure we must not mistake for one.
 */
function writeAndFlush(res, status, contentType, body, onFlushed, onFailed) {
	let done = false;
	const ok = () => { if (!done) { done = true; onFlushed(); } };
	const failed = () => { if (!done) { done = true; onFailed(); } };

	if (res.writableEnded || res.headersSent) { failed(); return; }

	res.once('finish', ok);
	res.once('error', failed);
	res.once('close', () => { if (res.writableFinished) ok(); else failed(); });

	try {
		res.writeHead(status, Object.assign({
			'content-type': contentType,
			'content-length': body.length,
			'cache-control': 'no-store, no-transform',
		}, corsHeaders()));
		res.end(body);
	} catch {
		failed();
	}
}

module.exports = {
	ListenHub,
	// exported for the offline assertions
	readCookie, buildCookie, cookieSecure, sendJson, corsHeaders, refuse,
	CLIENT_STATUS_TO_HTTP, RESPONSE_TYPES, FOREIGN_API,
};
