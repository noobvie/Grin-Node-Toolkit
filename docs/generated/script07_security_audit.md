# Script 07 — Public Pool Security Audit (White-Label / Uploads)

Scope: the white-label admin features (asset uploads, custom HTML injection, public
config endpoints) added to `web/07_mining_pool_public/`. See `script07_design.md` for the
feature design.

## Asset upload hardening (fixed)

The upload endpoint (`POST /api/admin/assets/upload`) is admin-only (`secureAdmin` =
IP allowlist + admin JWT + rate limit) and capped at 2 MB / 1 file. The following
upload-specific weaknesses were found and fixed.

| # | Finding | Risk | Fix |
|---|---------|------|-----|
| 1 | Served `Content-Type` is driven by the file **extension**, and the extension came from the uploader's original filename; the MIME check trusted the spoofable declared `Content-Type`. An `evil.html` declared as `image/png` would be served as `text/html` → **stored XSS in the pool origin**. | High (admin-gated) | Filenames are now **server-controlled**: `${type}_${ts}_${rand}.${ext}` where `ext` comes from the *detected* content type. The original name is never used for the on-disk name. |
| 2 | `req.query.type` was concatenated into the filename **unsanitised**, and `multer` wrote to disk *before* `saveAsset` validated the type → **arbitrary file write** via `../`. | Medium | Switched to `multer.memoryStorage()` — nothing is written until validation passes. `type` is sanitised (`[^a-z0-9_]` stripped) and the resolved path is asserted to stay inside the upload dir. |
| 3 | No content validation — only the spoofable declared MIME was checked. | Medium | `detectImage()` sniffs **magic bytes** (PNG/JPEG/GIF signatures; SVG must parse as `<svg>` in the head). Non-images are rejected with 400. The detected MIME (not the declared one) is stored. |
| 4 | The `/custom/` static location had no isolating headers, so a served SVG/HTML could execute on direct navigation. | Medium | The vhost `location /custom/` now sets `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`. Correct image MIME types are preserved so logos/icons still render; the sandbox CSP neutralises script inside any SVG opened directly. |

**Delete path** (`deleteAsset`) only unlinks the stored basename within the upload dir and
requires a matching DB row first — no traversal.

**SVG decision:** `image/svg+xml` remains allowed (logos are commonly SVG). It is defended
by (a) magic/structure validation at upload and (b) the `nosniff` + sandbox CSP headers at
serve time. `<img src>` embedding never executes SVG scripts; the headers cover the
direct-navigation case.

## Residual / accepted risks

- **Admin-authored HTML is stored, site-wide XSS by design.** `custom_css`,
  `custom_head_html`, `custom_body_html`, content-page HTML, banner messages, and the
  maintenance message are injected verbatim and render in **every visitor's browser**.
  This is inherent to "inject custom HTML" white-label features. Mitigation is the admin
  auth stack (bcrypt + JWT + IP allowlist + rate limit + httpOnly cookies) — i.e. an
  attacker must already control the admin account. If an operator wants to eliminate the
  vector entirely, expose a switch to disable the raw-HTML fields (not implemented).
- **Public-page CSP includes `'unsafe-inline'` for scripts** (required by the inline page
  bootstraps + analytics init). This weakens the site-wide XSS barrier and compounds the
  point above. A nonce-based CSP would be stronger but is impractical with nginx-served
  static pages + client-side injection.
- **Host header reflection** in `robots.txt` / `sitemap.xml` (`siteOrigin()` falls back to
  `req.get('host')` when `site_url` is unset). Low severity; set `site_url` to pin it.

## Public endpoints (reviewed, no change needed)

`/api/public/branding`, `/api/public/page/:key`, `/robots.txt`, `/sitemap.xml`,
`/manifest.json` are unauthenticated and rate-limited (`public` tier). They expose only the
curated, operator-set fields from `buildPublicConfig()` — no balances, secrets, IPs, or
alert thresholds. `:key` is validated against the fixed `pages` allowlist; the `page.html`
client also strips the `?p=` param to `[a-z0-9_-]`.
