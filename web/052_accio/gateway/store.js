'use strict';
/**
 * store.js — the suffix ↔ session table (packet S4b).
 *
 * Two tables and nothing else:
 *
 *   sessions[sid]      { created, seen }
 *   suffixes[suffix]   { sid, created, seen, verified }
 *
 * A "suffix" is the bearer name in a wallet's receiving address —
 * `https://<host>/wallet/<suffix>/v2/foreign` (design §9). A "session" is the
 * opaque id in the HttpOnly cookie set on the /listen handshake, and it is the
 * ONLY thing that proves ownership of a suffix, because the client proves
 * ownership with nothing at all: `Own URL` carries the suffix, which is public
 * — it IS the payee's address (design §10).
 *
 * ─── Why this is durable, and why that is not optional ───────────────────────
 * Keeping this in memory would be one line shorter and would ROTATE EVERY
 * USER'S RECEIVING ADDRESS ON EVERY RESTART. The mechanism is in the client:
 * on each reconnect it asks `Own URL` for every suffix it holds, and a `false`
 * makes it discard that suffix and mint a new one (design §10). So a routine
 * `systemctl restart` — a deploy, a config change, an OOM — would silently
 * change the address of every wallet that had ever connected, while any payment
 * already in flight to the old address answers 404. Durability here is a
 * correctness property, not a nicety.
 *
 * ─── Why a JSON snapshot and not SQLite ──────────────────────────────────────
 * 093 Transporter's patterns are Node + SQLite and this packet is told to reuse
 * them, but SQLite needs either an npm package (the gateway has zero
 * dependencies, and socks5.js/ws.js explain why that is a rule) or `node:sqlite`,
 * which needs Node 22.5+ and is still flagged experimental while our floor is
 * Node 18. What 093 actually contributes is its two hard-won lessons, and both
 * are honoured: capacity is partitioned per writer rather than per victim (see
 * listen_route.js), and the wallet id is normalised at the route rather than in
 * a middleware layer (see wallet_route.js).
 *
 * The shape here is one small row per wallet, no queries, no joins, no ordering
 * — a table that fits in memory by construction. A snapshot written by atomic
 * rename is the honest match for that, and it keeps the gateway dependency-free.
 * If this ever grows a second index or a range query, that is the signal to
 * revisit, not before.
 *
 * ─── What is deliberately NOT in here ────────────────────────────────────────
 * No IP addresses, no user agents, no per-payment records. A suffix is a payee
 * address; joining it to an IP and a timestamp would build the payment graph
 * Grin exists in order not to have (design §11.11). The timestamps that ARE
 * stored are coarse liveness marks with no counterparty attached.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_VERSION = 1;

// Lowercase only, and that is load-bearing rather than tidy: inbound lookup
// lowercases the suffix while the wallet stores what it was given VERBATIM
// (design §9). A single uppercase character therefore indexes the wallet under
// a key the lookup can never produce — the address displays fine, the sender
// delivers fine, and every inbound payment is answered 404 with nothing in the
// UI to explain it. nginx's [a-zA-Z0-9]+ is the ceiling, not the target.
//
// RFC 4648 base32, lowercased — exactly 32 symbols, so a byte masked to 5 bits
// selects one with NO modulo bias (a 31- or 36-symbol alphabet would quietly
// favour its first few characters). It is also the alphabet a v3 onion address
// already uses, so a Grin user has seen this shape before.
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';   // exactly 32

const SUFFIX_RE = /^[a-z0-9]{4,64}$/;

class Store {
	constructor(cfg, log) {
		this.cfg = cfg;
		this.log = log;
		this.sessions = new Map();
		this.suffixes = new Map();
		this.bySession = new Map();     // sid → Set<suffix>

		this.file = cfg.state_dir ? path.join(cfg.state_dir, 'listen-state.json') : '';
		this.durable = Boolean(this.file);
		this._saveTimer = null;
		this._dirty = false;
		this.asideFiles = 0;

		// ⚠ R6. Set by ListenHub to `_forgetEverywhere`. Every path that removes a
		// suffix from this table calls it, because a socket keeps its own claim set
		// (`state.owned`) and nothing else tells that set the row is gone. Before
		// this hook existed, an eviction left the claim behind forever: `Create URL`
		// in a loop grew a per-socket Set at the client's message rate, bounded by
		// nothing, while the table itself stayed correctly capped at 16 per session.
		// The table was never the leak — the mirror of it was.
		this.onForget = null;

		if (this.durable) {
			this._load();
		} else {
			// Loud, because the symptom is invisible until the first restart and
			// then looks like a wallet bug rather than a config one.
			log.warn('state_dir is not set — the suffix table is IN MEMORY ONLY.');
			log.warn('Every restart will change the receiving address of every wallet.');
		}
		this.ttlMs = cfg.session_ttl_days * 24 * 60 * 60 * 1000;
	}

	// ─── Persistence ─────────────────────────────────────────────────────────

	_load() {
		this.asideFiles = this._countAside();
		let raw;
		try {
			raw = fs.readFileSync(this.file, 'utf8');
		} catch (err) {
			// ENOENT is the first run and the only benign case.
			if (err.code === 'ENOENT') return;
			// ⚠ R6. EVERY OTHER READ ERROR IS FATAL, and this is the one branch in
			// this file that used to log and carry on. Carrying on means starting
			// empty, and starting empty means the next flush RENAMES OVER a snapshot
			// full of live receiving addresses — rename takes its permission from the
			// directory, which we own, not from the file we just failed to read. So a
			// listen-state.json left root:root by a restore (EACCES) silently
			// destroyed every address in it, two seconds after boot.
			//
			// The corrupt-JSON and wrong-version branches below both move the file
			// aside before starting empty, for exactly this reason. This branch
			// cannot: it does not know the file is expendable. Refuse to start, the
			// way loadConfig() refuses a config it cannot read — a gateway that is up
			// and empty is worse than one that is down and saying why.
			throw new Error(
				`cannot read ${this.file}: ${err.message}\n`
				+ '       Refusing to start rather than overwrite the address table.\n'
				+ `       Check owner and mode: it must be readable by the service user.`,
			);
		}
		let data;
		try {
			data = JSON.parse(raw);
		} catch (err) {
			// Move it aside rather than deleting it. Every row in here is a
			// live receiving address; if this ever fires, an operator needs the
			// file intact far more than we need a tidy directory.
			const aside = `${this.file}.corrupt-${Date.now()}`;
			try { fs.renameSync(this.file, aside); this.asideFiles += 1; } catch { /* best effort */ }
			this.log.error(`${this.file} is not valid JSON (${err.message})`);
			this.log.error(`moved to ${aside}; starting empty — every wallet will get a new address`);
			return;
		}
		if (!data || data.version !== SNAPSHOT_VERSION) {
			// Moved aside for the same reason a corrupt file is: starting empty
			// means the very next flush OVERWRITES a snapshot full of live
			// receiving addresses, so a version bump would destroy the one file a
			// downgrade or a migration script would need.
			const aside = `${this.file}.v${data && data.version}-${Date.now()}`;
			try { fs.renameSync(this.file, aside); this.asideFiles += 1; } catch { /* best effort */ }
			this.log.warn(`${this.file} has version ${data && data.version} (expected ${SNAPSHOT_VERSION})`);
			this.log.warn(`moved to ${aside}; starting empty — every wallet will get a new address`);
			return;
		}
		for (const [sid, row] of Object.entries(data.sessions || {})) {
			if (typeof sid === 'string' && row && typeof row.created === 'number') {
				this.sessions.set(sid, { created: row.created, seen: row.seen || row.created });
			}
		}
		for (const [suffix, row] of Object.entries(data.suffixes || {})) {
			// A suffix whose session did not survive is dropped here rather than
			// kept as an orphan: without a session nothing can ever own it, so
			// it would answer `Own URL` false forever while occupying the name.
			if (!SUFFIX_RE.test(suffix) || !row || !this.sessions.has(row.sid)) continue;
			this.suffixes.set(suffix, {
				sid: row.sid,
				created: row.created || Date.now(),
				seen: row.seen || row.created || Date.now(),
				verified: Boolean(row.verified),
			});
			this._index(row.sid).add(suffix);
		}
		this._truncateToCaps();
		this.log.info(`state loaded: ${this.sessions.size} sessions, ${this.suffixes.size} addresses`);
		if (this.asideFiles) {
			// Surfaced rather than left in the directory for someone to find: each
			// one holds live receiving addresses from a table we could not use.
			this.log.warn(`${this.asideFiles} set-aside snapshot(s) in ${this.cfg.state_dir} — review and remove them`);
		}
	}

	/**
	 * ⚠ R6. A snapshot written under a looser config is not a licence to exceed
	 * the current one. Before this, `max_suffixes_total` and `max_sessions` were
	 * enforced on every mint and on nothing else, so lowering either one left the
	 * cap un-applied until the table happened to be touched — i.e. the limit an
	 * operator had just tightened was not in force at the moment they restarted to
	 * apply it. Trimmed by the same rule the evictors use: unverified first.
	 */
	_truncateToCaps() {
		let trimmed = 0;
		while (this.suffixes.size > this.cfg.max_suffixes_total && this._evictGlobalOldestUnverified()) trimmed += 1;
		while (this.sessions.size > this.cfg.max_sessions && this._evictOldestEmptySession()) trimmed += 1;
		if (trimmed) {
			this.log.warn(`trimmed ${trimmed} row(s) on load — the snapshot exceeded the configured caps`);
			this._schedule();
		}
	}

	/** Count the .corrupt-* / .v*-* snapshots we have set aside, for counts(). */
	_countAside() {
		try {
			const base = path.basename(this.file);
			return fs.readdirSync(this.cfg.state_dir)
				.filter((n) => n.startsWith(`${base}.corrupt-`) || n.startsWith(`${base}.v`))
				.length;
		} catch {
			return 0;   // an unreadable dir is the caller's problem, not this counter's
		}
	}

	_index(sid) {
		let set = this.bySession.get(sid);
		if (!set) { set = new Set(); this.bySession.set(sid, set); }
		return set;
	}

	/**
	 * Debounced write. Coalescing matters: a reconnect storm touches `seen` on
	 * every row a client holds, and rewriting the snapshot per touch would turn
	 * a reconnect into a disk-bound event.
	 */
	_schedule() {
		if (!this.durable) return;
		this._dirty = true;
		if (this._saveTimer) return;
		this._saveTimer = setTimeout(() => {
			this._saveTimer = null;
			this.flush();
		}, this._flushDelay());
		this._saveTimer.unref?.();
	}

	/**
	 * ⚠ R6. The debounce bounds how OFTEN we write, and nothing bounded how MUCH.
	 * flush() re-serialises the whole table, so at `max_suffixes_total` (100k rows,
	 * ~10 MB) a steady trickle of mints meant ~10 MB every 2 s — several MB/s of
	 * sustained writes on a box shared with the node, the pool and Fidelius, plus
	 * the flash wear. Scaling the delay with the table keeps the write RATE roughly
	 * flat instead of growing linearly with how successful the gateway has been.
	 * The cost is bounded and stated: at most this many seconds of `seen` marks and
	 * fresh addresses lost to a hard kill, which the S9 note on durability accepts.
	 */
	_flushDelay() {
		const scale = 1 + Math.floor(this.suffixes.size / 10000);
		return this.cfg.state_flush_ms * scale;
	}

	/** flush() — atomic, and safe to call at any time (SIGTERM does). */
	flush() {
		if (!this.durable || !this._dirty) return;
		// ⚠ S8. Only sessions that OWN an address are persisted. A session is
		// minted by any completed handshake, before the client has asked for
		// anything, so persisting them all let a handshake flood rewrite an
		// ever-growing snapshot every two seconds. An empty session has nothing
		// to restore: losing it costs its holder a new cookie and no address.
		const sessions = {};
		for (const [sid, row] of this.sessions) {
			const set = this.bySession.get(sid);
			if (set && set.size) sessions[sid] = row;
		}
		const snapshot = {
			version: SNAPSHOT_VERSION,
			written: new Date().toISOString(),
			sessions,
			suffixes: Object.fromEntries(this.suffixes),
		};
		const tmp = `${this.file}.tmp`;
		try {
			// Write-then-rename, so a crash mid-write leaves the previous
			// snapshot whole. A truncated snapshot here means new addresses for
			// everyone, which is exactly what durability is supposed to prevent.
			//
			// ⚠ R6. fsync BEFORE the rename, and the directory after it. Without the
			// first, a power loss can land the rename while the data behind it is
			// still in page cache — the classic result is a zero-length file, i.e.
			// precisely the total loss the atomic rename was chosen to prevent.
			// Without the second, the rename itself can be lost. This runs at most
			// once per _flushDelay(), so the cost is nothing next to what it buys.
			const fd = fs.openSync(tmp, 'w', 0o600);
			try {
				fs.writeFileSync(fd, JSON.stringify(snapshot));
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			fs.renameSync(tmp, this.file);
			try {
				const dfd = fs.openSync(this.cfg.state_dir, 'r');
				try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
			} catch { /* not every filesystem lets you fsync a directory */ }
			this._dirty = false;
		} catch (err) {
			this.log.error(`could not write ${this.file}: ${err.message}`);
			try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
		}
	}

	// ─── Sessions ────────────────────────────────────────────────────────────

	/**
	 * Sessions expire on a ROLLING ttl, refreshed by every handshake. That
	 * choice is not an implementation detail: because a client that fails
	 * `Own URL` discards its suffix and mints a new one, the session lifetime IS
	 * the address lifetime. A tab that connects at least once inside the window
	 * keeps its address indefinitely; one that goes quiet for the whole window
	 * comes back with a new one.
	 */
	getSession(sid) {
		if (typeof sid !== 'string' || !sid) return null;
		const row = this.sessions.get(sid);
		if (!row) return null;
		if (Date.now() - row.seen > this.ttlMs) {
			this.dropSession(sid);
			return null;
		}
		return row;
	}

	touchSession(sid) {
		const row = this.sessions.get(sid);
		if (!row) return;
		row.seen = Date.now();
		// Only a session that owns an address is in the snapshot, so only that
		// one has anything to re-write. See flush().
		if (this._owns(sid)) this._schedule();
	}

	/** Does this session own at least one address? Decides what is persisted. */
	_owns(sid) {
		const set = this.bySession.get(sid);
		return Boolean(set && set.size);
	}

	/**
	 * createSession() → sid, or throws MintError when the table is full.
	 *
	 * ⚠ S8. A session is minted by ANY completed /listen handshake, before the
	 * client has asked for an address, so this is a table a stranger can grow
	 * for the price of a WebSocket. It is bounded three ways now: empty sessions
	 * are never persisted (flush), are swept on a short ttl (sweep), and are the
	 * first thing evicted here. Only when every session in the table owns a real
	 * address do we refuse — and that refusal is a 503 on the handshake, which
	 * the client's retry ladder already knows how to survive.
	 */
	createSession() {
		if (this.sessions.size >= this.cfg.max_sessions) {
			this.sweep();
			if (this.sessions.size >= this.cfg.max_sessions && !this._evictOldestEmptySession()) {
				this.log.error(`session table is full (${this.sessions.size}) and every session owns an address`);
				throw new MintError('the gateway session table is full');
			}
		}
		// 256 bits from the CSPRNG. There is no HMAC and no signature around it
		// on purpose: the value is looked up in a server-side table, so a forged
		// cookie has to GUESS an entry rather than construct one, and a MAC
		// would add a key to a service whose whole design claim is that it holds
		// no secrets.
		const sid = crypto.randomBytes(32).toString('base64url');
		const now = Date.now();
		this.sessions.set(sid, { created: now, seen: now });
		// No _schedule() — an empty session is not persisted, so nothing on disk
		// is stale until it owns its first address (mint() schedules that).
		return sid;
	}

	_evictOldestEmptySession() {
		let oldest = null;
		let oldestAt = Infinity;
		for (const [sid, row] of this.sessions) {
			if (this._owns(sid)) continue;
			if (row.seen < oldestAt) { oldestAt = row.seen; oldest = sid; }
		}
		if (!oldest) return false;
		this.sessions.delete(oldest);
		this.bySession.delete(oldest);
		return true;
	}

	dropSession(sid) {
		const set = this.bySession.get(sid);
		if (set) {
			for (const suffix of set) {
				this.suffixes.delete(suffix);
				this._forget(suffix, sid);
			}
		}
		this.bySession.delete(sid);
		this.sessions.delete(sid);
		this._schedule();
	}

	/**
	 * Tell whoever mirrors this table that a suffix is gone. Wrapped, because the
	 * listener is another module's method and a throw here would abandon a
	 * half-finished mutation — the table's consistency must not depend on the
	 * mirror's correctness.
	 */
	_forget(suffix, sid) {
		if (!this.onForget) return;
		try {
			this.onForget(suffix, sid);
		} catch (err) {
			// No suffix and no sid in the line: a suffix is a payee address (§11.11).
			this.log.error(`onForget hook threw: ${err.message}`);
		}
	}

	// ─── Suffixes ────────────────────────────────────────────────────────────

	lookup(suffix) { return this.suffixes.get(suffix) || null; }

	owns(sid, suffix) {
		const row = this.suffixes.get(suffix);
		return Boolean(row && row.sid === sid);
	}

	/**
	 * Marks a suffix as confirmed-in-use. Only `Own URL` sets this, which is the
	 * one signal the protocol gives us that a client actually kept a suffix we
	 * minted — a `Create URL` we answered on a socket the client did not survive
	 * is re-asked on the next connection, leaving the first suffix orphaned
	 * (design §8). `verified` is what makes those orphans collectable without a
	 * timer having to guess.
	 */
	markVerified(suffix) {
		const row = this.suffixes.get(suffix);
		if (!row) return;
		row.verified = true;
		row.seen = Date.now();
		this._schedule();
	}

	touchSuffix(suffix) {
		const row = this.suffixes.get(suffix);
		if (!row) return;
		row.seen = Date.now();
		this._schedule();
	}

	/**
	 * mint(sid) → suffix, or throws MintError.
	 *
	 * Quotas, in order of what they protect:
	 *  · per session — a browser holds several wallets, so this is not 1. When
	 *    it is reached we evict the oldest UNVERIFIED suffix, which reclaims
	 *    exactly the orphans described above and nothing a client is using. If
	 *    every suffix is verified the session genuinely is full and we refuse.
	 *  · global — bounds the snapshot and the memory, and is the only limit that
	 *    still applies to an attacker who is happy to take a new cookie each time.
	 */
	mint(sid) {
		const cfg = this.cfg;

		// A session that no longer exists cannot own anything, and minting under
		// one produces a row that WORKS until the next restart and then vanishes:
		// _load() drops any suffix whose session did not survive, so the wallet
		// would display a perfectly good address that starts answering 404 after a
		// deploy. The window is real — the sweep is time-based, not
		// connection-based, so a session can expire underneath a socket that is
		// still open. Refuse; listen_route.js turns this into a reconnect, which
		// mints a fresh session and cookie.
		if (!this.sessions.has(sid)) {
			throw new MintError('session expired');
		}

		const set = this._index(sid);

		if (set.size >= cfg.max_suffixes_per_session) {
			if (!this._evictOldestUnverified(sid)) {
				throw new MintError('address quota for this session is full');
			}
		}
		if (this.suffixes.size >= cfg.max_suffixes_total) {
			this.sweep();
			// A partial relief, not a defence: evict the oldest address in the
			// WHOLE table that no client has ever confirmed holding. Those are
			// the `Create URL` answers that never reached a surviving client
			// (design §8) plus whatever a flooder minted and walked away from.
			// It cannot stop a determined attacker — they can verify their own
			// addresses — so if this ever fires in anger the real lever is the
			// nginx rate zones, and the operator has to be told. Hence the log.
			while (this.suffixes.size >= cfg.max_suffixes_total && this._evictGlobalOldestUnverified()) { /* reclaim */ }
			if (this.suffixes.size >= cfg.max_suffixes_total) {
				this.log.error(`address table is FULL (${this.suffixes.size}) — no wallet can be given a new receiving address`);
				this.log.error('every address in it has been confirmed in use; raise max_suffixes_total or tighten the nginx rate zones');
				throw new MintError('the gateway address table is full');
			}
		}

		const suffix = this._randomSuffix();
		const now = Date.now();
		this.suffixes.set(suffix, { sid, created: now, seen: now, verified: false });
		set.add(suffix);
		this._schedule();
		return suffix;
	}

	release(sid, suffix) {
		const row = this.suffixes.get(suffix);
		if (!row || row.sid !== sid) return false;
		this.suffixes.delete(suffix);
		const set = this.bySession.get(sid);
		if (set) set.delete(suffix);
		this._forget(suffix, sid);
		this._schedule();
		return true;
	}

	_evictOldestUnverified(sid) {
		const set = this.bySession.get(sid);
		if (!set) return false;
		let oldest = null;
		let oldestAt = Infinity;
		for (const suffix of set) {
			const row = this.suffixes.get(suffix);
			if (!row || row.verified) continue;
			if (row.created < oldestAt) { oldestAt = row.created; oldest = suffix; }
		}
		if (!oldest) return false;
		this.suffixes.delete(oldest);
		set.delete(oldest);
		this._forget(oldest, sid);
		return true;
	}

	/** The same rule as _evictOldestUnverified, applied across every session. */
	_evictGlobalOldestUnverified() {
		let oldest = null;
		let oldestAt = Infinity;
		for (const [suffix, row] of this.suffixes) {
			if (row.verified) continue;
			if (row.created < oldestAt) { oldestAt = row.created; oldest = suffix; }
		}
		if (!oldest) return false;
		const row = this.suffixes.get(oldest);
		this.suffixes.delete(oldest);
		const set = this.bySession.get(row.sid);
		if (set) set.delete(oldest);
		this._forget(oldest, row.sid);
		return true;
	}

	_randomSuffix() {
		const len = this.cfg.suffix_length;
		for (let attempt = 0; attempt < 8; attempt++) {
			const bytes = crypto.randomBytes(len);
			let out = '';
			// 32 symbols, 5 bits per character: masking is unbiased here, which
			// a modulo over a non-power-of-two alphabet would not be.
			for (let i = 0; i < len; i++) out += SUFFIX_ALPHABET[bytes[i] & 0x1f];
			if (!this.suffixes.has(out)) return out;
		}
		// At the configured default (16 chars over 32 symbols = 80 bits) eight
		// collisions in a row is not something that happens; if it ever does,
		// the table is not the problem and we should say so rather than loop.
		throw new MintError('could not allocate a unique address');
	}

	// ─── Garbage collection ──────────────────────────────────────────────────

	/**
	 * Expired sessions take their suffixes with them. There is no separate
	 * suffix ttl, and that is deliberate: a suffix outliving its session could
	 * never be claimed again (nothing else can prove ownership), and a suffix
	 * expiring inside a live session would change a working address underneath
	 * a user who did nothing wrong.
	 */
	sweep() {
		const now = Date.now();
		let dropped = 0;
		let empties = 0;
		for (const [sid, row] of this.sessions) {
			if (now - row.seen > this.ttlMs) { this.dropSession(sid); dropped += 1; continue; }
			// ⚠ S8. A session that never got as far as owning an address only has
			// to outlive the gap between the handshake and the first `Create URL`.
			// Keeping it for the full 90-day address ttl is what let a handshake
			// flood sit in this table for a quarter of a year.
			if (now - row.created > this.cfg.empty_session_ttl_ms && !this._owns(sid)) {
				this.sessions.delete(sid);
				this.bySession.delete(sid);
				empties += 1;
			}
		}
		if (dropped) this.log.info(`swept ${dropped} expired session(s)`);
		if (empties) this.log.info(`swept ${empties} session(s) that never claimed an address`);
		return dropped;
	}

	counts() {
		return {
			sessions: this.sessions.size,
			addresses: this.suffixes.size,
			durable: this.durable,
			// Surfaced because the symptom of a full table is that new wallets
			// silently cannot get an address, which looks like a client bug.
			table_full: this.suffixes.size >= this.cfg.max_suffixes_total,
			// R6: a set-aside snapshot holds live receiving addresses from a table
			// we could not use. Left only in the directory, it is a file nobody
			// looks for until they already know to; on /health it is a number the
			// Status screen can print.
			snapshots_set_aside: this.asideFiles,
		};
	}
}

class MintError extends Error {
	constructor(message) { super(message); this.name = 'MintError'; }
}

module.exports = { Store, MintError, SUFFIX_ALPHABET, SUFFIX_RE, SNAPSHOT_VERSION };
