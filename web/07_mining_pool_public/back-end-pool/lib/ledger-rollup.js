/**
 * Ledger rollup — daily aggregation of balance_log into balance_log_daily, so raw ledger
 * rows can be pruned after `database.balance_log_keep_days` without losing ANY lifetime
 * analytics. The rollup keeps every dimension the historical consumers group by —
 * (day, grin_address, event_type, reference_type) — so these stay exact forever:
 *   - payments/transparency series + lifetime totals (hashrate-tracker.getPaymentsHistory)
 *   - reconciliation lifetime flows, pool_fee/prize_pool funding detail, and the
 *     integrity invariant (lib/reconciliation.js)
 * Only per-row detail (which block height paid which credit) ages out with the raw window.
 *
 * Horizon contract — the ONE rule composite readers rely on:
 *   The marker pool_config('_state','balance_log_rollup_horizon') = H (unix, UTC-day-aligned)
 *   means balance_log_daily fully covers created_at < H. Raw rows are only ever pruned
 *   BELOW min(H, now - keep_days), each day verified against its rollup first. Therefore:
 *     lifetime reads  = rollup(day < H) + raw(created_at >= H)   — no gap, no double count
 *     window reads with cutoff >= now - keep_days may read raw only (raw is complete there)
 *   balance_log.created_at is never backdated (DEFAULT unixepoch()), so a completed UTC day
 *   is immutable once rolled.
 */

const DAY = 86400;
const floorDay = (ts) => Math.floor(ts / DAY) * DAY;

// Rollup coverage horizon. 0 = no rollup yet (readers must treat the whole ledger as raw).
function getHorizon(db) {
  try {
    const row = db.prepare(
      "SELECT value FROM pool_config WHERE section = '_state' AND key = 'balance_log_rollup_horizon'"
    ).get();
    const h = row ? parseInt(row.value, 10) : 0;
    return Number.isFinite(h) && h > 0 ? h : 0;
  } catch (e) {
    return 0;
  }
}

function _setHorizon(db, h) {
  db.prepare(`
    INSERT INTO pool_config (section, key, value, value_type)
    VALUES ('_state', 'balance_log_rollup_horizon', ?, 'string')
    ON CONFLICT(section, key) DO UPDATE SET value = excluded.value
  `).run(String(h));
}

// Roll every completed UTC day in [current horizon, today) into balance_log_daily and
// advance the marker — atomically, so a crash can never leave the marker ahead of the data.
// Whole-day recompute + replace-on-conflict keeps it idempotent. Returns the new horizon.
function rollupCompletedDays(db, maxDaysPerPass = 400) {
  const todayStart = floorDay(Math.floor(Date.now() / 1000));
  let horizon = getHorizon(db);
  if (!horizon) {
    const m = db.prepare('SELECT MIN(created_at) AS m FROM balance_log').get().m;
    horizon = m != null ? floorDay(m) : todayStart;
  }
  const target = Math.min(todayStart, horizon + maxDaysPerPass * DAY);
  if (target <= horizon) {
    // Nothing new to roll; still persist a first-run marker so readers get a stable H.
    if (!getHorizon(db)) _setHorizon(db, horizon);
    return { horizon, rolled_days: 0 };
  }
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO balance_log_daily (day, grin_address, event_type, reference_type, total_amount, event_count)
      SELECT CAST(created_at / ${DAY} AS INTEGER) * ${DAY}, grin_address, event_type, reference_type,
             COALESCE(SUM(amount), 0), COUNT(*)
      FROM balance_log
      WHERE created_at >= ? AND created_at < ?
      GROUP BY 1, 2, 3, 4
      ON CONFLICT(day, grin_address, event_type, reference_type)
      DO UPDATE SET total_amount = excluded.total_amount, event_count = excluded.event_count
    `).run(horizon, target);
    _setHorizon(db, target);
  });
  tx();
  return { horizon: target, rolled_days: (target - horizon) / DAY };
}

// Prune raw balance_log rows older than keep_days — one UTC day at a time, and ONLY after
// verifying that day's raw count/sum against its rollup. A mismatch halts pruning (never
// deletes an unverified day) and is surfaced to the caller for alerting. Bounded per pass.
function verifyAndPruneRaw(db, keepDays, maxDaysPerPass = 30) {
  const now = Math.floor(Date.now() / 1000);
  const horizon = getHorizon(db);
  const cutoff = Math.min(horizon, floorDay(now - keepDays * DAY));
  const out = { deleted: 0, days: 0, cutoff, mismatch: null };
  if (cutoff <= 0) return out;

  for (let i = 0; i < maxDaysPerPass; i++) {
    const m = db.prepare('SELECT MIN(created_at) AS m FROM balance_log').get().m;
    if (m == null || m >= cutoff) break;
    const d = floorDay(m);

    const raw = db.prepare(
      'SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS s FROM balance_log WHERE created_at >= ? AND created_at < ?'
    ).get(d, d + DAY);
    const agg = db.prepare(
      'SELECT COALESCE(SUM(event_count), 0) AS c, COALESCE(SUM(total_amount), 0) AS s FROM balance_log_daily WHERE day = ?'
    ).get(d);
    // Count must match exactly; sums within float-accumulation tolerance (amounts are 1e-9 GRIN).
    if (raw.c !== agg.c || Math.abs(raw.s - agg.s) > 1e-4) {
      out.mismatch = {
        day: d, raw_count: raw.c, rollup_count: agg.c,
        raw_sum: raw.s, rollup_sum: agg.s
      };
      console.error(
        `[LedgerRollup] verify FAILED for day ${d} (raw ${raw.c}/${raw.s} vs rollup ${agg.c}/${agg.s}) — pruning halted`
      );
      break;
    }

    const r = db.prepare('DELETE FROM balance_log WHERE created_at >= ? AND created_at < ?').run(d, d + DAY);
    out.deleted += r.changes;
    out.days++;
  }
  return out;
}

module.exports = { getHorizon, rollupCompletedDays, verifyAndPruneRaw, floorDay, DAY };
