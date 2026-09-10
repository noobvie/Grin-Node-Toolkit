'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Node Reachability Checker — the pure half of POST /api/node-check
//
// Everything here is arithmetic on strings: parse what the visitor typed, and
// decide whether a RESOLVED address is one we are willing to dial. No sockets,
// no DNS, no config — so it is unit-testable without the server, exactly like
// lib/payment-proof.js.
//
// THE RISK THIS FILE EXISTS FOR IS SSRF, NOT PORT SCANNING. The dangerous
// request is not "some port on the internet", it is "127.0.0.1:3413" or
// "192.168.1.1" — this server sits ON the operator's box, inside the operator's
// LAN, and it is the one party that can reach both. So:
//
//   • The CALLER MUST RESOLVE DNS FIRST and pass every resolved address through
//     blockedReason() — checking the hostname string is worthless, because
//     `evil.example.com IN A 127.0.0.1` is a legal DNS record and needs no
//     rebinding trick at all.
//   • The caller must then CONNECT TO THE ADDRESS IT CHECKED, not to the name.
//     Re-resolving at connect time is the rebinding hole: a TTL-0 record can
//     answer public on the first lookup and loopback on the second.
//
// The block list covers more than the four ranges the design doc names
// (loopback / RFC1918 / 169.254 / 100.64). The extra ranges — multicast,
// reserved, documentation, 6to4, NAT64 — cost one array row each and close the
// encodings that reach the same places by another spelling. The IPv4-mapped
// IPv6 form (::ffff:127.0.0.1) is the one that actually bites: it is a v6
// address by every string test and a loopback packet on the wire.
// ─────────────────────────────────────────────────────────────────────────────

const net = require('net');

const DEFAULT_PORT = 3413;          // grin node API (mainnet). Testnet is 13413.
const RPC_PATH     = '/v2/foreign'; // POST-only JSON-RPC — a GET here proves nothing.

class NodeCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NodeCheckError';
    this.code = code;
  }
}

// ── Target parsing ───────────────────────────────────────────────────────────

const HOSTNAME_RE = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

