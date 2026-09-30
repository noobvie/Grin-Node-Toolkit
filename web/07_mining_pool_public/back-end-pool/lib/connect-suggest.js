'use strict';

// "Best server for you" on the connect page (P-05) — the ESTIMATE, for GET /api/pool/connect/suggest.
//
// The principle: a Model C gateway ends the miner's TCP connection but does NOT shorten the trip
// to the hub — every share still crosses gateway→hub before it counts. So the number that matters
// is EFFECTIVE latency:
//     via a gateway = viewer→gateway + gateway→hub (hub_rtt_ms, lib/region-rtt.js)
//     direct        = viewer→hub
// Ranking gateways by viewer→gateway alone would send a Singapore visitor to Hong Kong when
// connecting straight to a Gravelines hub is faster (SG→Gravelines ~150 ms direct, vs SG→HK plus
// an HK→EU leg of 160–250 ms depending on the HK provider's route).
//
// This is an estimate from geography, shown instantly; the browser's own measurement
// (reactor-dashboard.js, timing each server's /ping) replaces it where it succeeds and falls back
// to it where it does not.
//
// PRIVACY: the viewer is placed at their COUNTRY centroid (lib/geoip.js) — country level only,
// never finer — and that position is never returned. The caller passes a country code and gets
// back per-region milliseconds; neither the IP nor the country is stored, logged or echoed.
//
// Pure: no I/O, no clock, no DB. index.js starts a server on require, so the behaviour lives here
// where scripts/test-connect-suggest.js can run it for real.

const geoip = require('./geoip');

// RTT milliseconds per great-circle km. Calibrated against Globalping measurements to OVH
// Gravelines on 2026-09-23 (one probe set, same day):
//   Frankfurt  ~470 km    →   9 ms (est  7, −21%)   Ashburn   ~6,100 km → 84 ms (est 91, +9%)
//   Singapore  ~10,700 km → 148–162 ms (est 161)    Hong Kong ~9,500 km → 159–182 ms on good
//                                                   routes (est 143, −10…−22%)
// 0.015 lands within ±25% of every one of them. It is a planning figure, not a law: real routes
// detour (HK→EU varied by ~100 ms between providers), which is why a measurement wins over it.
const DEFAULT_K = 0.015;

// Prefer DIRECT unless a gateway beats it by more than this. A gateway is one more trusted box in
// the path (it vouches for the miner's IP — audit §J16-2) and one more thing that can go down, so
// a near-tie goes to the hub. Also larger than the estimate's own noise at short distances.
const DEFAULT_DIRECT_BIAS_MS = 15;

const EARTH_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

// Great-circle distance in km between two { lat, lng }.
function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// A region's position: its operator-declared lat/lng when both are set (the server's own public
// location), else its country centroid, else null (no estimate for it). `byCentroid` says which.
function regionPosition(r, centroid) {
  const lat = r.lat == null ? NaN : Number(r.lat);
  const lng = r.lng == null ? NaN : Number(r.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, byCentroid: false };
  const c = r.country_code ? centroid(r.country_code) : null;
  return c ? { lat: c.lat, lng: c.lng, byCentroid: true } : null;
}

// Typical distance inside a country, in km — its half-extent from geoip's table (degrees × 111).
// Used when the viewer and a server are BOTH placed at the same country's centroid: their
// distance then computes as 0 km, which treats every visitor in that country as sitting in the
// server's datacenter. The seeded regions carry no lat/lng, so without this a US visitor was
// sent to a US gateway on its link home alone, even where connecting direct was as fast.
// Declaring the gateway's lat/lng (admin → Regions) replaces this guess with geometry.
const KM_PER_DEG = 111;
function inCountryKm(cc) {
  const c = geoip.COUNTRIES[String(cc || '').toUpperCase()];
  return ((c && c.s) || 1.5) * KM_PER_DEG;
}

