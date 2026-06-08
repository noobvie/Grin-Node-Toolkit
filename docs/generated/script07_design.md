# Script 07 — Public Pool White-Label System (Design)

Covers the admin-configurable branding / SEO / analytics system for the public mining
pool (`web/07_mining_pool_public/`). Scope: how operator customisation flows from the
admin panel into the public-facing pages.

## Problem

The admin panel stored branding/SEO/GA settings in `pool_config`, but nothing rendered
them — every public page shipped hardcoded `GRINIUM` titles, meta tags, and OG data.
Settings were effectively write-only. Two unrelated theme systems also existed (public
pages use `body.<name>-theme` CSS classes; the admin panel uses CSS-variable themes in
`theme.js`), and three themes (`matrix`, `naruto`, `japan`) were defined but never
exposed in the UI.

## Architecture

Static pages are served directly by **nginx** from `/var/www/grin-pool`; the Node/Express
backend only answers `/api/*` (proxied). Server-side templating of the HTML is therefore
not available. Customisation is applied **client-side**:

```
admin (settings.html) ──POST /api/admin/settings/<section>──▶ pool_config (SQLite)
                                                                     │
public page ──GET /api/public/branding──▶ buildPublicConfig() ◀──────┘
      │
      └─ /js/branding.js applies: title/meta/OG/Twitter/canonical/JSON-LD,
         theme (CSS vars + custom CSS + font), analytics, [data-brand] content
```

- **`/api/public/branding`** (public, rate-limited `public`, `Cache-Control: 60s`):
  returns the curated, non-sensitive payload from `PoolSettings.buildPublicConfig()`.
  Asset URLs are resolved via `AssetManager.getActiveAsset()`.
- **`/js/branding.js`**: loaded by every public page (before `</body>`). Defensive —
  any fetch/field failure leaves the page's hardcoded defaults intact. Bridges the two
  theme systems by writing CSS custom properties (works everywhere) plus toggling the
  public `body.<theme>-theme` class and persisting `admin-theme` for `theme.js`.

## Config schema (`pool_config`, generic section/key — no migration needed)

New/changed keys in `lib/pool-settings.js` `defaults`:

| Section | Keys |
|---|---|
| `branding` | `logo_dark_file`, `default_theme`, `allow_theme_switch`, `custom_theme` (JSON of CSS-var→value), `font_family`, `font_url`, `hero_heading`, `hero_subheading`, `cta_text`, `cta_link` (plus existing logo/favicon/accent/custom_css/social/footer) |
| `seo` | `title_template` (`%page%`,`%pool_name%`), `og_locale`, `twitter_handle`, `twitter_card_type`, `theme_color`, `page_seo` (JSON `{pageKey:{title,description}}`), `structured_data_enabled`; **`ga_tracking_id` removed** (moved to `analytics`, still read as a fallback for back-compat) |
| `analytics` *(new)* | `provider` (`none\|ga4\|plausible\|umami\|matomo`), `ga_tracking_id`, `plausible_domain`, `plausible_src`, `umami_website_id`, `umami_src`, `matomo_url`, `matomo_site_id`, `custom_head_html`, `cookie_consent_enabled`, `cookie_consent_text` |

`custom_theme` / `page_seo` validators accept an object or JSON string and always persist
a JSON string. Provider URLs and IDs are format-validated.

## Theme builder

The Branding tab renders a colour picker per CSS variable (keys match `theme.js`:
`primary`, `accent`, `bg-body`, `text`, …). On save they are serialised into the hidden
`custom_theme` field; only variables changed from the `#000000` placeholder are recorded.
`default_theme: custom` makes `branding.js` apply the full custom palette; otherwise the
custom values partially override the chosen named theme. The three previously hidden
themes (`matrix`/`naruto`/`japan`) plus `atomic` are now selectable in the dropdown.

## Per-page SEO

Pages declare a key via `<html data-page="...">` (e.g. `home`, `pool-info`,
`miners-stats`); `branding.js` falls back to the path basename. `page_seo[key]` overrides
title/description for that page; otherwise the title comes from `title_template`.

