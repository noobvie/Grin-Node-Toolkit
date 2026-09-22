'use strict';

// Donor names — design §16 (2026-09-21). Everything about the OPTIONAL public name a donor
// puts on the wall lives here: normalisation, the fixed reserved words, the shipped starter
// blocklist, the capture rule, the rescan, and the one display-state function that BOTH the
// miner's account API and the public wall call, so the two can never disagree about whether
// a name shows.
//
// No dependency on index.js or pool-settings.js on purpose: pool-settings.js imports
// STARTER_BLOCKLIST from here for its default, so a require the other way would be a cycle.
// Every function takes `db` and the already-read settings as parameters.
//
// What a name IS: the label part of a `<label>-donateN` worker name, lowercase, charset
// `a-z0-9_-`, at most MAX_WORKER_NAME_LEN chars — exactly `donor_label` as validateUsername
// returns it after the cut (lib/stratum-protocol.js). It is stored as typed (post-fold); only
// the MATCHING is done on a normalised form.
//
// What a name is NOT: an identity. Stratum login is unauthenticated, so the capture rule
// (captureDonorName) only ever runs on the from-zero set that the caller has already gated
// behind PROOF_MIN_SHARES — see the §16.4 note at the call site in stratum-server.js.

const { MAX_WORKER_NAME_LEN } = require('./stratum-protocol');

// The public marker the operator MAY choose instead of the masked address for a censored
// name (`donor_censored_display` = 'marker'). Off by default: a visible "censored" is the
// reaction a troll wants (§16.1 #5). displayState is the only place that emits it.
const CENSORED_MARKER = '<censored-donor>';

// Fixed impersonation words, always applied whatever the operator's list says. The pool's
// own name is added at match time (poolName parameter).
const RESERVED = Object.freeze([
  'admin', 'official', 'operator', 'support', 'staff', 'pool', 'grinium', 'prize', 'jackpot',
  'winner'
]);

// Starter operator list — the DEFAULT of the `donor_name_blocklist` setting, not a rule.
// Compact English profanity + slurs; the operator's own words are the real list (§16.1 #6).
// Matched as a substring of the normalised name, so false positives are expected and
// documented (`classic` ⊃ `ass`) — the fix is the admin un-censor, which sets `allow`.
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
// mapped back. `a55-h0le` → `asshole`. Applied to BOTH sides of every comparison.
function normalise(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[-_]/g, '')
    .replace(/[013457]/g, (c) => LEET[c]);
}

// The operator's list text → normalised entries, in order, empties dropped. Split on newlines
// only; never a RegExp built from operator text (a stray `(` would throw on every capture).
// Each entry keeps its as-typed spelling for the admin badge (`auto: "word"`).
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
// matching. A one- or two-character pool name would censor nearly every donor, which is
// not what "reserved" means; three characters is the shortest brand this guards.
function poolNameEntry(poolName) {
  const norm = normalise(poolName);
  return norm.length >= 3 ? { entry: String(poolName).trim(), norm } : null;
}

// First matching entry (as typed) or null. Reserved words first (fixed, then the pool name),
// then the operator's list in order. Substring on the normalised name.
//
// Two layers on purpose: matchEntries takes the list ALREADY PARSED, so a caller that walks
// many names (rescanAll) parses the text once — parseList normalises every entry, and at the
// validator's ceiling (4000 entries) doing that per name cost ~1 s for 300 names on the shared
// synchronous connection, i.e. a one-second stall of share intake on every list save (Part 5
// review, 2026-09-21). matchBlocklist is the one-name convenience over it.
function matchEntries(name, entries, poolEntry) {
  const n = normalise(name);
  if (n === '') return null;
  for (const word of RESERVED) {
    if (n.includes(word)) return word;
  }
  if (poolEntry && n.includes(poolEntry.norm)) return poolEntry.entry;
  for (const { entry, norm } of entries) {
    if (n.includes(norm)) return entry;
  }
  return null;
}
function matchBlocklist(name, listText, poolName) {
  return matchEntries(name, parseList(listText), poolNameEntry(poolName));
}

const nowUnix = () => Math.floor(Date.now() / 1000);

