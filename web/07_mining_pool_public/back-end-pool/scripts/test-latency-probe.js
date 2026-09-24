'use strict';

// Latency probe targets — lib/latency-probe.js (published on /api/public/branding →
// connection.latency) and its agreement with the nginx side in 07_grin_mining_public_pool.sh.
// Covers: probe_domain defaults to the pool's own subdomain and is never derived wider (the
// public-suffix trap), and an operator override is honoured only as a parent of it; hub_url
// accepts only https://<host under the probe domain>/ping; behind a CDN proxy with no usable
// latency_hub_url the hub is NOT probed (the quoted-"false" trap included); the branding
// route publishes it; and the shell writes the matching CSP and a /ping that nginx really
// rate-limits (a named location, never a bare 'return' that runs before limit_req).
// index.js starts a server on require, so the route is read as text (as in test-regions.js).
// Run: node scripts/test-latency-probe.js   (no DB, no server, nothing left running)

const fs = require('fs');
const path = require('path');
const APP = path.resolve(__dirname, '..');
const SH = path.resolve(APP, '../../../scripts/07_grin_mining_public_pool.sh');

const lp = require(path.join(APP, 'lib/latency-probe.js'));
const indexSrc = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('\n[a] probe_domain: the pool\'s own subdomain by default\n');
ok('a. apex subdomain → itself', lp.probeDomain({ subdomain: 'grinium.com' }) === 'grinium.com');
ok('a. case and a trailing dot are normalised', lp.probeDomain({ subdomain: 'Grinium.COM.' }) === 'grinium.com');
ok('a. a true subdomain → itself, not its parent', lp.probeDomain({ subdomain: 'pool.example.com' }) === 'pool.example.com');
ok('a. no subdomain → null', lp.probeDomain({}) === null && lp.probeDomain({ subdomain: '' }) === null);
ok('a. not a hostname → null', lp.probeDomain({ subdomain: 'pool example.com' }) === null
  && lp.probeDomain({ subdomain: 'localhost' }) === null);

console.log('\n[b] never derived wider than the pool\'s own domain (public-suffix trap)\n');
ok('b. pool.example.co.uk is NOT widened to co.uk', lp.probeDomain({ subdomain: 'pool.example.co.uk' }) === 'pool.example.co.uk');
ok('b. mypool.duckdns.org is NOT widened to duckdns.org', lp.probeDomain({ subdomain: 'mypool.duckdns.org' }) === 'mypool.duckdns.org');
ok('b. override to a parent the operator declared is honoured',
  lp.probeDomain({ subdomain: 'pool.example.com', latency_probe_domain: 'example.com' }) === 'example.com');
ok('b. override equal to the subdomain is honoured',
  lp.probeDomain({ subdomain: 'grinium.com', latency_probe_domain: 'grinium.com' }) === 'grinium.com');
ok('b. override that is NOT a parent is ignored',
  lp.probeDomain({ subdomain: 'pool.example.com', latency_probe_domain: 'attacker.net' }) === 'pool.example.com');
ok('b. a suffix that is not a label boundary is ignored (ample.com vs example.com)',
  lp.probeDomain({ subdomain: 'pool.example.com', latency_probe_domain: 'ample.com' }) === 'pool.example.com');
ok('b. a bare TLD override is ignored',
  lp.probeDomain({ subdomain: 'pool.example.com', latency_probe_domain: 'com' }) === 'pool.example.com');
ok('b. a CHILD of the subdomain is not a parent → ignored',
  lp.probeDomain({ subdomain: 'example.com', latency_probe_domain: 'gw.example.com' }) === 'example.com');

console.log('\n[c] hub host: https://<host under the probe domain>/ping only\n');
const base = { subdomain: 'grinium.com' };
ok('c. https://cqf.grinium.com/ping → cqf.grinium.com', lp.hubHost({ ...base, latency_hub_url: 'https://cqf.grinium.com/ping' }) === 'cqf.grinium.com');
ok('c. https://host (no path) and https://host/ accepted', lp.hubHost({ ...base, latency_hub_url: 'https://cqf.grinium.com' }) === 'cqf.grinium.com'
  && lp.hubHost({ ...base, latency_hub_url: 'https://cqf.grinium.com/' }) === 'cqf.grinium.com');
