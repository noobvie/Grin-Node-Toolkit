'use strict';

// Donor-name words + donor settings — design §18.6 (2026-09-24), the survivor of §16's v1 name
// model. What is left here: the matching form of a name (normalise), the fixed reserved words,
// the shipped starter list of FLAG words, the review-queue flags built from them, calendar-month
// arithmetic for expiry, and the one bounded reader of every donor setting.
//
// Since §18 every donor name is PRE-moderated (lib/donor-profiles.js): nothing a donor types
// is public until an admin approves it, so a word hit is a HINT beside a queued name, never an
// automatic decision. v1's capture-from-login, auto-censor, rescan-on-save, per-address
// censor/allow state and the censored marker were deleted in §18 Part 3; the six v1 donor_*
// columns on miner_incentives stay in the schema, unread.
//
// No dependency on index.js or pool-settings.js on purpose: pool-settings.js imports
// STARTER_BLOCKLIST from here for its default, so a require the other way would be a cycle.

// Fixed impersonation words, always flagged whatever the operator's list says. The pool's
// own name is added at match time (poolName parameter).
const RESERVED = Object.freeze([
  'admin', 'official', 'operator', 'support', 'staff', 'pool', 'grinium', 'prize', 'jackpot',
  'winner'
]);

// Starter FLAG words — the DEFAULT of the `donor_name_blocklist` setting, not a rule.
// Compact English profanity + slurs; the operator's own words are the real list (§16.1 #6).
// Matched as a substring of the normalised name, so false positives are expected (`classic`
// ⊃ `ass`) — harmless since §18: a hit only highlights a queued name, the admin decides.
// One entry per line, nothing else in the data: it is joined with '\n' into a textarea.
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

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' };

// Matching form of a name or list entry: lowercase, separators stripped, six leet digits
// mapped back. `a55-h0le` → `asshole`, `Acme & Co.` → `acmeco`. Applied to BOTH sides of every
// comparison. The separators are every non-alphanumeric a §18.5 donor name may contain (space
// - _ . & '), so `s h i t` and `sh.it` read as what they spell.
function normalise(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[\s\-_.&']/g, '')
    .replace(/[013457]/g, (c) => LEET[c]);
}

// The operator's list text → normalised entries, in order, empties dropped. Split on newlines
// only; never a RegExp built from operator text (a stray `(` would throw on every match).
// Each entry keeps its as-typed spelling for the queue's flag badge.
function parseList(listText) {
  const out = [];
  for (const raw of String(listText == null ? '' : listText).split(/\r?\n/)) {
    const entry = raw.trim();
    if (entry === '') continue;
    const norm = normalise(entry);
    if (norm === '') continue; // an entry made only of separators
    out.push({ entry, norm });
  }
  return out;
}

// The pool's own name as a reserved word — only when it normalises to something worth
// matching. A one- or two-character pool name would flag nearly every donor, which is not
// what "reserved" means; three characters is the shortest brand this guards.
function poolNameEntry(poolName) {
  const norm = normalise(poolName);
  return norm.length >= 3 ? { entry: String(poolName).trim(), norm } : null;
}

// Substring hits on an already-normalised name. Reserved = the fixed words, then the pool name;
// list = the operator's entries in order. Each returns the first hit as typed, or null.
function reservedHit(n, poolEntry) {
  if (n === '') return null;
  for (const word of RESERVED) {
    if (n.includes(word)) return word;
  }
  return poolEntry && n.includes(poolEntry.norm) ? poolEntry.entry : null;
}
function listHit(n, entries) {
  if (n === '') return null;
  for (const { entry, norm } of entries || []) {
    if (n.includes(norm)) return entry;
  }
  return null;
}

// First matching entry (as typed) or null: reserved words first, then the operator's list.
// Takes the list ALREADY PARSED — a caller that matches many names parses the text once.
// parseList normalises every entry, and at the validator's ceiling (4000 entries) doing that
// per name cost ~1 s for 300 names on the shared synchronous connection, i.e. a stall of share
// intake (§16.12 finding A). nameFlagContext() below exists for the same reason.
function matchEntries(name, entries, poolEntry) {
  const n = normalise(name);
  return reservedHit(n, poolEntry) || listHit(n, entries);
}

// ── Review-queue flags (design §18.6) ───────────────────────────────────────────────────
// Hints beside a QUEUED name, never an automatic decision:
//   reserved       a fixed impersonation word or the pool's own name
//   word           an entry of the operator's flag-word list
//   same_as_donor  normalised equality with ANOTHER address's approved name (impersonation
//                  between donors). Expired approvals count: an expired name comes back the
//                  moment its donor donates again.
// Build the context ONCE per queue read, then call nameFlags per row. `approved` is
// [{ address, name }] for every approved name row.
function nameFlagContext(listText, poolName, approved) {
  const byNorm = new Map();
  for (const r of approved || []) {
    const n = normalise(r && r.name);
    if (n === '') continue;
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push(r.address);
  }
  return { entries: parseList(listText), poolEntry: poolNameEntry(poolName), approvedByNorm: byNorm };
}

// → [{ type, word?, addresses? }] in the fixed order reserved, word, same_as_donor; [] = clean.
function nameFlags(name, address, ctx) {
  const n = normalise(name);
  const out = [];
  if (n === '' || !ctx) return out;
  const r = reservedHit(n, ctx.poolEntry);
  if (r) out.push({ type: 'reserved', word: r });
  const w = listHit(n, ctx.entries);
  if (w) out.push({ type: 'word', word: w });
  const others = (ctx.approvedByNorm.get(n) || []).filter((a) => a !== address);
  if (others.length) out.push({ type: 'same_as_donor', addresses: others });
  return out;
}

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
    listText: typeof s.donor_name_blocklist === 'string' ? s.donor_name_blocklist : STARTER_BLOCKLIST.join('\n'),
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
  RESERVED,
  STARTER_BLOCKLIST,
  normalise,
  parseList,
  poolNameEntry,
  matchEntries,
  nameFlagContext,
  nameFlags,
  donorSettings,
  addMonthsUtc
};
