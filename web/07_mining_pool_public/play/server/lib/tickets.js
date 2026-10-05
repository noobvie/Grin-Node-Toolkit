'use strict';

// Guest tickets (design §19.17.4, D25). "Tickets" is the visible word; internally they are
// `plays`, and everything here goes through the ledger like every other plays change.
//
// A guest's balance is SET to guest_daily_plays once per UTC day — topped back up, never saved
// up: an admin who gave a guest extra yesterday sees it go back down today. It happens lazily,
// at the guest's first /me or first spend of the day, so an idle guest costs nothing.
//
//   - The change is ONE ledger row (plays, guest_daily − plays, 'guest_daily', 'gd:<day>'),
//     either sign, so Σ ledger = plays keeps holding and ledger.verify() keeps checking it.
//   - A day whose delta is 0 writes no ledger row (delta <> 0 is a CHECK), so the ref cannot be
//     the only "done today" marker: players.guest_day is set in the same transaction. The
//     ref's unique index (uq_ledger_ref) is the second guard against a double top-up.
//   - Miners are never topped up (their plays come from mining minutes, D10), and neither is a
//     deleted guest.
//
// topUp() runs inside the caller's transaction when there is one (a SAVEPOINT), so a spend
// and its day's top-up land together or not at all.

const { isGuestId } = require('./mask');
const { utcDay } = require('./plays');

function createTickets({ db, ledger, settings, now = () => Math.floor(Date.now() / 1000) }) {
  const raw = db.raw;
  const stmts = {
    player: raw.prepare('SELECT plays, kind, deleted_at, guest_day FROM players WHERE address = ?'),
    setDay: raw.prepare('UPDATE players SET guest_day = ? WHERE address = ?'),
  };

  // → the delta applied (0 when nothing was due or this is not a live guest).
  function topUp(address, t = now()) {
    if (!isGuestId(address)) return 0;
    return db.transaction(() => {
      const p = stmts.player.get(address);
      if (!p || p.kind !== 'guest' || p.deleted_at !== null) return 0;
      const day = utcDay(t);
      if (p.guest_day === day) return 0;
      const delta = settings.get('guest_daily_plays') - p.plays;
      let applied = 0;
      if (delta !== 0) {
        const r = ledger.post({ address, kind: 'plays', delta, reason: 'guest_daily', ref: `gd:${day}` });
        if (!r.duplicate) applied = delta;
      }
      stmts.setDay.run(day, address);
      return applied;
    });
  }

  return { topUp };
}

// The stand-in for modules built without tickets (the Part 4–12 tests construct some directly).
const NO_TICKETS = Object.freeze({ topUp: () => 0 });

module.exports = { createTickets, NO_TICKETS };
