// lib/geoip.js — country-only geolocation for the public network map.
//
// PRIVACY CONTRACT (matches the pool's address-as-identity / hidden-IP design):
// this module maps an IP to a COUNTRY CODE ONLY, at the moment the IP is transiently
// available (a miner's first accepted share; a node peer snapshot). The IP itself is
// never returned to callers, never stored, never logged. Downstream tables keep only
// the 2-letter country code + a display name — no city, no coordinates, no IP.
//
// Map positions therefore carry NO information beyond the country, and the two helpers
// below say which is which. countryCentroid() is for AGGREGATE markers (hub, gateway,
// miners-of-a-country): the exact centroid, because the country is published in the same
// payload — scattering the point would hide nothing it doesn't already say, and could only
// land the marker in a neighbouring country. placeInCountry() is for the one layer that
// draws many points inside a country (Grin-node twinkles), where the spread is the visual.
// Neither is an anonymisation device: privacy comes from country-only lookup plus the
// k-anonymity floor applied by the endpoints in index.js.
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

// Exact country centroid — { lat, lng }, no jitter. This is the honest position for any
// AGGREGATE marker (hub, gateway, miners-of-a-country): the country is published right
// beside the coordinates in the same payload, so scattering the point hides nothing and
// can only put the dot in the wrong country. `nudge` (0 = none) applies a tiny
// deterministic ring offset, sized to the country, purely so co-located markers — hub
// plus a gateway, or two gateways in one country — don't stack on the same pixel.
// null if the code has no centroid on file (caller omits the globe dot; the donut
// share still counts).
function countryCentroid(cc, nudge = 0) {
  const c = COUNTRIES[String(cc || '').toUpperCase()];
  if (!c) return null;
  if (!nudge) return { lat: c.lat, lng: c.lng };
  // Ring of 6 around the centroid. The radius is HALF the country's own declared
  // half-extent, so by construction the nudge stays inside it however small it is; the
  // absolute cap only stops a continental `s` from throwing the marker hundreds of km.
  // Don't shrink this further — below ~1° the offset is under 5px on screen at zoom 1,
  // which is inside the markers' own glow, so they read as one dot and the nearest-node
  // hit-test still hands every hover to whichever is first in draw order.
  const r = Math.min(1.6, (c.s || DEFAULT_SPREAD) * 0.5);
  const a = ((nudge - 1) % 6) * (Math.PI / 3);
  return {
    lat: Math.max(-85, Math.min(85, c.lat + Math.sin(a) * r)),
    lng: c.lng + Math.cos(a) * r
  };
}

// Deterministic in-country SCATTERED position, seeded by `key`. For layers that draw many
// individual points inside one country (the Grin-node twinkles) — there the spread is the
// visual, not a privacy device. Points stay within ±`s`° of the centroid, and every country
// declares an `s` sized to it: the default is deliberately TIGHT, because a country with no
// override is far more likely to be small than large. Never use this for an aggregate
// marker — use countryCentroid().
function placeInCountry(cc, key = '') {
  const c = COUNTRIES[String(cc || '').toUpperCase()];
  if (!c) return null;
  // cheap deterministic hash → two [0,1) values
  let h = 2166136261;
  const s = String(cc) + '|' + String(key);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  const r1 = ((h >>> 0) % 1000) / 1000;
  const r2 = (((Math.imul(h, 48271) >>> 0)) % 1000) / 1000;
  const spread = c.s || DEFAULT_SPREAD;
  return {
    lat: Math.max(-85, Math.min(85, c.lat + (r1 - 0.5) * 2 * spread)),
    lng: c.lng + (r2 - 0.5) * 2 * spread
  };
}

// Fallback half-extent for a country with no `s`. Kept small on purpose — an unlisted
// country is more often a compact one than a continental one, and a too-wide scatter puts
// points in a NEIGHBOUR (or the sea) while the map outlines the correct country.
const DEFAULT_SPREAD = 1.5;

