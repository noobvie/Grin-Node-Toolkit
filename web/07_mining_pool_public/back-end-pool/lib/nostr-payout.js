'use strict';

// ─── Goblin / Nostr payout bridge (Script 07 pool) ───────────────────────────
//
// Delivers a payout slatepack to a miner's Goblin wallet over Nostr (NIP-17 private
// DM), so a miner with no Tor listener can be paid by registering a Goblin username.
// Transport only: this module NEVER touches balances or the ledger — the withdrawal
// scheduler owns all money accounting (locks, reversals, confirm). The bridge just
// (a) resolves a username → npub, (b) wraps+publishes an already-built slatepack, and
// (c) delivers an incoming response slatepack back to the scheduler to finalize.
//
// Wire format is SOURCE-VERIFIED against goblin src/nostr/*.rs — see
// docs/generated/script05_planning_goblin.md and design §15. Key facts encoded here:
//   • kind-14 rumor, content = preamble + blank line + PLAIN-armor slatepack,
//     tags [["p",recipient],["goblin","1"],["subject",note]]
//   • standard NIP-44 v2 + NIP-59 gift wrap (goblin "v3" is an opt-in extension we
//     never need — a v2 peer is unaffected)
//   • the pool sends FROM the same Nostr key it listens on (goblin finalizes S2 only
//     if the seal-sender pubkey == the counterparty it sent to)
//   • relay floor wss://relay.floonet.dev is always in the publish + inbox set
//   • catch-up fetch on (re)connect with since = now − 3 days
//
// SECURITY MODEL (this rail pays a THIRD PARTY, unlike Tor/slatepack which pay the
// mining address's own wallet — design §15.2). The bridge enforces the transport-side
// guards; the money-side guards (ownership gate, 48h destination cooldown, TOFU npub
// re-pin, one-pending-per-address, failed-payout cooldown, freeze) live in the route
// and the scheduler. Both layers are required.
//
// nostr-tools + ws are lazy-required inside start() so a pool with the feature OFF
// (the default) boots even when the packages aren't installed. Every nostr-tools call
// is confined to the "── wire ──" section below; if a signature drifts in a future
// nostr-tools, only that section changes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Size caps mirror goblin's reject thresholds (protocol.rs). Anything larger is a
// malformed/hostile event and is dropped before any parsing.
const WRAP_CONTENT_MAX = 65536;
const RUMOR_CONTENT_MAX = 32768;
const SLATEPACK_MAX = 30720;
const NOTE_MAX = 256;

const RELAY_FLOOR = 'wss://relay.floonet.dev';
const DEFAULT_RELAYS = [RELAY_FLOOR, 'wss://relay.0xchat.com', 'wss://offchain.pub'];
const LOOKBACK_SECS = 3 * 86400;       // catch-up window on (re)connect
const PUBLISH_CONFIRM_MS = 30000;      // read-back confirm budget per goblin CONFIRM_TIMEOUT
const NIP05_TIMEOUT_MS = 10000;

const PAYMENT_PREAMBLE =
  '[Goblin] GRIN payment message — open in Goblin (https://goblin.st) to process.';

