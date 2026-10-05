'use strict';

// The name rule v2 (design §19.17.5, D27/D28) — pure functions, no state, no I/O.
//
// TWO COPIES: this file and back-end-pool/lib/name-rule.js. D5 forbids the games service
// loading pool code (and the pool never loads ours), so the rule is copied, and ONE fixture
// file — scripts/fixtures/name-rule.json — drives both: test-names.js here and
// back-end-pool/scripts/test-name-rule.js there both run every case in it, and the pool test
// also compares the SEED and EXCEPTIONS literals below with its own. Change both copies and the
// fixture together, or one suite goes red (§19.13 #24).
//
// What a name must be: 3–20 characters of A–Z a–z 0–9, at least one letter. ASCII only, so a
// look-alike letter (Cyrillic а), a bidi override or a zero-width character is refused, never
// normalised away.
//
// The MATCHING FORM — what every uniqueness, ban and word check compares: lower-case,
// separators removed (only donor names can hold any), the leet digits 0 1 3 4 5 7 folded to
// o i e a s t. `M0d` → `mod`, `B-o-b` → `bob`.
//
// THE SCUNTHORPE RULE (§19.13 #25), for reserved AND blocked words alike — the pool's donor
// flag list was matched as a substring and accepted `classic` ⊃ `ass` because a human read
// every hit; an automatic verdict cannot:
//   - an entry of ≤ 4 characters matches only the WHOLE name. "Whole" is tested on two forms:
//     the name with its leading and trailing digit runs stripped, then folded (`Mod1` → `mod`),
//     and the whole name folded (`A55` → `ass` — stripping first would leave `a`).
//   - an entry of ≥ 5 characters matches as a substring of the matching form, unless every
//     occurrence lies inside a word on EXCEPTIONS (`badminton` ⊃ `admin`).
//   - an operator entry may override that: a leading `*` forces substring, `=` forces whole.

