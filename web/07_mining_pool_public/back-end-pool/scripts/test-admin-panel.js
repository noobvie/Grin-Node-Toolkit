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
  // tor_held (2026-09-26): a Tor payout whose one attempt has an unknown outcome. retry_scheduled
  // stays while a legacy row can still exist (the scheduler migrates them at its first pass).
  const statuses = ['tor_checking', 'tor_sending', 'tor_held', 'retry_scheduled', 'slatepack_pending',
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

  // The dashboard and the payouts page must not drift apart again (audit §H4). Read from the
  // STATUS block only — payments.html also has a CHAIN badge map (on-chain state of a paid row,
  // not a withdrawal status), which the dashboard has no reason to know.
  const payStatusBlock = (read('payments.html').match(/const STATUS = \{([\s\S]*?)\n\};/) || [])[1] || '';
  const payStatuses = [...payStatusBlock.matchAll(/^ {2}([a-z_]+): +\['badge/gm)]
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
  // Design §19.17 D22: the ad TYPE is part of the serving predicate now (a legacy `code` row is
  // never served), so it must be in BOTH statements, through the one shared constant.
  ok("D22: SERVABLE admits banner + text only", /const SERVABLE = "ad_type IN \('banner', 'text'\)";/.test(adsLib));
  ok('D22: publicByPlacement AND recordEvents both splice in SERVABLE',
     (adsLib.match(/AND \$\{SERVABLE\}/g) || []).length === 2);
  ok('D22: the public SELECT no longer reads html_code',
     !/SELECT id, placement, ad_type[^`]*html_code/.test(adsLib));
}

// ── design §19.17 D22 — the code-ad type is gone from the admin page ───────────
console.log('\n[8b] D22 — ads.html offers no code ad; a legacy one is delete-only');
{
  const ads = read('ads.html');
  ok('the Type select has no "code" option', !/<option value="code">/.test(ads));
  ok('no snippet textarea and no html_code in the submit body',
     !/id="ad-code"/.test(ads) && !/html_code/.test(ads));
  ok('the Type field says why code ads went', /Code-snippet ads were removed for security — design §19\.17 D22/.test(ads));
  ok('a removed row shows "Unsupported (removed)"', /if \(a\.removed\) return \['Unsupported \(removed\)'/.test(ads));
  ok('a removed row renders only Delete (edit/duplicate/toggle are skipped)',
     /\$\{a\.removed \? '' : `<button class="btn-icon" onclick="editAd/.test(ads) &&
     /if \(!a \|\| a\.removed\) return;[\s\S]*if \(!a \|\| a\.removed\) return;/.test(ads));

  const an = read('settings-analytics.html');
  ok('settings-analytics.html has no custom HTML fields',
     !/id="custom_head_html"/.test(an) && !/id="custom_body_html"/.test(an));
  ok('settings-analytics.html says why, in one line',
     /Custom HTML was removed for security — design §19\.17 D22\./.test(an));
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
  for (const k of ['allow_miner_donations', 'donation_address', 'donor_banner_slots',
                   'donor_rank_window_days', 'donor_loyalty_percent_per_month', 'donor_loyalty_cap', 'donor_name_expiry_months']) {
    ok(`form carries ${k}`, present.has(k));
  }
  ok('the removed donor_censored_display is on no admin page', !panelFiles().some((f) => /donor_censored_display/.test(read(f))));
  ok('C4: the retired flag-word list is on no admin page (its words moved to Settings → Names)',
     !panelFiles().some((f) => /id="donor_name_blocklist"/.test(read(f))));
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
  ok('every requested name, reason, current name, worker name and donor-name field is escaped',
     /escHtml\(r\.name\)/.test(donors) && /escHtml\(r\.reason\)/.test(donors) &&
     /escHtml\(r\.current\.name\)/.test(donors) && /escHtml\(w\.name\)/.test(donors) && /escHtml\(d\.name\.text\)/.test(donors) &&
     /escHtml\(n\.name\)/.test(donors) && /escHtml\(n\.reason\)/.test(donors) && /escHtml\(n\.norm\)/.test(donors) && /escHtml\(what\)/.test(donors));
  // Part C4 (§19.17.6): names are auto-checked — the queue holds banners, names are a list.
  ok('C4: the queue asks for BANNERS only and has no Flags column',
     /\/api\/admin\/donors\/requests\?kind=banner&status=/.test(donors) && !/flagBadges|r\.flags/.test(donors) && !/<th>Flags<\/th>/.test(donors));
  const namesAt = donors.indexOf('id="names-tbody"');
  ok('C4: the Donor names section sits between the queue and the donors list',
     namesAt > donors.indexOf('id="queue-tbody"') && namesAt < donors.indexOf('id="donors-tbody"'));
  ok('C4: live / removed / banned views read the three admin routes',
     /'\/api\/admin\/donors\/banned-names'/.test(donors) && /'\/api\/admin\/donors\/names\?state=' \+ encodeURIComponent\(_namesView\)/.test(donors));
  ok('C4: ban / unban go through postAction (adminFetch, step-up aware) and pass values via this.dataset',
     /postAction\('\/api\/admin\/donors\/banned-names', \{ name, reason \}/.test(donors) &&
     /postAction\('\/api\/admin\/donors\/banned-names\/' \+ encodeURIComponent\(norm\) \+ '\/unban'/.test(donors) &&
     /onclick="banName\(this\.dataset\.name\)"/.test(donors) && /onclick="unbanName\(this\.dataset\.norm\)"/.test(donors));
  ok('C4: the page points the operator at Settings → Names for the words', /href="settings-names\.html"/.test(donors));
  ok('C4: the names table headers change by textContent, never innerHTML',
     /document\.getElementById\('names-h' \+ \(i \+ 1\)\)\.textContent = t/.test(donors));
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

// ── F4 — the dead auto-payout settings are gone, and the Payout form ↔ defaults stay in parity ──
// `payout.auto_payout` + `payout.payout_frequency` had a UI and were read by nothing: payouts are
// MINER-INITIATED by design (impl doc D10). They were removed the way D4's key was — input and
// default in ONE change, because the harvester sends every id in `.settings-form` and
// updateSection throws on an unknown key (memory project_pool_admin_settings_form).
console.log('\n[10] F4 — settings-payout.html vs PoolSettings.defaults.payout');
{
  const PoolSettings = require(path.resolve(__dirname, '../lib/pool-settings.js'));
  const keys = Object.keys(PoolSettings.defaults.payout);
  const page = read('settings-payout.html');
  const form = (page.match(/<div id="payout" class="settings-content[^"]*">([\s\S]*?)<script/) || [])[1] || '';
  ok('the payout settings form exists on the page', /class="settings-form"/.test(form));
  const harvested = [];
  for (const m of form.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const id = (m[2].match(/\bid="([^"]+)"/) || [])[1];
    if (id && !/\bclass="[^"]*\bsettings-skip\b/.test(m[2])) harvested.push(id);
  }
  const stray = harvested.filter((id) => !keys.includes(id));
  ok('every harvested id on the Payout form is a payout key (one stray fails every save)', stray.length === 0, stray.join(','));
  // The only defaults with no field, each for a stated reason — a key added to either side
  // without the other lands here instead of shipping a dead field or an unsaveable form.
  //   dormancy_policy_effective_at — written by lib/dormancy.js, never by the operator
  // (withdrawal_retry_delays, the other one, was removed 2026-09-26 with the Tor retry ladder.)
  const noField = keys.filter((k) => !harvested.includes(k)).sort();
  ok('the only payout default without a field is the one known non-form key',
     JSON.stringify(noField) === JSON.stringify(['dormancy_policy_effective_at']), noField.join(','));

  for (const k of ['auto_payout', 'payout_frequency']) {
    ok(`${k} is no longer a payout default`, !Object.prototype.hasOwnProperty.call(PoolSettings.defaults.payout, k));
    ok(`${k} has no validator`, !Object.prototype.hasOwnProperty.call(PoolSettings.validators.payout, k));
    const binders = panelFiles().filter((f) => new RegExp(`id="${k}"`).test(read(f)));
    ok(`no admin page binds id="${k}"`, binders.length === 0, binders.join(','));
  }
  ok('the Payout page no longer promises automatic payouts',
     !/auto(matic)?[ -]payouts?/i.test(page.replace(/<!--[\s\S]*?-->/g, '')));

  // The Tor send method switch (F5) was removed 2026-09-26 with the step-by-step sender — the same
  // one-change removal as auto_payout above (the no-field parity check guards the other half).
  ok('tor_send_mode is no longer a payout default', !Object.prototype.hasOwnProperty.call(PoolSettings.defaults.payout, 'tor_send_mode'));
  ok('tor_send_mode has no validator', !Object.prototype.hasOwnProperty.call(PoolSettings.validators.payout, 'tor_send_mode'));
  const modeBinders = panelFiles().filter((f) => /id="tor_send_mode"/.test(read(f)));
  ok('no admin page binds id="tor_send_mode"', modeBinders.length === 0, modeBinders.join(','));
  ok('the Payout page no longer offers a step-by-step Tor send',
     !/step-by-step/i.test(page.replace(/<!--[\s\S]*?-->/g, '')));
}

// ── One-attempt Tor payouts (plan Session 3, 2026-09-26) — payments.html + miners.html ──────────
// Session 2 removed the retry route (410), made tor_held a pending status and added Re-check, a
// forced refund (step-up + typed id) and the Tor-pause clear. These pin the admin half of that.
console.log('\n[11] one-attempt Tor payouts — Held, fail_detail, Re-check / forced refund, pause clear');
{
  const pay = read('payments.html');
  const statusBlock = (pay.match(/const STATUS = \{([\s\S]*?)\n\};/) || [])[1] || '';
  ok('payments.html has a Held badge', /^ {2}tor_held: +\['badge-warn', +'Held'\]/m.test(statusBlock));
  // One list since the payouts split (2026-10): the queue's Active chip and the wallet-switch
  // wizard's in-flight count used to carry their own copies, and once they sit on different
  // pages a drifted wizard list lets an operator swap wallets under a live send.
  const common = read('payouts-common.js');
  const active = (common.match(/const PAYOUT_ACTIVE_STATUSES = Object\.freeze\(\[([^\]]*)\]\)/) || [])[1] || '';
  ok('Held counts as ACTIVE (its amount is still locked)', /'tor_held'/.test(active), active);
  const wizFile = panelFiles().find((f) => /function wizRefreshState\(/.test(read(f))) || '';
  const wiz = wizFile ? (read(wizFile).match(/function wizRefreshState\(\) \{([\s\S]*?)\n\}/) || [])[1] || '' : '';
  ok('…and as in flight for the wallet-switch wizard (its send may still be in the wallet)',
     /PAYOUT_ACTIVE_STATUSES\.includes\(w\.status\)/.test(wiz) &&
     /_filter === 'active'\) return PAYOUT_ACTIVE_STATUSES\.includes\(w\.status\)/.test(pay), wizFile);
  ok('payments.html loads payouts-common.js (else every shared call is a ReferenceError)',
     /<script src="\/admin\/payouts-common\.js"><\/script>/.test(pay));
  const DRIFT = /\bconst (ACTIVE|inflightStatuses) =|\bconst PAYOUT_ACTIVE_STATUSES\b/g;
  const redeclared = [];
  for (const f of panelFiles().filter((x) => x !== 'payouts-common.js')) {
    for (const m of read(f).matchAll(DRIFT)) redeclared.push(f + ': ' + m[0]);
  }
  ok('no admin page re-declares the in-flight status list (ACTIVE / inflightStatuses / a 2nd PAYOUT_ACTIVE_STATUSES)',
     redeclared.length === 0, '\n      ' + redeclared.join('\n      '));
  ok('control — the drift sweep detects a re-declared list',
     new RegExp(DRIFT.source).test("const inflightStatuses = ['tor_sending'];"));
  ok('a Held filter chip exists', /data-filter="tor_held"[^>]*onclick="setFilter\('tor_held', this\)"/.test(pay));
  ok('the Retry button and its call are gone (the route answers 410)',
     !/retryWithdrawal/.test(pay) && !/\/retry'/.test(pay));
  const canCancel = (pay.match(/const canCancel = ([^;]+);/) || [])[1] || '';
  // tor_failed left the set 2026-09-27: it was refunded when it failed, so cancel only relabelled
  // it 'cancelled' — which auditWalletSends counts as recorded. The server now answers 409.
  ok('Cancel is offered only where the server allows it (tor_checking alone)',
     /tor_checking/.test(canCancel) && !/tor_failed|retry_scheduled|tor_held/.test(canCancel), canCancel);
  const railMap = (pay.match(/const RAIL = \{([^}]*)\}/) || [])[1] || '';
  ok('the Status badge names the rail of every row ("Paid · Tor"), from w.method',
     /tor: 'Tor'/.test(railMap) && /slatepack: 'Slatepack'/.test(railMap) && /nostr: 'Goblin'/.test(railMap) &&
     /const label = rail \? `\$\{status\} · \$\{rail\}` : status;/.test(pay) &&
     !/'Failed \(/.test(statusBlock), railMap);
  ok('Held rows get Re-check → POST …/recheck', /w\.status === 'tor_held'/.test(pay) &&
     /adminFetch\('\/api\/admin\/withdrawals\/' \+ id \+ '\/recheck', \{ method: 'POST' \}\)/.test(pay));
  const force = (pay.match(/async function forceRefundHeld\(id[^)]*\) \{([\s\S]*?)\n\}/) || [])[1] || '';
  ok('the forced refund asks for the payout id typed back and sends it as confirm_id',
     /prompt\(/.test(force) && /confirm_id: typed/.test(force) && /'\/force-refund'/.test(force));
  ok('…and stops on a mismatch before any request', force.indexOf('!== String(id)') > 0 &&
     force.indexOf('!== String(id)') < force.indexOf('adminFetch('));
  ok('fail_code and fail_detail are shown, escaped', /escHtml\(w\.fail_code\)/.test(pay) && /escHtml\(detail/.test(pay));
  ok('the queue summary shows the held count', /s\.held_count/.test(pay));

  const home = read('index.html');
  ok('the dashboard labels Held too', /tor_held: +'<span class="badge badge-warn">Held<\/span>'/.test(home));

  // Since 2026-09-27 the Tor state lives in the miner's expanded row (the 🧅 row button and its
  // separate card are gone); the address travels the same way, via data-addr.
  const miners = read('miners.html');
  ok('miners.html expands a miner via data-addr (never a spliced literal)',
     /class="mn-toggle" data-addr="\$\{addr\}"/.test(miners) && /toggleMiner\(tog\.dataset\.addr\)/.test(miners));
  ok('…which reads GET /api/admin/miners/:addr', /API\.get\('\/api\/admin\/miners\/' \+ encodeURIComponent\(addr\)\)/.test(miners));
  ok('the pause is cleared through adminFetch (step-up) on POST …/tor-pause/clear',
     /adminFetch\('\/api\/admin\/miners\/' \+ encodeURIComponent\(addr\) \+ '\/tor-pause\/clear', \{ method: 'POST' \}\)/.test(miners) &&
     /onclick="clearTorPause\(this\.dataset\.addr\)"/.test(miners));
  ok('the miner view shows paused_until in UTC', /paused_until/.test(miners) && /toISOString\(\)/.test(miners));
}

// ── Miners page (2026-09-27): status dot, expandable rigs, chips, sort, in-page dialogs ──────
console.log('\n[12] miners.html — status + expandable rigs');
{
  const miners = read('miners.html');
  const script = (miners.match(/<script>\n([\s\S]*?)<\/script>/) || [])[1] || '';
  const head = (miners.match(/<thead>([\s\S]*?)<\/thead>/) || [])[1] || '';
  ok('the Online column is gone — the status dot rides in the Miner cell',
     !/<th[^>]*>\s*Online\s*<\/th>/.test(head) && /class="mn-dot mn-st-\$\{st\}"/.test(script));
  ok('the dot state comes from the SERVER status (lib/miner-status.js), not a page-side guess',
     /m\.is_banned \? 'banned' : \(STATE_LABEL\[m\.status\]/.test(script) && !/m\.is_online/.test(script));
  ok('every live-status window label comes from the API windows object',
     /if \(data && data\.windows\) _win = data\.windows;/.test(script) && /if \(w && w\.windows\) _win = w\.windows;/.test(script));
  ok('the rigs come from GET /api/admin/miners/:addr/workers',
     /API\.get\('\/api\/admin\/miners\/' \+ encodeURIComponent\(addr\) \+ '\/workers'\)/.test(script));
  ok('the expanded detail is a second <tr> of the same row() — paging still counts miners',
     /return open \? main \+ detailRow\(m, detailId\) : main;/.test(script));
  ok('expanded rows survive the 30 s refresh (a Set; the on-screen ones re-fetched, not while hidden)',
     /const _open = new Set\(\);/.test(script) && /if \(!document\.hidden\) \{\s*document\.querySelectorAll\('#miners-tbody tr\.mn-row\.is-open'\)\.forEach\(tr => fetchDetail\(tr\.dataset\.addr\)\)/.test(script));
  // GET /api/admin/miners/:addr counts every retained share of the address on the DB the stratum
  // server shares; it must not ride the 30 s refresh for every open row.
  ok('account facts are NOT re-read on every refresh (FACTS_MAX_AGE_S gate)',
     /const FACTS_MAX_AGE_S = \d+;/.test(script) && /wantFacts \? API\.get\('\/api\/admin\/miners\/' \+ encodeURIComponent\(addr\)\) : null/.test(script));
  ok('one ban/unban dialog at a time — a second open cancels the first (one Submit, one address)',
     /if \(_dialogClose\) _dialogClose\(null\);/.test(script) && /_dialogClose = close;/.test(script));
  ok('a timer refresh keeps the page; only a chip or sort change resets it',
     /applyView\(\);/.test(script) && (script.match(/applyView\(true\)/g) || []).length === 2);
  ok('the row click ignores buttons, links, copy controls and the detail itself',
     /t\.closest\('button, a, input, select, textarea, label, \[data-copy\], tr\.mn-detail'\)/.test(script));
  ok('the address copy survived as its own [data-copy] control',
     /class="addr-copy mn-copy" data-copy="\$\{addr\}"/.test(script));
  ok('the old shares_count column is gone (it fell at every retention prune)',
     !/shares_count/.test(head) && !/m\.shares_count/.test(script));
  // Native dialogs: a confirm()/prompt() followed by the step-up dialog is the throttled
  // "successive dialogs" pattern (design §13.12r) — this page uses its own in-page dialog.
  const code = script.replace(/\/\/[^\n]*/g, '');
  ok('no window.prompt / confirm on the miners page', !/\bprompt\(/.test(code) && !/\bconfirm\(/.test(code));
  ok('the dialog writes every value with textContent (no innerHTML in askDialog)',
     /function askDialog[\s\S]*?\n\}/.test(script) && !/innerHTML/.test((script.match(/function askDialog[\s\S]*?\n\}/) || [''])[0]));
  ok('ban/unban still go through adminFetch (step-up)',
     /adminFetch\('\/api\/admin\/miners\/' \+ encodeURIComponent\(addr\) \+ '\/ban'/.test(script) &&
     /adminFetch\('\/api\/admin\/miners\/' \+ encodeURIComponent\(addr\) \+ '\/unban'/.test(script));

  const shell = read('admin-shell.js');
  ok('AdminTable urlQuery is opt-in and only ever sets the input VALUE',
     /if \(input && opts\.urlQuery\)/.test(shell) && /input\.value = q0\.trim\(\);/.test(shell));
  ok('payments.html opts in, so miners.html → payments.html?q=<address> filters it',
     /urlQuery: true/.test(read('payments.html')) && /'\/admin\/payments\.html\?q=' \+ encodeURIComponent\(m\.grin_address\)/.test(script));

  // The capped list (route priority in test-admin-miners.js §5): the page must ask for the route's
  // maximum, say what it is showing, and reach accounts the cap left out through ?search=.
  ok('asks for the route maximum and no longer claims "Top 500 by balance"',
     /const LIST_LIMIT = 1000;/.test(script) && /'\/api\/admin\/miners\?limit=' \+ LIST_LIMIT/.test(script) && !/Top 500/.test(script));
  ok('the scope line is written with textContent from the API counts',
     /function updateScope\(\)[\s\S]*?el\.textContent = t;/.test(script) && /data\.truncated/.test(script));
  ok('the address filter also searches the server, only when the list is capped, URL-encoded, stale replies dropped',
     /onSearch: q =>/.test(script) &&
     /if \(!_scope \|\| !_scope\.truncated \|\| q\.length < SEARCH_MIN\)/.test(script) &&
     /'\/api\/admin\/miners\?limit=50&search=' \+ encodeURIComponent\(q\)/.test(script) &&
     /if \(seq !== _searchSeq\) return;/.test(script));
  ok('AdminTable onSearch is optional and cannot break the local filter',
     /if \(typeof opts\.onSearch === 'function'\) \{\s*try \{ opts\.onSearch\(input\.value\.trim\(\)\); \} catch/.test(shell));
}

// ── Games → Events (design §19.9, §19.11 — games Part 7) ─────────────────────────────
console.log('\n[13] games-events.html — the admin proxy, step-up and the nav');
{
  const exists = fs.existsSync(path.join(PANEL, 'games-events.html'));
  ok('games-events.html exists', exists);
  const page = exists ? read('games-events.html') : '';
  const script = (page.match(/<script>\n([\s\S]*?)<\/script>/) || [])[1] || '';
  const code = script.replace(/\/\/[^\n]*/g, '');
  const shell = read('admin-shell.js');
  const navBlock = (shell.match(/var NAV = \[([\s\S]*?)\n  \];/) || [])[1] || '';
  ok('NAV has a Games group holding games-events.html', /title: 'Games', ico: '🎮', children: \[[\s\S]*?\{ file: 'games-events\.html',\s+title: 'Events' \}/.test(navBlock));

  // Every call goes through the proxy prefix via games(); the paths it builds, checked against the
  // pool's OWN step-up rule (lib/games-link.js requiresStepUp — the enforcer, §19.11).
  const { requiresStepUp } = require('../lib/games-link');
  ok('all proxied calls go through games() → adminFetch(\'/api/admin/games/\' + rel)',
    /const res = await adminFetch\('\/api\/admin\/games\/' \+ rel, opts\);/.test(script) && !/API\.(get|post|put|del)\(/.test(code));
  ok('create + update are FAST writes (plain admin), cancel + finalise are step-up — per the pool\'s rule',
    /games\('POST', 'events', body\)/.test(script) && /games\('POST', 'events\/' \+ _editing\.id, body\)/.test(script)
    && /games\('POST', 'events\/' \+ ev\.id \+ '\/cancel'/.test(script) && /games\('POST', 'events\/' \+ ev\.id \+ '\/finalise'/.test(script)
    && !requiresStepUp('POST', 'events') && !requiresStepUp('POST', 'events/7')
    && requiresStepUp('POST', 'events/7/cancel') && requiresStepUp('POST', 'events/7/finalise') && !requiresStepUp('GET', 'events/7'));
  // Auth.fetch (API.*) redirects to /login.html on ANY 401 — and the proxy passes the games
  // service's own 401 (link secret mismatch) through. The page must tell the two apart.
  ok('a games 401 (ok:false) is shown as a link problem; only the pool\'s own 401 goes to login',
    /if \(res\.status === 401 && !\(data && data\.ok === false\)\)/.test(script) && /unauthorised: 'The pool and the games service disagree on the link secret/.test(script));
  ok('row buttons pass the id via data-id and one delegated listener (no inline on* on rows)',
    /data-act="cancel" data-id="\$\{id\}"/.test(script) && /btn\.dataset\.id/.test(script) && !/onclick=/.test(page));
  ok('no window.prompt / confirm (the in-page dialog, then stepup.js)', !/\bprompt\(/.test(code) && !/\bconfirm\(/.test(code));
  ok('the confirm dialog writes the operator\'s title with textContent',
    /document\.getElementById\('confirm-body'\)\.textContent = body;/.test(script) && !/confirm-body'\)\.innerHTML/.test(script));
  ok('every row value is escaped (title, kind, days, state, counts)',
    /\$\{escHtml\(e\.title\)\}/.test(script) && /title="\$\{escHtml\(e\.description\)\}"/.test(script) && !/\$\{e\.(title|kind_label|first_day|state)\}/.test(script));
  ok('days are UTC date inputs and the last day is INCLUDED (ends_at = last day + 1 day)',
    /type="date" id="ge-first"/.test(page) && /type="date" id="ge-last"/.test(page)
    && /Date\.parse\(v \+ 'T00:00:00Z'\)/.test(script) && /ends_at: lastDay \+ DAY,/.test(script));
  ok('loads stepup.js (adminFetch)', /<script src="\/js\/stepup\.js"><\/script>/.test(page));
}

// ── Games → Overview, Chat, Players (design §19.10, §19.11, D21 — games Part 9) ─────────
console.log('\n[14] games.html / games-chat.html / games-players.html — proxy, step-up, text-only chat');
{
  const pages = ['games.html', 'games-chat.html', 'games-players.html'];
  const exist = pages.every((p) => fs.existsSync(path.join(PANEL, p))) && fs.existsSync(path.join(PANEL, 'games-admin.js'));
  ok('the three pages and games-admin.js exist', exist);
  const shell = read('admin-shell.js');
  const navBlock = (shell.match(/var NAV = \[([\s\S]*?)\n  \];/) || [])[1] || '';
  ok('NAV: Games parent is games.html, children Overview → Chat → Players → Events',
    /\{ file: 'games\.html', title: 'Games', ico: '🎮', children: \[\s*\{ file: 'games\.html',\s+title: 'Overview & settings' \},\s*\{ file: 'games-chat\.html',\s+title: 'Chat & moderation' \},\s*\{ file: 'games-players\.html', title: 'Players' \},\s*\{ file: 'games-events\.html',\s+title: 'Events' \}/.test(navBlock));
  const helper = exist ? read('games-admin.js') : '';
  const helperCode = helper.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok('games-admin.js: every call goes through adminFetch(\'/api/admin/games/\' + rel) and tells a games 401 from the pool\'s',
    /var res = await adminFetch\('\/api\/admin\/games\/' \+ rel, opts\);/.test(helper)
    && /if \(res\.status === 401 && !\(data && data\.ok === false\)\)/.test(helper) && !/API\.(get|post|put|del)\(/.test(helperCode));
  ok('games-admin.js: no HTML sink at all (el() sets textContent)',
    !/\b(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write/.test(helperCode) && /if \(text !== undefined && text !== null\) e\.textContent = String\(text\);/.test(helper));
  for (const p of pages) {
    const page = exist ? read(p) : '';
    const script = (page.match(/<script>\n([\s\S]*?)<\/script>/) || [])[1] || '';
    const code = script.replace(/\/\/[^\n]*/g, '');
    ok(`${p}: loads stepup.js, admin-shell.js, then games-admin.js`,
      /<script src="\/js\/stepup\.js"><\/script>\s*<script src="\/admin\/admin-shell\.js"><\/script>\s*<script src="\/admin\/games-admin\.js"><\/script>/.test(page));
    ok(`${p}: proxied calls only through GamesAdmin.call (no API.*, no raw fetch)`, !/API\.(get|post|put|del)\(/.test(code) && !/\bfetch\(/.test(code) && /G\.call\(/.test(code));
    ok(`${p}: no HTML sink in the page script (chat bodies, reasons and names are text)`, !/\b(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write/.test(code));
    ok(`${p}: no inline on* handler, no native prompt/confirm/alert`, !/\son[a-z]+="/i.test(page) && !/\b(prompt|confirm|alert)\(/.test(code));
  }
  const chat = exist ? read('games-chat.html') : '';
  const players = exist ? read('games-players.html') : '';
  ok('games-chat.html: the message body and report reasons are built with el() (textContent)',
    /body\.appendChild\(el\('div', 'gc-body', m\.body\)\);/.test(chat) && /el\('span', null, '“' \+ r\.reason \+ '”'\)/.test(chat));
  ok('games-players.html: the message body is built with el() (textContent)', /el\('div', 'gp-body', m\.body\)/.test(players));

  // The paths these pages write, checked against the POOL's own step-up rule (the enforcer).
  const { requiresStepUp } = require('../lib/games-link');
  const A = 'grin1' + 'q'.repeat(58);
  const fast = [['POST', 'chat/messages/7/delete'], ['POST', 'chat/held/7/approve'], ['POST', 'chat/post'], ['POST', `players/${A}/mute`]];
  const stepUp = [['POST', 'chat/messages/7/restore'], ['POST', `players/${A}/unmute`], ['POST', `players/${A}/ban`], ['POST', `players/${A}/unban`],
    ['POST', `players/${A}/purge`], ['POST', `players/${A}/adjust`], ['POST', `moderators/${A}`], ['POST', `moderators/${A}/remove`],
    ['POST', 'chat/words'], ['POST', 'settings']];
  ok('delete / approve / operator post / mute are FAST (live moderation); everything else these pages write is step-up',
    fast.every(([m, p]) => !requiresStepUp(m, p)) && stepUp.every(([m, p]) => requiresStepUp(m, p)),
    JSON.stringify([...fast.filter(([m, p]) => requiresStepUp(m, p)), ...stepUp.filter(([m, p]) => !requiresStepUp(m, p))]));
  ok('the pages build exactly those write paths',
    /'chat\/held\/' \+ m\.id \+ '\/approve'/.test(chat) && /'chat\/messages\/' \+ m\.id \+ '\/' \+ action/.test(chat)
    && /G\.call\('POST', 'chat\/post'/.test(chat) && /'players\/' \+ G\.playerSeg\(address\) \+ '\/mute'/.test(chat)
    && /G\.call\('POST', 'chat\/words', body\)/.test(chat) && /'moderators\/' \+ address \+ '\/remove'/.test(chat)
    && /write\('\/ban'/.test(players) && /write\('\/purge'/.test(players) && /write\('\/adjust'/.test(players));
  // Guests (games Part C5, §19.17.3): a guest id cannot sit in a path (':' — PROXY_PATH_RE refuses
  // it), so every player path goes through GamesAdmin.playerSeg ('g:<16>' → 'g.<16>'), and the
  // guest-only write (delete) is step-up while muting a guest stays FAST like any mute.
  const gadmin = read('games-admin.js');
  const GS = 'g.' + 'a'.repeat(16);
  // The proxy's own path check, read from its source (it is not exported): the enforcer, not a copy.
  const proxySrc = /const PROXY_PATH_RE = \/(.+)\/;\n/.exec(fs.readFileSync(path.join(__dirname, '..', 'lib', 'games-link.js'), 'utf8'));
  const PROXY_PATH_OK = (p) => !!proxySrc && new RegExp(proxySrc[1]).test(p);
  ok('guests: playerSeg maps g:<16> to g.<16>; every player path on the three pages uses it',
    /function playerSeg\(a\) \{ return GUEST_RE\.test\(a\) \? 'g\.' \+ a\.slice\(2\) : a; \}/.test(gadmin)
      && /'players\/' \+ G\.playerSeg\(_addr\) \+ rel/.test(players) && /'players\/' \+ G\.playerSeg\(address\)\)/.test(players)
      && /write\('players\/' \+ G\.playerSeg\(address\) \+ '\/nick-block'/.test(read('games-names.html'))
      && !/'players\/' \+ (address|_addr) \+/.test(chat + players + read('games-names.html')));
  ok('guests: the proxy accepts the g.<16> form; delete is step-up, mute stays FAST',
    PROXY_PATH_OK(`players/${GS}/mute`) && PROXY_PATH_OK(`guests/${GS}/delete`) && !PROXY_PATH_OK('players/g:' + 'a'.repeat(16) + '/mute')
      && requiresStepUp('POST', `guests/${GS}/delete`) && !requiresStepUp('POST', `players/${GS}/mute`)
      && /G\.call\('POST', 'guests\/' \+ G\.playerSeg\(_addr\) \+ '\/delete'/.test(players));
  ok('games.html shows the fixed floors (the 1 h proof-age floor, §19.11) and saves only changed keys',
    /chat_min_proof_age: s => 'A proof is always at least '/.test(read('games.html')) && /G\.call\('POST', 'settings', \{ values \}\)/.test(read('games.html')));
}

// ── Games → Nicknames (design §19.16 — games Part 12) ───────────────────────────────────
console.log('[15] games-names.html — the nickname queue: proxy, step-up, text-only names');
{
  const exists = fs.existsSync(path.join(PANEL, 'games-names.html'));
  ok('games-names.html exists', exists);
  const page = exists ? read('games-names.html') : '';
  const script = (page.match(/<script>\n([\s\S]*?)<\/script>/) || [])[1] || '';
  const code = script.replace(/\/\/[^\n]*/g, '');
  const shell = read('admin-shell.js');
  const navBlock = (shell.match(/var NAV = \[([\s\S]*?)\n  \];/) || [])[1] || '';
  ok('NAV: Nicknames sits in the Games group, after Events',
    /\{ file: 'games-events\.html',\s+title: 'Events' \},\s*\{ file: 'games-names\.html',\s+title: 'Nicknames' \}\s*\]/.test(navBlock));
  ok('loads stepup.js, admin-shell.js, then games-admin.js',
    /<script src="\/js\/stepup\.js"><\/script>\s*<script src="\/admin\/admin-shell\.js"><\/script>\s*<script src="\/admin\/games-admin\.js"><\/script>/.test(page));
  ok('proxied calls only through GamesAdmin.call (no API.*, no raw fetch)', !/API\.(get|post|put|del)\(/.test(code) && !/\bfetch\(/.test(code) && /G\.call\(/.test(code));
  ok('no HTML sink: the nickname, its shown_as and the reason are text (el() → textContent)',
    !/\b(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write/.test(code)
    && /el\('div', 'gn-name', n\.name\)/.test(script) && /el\('span', null, '“' \+ n\.reason \+ '”'\)/.test(script));
  ok('no inline on* handler, no native prompt/confirm/alert', !/\son[a-z]+="/i.test(page) && !/\b(prompt|confirm|alert)\(/.test(code));
  // Part C3 (§19.17.5): no queue — the five writes are remove, ban name, unban, block, unblock.
  const writes = [...script.matchAll(/write\('([^']*)'( \+ [^,]+)?/g)].map((m) => m[1] + (m[2] ? '…' : ''));
  ok('the page builds exactly the five v2 write paths, all through write() → G.call(POST)',
    JSON.stringify(writes.sort()) === JSON.stringify(['banned-names', 'banned-names/…', 'nicknames/…', 'players/…', 'players/…'].sort())
    && /await G\.call\('POST', rel, body\)/.test(script) && !/\/approve'|\/reject'|state=pending/.test(code), writes.join(' | '));
  ok('a rule hint on a live row and a banned name are rendered as text',
    /el\('span', 'badge badge-warn', 'Now refused by '/.test(script) && /el\('td', 'gn-name', b\.name\)/.test(script));
  // The POOL is the enforcer (§19.11): every nickname write must be step-up there. The games
  // side's own copy is checked in play/server/scripts/test-names.js (it may not load pool code).
  const { requiresStepUp } = require('../lib/games-link');
  const addr = 'grin1' + 'q'.repeat(58);
  ok('every nickname write is STEP-UP at the pool (none is in FAST_WRITES); the reads are not',
    ['nicknames/7/remove', 'banned-names', 'banned-names/sparky/unban', `players/${addr}/nick-block`, `players/${addr}/nick-unblock`].every((p) => requiresStepUp('POST', p))
      && !requiresStepUp('GET', 'nicknames') && !requiresStepUp('GET', 'banned-names') && !requiresStepUp('GET', 'nick-blocked'));
  ok('the reason field says the player sees it', /Reason \(optional — the player sees it on \/play\/; it is kept in the moderation log\)/.test(page));
  ok('games.html links the page and labels both nickname settings', /href="games-names\.html">Nicknames</.test(read('games.html'))
    && /nicknames_enabled: 'Players may set a nickname \(checked automatically, live at once/.test(read('games.html'))
    && /nickname_change_days: 'A player may change their nickname once every this many days/.test(read('games.html')));
  ok('the page links Settings → Names (the blocked-word list lives in the pool)', /href="settings-names\.html">blocked words</.test(page));
  ok('games-players.html shows the nickname as text', /document\.getElementById\('gp-nick-state'\)\.textContent = /.test(read('games-players.html')));
}

// ── [16] node-availability.html — two observers side by side (design §20.4/§20.6) ─────────────
// No jsdom in this project (test-branding-sinks.js), so the page keeps its view logic in a pure
// block between NA-VIEW markers and this runs that block on its own in a vm. A missing marker is
// a FAIL, never a skip. The DOM wiring below the block only hands these functions' output over.
console.log('\n[16] node-availability.html — empty state, both sources, filters');
{
  const vm = require('vm');
  const page = read('node-availability.html');
  const shell = read('admin-shell.js');
  const m = page.match(/\/\/ ── NA-VIEW BEGIN ──[^\n]*\n([\s\S]*?)\/\/ ── NA-VIEW END ──/);
  ok('the page carries the NA-VIEW block', !!m);
  const block = m ? m[1] : '';
  ok('the view block touches no DOM (document/window) — it must run headless',
     !!block && !/\b(document|window)\b/.test(block.replace(/\/\/[^\n]*/g, '')));
  const ctx = vm.createContext({});
  try { vm.runInContext(block, ctx); } catch (e) { ok('the view block runs in a vm', false, e.message); }
  const V = ctx;

  // Nav + page shell.
  const dash = (shell.match(/\{ file: 'index\.html', title: 'Dashboard'[\s\S]*?\] \}/) || [''])[0];
  ok('nav: the page sits in the Dashboard group, right after System Health',
     /file: 'health\.html',\s*title: 'System Health' \},\s*\{ file: 'node-availability\.html', title: 'Node Availability' \}/.test(dash));
  ok('page loads auth.js → api.js → admin-shell.js and guards the page',
     /\/js\/auth\.js[\s\S]*\/js\/api\.js[\s\S]*\/admin\/admin-shell\.js/.test(page) && /API\.guardAdminPage\(\)/.test(page));
  const visible = page.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  ok('UTC is stated ONCE on the page (memory feedback_pool_utc_display)', (visible.match(/All times UTC/g) || []).length === 1);
  ok('no local-time formatter anywhere in the page', !/toLocale(String|TimeString|DateString)\(/.test(page));
  const css = (page.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1].replace(/\/\*[\s\S]*?\*\//g, '');   // its comment names display:none on purpose
  ok('no class rule hides anything (initial hidden states are inline)', !/display:\s*none/.test(css));
  ok('day states do not rely on colour alone: outage is HATCHED, not-watched is a dashed hollow',
     /\.na-st-out\s*\{[^}]*repeating-linear-gradient/.test(css) && /\.na-st-none\s*\{[^}]*dashed/.test(css));
  ok('both themes are tokenised (dark default + light override)',
     /:root, :root\[data-theme="dark"\] \{[^}]*--na-ok/.test(css) && /:root\[data-theme="light"\] \{[^}]*--na-hatch/.test(css));
  ok('no inline on* handler', !/\son[a-z]+="/i.test(page.replace(/<script[\s\S]*?<\/script>/g, '')));
  ok('the events table goes through AdminTable', /AdminTable\.create\(\{\s*tbody: 'na-events-tbody'/.test(page));

  const T = 1759500000;                       // a fixed "now" (server clock, data.to)
  const day = (d, o) => Object.assign({ day: d, up_s: 0, down_s: 0, planned_s: 0, fault_s: 0, unobserved_s: 0, uptime_pct: null }, o);
  const src = (o) => Object.assign({ uptime_pct: 100, outages: 0, by_class: {}, mtbf_s: null, longest_outage_s: null,
    open_outage: false, planned_stops: 0, up_since: T - 3 * 86400, daily: [] }, o);

  // Empty state — no recorder on the box.
  if (typeof V.naRecorderNotice === 'function') {
    const absent = { network: 'mainnet', to: T, recorder: { ledger: 'absent', status: null },
      sources: { pool: src({ uptime_pct: 99.5 }), recorder: src({ uptime_pct: null, up_since: null }) } };
    const n = V.naRecorderNotice(absent);
    ok('empty state: an absent ledger says so and names hub 08 → Diagnostics',
       n.kind === 'absent' && /hub 08 → Diagnostics → Node event recorder/.test(n.html));
    const k = V.naKpis(absent);
    ok('empty state: node-box KPIs are blank and "not installed", the pool view still shows',
       k.recorder.up === '—' && k.recorder.now.text === 'not installed' && k.pool.up === '99.50%');
    ok('empty state: the node-box class card says no recorder', /No recorder installed/.test(V.naClassCardHtml(absent, 'recorder')));
    const unread = V.naRecorderNotice({ network: 'mainnet', recorder: { ledger: 'unreadable' }, sources: {} });
    ok('unreadable ledger names the modes to fix', unread.kind === 'unreadable' && /0755/.test(unread.html) && /0644/.test(unread.html));
    const stale = V.naRecorderNotice({ network: 'mainnet', recorder: { ledger: 'ok', status: { state: 'up', stale: true, updated: T - 900 } }, sources: {} });
    ok('a stale recorder status is called out', stale.kind === 'stale' && /stopped updating/.test(stale.html));
    // Control: an installed, fresh recorder must produce NO notice, or the empty-state check above
    // would pass on a page that shows the banner unconditionally.
    const fine = V.naRecorderNotice({ network: 'mainnet', recorder: { ledger: 'ok', status: { state: 'up', stale: false, updated: T } }, sources: {} });
    ok('control — a working recorder produces no notice', fine.kind === 'ok' && fine.html === '');
    ok('the other network is explained, not shown as empty data',
       V.naRecorderNotice({ network: 'testnet', other_network: true, events: [], sources: {} }).kind === 'other');
    ok('the network name is escaped / allow-listed in the notice',
       !/<script>/.test(V.naRecorderNotice({ network: '<script>', recorder: { ledger: 'absent' }, sources: {} }).html));
  } else ok('naRecorderNotice is defined in the view block', false);

  // Both sources — separate figures, separate lanes, rows from each.
  if (typeof V.naKpis === 'function') {
    const both = { network: 'mainnet', to: T,
      recorder: { ledger: 'ok', status: { state: 'up', stale: false, updated: T - 20, up_since: T - 2 * 86400 } },
      sources: {
        pool: src({ uptime_pct: 99.31, outages: 2, by_class: { timeout: 1, refused: 1 }, mtbf_s: 7200, longest_outage_s: 600,
          daily: [day('2026-10-01', { up_s: 86400, uptime_pct: 100 }), day('2026-10-02', { up_s: 85800, down_s: 600, uptime_pct: 99.3 }),
                  day('2026-10-03', { unobserved_s: 3600 })] }),
        recorder: src({ uptime_pct: 100, outages: 0, planned_stops: 1,
          daily: [day('2026-10-01', { up_s: 86400, uptime_pct: 100 }), day('2026-10-02', { up_s: 85800, planned_s: 600, uptime_pct: 100 }),
                  day('2026-10-03', { up_s: 3600, uptime_pct: 100 })] }) } };
    const k = V.naKpis(both);
    ok('both sources: each has its OWN uptime — never merged (pool 99.31%, node box 100%)',
       k.pool.up === '99.31%' && k.recorder.up === '100%');
    ok('both sources: outage counts stay per observer', k.pool.outages === '2' && k.recorder.outages === '0');
    ok('both sources: "right now" reads each observer', /^up 3 d/.test(k.pool.now.text) && /^up 2 d/.test(k.recorder.now.text));
    const pd = V.naStripDays(both, 'pool', 90), rd = V.naStripDays(both, 'recorder', 90);
    ok('strip: pool lane is ok / outage / not-watched', pd.map((x) => x.state).join() === 'ok,out,none');
    ok('strip: a planned-only day is NOT an outage on the node-box lane', rd.map((x) => x.state).join() === 'ok,ok,ok');
    const lane = V.naLaneHtml(pd, 'pool');
    ok('strip: lane cells carry the state class and a spoken summary',
       /na-st-out/.test(lane) && /aria-label="Pool view, last 3 days: 1 up, 1 with a counted outage, 1 with no counted time\."/.test(lane));
    // R2: a day the pool WAS watching but saw only an auth fault (or a node-box day that was all
    // planned stop) has no counted time — it must not be labelled "not watched".
    const faultDay = day('2026-10-04', { fault_s: 86400 });
    const faultTip = V.naTipHtml({ day: faultDay.day, state: V.naDayState(faultDay), d: faultDay }, 'pool');
    ok('strip: an auth-fault-only day reads "no counted time" and shows its fault time, never "not watched"',
       V.naDayState(faultDay) === 'none' && /no counted time/.test(faultTip) && /Auth fault/.test(faultTip) && !/not watched/i.test(faultTip));
    ok('strip: the downtime table lists both observers\' days (down AND planned)',
       V.naDowntimeDays(both).map((r) => r.src + ':' + r.day).join() === 'pool:2026-10-02,recorder:2026-10-02');
    ok('classes: the planned stop is listed as not counted', /1 planned stop .*not counted/.test(V.naClassCardHtml(both, 'recorder')));

    const events = [
      { id: 1, source: 'pool', started_at: T - 7000, ended_at: T - 6400, duration_s: 600, state: 'down', class: 'refused', origin: 'transport', detail: 'API port refused; no node process seen' },
      { id: 2, source: 'recorder', started_at: T - 7100, ended_at: T - 6300, duration_s: 800, state: 'planned', class: null, origin: null, detail: 'toolkit stop · by=01_build_new_grin_node.sh' },
      { id: 3, source: 'recorder', started_at: T - 6300, ended_at: T - 6300, duration_s: 0, state: 'info', class: null, origin: null, detail: 'up' },
      { id: 4, source: 'pool', started_at: T - 300, ended_at: null, duration_s: null, state: 'down', class: 'timeout', origin: 'transport', detail: '<img src=x onerror=alert(1)>' },
      { id: 5, source: 'recorder', started_at: T - 290, ended_at: null, duration_s: null, state: 'down', class: 'hung', origin: null, detail: 'hung' },
    ];
    const ann = V.naAnnotate(events, T);
    ok('annotate: a pool outage overlapping a node-box planned stop gets a note', /planned toolkit stop/.test(ann[0].note || ''));
    ok('annotate: a pool outage with no planned stop under it gets none', !ann[3].note);
    ok('annotate: never changes the row itself (state/class/duration)',
       ann[0].state === 'down' && ann[0].class === 'refused' && ann[0].duration_s === 600 && events[0].note === undefined);
    const poolRow = V.naRow(ann[0], T), recRow = V.naRow(ann[4], T);
    ok('rows: both observers render, labelled', /<td>Pool view<\/td>/.test(poolRow) && /<td>Node box<\/td>/.test(recRow));
    ok('rows: start is UTC and the open row reads "ongoing"',
       poolRow.includes(new Date((T - 7000) * 1000).toISOString().slice(0, 19).replace('T', ' ')) && /5 min · ongoing/.test(V.naRow(ann[3], T)));
    ok('rows: detail text is escaped', !/<img/.test(V.naRow(ann[3], T)) && /&lt;img/.test(V.naRow(ann[3], T)));
    ok('rows: a point event shows no duration', /<td>—<\/td>/.test(V.naRow(ann[2], T)));

    // Filters.
    const ids = (rows) => rows.map((e) => e.id).join();
    ok('filter: default hides only the info lines', ids(V.naFilter(ann, {})) === '1,2,4,5');
    ok('filter: observer = pool', ids(V.naFilter(ann, { source: 'pool', show: 'all' })) === '1,4');
    ok('filter: observer = node box', ids(V.naFilter(ann, { source: 'recorder', show: 'all' })) === '2,3,5');
    ok('filter: class', ids(V.naFilter(ann, { cls: 'hung' })) === '5');
    ok('filter: counted outages only', ids(V.naFilter(ann, { show: 'outages' })) === '1,4,5');
    ok('filter: everything includes the info lines', ids(V.naFilter(ann, { show: 'all' })) === '1,2,3,4,5');
    ok('filter: class options come from the rows', V.naClassOptions(ann).join() === 'hung,refused,timeout');
  } else ok('naKpis is defined in the view block', false);

  // Formatters.
  if (typeof V.naDur === 'function') {
    ok('durations: s / min / h min / d h', V.naDur(45) === '45 s' && V.naDur(720) === '12 min' &&
       V.naDur(3 * 3600 + 300) === '3 h 05 min' && V.naDur(2 * 86400 + 4 * 3600) === '2 d 4 h');
    ok('percent: null is a dash, never 0%', V.naPct(null) === '—' && V.naPct(100) === '100%' && V.naPct(99.5) === '99.50%');
  }
}

console.log('\n' + (fail ? 'FAILURES' : 'ALL PASS') + ` — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