class NostrPayoutBridge {
  // db: better-sqlite3 handle (dedup table + destination lookup on receive).
  // getDb is injected rather than required so tests can stub it.
  constructor(config, db) {
    this.config = config || {};
    this.db = db;
    this.enabled = this.config.nostr_payouts_enabled === true ||
                   this.config.nostr_payouts_enabled === 'true';

    // Operator-advertised relay set (≤ a handful); floor is always forced in.
    let relays = this.config.nostr_relays;
    if (typeof relays === 'string') { try { relays = JSON.parse(relays); } catch (_) { relays = null; } }
    if (!Array.isArray(relays) || relays.length === 0) relays = DEFAULT_RELAYS.slice();
    relays = relays.filter((r) => typeof r === 'string' && /^wss:\/\//.test(r));
    if (!relays.includes(RELAY_FLOOR)) relays.unshift(RELAY_FLOOR);
    this.relays = [...new Set(relays)].slice(0, 6);

    // NIP-05 domain allowlist — the ONLY domains we will resolve a username against.
    // This is the SSRF + typo-squat guard: an attacker can't point the pool's resolver
    // at an internal host or a look-alike domain. Defaults to goblin's home domain.
    let domains = this.config.nostr_nip05_domains;
    if (typeof domains === 'string') { try { domains = JSON.parse(domains); } catch (_) { domains = null; } }
    if (!Array.isArray(domains) || domains.length === 0) domains = ['goblin.st'];
    this.nip05Domains = new Set(
      domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean)
    );

    // Pool Nostr identity key file (hex secret key). Transport identity ONLY — it can
    // never sign a Grin slate, so a leak exposes metadata, not funds. Stored like
    // .wallet_pass (chmod 600, grin-owned).
    this.keyFile = this.config.nostr_key_file ||
      path.join(path.dirname(this.config.db_path || './pool.sqlite'), '.nostr_payout_key');

    // Wire state — populated by start(); null until then.
    this._lib = null;          // nostr-tools module
    this._ws = null;           // ws implementation
    this._pool = null;         // SimplePool
    this._sk = null;           // Uint8Array secret key
    this._pkHex = null;        // hex public key
    this._sub = null;          // active subscription handle
    this._responseHandler = null;
    this._started = false;
  }

  isEnabled() { return this.enabled; }

  // The scheduler registers a callback invoked when a response (S2) slatepack arrives
  // for one of our pending nostr withdrawals: fn(withdrawalId, grinAddress, slatepack, senderPubHex).
  setResponseHandler(fn) { this._responseHandler = fn; }

  getPubkeyHex() { return this._pkHex; }
  getNpub() {
    if (!this._pkHex || !this._lib) return null;
    try { return this._lib.nip19.npubEncode(this._pkHex); } catch (_) { return null; }
  }

  // Idempotent. Loads nostr-tools, ensures the identity key, opens the relay pool,
  // advertises our DM-relay list (kind 10050), and subscribes for incoming responses.
  // Throws only on a hard misconfig; a package-missing error is surfaced to the caller
  // (index.js) which logs and leaves the feature disabled.
  async start() {
    if (!this.enabled) return false;
    if (this._started) return true;

    this._loadLib();
    this._ensureKey();

    const { SimplePool } = this._lib;
    this._pool = new SimplePool();

    this._ensureSeenTable();
    await this._publishRelayList();
    this._subscribe();

    this._started = true;
    console.log(
      `[nostr-payout] bridge started — npub ${this.getNpub()} on ${this.relays.length} relays ` +
      `(NIP-05 domains: ${[...this.nip05Domains].join(', ')})`
    );
    return true;
  }

  stop() {
    try { if (this._sub && this._sub.close) this._sub.close(); } catch (_) { /* noop */ }
    try { if (this._pool && this._pool.close) this._pool.close(this.relays); } catch (_) { /* noop */ }
    this._started = false;
  }