// The label validateUsername hands over is already lowercase and inside the charset; this is
// the contract check for any other caller. A label that fails it is a programming error, not
// user input — refuse loudly rather than store something the wall cannot render.
const LABEL_RE = new RegExp(`^[a-z0-9_-]{1,${MAX_WORKER_NAME_LEN}}$`);

// §16.4 — write the donor name for `address` from the login label. The CALLER guarantees this
// is the from-zero branch (stored % was 0, new % > 0) and that setDonation returned true; this
// function does not re-check that, because it cannot know the session.
//   label ''/null  → clear donor_name (a plain `donateN` after a branded one removes the name).
//                    A label with no letter or digit in it (`--donate10` → `-`, `_-_-donate10`
//                    → `_-_`) is the same case: it is inside the grammar, so validateUsername
//                    hands it over as typed, but it normalises to nothing, matches nothing, and
//                    would head a card as the "name" `-`. Treated as no label here, where what a
//                    name IS is decided (Part 5 review, 2026-09-21).
//   donor_censor 'admin' → sticky: the new name is stored but stays censored (§16.1 #4).
//   donor_censor 'allow' → override: stored, never auto-matched.
//   otherwise      → stored, then 'auto' + the matching word, or NULL when clean.
// Reserved and list hits are STORED, not refused — the name exists, it just never displays.
// donor_name_set_at is written on every call (it drives the admin NEW badge, and on a clear it
// records when the name went away). Returns { name, censor, word } as now stored.
function captureDonorName(db, address, label, opts = {}) {
  const now = Number.isFinite(opts.now) ? Math.floor(opts.now) : nowUnix();
  let name = label == null || label === '' ? null : String(label).toLowerCase();
  if (name !== null && !LABEL_RE.test(name)) {
    throw new Error(`donor label "${label}" is outside the worker-name grammar`);
  }
  if (name !== null && normalise(name) === '') name = null; // separators only — no name

  db.prepare('INSERT OR IGNORE INTO miner_incentives (grin_address) VALUES (?)').run(address);
  const row = db.prepare(
    'SELECT donor_censor, donor_censor_word FROM miner_incentives WHERE grin_address = ?'
  ).get(address) || {};
  const censor = row.donor_censor || null;

  if (name === null) {
    // Clear. An `auto` verdict was about the name that is now gone, so it goes with it;
    // `admin` and `allow` are per-ADDRESS decisions and survive (the next name inherits them).
    const keep = censor === 'admin' || censor === 'allow';
    db.prepare(`
      UPDATE miner_incentives
      SET donor_name = NULL, donor_name_set_at = ?,
          donor_censor = CASE WHEN ? THEN donor_censor ELSE NULL END,
          donor_censor_word = CASE WHEN ? THEN donor_censor_word ELSE NULL END,
          donor_censor_at = CASE WHEN ? THEN donor_censor_at ELSE NULL END,
          donor_censor_by = CASE WHEN ? THEN donor_censor_by ELSE NULL END
      WHERE grin_address = ?
    `).run(now, keep ? 1 : 0, keep ? 1 : 0, keep ? 1 : 0, keep ? 1 : 0, address);
    return { name: null, censor: keep ? censor : null, word: keep ? (row.donor_censor_word || null) : null };
  }

  if (censor === 'admin' || censor === 'allow') {
    db.prepare(
      'UPDATE miner_incentives SET donor_name = ?, donor_name_set_at = ? WHERE grin_address = ?'
    ).run(name, now, address);
    return { name, censor, word: censor === 'admin' ? (row.donor_censor_word || null) : null };
  }

  const word = matchBlocklist(name, opts.listText, opts.poolName);
  db.prepare(`
    UPDATE miner_incentives
    SET donor_name = ?, donor_name_set_at = ?,
        donor_censor = ?, donor_censor_word = ?, donor_censor_at = ?, donor_censor_by = NULL
    WHERE grin_address = ?
  `).run(name, now, word ? 'auto' : null, word, word ? now : null, address);
  return { name, censor: word ? 'auto' : null, word };
}

