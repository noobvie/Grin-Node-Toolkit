#!/usr/bin/env node
// CSP Report-Only twins (code-layout refactor F6, plan tool T6).
//
// Every PAGE policy ships a second header, Content-Security-Policy-Report-Only, that is the
// enforcing policy with exactly one token removed: 'unsafe-inline' from script-src. Browsers
// then log to the console whatever the strict policy WOULD block, and block nothing. Three
// page policies exist — Express (index.js), the nginx public page snippet, the nginx admin
// snippet — and each twin is a hand-written copy of a long line, so the thing that goes wrong
// is drift: a host added to one line and not the other turns the Report-Only run into a
// report about the wrong policy. This test derives the expected twin from the enforcing line
// and compares directive by directive.
//
// Also pinned: no report-uri / report-to (the console is the report — no new endpoint), the
// two /uploads/ + /custom/ sandbox CSPs are untouched and carry no twin, and the enforcing
// policies still allow inline script — the strict flip (F7) is a separate, reviewed commit
// that rewrites the last group of assertions.
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
// The one sanctioned difference: script-src without 'unsafe-inline'. Everything else identical.
function strictTwin(policy) {
  return directives(policy).map((d) =>
    (d[0] === 'script-src' ? d.filter((t) => t !== "'unsafe-inline'") : d));
}
const srcOf = (dirs, name) => (dirs.find((d) => d[0] === name) || []).slice(1);

function checkPair(label, enforcing, reportOnly) {
  ok(`${label}: enforcing policy found`, enforcing.length === 1, `found ${enforcing.length}`);
  ok(`${label}: exactly one Report-Only twin`, reportOnly.length === 1, `found ${reportOnly.length}`);
  if (enforcing.length !== 1 || reportOnly.length !== 1) return;
  const want = strictTwin(enforcing[0]);
  const got = directives(reportOnly[0]);
  ok(`${label}: twin == enforcing minus 'unsafe-inline' in script-src, directive by directive`,
    JSON.stringify(got) === JSON.stringify(want),
    `\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`);
  ok(`${label}: twin script-src has no 'unsafe-inline' (and no 'unsafe-eval')`,
    srcOf(got, 'script-src').length > 0 &&
    !srcOf(got, 'script-src').some((t) => t === "'unsafe-inline'" || t === "'unsafe-eval'"));
  ok(`${label}: twin style-src still allows inline style (out of scope — not part of the flip)`,
    srcOf(got, 'style-src').includes("'unsafe-inline'"));
  // Non-vacuity: the enforcing side really is the permissive one today.
  ok(`${label}: enforcing script-src still has 'unsafe-inline' (F7 flips it, not F6)`,
    srcOf(directives(enforcing[0]), 'script-src').includes("'unsafe-inline'"));
}

console.log('\n[1] Express (index.js) security-header middleware');
{
  const enf = [...indexSrc.matchAll(/res\.setHeader\('Content-Security-Policy', "([^"]+)"\)/g)].map((m) => m[1]);
  const ro = [...indexSrc.matchAll(/res\.setHeader\('Content-Security-Policy-Report-Only', "([^"]+)"\)/g)].map((m) => m[1]);
  checkPair('Express', enf, ro);
  // Both set in the SAME middleware, adjacent — a twin set somewhere else could run on a
  // different set of responses.
  const i = indexSrc.indexOf("res.setHeader('Content-Security-Policy',");
  const j = indexSrc.indexOf("res.setHeader('Content-Security-Policy-Report-Only',");
  ok('Express: the twin is set right after the enforcing header, in the same middleware',
    i > 0 && j > i && !/\n\s*next\(\);|\}\);/.test(indexSrc.slice(i, j)));
}

// The nginx snippets are heredocs in pool_setup_nginx; cut each one by its header comment.
const snippet = (re) => (vhostSrc.match(re) || [''])[0];
const nginxPolicies = (block, header) =>
  [...block.matchAll(new RegExp(`^add_header ${header} "([^"]+)" always;$`, 'gm'))].map((m) => m[1]);

console.log('\n[2] nginx public page snippet ($hdr_page)');
{
  const page = snippet(/# Common headers \+ the page CSP[\s\S]*?\nHDREOF/);
  ok('page snippet located', page.length > 0);
  checkPair('nginx page', nginxPolicies(page, 'Content-Security-Policy'),
    nginxPolicies(page, 'Content-Security-Policy-Report-Only'));
  // The ${probe_csp} expansion must be in BOTH, or the connect page's gateway pings would
  // report as violations that the enforcing policy allows.
  ok('nginx page: both lines carry the ${probe_csp} connect-src expansion',
    (page.match(/'self'\$\{probe_csp\}/g) || []).length === 2);
}

console.log('\n[3] nginx admin snippet ($hdr_admin)');
{
  const admin = snippet(/# Common headers \+ the ADMIN CSP[\s\S]*?\nHDREOF/);
  ok('admin snippet located', admin.length > 0);
  checkPair('nginx admin', nginxPolicies(admin, 'Content-Security-Policy'),
    nginxPolicies(admin, 'Content-Security-Policy-Report-Only'));
}

console.log('\n[4] scope — where the twin must NOT be');
{
  // Only the two snippets emit it. A location that set its own copy would be a third policy
  // to keep in sync, and nginx add_header inheritance is handled by the snippet includes.
  const roLines = vhostSrc.split('\n').filter((l) => /add_header Content-Security-Policy-Report-Only/.test(l));
  ok('vhost: exactly two Report-Only add_header lines (page + admin snippets)', roLines.length === 2,
    `found ${roLines.length}`);
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
  // Check the policy VALUES, not the files: the comments beside the twins say "no report-uri".
  const allPolicies = [
    ...[...indexSrc.matchAll(/res\.setHeader\('Content-Security-Policy(?:-Report-Only)?', "([^"]+)"\)/g)],
    ...[...vhostSrc.matchAll(/add_header Content-Security-Policy(?:-Report-Only)? "([^"]+)"/g)],
  ].map((m) => m[1]);
  ok('non-vacuity: every CSP value was read (2 Express + 4 snippet + 2 sandbox)', allPolicies.length === 8,
    `found ${allPolicies.length}`);
  ok('no policy carries report-uri / report-to (no new endpoint)',
    allPolicies.length > 0 && !allPolicies.some((p) => /report-uri|report-to/.test(p)));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
