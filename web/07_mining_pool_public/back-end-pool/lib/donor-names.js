'use strict';

// Donor settings + the v1 starter word list — what is left of §16's name model after §18 (names
// pre-moderated) and script07_design_games.md §19.17.6 (names auto-checked). Here:
// calendar-month arithmetic for expiry, the one bounded reader of every donor setting, and the
// old starter list.
//
// A donor NAME is checked by lib/name-rule.js (the shared rule, donor shape) and goes live at
// once (lib/donor-profiles.js). The rule owns the matching form and the reserved words, the
// review queue holds banners only, and the old `donor_name_blocklist` setting is retired into
// `names.blocked_words` (pool-settings.js retireDonorNameBlocklist carries the operator's own
// entries over once). The six v1 donor_* columns on miner_incentives stay in the schema, unread.
//
// No dependency on index.js or pool-settings.js on purpose: pool-settings.js imports
// STARTER_BLOCKLIST from here, so a require the other way would be a cycle.

// The v1 starter word list, kept as a RECORD: it was the default of the retired
// `donor_name_blocklist` setting, so the one-time carry-over can tell the operator's own entries
// from these. lib/name-rule.js SEED is built from it word for word (scripts/test-name-rule.js
// [2] checks); the rule, not this list, is what refuses a name.
const STARTER_BLOCKLIST = Object.freeze([
  'anal',
  'anus',
  'arse',
  'ass',
  'asshole',
  'bastard',
  'bitch',
  'blowjob',
  'boner',
  'chink',
  'clit',
  'cock',
  'cocksucker',
  'coon',
  'cunt',
  'dick',
  'dildo',
  'douche',
  'dyke',
  'fag',
  'faggot',
  'fuck',
  'gook',
  'handjob',
  'hitler',
  'jizz',
  'kike',
  'motherfucker',
  'nazi',
  'nigga',
  'nigger',
  'paedo',
  'pedo',
  'penis',
  'piss',
  'porn',
  'prick',
  'pussy',
  'rape',
  'rapist',
  'retard',
  'scum',
  'shit',
  'slut',
  'spic',
  'tits',
  'tranny',
  'twat',
  'wanker',
  'wetback',
  'whore'
]);

// `months` calendar months after `ref` (unix seconds), in UTC. Calendar months, not 30-day
// blocks: "12 months" on the settings page should mean the same date next year.
function addMonthsUtc(ref, months) {
  const d = new Date(ref * 1000);
  return Math.floor(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()
  ) / 1000);
}

// ── Bounded settings readers ────────────────────────────────────────────────────────────
// pool-settings.js validates these on WRITE, but a read still has to bound them: a row can
// arrive as a string (hand-edited value_type), a blank, or a number outside the range the
// validator was given later. NaN/Infinity never reach a multiplier (memory
// reference_money_number_boundary_traps). Every consumer reads through donorSettings().
function boundInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < lo || n > hi) return dflt;
  return n;
}
function boundNum(v, lo, hi, dflt) {
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return dflt;
  return n;
}

// `section` is PoolSettings.getSection('incentives'); `poolName` is pool_info.pool_name.
function donorSettings(section, poolName) {
  const s = section || {};
  return {
    poolName: poolName == null ? '' : String(poolName),
    rankWindowDays: boundInt(s.donor_rank_window_days, 0, 3650, 365),
    loyaltyPercentPerMonth: boundNum(s.donor_loyalty_percent_per_month, 0, 100, 10),
    loyaltyCap: boundNum(s.donor_loyalty_cap, 1, 100, 3),
    nameExpiryMonths: boundInt(s.donor_name_expiry_months, 0, 120, 12),
    // Design §18.6: how many league ranks show an approved banner. 0 = banners off.
    bannerSlots: boundInt(s.donor_banner_slots, 0, 10, 5)
  };
}

module.exports = {
  STARTER_BLOCKLIST,
  donorSettings,
  addMonthsUtc
};
