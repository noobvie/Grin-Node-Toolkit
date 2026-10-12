// Every HTTP route the pool serves, registered on `app` in the order Express will match them.
// This is the former setupRoutes() body from index.js, moved verbatim (code-layout refactor P1);
// later parts split it into per-area files under routes/ and this file becomes the ordered list.
//
// Where identifiers come from: stateless modules are require()d here exactly as index.js does
// (a lib re-required is the same cached module instance). Everything that is an INSTANCE or
// STATE — the managers, config, db, the failure Maps, and index.js's module-level helpers — is
// built once by index.js and handed over in `ctx`. None of them is reassigned after
// registerRoutes() runs (checked in P1), so destructuring them here is behaviour-identical to
// the old closure capture.

const express = require('express');
const { verifyOwnerProof, auditOwnerProof } = require('../lib/owner-proof');
const createGuards = require('./_shared/guards');
const createPublicRoutes = require('./public');
const createSeoRoutes = require('./seo');
const createAuthRoutes = require('./auth');
const createPoolRoutes = require('./pool');
const createAccountRoutes = require('./account');
const registerAdminRoutes = require('./admin');
const { GRIN_ADDR_RE } = require('./_shared/grin-address');
const caches = require('./_shared/caches');
const noAutoOptions = require('./_shared/no-auto-options');

module.exports = function registerRoutes(app, ctx) {
  const {
    config, db, stratumPause,
    poolSettings, uploadsDir,
    gamesLink,
  } = ctx;

  // ─── One shape check for the whole /api/account/ family (audit §J3-8) ──────────────────
  // Every route under /api/account/:addr took the address straight from the URL with no
  // validation at all. Two of them then interpolated it into a Content-Disposition filename,
  // and several did work for an address that has never existed here. One gate in front of the
  // whole block is better than thirteen sanitisers: nothing downstream has to wonder whether
  // `:addr` could be a quote, a control character, or 4 KB of junk.
  //
  // Deliberately mounted on the PATH rather than declared with app.param('addr', …): the
  // admin panel uses `:addr` too and legitimately addresses the `prize_pool` / `pool_fee`
  // pseudo-accounts, which are not bech32 and must keep working there.
  //
  // The segment is read from req.path and decoded here rather than read from req.params,
  // because inside a mounted middleware Express rebuilds params per layer — so a check
  // written against req.params can silently inspect something other than what the route
  // handler later receives (the trap recorded in memory project_comms_hub_09).
  app.use('/api/account', (req, res, next) => {
    const seg = String(req.path || '').split('/')[1] || '';
    let addr;
    try { addr = decodeURIComponent(seg); } catch (e) { addr = seg; }
    if (!GRIN_ADDR_RE.test(addr)) {
      // Same 404 shape an unknown-but-well-formed address already gets, so this adds no new
      // signal — a malformed address and an address that never mined here are both "not here".
      return res.status(404).json({ error: 'Account not found' });
    }
    next();
  });

  // Serve uploaded CMS media at /uploads. In production nginx serves this dir directly
  // (location /uploads/), but mounting it here too makes the app self-sufficient in dev
  // and a safe fallback if the nginx block is missing. immutable: filenames are unique.
  if (uploadsDir) {
    app.use('/uploads', express.static(uploadsDir, {
      maxAge: '7d', immutable: true, index: false, dotfiles: 'ignore',
      setHeaders: (res) => {
        // Parity with the nginx /uploads/ block: stop MIME-sniffing and neutralise any
        // script inside a directly-opened SVG. Overrides the app's global CSP for this
        // path (which otherwise allows 'unsafe-inline' and would let an SVG run script).
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      },
    }));
  }

  // One guards instance for the whole app (I7) — handed to every route file that needs a chain.
  const guards = createGuards(ctx);
  const { secureAdmin, stepUpRefused } = guards;

  // ─── Multi-region (Model C) ─────────────────────────────────────────────────
  // There is NO satellite share/block ingestion API any more. Regional GATEWAYS are
  // thin stratum forwarders (HAProxy + WireGuard, scripts/lib/07_lib_gateway.sh): they
  // forward raw stratum to a per-region internal port on THIS box (PROXY-protocol v2
  // carries the real miner IP). The central stratum-server records those shares directly
  // into the local DB with the region stamped from the listener — exactly like local
  // miners — so all accounting stays single-writer here. Per-region liveness is derived
  // from recent shares (+ best-effort WireGuard handshake); see /api/admin/health/gateways.

  // _brandingCache lives on routes/_shared/caches.js (readers here, invalidators in other files).
  const { invalidateBranding } = caches;
  // Every stratum pause transition — the 15 s timer's auto-resume and window start included —
  // drops the memo, so the computed maintenance overlay follows the pause (design §21.8).
  if (stratumPause) stratumPause.onChange = invalidateBranding;
  app.use(noAutoOptions(createPublicRoutes(ctx)));

  // ─── Games platform link (design §19.3) — all logic in lib/games-link.js ──────
  // The three internal routes are already mounted (top of file); this gives them the DB, starts
  // the 60 s health probe and mounts the admin proxy (/api/admin/games/*) behind secureAdmin,
  // with step-up enforced in the lib for the §19.11 paths.
  gamesLink.attach({ db, config, poolSettings, verifyOwnerProof, auditOwnerProof, onHealthChange: invalidateBranding });
  gamesLink.mountAdmin(app, { secureAdmin, stepUpRefused });

  app.use(noAutoOptions(createSeoRoutes(ctx)));
  app.use(noAutoOptions(createAuthRoutes(ctx, guards)));

  app.use(noAutoOptions(createPoolRoutes(ctx, app)));

  // Test endpoints removed for production security
  // REMOVED: /api/test/add-miner, /api/test/miners, /api/test/blocks, /api/test/tables
  // These endpoints are unprotected and allow arbitrary data manipulation.
  // For testing in development, use curl with direct database queries.





  app.use(noAutoOptions(createAccountRoutes(ctx)));

  // Test endpoint removed - manual block crediting disabled for security

  registerAdminRoutes(app, ctx, guards);
























  // REMOVED (2026-07-28): GET /api/miners/top — a public, unauthenticated rich-list. It paired a
  // full grin address with balance + balance_locked + share count + online flag + account age,
  // ordered by balance descending and offset-paginated, so a scraper could walk the pool's entire
  // custodial position miner by miner. Nothing in public_html/ or the admin panel called it, and
  // it duplicated /api/pool/miners (now address-masked). The legitimate public leaderboards are
  // /api/stratum/top-miners and /api/pool/top-block-finders, which rank on hashrate and blocks
  // found — contribution, not how much money is sitting in someone's pool balance.
















  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
};
