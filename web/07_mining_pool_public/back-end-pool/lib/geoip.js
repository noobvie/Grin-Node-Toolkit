// lib/geoip.js — country-only geolocation for the public network map.
//
// PRIVACY CONTRACT (matches the pool's address-as-identity / hidden-IP design):
// this module maps an IP to a COUNTRY CODE ONLY, at the moment the IP is transiently
// available (a miner's first accepted share; a node peer snapshot). The IP itself is
// never returned to callers, never stored, never logged. Downstream tables keep only
// the 2-letter country code + a display name — no city, no coordinates, no IP. Map
// positions are RANDOMIZED within the country (placeInCountry) so a dot is never a
// real location and can never be traced to an individual.
//
// Backend: optional `geoip-lite` (bundled offline country DB, MIT-licensed, no API key).
// When the package is not installed, available() is false and lookupCountry() returns
// null — every consumer degrades gracefully (the map falls back to grouping miners by
// the country of the GATEWAY they connect through). Enable true per-miner country with:
//   cd back-end-pool && npm install geoip-lite     (~30 MB bundled data)

let _geo = null, _tried = false;
function _lib() {
  if (_tried) return _geo;
  _tried = true;
  try {
    _geo = require('geoip-lite');
  } catch (_) {
    _geo = null;
    console.warn('[geoip] geoip-lite not installed — per-miner country attribution disabled ' +
      '(network map falls back to gateway country). Run `npm install geoip-lite` to enable.');
  }
  return _geo;
}

function available() { return !!_lib(); }

// IP → { cc, name } | null. cc is an uppercase ISO-3166-1 alpha-2. Private / reserved /
// loopback / unknown addresses resolve to null (no country attributed).
function lookupCountry(ip) {
  const lib = _lib();
  if (!lib || !ip) return null;
  try {
    const r = lib.lookup(String(ip).trim());
    if (!r || !r.country) return null;
    const cc = String(r.country).toUpperCase();
    const c = COUNTRIES[cc];
    return { cc, name: c ? c.n : cc };
  } catch (_) { return null; }
}

// Country display name for a code (falls back to the code itself).
function countryName(cc) {
  const c = COUNTRIES[String(cc || '').toUpperCase()];
  return c ? c.n : String(cc || '').toUpperCase();
}

// Deterministic in-country RANDOMIZED position for a country code. Returns
// { lat, lng } jittered ±~4.5° around the country centroid, seeded by `key` so the
// same miner/gateway keeps a stable (but fake) spot across polls. null if the code has
// no centroid on file (caller then omits the globe dot; the donut share still counts).
function placeInCountry(cc, key = '') {
  const c = COUNTRIES[String(cc || '').toUpperCase()];
  if (!c) return null;
  // cheap deterministic hash → two [0,1) values
  let h = 2166136261;
  const s = String(cc) + '|' + String(key);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  const r1 = ((h >>> 0) % 1000) / 1000;
  const r2 = (((Math.imul(h, 48271) >>> 0)) % 1000) / 1000;
  const spread = c.s || 4.5;
  return {
    lat: Math.max(-85, Math.min(85, c.lat + (r1 - 0.5) * 2 * spread)),
    lng: c.lng + (r2 - 0.5) * 2 * spread
  };
}

