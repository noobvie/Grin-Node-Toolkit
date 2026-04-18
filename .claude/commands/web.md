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

## 7. Theme Color Contrast

All themes use a shared set of CSS variables. For each theme file in `css/themes/`,
extract the variable values and check the following pairs against WCAG AA contrast ratios:

| Pair | Used for | Min ratio |
|---|---|---|
| `--text` on `--bg-body` | Body text | 4.5 : 1 |
| `--text` on `--bg-card` | Card text | 4.5 : 1 |
| `--text` on `--bg-card2` | Secondary card text | 4.5 : 1 |
| `--text-dim` on `--bg-body` | Dimmed/muted text | 4.5 : 1 |
| `--text-dim` on `--bg-card` | Dimmed text on cards | 4.5 : 1 |
| `--accent` on `--bg-body` | Highlighted values, links | 3 : 1 |
| `--accent` on `--bg-card` | Accent text on cards | 3 : 1 |
| `--btn-text` on `--btn-bg` | Button labels | 4.5 : 1 |
| `--error-color` on `--bg-card` | Error messages | 4.5 : 1 |
| `--ok-color` on `--bg-card` | Success messages | 4.5 : 1 |
| `a` color on its background | Links | 4.5 : 1 |

**How to calculate:** use the WCAG relative luminance formula.
For a hex color `#RRGGBB`, convert each channel: `c = c/255`, then
`c_lin = c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4`.
Luminance `L = 0.2126*R + 0.7152*G + 0.0722*B`.
Contrast ratio = `(L_lighter + 0.05) / (L_darker + 0.05)`.

Flag any pair that falls below the minimum. For each failure, suggest the
minimum adjustment needed (e.g. lighten/darken by how much) rather than
proposing a full color redesign — preserve the theme's visual identity.
Only report failures, not passing pairs.

## 8. Consistency Across Services

- Favicon usage consistent across all `public_html/` directories.
- Theme switcher pattern (css/themes/ + theme.js) is used in 052 and 07 — check it works the same way in both.
- Error message tone consistent: user-facing errors should not expose internal paths or stack traces.

## 9. Mobile & Responsive (Phone Display)

Target: **390–430px CSS width** (iPhone 15/16 Pro, standard Android flagship portrait).
These are general rules — apply them to every page regardless of theme or framework.

### 9a. Header & Navigation
- **Fixed header height vs body padding-top must match.** Measure the header's worst-case
  height at 390px (count rows if content wraps) and confirm `body { padding-top }` ≥ that
  height. A mismatch hides the top of the page content behind the fixed bar.
- **`scroll-margin-top` on anchored sections must equal the fixed header height**, not a
  hardcoded guess. Flag any hardcoded value that isn't updated when the header shrinks on mobile.
- **Nav pills / link bars inside a fixed header must not wrap to a second row.**
  Options: hide them on ≤480px (scrolling is fine for short pages), collapse to a hamburger,
  or use `overflow-x: auto; flex-wrap: nowrap` for a scrollable strip. Wrapping is not acceptable.
- **Touch targets must be ≥ 44×44 px** (Apple HIG / WCAG 2.5.5). Check buttons, nav pills,
  theme-picker button, tab buttons, and any `<a>` used as a button. Flag anything with
  `padding` that results in a hit area below 44px.
- Theme-picker dropdown must not overflow the right edge of the screen on mobile.
  Confirm `right: 0` or similar anchoring.

### 9b. Layout & Overflow
- **No horizontal scroll on the page body.** Any `min-width` value on flex/grid children
  that exceeds the container width will cause this. Check `min-width` values on stat items,
  cards, and input fields — at 390px the container inner width is roughly 358px.
- **Flex rows that wrap must be intentional.** Unintended wrapping on stat bars, tab rows,
  and amount-button grids can make pages look broken. Verify each flex row either:
  - fits in one row at 390px, or
  - wraps into a clean 2-column grid (not 3+1 or other orphan layouts), or
  - uses `overflow-x: auto; flex-wrap: nowrap` for horizontal scroll.
