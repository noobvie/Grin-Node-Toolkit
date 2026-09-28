'use strict';

// Activity sync: plays from active mining MINUTES (design §19.6, D10).
//
// Every 5 min (the maintenance '5m' tier) the service asks the pool for the active
// miner-seconds in one window at a time and credits plays for them. The rules, each one a
// guard against a specific way plays could appear without mining:
//
//   - WINDOWS never cross a whole hour: to = min(next hour boundary, now − LAG). So a window
//     is ≤ 3600 s (the pool's own bound), never spans UTC midnight, and belongs to exactly
//     one UTC day. LAG (120 s) gives the pool's minute rows time to land.
//   - Windows are CONTIGUOUS from the watermark (MAX(activity_sync.window_to)), so no second
//     of pool history is counted twice or skipped.
//   - A window is credited ONCE. The whole credit — the activity_sync row, every
//     activity_daily update, every ledger row and players.plays — is one transaction, and
//     activity_sync.window_from is UNIQUE, so a repeated or concurrent sync of the same
//     window is a no-op. The ledger ref 'w:<window_from>' is a second, independent guard.
//   - CATCH-UP is bounded: at most MAX_WINDOWS_PER_TICK pool calls per tick, so a long outage
//     never starts with a flood of calls at the pool. Windows older than LOOKBACK are recorded
//     as skipped (rows = −1) without a pool call — those minutes are lost, not flooded in.
//   - The seconds the pool reports for one address are clamped to the window's length: one
//     address cannot have been active for longer than the window lasted.
//   - Settings (minutes_per_play, caps) are read per window and apply from that window on.
//     Earlier DAYS are never recomputed, but `due` is taken from the day's running total, so
//     a change re-rates the CURRENT UTC day: lowering minutes_per_play or raising the daily
//     cap mid-day credits the difference at the next window; the opposite change credits
//     nothing more that day. plays_awarded only ever grows within a day (§19.15 Part 11).
//
// Runs in every games mode, 'off' included: it costs the pool one indexed query per 5 min,
// and plays then exist when the operator switches the games on. With no link secret it is a
// logged no-op.

const HOUR = 3600;
const DAY = 86400;
const LAG_S = 120;
const MAX_WINDOWS_PER_TICK = 24;
const LOOKBACK_S = 7 * DAY;
// The pool refuses from < now − 7 d; stay clear of that edge so clock skew between the
// computation here and the check there cannot turn a valid window into a 400.
const LOOKBACK_MARGIN_S = 300;

