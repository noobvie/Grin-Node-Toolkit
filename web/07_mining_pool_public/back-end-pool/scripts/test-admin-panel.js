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
     /script-src 'self' 'unsafe-inline';/.test(adminCsp) && /img-src 'self' data:/.test(adminCsp));
  // design §18.11 Part 3 #1: the Donors queue loads banners from a plain same-origin src, so
  // img-src stays exactly 'self' data: — no blob:, which would let a preview escape the image
  // route's sandbox headers.
  ok("img-src is exactly 'self' data: — no blob:, no other widening",
     /img-src 'self' data:;/.test(adminCsp) && !/blob:/.test(adminCsp));
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
// ── design §18.6 — admin → Donors page (review queue + donors list + donation settings) ──
console.log('\n[9] §18.6 — donors.html');
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
  ok('the nav badge is the PENDING count, painted only for a positive number',
     /decorateDonorBadge/.test(shell) && /typeof d\.pending_requests === 'number'/.test(shell) &&
     /if \(!\(n > 0\)\) return;/.test(shell) && !/new_names_7d/.test(shell));

  // Page order (§18 Part 3): the review queue first, then the donors list, then the settings.
  const qAt = donors.indexOf('id="queue-tbody"'), dAt = donors.indexOf('id="donors-tbody"'), sAt = donors.indexOf('id="donation-settings"');
  ok('page order: review queue → donors list → settings', qAt > 0 && qAt < dAt && dAt < sAt);

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
  for (const k of ['allow_miner_donations', 'donation_address', 'donor_name_blocklist', 'donor_banner_slots',
                   'donor_rank_window_days', 'donor_loyalty_percent_per_month', 'donor_loyalty_cap', 'donor_name_expiry_months']) {
    ok(`form carries ${k}`, present.has(k));
  }
  ok('the removed donor_censored_display is on no admin page', !panelFiles().some((f) => /donor_censored_display/.test(read(f))));
  ok('the word list is relabelled as FLAG words for the review queue',
     /<label for="donor_name_blocklist">Flag words — highlighted in the review queue<\/label>/.test(form));
  ok('banner slots carries the validator bounds (0–10)', /id="donor_banner_slots"[^>]*min="0" max="10"/.test(form));
  ok('donation_address may be saved EMPTY (settings-allow-empty) — "leave blank" must be able to persist',
     /id="donation_address"[^>]*class="[^"]*settings-allow-empty/.test(form));
  // Inputs OUTSIDE the settings form (the queue's reason boxes, the dialog, the two filters)
  // are never harvested, but carry settings-skip anyway so a later move into the form is safe.
  const outside = donors.replace(form, '');
  const outsideIds = [...outside.matchAll(/<(input|select)\b([^>]*)>/gi)].map((m) => m[2]).filter((a) => /\bid="/.test(a));
  ok('every input/select outside the settings form is settings-skip',
     outsideIds.length >= 3 && outsideIds.every((a) => /\bsettings-skip\b/.test(a)), outsideIds.join(' | '));

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
     /id="queue-msg" style="display:none/.test(donors) && /id="donor-msg" style="display:none/.test(donors) &&
     /id="settings-msg" style="display:none/.test(donors));
  const poolCss = fs.readFileSync(path.resolve(__dirname, '../../public_html/css/pool.css'), 'utf8');
  const msgRules = (poolCss.match(/\.error-msg \{[^}]*\}/) || [''])[0] + (poolCss.match(/\.success-msg \{[^}]*\}/) || [''])[0];
  ok('.error-msg/.success-msg carry no display:none', msgRules.length > 0 && !/display:\s*none/.test(msgRules));

  // Row actions pass their value via this.dataset (audit §J14), and every write uses the panel
  // helper for step-up-gated writes (adminFetch handles the freshAdmin challenge; a bare
  // Auth.fetch would show "re-authentication required" with no way to complete it).
  ok('queue decisions pass the request id via this.dataset',
     /onclick="approveRequest\(this\.dataset\.id\)"/.test(donors) && /onclick="rejectRequest\(this\.dataset\.id\)"/.test(donors));
  ok('remove / block / unblock pass the address (and kind) via this.dataset',
     /onclick="removeLive\(this\.dataset\.addr, this\.dataset\.kind\)"/.test(donors) &&
     /onclick="blockDonor\(this\.dataset\.addr\)"/.test(donors) && /onclick="unblockDonor\(this\.dataset\.addr\)"/.test(donors));
  ok('every decision POST and the settings save go through adminFetch (step-up aware)',
     /async function postAction[\s\S]{0,120}adminFetch\(url,/.test(donors) &&
     /postAction\('\/api\/admin\/donors\/requests\/' \+ encodeURIComponent\(id\) \+ '\/approve'/.test(donors) &&
     /postAction\('\/api\/admin\/donors\/requests\/' \+ encodeURIComponent\(id\) \+ '\/reject'/.test(donors) &&
     /postAction\('\/api\/admin\/donors\/' \+ encodeURIComponent\(addr\) \+ '\/remove'/.test(donors) &&
     /postAction\('\/api\/admin\/donors\/' \+ encodeURIComponent\(addr\) \+ '\/block'/.test(donors) &&
     /postAction\('\/api\/admin\/donors\/' \+ encodeURIComponent\(addr\) \+ '\/unblock'/.test(donors) &&
     /adminFetch\('\/api\/admin\/settings\/incentives'/.test(donors));
  ok('a refusal shows the SERVER\'s reason (§J14), not a generic word',
     /throw new Error\(data\.error \|\| \('HTTP ' \+ res\.status\)\)/.test(donors));
  ok('the page never uses Auth.read (public pages\' helper) or a bare fetch()',
     !/Auth\.read\(/.test(donors) && !/[^a-zA-Z.]fetch\(/.test(donors.replace(/adminFetch\(/g, 'X(')));
  ok('a failed load renders as an error, not as an empty list — both lists',
     /data\.success !== true[\s\S]{0,160}queueTable\.setError/.test(donors) && /data\.success !== true[\s\S]{0,160}donorsTable\.setError/.test(donors));
  ok('the reason prompts are an IN-PAGE dialog, never window.prompt()',
     /id="reason-dialog"[^>]*class="modal-overlay"|class="modal-overlay" id="reason-dialog"/.test(donors) &&
     !/\bprompt\(/.test(donors.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')));
  ok('the ink on the accent pill is the theme token, not a literal',
     /\.admin-subnav a \.nav-count \{[^}]*color: var\(--btn-text\)/.test(read('styles.css')));

  // §18.9 — the reject/remove reason is PUBLIC (the donor's account page is address-addressable);
  // the UI must say so beside every field that collects one. A block note is admin-only.
  ok('the queue\'s reason field says it is shown to the donor on their account page',
     /The reason is shown to the donor on their account page, which anyone holding the address can open\./.test(donors));
  ok('the remove dialog says the reason is shown on the donor\'s public account page',
     /label: 'Reason \(optional\) — shown to the donor on their public account page'/.test(donors));
  ok('the block dialog says its note is admin-side only',
     /label: 'Note \(optional\) — kept for the admin side only, never shown to the donor'/.test(donors));

  // Images (design §18.11 Part 3 #1): the queue points a plain same-origin src at the admin image
  // route, so the route's headers (stored mime, nosniff, sandbox CSP) govern every way the image
  // is viewed. No object URL: a blob copy would drop those headers and need blob: in img-src.
  // Approved thumbnails in the list are the PUBLIC /uploads/donors/ file, shape-checked.
  ok('queue images: a same-origin src on the admin image route, the id URL-encoded',
     /src="\/api\/admin\/donors\/requests\/\$\{encodeURIComponent\(String\(r\.id\)\)\}\/image"/.test(donors));
  ok('no object URL / blob anywhere on the page',
     !/createObjectURL|revokeObjectURL|\.blob\(\)|blob:/.test(donors.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')));
  ok('a preview that fails to load becomes text, wired after each render (onRender)',
     /onRender:\s*tbody\s*=>[\s\S]{0,700}addEventListener\('error', \(\) => imageFailed\(img\), \{ once: true \}\)/.test(donors) &&
     /function imageFailed\(img\)[\s\S]{0,300}preview unavailable/.test(donors));
  ok('the queue banner carries width/height from the stored dims (no layout jump)',
     /class="req-banner" data-req-img=[\s\S]{0,320}width="\$\{w\}" height="\$\{h\}"/.test(donors));
  ok('list thumbnails accept only the /uploads/donors/<16 hex>.(png|jpg|gif) shape',
     /\^\\\/uploads\\\/donors\\\/\[0-9a-f\]\{16\}\\\.\(png\|jpg\|gif\)\$/.test(donors) && /bannerUrl\(d\.banner\.url\)|d\.banner && bannerUrl\(d\.banner\.url\)/.test(donors));
  ok('the queue does NOT poll on a timer (a repaint would wipe a reason being typed)',
     !/setInterval\(loadQueue/.test(donors) && /setInterval\(loadDonors, 60000\)/.test(donors));
  ok('a typed reason survives a re-render (written through to a map the row reads back)',
     /_reasons\.set\(inp\.dataset\.reasonFor, inp\.value\)/.test(donors) && /_reasons\.get\(String\(r\.id\)\)/.test(donors));

  // Escaping — AdminTable inserts row() output raw, so every server string passes escHtml.
  ok('every requested name, flag word, reason, current name and worker name is escaped',
     /escHtml\(r\.name\)/.test(donors) && /escHtml\(f\.word\)/.test(donors) && /escHtml\(r\.reason\)/.test(donors) &&
     /escHtml\(r\.current\.name\)/.test(donors) && /escHtml\(w\.name\)/.test(donors) && /escHtml\(d\.name\.text\)/.test(donors));
  ok('no v1 moderation left on the page (censor / uncensor / rescan / marker)',
     !/censorDonor|uncensorDonor|\/censor'|\/uncensor'|body\.rescan|Rescanned|censored-donor|donor_censor/.test(donors));
  ok('UTC is stated on the page', (donors.match(/UTC/g) || []).length >= 1);
  const home = read('index.html');
  ok('the Overview shows the pending-requests tile from the dashboard field and links to Donors',
     /id="kpi-donor-requests"/.test(home) && /d\.pending_donor_requests \?\? '—'/.test(home) && /href="donors\.html"/.test(home) &&
     !/new_donor_names_7d|kpi-donor-names/.test(home));

  // AdminTable's onRender hook (added for this page): runs only after real rows are painted,
  // and a throw inside it cannot blank the table.
  ok('AdminTable.onRender runs after rows are painted and is try/caught',
     /tbody\.innerHTML = slice\.map[\s\S]{0,120}if \(typeof opts\.onRender === 'function'\) \{\s*try \{ opts\.onRender\(tbody\); \} catch/.test(shell));
}

console.log('\n' + (fail ? 'FAILURES' : 'ALL PASS') + ` — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
