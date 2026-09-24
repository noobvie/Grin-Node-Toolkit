'use strict';

// Where the connect page may MEASURE latency from the visitor's browser. It is published on
// GET /api/public/branding → connection.latency, and the page keeps its estimate
// (lib/connect-suggest.js) for anything it cannot measure.
//
//   probe_domain  the domain whose subdomains the page may fetch https://<gateway>/ping from.
//                 The nginx page CSP carries connect-src https://*.<probe_domain>. A gateway
//                 host outside it would be blocked by that CSP, so the page must not try.
//   hub_url       where the page times THIS hub (the "direct" row), or null for "do not time
//                 it, keep the estimate".
//   direct_bias_ms  the estimate's own direct bias (lib/connect-suggest.js), so the page
//                 re-ranks its measurements by the same rule instead of a second literal. Here and
//                 not on /api/pool/connect/suggest: the page still measures when that route has
//                 no answer (no geo-IP), and it never measures without this object.
//
// ⚠ scripts/07_grin_mining_public_pool.sh applies the SAME two rules when it writes the CSP
// and the /ping server blocks (_pool_latency_probe_domain / _pool_latency_hub_host). The page
// must never be told to probe a host the CSP blocks, so change both or neither.
//
// Pure: no I/O. index.js starts a server on require, so the rules live here where
// scripts/test-latency-probe.js can run them.

const { DEFAULT_DIRECT_BIAS_MS } = require('./connect-suggest');

const HOST_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\.$/, '');

// Default: the pool's own subdomain, and never anything wider. Deriving a parent needs the
// Public Suffix List ("pool.example.co.uk" → "co.uk", "mypool.duckdns.org" → "duckdns.org"),
// and a CSP wildcard over a public suffix gives injected script a destination on any host
// under it. So widening is the operator's explicit latency_probe_domain, and only to a PARENT
// of the subdomain (or the subdomain itself). Anything else is ignored.
function probeDomain(config) {
  const sub = norm(config && config.subdomain);
  if (!HOST_RE.test(sub)) return null;
  const ovr = norm(config && config.latency_probe_domain);
  if (ovr && HOST_RE.test(ovr) && (sub === ovr || sub.endsWith('.' + ovr))) return ovr;
  return sub;
}

// The operator's latency_hub_url host, when it is usable: https://<host>/ping (or
// https://<host>), <host> under the probe domain, and not the site's own name or its www
// alias (the default same-origin /ping already covers those). Else null.
function hubHost(config) {
  const url = norm(config && config.latency_hub_url);
  const m = /^https:\/\/([a-z0-9.-]+)(\/ping)?\/?$/.exec(url);
  if (!m) return null;
  const host = m[1].replace(/\.$/, '');
  if (!HOST_RE.test(host)) return null;
  const sub = norm(config.subdomain);
  const dom = probeDomain(config);
  if (!dom || !host.endsWith('.' + dom)) return null;
  if (host === sub || host === 'www.' + sub) return null;
  return host;
}

// cloudflare_proxy is written by the installer as the STRING "true"/"false". A quoted
// "false" is truthy, so compare the value, never its truthiness.
const behindCdn = (config) => config != null && String(config.cloudflare_proxy) === 'true';

// Behind a CDN proxy the same-origin /ping is answered by the CDN's EDGE, a few ms from every
// visitor, so "direct" would win everywhere. With the proxy on and no usable latency_hub_url
// the answer is null.
function latencyConfig(config) {
  const host = hubHost(config);
  let hubUrl;
  if (host) hubUrl = `https://${host}/ping`;
  else if (behindCdn(config)) hubUrl = null;
  else hubUrl = '/ping';
  return { probe_domain: probeDomain(config), hub_url: hubUrl, direct_bias_ms: DEFAULT_DIRECT_BIAS_MS };
}

module.exports = { HOST_RE, probeDomain, hubHost, latencyConfig };
