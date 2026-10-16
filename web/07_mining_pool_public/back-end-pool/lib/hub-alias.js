'use strict';

// One box, one connect card: fold every PUBLISHED row that is really this hub into the hub's own
// (is_hub) row, for GET /api/pool/stats/regions and GET /api/pool/connect/suggest.
//
// How the duplicate arises: a hub MOVE with a new region tag (e.g. main → cqf). ensureLocalRegion
// activates the new tag's row (seeded as cqf.<domain>:3333) and deliberately leaves the old local
// row alone — but that old row names the pool's OWN address (<subdomain>:<stratum_port>, written
// by the old hub's ensureLocalRegion), and that address follows the hub to the new box. Two cards,
// one machine: the alias read as a "gateway" with a few ms of hub_rtt_ms and never any miners
// (direct shares are stamped with the local tag), the real hub row beside it.
//
// The rule is deterministic, never latency-guessed: an ACTIVE row whose stratum endpoint equals
// this box's own <subdomain>:<stratum_port> — the exact string ensureLocalRegion registers — IS
// this box. Only on a singlebox (localRegion set): a bare hub runs no local stratum.
// The merged card keeps the hub row's is_hub / hub_rtt_ms 0 / position, sums the per-region
// counters (direct shares carry the local tag, so the alias's are ~always 0), and wears the
// identity (tag, label, address) of the row at the pool's own address — the address miners know.
// If the hub row already IS that address, it keeps its own identity. Admin → Regions still lists
// both raw rows; only the public view folds.
//
// Pure: no I/O. Kept out of the routes so scripts/test-regions.js can run it.

const SUM_FIELDS = ['hashrate_gps', 'miners', 'workers', 'shares_window'];

// "stratum+tcp://Host.:3333/" → { host: 'host', port: '3333' } ('' port when absent).
function parseEndpoint(u) {
  const s = String(u == null ? '' : u).trim().toLowerCase().replace(/^\w+(\+\w+)?:\/\//, '').replace(/\/+$/, '');
  const m = /^([^:/]+?)\.?(?::(\d+))?$/.exec(s);
  return m ? { host: m[1], port: m[2] || '' } : null;
}

function sameEndpoint(a, b, defaultPort) {
  const x = parseEndpoint(a), y = parseEndpoint(b);
  if (!x || !y || !x.host) return false;
  return x.host === y.host && (x.port || defaultPort) === (y.port || defaultPort);
}

const isActive = (r) => r.is_active === true || r.is_active === 1;

// rows: region rows (each with region, stratum_url, is_active, and whatever else the caller
// publishes). opts: { localRegion, ownStratum ("<subdomain>:<port>"), defaultPort }.
// Returns a NEW array; the input rows are not mutated. No hub row, no own address, or no alias
// → the same rows, unchanged.
function foldHubAliases(rows, { localRegion, ownStratum, defaultPort = '' } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!localRegion || !ownStratum) return list.slice();
  const port = String(defaultPort || (parseEndpoint(ownStratum) || {}).port || '');
  const hubIdx = list.findIndex((r) => r && r.region === localRegion);
  if (hubIdx < 0) return list.slice();
  const hub = list[hubIdx];
  const aliases = list
    .filter((r) => r && r.region !== localRegion && isActive(r) && sameEndpoint(r.stratum_url, ownStratum, port))
    .sort((a, b) => (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
  if (!aliases.length) return list.slice();

  const id = sameEndpoint(hub.stratum_url, ownStratum, port) ? hub : aliases[0];
  const group = [hub].concat(aliases);
  const merged = Object.assign({}, hub, {
    region: id.region,
    label: id.label || hub.label || null,
    country: id.country || hub.country || null,
    country_code: id.country_code || hub.country_code || null,
    stratum_url: id.stratum_url,
    is_active: typeof hub.is_active === 'number' ? 1 : true,
    is_hub: true,
    hub_rtt_ms: 0,
  });
  if (!(Number.isFinite(hub.lat) && Number.isFinite(hub.lng)) && Number.isFinite(id.lat) && Number.isFinite(id.lng)) {
    merged.lat = id.lat;
    merged.lng = id.lng;
  }
  for (const f of SUM_FIELDS) {
    if (!(f in hub)) continue;
    const vals = group.map((r) => r[f]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    merged[f] = f === 'hashrate_gps'
      ? parseFloat(vals.reduce((s, v) => s + v, 0).toFixed(6))
      : vals.reduce((s, v) => s + v, 0);
  }
  if ('status' in hub && group.some((r) => r.status === 'online')) merged.status = 'online';
  if ('online' in hub) merged.online = merged.status !== 'offline';

  const drop = new Set(aliases);
  const out = [];
  list.forEach((r, i) => {
    if (i === hubIdx) out.push(merged);
    else if (!drop.has(r)) out.push(r);
  });
  return out;
}

module.exports = { parseEndpoint, sameEndpoint, foldHubAliases };