const NAME_MIN = 3;
const NAME_MAX = 20;
const NAME_RE = /^[A-Za-z0-9]+$/;
const NAME_RULE = `${NAME_MIN}–${NAME_MAX} characters: letters A–Z and digits 0–9 only (no spaces), with at least one letter`;
// The donor shape (§18.5, kept by the operator at C0 — §19.17.6): wider than a nickname, because
// a donor name is often a brand. Only the pool uses it; it lives here so both copies stay one code.
const DONOR_MIN = 2;
const DONOR_MAX = 32;
const DONOR_RE = /^[A-Za-z0-9 \-_.&']+$/;
const DONOR_RULE = `${DONOR_MIN}–${DONOR_MAX} characters: letters, digits, spaces and - _ . & ' only, with at least one letter or digit`;
const ENTRY_MAX = 40;          // a chat word may be 40; the pool's own list is capped at 32 on write
const WHOLE_MAX = 4;           // ≤ this many characters → whole-name match by default

const SEPARATORS = /[\s\-_.&']/g;
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' };
function matchForm(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(SEPARATORS, '')
    .replace(/[013457]/g, (c) => LEET[c]);
}
function fold(s) { return s.replace(/[013457]/g, (c) => LEET[c]); }

// The forms a whole-name entry is compared with, equal-or-nothing: the name with its leading and
// trailing digit runs stripped, then folded, and the whole name folded. A name with separators
// (donor names only) adds the same two forms for each of its words, so `Big Ass` hits `ass` the
// way `Ass` does — a word boundary the name itself drew costs no innocent name.
function wholeForms(name) {
  const lower = String(name == null ? '' : name).toLowerCase();
  const out = [];
  const add = (w) => { out.push(fold(w.replace(/^[0-9]+/, '').replace(/[0-9]+$/, '')), fold(w)); };
  add(lower.replace(SEPARATORS, ''));
  const words = lower.split(SEPARATORS).filter((w) => w !== '');
  if (words.length > 1) words.forEach(add);
  return out;
}

// Words that may appear in a name but whose role in the page would be a badge's: refused.
// The pool's own name is added from the config route (pool-link.js), when it folds to ≥ 3
// characters.
const RESERVED = Object.freeze([
  'operator', 'moderator', 'admin', 'official', 'support', 'staff', 'grinium', 'deleted',
  'mod', 'bot', 'pool',
]);
// Refused as a PREFIX of the matching form: no one may wear another guest's `Guest-XXXX` label.
const RESERVED_PREFIXES = Object.freeze(['guest']);
// A donor name's reserved words: §16.4's list (the words that would make a card read as the
// pool's own, or as a prize), under the same Scunthorpe rule. No prefixes — a donor card never
// shows a `Guest-XXXX` label.
const DONOR_RESERVED = Object.freeze([
  'admin', 'official', 'operator', 'support', 'staff', 'pool', 'grinium', 'prize', 'jackpot',
  'winner',
]);

// Substring hits that are innocent words. Matched as substrings of the matching form, so
// `prickl` covers prickly and prickle. Short on purpose: an operator who needs more uses `=`.
const EXCEPTIONS = Object.freeze([
  'badminton', 'staffy', 'staffie', 'stafford', 'therapist', 'snigger', 'retardant', 'prickl',
  'cooperator', 'supporter', 'breadwinner', 'supportiv', 'peniston',
]);

// The code seed of the blocked list, applied even when the pool has never answered. It is the
// pool's STARTER_BLOCKLIST (back-end-pool/lib/donor-names.js) with two entries forced to
// substring: no innocent name contains them, and as whole-only they would let `FuckYou` by.
const SEED = Object.freeze([
  'anal', 'anus', 'arse', 'ass', 'asshole', 'bastard', 'bitch', 'blowjob', 'boner', 'chink',
  'clit', 'cock', 'cocksucker', 'coon', 'cunt', 'dick', 'dildo', 'douche', 'dyke', 'fag',
  'faggot', '*fuck', 'gook', 'handjob', 'hitler', '*jizz', 'kike', 'motherfucker', 'nazi',
  'nigga', 'nigger', 'paedo', 'pedo', 'penis', 'piss', 'porn', 'prick', 'pussy', 'rape',
  'rapist', 'retard', 'scum', 'shit', 'slut', 'spic', 'tits', 'tranny', 'twat', 'wanker',
  'wetback', 'whore',
]);

// One list entry → { entry, norm, whole } | null. `entry` is the line as given (shown to the
// admin only). An entry that is empty, too long, or folds to anything but a–z 0–9 can never
// match an ASCII name, so it is dropped rather than refused here (the pool's validator refuses
// it on write; a chat word with an accent is simply not a name word).
function parseEntry(raw, max = ENTRY_MAX) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  let force = null;
  if (s.startsWith('*')) { force = false; s = s.slice(1); }
  else if (s.startsWith('=')) { force = true; s = s.slice(1); }
  const norm = matchForm(s);
  if (!/^[a-z0-9]+$/.test(norm) || norm.length > max) return null;
  return { entry: raw.trim(), norm, whole: force === null ? norm.length <= WHOLE_MAX : force };
}

// A list (array of strings) → parsed entries, duplicates out. Parse once per list, not per name.
function compileList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const e = parseEntry(raw);
    if (!e) continue;
    const key = `${e.whole ? '=' : '*'}${e.norm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// The pool's name as a reserved entry, or null when it folds to < 3 characters (a one- or
// two-letter pool name would refuse nearly every name; same floor as the donor flags).
// pool_info.pool_name is free text, so accents are stripped and every other character outside
// a–z 0–9 (`!`, brackets, `#`, `™`, an emoji) is DROPPED — never a reason to reserve nothing:
// `Night Owl Mining!` reserves `nightowlmining` like `Night Owl Mining` does (R1 review).
function poolNameEntry(poolName) {
  const bare = String(poolName == null ? '' : poolName).normalize('NFD').replace(/[̀-ͯ]/g, '');
  const norm = matchForm(bare).replace(/[^a-z0-9]/g, '');
  if (norm.length < 3) return null;
  return { entry: String(poolName).trim(), norm, whole: norm.length <= WHOLE_MAX };
}

function substringHit(form, needle) {
  let i = form.indexOf(needle);
  while (i !== -1) {
    const covered = EXCEPTIONS.some((w) => {
      if (!w.includes(needle)) return false;
      for (let j = form.indexOf(w); j !== -1; j = form.indexOf(w, j + 1)) {
        if (j <= i && i + needle.length <= j + w.length) return true;
      }
      return false;
    });
    if (!covered) return true;
    i = form.indexOf(needle, i + 1);
  }
  return false;
}

// → the first entry the name hits, or null.
function firstHit(entries, form, wholes) {
  for (const e of entries) {
    if (e.whole ? wholes.includes(e.norm) : substringHit(form, e.norm)) return e;
  }
  return null;
}

const RESERVED_ENTRIES = Object.freeze(compileList(RESERVED));
const DONOR_RESERVED_ENTRIES = Object.freeze(compileList(DONOR_RESERVED));
const SEED_ENTRIES = Object.freeze(compileList(SEED));

// The two shapes. `nick` (the default) is a game nickname or a guest sign-up name; `donor` is a
// donor name on the pool's wall. Only the shape and the reserved words differ: the matching form,
// the Scunthorpe rule, the seed and the operator's list are the same for both.
const SHAPES = Object.freeze({
  nick: Object.freeze({
    min: NAME_MIN, max: NAME_MAX, re: NAME_RE, collapse: false,
    needs: /[A-Za-z]/, noLetter: 'name_no_letter',
    reserved: RESERVED_ENTRIES, prefixes: RESERVED_PREFIXES,
  }),
  donor: Object.freeze({
    min: DONOR_MIN, max: DONOR_MAX, re: DONOR_RE, collapse: true,
    needs: /[A-Za-z0-9]/, noLetter: 'name_no_alnum',
    reserved: DONOR_RESERVED_ENTRIES, prefixes: Object.freeze([]),
  }),
});
// An unknown shape is a programming error, never a silent fallback to the looser one.
function shapeOf(shape) {
  if (shape === undefined || shape === null) return SHAPES.nick;
  if (!Object.prototype.hasOwnProperty.call(SHAPES, shape)) throw new Error(`name-rule: unknown shape ${String(shape)}`);
  return SHAPES[shape];
}

// The shape alone → { ok:true, name } | { ok:false, code }. The only refusals that explain
// themselves (with RULE_TEXT / DONOR_RULE_TEXT). A donor name has its ASCII whitespace runs
// collapsed to one space first; only ASCII — a Unicode space is a character outside the set.
function checkShape(raw, shape) {
  const sh = shapeOf(shape);
  if (typeof raw !== 'string') return { ok: false, code: 'name_invalid' };
  const name = (sh.collapse ? raw.replace(/[ \t\r\n\f\v]+/g, ' ') : raw).trim();
  if (name.length < sh.min || name.length > sh.max) return { ok: false, code: 'name_length' };
  if (!sh.re.test(name)) return { ok: false, code: 'name_charset' };
  if (!sh.needs.test(name)) return { ok: false, code: sh.noLetter };
  return { ok: true, name };
}

// The word checks, in the contract's order (§19.17.5, refusals 1–4; banned and taken need the
// database and are the caller's). ctx: { shape: 'nick' (default) | 'donor', poolName, blocked:
// compiled operator list, words: compiled chat word list } — every part optional.
//   → { ok:true, name, norm }
//   | { ok:false, code }                       code = a shape code, or name_address
//   | { ok:false, code, list, entry }          code = name_reserved | name_blocked (list says
//                                              which: reserved | pool_name | prefix | seed |
//                                              operator | chat; for the admin, never a player)
function check(raw, ctx = {}) {
  const sh = shapeOf(ctx.shape);
  const shaped = checkShape(raw, ctx.shape);
  if (!shaped.ok) return shaped;
  const name = shaped.name;
  const lower = name.toLowerCase();
  // Before the leet fold, which would turn the 1 into an i.
  if (lower.startsWith('grin1') || lower.startsWith('tgrin1')) return { ok: false, code: 'name_address' };
  const form = matchForm(name);
  const wholes = wholeForms(name);
  const refuse = (code, list, e) => ({ ok: false, code, list, entry: e.entry });

  let e = firstHit(sh.reserved, form, wholes);
  if (e) return refuse('name_reserved', 'reserved', e);
  const pe = poolNameEntry(ctx.poolName);
  if (pe && firstHit([pe], form, wholes)) return refuse('name_reserved', 'pool_name', pe);
  const px = sh.prefixes.find((p) => form.startsWith(p));
  if (px) return refuse('name_reserved', 'prefix', { entry: px });

  e = firstHit(SEED_ENTRIES, form, wholes);
  if (e) return refuse('name_blocked', 'seed', e);
  e = firstHit(ctx.blocked || [], form, wholes);
  if (e) return refuse('name_blocked', 'operator', e);
  e = firstHit(ctx.words || [], form, wholes);
  if (e) return refuse('name_blocked', 'chat', e);

  return { ok: true, name, norm: form };
}

const RULE_TEXT = Object.freeze({
  name_invalid: `A nickname must be text: ${NAME_RULE}.`,
  name_length: `A nickname must be ${NAME_RULE}.`,
  name_charset: `That nickname has a character that is not allowed. A nickname must be ${NAME_RULE}.`,
  name_no_letter: `A nickname needs at least one letter (${NAME_RULE}).`,
  name_address: 'A nickname cannot look like a GRIN address.',
});
const DONOR_RULE_TEXT = Object.freeze({
  name_invalid: `A donor name must be text: ${DONOR_RULE}.`,
  name_length: `A donor name must be ${DONOR_RULE}.`,
  name_charset: `That name contains a character that is not allowed. A donor name must be ${DONOR_RULE}.`,
  name_no_alnum: `A donor name needs at least one letter or digit (${DONOR_RULE}).`,
  name_address: 'A donor name cannot look like a GRIN address.',
});

module.exports = {
  NAME_MIN, NAME_MAX, NAME_RULE, RULE_TEXT, RESERVED, RESERVED_PREFIXES, EXCEPTIONS, SEED,
  DONOR_MIN, DONOR_MAX, DONOR_RULE, DONOR_RULE_TEXT, DONOR_RESERVED,
  matchForm, wholeForms, parseEntry, compileList, poolNameEntry, checkShape, check,
};
