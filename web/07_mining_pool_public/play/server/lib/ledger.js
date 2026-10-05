'use strict';

// Plays + points ledger (design §19.6, D1).
//
// Nothing here is money. Plays and points are worthless outside the games, never GRIN,
// never transferable, and nothing outside grinium-games.db reads them (D1, D5).
//
// THE INVARIANT: players.plays = Σ ledger.delta (kind='plays') and players.points =
// Σ ledger.delta (kind='points'), for every address. It holds because:
//   - post() is the ONLY writer of either column, and it writes the balance and the ledger
//     row in one transaction (a SAVEPOINT when the caller already holds one, so a caller
//     that fails later rolls the credit back with everything else);
//   - a debit that would take a balance below 0 is refused (LedgerError 'no_plays' /
//     'no_points') before anything is written — and the CHECK (plays >= 0) constraint is
//     the backstop if a caller ever bypasses that;
//   - a credit with a ref is exactly-once: uq_ledger_ref (address, kind, reason, ref) turns a
//     repeat into a no-op, reported as { duplicate:true }, so a retried window or a doubled
//     settle can never double-credit.
//
// verify() recomputes the sums and REPORTS drift. It never fixes it: an automatic "repair"
// would hide the bug that caused the drift and could silently mint or burn balances.

const KINDS = new Set(['plays', 'points']);
// §19.4 ledger.reason. A reason not in this list is refused, so a typo cannot create a new
// category that reports and the admin pages would never show.
const REASONS = new Set([
  'mining_minutes', 'match_cost', 'match_refund', 'match_result', 'event', 'admin_adjust', 'admin_void',
  // §19.17.4 (C5): a guest's balance SET to guest_daily_plays at the first spend or /me of a
  // UTC day — either sign, ref 'gd:<day>' (lib/tickets.js).
  'guest_daily',
]);
const REF_RE = /^[A-Za-z0-9:_.-]{1,64}$/;
// Far below 2^53 (node:sqlite throws past it) and far above any real balance.
const DELTA_MAX = 1e9;

class LedgerError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function createLedger({ db, now = () => Math.floor(Date.now() / 1000) }) {
  const raw = db.raw;
  const stmts = {
    player: raw.prepare('SELECT plays, points FROM players WHERE address = ?'),
    ensure: raw.prepare(
      'INSERT INTO players (address, first_seen, last_seen) VALUES (?, ?, ?) ON CONFLICT(address) DO NOTHING'),
    insert: raw.prepare(
      'INSERT INTO ledger (address, kind, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT DO NOTHING'),
    plays: raw.prepare('UPDATE players SET plays = plays + ? WHERE address = ?'),
    points: raw.prepare('UPDATE players SET points = points + ? WHERE address = ?'),
  };

  // Creates the players row if missing (a miner collects plays before their first login).
  function ensurePlayer(address, t = now()) {
    stmts.ensure.run(address, t, t);
  }

  // post({ address, kind, delta, reason, ref }) → { duplicate, balance }
  // Runs inside the caller's transaction when there is one. Throws LedgerError on an
  // overdraft, Error on a malformed call (a programming error, not a player's).
  function post({ address, kind, delta, reason, ref = null }) {
    if (typeof address !== 'string' || address === '') throw new Error('ledger: address required');
    if (!KINDS.has(kind)) throw new Error(`ledger: bad kind ${kind}`);
    if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > DELTA_MAX) throw new Error('ledger: delta must be a non-zero safe integer');
    if (!REASONS.has(reason)) throw new Error(`ledger: bad reason ${reason}`);
    if (ref !== null && (typeof ref !== 'string' || !REF_RE.test(ref))) throw new Error('ledger: bad ref');

    return db.transaction(() => {
      const t = now();
      ensurePlayer(address, t);
      const p = stmts.player.get(address);
      const bal = kind === 'plays' ? p.plays : p.points;
      if (delta < 0 && bal + delta < 0) throw new LedgerError(kind === 'plays' ? 'no_plays' : 'no_points');
      const r = stmts.insert.run(address, kind, delta, reason, ref, t);
      if (r.changes === 0) return { duplicate: true, balance: bal };
      (kind === 'plays' ? stmts.plays : stmts.points).run(delta, address);
      return { duplicate: false, balance: bal + delta };
    });
  }

  const credit = (address, kind, amount, reason, ref) => post({ address, kind, delta: amount, reason, ref });
  const debit = (address, kind, amount, reason, ref) => post({ address, kind, delta: -amount, reason, ref });

  // → [{ address, kind, balance, ledger }] for every mismatch; [] when consistent. One pass
  // over the ledger (GROUP BY on idx_ledger_address) plus one over players.
  function verify() {
    const sums = new Map();
    for (const r of raw.prepare('SELECT address, kind, SUM(delta) AS s FROM ledger GROUP BY address, kind').all()) {
      sums.set(`${r.kind}|${r.address}`, r.s);
    }
    const drift = [];
    const seen = new Set();
    for (const p of raw.prepare('SELECT address, plays, points FROM players').all()) {
      for (const kind of ['plays', 'points']) {
        const key = `${kind}|${p.address}`;
        seen.add(key);
        const l = sums.get(key) || 0;
        if (l !== p[kind]) drift.push({ address: p.address, kind, balance: p[kind], ledger: l });
      }
    }
    // Ledger rows for an address with no players row: a balance that exists nowhere.
    for (const [key, s] of sums) {
      if (!seen.has(key) && s !== 0) {
        const [kind, address] = key.split('|');
        drift.push({ address, kind, balance: null, ledger: s });
      }
    }
    return drift;
  }

  return { post, credit, debit, verify, ensurePlayer };
}

module.exports = { createLedger, LedgerError, REASONS, KINDS };