// Re-run the auto-list over every stored name after the operator saves the list (§16.5 #2).
// Walks NAMES, not shares: one row per address with a donor_name, and only the rows the list
// is allowed to decide — `admin` (sticky) and `allow` (override) are skipped. Bounded by the
// number of donors who ever set a name, which is small by construction (each one cost a
// from-zero ceremony). Returns
//   scanned  — rows walked
//   censored — rows in `auto` state AFTER the scan (the list's current effect)
//   cleared  — rows that were `auto` and the new list no longer matches (now NULL)
function rescanAll(db, opts = {}) {
  const now = Number.isFinite(opts.now) ? Math.floor(opts.now) : nowUnix();
  const rows = db.prepare(`
    SELECT grin_address, donor_name, donor_censor, donor_censor_word
    FROM miner_incentives
    WHERE donor_name IS NOT NULL AND (donor_censor IS NULL OR donor_censor = 'auto')
  `).all();
  const setAuto = db.prepare(`
    UPDATE miner_incentives
    SET donor_censor = 'auto', donor_censor_word = ?, donor_censor_at = ?, donor_censor_by = NULL
    WHERE grin_address = ?
  `);
  const clear = db.prepare(`
    UPDATE miner_incentives
    SET donor_censor = NULL, donor_censor_word = NULL, donor_censor_at = NULL, donor_censor_by = NULL
    WHERE grin_address = ?
  `);
  let censored = 0, cleared = 0;
  // Parse the list ONCE for the whole walk (see matchEntries) — never per row.
  const entries = parseList(opts.listText);
  const poolEntry = poolNameEntry(opts.poolName);
  const run = db.transaction(() => {
    for (const r of rows) {
      const word = matchEntries(r.donor_name, entries, poolEntry);
      if (word) {
        censored++;
        // Re-stamp only on a change; an unchanged verdict keeps its original censor_at.
        if (r.donor_censor !== 'auto' || r.donor_censor_word !== word) setAuto.run(word, now, r.grin_address);
      } else if (r.donor_censor === 'auto') {
        cleared++;
        clear.run(r.grin_address);
      }
    }
  });
  run();
  return { scanned: rows.length, censored, cleared };
}

// ── Admin moderation (§16.5 layer 3) ───────────────────────────────────────────────────────
// The per-ADDRESS decision the operator takes from admin → Donors. Both directions are one
// transaction with their audit row (fail-closed, like PoolSettings.updateSection: no admin
// mutation lands without its admin_audit_log row).
//   censor   → 'admin' (sticky: every later rename stays censored until an admin clears it)
//   uncensor → 'allow' (override: the auto-list skips this address from now on)
// State table (current → after):
//   NULL   censor → admin   uncensor → allow      (a pre-emptive allow is legitimate — the
//   auto   censor → admin   uncensor → allow       operator can whitelist `classic` before the
//   admin  censor → 409     uncensor → allow       list ever gains `ass`)
//   allow  censor → admin   uncensor → 409
// Un-censor writes 'allow', never NULL — NULL would hand the name straight back to the
// auto-list on the next save, which is the whack-a-mole §16.1 #4 exists to end. The word is
// cleared either way: it described an auto verdict, and neither admin state is about a word.
// A censor on an address with no name yet is allowed and sticky by design (§16.1 #4).
// Returns { ok:true, address, name, censor, previous } or { ok:false, code:'not_found'|'already' }.
function adminCensor(db, address, opts = {}) {
  const censor = opts.censor !== false;
  const now = Number.isFinite(opts.now) ? Math.floor(opts.now) : nowUnix();
  const adminId = Number.isFinite(opts.adminId) ? opts.adminId : null;
  const ip = opts.ip == null ? null : String(opts.ip);
  const target = censor ? 'admin' : 'allow';

  const run = db.transaction(() => {
    const acct = db.prepare('SELECT 1 FROM miner_accounts WHERE grin_address = ?').get(address);
    if (!acct) return { ok: false, code: 'not_found' };
    db.prepare('INSERT OR IGNORE INTO miner_incentives (grin_address) VALUES (?)').run(address);
    const row = db.prepare(
      'SELECT donor_name, donor_censor FROM miner_incentives WHERE grin_address = ?'
    ).get(address);
    const previous = row.donor_censor || null;
    if (previous === target) return { ok: false, code: 'already', censor: previous };

    db.prepare(`
      UPDATE miner_incentives
      SET donor_censor = ?, donor_censor_word = NULL, donor_censor_at = ?, donor_censor_by = ?
      WHERE grin_address = ?
    `).run(target, now, adminId, address);

    db.prepare(`
      INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
      VALUES (?, ?, 'donor', ?, ?, ?)
    `).run(adminId, censor ? 'donor_censor' : 'donor_uncensor', address,
           JSON.stringify({ name: row.donor_name || null, previous }), ip);

    return { ok: true, address, name: row.donor_name || null, censor: target, previous };
  });
  return run();
}

