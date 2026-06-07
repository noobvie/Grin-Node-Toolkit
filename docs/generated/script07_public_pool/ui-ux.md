# GRINIUM — UI / UX

**Updated:** 2026-06-06
Frontend reality, theme system, the **theme/UX rework** (open item), public
pages, and frontend standards.

---

## Frontend reality

Static **HTML + vanilla JS** served by nginx — **not** React/Next.js/Tailwind
(see [00_overview.md](00_overview.md)). Files:

```
web/public_html/
  index.html  login.html  miners-stats.html  payment-history.html
  pool-info.html  system-health.html  account-settings.html  admin-dashboard.html
  grin_mining_testnet_instruction.html   (8-step IPOLLO testnet guide — DONE)
  css/pool.css        single stylesheet, CSS-variable driven
  js/api.js           fetch wrappers
  js/auth.js          login/session (auth gate BUG-19 — see security.md)
  js/theme.js         theme switcher (5 themes)
  images/  *.svg, manifest.json, robots.txt, sitemap.xml
web/back-end-pool/admin-panel/   second HTML tree (index/users/miners/payments/health/settings)
web/back-end-pool/public/        login.html, admin.html
web/preview/         design mockups (NOT wired to the app)
```

**Two structural problems to resolve:**
- **Two HTML trees, one reachable.** `public_html/` is served; the
  `back-end-pool/admin-panel/` and `back-end-pool/public/` trees are never
  registered as static routes (BUG-34). Decide one: serve admin from
  `public_html/` via nginx, **or** mount admin-panel behind a `requireAdmin`
  static route. Don't keep both.
- **Hardcoded production URLs** (`https://pool.grin.money/...`) baked into
  `og:url`/canonical/twitter tags on 9 pages (BUG-36). Template from
  config/subdomain at deploy time.

---

## Theme system & the rework (open item)

`js/theme.js` ships **5 themes** — Matrix (green `#00ff00`), Dark (purple
`#f093fb`, the default), Light, Naruto, Japan — applied via CSS variables and
persisted to localStorage. `css/pool.css` is the single variable-driven sheet.

**Known bug:** the theme localStorage key is **fragmented** across files
(`admin-theme`, `grinium-theme`, `grin-pool-theme`) — BUG-35. Consolidate to one
key (`pool-theme`).

### The atomic preview — what the user is unhappy with

`web/preview/grinium-v1-atomic.html` ("GRINIUM — Uranium Mining Pool") is a neon
**cyberpunk/uranium** aesthetic: near-black `#0a0a0a`, neon cyan `#00f7ff`, neon
magenta `#ff00ff`, uranium-lime `#b8e600`, `Courier New` mono. **This is the
current direction the user finds unsatisfactory** — too loud/neon, weak on
usability.

Other explorations in `preview/`: `cyberpunk-pool-home.html`,
`dual-theme-complete.html`, plus mockups for account-settings, admin-dashboard,
miners-stats, payment-history, pool-info, system-health.

### Redesign direction (DECIDED 2026-06-06 → mockup built)

Chosen: **clean dark dashboard** — data-first, calm, legible, restrained
Grin-green accent, no neon glow. A full clickable static mockup was built at
**`web/mockup/`** (open `index.html`, or `python3 -m http.server`). It includes
dashboard, blocks, payments, miners, account (with the Tor/Slatepack withdraw
modal), login, admin, and FAQ — all sharing `theme.css` (CSS-variable tokens) +
`app.js` (light/dark toggle, mock chart). Theme preference uses the single key
`grinium-theme`, consolidating the old fragmented keys (BUG-35).

The old neon `grinium-v1-atomic` exploration and the other early mockups are
archived as `web/preview/old_*.html`.

| Direction | Status |
|---|---|
| **Clean dark dashboard** | ✅ chosen — `web/mockup/` |
| Retro terminal (amber) | considered; retune `theme.css` tokens if revisited |
| Atomic neon | rejected (archived `old_*`) |

Next step when wiring for real: port `theme.css` tokens into the live
`public_html/css/pool.css` + `js/theme.js`, replace placeholder data with API
calls, and drop the unused themes. Palette retuning = edit the CSS variables at
the top of `theme.css`.

UX priorities for the rework (independent of palette):
- Data-table-first layout; live values legible at a glance (large mono numbers).
- Mobile responsive (tables stack; ≥44px touch targets; hamburger nav).
- Consistent components: cards/panels, badges, stat readouts, buttons.
- Blinking-cursor / skeleton loading states; clear error cards.
- Distinct visual treatment for the admin area (signals elevated access).

---

## Pages

**Public (no auth):**
- `/` home — miners online, pool hashrate (C32), network difficulty/hashrate,
  last block + mining height, pool fee, luck %, GRIN price; 24h hashrate chart;
  5–10s refresh.
- `/blocks` — height, hash, reward, found, status (immature/mature/orphan),
  confirms; 50/page.
- `/payments` — recent confirmed withdrawals (aggregated/anonymized — see
  [security.md](security.md)).
- `/miners` — top-50 leaderboard by 24h hashrate (truncated addresses).
- `/account/:addr` — per-miner: hashrate (live/1h/24h), balance + locked,
  workers, recent blocks, payout history, **pending withdrawal status + claim
  link if Slatepack**.
- `/faq`, `/help` — static (mining setup, GPU/ASIC, payout timing, Tor vs
  Slatepack, troubleshooting).

**Admin (requireAdmin):** dashboard, users, miners, withdrawals, **payment-stats**
(reconciliation + anomalies — see [payments.md](payments.md)), health, settings.

---

## Frontend standards (public pages)

- **SEO:** title/description/og/canonical per page; JSON-LD
  (`schema.org/SoftwareApplication`); `sitemap.xml`; `robots.txt` allows public,
  disallows `/admin`.
- **Mobile:** breakpoints 320/768/1024; responsive Chart.js; tables stack.
- **Performance:** lazy-load charts, minify CSS/JS, compress images; Lighthouse
  target ≥ 80 mobile / ≥ 90 desktop.
- **GA4 (optional):** `gtag.js` in the shared header; track page_view +
  view_pool_stats/blocks/miners/payments + search_miner; tracking ID via env;
  footer privacy note.
- **External:** optional daily push to `miningpoolstats.stream` for the public
  Grin leaderboard (Phase 2+, low priority).

> Public pages are a confidence-building **Phase 2+** effort (~15–20h) layered on
> after the core mining/payment system works. The theme rework can begin
> independently since it only touches CSS tokens + component markup.