- **Tabs (donate/claim/how-it-works) must not wrap.** Long tab labels cause 2-row tab bars
  that break the visual connection between the active tab and its content panel. Use
  `overflow-x: auto; flex-wrap: nowrap; -webkit-overflow-scrolling: touch` on the tab
  container, and `white-space: nowrap; flex-shrink: 0` on each tab button.
- **`position: fixed` and `position: sticky` elements must not clip content.** Check that
  all sections below a fixed header have sufficient top offset.
- Code/monospace boxes (`slatepack-box`, `cmd-box`, pre/code) must have
  `word-break: break-all` or `overflow-x: auto` — long strings like slatepack messages
  will overflow on narrow screens without this.

### 9c. Text & Readability
- **Minimum font size 14px for body text** on mobile. `0.75rem` base = 12px — too small.
  Theme overrides that reduce `font-size` below 13px on mobile should be flagged.
- **Line length should be ≤ 75ch** — constrained by the container max-width and page padding.
  On mobile the container padding (e.g. `padding: 0 1rem`) effectively limits this. Confirm
  `1rem` padding is applied on both sides so text does not run edge-to-edge.
- Labels above form inputs must remain visible and not overlap the input on mobile.
  Check `label` elements are block-level with adequate bottom margin.

### 9d. Forms & Inputs
- `input[type="text"]`, `input[type="number"]`, `textarea` must have `font-size ≥ 16px`
  (or `font-size: 1rem` with base 16px) on iOS — anything smaller triggers auto-zoom on focus,
  which breaks the page layout. Flag inputs with `font-size: .9rem` or smaller.
- `input[type="number"]` with `max-width: 200px` is safe on mobile (fits within 358px).
- Textarea `resize: vertical` — confirm `resize: horizontal` and `resize: both` are not set,
  as horizontal resize can break the layout on mobile.

### 9e. Theme-Specific Mobile Checks
- **Win98 theme:** Raised bevel tab chrome (`border-bottom` active-tab trick) breaks
  when tabs are in a horizontal scroll container. Confirm a `@media` override re-applies
  the tab bar border and background for the scroll case.
- **Win98 theme:** `box-shadow: 2px 2px 0 #000` on cards adds 2px overflow right/bottom —
  confirm the container has enough padding-right to absorb this without triggering body scroll.
- **Cute theme:** `backdrop-filter: blur()` must include `-webkit-backdrop-filter` for Safari.
  Header background must remain opaque enough (≥ 85% alpha) to keep title readable over
  content that scrolls beneath it.
- **Matrix theme:** The canvas rain animation must not cause horizontal overflow or affect
  touch scrolling. Confirm `canvas` has `position: fixed` and `pointer-events: none`.
- **All dark themes:** Check that the fixed header's background color exactly matches or
  is slightly darker than `--bg-body` — a transparent or wrong-color header will show a
  visible seam as the page scrolls underneath it.

### 9f. General Phone Display Checklist (run for every page)
1. `<meta name="viewport" content="width=device-width, initial-scale=1.0">` present — prevents
   the browser from scaling down the page to fit, which makes text tiny.
2. No element wider than the viewport (check with `* { max-width: 100% }` mental model).
3. Buttons and links spaced at least 8px apart — adjacent touch targets cause mis-taps.
4. Page scrolls vertically without horizontal scroll at 390px.
5. Above-the-fold content (first screenful) is useful — stat bars and hero content should
   be visible without scrolling; a 3-row header eating 30% of the screen is not acceptable.
6. Images and SVGs have `max-width: 100%` or explicit responsive sizing.
7. No `position: fixed` element with `width: auto` — always set `left: 0; right: 0` or an
   explicit width, otherwise it sizes to content and may not span the viewport.

Report by category with file:line references. Flag critical security issues first.
End with a per-service summary table: which services pass, which need attention, and the top issue per service.