  // ── Username resolution (public: called by the registration route) ──────────
  // Accepts "name" (→ name@<home_domain>), "name@domain", or a bech32 npub. Returns
  // { username, pubHex, npub } or throws a coded Error. Enforces the domain allowlist.
  async resolveDestination(input) {
    this._requireStarted();
    const raw = String(input || '').trim();
    if (!raw) { const e = new Error('username required'); e.code = 400; throw e; }

    // Direct npub — no NIP-05 lookup. Still normalised to hex for storage/matching.
    if (/^npub1[ac-hj-np-z02-9]+$/.test(raw)) {
      let pubHex;
      try {
        const dec = this._lib.nip19.decode(raw);
        if (dec.type !== 'npub' || typeof dec.data !== 'string') throw new Error('bad npub');
        pubHex = dec.data;
      } catch (_) { const e = new Error('invalid npub'); e.code = 400; throw e; }
      return { username: raw, pubHex, npub: raw };
    }

    // NIP-05 name → require an EXPLICIT name@domain, validate both halves, enforce allowlist.
    // We deliberately DON'T guess a home domain for a bare "name": with an irreversible payout
    // a silent "alice" → "alice@goblin.st" could resolve to a stranger, and the guess turns
    // outright ambiguous the moment the operator also allowlists their own 091 name-authority
    // domain. Force the domain (or an npub, handled above).
    if (!raw.includes('@')) {
      const e = new Error('include the domain (e.g. alice@goblin.st) or paste an npub'); e.code = 400; throw e;
    }
    const parts = raw.replace(/^@/, '').split('@');
    if (parts.length !== 2) { const e = new Error('invalid username'); e.code = 400; throw e; }
    let [name, domain] = parts;
    name = name.toLowerCase();
    domain = domain.toLowerCase();

    if (!/^[a-z0-9._-]{1,64}$/.test(name)) { const e = new Error('invalid username'); e.code = 400; throw e; }
    // Strict hostname shape — no IP literals, no ports, no paths (SSRF/path-smuggling guard).
    if (!/^[a-z0-9.-]{1,253}$/.test(domain) || /^\d+\.\d+\.\d+\.\d+$/.test(domain) ||
        domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
      const e = new Error('invalid domain'); e.code = 400; throw e;
    }
    if (!this.nip05Domains.has(domain)) {
      const e = new Error(`username domain not allowed (permitted: ${[...this.nip05Domains].join(', ')})`);
      e.code = 400; throw e;
    }

    const pubHex = await this._nip05Resolve(name, domain);
    if (!pubHex) { const e = new Error('could not resolve that username'); e.code = 404; throw e; }
    let npub = null;
    try { npub = this._lib.nip19.npubEncode(pubHex); } catch (_) { /* keep hex */ }
    return { username: `${name}@${domain}`, pubHex, npub };
  }

