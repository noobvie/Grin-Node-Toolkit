'use strict';

// Event badges (design §19.9). A badge id comes from THIS list, never from free text: an
// operator picks one per reward tier, and players.badges_json stores ids only. So a badge
// can never carry markup, a link or a lookalike of the operator's name, and the label a
// browser shows is ours.
//
// Ids are ≤ 24 chars (§19.9). Adding one is a code change; removing one leaves it in old
// players' badges_json, where parseBadges() drops it quietly (a label we no longer have).

const BADGES = Object.freeze({
  gold:       'Gold',
  silver:     'Silver',
  bronze:     'Bronze',
  top10:      'Top 10',
  champion:   'Champion',
  marathon:   'Marathon miner',
  regular:    'Every day',
  took_part:  'Took part',
});

const BADGE_ID_RE = /^[a-z0-9_]{1,24}$/;
// players.badges_json never grows past this. An address that somehow reaches it keeps its
// earlier badges and gets no more; the event's own results still record the badge.
const MAX_BADGES_PER_PLAYER = 500;

const isBadge = (id) => typeof id === 'string' && BADGE_ID_RE.test(id) && Object.prototype.hasOwnProperty.call(BADGES, id);

// players.badges_json → [{ id, event }] (only well-formed entries with a known id). The
// column is ours, but it is read defensively: one bad row must not break /me.
function parseBadges(json) {
  let arr;
  try { arr = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const b of arr) {
    if (b && typeof b === 'object' && isBadge(b.id) && Number.isSafeInteger(b.event) && b.event > 0) {
      out.push({ id: b.id, event: b.event });
    }
  }
  return out;
}

// For a response: [{ id, label, event_id }].
function publicBadges(json) {
  return parseBadges(json).map((b) => ({ id: b.id, label: BADGES[b.id], event_id: b.event }));
}

module.exports = { BADGES, isBadge, parseBadges, publicBadges, MAX_BADGES_PER_PLAYER };
