Review web files (HTML/CSS/JS/PHP/Python) for quality, security, and UX.
Check the file(s) or service directory specified as $ARGUMENTS, or all of web/ if none given.

## 1. Security (highest priority — these pages proxy to live wallet APIs)

**PHP (web/051_wallet/, web/051_xp_wallet/)**
- Every state-changing endpoint must verify the CSRF token from csrf.php before acting.
- Output must be escaped before rendering — no raw `echo $_POST[...]` or `echo $var` into HTML.
- `proxy.php` must whitelist allowed wallet API methods — it must not forward arbitrary caller-supplied method names.
- Secrets (API passwords, secrets) must never appear in PHP source — read from file paths only.

**JavaScript**
- No sensitive data (wallet secrets, API tokens) stored in `localStorage` or `sessionStorage`.
- All `fetch()` calls to the wallet API must go through the PHP proxy, never directly to the wallet port.
- User-supplied input rendered into the DOM must use `textContent`, not `innerHTML`.

**Python (web/052_drop/app/, web/07_pool/pool-manager/)**
- SQL queries must use parameterised statements — no string concatenation into queries.
- All routes that modify state must require authentication and validate the session.
- Rate limiting must be enforced on claim/withdrawal endpoints.

## 2. HTML Quality

- Every `<html>` must have `lang` attribute.
- `<head>` must include: `<meta charset>`, `<meta name="viewport">`, `<title>`, `<meta name="description">`.
- Favicon: check for `<link rel="icon">` pointing to `favicon.svg` (used project-wide).
- Open Graph tags (`og:title`, `og:description`, `og:type`) present on public-facing pages.
- Semantic structure: headings in logical order (no h3 before h2), landmark elements used (`<main>`, `<nav>`, `<footer>`).
- No deprecated tags (`<center>`, `<font>`, `<b>` for styling, `<i>` for non-icon use).

## 3. CSS Quality

- Mobile-first responsive: check for `@media` breakpoints. Flag pages with no responsive rules at all.
- No hardcoded pixel font sizes — prefer `rem`/`em`.
- Theme files (css/themes/*.css) must only override variables or theme-specific rules, not duplicate base styles.
- Flag unused CSS classes: classes defined in the stylesheet but not referenced in the matching HTML file.
- Consistent spacing/sizing units within a file (don't mix px and rem arbitrarily).

## 4. JavaScript Quality

- No `console.log` / `console.debug` left in production files.
- All `fetch()` / `XMLHttpRequest` calls must have `.catch()` or `try/catch` error handling.
- No unused functions or variables.
- Event listeners should be removed or scoped — flag global listeners added inside loops.
- `async/await` preferred over raw `.then()` chains for readability.

## 5. Performance

- External scripts/styles loaded from CDN should have `integrity` (SRI hash) and `crossorigin` attributes.
- `<script>` tags should use `defer` or `async` unless order-dependent.
- Images should have explicit `width`/`height` to prevent layout shift.
- CSS and JS files should not be inlined in HTML if they exceed ~20 lines (move to external file).

## 6. Deployment Permissions

After copying files to the server, ownership and permissions must be set correctly.
Check that any deploy step in the corresponding bash script includes these after copying:

```bash
# Correct ownership — nginx and php-fpm run as www-data
chown -R www-data:www-data /opt/grin/<service>/public_html/

# Correct permissions
find /opt/grin/<service>/public_html/ -type d -exec chmod 755 {} \;   # dirs: rwxr-xr-x
find /opt/grin/<service>/public_html/ -type f -exec chmod 644 {} \;   # files: rw-r--r--
```

Flag any deploy function that copies files but is missing the `chown`/`chmod` block.
Also flag:
- PHP files with execute bit set (`chmod 755` on `.php`) — they should be 644.
- Config or secret files world-readable (`chmod 644` on files containing credentials) — should be 640 or 600.
- Directories set to 777 — never acceptable.

## 7. Consistency Across Services

- Favicon usage consistent across all `public_html/` directories.
- Theme switcher pattern (css/themes/ + theme.js) is used in 052 and 07 — check it works the same way in both.
- Error message tone consistent: user-facing errors should not expose internal paths or stack traces.

Report by category with file:line references. Flag critical security issues first.
End with a per-service summary table: which services pass, which need attention, and the top issue per service.