// cc → { n: name, lat, lng, s?: jitter-spread override (large countries spread wider) }.
// Approximate population/land centroids — plenty for a randomized country-level dot.
const COUNTRIES = {
  AE: { n: 'United Arab Emirates', lat: 24.0, lng: 54.0 },
  AR: { n: 'Argentina', lat: -35, lng: -64, s: 7 },
  AT: { n: 'Austria', lat: 47.6, lng: 14.1 },
  AU: { n: 'Australia', lat: -25, lng: 134, s: 8 },
  BD: { n: 'Bangladesh', lat: 23.7, lng: 90.4 },
  BE: { n: 'Belgium', lat: 50.6, lng: 4.6 },
  BG: { n: 'Bulgaria', lat: 42.7, lng: 25.3 },
  BR: { n: 'Brazil', lat: -10, lng: -52, s: 9 },
  CA: { n: 'Canada', lat: 58, lng: -100, s: 10 },
  CH: { n: 'Switzerland', lat: 46.8, lng: 8.2 },
  CL: { n: 'Chile', lat: -35, lng: -71, s: 6 },
  CN: { n: 'China', lat: 35, lng: 104, s: 8 },
  CO: { n: 'Colombia', lat: 4.6, lng: -74 },
  CZ: { n: 'Czechia', lat: 49.8, lng: 15.5 },
  DE: { n: 'Germany', lat: 51, lng: 10, s: 3 },
  DK: { n: 'Denmark', lat: 56, lng: 9.5 },
  EG: { n: 'Egypt', lat: 26.8, lng: 30.8 },
  ES: { n: 'Spain', lat: 40, lng: -4, s: 4 },
  FI: { n: 'Finland', lat: 64, lng: 26, s: 5 },
  FR: { n: 'France', lat: 47, lng: 2, s: 4 },
  GB: { n: 'United Kingdom', lat: 54, lng: -2, s: 4 },
  GR: { n: 'Greece', lat: 39, lng: 22 },
  HK: { n: 'Hong Kong', lat: 22.3, lng: 114.2, s: 0.3 },
  HU: { n: 'Hungary', lat: 47.2, lng: 19.5 },
  ID: { n: 'Indonesia', lat: -2, lng: 118, s: 8 },
  IE: { n: 'Ireland', lat: 53.2, lng: -8 },
  IL: { n: 'Israel', lat: 31.5, lng: 34.9 },
  IN: { n: 'India', lat: 22, lng: 79, s: 7 },
  IR: { n: 'Iran', lat: 32, lng: 53, s: 5 },
  IT: { n: 'Italy', lat: 42.8, lng: 12.8, s: 4 },
  JP: { n: 'Japan', lat: 36, lng: 138, s: 3 },
  KR: { n: 'South Korea', lat: 36.5, lng: 128 },
  KZ: { n: 'Kazakhstan', lat: 48, lng: 68, s: 7 },
  MX: { n: 'Mexico', lat: 23, lng: -102, s: 5 },
  MY: { n: 'Malaysia', lat: 4, lng: 102, s: 4 },
  NL: { n: 'Netherlands', lat: 52.2, lng: 5.3, s: 2 },
  NO: { n: 'Norway', lat: 62, lng: 10, s: 5 },
  NZ: { n: 'New Zealand', lat: -41, lng: 173, s: 3 },
  PH: { n: 'Philippines', lat: 12.9, lng: 122, s: 4 },
  PL: { n: 'Poland', lat: 52, lng: 19, s: 3 },
  PT: { n: 'Portugal', lat: 39.6, lng: -8 },
  RO: { n: 'Romania', lat: 45.9, lng: 25 },
  RS: { n: 'Serbia', lat: 44, lng: 21 },
  RU: { n: 'Russia', lat: 60, lng: 90, s: 12 },
  SA: { n: 'Saudi Arabia', lat: 24, lng: 45, s: 5 },
  SE: { n: 'Sweden', lat: 62, lng: 15, s: 5 },
  SG: { n: 'Singapore', lat: 1.35, lng: 103.82, s: 0.2 },
  TH: { n: 'Thailand', lat: 15, lng: 101, s: 4 },
  TR: { n: 'Turkey', lat: 39, lng: 35, s: 4 },
  TW: { n: 'Taiwan', lat: 24, lng: 121, s: 1 },
  UA: { n: 'Ukraine', lat: 49, lng: 32, s: 4 },
  US: { n: 'United States', lat: 39, lng: -98, s: 9 },
  VN: { n: 'Vietnam', lat: 16, lng: 108, s: 4 },
  ZA: { n: 'South Africa', lat: -29, lng: 24, s: 5 }
};

module.exports = { available, lookupCountry, countryName, placeInCountry, COUNTRIES };