// cc → { n: name, lat, lng, s?: scatter half-extent in degrees, sized to the country }.
// Approximate population/land centroids — plenty for a country-level marker.
const COUNTRIES = {
  AE: { n: 'United Arab Emirates', lat: 24.0, lng: 54.0, s: 1 },
  AR: { n: 'Argentina', lat: -35, lng: -64, s: 7 },
  AT: { n: 'Austria', lat: 47.6, lng: 14.1, s: 1.5 },
  AU: { n: 'Australia', lat: -25, lng: 134, s: 8 },
  BD: { n: 'Bangladesh', lat: 23.7, lng: 90.4, s: 1.2 },
  BE: { n: 'Belgium', lat: 50.6, lng: 4.6, s: 0.7 },
  BG: { n: 'Bulgaria', lat: 42.7, lng: 25.3, s: 1.5 },
  BR: { n: 'Brazil', lat: -10, lng: -52, s: 9 },
  CA: { n: 'Canada', lat: 58, lng: -100, s: 10 },
  CH: { n: 'Switzerland', lat: 46.8, lng: 8.2, s: 0.8 },
  CL: { n: 'Chile', lat: -35, lng: -71, s: 6 },
  CN: { n: 'China', lat: 35, lng: 104, s: 8 },
  CO: { n: 'Colombia', lat: 4.6, lng: -74, s: 2.5 },
  CZ: { n: 'Czechia', lat: 49.8, lng: 15.5, s: 1.5 },
  DE: { n: 'Germany', lat: 51, lng: 10, s: 3 },
  DK: { n: 'Denmark', lat: 56, lng: 9.5, s: 0.8 },
  EG: { n: 'Egypt', lat: 26.8, lng: 30.8, s: 2.5 },
  ES: { n: 'Spain', lat: 40, lng: -4, s: 4 },
  FI: { n: 'Finland', lat: 64, lng: 26, s: 5 },
  FR: { n: 'France', lat: 47, lng: 2, s: 4 },
  GB: { n: 'United Kingdom', lat: 54, lng: -2, s: 4 },
  GR: { n: 'Greece', lat: 39, lng: 22, s: 1.5 },
  HK: { n: 'Hong Kong', lat: 22.3, lng: 114.2, s: 0.3 },
  HU: { n: 'Hungary', lat: 47.2, lng: 19.5, s: 1.5 },
  ID: { n: 'Indonesia', lat: -2, lng: 118, s: 8 },
  IE: { n: 'Ireland', lat: 53.2, lng: -8, s: 1 },
  IL: { n: 'Israel', lat: 31.5, lng: 34.9, s: 0.6 },
  IN: { n: 'India', lat: 22, lng: 79, s: 7 },
  IR: { n: 'Iran', lat: 32, lng: 53, s: 5 },
  IT: { n: 'Italy', lat: 42.8, lng: 12.8, s: 4 },
  JP: { n: 'Japan', lat: 36, lng: 138, s: 3 },
  KR: { n: 'South Korea', lat: 36.5, lng: 128, s: 1.2 },
  KZ: { n: 'Kazakhstan', lat: 48, lng: 68, s: 7 },
  MX: { n: 'Mexico', lat: 23, lng: -102, s: 5 },
  MY: { n: 'Malaysia', lat: 4, lng: 102, s: 4 },
  NL: { n: 'Netherlands', lat: 52.2, lng: 5.3, s: 2 },
  NO: { n: 'Norway', lat: 62, lng: 10, s: 5 },
  NZ: { n: 'New Zealand', lat: -41, lng: 173, s: 3 },
  PH: { n: 'Philippines', lat: 12.9, lng: 122, s: 4 },
  PL: { n: 'Poland', lat: 52, lng: 19, s: 3 },
  PT: { n: 'Portugal', lat: 39.6, lng: -8, s: 1.2 },
  RO: { n: 'Romania', lat: 45.9, lng: 25, s: 1.8 },
  RS: { n: 'Serbia', lat: 44, lng: 21, s: 1 },
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

module.exports = { available, lookupCountry, countryName, countryCentroid, placeInCountry, COUNTRIES };