ok('c. case normalised', lp.hubHost({ ...base, latency_hub_url: 'HTTPS://CQF.Grinium.com/PING' }) === 'cqf.grinium.com');
ok('c. http:// refused (mixed content from an HTTPS page)', lp.hubHost({ ...base, latency_hub_url: 'http://cqf.grinium.com/ping' }) === null);
ok('c. an explicit port refused (the CSP source carries none, so only 443 matches)',
  lp.hubHost({ ...base, latency_hub_url: 'https://cqf.grinium.com:8443/ping' }) === null);
ok('c. another path refused (nginx serves /ping only)', lp.hubHost({ ...base, latency_hub_url: 'https://cqf.grinium.com/health' }) === null);
ok('c. a host outside the probe domain refused (the CSP would block it)',
  lp.hubHost({ ...base, latency_hub_url: 'https://hub.other.net/ping' }) === null);
ok('c. a look-alike suffix refused (evilgrinium.com)', lp.hubHost({ ...base, latency_hub_url: 'https://evilgrinium.com/ping' }) === null);
ok('c. the site\'s own name refused (the default /ping covers it)', lp.hubHost({ ...base, latency_hub_url: 'https://grinium.com/ping' }) === null);
ok('c. the www alias refused (it only redirects)', lp.hubHost({ ...base, latency_hub_url: 'https://www.grinium.com/ping' }) === null);
ok('c. credentials / query / fragment refused', lp.hubHost({ ...base, latency_hub_url: 'https://a@cqf.grinium.com/ping' }) === null
  && lp.hubHost({ ...base, latency_hub_url: 'https://cqf.grinium.com/ping?x=1' }) === null
  && lp.hubHost({ ...base, latency_hub_url: 'https://cqf.grinium.com/ping#x' }) === null);
ok('c. with a parent override, a sibling of the subdomain is allowed',
  lp.hubHost({ subdomain: 'pool.example.com', latency_probe_domain: 'example.com', latency_hub_url: 'https://gra.example.com/ping' }) === 'gra.example.com');
ok('c. without it, the same sibling is refused',
  lp.hubHost({ subdomain: 'pool.example.com', latency_hub_url: 'https://gra.example.com/ping' }) === null);

console.log('\n[d] hub_url: same-origin, a DNS-only name, or NOT probed behind a CDN\n');
const lc = (c) => lp.latencyConfig(c);
ok('d. no CDN, no key → same-origin /ping', lc({ ...base, cloudflare_proxy: 'false' }).hub_url === '/ping');
ok('d. no cloudflare_proxy key at all → same-origin /ping', lc(base).hub_url === '/ping');
ok('d. CDN ("true" string, as the installer writes it), no key → null', lc({ ...base, cloudflare_proxy: 'true' }).hub_url === null);
ok('d. CDN as a real boolean true → null', lc({ ...base, cloudflare_proxy: true }).hub_url === null);
ok('d. quoted "false" is NOT read as truthy (config loader trap)', lc({ ...base, cloudflare_proxy: 'false' }).hub_url === '/ping');
ok('d. CDN + a usable latency_hub_url → that URL, normalised to /ping',
  lc({ ...base, cloudflare_proxy: 'true', latency_hub_url: 'https://cqf.grinium.com' }).hub_url === 'https://cqf.grinium.com/ping');
ok('d. CDN + an unusable latency_hub_url → still null, never the edge',
  lc({ ...base, cloudflare_proxy: 'true', latency_hub_url: 'https://grinium.com/ping' }).hub_url === null);
{
  const r = lc({ ...base, cloudflare_proxy: 'true', latency_hub_url: 'https://cqf.grinium.com/ping' });
  ok('d. exactly { probe_domain, hub_url, direct_bias_ms }',
    JSON.stringify(Object.keys(r).sort()) === '["direct_bias_ms","hub_url","probe_domain"]'
    && r.probe_domain === 'grinium.com');
  ok('d. direct_bias_ms is the suggestion\'s own bias (one number, not a second literal)',
    r.direct_bias_ms === require(path.join(APP, 'lib/connect-suggest.js')).DEFAULT_DIRECT_BIAS_MS
    && /require\('\.\/connect-suggest'\)/.test(fs.readFileSync(path.join(APP, 'lib/latency-probe.js'), 'utf8')));
}
ok('d. no subdomain → probe_domain null (no gateway is probed)', lc({ cloudflare_proxy: 'false' }).probe_domain === null);

