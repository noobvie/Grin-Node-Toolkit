'use strict';

// Unit test for the gateway PROXY-protocol v2 parser (Model C, Phase 1).
// Verifies the central stratum-server recovers the real miner IP from the binary header
// HAProxy `send-proxy-v2` prepends, and that direct (non-proxied) miners are untouched.
// Run: node scripts/test-proxy-v2.js   (no DB / network needed — pure parser test)

const { parseProxyV2Header } = require('../lib/stratum-server');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else      { fail++; console.error(`  FAIL ${name}`); }
}

const SIG = Buffer.from([0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A]);

// Build a PROXY v2 TCP/IPv4 header for src ip:port → dst ip:port.
function ipv4Header(srcIp, srcPort, dstIp = '10.66.66.1', dstPort = 3391) {
  const addr = Buffer.alloc(12);
  srcIp.split('.').forEach((o, i) => { addr[i] = parseInt(o, 10); });
  dstIp.split('.').forEach((o, i) => { addr[4 + i] = parseInt(o, 10); });
  addr.writeUInt16BE(srcPort, 8);
  addr.writeUInt16BE(dstPort, 10);
  const fixed = Buffer.alloc(4);
  fixed[0] = 0x21;            // version 2 (0x2_) + PROXY command (0x_1)
  fixed[1] = 0x11;            // AF_INET (0x1_) + STREAM (0x_1)
  fixed.writeUInt16BE(addr.length, 2);
  return Buffer.concat([SIG, fixed, addr]);
}

// 1) Well-formed IPv4 header → real source IP recovered, whole header consumed.
{
  const h = ipv4Header('203.0.113.7', 50000);
  const r = parseProxyV2Header(h);
  check('IPv4 header parses', r.state === 'parsed');
  check('IPv4 source IP recovered', r.ip === '203.0.113.7');
  check('IPv4 header fully consumed (28 bytes)', r.consumed === h.length && h.length === 28);
}

// 2) Header followed by a stratum login line → only the header is consumed; the rest is the line.
{
  const login = '{"id":"1","jsonrpc":"2.0","method":"login","params":{"login":"grin1abc.rig1"}}\n';
  const buf = Buffer.concat([ipv4Header('198.51.100.9', 4444), Buffer.from(login)]);
  const r = parseProxyV2Header(buf);
  check('header+payload parses', r.state === 'parsed' && r.ip === '198.51.100.9');
  check('payload after header is the stratum line', buf.subarray(r.consumed).toString() === login);
}

// 3) Direct miner (stratum JSON, no header) → absent, nothing consumed.
{
  const r = parseProxyV2Header(Buffer.from('{"id":"1","method":"login"}\n'));
  check('direct stratum JSON → absent', r.state === 'absent');
}

// 4) Leading CRLF then JSON (lenient client) → still absent (mismatch at byte 2).
{
  const r = parseProxyV2Header(Buffer.from('\r\n{"id":"1"}\n'));
  check('CRLF-led JSON → absent', r.state === 'absent');
}

// 5) Fragmentation: only the first 8 signature bytes arrived → need-more (wait, do not reject).
{
  const r = parseProxyV2Header(SIG.subarray(0, 8));
  check('partial signature → need-more', r.state === 'need-more');
}

// 6) Full signature + version byte but address block not yet arrived → need-more.
{
  const partial = ipv4Header('1.2.3.4', 1234).subarray(0, 18); // 16 fixed + 2 of 12 addr bytes
  const r = parseProxyV2Header(partial);
  check('incomplete address block → need-more', r.state === 'need-more');
}

// 7) LOCAL command (health probe) → parsed, ip null (caller keeps socket addr).
{
  const fixed = Buffer.alloc(4);
  fixed[0] = 0x20;           // version 2 + LOCAL command
  fixed[1] = 0x00;           // AF_UNSPEC
  fixed.writeUInt16BE(0, 2); // no address block
  const r = parseProxyV2Header(Buffer.concat([SIG, fixed]));
  check('LOCAL command → parsed with null ip', r.state === 'parsed' && r.ip === null && r.consumed === 16);
}

// 8) IPv6 header → source IP recovered.
{
  const addr = Buffer.alloc(36);
  // src = 2001:db8::1
  addr.writeUInt16BE(0x2001, 0); addr.writeUInt16BE(0x0db8, 2); addr.writeUInt16BE(0x0001, 14);
  const fixed = Buffer.alloc(4);
  fixed[0] = 0x21; fixed[1] = 0x21; // PROXY + AF_INET6/STREAM
  fixed.writeUInt16BE(36, 2);
  const r = parseProxyV2Header(Buffer.concat([SIG, fixed, addr]));
  check('IPv6 header parses', r.state === 'parsed');
  check('IPv6 source IP recovered', r.ip === '2001:db8:0:0:0:0:0:1');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