// Names captured inside the last `days` (7 = the admin NEW badge + the dashboard counter).
// A cleared name (donor_name NULL) is not "new" even though its set_at was just re-stamped.
const NEW_NAME_DAYS = 7;
function countNewNames(db, opts = {}) {
  const now = Number.isFinite(opts.now) ? Math.floor(opts.now) : nowUnix();
  const days = Number.isFinite(opts.days) && opts.days > 0 ? Math.floor(opts.days) : NEW_NAME_DAYS;
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM miner_incentives WHERE donor_name IS NOT NULL AND donor_name_set_at >= ?'
  ).get(now - days * 86400);
  return row ? row.n : 0;
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

// What the public sees for one donor row — THE function for both /api/account/:addr and the
// wall (§16.7). `row` is the miner_incentives row (or null). Returns { name, name_state }:
//   shown    — name displays
//   masked   — no name set (plain donateN): the masked address is what the caller shows
//   censored — auto or admin censor; `name` is CENSORED_MARKER only when censoredDisplay is
//              'marker', else null
//   expired  — the name is older than donor_name_expiry_months, counted from the LATER of the
//              last donation debit and the capture itself (a name that was just re-set through
//              the ceremony is not instantly expired while its first debit is still pending)
// `name` is null for every state but `shown` and the marker case, so a caller that prints
// `name || maskedAddress` is right by construction. Censor outranks expiry: a censored name
// that also aged out is still the operator's decision, and the marker (if chosen) says so.
function displayState(row, opts = {}) {
  if (!row || !row.donor_name) return { name: null, name_state: 'masked' };
  const censor = row.donor_censor;
  if (censor === 'auto' || censor === 'admin') {
    return { name: opts.censoredDisplay === 'marker' ? CENSORED_MARKER : null, name_state: 'censored' };
  }
  const months = boundInt(opts.expiryMonths, 0, 120, 12);
  if (months > 0) {
    const now = Number.isFinite(opts.now) ? Math.floor(opts.now) : nowUnix();
    const ref = Math.max(Number(opts.lastDonatedAt) || 0, Number(row.donor_name_set_at) || 0);
    if (ref > 0 && now >= addMonthsUtc(ref, months)) return { name: null, name_state: 'expired' };
  }
  return { name: row.donor_name, name_state: 'shown' };
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

const CENSORED_DISPLAY_VALUES = Object.freeze(['masked', 'marker']);

// `section` is PoolSettings.getSection('incentives'); `poolName` is pool_info.pool_name.
function donorSettings(section, poolName) {
  const s = section || {};
  const display = String(s.donor_censored_display || '').trim().toLowerCase();
  return {
    listText: typeof s.donor_name_blocklist === 'string' ? s.donor_name_blocklist : STARTER_BLOCKLIST.join('\n'),
    poolName: poolName == null ? '' : String(poolName),
    censoredDisplay: CENSORED_DISPLAY_VALUES.includes(display) ? display : 'masked',
    rankWindowDays: boundInt(s.donor_rank_window_days, 0, 3650, 365),
    loyaltyPercentPerMonth: boundNum(s.donor_loyalty_percent_per_month, 0, 100, 10),
    loyaltyCap: boundNum(s.donor_loyalty_cap, 1, 100, 3),
    nameExpiryMonths: boundInt(s.donor_name_expiry_months, 0, 120, 12)
  };
}

module.exports = {
  CENSORED_MARKER,
  CENSORED_DISPLAY_VALUES,
  RESERVED,
  STARTER_BLOCKLIST,
  normalise,
  parseList,
  poolNameEntry,
  matchEntries,
  matchBlocklist,
  captureDonorName,
  rescanAll,
  adminCensor,
  countNewNames,
  NEW_NAME_DAYS,
  displayState,
  donorSettings,
  addMonthsUtc
};
