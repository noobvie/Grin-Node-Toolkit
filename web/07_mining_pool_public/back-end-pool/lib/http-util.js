'use strict';

// Small request/address helpers shared by route files (code-layout refactor P10; moved out of
// index.js verbatim). Stateless — safe to require from anywhere.

// True when a request arrived DIRECTLY on loopback (the trusted operator on the box —
// e.g. Script 07's guided installer hitting 127.0.0.1:8080), NOT proxied in from nginx.
// The app binds 127.0.0.1 only, and trust proxy='loopback' rewrites req.ip to the real
// client IP for anything coming through nginx (which always sets XFF). So a loopback req.ip
// can ONLY be a direct on-box call. Used to skip the anti-robot CAPTCHA for setup-time admin
// registration — the captcha exists to slow REMOTE brute force, not the local root operator.
//
// ⚠ The premise above is only true of a vhost where EVERY proxied location sets
// X-Forwarded-For, and §J12-3 found four that did not (the SEO file proxies) — on those,
// req.ip was nginx's own 127.0.0.1 for every visitor on Earth. The vhost is fixed, but an
// invariant that depends on a config file agreeing with it is not an invariant. So this now
// requires BOTH halves: a loopback socket AND no forwarding header at all. A request that
// came through nginx always carries one, so a genuine direct on-box call is the only thing
// that can satisfy both — and the next route someone proxies without the header inherits a
// refusal, not "the trusted root operator".
function isLocalRequest(req) {
  if (req.headers && req.headers['x-forwarded-for']) return false;
  const ip = String(req.ip || '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1';
}

// Public-surface address masking (grin1qxy…mn4p). The same truncation the front-end already
// applies when rendering, moved server-side on the aggregate/list endpoints: the pages look
// identical, but the raw API stops handing a scraper a full-address list in one call. NOT used
// on /api/account/:addr responses — there the caller already knows the address (it's identity).
//
// ⚠ THIS IS NOT DE-IDENTIFICATION, and it never was (audit §J11-1). Nine leading plus four
// trailing bech32 characters is a UNIQUE key: given any list of full addresses, every masked
// row re-attaches to its own by a plain table join. It only works as a control while NO public
// route publishes a full address — which is why, as of 2026-09-02, every public list endpoint
// that carries an address masks it, and the account-page deep-link was removed from the three
// leaderboards, the payouts table and the donor wall (those links were the full-address source
// that inverted the mask everywhere else). The invariant to keep:
//
//     NO public route may emit an unmasked grin_address in a LIST.
//
// `/api/account/:addr/*` is the one exception and is not a list — the caller supplied the
// address, so returning it reveals nothing. Adding a full address to any aggregate feed
// re-opens §J11-1 for `/api/pool/miners`, `/api/stratum/stats` and `/api/pool/unclaimed` at
// the same time, and `/api/pool/unclaimed` is the expensive one: its rows are balances whose
// owners are provably not watching. scripts/test-public-leakage.js asserts the invariant.
function maskAddr(a) {
  const s = String(a || '');
  return s.length > 16 ? `${s.slice(0, 9)}…${s.slice(-4)}` : s;
}

module.exports = { isLocalRequest, maskAddr };
