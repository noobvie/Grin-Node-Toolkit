// /api/public/* — branding, footer price, endpoints directory, lottery, CMS pages/posts and the ads feed.
// Moved verbatim out of routes/index.js (code-layout refactor P3); registrations stay at 2-space
// indent and write FULL paths. Instances/state come from ctx.

const express = require('express');
const caches = require('./_shared/caches');
const explorers = require('../lib/explorers');
const { latencyConfig } = require('../lib/latency-probe');

module.exports = function createPublicRoutes(ctx) {
  const {
    adsManager, assetManager, config, gamesLink, incentivesManager, lotteryManager, pagesManager,
    poolSettings, postsManager, rateLimiter, stratumPause
  } = ctx;
  const router = express.Router();

  // ─── Public Health Check (rate-limited, no auth) ───────────────────────────
  // Registered on both /health and /api/health: nginx proxies /api/* to the backend,
  // so the /api/health alias is what reaches the pool through the standard proxy path.
  router.get(['/health', '/api/health'],
    rateLimiter.middleware('public'),
    (req, res) => {
      res.json({
        // `status` reports the HTTP backend, which is fine during a stratum pause (§21.9);
        // `stratum` says whether miners are being accepted.
        status: 'ok',
        network: config.network,
        stratum: stratumPause && stratumPause.isPaused() ? 'paused' : 'accepting',
        timestamp: new Date().toISOString()
      });
    }
  );

  // ─── Public White-Label Config (rate-limited, no auth) ─────────────────────
  // Serves the curated branding/SEO/analytics payload consumed by /js/branding.js
  // on every public page. Only operator-set, non-sensitive fields are exposed.
  //
  // MEMOISED 60 s — the same window the Cache-Control header already advertised, but on the
  // box rather than as a hint to the client (audit §J12-8). This is the most-hit endpoint in
  // the product: every public page fetches it on every load. Each rebuild was five uncached
  // `getSection()` queries (pool-settings.js has no memo of its own), plus asset lookups, an
  // incentives summary and a lottery read — and §J9-8 established that ~40 of the strings it
  // republishes are bounded only by express.json()'s 100 KB PER-REQUEST body limit, so the
  // response size is an operator-set number with no ceiling. Caching does not fix that (the
  // length caps are still §J9-8's open item); it stops it being paid per request.
  //
  // Keyed on req.hostname because `connection.stratum_host` falls back to it.
  // Invalidated explicitly on every settings/asset write (see invalidateBranding), so an
  // operator's edit shows up immediately; the TTL is the backstop for the inputs that are NOT
  // settings writes — the prize-pool figure and the lottery schedule. Those have their own
  // live endpoints (/api/pool/prize-pool), so 60 s of staleness here costs nothing.
  const BRANDING_TTL_MS = 60000;

  router.get('/api/public/branding',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const ckey = String(req.hostname || '');
        const hit = caches.branding.get(ckey);
        if (hit && (Date.now() - hit.at) < BRANDING_TTL_MS) {
          res.setHeader('Cache-Control', 'public, max-age=60');
          return res.json({ success: true, data: hit.payload });
        }
        const assetUrlFor = (type) => {
          const asset = assetManager.getActiveAsset(type);
          return asset ? assetManager.getAssetUrl(asset.filename) : '';
        };
        // The stratum pause (design §21.8/§21.9) feeds the COMPUTED overlay, the `stratum`
        // block and the synthetic banner. Every pause transition drops this memo (onChange).
        const cfg = poolSettings.buildPublicConfig(assetUrlFor, stratumPause ? stratumPause.publicStatus() : null);
        // Same derivation siteOrigin() uses, so branding.js's client-side canonical / og:url /
        // JSON-LD agree with the server-rendered ones on the two SSR routes. Without this the
        // blanked site_url default (§J10-4) would simply drop the canonical off every page that
        // is NOT server-rendered, instead of correcting it.
        if (!cfg.seo.site_url && config.subdomain) {
          cfg.seo.site_url = 'https://' + String(config.subdomain).replace(/\/+$/, '');
        }
        // Connection info for the miner-config generator (host falls back to request host).
        cfg.connection = {
          stratum_host: cfg.pool.public_stratum_host || req.hostname || '',
          stratum_port: config.stratum_port || '',
          network: config.network || 'mainnet',
          // Resolved explorer key (lib/explorers.js) — testnet is always grinscan_testnet.
          // From cfg.branding (already read above, and a settings write invalidates this memo).
          explorer: explorers.resolveExplorerKey(config.network, cfg.branding.explorer_mainnet),
          algorithm: 'Cuckatoo32',
          // Where the connect page may time latency (lib/latency-probe.js): probe_domain
          // (gateways it may probe at https://<stratum host>/ping, the nginx CSP's
          // connect-src wildcard), hub_url (this hub's /ping, or null behind a CDN proxy) and
          // direct_bias_ms (the suggestion's ranking bias, so the page re-ranks by the same rule).
          // Installer-set values only, so it is safe inside this hostname-keyed cache.
          latency: latencyConfig(config),
        };
        // Public incentive summary (prize-pool size, next draw, recent winners). Only shown
        // when the operator has enabled incentives. Winner addresses are truncated.
        try {
          if (incentivesManager && incentivesManager.enabled()) {
            const recent = lotteryManager.recentDraws(3);
            const trunc = (a) => (a && a.length > 14 ? `${a.slice(0, 10)}…${a.slice(-4)}` : a);
            const incCfg = poolSettings.getSection('incentives');
            cfg.incentives = {
              enabled: true,
              ...incentivesManager.publicSummary(),
              donation_address: incCfg.donation_address || '',
              lottery: lotteryManager.nextScheduled(),
              recent_winners: recent.flatMap((d) =>
                (d.winners || []).map((w) => ({
                  event: d.event_name || 'Weekly',
                  address: trunc(w.address || w.grin_address),
                  amount: w.amount,
                }))
              ),
            };
          } else {
            cfg.incentives = { enabled: false };
          }
        } catch (e) {
          cfg.incentives = { enabled: false };
        }
        // Games nav flag (design §19 D12): { mode, chat }. mode is 'off' whenever the games
        // service fails its health probe, and a probe flip invalidates this memo (attach below).
        cfg.games = gamesLink.publicFlag();
        // Bound the key space: hostname is attacker-chosen (any Host header nginx passes
        // through), so this is a cache, not a registry. Drop the oldest insert past the cap.
        if (caches.branding.size >= 32) {
          caches.branding.delete(caches.branding.keys().next().value);
        }
        caches.branding.set(ckey, { at: Date.now(), payload: cfg });
        // Short cache: branding changes are infrequent and the page can tolerate it.
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ success: true, data: cfg });
      } catch (err) {
        res.status(500).json({ error: 'Failed to load branding' });
      }
    }
  );

  // ─── Public GRIN price (footer ticker) — cached external lookup ────────────────
  // The pool box has a node + wallet but no market data, so price comes from a public
  // market API (CoinGecko). Fetched server-side (avoids CORS + a per-visitor key) and
  // cached ~5 min. On any failure we serve the last good value, or {available:false}.
  let _priceCache = { ts: 0, data: null };
  const PRICE_TTL_MS = 5 * 60 * 1000;
  // NEGATIVE cache. The success path was cached; the failure path was not, and `_priceCache.ts`
  // was only ever stamped alongside a good value — so any upstream refusal turned this into a
  // per-request outbound fetch, forever (audit §J12-6). At the ~10 req/s nginx allows from one
  // host that is up to 50 concurrent 5-second HTTPS sockets held open by an anonymous client,
  // plus whatever reputation the pool's egress IP earns upstream. 60 s is short enough that a
  // recovered upstream is picked up quickly and long enough that failure is not free to trigger.
  const PRICE_FAIL_TTL_MS = 60 * 1000;
  let _priceFailAt = 0;
  let _priceInflight = null;
  // ⚠ CoinGecko 403s a request with no DESCRIPTIVE User-Agent ("Please add a descriptive
  // User-Agent to your request"), and Node's fetch sends the bare string `node`. Every other
  // CoinGecko caller in this toolkit (06_price_collector.py, 07_mining_block_collector.py,
  // 06b_grinscan/server.js, 06d_tiny_explorer) had to gain one for the same reason; this one
  // was written without it. Memory project_grin_btc_price_source.
  const PRICE_UA = `grin-mining-pool/1.0 (+Grin Node Toolkit; ${config.network || 'mainnet'})`;
  const fetchPrice = async () => {
    const ctrl = AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined;
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=grin&vs_currencies=usd,btc',
      { signal: ctrl, headers: { accept: 'application/json', 'user-agent': PRICE_UA } }
    );
    if (!r.ok) throw new Error('upstream ' + r.status);
    const j = await r.json();
    const g = j && j.grin ? j.grin : {};
    const data = {
      available: typeof g.usd === 'number' || typeof g.btc === 'number',
      usd: typeof g.usd === 'number' ? g.usd : null,
      btc: typeof g.btc === 'number' ? g.btc : null,
      source: 'coingecko',
      updated_at: Date.now(),
    };
    // A 200 that carries no number is a failure too — it must arm the negative cache, or an
    // upstream that has quietly dropped the `grin` id becomes the per-request fetch again.
    if (!data.available) throw new Error('upstream returned no price');
    return data;
  };
  router.get('/api/public/price',
    rateLimiter.middleware('public'),
    async (req, res) => {
      const now = Date.now();
      res.setHeader('Cache-Control', 'public, max-age=300');
      if (_priceCache.data && (now - _priceCache.ts) < PRICE_TTL_MS) {
        return res.json({ success: true, data: _priceCache.data });
      }
      // Still inside the failure cool-off → answer from last-good (or "unavailable") without
      // touching the network at all.
      if ((now - _priceFailAt) < PRICE_FAIL_TTL_MS) {
        return res.json({ success: true, data: _priceCache.data || { available: false } });
      }
      // Collapse concurrent misses onto one outbound call.
      if (!_priceInflight) {
        _priceInflight = fetchPrice()
          .then((data) => { _priceCache = { ts: Date.now(), data }; return data; })
          .catch(() => { _priceFailAt = Date.now(); return null; })
          .then((data) => { _priceInflight = null; return data; });
      }
      const data = await _priceInflight;
      // Serve stale-if-error; otherwise report unavailable (footer hides the ticker).
      res.json({ success: true, data: data || _priceCache.data || { available: false } });
    }
  );

  // ─── Public API reference — auto-generated from the live Express route table ───
  // Always accurate for WHICH routes exist (it reflects the routes actually mounted); only
  // public-safe prefixes are exposed, so admin/auth routes are never listed. api-docs.html
  // renders this. An unmapped route still appears (with an empty description) so the LIST can
  // never drift — but the per-endpoint metadata below is hand-maintained and CAN drift, so
  // treat it as documentation, not as introspection.
  //
  // `shape` matters more than it looks. This API is NOT uniform: the /api/public/* CMS-era
  // routes return { success: true, data: … } while almost everything older returns the payload
  // raw (often a bare array), and errors are ALWAYS { error: "…" } with no success flag on any
  // of them. The page used to claim a single envelope for all of it, which is wrong for ~70% of
  // the endpoints and breaks the first client anyone writes. Publishing the real shape per
  // endpoint is cheaper and more honest than retrofitting one envelope onto 30 live routes that
  // the pool's own front-end already consumes.
  //   envelope = { success: true, data: … }   flat = { success: true, …fields }
  //   raw      = payload at the top level     array = bare JSON array
  //   none     = 204 No Content
  // `params`  — query string, with the caps the handler actually enforces.
  // `body`    — request body fields, for the POST/DELETE rails.
  // `auth`    — ownership proof required (lib/owner-proof.js), otherwise public.
  // `gated`   — an operator setting that makes the route 404 when off.
  // `rate`    — which rate-limiter bucket applies (see this.limits in lib/rate-limiter.js).
  const PUBLIC_API_PREFIXES = [
    '/api/public/', '/api/account/', '/api/config/', '/api/pool/',
    // Added 2026-07-28. These are public, rate-limited, and consumed by the pool's own pages
    // (reactor-dashboard.js, miners-stats.html, network-map.js) — they were simply invisible to
    // the reference because the prefix list predated them. An undocumented public endpoint is
    // not a private one; it is a public one nobody can use correctly.
    '/api/stratum/', '/api/network/',
  ];
  const OWNER_PROOF_BODY = 'proof (recent mining IP or the rig\'s stratum password; legacy alias ip_proof)';
  const API_DOC_META = {
    // ── Public ────────────────────────────────────────────────────────────────
    'GET /api/public/branding': { desc: 'White-label config (name, theme, SEO, social, footer links). connection.latency tells the connect page where it may measure latency from your browser: probe_domain (regional servers under https://*.<probe_domain> answer GET /ping with an empty 204; null = none), hub_url (where the pool itself answers /ping; null when it sits behind a CDN proxy, which would time the CDN instead) and direct_bias_ms (integer milliseconds: connecting directly is preferred unless a regional server is more than this much faster — the same rule as /api/pool/connect/suggest). connection.explorer is the chain explorer this pool links blocks, kernels and outputs to — one of grincoin (grincoin.org), tiny (scan.grin.money), grinscan (grinscan.org) on mainnet, as the operator chose; always grinscan_testnet (test.grinscan.org) on testnet. branding.explorer_mainnet is the mainnet choice the operator made, shown even on a testnet pool; links should follow connection.explorer. games = { mode, chat } for the /play/ games platform: mode is off, preview or on, and reads off whenever the games service is not answering; the nav shows Play only on on. stratum = { accepting, paused_since, resumes_at, planned: { start, end } | null } (ISO-8601 UTC, null when not applicable): whether the pool is accepting miners right now, and any planned pause. While stratum is paused and the operator has not set maintenance mode, maintenance is on with source stratum and until = the automatic resume time (source operator = the maintenance mode the operator set themselves, which always wins), and announcements leads with a non-dismissible maintenance banner — also shown from 24 h before a planned pause.', shape: 'envelope' },
    'GET /api/public/price': { desc: 'Cached GRIN price (USD + BTC) from CoinGecko. Serves the last good value on upstream failure; { available: false } if never fetched. updated_at is UNIX MILLISECONDS (the one such field on this API).', shape: 'envelope' },
    'GET /api/public/endpoints': { desc: 'This API reference (machine-readable).', shape: 'envelope' },
    'GET /api/public/ads': { desc: 'Active operator ads by placement (+ rotation interval). Cached 60s, so ad edits take up to a minute to appear.', shape: 'raw', params: 'placement (omit for every slot keyed by placement)' },
    'POST /api/public/ads/event': { desc: 'Ad impression/click beacon — aggregate counters only, no visitor data. Always 204, even on a malformed body.', shape: 'none', body: 'impressions[], clicks[] (ad ids)' },
    'GET /api/public/lottery/winners': { desc: 'Fortune-board winner history (truncated addresses). Empty when incentives are disabled.', shape: 'envelope', params: 'limit (≤100, default 25) · offset' },
    'GET /api/public/lottery/stats': { desc: 'Fortune-board aggregates: total prizes/winners/draws, Pot A/B split, monthly series.', shape: 'envelope' },
    'GET /api/public/pages': { desc: 'Published CMS pages (slug + title) for the header/footer link lists.', shape: 'envelope' },
    'GET /api/public/page/:key': { desc: 'One published CMS page by slug (About / Terms / Privacy / FAQ …). 404 if the slug is unknown or unpublished.', shape: 'envelope' },
    'GET /api/public/posts': { desc: 'Blog: paginated list of published posts (card view — excerpt, cover, date).', shape: 'envelope', params: 'limit (≤50, default 10) · offset' },
    'GET /api/public/post/:slug': { desc: 'Blog: one published post in full, by slug. 404 if unknown or unpublished.', shape: 'envelope' },

    // ── Config ────────────────────────────────────────────────────────────────
    'GET /api/config/pool-info': { desc: 'Pool terms: network, pool fee %, minimum withdrawal, the flat per-payout withdrawal fee (0 = the pool absorbs the network fee), address format, which listener a miner needs, and explorer — the chain explorer key this pool links to (grincoin, tiny or grinscan on mainnet; grinscan_testnet on testnet).', shape: 'raw' },

    // ── Pool ──────────────────────────────────────────────────────────────────
    'GET /api/pool/stats': { desc: 'Live pool stats: block totals (found / confirmed / immature counts, confirmed + immature reward; orphans_24h = blocks found in the last 24 h that were later orphaned, null if unreadable), active miners (distinct addresses), active workers (logged-in rigs), raw connections, and share quality (accepted/stale/rejected). Share quality is LIVE in-memory only — it is empty with no connected sessions and resets on disconnect. Also network (mainnet or testnet) and explorer, the chain explorer key this pool links to (grincoin, tiny or grinscan on mainnet; grinscan_testnet on testnet). stratum = { accepting, paused_since, resumes_at, planned } as on /api/public/branding — while the pool is paused hashrate drops, and this says why.', shape: 'raw' },
    'GET /api/pool/status': { desc: 'Coarse service health for the status strip: pool up, node reachable/state/synced/peers/height/up_days, wallet reachable. node.state is ok | starting (API port closed, node process running) | busy (API timed out) | offline; reachable is true only for ok. node.up_days is how long the node has been continuously available, as an integer of WHOLE UTC DAYS counted to the most recent 00:00 UTC — so it changes only at midnight UTC and can understate by up to a day, never overstate (0 = came up today or yesterday). It is null when unknown, including whenever reachable is false, and null must never be read as 0. Its source is the node box\'s own event recorder when that is installed and fresh, else the pool\'s own probe history. It is the only uptime field: no restart time, timestamp or uptime in seconds is published. Cached 15 s. Never exposes balances or addresses.', shape: 'raw' },
    'GET /api/pool/stats/regions': { desc: 'Per-region stratum endpoints + live status (online | idle | offline | checking — the last only on the first poll after a restart, before the reachability probe has a verdict) and 15-minute regional hashrate, miners (distinct addresses) and workers (distinct address+rig pairs). On a MULTI-region pool a k-anonymity floor applies: a region with 0 < miners < min_bucket reports miners/workers/hashrate_gps/shares_window as null with below_floor:true — that is withheld, not zero (a real zero is still 0). Totals are always exact. Per region, is_hub (boolean) marks this server\'s own region — connecting there is connecting to the pool directly; false on every row of a pool that runs no local stratum. hub_rtt_ms (integer milliseconds) is the round trip between the pool and that region\'s server — the minimum of its last 5 TCP connects to the region\'s public stratum port; add it to your own latency to that server for your effective latency to the pool. It is 0 on the is_hub row, and null when that server has not been reached yet (just after a restart, or never). timestamp is ISO 8601.', shape: 'raw' },
    'GET /api/pool/connect/suggest': { desc: 'Which server to point a rig at, for YOU: estimated effective latency per region, from the country your IP resolves to. Effective = your distance to that server + its link to the pool (hub_rtt_ms) — a regional server does not shorten the trip to the pool, so a far one can lose to connecting directly. Returns { basis: "estimate", recommended (region tag, or null), estimates: [{ region, est_ms (integer milliseconds, round trip), via: direct | gateway }] }; direct is preferred unless a gateway is more than 15 ms faster. Regions that are offline, or whose link to the pool has not been measured yet, get no estimate. { basis: "unavailable" } alone when no country can be resolved. An estimate from geography, not a measurement. Your IP and country are used for this one answer and neither stored, logged nor returned; never cached (Cache-Control: private, no-store).', shape: 'raw' },
    'GET /api/pool/locations': { desc: 'Operator-declared stratum regions that are currently active — region key, label, and the stratum URL to point a rig at.', shape: 'array' },
    'GET /api/pool/blocks': { desc: 'Pool-found blocks, newest first. A short page (fewer rows than limit) means the last page. found_by is MASKED (grin1qxy…mn4p).', shape: 'array', params: 'limit (≤500, default 50) · offset · status=immature|matured|orphaned (matured = confirmed + paid; confirmed|paid alone also accepted)' },
    'GET /api/pool/blocks/history': { desc: 'Durable block series: luck, per-period counts, status split, cumulative reward, and found blocks by UTC hour. Blocks are never pruned, so any range is meaningful. points[].expected is the number of blocks the pool should have found in that period from its share of network hashrate (pool GPS ÷ network GPS × 60 per hour, from the hourly rollup); null when the period has no network sample — draw it as a gap. Every period the rollup covers has a point, so a period with expected > 0 and blocks 0 is listed. hours = { found, expected, expected_hours }: 7×24 arrays indexed [weekday][hour], UTC, weekday 0 = Sunday; expected is null until the rollup has an hour with a network sample, and expected_hours counts the hours it was built from. hours is null when the block manager is unavailable.', shape: 'raw', params: 'range=week|month|year|all (default month)' },
    'GET /api/pool/effort': { desc: 'Pool network share, luck over the last 100 blocks, current round effort, and time since the last block. round_shares is the round\'s SUMMED share difficulty in chain units (the effort numerator — every accepted share weighs job target × 16384), NOT a count; round_share_count is the number of accepted shares. The round window is capped at 7 days (round_window_capped:true when the cap, not the last block, set round_window_from). The whole response is cached 30s; network difficulty ~60s.', shape: 'raw' },
    'GET /api/pool/hashrate/history': { desc: 'Pool hashrate time-series, summed across addresses per bucket.', shape: 'raw', params: 'hours (1–720, default 24)' },
    'GET /api/pool/poolstats': { desc: 'Listing feed for pool directories — this is the URL to hand to miningpoolstats.stream (they poll it; nothing is pushed). Pool + network aggregates in the same field layout as the toolkit\'s solo-mining poolstats_<net>.json, so an importer written for that needs no changes. Recomputed at most once every 60s and served from cache in between, so polling faster than 1/min returns identical bytes — 1–5 min is the sensible range. Every value is an aggregate already shown on the homepage; no address or per-miner row is included, so it needs no auth. The ts field is the generation time: if it stops advancing, the feed is stale. ts and pool.last_block.ts are ISO 8601 strings, not UNIX seconds — the solo feed layout this mirrors uses them. Fields are null (not 0) when the node is unreachable, and network.hashrate_gps_24h is null until the pool has an hour of history.', shape: 'raw' },
    'GET /api/pool/metrics/history': { desc: 'Durable pool trend series: hashrate, miners, workers, blocks found, earnings, payout, network hashrate. Rolled up hourly and never pruned. At day-or-coarser buckets (month/year/all) miner_count/worker_count are the PEAK hour in the bucket, hashrate the average, money the sum. worker_count is null for hours recorded before it existed — draw a null as a GAP, never as 0.', shape: 'raw', params: 'range=day|week|month|year|all (default day)' },
    'GET /api/pool/metrics/history/regions': { desc: 'Per-region miners/hashrate trend series (the "miners by gateway" view). Same k-anonymity floor as /api/pool/stats/regions, applied per point: below the floor miner_count and hashrate_gps are null with below_floor:true. Draw a null as a GAP, never as 0.', shape: 'raw', params: 'range=day|week|month|year|all (default day)' },
    'GET /api/pool/payments/history': { desc: 'Durable payments & transparency series: payouts, reward split, giveaways, donations, fee, plus lifetime totals. Payout figures are miners only; revenue withdrawals by the pool operator are reported separately as totals.operator_withdrawn_all / operator_withdrawal_count.', shape: 'raw', params: 'range=day|week|month|year|all (default month)' },
    'GET /api/pool/payments': { desc: 'Recent confirmed payouts: address, amount, flat fee charged, method, timestamps and has_kernel_proof (true once the payout\'s kernel has been seen mined; stays false on a pool with no Owner API wallet) and kernel_excess — the payout\'s Tx ID (66 hex chars, lowercase), or null until mined; link it to a chain explorer\'s kernel page to verify the payout on-chain. Addresses are MASKED (grin1qxy…mn4p). Revenue withdrawals by the pool operator are listed too, with operator: true and the fixed label "Pool operator" in place of an address (never the wallet they went to). Pool-internal payout machinery (slate id, Tor probe result, retry state, cancel reason) is deliberately not published either.', shape: 'array', params: 'limit (≤500, default 100)' },
    'GET /api/pool/miners': { desc: 'Balance distribution across accounts, richest first. Addresses are MASKED (grin1qxy…mn4p) — the distribution is public, the address→balance mapping is not.', shape: 'array', params: 'limit (≤500, default 50)' },
    'GET /api/pool/top-block-finders': { desc: 'Lucky-miner leaderboard over a recent window: per address blocks_found, total_reward, total_fees (null = fees not captured), orphaned (count, never a find), last_found_at, last_height; plus total_blocks for the whole pool. Orphans do not count as a find. Addresses are MASKED.', shape: 'raw', params: 'days (≤3650, default 30) · limit (≤1000, default 500)' },
    'GET /api/pool/unclaimed': { desc: 'Lost-and-found: masked addresses of long-dormant balances with a per-address disposal countdown, plus the historical disposition ledger (sweeps into the prize pool).', shape: 'raw', params: 'limit (≤200, default 100)' },
    'GET /api/pool/donors': { desc: 'Donor league + past donors. `league` = addresses with a donation debit inside the ranking window, ranked by score = GRIN in window × loyalty multiplier (min(1 + loyalty_percent_per_month/100 × active_months, loyalty_cap); active_months = distinct UTC months with a debit, lifetime), ties by months then first donation; top 100 with `rank` 1..N. `past.donors` = up to 20 addresses with a lifetime total but nothing in the window, newest last donation first, plus `past.more` for the rest. Both arrays share one card shape: rank (null on past), name, name_state, banner, address, in_window_donated, total_donated, active_months, multiplier, score, first_donated_at, last_donated_at, donation_count, rigs_online, rigs_donating, pct_min, pct_max (live, display only, never ranked). A donation is per RIG: rigs_online = distinct rigs mining to the address now, rigs_donating = how many carry a `donateN` tag with N > 0, pct_min/pct_max = the range of those tags (0 when none). `name` is the donor\'s own nickname, set on their account page; the pool APPROVED it by an automatic check (reserved words, a blocked-word list, banned and taken names — live at once) or, before that check existed, by hand, and can take it down (2–32 chars: letters, digits, space and - _ . & \', case kept); it is null for every name_state but `shown` (masked = no approved name, expired = the approval aged out). Escape before rendering. `banner` = {url, width, height} (url always /uploads/donors/<file>, a PNG, JPEG or GIF the pool APPROVED, 320–1600 × 80–400 px, 2:1 to 8:1) only on league cards with rank ≤ ranking.banner_slots whose banner has not expired; null on every other card and always null on past. Addresses are MASKED. `totals` are LIFETIME over EVERY donor, not the cards (donor_count, total_donated) and `totals.active_donors` counts addresses with a tagged rig mining right now (a tag shows there before its first slice is taken — that only happens when a block matures). `ranking` = {window_days (0 = all-time), loyalty_percent_per_month, loyalty_cap, name_expiry_months, banner_slots (0–10; 0 = no banners)} for the page\'s ranking sentence and its Top-N spotlight. rigs_donating, pct_min, pct_max and active_donors read 0 while the operator has donations switched off. Window edge: a day already rolled into the daily ledger counts WHOLE when its UTC midnight is ≥ now − window.', shape: 'raw' },
    'GET /api/pool/prize-pool': { desc: 'Prize-pool transparency report: current balance + LIFETIME in/out totals by source (fee-cut, donations, operator top-ups, abandoned balances, orphan clawbacks). Per-event rows are deliberately withheld — their timestamps would expose the cadence of discretionary operator top-ups.', shape: 'raw' },
    'GET /api/pool/topology': { desc: 'Network map: hub → gateways → miners aggregated BY COUNTRY. Country-only geolocation; no per-miner coordinate is ever resolved or stored, and countries under the k-anonymity floor merge into one unnamed bucket. Gateway lat/lng is the operator-declared position of that public server (admin → Regions), or the country centroid when none was declared. timestamp is ISO 8601.', shape: 'raw', gated: 'the operator publishes the network map (on by default; 404 while switched off in admin → Access)' },

    // ── Stratum (live session aggregates) ─────────────────────────────────────
    'GET /api/stratum/stats': { desc: 'Live stratum server state: connection counts and per-session share tallies. Session addresses are truncated so the live list cannot be scraped to enumerate miners.', shape: 'raw' },
    'GET /api/stratum/hashrate': { desc: 'Pool hashrate aggregates (1h/24h GPS) plus the fixed top-10 by hashrate (addresses MASKED) — the gauge on the homepage.', shape: 'raw' },
    'GET /api/stratum/top-miners': { desc: 'Top miners by hashrate over a recent window — the paginated contribution leaderboard. Per row: hashrate_gps, hashrate_1h_gps (last hour; null when the window is ≤ 1 h), share_pct of the pool\'s work, shares, rigs (count only), last_share_at. Cached 60 s. Addresses are MASKED.', shape: 'raw', params: 'window minutes (≤1440, default 1440) · limit (≤1000, default 500)' },
    'GET /api/stratum/top-avg-hashrate': { desc: 'Top miners by AVERAGE hashrate over a multi-day window (sustained contribution). Backed by hashrate_history, so a 30-day window is meaningful. Per row: avg_hashrate_gps, share_pct, peak_day_gps (best fully covered UTC day; null if none), days_active, daily_gps (per-UTC-day average, oldest → today, over every day the window touches). Cached 60 s. Addresses are MASKED.', shape: 'raw', params: 'days (≤90, default 30) · limit (≤1000, default 500)' },

    // ── Network ───────────────────────────────────────────────────────────────
    'GET /api/network/peers': { desc: 'Distinct Grin nodes the pool box\'s node(s) have handshaked with — live connections plus each node\'s own peer store, NOT a network crawl — aggregated by country over a rolling window (+ mainnet/testnet split, and `sources` = which networks are read). Country-only, no IPs; thin countries merge into one unnamed bucket. timestamp is ISO 8601.', shape: 'raw', params: 'window days (1–90, default 30)', gated: 'the operator publishes the network map (on by default; 404 while switched off in admin → Access)' },

    // ── Account (address-as-identity: the address IS the credential to READ) ──
    'GET /api/account/:addr': { desc: 'Account summary: balance, locked, lifetime paid, pending payout, share/hashrate snapshot, the live donation reading (`donation` = { rigs_donating, rigs_online, pct_min, pct_max, workers: [{ name, percent }] } — a `donateN` tag donates that % of what THAT rig earns; zeros while donations are switched off), the donor profile (`donor_profile` = { eligible, blocked, refusal: null | donations_off | blocked | not_a_donor, name: { live, state: shown | expired | none, pending_at (always null: a name is checked automatically and goes live at once), rejected: { reason, at } | null, removed: { reason, at } | null, change_available_at (unix UTC when the 7-day name-change limit allows the next change; null = now) }, banner: { live_url, width, height, state, pending_at, rejected, removed, slot_rank, slots, showing } } — `name.live` is the APPROVED name the wall shows; a banner waiting for review is reported by its submit time only, never its content; null if it could not be read), and the ownership proofs on record. `proofs` is COUNTS ONLY — { ip, pass, max, anchor, last_added_at }: how many distinct mining IPs and rig passwords the pool currently holds for this address, the per-kind cap, whether the original write-once proof is still on record, and the newest capture time across both kinds (UTC seconds; it does not move when a known rig reconnects). No proof value, hash, salt or per-row timestamp is ever returned, here or anywhere else. `tor_pause` = { failures_24h, max, paused_until } — counted failed Tor payouts in the last 24 h (only a wallet that did not answer over Tor counts), the limit (5), and while paused the unix-seconds UTC time Tor payouts reopen for this address (null when not paused); Slatepack is never paused. `slatepack_window_minutes` is how long a Slatepack payout stays answerable before it expires and the balance comes back. `pending_withdrawal.status` can be tor_held: a Tor payout whose outcome the pool is still confirming — the amount stays reserved and it is never sent twice. 404 if the address has never mined here OR is not a well-formed Grin address.', shape: 'raw' },
    'GET /api/account/:addr/shares': { desc: 'Raw accepted shares for an address, newest first. Shares are pruned aggressively — use the hashrate history for anything older than ~a day.', shape: 'raw', params: 'limit (≤500, default 100) · offset' },
    'GET /api/account/:addr/workers': { desc: 'Per-worker (rig) hashrate + share quality over a recent window. `donate_percent` per worker = the % of that rig’s share credit donated to the prize pool, read from its `donateN` name tag (0–100); null when untagged or while the operator has donations switched off.', shape: 'raw', params: 'window minutes (1–1440, default 10)' },
    'GET /api/account/:addr/hashrate/history': { desc: 'Account hashrate time-series, downsampled for charting.', shape: 'raw', params: 'hours (1–720, default 24)' },
    'GET /api/account/:addr/earnings': { desc: 'Credited earnings per period (1h/24h/7d/30d) + 30d in/out totals. Payout reversals count as money-in but never as earnings.', shape: 'raw' },
    'GET /api/account/:addr/balance/log': { desc: 'Address ledger. direction=in|out splits it by movement of the spendable balance: a payout appears in OUT once, as its lock at request time (gross, fee included), and a payout that fails, expires or is cancelled comes back in IN as a reversal — the confirm-time settlement rows appear only in the unfiltered view. Payout rows carry payout_method (tor · slatepack · nostr · manual; null on other rows); the CSV does not. Raw rows prune after ~60 days (the durable record is the withdrawal history below). format=csv streams the filtered window as a download on a tighter rate limit.', shape: 'raw · csv', params: 'direction=in|out · days (≤3650, default all) · limit (≤500, default 50) · offset · format=csv' },
    'GET /api/account/:addr/withdrawals': { desc: 'Payout history for an address — kept forever, so this is the durable record for accounting. Payouts only: no donations or orphan clawbacks. fee_charged is the flat withdrawal fee you were charged (you received amount − fee_charged); fee is the real network fee the POOL wallet paid, not a charge to you. The CSV carries withdrawal_fee and received instead, filled only for paid rows. format=csv streams all-time on a tighter rate limit. The on-chain kernel is NOT returned here — rows carry has_kernel_proof and has_payment_proof (booleans) and the proofs themselves need an ownership proof; see POST /api/account/:addr/withdrawals/proofs. A tor_failed row carries fail_code — why the ONE Tor attempt failed (the balance was returned): wallet_offline (your wallet did not answer over Tor), wallet_unreachable (it could not reach your wallet), pool_send_path (the pool could not deliver), pool_busy (the pool wallet could not cover it), unknown (a held payout that did not go out), wallet_offline_cleared (the operator un-counted it); null on every other row.', shape: 'raw · csv', params: 'limit (≤200, default 20) · offset · format=csv' },
    'POST /api/account/:addr/withdrawals/proofs': { desc: 'Payment proofs for your own payouts, two kinds in one call. proofs: { <withdrawal id>: <kernel excess> } - the on-chain kernel of every confirmed payout (proves the tx was mined). payment_proofs: { <withdrawal id>: <PaymentProof> } - the signed proof grin-wallet requested on Tor payouts: { amount (nanogrin), excess, recipient_address, recipient_sig, sender_address, sender_sig }, the same JSON `grin-wallet export_proof` writes; save one as a file and `grin-wallet verify_proof` it. recipient_sig is YOUR wallet\'s signature, so it proves receipt to anyone. Slatepack/nostr payouts carry no signed proof (kernel only). Newest 500 signed proofs. Ownership-gated on purpose: publishing an address next to its kernels would be a public address-to-chain index on a privacy coin. 403 = proof failed, 404 = no such account.', shape: 'raw', auth: 'ownership proof', rate: 'withdraw', body: OWNER_PROOF_BODY },
    'GET /api/account/:addr/tor-check': { desc: 'Is this miner\'s wallet answering over Tor right now? The pool opens a fresh Tor circuit to the onion derived from the address and POSTs check_version to its foreign API; can take up to ~30 s. online is TRI-STATE: true = a grin-wallet answered; false = our Tor works and the wallet did not answer (or something that is not a wallet did); null = this pool could not look (its own Tor is down) — says nothing about the wallet, and a Tor payout is still allowed. reason: reachable · reachable_auth · onion_unreachable · onion_timeout · no_answer · not_wallet · invalid_format · derivation_failed · tor_unavailable · probe_failed. 404 if the address has never mined here — the probe is not offered for arbitrary Grin addresses. Answers are cached 60s per address; fresh=1 re-probes, but only once the cached answer is 10s old (younger answers are served as-is), and joins a probe already running. The payout gate always re-probes fresh.', shape: 'raw', params: 'fresh=1 (re-probe; 10s floor)', rate: 'torcheck' },
    'POST /api/account/:addr/withdraw': { desc: 'Request a payout on one of three rails. amount defaults to the full available balance. 403 = ownership proof failed; 400 = invalid amount, below the minimum, or too small to cover the flat fee; 409 = insufficient balance, or payouts frozen by the operator; 409 (tor) = wallet unreachable (nothing locked): the body carries tor_online: false and suggest: "slatepack"; 409 (nostr) = destination unregistered, still in cooldown, or its npub changed; 429 = a payout is already pending on ANY rail (one at a time — a Held Tor payout counts), a recently reversed payout is still in its cooldown (not after a failed Tor payout), or the pool-wide pending cap is full; 429 (tor) with error: "tor_paused" = Tor is paused for this address after 5 failed Tor payouts in 24 h — the body carries paused_until (unix seconds, UTC), failures_24h, max and suggest: "slatepack"; nothing is locked; 503 = the nostr rail is disabled, or the pool wallet cannot cover the payout right now (funds tied up in payouts still settling — the balance is returned; retry in about an hour). A slatepack request also returns `slatepack` (encrypted to your address) and `expires_at` (unix seconds): return the response before then or the payout expires and the balance comes back.', shape: 'flat', auth: 'ownership proof', rate: 'withdraw', body: `method=tor|slatepack|nostr (default tor) · amount (default: full balance) · ${OWNER_PROOF_BODY}` },
    'POST /api/account/:addr/withdraw/:id/finalize': { desc: 'Complete a slatepack payout by posting back the response slatepack your wallet produced with `receive`. The pool finalizes and broadcasts. 404 = no such withdrawal; 409 = not awaiting a slatepack (already settled or expired); 400 = the slatepack does not match this withdrawal.', shape: 'flat', auth: 'ownership proof', rate: 'withdraw', body: `response_slatepack · ${OWNER_PROOF_BODY}` },
    'POST /api/account/:addr/withdraw/:id/slatepack': { desc: 'Fetch a pending slatepack payout\'s slatepack again — for when the tab was closed or it was never copied. Returns the SAME slatepack issued at request time (encrypted to your address), never a new one, plus `expires_at` (unix seconds). Manual slatepack rail only; served only while the payout is still awaiting your response. 403 = ownership proof failed; 404 = no pending slatepack payout with that number for this address (settled, expired, another rail, or not yours).', shape: 'flat', auth: 'ownership proof', rate: 'withdraw', body: OWNER_PROOF_BODY },
    // NOT the shared OWNER_PROOF_BODY: this is the one route that needs the IP and the password
    // as two separate fields (either alone is a 400 both_proofs_required), so the "IP or
    // password" wording every other money route carries would be wrong here.
    'POST /api/account/:addr/nostr-destination': { desc: 'Register/replace the Goblin username for Nostr payouts. Does NOT move funds — it pins the destination and (re)starts a security cooldown, during which the nostr rail refuses to pay. Needs BOTH proofs as separate fields (400 both_proofs_required otherwise), and each must have been on record for at least the cooldown period — a 409 reason of proof_too_recent means the evidence is newer than that, and anchor_not_accepted_here means the proof matched only the original write-once record after it had dropped out of the live set of 10 (it can withdraw, but not redirect; while it is still live it counts as an ordinary proof). Replacing an existing destination is refused with 409 confirm_replace_required (the response echoes `replacing`) until the call carries confirm_replace = the username being replaced. 503 when the rail is disabled.', shape: 'flat', auth: 'ownership proof (BOTH kinds)', rate: 'withdraw', body: 'username (Goblin/NIP-05) · proof (recent mining IP; legacy alias ip_proof) · password_proof (the rig\'s stratum password) · confirm_replace (current username, only when replacing)' },
    'POST /api/account/:addr/donor-profile/name': { desc: 'Set your donor name. It is checked automatically and, if it passes, shown on the donor wall AT ONCE (status approved), replacing your previous name. Rules: 2-32 characters, letters, digits, spaces and - _ . & \' only, at least one letter or digit, case kept, not like a GRIN address; one change per 7 days. Answered BEFORE the proofs are checked: 400 name_length / name_charset / name_no_alnum / name_invalid / name_address (the rule, explained), 409 unchanged, 429 name_cooldown + available_at (unix UTC). Answered only AFTER both proofs: 400 name_not_allowed (a reserved or blocked word — the answer never says which), 409 name_unavailable (another donor has it, or it is banned — the answer never says which). Needs BOTH proofs, each on record for at least the security floor (same gate as a Goblin destination change: 400 both_proofs_required, 409 proof_too_recent / anchor_not_accepted_here, 403 a proof that does not match). 409 not_a_donor = no donation debit yet; 403 blocked; 503 donations_off. A refused name is stored nowhere. The pool can still take a live name down (the reason is shown on your account page).', shape: 'flat', auth: 'ownership proof (BOTH kinds)', rate: 'withdraw', body: `name · proof (recent mining IP; legacy alias ip_proof) · password_proof (the rig\'s stratum password)` },
    'POST /api/account/:addr/donor-profile/banner': { desc: 'Submit a donor banner for review (multipart/form-data). Shown only after approval, and only while the address ranks in the top donor_banner_slots of the donor league. PNG, JPG or GIF (animation allowed), identified from the bytes: SVG and WEBP are refused. 320-1600 x 80-400 px, 2:1 to 8:1 wide, at most 300 KB, 800 x 200 recommended. 413 banner_too_large; 400 banner_type / banner_unreadable / banner_dimensions / banner_aspect. Same proofs and refusals as the name route.', shape: 'flat', auth: 'ownership proof (BOTH kinds)', rate: 'withdraw', body: `file (the image) · proof (recent mining IP; legacy alias ip_proof) · password_proof (the rig\'s stratum password)` },
    'DELETE /api/account/:addr/donor-profile/:kind': { desc: 'kind = name | banner. which=pending withdraws the banner waiting for review (a name is never pending: it goes live at once); which=live takes the approved one off the wall. Same BOTH-proofs gate as a submit, but works with donations off and on a blocked address: removing your own data is always allowed. 404 nothing_pending / nothing_live.', shape: 'flat', auth: 'ownership proof (BOTH kinds)', rate: 'withdraw', body: `which=pending|live · proof (recent mining IP; legacy alias ip_proof) · password_proof (the rig\'s stratum password)` },
    'DELETE /api/account/:addr/nostr-destination': { desc: 'Remove the registered Goblin payout destination, clearing the pin and cooldown.', shape: 'flat', auth: 'ownership proof', rate: 'withdraw', body: OWNER_PROOF_BODY },
  };
  router.get('/api/public/endpoints',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        // Express 4: the route table hangs off app._router. Express 5 renames it to app.router,
        // so accept either — otherwise a major-version bump would silently empty this page
        // rather than fail loudly (the catch below would never even fire).
        const router = req.app._router || req.app.router;
        // Routes now live in Routers mounted with app.use(): flatten those layers (code-layout
        // refactor P3 — the one non-move edit; scripts/test-endpoints-directory.js).
        const flatten = (stk) => (stk || []).reduce((acc, layer) => {
          if (layer && layer.name === 'router' && layer.handle && layer.handle.stack) acc.push(...flatten(layer.handle.stack));
          else acc.push(layer);
          return acc;
        }, []);
        const stack = flatten(router && router.stack);
        const seen = new Set();
        const out = [];
        for (const layer of stack) {
          const route = layer && layer.route;
          if (!route || !route.path) continue;
          const paths = Array.isArray(route.path) ? route.path : [route.path];
          for (const p of paths) {
            if (typeof p !== 'string') continue;
            if (!PUBLIC_API_PREFIXES.some((pre) => p === pre || p.startsWith(pre))) continue;
            const methods = Object.keys(route.methods || {})
              .filter((m) => m !== '_all').map((m) => m.toUpperCase());
            for (const m of methods) {
              const key = m + ' ' + p;
              if (seen.has(key)) continue;
              seen.add(key);
              const meta = API_DOC_META[key] || {};
              out.push({
                method: m,
                path: p,
                description: meta.desc || '',
                shape: meta.shape || '',
                params: meta.params || '',
                body: meta.body || '',
                auth: meta.auth || '',
                gated: meta.gated || '',
                rate_limit: meta.rate || 'public',
              });
            }
          }
        }
        out.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.json({
          success: true,
          data: {
            count: out.length,
            endpoints: out,
            // Cross-cutting facts the page states once instead of on every row.
            notes: {
              errors: 'Errors are always { "error": "…" } with an HTTP status — never { success: false }.',
              cors: 'Public GETs send Access-Control-Allow-Origin: * (no credentials). POST/DELETE are same-origin only.',
              rate_limits: rateLimiter && rateLimiter.limits
                ? { public: rateLimiter.limits.public, withdraw: rateLimiter.limits.withdraw, export: rateLimiter.limits.export, torcheck: rateLimiter.limits.torcheck }
                : null,
              // Not "all timestamps": the row-level *_at fields are UNIX seconds, but the aggregate
              // feeds stamp their generation time as an ISO string and the price ticker in ms.
              // The rows that differ say so in their own description.
              times: 'Row timestamps (*_at, ts fields on ledger rows) are UNIX seconds (UTC). Exceptions are named on their rows: the generation-time `timestamp`/`ts` on the aggregate feeds (topology, peers, regions, poolstats) is ISO 8601, and price.updated_at is UNIX milliseconds.',
            },
          },
        });
      } catch (err) {
        res.status(500).json({ error: 'Failed to build API reference' });
      }
    }
  );

  // ─── Public Fortune Board: lottery winner history (no auth, rate-limited) ──────
  // Transparency/audit feed — winner (truncated address) + amount + date + verifiable seed.
  router.get('/api/public/lottery/winners',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        if (!incentivesManager || !incentivesManager.enabled()) {
          return res.json({ success: true, data: { total: 0, winners: [] } });
        }
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ success: true, data: lotteryManager.winnerHistory(limit, offset) });
      } catch (err) {
        res.status(500).json({ error: 'Failed to load winners' });
      }
    }
  );

  // Aggregate fortune-board stats (headline tiles + charts). Covers all history, unlike the
  // paginated winners feed above. Empty payload when incentives are disabled.
  router.get('/api/public/lottery/stats',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        if (!incentivesManager || !incentivesManager.enabled()) {
          return res.json({
            success: true,
            data: { total_prizes_grin: 0, total_winners: 0, unique_winners: 0, total_draws: 0, by_pot: [], by_event: [], monthly: [] },
          });
        }
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ success: true, data: lotteryManager.stats() });
      } catch (err) {
        res.status(500).json({ error: 'Failed to load lottery stats' });
      }
    }
  );

  // Single content page authored in the admin CMS (dynamic `pages` table; the legacy
  // fixed-slot config was migrated into it). `:key` is the page slug.
  router.get('/api/public/page/:key',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const page = pagesManager.getPublic(req.params.key);
        if (!page) return res.status(404).json({ error: 'Page not found' });
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ success: true, data: page });
      } catch (err) {
        res.status(500).json({ error: 'Failed to load page' });
      }
    }
  );

  // Navigable published pages (for footer/header link lists in public-shell.js).
  router.get('/api/public/pages',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ success: true, data: pagesManager.listEnabled() });
      } catch (err) {
        res.status(500).json({ error: 'Failed to load pages' });
      }
    }
  );

  // Blog: paginated list of published posts (cards).
  router.get('/api/public/posts',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const out = postsManager.listPublished({ limit: req.query.limit, offset: req.query.offset });
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ success: true, data: out });
      } catch (err) {
        res.status(500).json({ error: 'Failed to load posts' });
      }
    }
  );

  // Blog: full published post by slug (permalink page).
  router.get('/api/public/post/:slug',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const post = postsManager.getPublic(req.params.slug);
        if (!post) return res.status(404).json({ error: 'Post not found' });
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ success: true, data: post });
      } catch (err) {
        res.status(500).json({ error: 'Failed to load post' });
      }
    }
  );

  // ─── ADS (Public) ──────────────────────────────────────────────────
  // Active, in-window ads for the public site. `?placement=header` returns one slot;
  // no param returns all slots keyed by placement. Only render-relevant fields are
  // exposed. Cached 60 s (every visitor on every page hits this) — ad edits take up
  // to a minute to appear publicly.
  router.get('/api/public/ads', rateLimiter.middleware('public'), (req, res) => {
    try {
      res.set('Cache-Control', 'public, max-age=60');
      const p = req.query.placement;
      const cfg = adsManager.getConfig();
      if (p) return res.json({ placement: p, ads: adsManager.publicByPlacement(p), ...cfg });
      res.json({ ads: adsManager.publicAll(), ...cfg });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Impression/click beacon — coarse per-ad counters only (no per-visitor rows, no
  // IPs). Ids are sanitised + capped in recordEvents; always 204 so the client never
  // retries or logs (ads are non-essential), and so the response never reveals which
  // ad ids exist. UNAUTHENTICATED AND UNDEDUPED BY DESIGN — the counters it moves are
  // not measurement and the admin panel labels them "unverified" (audit §J10-3 /
  // §J14-9). recordEvents only counts ads the public site is actually serving.
  router.post('/api/public/ads/event', rateLimiter.middleware('public'), (req, res) => {
    try { adsManager.recordEvents(req.body || {}); } catch (err) { /* counters only — never fail the page */ }
    res.status(204).end();
  });
  return router;
};