## Analytics & CSP

`branding.js` injects the selected provider's script (GA4 / Plausible / Umami / Matomo)
plus any `custom_head_html`, optionally gated behind a cookie-consent banner. Because
nginx (not Express) sets the CSP for static pages, the vhost CSP in
`scripts/07_grin_mining_public_pool.sh` was widened to permit `'unsafe-inline'` scripts,
the managed provider script/beacon hosts, and Google Fonts. **Self-hosted Plausible /
Umami / Matomo on a custom domain require adding that domain to `script-src` and
`connect-src` in the vhost CSP.**

## Content hooks

`branding.js` sets `textContent`/`href` on elements carrying `data-brand="..."`:
`pool_name`, `pool_tagline`, `hero_heading`, `hero_subheading`, `cta`, `footer_text`,
`logo`, `social-<net>`, `banner`. Adding a hook to any page is a one-line attribute.

## Security notes

- The public endpoint exposes only operator-set, non-sensitive fields (no balances,
  secrets, IPs, or thresholds).
- `custom_css` / `custom_head_html` are injected verbatim. They are settable only by the
  authenticated admin and render on the operator's own site, so this is operator-against-
  self — acceptable for a white-label tool, but worth noting in the audit doc.

## Files touched

- `back-end-pool/lib/pool-settings.js` — defaults, validators, `buildPublicConfig()`
- `back-end-pool/lib/asset-manager.js` — added `logo_dark` asset type
- `back-end-pool/index.js` — `GET /api/public/branding`
- `back-end-pool/admin-panel/settings.html` — Analytics tab, theme builder, hero/slogan,
  per-page SEO, exposed themes
- `public_html/js/branding.js` — new injector
- `public_html/*.html` — `data-brand` hooks (index) + `branding.js` include (all pages)
- `scripts/07_grin_mining_public_pool.sh` — widened nginx CSP

## SEO files & PWA manifest (dynamic)

`robots.txt`, `sitemap.xml`, and `manifest.json` are generated on the fly by Express and
exposed through exact-match nginx `location =` proxies (so they win over any static file
of the same name):

- **`/robots.txt`** — `Disallow:` (index by default). When `seo.robots_noindex` is true it
  emits `Disallow: /` and drops the `Sitemap:` line. References `/sitemap.xml` otherwise.
- **`/sitemap.xml`** — lists the core public pages plus any authored content pages
  (`/page.html?p=<key>`). Returns 404 when noindex or `sitemap_enabled=false`.
- **`/manifest.json`** — built from `pool_name`, `app_short_name`, `theme_color`, and the
  uploaded `icon_192` / `icon_512` assets.

The canonical origin is `seo.site_url` if set, else the request host.

## Content pages

A new `pages` config section holds operator-authored HTML for `about`, `terms`,
`privacy`, `faq`, `impressum` (titles fixed in `PoolSettings.pageTitles`). **Empty content
disables a page.** `GET /api/public/page/:key` returns `{title, html}` (404 when empty);
`public_html/page.html` renders it client-side and `branding.js` auto-adds footer links to
enabled pages via the `[data-brand="page-links"]` hook. Impressum is included for EU/German
operators. Content is operator-controlled HTML (operator-against-self, like `custom_css`).

## Miner-config generator

`public_html/connect.html` (reachable at `/connect`) fetches `/api/public/branding`, reads
the new `connection` block (`stratum_host` = `pool_info.public_stratum_host` or request
host; `stratum_port` from `pool.json`; network; `Cuckatoo32`) and generates copy-paste
commands for lolMiner / GMiner / SRBMiner-MULTI using the miner's `address.worker` stratum
username. The homepage CTA points here by default.

## Maintenance mode & announcement banners

New `notices` config section drives two site-wide features, both rendered by `branding.js`
and exposed through `/api/public/branding`:

