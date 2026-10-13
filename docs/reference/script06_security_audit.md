# Script 06 — Explorers & Peer Map — Security Audit

> **Covers code as of:** 2026-08-15 · **Last verified:** never re-verified since
> **Product code last changed:** 2026-09-06 — `scripts/06_global_grin_health.sh`, `scripts/lib/06*`, `web/06_stats_map/`, `web/06d_tiny_explorer/`
> ⚠ The 06d tools hub (probe routes, its own nginx rate-limit zone) landed **after** this audit and is **not covered by it**.

**Scope:** the public read services in front of the Grin node — **06b GrinScan**
(`web/06b_grinscan/server.js` + `scripts/lib/06b_grinscan.sh`) and **06d Tiny Explorer**
(`web/06d_tiny_explorer/tiny-explorer-server.js`), plus the peer/topology data both expose
(the "peer map"). Focus: injection, node-proxy DoS/amplification, info leak. The 06 stats
collector (`06_collector.py`, world.grin.money) is out of scope for this pass beyond the peer
exposure principle it shares — except **F4**, added 2026-08-15 to record one deliberate new
public field in the collector's own `peers.json`.

**Date:** 2026-07-10 · **Auditor:** Claude · **Verdict:** Both explorers are **injection-safe**
(prepared statements, strict ref/commit regexes, localhost bind, no user-reflected HTML). The
real risk is a **node-proxy amplification DoS**: the node-touching `/api/*` endpoints are not
rate-limited at nginx and unique-ref requests bypass the in-process caches, so an attacker can
drive the archive node into the documented page-cache thrash. Plus a topology info-leak.

---

## Findings

### F1 — [Medium] Unthrottled node-proxy amplification on `/api/block|kernel|output|peers`
- **Evidence:** The nginx vhost rate-limits **only** `location /rest/` (`limit_req zone=grinscan_api`)
  — [06b_grinscan.sh:788-813](../../scripts/lib/06b_grinscan.sh#L788-L813). The node-touching
  endpoints live under `location /` (`/api/block/:ref`, `/api/kernel/:excess`, `/api/output/:commit`,
  `/api/peers`) and get **no `limit_req`**. In the app, `/api/block/:ref` on a cache-miss calls the
  Foreign API `get_block` live ([server.js:855-882](../../web/06b_grinscan/server.js#L855-L882));
  GrinScan keeps **no** cache for live block fetches, and while kernel/output have a 500-entry
  LRU/TTL, an attacker who varies the ref misses the cache every time → one live node RPC per request.
- **Impact:** Per CLAUDE.md, *bulk random `get_block` reads thrash* an archive node's page cache
  (swap fills, kswapd pegged) — a documented way to take a small box down. An attacker iterating
  `/api/block/<random height>` (archive nodes serve every height) turns the public explorer into a
  node-DoS amplifier, with no HTTP-layer brake. Tiny Explorer has the same `/api/*` shape (its
  300-entry block LRU is likewise defeated by unique refs).
- **Fix:** Apply the existing `grinscan_api` `limit_req` zone to `location /api/` (and `/block/`,
  `/kernel/`, `/output/` deep-link routes) as well as `/rest/`. Additionally clamp the live
  `get_block` fallback to a bounded recent height window (or require the height be within the cached
  range), so an arbitrary-height crawl can't reach cold rangeproof reads.

### F2 — [Low] Public node topology exposure (the "peer map")
- **Evidence:** `/rest/node.json` and `/api/peers` publish the node's **connected peer set** — each
  peer's `addr` (IP:port), `direction` (Inbound/Outbound), and `user_agent`
  ([server.js:753-774](../../web/06b_grinscan/server.js#L753-L774),
  [1044-1052](../../web/06b_grinscan/server.js#L1044-L1052)). Sourced from the Owner API
  `get_connected_peers` (a management call) proxied to the public.
- **Impact:** Low. Grin P2P addresses are gossip-public, but publishing *this node's own live peer
  set* — especially the **outbound** peers plus exact node version — hands an attacker the exact
  topology to attempt an eclipse attack and fingerprints the node. It's a management-API surface
  exposed unauthenticated on a public page.
- **Fix:** For the public/map surface, expose **counts + version buckets + direction totals** and
  aggregate peer IPs to country (what the map needs) rather than raw `addr:port`; drop the raw
  outbound peer list, or gate the full list behind admin. (Node version is already public via
  `get_status`; the peer *addresses* are the sensitive part.)

### F3 — [Info] Correct controls (no action)
- **No SQL injection:** every query is a `better-sqlite3`/`node:sqlite` prepared statement with bound
  params ([server.js:109-178](../../web/06b_grinscan/server.js#L109-L178)); the block/kernel/output
  refs are regex-validated (`^\d+$` / `^[0-9a-fA-F]{8,}$` / 64–66-hex) before any use
  ([server.js:832-841](../../web/06b_grinscan/server.js#L832-L841), 908; tiny-explorer 184-192).
- **No user-reflected HTML:** `injectGlobals()` interpolates only **operator config** (network,
  version, base_url, banners, GA4 id) — no request-derived value reaches the HTML. Tiny Explorer
  additionally `esc()`s its SEO meta ([tiny-explorer-server.js:692-718](../../web/06d_tiny_explorer/tiny-explorer-server.js#L692-L718)).
- **Exposure & inputs:** both bind `127.0.0.1`; numeric query params are clamped
  (`limit`/`offset`/`days`/`n` via `Math.min/Math.max`); node secrets are read from files and never
  echoed; `/rest/` CORS `*` is intentional for a read-only public API.
- **Outbound calls** (price feeds, sync-reference nodes) target operator-configured or hardcoded
  hosts — no user-controlled URL, so no SSRF from visitors.

### F4 — [Info] `node_id` on the public peer map (added 2026-08-15, by design)
- **Context:** `data/peers.json` (world.grin.money) is fetched by the browser, so every field in
  it is public. It now carries `node_id` per peer so the map's location drill-down can tell two
  hosts apart inside one masked /24 — see `script06_design.md` for why the list is unusable
  without it.
- **Why it is not a deanonymisation step:** `node_id = sha256(salt|real_ip)[:4]` where `salt` is a
  128-bit value minted per install and kept in `meta.node_id_salt` — **never exported**
  ([06_collector.py `_node_id_salt`](../../scripts/lib/06_collector.py)). Unsalted this would be a
  disclosure, not a hash: the /24 is published alongside it, leaving 256 candidates to brute-force
  in microseconds. With the salt secret there is no offline attack, and 4 hex chars are too few to
  serve as a tracking identifier or to correlate one node across two installs (different salts).
- **What it does grant, deliberately:** a stable label for one host across collector runs *on this
  install*, which the published `ip` + `port` + `user_agent` triple already effectively provided.
  It adds no new location, version or topology detail.
- **If the salt leaks:** it is the only secret here. Anyone holding it can map a published
  `node_id` back to the exact IP within a /24. It lives in the stats DB, so it rides along in the
  same backups — treat `stats.db` as holding one small secret, and rotate by deleting the
  `node_id_salt` row (all ids change on the next run; nothing else breaks).
- **Not applicable to F2's concern:** this is the 06 collector's own peer *registry*, not
  GrinScan's live `get_connected_peers` set.

---

## Priority for the operator
1. **F1** — add `limit_req` to `location /api/` (+ deep-link routes) and bound the live `get_block`
   height window before running GrinScan/Tiny Explorer in front of an **archive** node on a small box.
2. **F2** — decide how much peer topology the public map should reveal; prefer country-aggregated
   counts over raw peer IP:port, especially the outbound set.
