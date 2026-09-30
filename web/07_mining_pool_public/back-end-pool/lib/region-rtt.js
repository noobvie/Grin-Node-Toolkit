'use strict';

// hub↔gateway round-trip time, per region, for GET /api/pool/stats/regions → hub_rtt_ms.
//
// Source: index.js refreshStratumProbes() TCP-dials every region's PUBLIC stratum host:port from
// this box once a minute. A TCP connect completes after one SYN / SYN-ACK exchange, so the
// connect time (timed from after DNS resolution, see probeStratumTcp) is about one hub↔gateway
// RTT — the same network path the region's WireGuard tunnel takes back to this hub.
// It feeds the connect page's EFFECTIVE latency estimate (viewer→gateway + gateway→hub): a gateway
// ends the miner's TCP connection but does not shorten the trip to the hub, so without this second
// leg a far-away viewer is sent to a near gateway that is slower than connecting directly.
//
// Pure: no I/O, no clock. Kept out of index.js because index.js starts a server on require, and
// this is behaviour worth testing, not text (scripts/test-regions.js).

// Last N SUCCESSFUL samples. A failed dial adds nothing (it measures no path) and clears nothing:
// a region that is down reports status 'offline', and a consumer skips offline regions.
const RTT_WINDOW = 5;

// Append one sample to a region's window (a plain array), keeping the newest RTT_WINDOW.
// Non-finite / negative values are ignored. Returns the (new) array.
function pushRttSample(win, ms) {
  const prev = Array.isArray(win) ? win : [];
  if (!(typeof ms === 'number' && Number.isFinite(ms) && ms >= 0)) return prev.slice(-RTT_WINDOW);
  return prev.slice(-(RTT_WINDOW - 1)).concat(ms);
}

// The value published as hub_rtt_ms:
//   · isHub (this box's own region)  → 0 — connecting there IS connecting to the hub;
//   · no sample in the window        → null (never probed, or never reachable) — unknown, not 0;
//   · otherwise the MIN of the window, rounded to an integer ms. Min, not mean: queueing and
//     scheduling only ever ADD delay, so the lowest sample is the closest to the path's RTT.
function hubRttMs(win, isHub) {
  if (isHub) return 0;
  if (!Array.isArray(win) || !win.length) return null;
  return Math.round(Math.min.apply(null, win));
}

module.exports = { RTT_WINDOW, pushRttSample, hubRttMs };