  // ── Send (public: called by the scheduler's createNostrWithdrawal) ──────────
  // Wraps an ALREADY-BUILT plain-armor slatepack for `recipientPubHex` and publishes.
  // Returns { ok, relays } on success (≥1 relay accepted) or throws a coded Error.
  // The scheduler reverses the balance lock if this throws.
  async publishSlatepack(recipientPubHex, armoredSlatepack, note) {
    this._requireStarted();
    if (!/^[0-9a-f]{64}$/.test(String(recipientPubHex || ''))) {
      const e = new Error('invalid recipient key'); e.code = 400; throw e;
    }
    const armor = String(armoredSlatepack || '');
    if (!armor.includes('BEGINSLATEPACK') || armor.length > SLATEPACK_MAX) {
      const e = new Error('invalid slatepack'); e.code = 400; throw e;
    }
    const subject = String(note || 'Grin mining payout').slice(0, NOTE_MAX);

    const rumor = {
      kind: 14,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipientPubHex], ['goblin', '1'], ['subject', subject]],
      content: `${PAYMENT_PREAMBLE}\n\n${armor}`,
      pubkey: this._pkHex,
    };

    // Recipient's advertised DM relays (kind 10050) ∪ our set ∪ the floor.
    let targets = this.relays.slice();
    try {
      const hint = await this._fetchDmRelays(recipientPubHex);
      if (hint && hint.length) targets = [...new Set([...hint, ...targets])];
    } catch (_) { /* fall back to our set — goblin does the same */ }
    if (!targets.includes(RELAY_FLOOR)) targets.push(RELAY_FLOOR);

    const wrap = this._wrap(rumor, recipientPubHex);
    const accepted = await this._publish(targets, wrap);
    if (accepted < 1) { const e = new Error('no relay accepted the payout message'); e.code = 502; throw e; }
    return { ok: true, relays: targets.length, accepted };
  }

  // ── Security notice (public: called when a payout destination changes) ─────
  // Sends a PLAIN-TEXT NIP-17 DM — no slatepack, and deliberately WITHOUT
  // PAYMENT_PREAMBLE, so a Goblin wallet never mistakes an alert for a payment to parse.
  //
  // This is the out-of-band channel that makes the destination cooldown mean something.
  // Without it the cooldown only helps a miner who happens to open the account page; with
  // it, a hijack reaches the real owner on a channel the attacker does not control, hours
  // before any money can move.
  //
  // BEST-EFFORT BY CONTRACT: returns { ok:false, error } instead of throwing. A relay
  // outage must not block a legitimate destination change — but the caller MUST record the
  // failure (audit log + response), because an alert nobody received is not a control.
  async publishNotice(recipientPubHex, text, subject) {
    try {
      this._requireStarted();
      if (!/^[0-9a-f]{64}$/.test(String(recipientPubHex || ''))) {
        return { ok: false, error: 'invalid recipient key' };
      }
      const body = String(text || '').slice(0, SLATEPACK_MAX);
      if (!body) return { ok: false, error: 'empty notice' };

      const rumor = {
        kind: 14,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', recipientPubHex], ['goblin', '1'],
               ['subject', String(subject || 'Grin pool security notice').slice(0, NOTE_MAX)]],
        content: body,
        pubkey: this._pkHex,
      };

      let targets = this.relays.slice();
      try {
        const hint = await this._fetchDmRelays(recipientPubHex);
        if (hint && hint.length) targets = [...new Set([...hint, ...targets])];
      } catch (_) { /* fall back to our set */ }
      if (!targets.includes(RELAY_FLOOR)) targets.push(RELAY_FLOOR);

      const accepted = await this._publish(targets, this._wrap(rumor, recipientPubHex));
      if (accepted < 1) return { ok: false, error: 'no relay accepted the notice' };
      return { ok: true, relays: targets.length, accepted };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ─────────────────────────── wire (nostr-tools) ─────────────────────────────
  // Everything below is the only code coupled to nostr-tools' API surface.

  _loadLib() {
    if (this._lib) return;
    let lib;
    try {
      lib = require('nostr-tools');
    } catch (e) {
      const err = new Error(
        'nostr payouts are enabled but "nostr-tools" is not installed — run `npm install` in ' +
        'the pool backend (adds nostr-tools + ws), then restart'
      );
      err.code = 503;
      throw err;
    }
    // SimplePool needs a WebSocket implementation in Node. nostr-tools exposes a setter
    // (location has varied across 2.x — try both, tolerate absence in case a build wires
    // a global WebSocket).
    try {
      const WebSocket = require('ws');
      this._ws = WebSocket;
      const setter = (lib.useWebSocketImplementation) ||
        (safeRequire('nostr-tools/pool') && safeRequire('nostr-tools/pool').useWebSocketImplementation);
      if (typeof setter === 'function') setter(WebSocket);
      else if (typeof globalThis.WebSocket === 'undefined') globalThis.WebSocket = WebSocket;
    } catch (e) {
      console.warn(`[nostr-payout] ws wiring: ${e.message}`);
    }
    this._lib = lib;
  }

  _wrap(rumor, recipientPubHex) {
    // nip59.wrapEvent(rumor, senderSecretKey, recipientPubHex) → signed kind-1059 gift
    // wrap (seal kind-13 signed by us, wrap signed by an ephemeral key, created_at fuzzed).
    return this._lib.nip59.wrapEvent(rumor, this._sk, recipientPubHex);
  }

  _unwrap(giftWrap) {
    // Returns the kind-14 rumor with .pubkey = the seal-verified SENDER (nip59 checks the
    // seal author == rumor author internally). Throws on any crypto/verify failure.
    return this._lib.nip59.unwrapEvent(giftWrap, this._sk);
  }

  async _publish(relays, event) {
    // pool.publish returns one promise per relay; count how many resolve within the budget.
    const proms = this._pool.publish(relays, event);
    let accepted = 0;
    await Promise.all(
      proms.map((p) =>
        withTimeout(Promise.resolve(p), PUBLISH_CONFIRM_MS)
          .then(() => { accepted += 1; })
          .catch(() => { /* this relay rejected/timed out — others may still accept */ })
      )
    );
    return accepted;
  }

  async _publishRelayList() {
    // kind 10050 = DM inbox relays (NIP-17). NO "encryption" tag → goblin peers speak
    // standard v2 to us. Replaceable event, so re-publishing on every boot is idempotent.
    try {
      const tags = this.relays.map((r) => ['relay', r]);
      const tmpl = { kind: 10050, created_at: Math.floor(Date.now() / 1000), tags, content: '' };
      const signed = this._lib.finalizeEvent(tmpl, this._sk);
      await this._publish(this.relays, signed);
    } catch (e) {
      console.warn(`[nostr-payout] could not publish relay list: ${e.message}`);
    }
  }

  async _fetchDmRelays(pubHex) {
    // Best-effort kind-10050 lookup for a recipient (their preferred DM inbox relays).
    const ev = await withTimeout(
      this._pool.get(this.relays, { kinds: [10050], authors: [pubHex] }),
      NIP05_TIMEOUT_MS
    ).catch(() => null);
    if (!ev || !Array.isArray(ev.tags)) return [];
    return ev.tags
      .filter((t) => t[0] === 'relay' && typeof t[1] === 'string' && /^wss:\/\//.test(t[1]))
      .map((t) => t[1])
      .slice(0, 4);
  }

  async _nip05Resolve(name, domain) {
    // nostr-tools nip05.queryProfile does the /.well-known/nostr.json fetch. Domain is
    // already allowlist-checked by the caller, so this can't be pointed at internal hosts.
    try {
      const profile = await withTimeout(
        this._lib.nip05.queryProfile(`${name}@${domain}`),
        NIP05_TIMEOUT_MS
      );
      const pk = profile && profile.pubkey;
      return /^[0-9a-f]{64}$/.test(String(pk || '')) ? pk : null;
    } catch (_) {
      return null;
    }
  }

  _subscribe() {
    const filter = {
      kinds: [1059],
      '#p': [this._pkHex],
      since: Math.floor(Date.now() / 1000) - LOOKBACK_SECS,
    };
    this._sub = this._pool.subscribeMany(this.relays, [filter], {
      onevent: (ev) => { this._onWrap(ev).catch((e) => console.warn(`[nostr-payout] onevent: ${e.message}`)); },
      oneose: () => { /* end of stored events; live tail continues */ },
    });
  }

  // ───────────────────────── receive pipeline ─────────────────────────────────
  async _onWrap(ev) {
    if (!ev || typeof ev.id !== 'string') return;
    if (ev.content && ev.content.length > WRAP_CONTENT_MAX) return;        // oversized wrap
    if (!this._markSeen(ev.id)) return;                                     // dedup (idempotent receive)

    let rumor;
    try { rumor = this._unwrap(ev); }
    catch (_) { return; }                                                   // undecryptable / forged seal
    if (!rumor || rumor.kind !== 14) return;
    if (typeof rumor.content !== 'string' || rumor.content.length > RUMOR_CONTENT_MAX) return;

    const senderPub = String(rumor.pubkey || '');
    if (!/^[0-9a-f]{64}$/.test(senderPub)) return;

    const slatepack = extractSlatepack(rumor.content);
    if (!slatepack) return;                                                 // no/duplicate/oversized armor

    // Route to a pending nostr withdrawal whose registered destination is this sender.
    // The scheduler re-verifies (npub match + slate.id bind) before touching money.
    let row = null;
    try {
      row = this.db.prepare(
        `SELECT w.id AS id, w.grin_address AS grin_address
           FROM withdrawals w JOIN miner_accounts m ON m.grin_address = w.grin_address
          WHERE w.status = 'slatepack_pending' AND w.method = 'nostr' AND m.nostr_npub = ?
          ORDER BY w.created_at ASC LIMIT 1`
      ).get(senderPub);
    } catch (e) {
      console.warn(`[nostr-payout] lookup failed: ${e.message}`);
      return;
    }
    if (!row) return;                                                       // unsolicited / already settled

    if (typeof this._responseHandler !== 'function') return;
    try {
      await this._responseHandler(row.id, row.grin_address, slatepack, senderPub);
    } catch (e) {
      console.warn(`[nostr-payout] finalize handoff for withdrawal ${row.id}: ${e.message}`);
    }
  }

  // ───────────────────────── helpers ──────────────────────────────────────────
  _ensureKey() {
    const { generateSecretKey, getPublicKey } = this._lib;
    let hex = null;
    try {
      if (fs.existsSync(this.keyFile)) hex = fs.readFileSync(this.keyFile, 'utf8').trim();
    } catch (e) { console.warn(`[nostr-payout] reading key file: ${e.message}`); }

    if (!/^[0-9a-f]{64}$/.test(String(hex || ''))) {
      const sk = generateSecretKey();                 // Uint8Array(32)
      hex = Buffer.from(sk).toString('hex');
      try {
        fs.writeFileSync(this.keyFile, hex, { mode: 0o600 });
        try { fs.chmodSync(this.keyFile, 0o600); } catch (_) { /* windows: no-op */ }
        console.warn(`[nostr-payout] generated new pool identity key → ${this.keyFile}`);
      } catch (e) {
        throw new Error(`cannot persist nostr key file ${this.keyFile}: ${e.message}`);
      }
    }
    this._sk = Uint8Array.from(Buffer.from(hex, 'hex'));
    this._pkHex = getPublicKey(this._sk);
  }

  _ensureSeenTable() {
    try {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS nostr_seen_events (
           event_id TEXT PRIMARY KEY,
           seen_at INTEGER NOT NULL DEFAULT (unixepoch())
         )`
      );
    } catch (e) { console.warn(`[nostr-payout] seen-table init: ${e.message}`); }
  }

  // Returns true if this is the FIRST time we've seen the id (i.e. process it); false if
  // already seen. INSERT OR IGNORE makes the check atomic against concurrent relay copies.
  _markSeen(eventId) {
    try {
      const r = this.db.prepare('INSERT OR IGNORE INTO nostr_seen_events (event_id) VALUES (?)').run(eventId);
      return r.changes === 1;
    } catch (e) {
      console.warn(`[nostr-payout] dedup insert: ${e.message}`);
      return true; // fail-open: better to risk a re-parse (scheduler guards money) than to drop
    }
  }

  _requireStarted() {
    if (!this._started) { const e = new Error('nostr payouts are not available'); e.code = 503; throw e; }
  }
}

// ── module-scope pure helpers (unit-testable without nostr-tools) ──────────────

// Extract EXACTLY ONE BEGINSLATEPACK…ENDSLATEPACK block (tag-distrusting, mirrors
// goblin's extract_slatepack). Two blocks, none, or oversized → null (rejected).
function extractSlatepack(content) {
  if (typeof content !== 'string') return null;
  const re = /BEGINSLATEPACK\.[\s\S]*?ENDSLATEPACK\./g;
  const matches = content.match(re);
  if (!matches || matches.length !== 1) return null;
  const sp = matches[0];
  if (sp.length > SLATEPACK_MAX) return null;
  return sp;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

function safeRequire(mod) {
  try { return require(mod); } catch (_) { return null; }
}

module.exports = NostrPayoutBridge;
module.exports._extractSlatepack = extractSlatepack; // exported for unit tests