console.log('\n[e] the branding route publishes it\n');
{
  const rs = indexSrc.indexOf("app.get('/api/public/branding'");
  const route = rs >= 0 ? indexSrc.slice(rs, rs + 6000) : '';
  ok('e. branding route found', rs >= 0);
  ok('e. connection.latency = latencyConfig(config)', /latency:\s*latencyConfig\(config\)/.test(route));
  ok('e. latencyConfig is the lib\'s, not a local copy',
    /require\('\.\/lib\/latency-probe'\)/.test(indexSrc) && !/function latencyConfig/.test(indexSrc));
  const meta = indexSrc.split('\n').find((l) => l.trimStart().startsWith("'GET /api/public/branding':")) || '';
  ok('e. API_DOC_META documents connection.latency, probe_domain, hub_url, direct_bias_ms and the CDN null',
    /connection\.latency/.test(meta) && /probe_domain/.test(meta) && /hub_url/.test(meta) && /CDN/.test(meta)
    && /direct_bias_ms/.test(meta));
}

console.log('\n[f] the shell writes the matching nginx side\n');
if (!fs.existsSync(SH)) {
  console.log(`  SKIP  f. ${SH} not present (a deployed app dir has no scripts/) — run from the repo`);
} else {
  const sh = fs.readFileSync(SH, 'utf8');
  const reLine = (sh.match(/^_POOL_HOST_RE='([^']+)'/m) || [])[1];
  ok('f. the shell hostname regex is the lib\'s, character for character',
    reLine === lp.HOST_RE.source, `shell=${reLine} js=${lp.HOST_RE.source}`);
  ok('f. the page CSP connect-src carries the probe wildcard', /connect-src 'self'\$\{probe_csp\}/.test(sh));
  ok('f. probe_csp is https://*.<probe domain> and nothing when there is none',
    /probe_csp=" https:\/\/\*\.\$\{probe_domain\}"/.test(sh) && /local probe_domain probe_hub_host probe_csp=""/.test(sh));
  ok('f. the admin CSP is still connect-src \'self\' only',
    /connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';" always;\s*\r?\nHDREOF\s*\r?\n\s*\r?\n\s*info "Writing nginx vhost/.test(sh));
  const bs = sh.indexOf('_pool_nginx_ping_block() {');
  const block = bs >= 0 ? sh.slice(bs, sh.indexOf('\n}', bs)) : '';
  const exact = (block.match(/location = \/ping \{[\s\S]*?\n\s*\}/) || [''])[0];
  const named = (block.match(/location @pool_ping \{[\s\S]*?\n\s*\}/) || [''])[0];
  ok('f. = /ping is rate-limited with an EXISTING zone (_static)', /limit_req zone=\$\{POOL_SERVICE\}_static/.test(exact));
  ok('f. = /ping allows GET (and so HEAD) only', /limit_except GET \{ deny all; \}/.test(exact));
  ok('f. = /ping does NOT answer with a bare return (it would run before limit_req)', !/\breturn\b/.test(exact));
  ok('f. = /ping hands over via try_files to the named location', /try_files \S+ @pool_ping;/.test(exact));
  ok('f. = /ping adds no header of its own (its 403/429 inherit the server set)', !/add_header/.test(exact));
  ok('f. @pool_ping re-includes a header snippet because it adds headers', /include \$\{hdr\};/.test(named) && /add_header/.test(named));
  ok('f. @pool_ping: 204, no-store, CORS + Timing-Allow-Origin', /return 204;/.test(named) && /Cache-Control "no-store"/.test(named)
    && /Access-Control-Allow-Origin "\*"/.test(named) && /Timing-Allow-Origin "\*"/.test(named));
  ok('f. both /ping locations keep no access log', /access_log off;/.test(exact) && /access_log off;/.test(named));
  ok('f. the main vhost includes the ping block with the PAGE snippet', /ping_block=\$\(_pool_nginx_ping_block "\$hdr_page"\)/.test(sh)
    && /\$\{ping_block\}/.test(sh));
  ok('f. the latency_hub_url block exists only once its cert does (Let\'s Encrypt bootstrap rule)',
    /if \[\[ -f "\/etc\/letsencrypt\/live\/\$probe_hub_host\/fullchain\.pem" \]\]; then\s*\r?\n\s*probe_hub_block=/.test(sh));
}

console.log(fail ? `\nFAILED — ${pass} passed, ${fail} failed` : `\nALL PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