// Accepts: host · host:port · [v6]:port · v6 · http(s)://host[:port] and an
// explicit /v2/foreign tail (people paste the endpoint they were given). Any
// other path is rejected rather than silently ignored — this tool always POSTs
// to /v2/foreign, and quietly dropping the path someone typed would be a lie
// about what was checked.
function parseTarget(raw) {
  if (typeof raw !== 'string') throw new NodeCheckError('bad_input', 'No host given.');
  let s = raw.trim();
  if (!s) throw new NodeCheckError('bad_input', 'Enter a host to check.');
  if (s.length > 300) throw new NodeCheckError('bad_input', 'That is too long to be a host.');
  if (/\s/.test(s)) throw new NodeCheckError('bad_input', 'A host cannot contain spaces.');

  let scheme = null;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(s);
  if (m) {
    scheme = m[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw new NodeCheckError('bad_input', 'Only http:// and https:// can be checked.');
    }
    s = s.slice(m[0].length);
  }
  if (s.includes('@')) throw new NodeCheckError('bad_input', 'Remove the credentials from that URL.');

  const cut = s.search(/[/?#]/);
  if (cut !== -1) {
    const tail = s.slice(cut).replace(/\/+$/, '');
    if (tail !== '' && tail.toLowerCase() !== RPC_PATH) {
      throw new NodeCheckError('bad_input',
        'Enter a host and optional port — the ' + RPC_PATH + ' path is added for you.');
    }
    s = s.slice(0, cut);
  }
  if (!s) throw new NodeCheckError('bad_input', 'Enter a host to check.');

  let host, portStr = '';
  if (s.startsWith('[')) {                       // [2001:db8::1]:3413
    const close = s.indexOf(']');
    if (close === -1) throw new NodeCheckError('bad_input', 'That IPv6 address is missing its "]".');
    host = s.slice(1, close);
    const rest = s.slice(close + 1);
    if (rest) {
      if (rest[0] !== ':') throw new NodeCheckError('bad_input', 'Expected ":port" after "]".');
      portStr = rest.slice(1);
    }
    if (!net.isIPv6(host)) throw new NodeCheckError('bad_input', 'That is not a valid IPv6 address.');
  } else if (net.isIPv6(s)) {                    // bare ::1 / fe80::1 — no port possible
    host = s;
  } else {
    const i = s.lastIndexOf(':');
    if (i !== -1) { host = s.slice(0, i); portStr = s.slice(i + 1); }
    else          { host = s; }
    if (!net.isIP(host)) {
      const bare = host.replace(/\.$/, '');      // a trailing root dot is legal
      if (!HOSTNAME_RE.test(bare)) throw new NodeCheckError('bad_input', 'That is not a valid host name.');
      host = bare.toLowerCase();
    }
  }

  let port;
  // TRUE only when the visitor gave NEITHER a scheme NOR a port, i.e. every part
  // of the endpoint below the host name was assumed by us. It is not a parsing
  // detail — it is the difference between "your node did not answer" and "the
  // port WE picked did not answer", and the caller needs it to say which.
  // A bare host lands on 3413, but the toolkit's own Script 04 publishes a node
  // through nginx on 443 (`https://api.grin.money/v2/foreign`), so the single
  // commonest wrong verdict this tool can give is a correct answer about a port
  // the operator never uses.
  let assumed = false;
  if (portStr !== '') {
    if (!/^[0-9]{1,5}$/.test(portStr)) throw new NodeCheckError('bad_input', 'That port is not a number.');
    port = Number(portStr);
    if (port < 1 || port > 65535) throw new NodeCheckError('bad_input', 'That port is out of range.');
  } else {
    // A scheme with no port means what it means in a URL. Otherwise the grin
    // node default — this tool's whole subject.
    port = scheme === 'https' ? 443 : scheme === 'http' ? 80 : DEFAULT_PORT;
    assumed = !scheme;
  }
  if (!scheme) scheme = port === 443 ? 'https' : 'http';

  return { scheme, host, port, path: RPC_PATH, assumed, display: displayTarget(scheme, host, port) };
}

function displayTarget(scheme, host, port) {
  const h = net.isIPv6(host) ? '[' + host + ']' : host;
  return scheme + '://' + h + ':' + port + RPC_PATH;
}

// ── Address blocklist ────────────────────────────────────────────────────────

// [network, prefix bits, what it is]. The scan is linear and 14 rows deep, so
// row order is cosmetic; the four the design doc names come first.
const V4_BLOCKS = [
  ['127.0.0.0',    8,  'loopback'],
  ['10.0.0.0',     8,  'private (RFC1918)'],
  ['172.16.0.0',   12, 'private (RFC1918)'],
  ['192.168.0.0',  16, 'private (RFC1918)'],
  ['169.254.0.0',  16, 'link-local'],
  ['100.64.0.0',   10, 'carrier-grade NAT'],
  ['0.0.0.0',      8,  'this network'],
  ['192.0.0.0',    24, 'IETF protocol assignments'],
  ['192.0.2.0',    24, 'documentation'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0',  24, 'documentation'],
  ['198.18.0.0',   15, 'benchmarking'],
  ['224.0.0.0',    4,  'multicast'],
  ['240.0.0.0',    4,  'reserved'],            // includes 255.255.255.255
];

function v4ToInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    const b = Number(part);
    if (b > 255) return null;
    n = (n * 256) + b;
  }
  return n;
}

function v4Blocked(ip) {
  const n = v4ToInt(ip);
  if (n === null) return 'unparseable';
  for (const [netAddr, bits, label] of V4_BLOCKS) {
    const base = v4ToInt(netAddr);
    const mask = bits === 0 ? 0 : (0xffffffff - (Math.pow(2, 32 - bits) - 1));
    // >>> 0 keeps the comparison unsigned; a plain & sign-flips 224/4 and 240/4.
    if (((n & mask) >>> 0) === ((base & mask) >>> 0)) return label;
  }
  return null;
}

// Expand any legal IPv6 text form to 16 bytes. Lenient by design — callers
// validate with net.isIPv6 first; this only has to agree with it, not police it.
function v6Bytes(str) {
  let s = String(str).split('%')[0];             // drop any zone id
  if (s.includes('.')) {                         // ::ffff:127.0.0.1 → ::ffff:7f00:1
    const colon = s.lastIndexOf(':');
    const n = v4ToInt(s.slice(colon + 1));
    if (n === null) return null;
    s = s.slice(0, colon + 1)
      + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || head.length + tail.length + fill !== 8) return null;
  const groups = head.concat(new Array(fill).fill('0'), tail);
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const g = parseInt(groups[i], 16);
    out[i * 2]     = (g >> 8) & 0xff;
    out[i * 2 + 1] = g & 0xff;
  }
  return out;
}