// The ranking rule on its own: rows [{ region, ms, direct }] → the region tag to recommend, or
// null. Lowest ms wins, a tie breaks on the tag, and the direct row wins whenever it is within
// `directBiasMs` of the best gateway. Rows without a finite ms are ignored.
// ⚠ public_html/js/reactor-dashboard.js carries a copy of this function: the page re-ranks with
// the browser's own measurements, and the web root deploys apart from this app, so it cannot
// require this file. The page takes the bias from /api/public/branding
// (connection.latency.direct_bias_ms) rather than a literal, and scripts/test-connect-suggest.js
// [h] runs both copies on the same inputs. Change both or neither.
function pickRecommended(rows, directBiasMs = DEFAULT_DIRECT_BIAS_MS) {
  const bias = Number.isFinite(directBiasMs) && directBiasMs >= 0 ? directBiasMs : DEFAULT_DIRECT_BIAS_MS;
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.region && typeof r.ms === 'number' && Number.isFinite(r.ms))
    .sort((a, b) => (a.ms - b.ms) || (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
  if (!list.length) return null;
  const best = list[0];
  const directRow = list.find((r) => r.direct === true);
  return (directRow && best.direct !== true && directRow.ms - best.ms <= bias) ? directRow.region : best.region;
}

// estimate({ viewerCc, regions, K, directBiasMs }) → { recommended, estimates:[{ region, est_ms, via }] }
//   regions: rows shaped like /api/pool/stats/regions (region, is_hub, hub_rtt_ms, status) plus
//            lat/lng/country_code. Rows the caller did not publish (inactive, no stratum_url)
//            must be filtered out BEFORE calling — this function only judges reachability.
//   via:     'direct' for the is_hub row, 'gateway' otherwise.
//   recommended: a region tag, or null when there is nothing to recommend (unknown country, or no
//            region with a usable estimate).
// Skipped rows get no estimate at all (rather than a misleading one):
//   · status 'offline' — a miner cannot connect there;
//   · a gateway with hub_rtt_ms null — its second leg is unknown, and a figure without it is
//     exactly the misleading viewer→gateway-only number this module exists to avoid;
//   · no position (no lat/lng and no country centroid on file).
// A server placed by the viewer's OWN country centroid is taken to be inCountryKm() away, not 0.
function estimate({ viewerCc, regions, K = DEFAULT_K, directBiasMs = DEFAULT_DIRECT_BIAS_MS,
  centroid = geoip.countryCentroid, spreadKm = inCountryKm } = {}) {
  const none = { recommended: null, estimates: [] };
  const viewer = viewerCc ? centroid(viewerCc) : null;
  if (!viewer) return none;
  const k = Number.isFinite(K) && K > 0 ? K : DEFAULT_K;
  const bias = Number.isFinite(directBiasMs) && directBiasMs >= 0 ? directBiasMs : DEFAULT_DIRECT_BIAS_MS;

  const scored = [];
  for (const r of Array.isArray(regions) ? regions : []) {
    if (!r || !r.region || r.status === 'offline') continue;
    const direct = r.is_hub === true;
    const leg2 = direct ? 0 : r.hub_rtt_ms;
    if (!(typeof leg2 === 'number' && Number.isFinite(leg2) && leg2 >= 0)) continue;
    const pos = regionPosition(r, centroid);
    if (!pos) continue;
    let km = haversineKm(viewer, pos);
    if (pos.byCentroid && String(r.country_code).toUpperCase() === String(viewerCc).toUpperCase()) {
      km = Math.max(km, spreadKm(viewerCc));
    }
    scored.push({ region: String(r.region), raw: km * k + leg2, direct });
  }
  if (!scored.length) return none;

  // Lowest first; a tie breaks on the tag so the answer is stable across calls.
  scored.sort((a, b) => (a.raw - b.raw) || (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
  const recommended = pickRecommended(scored.map((s) => ({ region: s.region, ms: s.raw, direct: s.direct })), bias);

  return {
    recommended,
    estimates: scored.map((s) => ({
      region: s.region,
      est_ms: Math.max(1, Math.round(s.raw)),
      via: s.direct ? 'direct' : 'gateway',
    })),
  };
}

module.exports = { DEFAULT_K, DEFAULT_DIRECT_BIAS_MS, haversineKm, regionPosition, inCountryKm, pickRecommended, estimate };
