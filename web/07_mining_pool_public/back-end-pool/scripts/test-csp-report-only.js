#!/usr/bin/env node
// Strict page CSPs (code-layout refactor: F6 added Report-Only twins, F7 flipped, plan tool T6).
//
// Three PAGE policies exist — Express (index.js), the nginx public page snippet, the nginx admin
// snippet. Since F7 (2026-10-12) each ENFORCES a script-src with no 'unsafe-inline' and no
// 'unsafe-eval': pages carry no inline <script> and no on*= handler. Until then each shipped a
// Content-Security-Policy-Report-Only twin (the same policy minus 'unsafe-inline' in script-src)
// so a browse of every page could show what the strict policy WOULD block; the flip went in only
// after that browse logged nothing. The twins are gone, and [1]–[4] now fail if one comes back.
//
// Also pinned: no report-uri / report-to (no reporting endpoint exists), style-src still allows
// inline style (out of the flip's scope), and the /uploads/ + /custom/ + donor-banner sandbox
// CSPs are untouched.
//
// [5] (R3): the two app-rendered pages (/blog/<slug>, /page.html) must hide the app's own CSP at
// nginx, or the browser enforces both policies there (the app's has no analytics or font host).
// The Report-Only hide stays too: harmless now, and it covers an old app behind a new vhost.
//
// [6] (R3 L9 C10): the three ENFORCING page policies are pinned as literal strings, so any edit
// to one — a host added, a directive dropped, 'unsafe-inline' put back — is a reviewed test diff.
// [7] (R3 L9 C4): nginx add_header inheritance, mechanically. Every block of the pool vhost
// (shell fragments expanded the way bash expands them) that declares an add_header of its own
// must re-include a header snippet, and every :443 server must include one at server level.
//
// Run: node scripts/test-csp-report-only.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

const INDEX = path.resolve(__dirname, '../index.js');
const VHOST = path.resolve(__dirname, '../../../../scripts/07_grin_mining_public_pool.sh');
const indexSrc = fs.readFileSync(INDEX, 'utf8');
const vhostSrc = fs.readFileSync(VHOST, 'utf8');

// "a b; c d e;" → [['a','b'], ['c','d','e']]
function directives(policy) {
  return policy.split(';').map((d) => d.trim()).filter(Boolean).map((d) => d.split(/\s+/));
}
const srcOf = (dirs, name) => (dirs.find((d) => d[0] === name) || []).slice(1);

function checkStrict(label, enforcing, reportOnly) {
  ok(`${label}: exactly one enforcing policy`, enforcing.length === 1, `found ${enforcing.length}`);
  ok(`${label}: no Report-Only policy (the F6 twin is gone since the F7 flip)`, reportOnly.length === 0,
    `found ${reportOnly.length}`);
  if (enforcing.length !== 1) return;
  const dirs = directives(enforcing[0]);
  ok(`${label}: enforcing script-src has neither 'unsafe-inline' nor 'unsafe-eval'`,
    srcOf(dirs, 'script-src').length > 0 &&
    !srcOf(dirs, 'script-src').some((t) => t === "'unsafe-inline'" || t === "'unsafe-eval'"),
    JSON.stringify(srcOf(dirs, 'script-src')));
  ok(`${label}: style-src still allows inline style (out of scope — not part of the flip)`,
    srcOf(dirs, 'style-src').includes("'unsafe-inline'"));
}