- **Maintenance mode** (`maintenance_mode` / `maintenance_title` / `maintenance_message`) —
  a clear on/off toggle on the **Announcements** admin tab (removed from the visibility
  dropdown). When on, `branding.js` paints a branded full-page overlay on public pages.
  Pages that must stay reachable opt out with `<html data-maintenance="exempt">`
  (`login`, `admin-dashboard`, `account-settings`). The admin panel (`/admin/…`) never
  loads `branding.js`, so settings stay editable; **stratum/mining is untouched** — miners
  keep hashing during maintenance.
- **Announcement banners** (`banners` = JSON array) — typed (`news` / `update` /
  `maintenance` / `warning`), each with message, optional link, enable toggle, dismissible
  flag, and optional `start`/`end` date. `buildPublicConfig` returns only banners that are
  enabled and inside their date window (`getActiveBanners`). `branding.js` stacks them at
  the top of every public page, colour-coded by type; dismissals persist per banner id in
  `localStorage`. The admin **Announcements** tab has an add/remove row editor.

## Other white-label additions

- **Theme export/import** — download/upload the `custom_theme` JSON from the builder.
- **Full icon set** — `apple_touch_icon`, `icon_192`, `icon_512` asset types (Apple touch
  link injected by `branding.js`; 192/512 feed the manifest).
- **"Powered by" toggle** — `branding.show_attribution` hides `[data-brand="attribution"]`.
- **Custom body HTML** — `analytics.custom_body_html` injected before `</body>` (chat
  widgets); sibling to `custom_head_html`.

## Uploaded asset serving (`/custom/`)

Asset URLs are `/custom/<file>` (`AssetManager.getAssetUrl`). The upload directory is now
config-driven: `assets_dir` in `pool.json` (default `$POOL_APP_DIR/custom_assets`), resolved
via `path.resolve` in `AssetManager`. The deploy script creates the directory, makes it
nginx-traversable (`chmod o+rx` on it and its parents), and the vhost serves it:

```nginx
location /custom/ {
    alias /opt/grin/pool/mainnet/custom_assets/;
    try_files $uri =404;
    expires 7d;
}
```

This replaced a hardcoded `/opt/grin/mining-pool-<net>/custom_assets` path that did not
match the app's actual working directory, so uploaded logos/icons/OG image (and the PWA
manifest icons) now load. `img-src 'self'` in the CSP already permits them.

## Incentive features (prize pool, bonuses, lottery)

Fun, balanced incentives to attract and retain **small** miners without letting raw hashrate
always win. All configured from the admin **Incentives** tab; all off until the master switch
(`incentives_enabled`) is on. Register-free is preserved — the grin_address is the identity.

### Prize pool = reserved pseudo-address
A single bucket funds every prize: the reserved `prize_pool` row in `miner_accounts` (mirrors
the existing `pool_fee` pseudo-row). Funding credits it; prizes debit it; all movements go
through `balance_log` for audit. `IncentivesManager.RESERVED_ADDRESSES = ['pool_fee','prize_pool']`
is filtered out of every miner-facing surface (leaderboards, `rewardStats`, lottery eligibility).
Prize debits never overdraw the bucket (`debitPrizePool` returns false if insufficient).

**Funding (3 sources):**
1. **Fee cut** — `prize_fee_cut_percent` of the collected pool fee is diverted from `pool_fee`
   → `prize_pool` during reward distribution (net-zero move, [rewards.js](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js) `creditBalances`).
2. **Miner donations** — a miner names a worker `donate10` (or `rig01-donate10`) to donate N%
   of their payout. Parsed in [stratum-protocol.js](../../web/07_mining_pool_public/back-end-pool/lib/stratum-protocol.js) `validateUsername`; **only N in 0–100
   donates** (`donate0` opts out). Out-of-range/mistyped tokens (`donate101`, `donate-1`,
   `donatexx`, bare `donate`) are kept as a literal worker name and donate nothing — a typo can
   never cause an accidental donation. Stored in `miner_incentives.donation_percent`.