function utcDay(t) {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

function createActivitySync({ db, poolLink, ledger, settings, log, now = () => Math.floor(Date.now() / 1000) }) {
  const raw = db.raw;
  const stmts = {
    watermark: raw.prepare('SELECT MAX(window_to) AS w FROM activity_sync'),
    mark: raw.prepare(
      'INSERT INTO activity_sync (window_from, window_to, rows, synced_at) VALUES (?, ?, ?, ?) ON CONFLICT(window_from) DO NOTHING'),
    addSeconds: raw.prepare(
      'INSERT INTO activity_daily (address, day, seconds) VALUES (?, ?, ?) ' +
      'ON CONFLICT(address, day) DO UPDATE SET seconds = seconds + excluded.seconds ' +
      'RETURNING seconds, plays_awarded'),
    setAwarded: raw.prepare('UPDATE activity_daily SET plays_awarded = ? WHERE address = ? AND day = ?'),
    plays: raw.prepare('SELECT plays FROM players WHERE address = ?'),
  };

  // The first sync ever starts at the current UTC day's midnight, so miners get today's
  // plays when the games launch (≤ 24 windows — exactly one tick's bound).
  function watermark(t) {
    const w = stmts.watermark.get().w;
    if (Number.isSafeInteger(w)) return w;
    return Math.floor((t - LAG_S) / DAY) * DAY;
  }

  // Credits one window's rows. Synchronous, one transaction. → { credited, plays } or
  // { duplicate:true } when the window was already synced.
  function creditWindow(from, to, rows) {
    const cfg = settings.all();
    const minutesPerPlay = cfg.minutes_per_play;
    const dailyCap = cfg.plays_daily_cap;
    const balanceCap = cfg.plays_balance_cap;
    const day = utcDay(from);
    const span = to - from;
    return db.transaction(() => {
      const t = now();
      if (stmts.mark.run(from, to, rows.length, t).changes === 0) return { duplicate: true };
      let credited = 0;
      let plays = 0;
      for (const r of rows) {
        const secs = Math.min(r.seconds, span);
        if (secs <= 0) continue;
        ledger.ensurePlayer(r.address, t);
        const d = stmts.addSeconds.get(r.address, day, secs);
        const due = Math.min(dailyCap, Math.floor(d.seconds / 60 / minutesPerPlay));
        if (due <= d.plays_awarded) continue;          // nothing new (or a cap was lowered today)
        const bal = stmts.plays.get(r.address).plays;
        const delta = Math.min(due - d.plays_awarded, Math.max(0, balanceCap - bal));
        // Minutes cut by the balance cap are lost, not deferred (§19.6): plays_awarded
        // moves to `due` either way.
        stmts.setAwarded.run(due, r.address, day);
        if (delta > 0) {
          const res = ledger.credit(r.address, 'plays', delta, 'mining_minutes', `w:${from}`);
          if (!res.duplicate) { credited++; plays += delta; }
        }
      }
      return { duplicate: false, credited, plays };
    });
  }

  function skipWindow(from, to) {
    db.transaction(() => { stmts.mark.run(from, to, -1, now()); });
  }

  // One tick. → { windows, skipped, credited, plays, stopped } — `stopped` names why the
  // tick ended early (a PoolLinkError code), or null.
  async function syncOnce() {
    const summary = { windows: 0, skipped: 0, credited: 0, plays: 0, dropped: 0, stopped: null };
    if (!poolLink.secretConfigured()) { summary.stopped = 'link_not_configured'; return summary; }
    let calls = 0;
    // Each pass either makes one pool call or advances the watermark without one; the guard
    // is only a backstop against a watermark that somehow fails to move.
    for (let guard = 0; calls < MAX_WINDOWS_PER_TICK && guard < 4 * MAX_WINDOWS_PER_TICK; guard++) {
      const t = now();
      const end = t - LAG_S;
      const from = watermark(t);
      if (from >= end) break;
      const cutoff = t - LOOKBACK_S + LOOKBACK_MARGIN_S;
      if (from < cutoff) {
        // Everything before the lookback in ONE skipped row, up to the first whole hour
        // inside it — a month-long outage is one row, not 720.
        skipWindow(from, Math.min(Math.ceil(cutoff / HOUR) * HOUR, end));
        summary.skipped++;
        continue;
      }
      const to = Math.min((Math.floor(from / HOUR) + 1) * HOUR, end);
      calls++;
      let act;
      try {
        act = await poolLink.activity(from, to);
      } catch (e) {
        // The pool says the window is too old after all (clock skew at the edge): record it
        // as skipped, or the sync would retry the same refused window forever.
        if (e && e.code === 'link_rejected' && e.field === 'from') {
          skipWindow(from, to);
          summary.skipped++;
          continue;
        }
        summary.stopped = (e && e.code) || 'error';
        break;
      }
      const res = creditWindow(from, to, act.rows);
      summary.windows++;
      summary.dropped += act.dropped || 0;
      if (!res.duplicate) { summary.credited += res.credited; summary.plays += res.plays; }
    }
    if (summary.dropped) log.warn(`[plays] ignored ${summary.dropped} malformed activity row(s) from the pool`);
    return summary;
  }

  return { syncOnce, creditWindow, watermark, utcDay };
}

module.exports = { createActivitySync, utcDay, LAG_S, MAX_WINDOWS_PER_TICK, LOOKBACK_S };