console.log('\n[1] Express (index.js) security-header middleware');
{
  const enf = [...indexSrc.matchAll(/res\.setHeader\('Content-Security-Policy', "([^"]+)"\)/g)].map((m) => m[1]);
  const ro = [...indexSrc.matchAll(/res\.setHeader\('Content-Security-Policy-Report-Only', "([^"]+)"\)/g)].map((m) => m[1]);
  checkStrict('Express', enf, ro);
  // Set in the SAME middleware as X-Frame-Options, unconditionally — a CSP under an `if` could
  // miss a set of responses (R3 L9 C8: a substring check cannot see a condition on the same
  // line or an `if (…) {` wrapping only one of them).
  const lines = indexSrc.split('\n');
  const li = lines.findIndex((l) => l.includes("res.setHeader('Content-Security-Policy',"));
  const lx = lines.findIndex((l) => l.includes("res.setHeader('X-Frame-Options',"));
  // The indent of a line that is NOTHING but a setHeader statement; null for anything else.
  const bareIndent = (n) => (n < 0 ? null : (lines[n].match(/^(\s*)res\.setHeader\(.*\);\s*$/) || [null, null])[1]);
  ok('Express: X-Frame-Options and the enforcing CSP are bare statements at ONE indent (no condition on either)',
    li > lx && lx >= 0 && bareIndent(lx) !== null && bareIndent(li) === bareIndent(lx),
    `lines ${lx + 1}/${li + 1}`);
}

// The nginx snippets are heredocs in pool_setup_nginx; cut each one by its header comment.
const snippet = (re) => (vhostSrc.match(re) || [''])[0];
const nginxPolicies = (block, header) =>
  [...block.matchAll(new RegExp(`^add_header ${header} "([^"]+)" always;$`, 'gm'))].map((m) => m[1]);

console.log('\n[2] nginx public page snippet ($hdr_page)');
{
  const page = snippet(/# Common headers \+ the page CSP[\s\S]*?\nHDREOF/);
  ok('page snippet located', page.length > 0);
  checkStrict('nginx page', nginxPolicies(page, 'Content-Security-Policy'),
    nginxPolicies(page, 'Content-Security-Policy-Report-Only'));
  // The ${probe_csp} expansion: without it the connect page's gateway pings are blocked.
  ok('nginx page: the policy carries the ${probe_csp} connect-src expansion',
    (page.match(/'self'\$\{probe_csp\}/g) || []).length === 1);
}

console.log('\n[3] nginx admin snippet ($hdr_admin)');
{
  const admin = snippet(/# Common headers \+ the ADMIN CSP[\s\S]*?\nHDREOF/);
  ok('admin snippet located', admin.length > 0);
  checkStrict('nginx admin', nginxPolicies(admin, 'Content-Security-Policy'),
    nginxPolicies(admin, 'Content-Security-Policy-Report-Only'));
}

console.log('\n[4] scope — no Report-Only anywhere, sandbox CSPs untouched');
{
  // The F6 twins lived in the two snippets; F7 deleted both. A Report-Only header set anywhere in
  // the vhost now is a policy nobody reads (no endpoint, and the console is not watched).
  const roLines = vhostSrc.split('\n').filter((l) => /add_header Content-Security-Policy-Report-Only/.test(l));
  ok('vhost: zero Report-Only add_header lines', roLines.length === 0, `found ${roLines.length}`);
  for (const loc of ['/uploads/', '/custom/']) {
    const esc = loc.replace(/\//g, '\\/');
    const block = (vhostSrc.match(new RegExp(`location ${esc} \\{[\\s\\S]*?\\n    \\}`)) || [''])[0];
    ok(`${loc}: sandbox CSP unchanged`, block.includes(
      `add_header Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; sandbox" always;`));
    ok(`${loc}: no Report-Only twin and no page/admin snippet`, block.length > 0 &&
      !/Report-Only/.test(block) && !/include \$hdr_(page|admin);/.test(block));
  }
  // The Express /uploads sandbox moved into routes/index.js with the backend refactor (P1).
  const routesIdx = fs.readFileSync(path.resolve(__dirname, '../routes/index.js'), 'utf8');
  ok('Express /uploads sandbox CSP unchanged (routes/index.js)', routesIdx.includes(
    `res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");`));
  ok('Express /uploads: no Report-Only twin', !/Report-Only/.test(routesIdx));
  // The THIRD sandbox policy (R3 L2): the donor-banner review image, served on the ADMIN origin.
  const donorsSrc = fs.readFileSync(path.resolve(__dirname, '../routes/admin/donors.js'), 'utf8');
  ok('Express donor banner image: sandbox CSP unchanged (routes/admin/donors.js)', donorsSrc.includes(
    `res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");`));
  ok('Express donor banner image: no Report-Only twin', !/Report-Only/.test(donorsSrc));
  // Check the policy VALUES, not the files: a comment may well mention report-uri.
  const allPolicies = [
    ...[...indexSrc.matchAll(/res\.setHeader\('Content-Security-Policy(?:-Report-Only)?', "([^"]+)"\)/g)],
    ...[...vhostSrc.matchAll(/add_header Content-Security-Policy(?:-Report-Only)? "([^"]+)"/g)],
  ].map((m) => m[1]);
  ok('non-vacuity: every CSP value was read (1 Express + 2 snippet + 2 sandbox)', allPolicies.length === 5,
    `found ${allPolicies.length}`);
  ok('no policy carries report-uri / report-to (no new endpoint)',
    allPolicies.length > 0 && !allPolicies.some((p) => /report-uri|report-to/.test(p)));
}

console.log('\n[5] Express-rendered pages carry the nginx page policy ONLY (R3)');
{
  // /blog/<slug> and /page.html are HTML documents the app renders (routes/seo.js sendShell) and
  // nginx proxies. The app sets its own CSP on EVERY response (index.js, [1]); nginx does not
  // strip upstream headers, and a browser enforces every CSP it receives — so on exactly these two
  // pages the app's narrower policy (no analytics or Google-font host) was intersected with the
  // page one. Each location hides the app's CSP (and the Report-Only header an app from before
  // F7 still sends) and declares no add_header of its own, so it inherits the server-level page
  // snippet: the same headers the shell gets when served from disk.
  const seo = fs.readFileSync(path.resolve(__dirname, '../routes/seo.js'), 'utf8');
  const shells = [...new Set([...seo.matchAll(/sendShell\(res, '([a-z-]+\.html)'/g)].map((m) => m[1]))].sort();
  ok('seo.js renders exactly post.html + page.html (a NEW app-rendered page needs the same nginx treatment)',
    JSON.stringify(shells) === '["page.html","post.html"]', JSON.stringify(shells));
  ok('server block includes the page snippet at server level (what the two locations inherit)',
    /\n    include \$hdr_page;\n/.test(vhostSrc));
  // Cut a location block by its opening line; comment lines dropped so prose cannot satisfy a check.
  const locBlock = (head) => {
    const i = vhostSrc.indexOf(`\n    location ${head}`);
    if (i < 0) return '';
    const j = vhostSrc.indexOf('\n    }', i + 1);
    if (j < 0) return '';
    return vhostSrc.slice(i, j + 6).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  };
  for (const [label, head] of [['/blog/<slug>', '~ ^/blog/('], ['/page.html', '= /page.html {']]) {
    const b = locBlock(head);
    ok(`${label}: location found and proxied to the app`, /proxy_pass\s+http:\/\/127\.0\.0\.1:\$POOL_PORT;/.test(b),
      b.slice(0, 80));
    ok(`${label}: hides the app's enforcing CSP`, /\n\s+proxy_hide_header\s+Content-Security-Policy;/.test(b));
    ok(`${label}: hides a pre-F7 app's Report-Only header`, /\n\s+proxy_hide_header\s+Content-Security-Policy-Report-Only;/.test(b));
    ok(`${label}: no add_header of its own (else it drops the inherited page snippet)`,
      b.length > 0 && !/\badd_header\b/.test(b));
  }
}

console.log('\n[6] the three ENFORCING page policies, pinned (R3 L9 C10)');
{
  // Literal copies, on purpose: [1]–[3] check properties (no inline script, inline style kept),
  // so a host added to or a directive dropped from an enforcing line passes them. Changing one of
  // these strings is the review step. F7 (2026-10-12) took 'unsafe-inline' out of all three
  // script-src lists here, in the same commit that flipped the policies.
  const PINNED = {
    Express: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'",
    'nginx page': "default-src 'self'; script-src 'self' https://www.googletagmanager.com https://plausible.io https://cloud.umami.is; connect-src 'self'${probe_csp} https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://plausible.io https://cloud.umami.is; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';",
    'nginx admin': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';",
  };
  const live = {
    Express: [...indexSrc.matchAll(/res\.setHeader\('Content-Security-Policy', "([^"]+)"\)/g)].map((m) => m[1]),
    'nginx page': nginxPolicies(snippet(/# Common headers \+ the page CSP[\s\S]*?\nHDREOF/), 'Content-Security-Policy'),
    'nginx admin': nginxPolicies(snippet(/# Common headers \+ the ADMIN CSP[\s\S]*?\nHDREOF/), 'Content-Security-Policy'),
  };
  for (const [label, want] of Object.entries(PINNED)) {
    ok(`${label}: enforcing policy == the pinned string`, live[label].length === 1 && live[label][0] === want,
      `\n      want ${want}\n      got  ${JSON.stringify(live[label])}`);
  }
}

console.log('\n[7] nginx header inheritance — every block with its own add_header re-includes a snippet (R3 L9 C4)');
{
  // nginx: add_header is inherited "if and only if there are no add_header directives defined on
  // the current level" — so ANY add_header in a block silently drops the server-level snippet
  // (CSP, X-Frame-Options, HSTS, nosniff) for that block unless it includes one again (audit §I1).
  // test-admin-panel / test-latency-probe / [5] pin the blocks that exist; this walks EVERY block,
  // so a new location with `add_header Cache-Control …` and no include fails here by name.
  //
  // The vhost is assembled by bash, so the text is expanded the same way first: the ping-block
  // function, the two optional server blocks, and the one-line fragments. An unknown bare
  // `$fragment` line FAILS — it could expand to anything, an add_header included.
  const SNIPPET_INCLUDE = /^include \$hdr_(common|page|admin)$/;
  const pingFn = (vhostSrc.match(/\n_pool_nginx_ping_block\(\) \{\n[\s\S]*?\n    cat << EOF\n([\s\S]*?)\nEOF\n\}/) || [])[1] || '';
  const ping = (hdrVar) => pingFn.replace(/\$\{hdr\}/g, '$' + hdrVar);
  const callPing = (s) => s.replace(/\$\(_pool_nginx_ping_block "\$([a-z_]+)"\)/g, (_, h) => ping(h));
  const probeHub = callPing((vhostSrc.match(/\n\s+probe_hub_block="([\s\S]*?)\n"\n/) || [])[1] || '');
  const wwwHttps = (vhostSrc.match(/\n\s+www_https_block="([\s\S]*?)\n"\n/) || [])[1] || '';
  const pingArg = (vhostSrc.match(/\n\s+local ping_block; ping_block=\$\(_pool_nginx_ping_block "\$([a-z_]+)"\)\n/) || [])[1];
  // What each one-line fragment expands to on a box where it is NON-empty (the worst case).
  const FRAGMENTS = {
    cf_realip_include: 'include $NGINX_CLOUDFLARE_REALIP_SNIPPET;',
    ssl_extra: 'include /etc/letsencrypt/options-ssl-nginx.conf;',
    admin_rules: 'allow all;',
    ping_block: pingArg ? ping(pingArg) : '',
  };
  ok('vhost fragments located (ping function, probe-hub + www server strings, ping_block arg)',
    pingFn.length > 0 && probeHub.length > 0 && wwwHttps.length > 0 && !!pingArg,
    JSON.stringify([pingFn.length, probeHub.length, wwwHttps.length, pingArg]));

  const expand = (text) => {
    let t = callPing(text)
      .replace(/\$\{www_https_block\}/g, () => wwwHttps)
      .replace(/\$\{probe_hub_block\}/g, () => probeHub);
    const unknown = [];
    t = t.replace(/^[ \t]*\$\{?([A-Za-z_]+)\}?[ \t]*$/gm, (line, name) => {
      if (Object.prototype.hasOwnProperty.call(FRAGMENTS, name)) return FRAGMENTS[name];
      unknown.push(name); return '';
    });
    return { text: t.replace(/\\\$/g, '$').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '$$$1'), unknown };
  };
  // Block parser: quotes respected, `#` comments dropped, statements split on `;`.
  const parseBlocks = (text) => {
    const blocks = []; const stack = [{ head: '(top)', stmts: [] }];
    let cur = '', q = null, bad = false;
    const flush = () => { const s = cur.trim().replace(/\s+/g, ' '); if (s) stack[stack.length - 1].stmts.push(s); cur = ''; };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '#') { while (i + 1 < text.length && text[i + 1] !== '\n') i++; continue; }
      if (c === '{') {
        const b = { head: cur.trim().replace(/\s+/g, ' '), stmts: [], parent: stack[stack.length - 1] };
        cur = ''; stack.push(b); blocks.push(b); continue;
      }
      if (c === ';') { flush(); continue; }
      if (c === '}') { flush(); if (stack.length === 1) bad = true; else stack.pop(); continue; }
      cur += c;
    }
    return { blocks, balanced: !bad && !q && stack.length === 1 && !cur.trim() };
  };

  const heredocs = [...vhostSrc.matchAll(/cat > "\$POOL_NGINX_CONF" << EOF\n([\s\S]*?)\nEOF\n/g)].map((m) => m[1]);
  ok('both vhost heredocs located (HTTP bootstrap + the SSL vhost)', heredocs.length === 2, `found ${heredocs.length}`);
  const all = []; let sslBlocks = [];
  heredocs.forEach((h, n) => {
    const { text, unknown } = expand(h);
    ok(`heredoc #${n + 1}: no unknown bare $fragment line`, unknown.length === 0, unknown.join(','));
    const { blocks, balanced } = parseBlocks(text);
    ok(`heredoc #${n + 1}: braces balance after expansion`, balanced);
    all.push(...blocks);
    if (n === 1) sslBlocks = blocks;
  });
  const hasAdd = (b) => b.stmts.some((s) => /^add_header\b/.test(s));
  const hasSnip = (b) => b.stmts.some((s) => SNIPPET_INCLUDE.test(s));
  const withAdd = all.filter(hasAdd);
  const servers443 = all.filter((b) => b.head === 'server' && b.stmts.some((s) => /^listen 443\b/.test(s)));
  // Floors (non-vacuity): today 33 blocks over both heredocs; 6 with an add_header (/admin/,
  // /uploads/, /custom/, /, and @pool_ping in the main AND the probe-hub server); 3 :443 servers
  // (main, www→apex, probe hub — the last two are optional on a box, always present in the text).
  ok('non-vacuity: ≥ 28 blocks parsed', all.length >= 28, String(all.length));
  ok('non-vacuity: ≥ 6 blocks declare an add_header', withAdd.length >= 6, String(withAdd.length));
  ok('non-vacuity: 3 :443 server blocks (main, www→apex, probe hub)', servers443.length === 3, String(servers443.length));
  const missing = withAdd.filter((b) => !hasSnip(b)).map((b) => b.head);
  ok('every block with its own add_header re-includes $hdr_common / $hdr_page / $hdr_admin', missing.length === 0,
    JSON.stringify(missing));
  const bareServer = servers443.filter((b) => !hasSnip(b)).map((b) => b.stmts.find((s) => /^server_name\b/.test(s)));
  ok('every :443 server includes a header snippet at server level (a server inherits nothing — §J16-9)',
    bareServer.length === 0, JSON.stringify(bareServer));
  // The two public HTML surfaces must carry a PAGE-class policy, never the bare common set.
  // …of the MAIN server (server_name $subdomain) — the probe-hub server has its own `location /`.
  const mainServer = sslBlocks.find((b) => b.head === 'server' && b.stmts.includes('server_name $subdomain'));
  const block = (head) => sslBlocks.find((b) => b.head === head && b.parent === mainServer) || { stmts: [] };
  ok('location / includes $hdr_page', block('location /').stmts.includes('include $hdr_page'));
  ok('location /admin/ includes $hdr_admin', block('location /admin/').stmts.includes('include $hdr_admin'));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