3. **Manual top-ups + public donation address** — operator credits the bucket via
   `POST /api/admin/incentives/prize-pool/topup` (accounting only). A published Slatepack
   `donation_address` lets anyone donate; received funds are reflected via a manual top-up.

The public **`donate.html`** page explains both channels (the `donateN` worker tag with an
examples table, and the Slatepack address with copy button) and shows the live prize-pool size;
**`fortune-board.html`** shows the winner history. Both link to each other and are in the sitemap.

### The four features
- **Join bonus** — one-time `join_bonus_amount`, paid only after an address's **first confirmed
  withdrawal** (anti-Sybil gate; spammers never reach a real payout). Idempotent via
  `miner_incentives.join_bonus_paid`; triggered from `withdrawal-scheduler.js markConfirmed`.
- **Block-finder jackpot** — flat `jackpot_amount` to `block.found_by`, credited at block
  **maturity** ([block-monitor.js](../../web/07_mining_pool_public/back-end-pool/lib/block-monitor.js)/`orphan-detector.js` confirm path, idempotent per height),
  and **clawed back on orphan** via `orphan-detector.js reverseBlockPayouts → reverseJackpot`.
  Sybil-proof: a small miner who solves a block gets the full flat jackpot.
- **Loyalty streak** — capped multiplier (`streak_bonus_per_week_percent`/week, max
  `streak_max_percent`) for consecutive mining days; daily `updateStreaks()` job; top-up funded
  from `prize_pool` so it never dilutes other miners' base PPLNS. Stale streak (no shares
  today/yesterday) → 0.
- **Lottery** — weekly + special-occasion (`lottery_special_events`: Christmas 12-25, New Year
  01-01, Grin Genesis 01-15, …). Two pots: **A = share-weighted** (tickets ∝ valid shares,
  favours contribution, Sybil-resistant) and **B = equal-chance** (one entry per qualifying
  address ≥ `lottery_min_shares`, favours small miners). **Verifiable**: the winner is picked
  deterministically from the node tip block hash (`seed_hash`) captured at draw time —
  `LotteryManager.seededMod`/`pickWeighted` — so anyone can recompute the result. Scheduler:
  hourly `runDueDraws()`; manual `POST /api/admin/incentives/lottery/draw-now`.

### Schema (db.js)
`miner_incentives` (per-address: join_bonus_paid, donation_percent, streak_days, last_active_day),
`lottery_draws` (period, seed_height/seed_hash, pot amounts, status), `lottery_winners`
(draw_id, address, pot a/b, ticket_count, amount). Balance-log `reference_type` markers:
`fee_cut`, `donation`, `streak`, `join_bonus`, `jackpot`, `jackpot_reversal`, `lottery`, `topup`.

### Fortune board (public transparency)
`fortune-board.html` lists full winner history (winner + amount + date + draw seed) via
`GET /api/public/lottery/winners` (paginated, truncated addresses, seed shown for audit).
Themed via shared `--t-*` variables. Prize-pool size + donation address surface through
`branding.js` `[data-brand]` hooks (`prize-pool`, `fortune-board`, `donation-address`).

### Known trade-off (register-free)
Pot B (equal-chance) and per-address bonuses are partly Sybil-farmable without accounts — a
whale can split into many addresses. Accepted: share-weighting + a min-shares bar raise the
cost, and the Sybil-*proof* features (jackpot, streak, fee-cut funding) carry the fairness load.
Optional free accounts for true one-person-one-entry is a deferred phase-2 item.

### Grin Transporter (payout rail #3 — placeholder)
`transporter_enabled` is reserved and forced off (read-only admin card); `lib/wallet-transporter.js`
is a throwing stub. See [script056_design.md](script056_design.md) — shipping is gated on whether
miners' existing wallets can receive on a relay.

## Follow-ups (not implemented)

- i18n / multi-language content and fiat (USD/EUR/BTC) price display.
- Optionally unify the public `body.<theme>-theme` system onto the `theme.js` CSS-variable
  system to remove the dual-theme split.
- Admin live-preview iframe and a WCAG contrast check in the theme builder.
