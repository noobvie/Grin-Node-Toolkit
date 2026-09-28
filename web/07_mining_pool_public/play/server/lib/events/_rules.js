'use strict';

// Shared helpers for event-kind modules (design §19.9, D17). Not a kind itself, so it is
// not listed in ./index.js.

class RulesError extends Error {
  // field: which rules key was refused ('rules' for the object itself). Never a value.
  constructor(field) { super(`rules.${field}`); this.field = field; }
}

// The rules object must be a plain object with only the listed keys: an unknown key is
// refused, never ignored, so a typo ("min_game") cannot silently leave the default in force.
function plainRules(rules, allowed) {
  if (rules === undefined || rules === null) rules = {};
  if (typeof rules !== 'object' || Array.isArray(rules)) throw new RulesError('rules');
  for (const k of Object.keys(rules)) if (!allowed.includes(k)) throw new RulesError(k);
  return rules;
}

// An optional integer in [min, max]; `def` when absent. A string "3" is refused, not coerced.
function intField(rules, key, { min, max, def }) {
  const v = rules[key];
  if (v === undefined) return def;
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new RulesError(key);
  return v;
}

function enumField(rules, key, values, def) {
  const v = rules[key];
  if (v === undefined && def !== undefined) return def;
  if (!values.includes(v)) throw new RulesError(key);
  return v;
}

module.exports = { RulesError, plainRules, intField, enumField };