function bytesAreZero(b, from, to) {
  for (let i = from; i < to; i++) if (b[i] !== 0) return false;
  return true;
}

function v4FromBytes(b, off) {
  return b[off] + '.' + b[off + 1] + '.' + b[off + 2] + '.' + b[off + 3];
}

function v6Blocked(ip) {
  const b = v6Bytes(ip);
  if (!b) return 'unparseable';

  // ::ffff:0:0/96 — an IPv4 address wearing a v6 costume. Checked FIRST, and
  // against the v4 table: ::ffff:127.0.0.1 is a loopback packet on the wire.
  if (bytesAreZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) {
    return v4Blocked(v4FromBytes(b, 12));
  }
  // 64:ff9b::/96 NAT64 — a v4 destination behind a translator.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && bytesAreZero(b, 4, 12)) {
    return v4Blocked(v4FromBytes(b, 12)) || 'NAT64-embedded';
  }
  // The deprecated ::a.b.c.d IPv4-compatible form (::1 and :: fall through it).
  if (bytesAreZero(b, 0, 12) && !bytesAreZero(b, 12, 15)) {
    return v4Blocked(v4FromBytes(b, 12)) || 'IPv4-compatible';
  }
  // 2002::/16 6to4 carries its v4 in bytes 2..5.
  if (b[0] === 0x20 && b[1] === 0x02) {
    return v4Blocked(v4FromBytes(b, 2));
  }

  if (bytesAreZero(b, 0, 15) && b[15] === 1)   return 'loopback';
  if (bytesAreZero(b, 0, 16))                  return 'unspecified';
  if ((b[0] & 0xfe) === 0xfc)                  return 'unique local (fc00::/7)';
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'link-local';
  if (b[0] === 0xff)                           return 'multicast';
  return null;
}

// The gate. Give it a RESOLVED address; a non-null return is the reason to
// refuse, already worded for the visitor. An address this cannot parse is
// refused too — "I could not tell what this is" must never mean "dial it".
function blockedReason(addr) {
  if (typeof addr !== 'string' || !addr) return 'unparseable';
  if (net.isIPv4(addr)) return v4Blocked(addr);
  if (net.isIPv6(addr)) return v6Blocked(addr);
  return 'unparseable';
}

// ── Reading the answer ───────────────────────────────────────────────────────

// Same convention as the server's own helper: the node serialises Rust
// Result<T,E> as {"Ok":T} / {"Err":E}, so the payload is one level down.
function unwrapResult(result) {
  if (result && typeof result === 'object') {
    if ('Ok'  in result) return result.Ok;
    if ('Err' in result) throw new NodeCheckError('node_error', JSON.stringify(result.Err));
  }
  return result;
}

// An HTTP 200 proves NOTHING — a parked domain, a CDN error page and a router
// login form all answer 200. Only an unwrapped {"Ok":{height:…}} proves a grin
// node is listening, so every other shape lands in one explicit failure code.
function readTip(bodyText) {
  let data;
  try { data = JSON.parse(bodyText); }
  catch { throw new NodeCheckError('not_json_rpc', 'The answer was not JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new NodeCheckError('not_json_rpc', 'The answer was not a JSON-RPC response.');
  }
  if (data.error) throw new NodeCheckError('node_error', JSON.stringify(data.error));
  if (!('result' in data)) throw new NodeCheckError('not_json_rpc', 'The answer carried no JSON-RPC result.');

  const tip = unwrapResult(data.result);        // throws node_error on {"Err":…}
  const height = (tip && typeof tip === 'object') ? tip.height : undefined;
  if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) {
    throw new NodeCheckError('not_json_rpc', 'The answer had no tip height in it.');
  }
  return {
    height,
    last_block_pushed: (tip && typeof tip.last_block_pushed === 'string') ? tip.last_block_pushed : null,
  };
}

// get_version is best-effort garnish, never the verdict: an older node, or a
// proxy that forwards only some methods, still counts as reachable.
function readVersion(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    if (!data || data.error) return null;
    const v = unwrapResult(data.result);
    return (v && typeof v.node_version === 'string') ? v.node_version : null;
  } catch { return null; }
}

module.exports = {
  DEFAULT_PORT, RPC_PATH,
  NodeCheckError,
  parseTarget, blockedReason, readTip, readVersion, unwrapResult,
  _internals: { v4Blocked, v6Blocked, v6Bytes },
};
