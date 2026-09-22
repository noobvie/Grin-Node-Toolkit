// Admin-panel front-end regression test — audit §J14.
//
// The admin panel is 21 HTML pages whose logic lives in inline <script> blocks, so nothing in
// the unit suite could reach it. These are STATIC assertions over the shipped source: they pin
// the §J14 fixes that a future edit would silently undo, plus the escaping invariant that
// makes the rest of the panel safe.
//
// Every assertion here is paired with its reason, because each one is a bug that already
// happened: the dashboard rendered 1970 dates and the literal string "undefined", the blocks
// table showed every paid-out block in the grey it uses for dead rows, and five row buttons
// spliced HTML-escaped values into JS string literals inside on* attributes.
//
// Run: node scripts/test-admin-panel.js
const fs = require('fs');
const path = require('path');

const PANEL = path.resolve(__dirname, '../admin-panel');
const read = (f) => fs.readFileSync(path.join(PANEL, f), 'utf8');
const panelFiles = () => fs.readdirSync(PANEL).filter((f) => /\.(html|js)$/.test(f));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// ── §J14-1 — the blocks page must know about the 'paid' terminal state ──────────
console.log('\n[1] §J14-1 — blocks.html and the paid state');
{
  const blocks = read('blocks.html');
  const rewards = fs.readFileSync(path.resolve(__dirname, '../lib/rewards.js'), 'utf8');
  ok("rewards.js still writes status = 'paid' (the premise of this section)",
     /status = 'paid'/.test(rewards));
  ok("blocks.html's STATUS map has a 'paid' row",
     /\bpaid:\s*\[/.test(blocks));
  ok("'paid' is not styled as a dead row",
     /\bpaid:\s*\['badge-ok'/.test(blocks));
  ok('the maturity cell treats paid like confirmed (maturity is behind it)',
     /b\.status === 'confirmed' \|\| b\.status === 'paid' \|\| b\.status === 'orphaned'/.test(blocks));
  ok('a filter chip exists for it — Confirmed alone hides the pool’s own history',
     /data-filter="paid"/.test(blocks));

  const idx = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
  ok('GET /api/admin/blocks computes blocks_to_maturity = 0 for paid too',
     /blocks_to_maturity = \(b\.status === 'confirmed' \|\| b\.status === 'paid' \|\| b\.status === 'orphaned'\)/.test(idx));
}

// ── §J14-2 — the dashboard's Recent Withdrawals table must match the schema ─────
console.log('\n[2] §J14-2 — index.html vs the withdrawals schema');
{
  const home = read('index.html');
  const db = fs.readFileSync(path.resolve(__dirname, '../lib/db.js'), 'utf8');
  const m = db.match(/CREATE TABLE IF NOT EXISTS withdrawals \(([\s\S]*?)\n\s*\)`/);
  const schema = m ? m[1] : '';
  ok('the withdrawals table still has no username/user_id column (the premise)',
     !!schema && !/\busername\b/.test(schema) && !/\buser_id\b/.test(schema));
  ok('the withdrawals table still has slate_id and no tx_slate_id (the premise)',
     !!schema && !/\btx_slate_id\b/.test(schema) && /\bslate_id\b/.test(schema));
  ok('the dashboard no longer reads w.username / w.user_id',
     !/w\.username|w\.user_id/.test(home));
  ok('the dashboard no longer reads w.tx_slate_id',
     !/w\.tx_slate_id/.test(home));
  ok('created_at is scaled to milliseconds (it is INTEGER unixepoch seconds)',
     /new Date\(t \* 1000\)/.test(home) && !/new Date\(iso\)/.test(home));

  // Read the map itself, not the file: the comment above it NAMES the stale statuses it
  // replaced, so a whole-file grep would match the explanation and report the bug as present.
  const badgeMap = (home.match(/const STATUS_BADGE = \{([\s\S]*?)\n\};/) || [])[1] || '';
  const declared = [...badgeMap.matchAll(/^\s*([a-z_]+):/gm)].map((x) => x[1]);
  const statuses = ['tor_checking', 'tor_sending', 'retry_scheduled', 'slatepack_pending',
                    'finalizing', 'confirmed', 'tor_failed', 'slatepack_failed',
                    'nostr_failed', 'slatepack_expired', 'cancelled'];
  const missing = statuses.filter((s) => !declared.includes(s));
  ok('every status the scheduler can write has a badge on the dashboard',
     !!badgeMap && missing.length === 0, missing.join(', '));
  // Control: the stale list this replaced must not creep back, or the assertion above would
  // have passed on a map full of statuses no rail has ever produced.
  const stale = declared.filter((s) => !statuses.includes(s));
  ok('control — no status the scheduler never writes is still in the map',
     stale.length === 0, stale.join(', '));

  // The dashboard and the payouts page must not drift apart again (audit §H4).
  const payStatuses = [...read('payments.html').matchAll(/^ {2}([a-z_]+): +\['badge/gm)]
    .map((x) => x[1]);
  ok('dashboard badge set covers payments.html’s STATUS set',
     payStatuses.length > 0 && payStatuses.every((s) => new RegExp('\\b' + s + ':').test(home)),
     'payments declares ' + payStatuses.length);
}

// ── §J14-3 — no HTML-escaped value inside a JS string literal in an on* handler ──
console.log('\n[3] §J14-3 — the on*="fn(...)" double-decode trap');
{
  // esc()/escHtml() emit &#39; for an apostrophe. The HTML parser decodes that back to a real
  // apostrophe BEFORE the attribute's JS is parsed, so the value breaks out of its string
  // literal. Such values must travel via data-* + this.dataset instead.
  const RE = /on[a-z]+="[^"]*\('\$\{\s*(esc|escHtml|escapeHtmlSafe|escapeAttrSafe)\b/gi;
  const offenders = [];
  for (const f of panelFiles()) {
    for (const hit of read(f).matchAll(RE)) offenders.push(f + ': ' + hit[0].slice(0, 60));
  }
  ok('no on* handler splices an HTML-escaped value into a JS string literal',
     offenders.length === 0, '\n      ' + offenders.join('\n      '));
  // Control: a clean sweep proves nothing unless the pattern is actually detectable.
  const probe = '<button onclick="banMiner(\'${escHtml(m.grin_address)}\')">x</button>';
  ok('control — the sweep detects the pattern it is looking for',
     new RegExp(RE.source, 'i').test(probe));
  ok('the row buttons pass their value via this.dataset instead',
     /onclick="banMiner\(this\.dataset\.addr\)"/.test(read('miners.html')) &&
     /onclick="clearBan\(this\.dataset\.ip\)"/.test(read('users.html')) &&
     /onclick="showPairing\(this\.dataset\.region\)"/.test(read('regions.html')));
}

// ── §J14-6 / §J14-7 — a refused settings save must say why ───────────────────────────────
console.log('\n[4] §J14-6/-7 — settings save surfaces the server’s reason');
{
  const sc = read('settings-common.js');
  ok('saveSection reads the error body instead of throwing a fixed string',
     !/throw new Error\('Save failed'\)/.test(sc) &&
     /if \(!response\.ok\) \{[\s\S]{0,300}?body\.error/.test(sc));
  ok('restoreSection does the same',
     !/throw new Error\('Restore failed'\)/.test(sc));
  ok('the attribute escapers escape & before " (no entity round-trip corruption)',
     (sc.match(/replace\(\/&\/g, '&amp;'\)\.replace\(\/"\/g, '&quot;'\)/g) || []).length >= 2);
}

// ── §J14-8 — every escaper covers the five characters, and 0 is not blank ───────
console.log('\n[5] §J14-8 — escaper shape across the panel');
{
  const weak = [], zeroDrop = [];
  let seen = 0;
  for (const f of panelFiles()) {
    for (const m of read(f).matchAll(/function (esc|escHtml)\s*\(s\)\s*\{\s*return ([\s\S]{0,220}?)\n\s*\}/g)) {
      seen++;
      const body = m[2];
      if (!/&amp;/.test(body) || !/&lt;/.test(body) || !/&gt;/.test(body) ||
          !/&quot;/.test(body) || !/&#39;/.test(body)) weak.push(f + ':' + m[1]);
      if (/String\(s \|\| ''\)/.test(body)) zeroDrop.push(f + ':' + m[1]);
    }
  }
  // A sweep that found no escapers would report "clean" for a panel with none at all.
  ok('the sweep actually found the panel’s escapers', seen >= 10, 'found ' + seen);
  ok('every escHtml/esc escapes all five of & < > " \'', weak.length === 0, weak.join(', '));
  ok('no escaper uses String(s || \'\') — that renders a real 0 as blank',
     zeroDrop.length === 0, zeroDrop.join(', '));
}

// ── §J14-10 — no session token may reach client storage ──────────────────────────
console.log('\n[6] §J14-10 — token handling');
{
  const hits = [];
  for (const f of panelFiles()) {
    for (const m of read(f).matchAll(/(localStorage|sessionStorage|document\.cookie)[^\n]*/g)) {
      if (/token|jwt|secret|password|auth/i.test(m[0])) hits.push(f + ': ' + m[0].trim().slice(0, 70));
    }
  }
  ok('no admin page writes a token/secret to localStorage, sessionStorage or document.cookie',
     hits.length === 0, '\n      ' + hits.join('\n      '));
}


// ── §J14-4 — the admin panel must NOT be served the public page CSP ─────────────
console.log('\n[7] §J14-4 — the admin panel gets its own CSP');
{
  const vhost = fs.readFileSync(
    path.resolve(__dirname, '../../../../scripts/07_grin_mining_public_pool.sh'), 'utf8');

  // /admin/ is static-served, so Express's header middleware never runs for an admin page:
  // whatever the vhost includes IS the admin CSP. It used to include $hdr_page, the public
  // one, which allowlists jsdelivr + four analytics origins the panel never uses.
  ok('pool_setup_nginx writes a dedicated admin header snippet',
     /local hdr_admin="\$snippet_dir\/script07-\$\{POOL_SERVICE\}-admin-headers\.conf"/.test(vhost));
  const adminCsp = (vhost.match(/# Common headers \+ the ADMIN CSP[\s\S]*?\nHDREOF/) || [''])[0];
  ok('the admin snippet exists and re-includes the common headers (X-Frame-Options etc.)',
     /include \$hdr_common;/.test(adminCsp));
  ok("the admin CSP is connect-src 'self' — no silent exfiltration destination",
     /connect-src 'self';/.test(adminCsp));
  ok('the admin CSP allowlists no third-party origin at all',
     !!adminCsp && !/https:\/\//.test(adminCsp));
  ok('it still permits inline script (the panel IS inline blocks) and data: images (2FA QR)',
     /script-src 'self' 'unsafe-inline';/.test(adminCsp) && /img-src 'self' data:;/.test(adminCsp));
  ok('it carries the four navigation/embedding directives',
     /frame-ancestors 'none'/.test(adminCsp) && /base-uri 'self'/.test(adminCsp) &&
     /form-action 'self'/.test(adminCsp) && /object-src 'none'/.test(adminCsp));

  // §J16-11: the public page CSP now carries the same four. It did not when §J14-4 was
  // written — both §J14 and §J15 left the decision to §J16, which took it. The public
  // origin serves account-settings.html (the withdrawal form and the rig-password box)
  // and §B accepts that operator HTML reaches these pages, so base-uri/form-action are
  // load-bearing there, not cosmetic. Asserted separately from the admin snippet: they
  // are two files with different reasons to change.
  const pageCsp = (vhost.match(/# Common headers \+ the page CSP[\s\S]*?\nHDREOF/) || [''])[0];
  ok('the page CSP also carries the four (audit §J16-11)',
     /frame-ancestors 'none'/.test(pageCsp) && /base-uri 'self'/.test(pageCsp) &&
     /form-action 'self'/.test(pageCsp) && /object-src 'none'/.test(pageCsp));
  // Control: the page CSP must still allow the analytics + Google Fonts origins, or the
  // tightening quietly broke every operator who switched a provider on.
  ok('control — the page CSP still allowlists the analytics + font origins',
     /https:\/\/www\.googletagmanager\.com/.test(pageCsp) &&
     /https:\/\/fonts\.gstatic\.com/.test(pageCsp));

  // The location block must point at it. Read only the /admin/ block, so the public
  // location's legitimate `include $hdr_page` can't satisfy or break this.
  const adminLoc = (vhost.match(/location \/admin\/ \{[\s\S]*?\n    \}/) || [''])[0];
  ok('location /admin/ includes $hdr_admin, not $hdr_page',
     /include \$hdr_admin;/.test(adminLoc) && !/include \$hdr_page;/.test(adminLoc));
  // Control: the public block must still get the page CSP — a global swap would break
  // analytics and Google Fonts on every public page.
  // Require the newline after the brace: the pre-certbot bootstrap vhost higher up the
  // file has a ONE-LINE `location / { try_files ...; }` that would match first and make
  // this control pass vacuously.
  const rootLoc = (vhost.match(/\n    location \/ \{\n[\s\S]*?\n    \}/) || [''])[0];
  ok('control — location / still includes $hdr_page',
     /include \$hdr_page;/.test(rootLoc) && !/include \$hdr_admin;/.test(rootLoc));
  ok('cleanup removes the new snippet too (snippets/ is swept by nothing else)',
     /"\$hdr_common" "\$hdr_page" "\$hdr_admin"/.test(vhost));

  // The panel loads nothing third-party — the premise the tight CSP rests on. If someone
  // adds a CDN <script>/<link> to a page, this fails and the CSP must be revisited.
  const external = [];
  for (const f of panelFiles().filter((x) => /\.html$/.test(x))) {
    for (const m of read(f).matchAll(/<(?:script|link)[^>]*\b(?:src|href)="(?:https?:)?\/\/[^"]*"/gi)) {
      external.push(f + ': ' + m[0].slice(0, 70));
    }
  }
  ok('no admin page loads an off-origin script or stylesheet',
     external.length === 0, '\n      ' + external.join('\n      '));
}

// ── §J14-9 — anonymous-writable counters must not read as measurement ───────────
console.log('\n[8] §J14-9 — ad counters are labelled unverified');
{
  const ads = read('ads.html');
  const adsLib = fs.readFileSync(path.resolve(__dirname, '../lib/ads.js'), 'utf8');
  ok('the Views/Clicks column header carries the unverified qualifier',
     /<th>Views \/ Clicks <span class="th-qual"/.test(ads));
  ok('the note above the table says the counters are client-reported and not billable',
     /unverified client-reported counters/.test(ads) && /never as a billable measurement/.test(ads));
  ok('the CTR is rendered as approximate, not as a measured percentage',
     /\(~\$\{\(c \/ v \* 100\)\.toFixed\(1\)\}%\)/.test(ads));
  // The endpoint stays open by design (no per-visitor rows), so the cheap half of J10-3 is
  // all the server can enforce: an ad the public site is not serving cannot accrue events.
  ok('recordEvents only counts ads that are actually being served',
     /UPDATE ads SET \$\{col\}[\s\S]{0,300}?AND is_active = 1[\s\S]{0,200}?start_at <= \?[\s\S]{0,160}?end_at   >= \?/.test(adsLib));
  // Control: that predicate is only meaningful if it matches the one the renderer uses.
  ok('control — publicByPlacement still uses the same serving predicate',
     /is_active = 1\s*\n\s*AND \(start_at IS NULL OR start_at <= \?\)\s*\n\s*AND \(end_at IS NULL OR end_at >= \?\)/.test(adsLib));
}
// ── design §16.8 — admin → Donors page (donor-name moderation + the moved donation settings) ──
console.log('\n[9] §16.8 — donors.html');
{
  const exists = fs.existsSync(path.join(PANEL, 'donors.html'));
  ok('donors.html exists', exists);
  const donors = exists ? read('donors.html') : '';
  const shell = read('admin-shell.js');

  // NAV: a Dashboard child directly after Miners — read the NAV block itself, not the file.
  const navBlock = (shell.match(/var NAV = \[([\s\S]*?)\n  \];/) || [])[1] || '';
  const files = [...navBlock.matchAll(/file: '([a-z0-9-]+\.html)'/g)].map((m) => m[1]);
  ok('NAV lists donors.html directly after miners.html',
     files.indexOf('donors.html') === files.indexOf('miners.html') + 1 && files.indexOf('miners.html') > 0,
     files.join(','));
  ok('the nav badge is a plain count, painted only for a positive number',
     /decorateDonorBadge/.test(shell) && /typeof d\.new_names_7d === 'number'/.test(shell) && /if \(!\(n > 0\)\) return;/.test(shell));

  // Settings ids: every id inside the settings form is either an incentives key or opted
  // out with settings-skip — one stray id fails the whole save (memory
  // project_pool_admin_settings_form). Checked against the LIVE defaults, not a hand list.
  const PoolSettings = require(path.resolve(__dirname, '../lib/pool-settings.js'));
  const keys = new Set(Object.keys(PoolSettings.defaults.incentives));
  const form = (donors.match(/<div id="donation-settings">([\s\S]*?)<\/section>/) || [])[1] || '';
  ok('the settings form exists on the page', form.length > 0);
  const inputs = [...form.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)];
  const stray = [], present = new Set();
  for (const m of inputs) {
    const attrs = m[2];
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    if (!id) continue;
    if (/\bclass="[^"]*\bsettings-skip\b/.test(attrs)) continue;
    if (keys.has(id)) present.add(id); else stray.push(id);
  }
  ok('no input id in the form that is not an incentives key (or settings-skip)', stray.length === 0, stray.join(','));
  for (const k of ['allow_miner_donations', 'donation_address', 'donor_name_blocklist', 'donor_censored_display',
                   'donor_rank_window_days', 'donor_loyalty_percent_per_month', 'donor_loyalty_cap', 'donor_name_expiry_months']) {
    ok(`form carries ${k}`, present.has(k));
  }
  ok('donation_address may be saved EMPTY (settings-allow-empty) — "leave blank" must be able to persist',
     /id="donation_address"[^>]*class="[^"]*settings-allow-empty/.test(form));
  ok('the censored-display select offers exactly the closed enum',
     [...(form.match(/<select id="donor_censored_display"[\s\S]*?<\/select>/) || [''])[0].matchAll(/value="([a-z]+)"/g)]
       .map((m) => m[1]).join(',') === 'masked,marker');

  // The two moved keys must exist on exactly one page: here, not on settings-incentives.html.
  const inc = read('settings-incentives.html').replace(/<!--[\s\S]*?-->/g, '');   // the comment names them on purpose
  ok('settings-incentives.html no longer carries allow_miner_donations', !/id="allow_miner_donations"/.test(inc));
  ok('settings-incentives.html no longer carries donation_address', !/id="donation_address"/.test(inc));
  ok('settings-incentives.html points at Donors instead', /href="donors\.html"/.test(inc));
  const dupes = panelFiles().filter((f) => f !== 'donors.html' && /id="(allow_miner_donations|donation_address)"/.test(read(f)));
  ok('no other admin page binds the moved keys', dupes.length === 0, dupes.join(','));

  // flash() must be able to reveal: the message element hides INLINE, never via a class that
  // carries display:none (2026-09-19 — every admin flash was invisible for that reason).
  ok('the flash targets hide inline, not by class',
     /id="donor-msg" style="display:none/.test(donors) && /id="settings-msg" style="display:none/.test(donors));
  const poolCss = fs.readFileSync(path.resolve(__dirname, '../../public_html/css/pool.css'), 'utf8');
  const msgRules = (poolCss.match(/\.error-msg \{[^}]*\}/) || [''])[0] + (poolCss.match(/\.success-msg \{[^}]*\}/) || [''])[0];
  ok('.error-msg/.success-msg carry no display:none', msgRules.length > 0 && !/display:\s*none/.test(msgRules));

  // Row actions pass the address via this.dataset (audit §J14), and use the panel helper for
  // step-up-gated writes (adminFetch handles the freshAdmin challenge; a bare Auth.fetch
  // would show "re-authentication required" with no way to complete it).
  ok('censor/un-censor buttons pass the address via this.dataset',
     /onclick="censorDonor\(this\.dataset\.addr\)"/.test(donors) && /onclick="uncensorDonor\(this\.dataset\.addr\)"/.test(donors));
  ok('the moderation POSTs and the settings save go through adminFetch (step-up aware)',
     /adminFetch\('\/api\/admin\/donors\/' \+ encodeURIComponent\(addr\)/.test(donors) &&
     /adminFetch\('\/api\/admin\/settings\/incentives'/.test(donors));
  ok('the page never uses Auth.read (public pages\' helper) or a bare fetch()',
     !/Auth\.read\(/.test(donors) && !/[^a-zA-Z.]fetch\(/.test(donors.replace(/adminFetch\(/g, 'X(')));
  ok('a failed load renders as an error, not as an empty donor list',
     /data\.success !== true[\s\S]{0,120}setError/.test(donors));
  ok('the ink on the accent pill is the theme token, not a literal',
     /\.admin-subnav a \.nav-count \{[^}]*color: var\(--btn-text\)/.test(read('styles.css')));
  ok('every donor name / word / worker name is escaped before it reaches the row',
     /escHtml\(d\.donor_name\)/.test(donors) && /escHtml\(d\.donor_censor_word/.test(donors) && /escHtml\(w\.name\)/.test(donors));
  ok('the rescan counts from the save response are shown', /body\.rescan/.test(donors) && /Rescanned \$\{r\.scanned\}/.test(donors));
  ok('UTC is stated once on the page', (donors.match(/UTC/g) || []).length >= 1);
  const home = read('index.html');
  ok('the Overview shows the 7-day new-names tile from the dashboard field and links to Donors',
     /id="kpi-donor-names"/.test(home) && /d\.new_donor_names_7d \?\? '—'/.test(home) && /href="donors\.html"/.test(home));
}

console.log('\n' + (fail ? 'FAILURES' : 'ALL PASS') + ` — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
