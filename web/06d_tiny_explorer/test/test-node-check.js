// Node-checker regression tests — the SSRF blocklist and parseTarget.
//
// WHY THIS FILE EXISTS. Both tables were run exactly once, in a throwaway
// harness (the first pass on 2026-09-05, re-confirmed by R5), and the numbers
// "23/23" and "14/14" then lived only in the tools-hub review plan, which is
// session scaffolding kept outside the repo. blockedReason() is the ONLY
// thing standing between a visitor-supplied host name and this server dialling
// its own network, and parseTarget() is what stops a pasted URL being dialled as
// something other than what it says. A regression in either would be silent.
//
// Every address here is asserted with the REASON, not just blocked/allowed — a
// v4-mapped loopback that got blocked as "multicast" would still pass a
// truthiness test while proving the wrong branch ran.
//
// Run: node test/test-node-check.js
'use strict';

const assert = require('node:assert');
const path   = require('node:path');

const APP = path.resolve(__dirname, '..');
const nc  = require(path.join(APP, 'lib/node-check.js'));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
};

// ═══ 1. blockedReason() — R5's 23 addresses, plus boundary rows ══════════════
//
// [address, expected reason | null, what it is]. `null` = must be dialled.
// The four disguised-loopback forms are the point of the table: each reaches the
// v4 rules through a DIFFERENT branch of v6Blocked (mapped, compatible, 6to4,
// NAT64), so one of them passing tells you nothing about the other three.
const ADDRESSES = [
  // — plain v4 —
  ['127.0.0.1',                 'loopback',                  'v4 loopback'],
  ['127.255.255.254',           'loopback',                  'v4 loopback, top of /8'],
  ['10.1.2.3',                  'private (RFC1918)',         'RFC1918 /8'],
  ['172.16.0.1',                'private (RFC1918)',         'RFC1918 /12, bottom'],
  ['172.31.255.255',            'private (RFC1918)',         'RFC1918 /12, top'],
  ['192.168.1.1',               'private (RFC1918)',         'RFC1918 /16'],
  ['169.254.169.254',           'link-local',                'the cloud metadata address'],
  ['100.64.0.1',                'carrier-grade NAT',         'CGNAT'],
  ['0.0.0.0',                   'this network',              '"this network"'],
  ['192.0.2.5',                 'documentation',             'TEST-NET-1'],
  ['198.18.0.1',                'benchmarking',              'benchmarking /15'],
  ['224.0.0.1',                 'multicast',                 'v4 multicast'],
  ['255.255.255.255',           'reserved',                  'broadcast (inside 240/4)'],
  // — v4 wearing a v6 costume: four different branches, same destination —
  ['::ffff:127.0.0.1',          'loopback',                  'v4-MAPPED loopback'],
  ['0:0:0:0:0:ffff:192.168.1.1', 'private (RFC1918)',        'v4-mapped RFC1918, long form'],
  ['::127.0.0.1',               'loopback',                  'v4-COMPATIBLE loopback (deprecated)'],
  ['2002:7f00:1::',             'loopback',                  '6to4 wrapping 127.0.0.1'],
  ['64:ff9b::127.0.0.1',        'loopback',                  'NAT64 wrapping 127.0.0.1'],
  // — native v6 —
  ['::1',                       'loopback',                  'v6 loopback'],
  ['::',                        'unspecified',               'v6 unspecified'],
  ['fd00::1',                   'unique local (fc00::/7)',   'v6 ULA'],
  ['fe80::1',                   'link-local',                'v6 link-local'],
  ['ff02::1',                   'multicast',                 'v6 multicast'],
  // — must be ALLOWED: over-blocking breaks the tool for real public nodes —
  ['8.8.8.8',                   null,                        'public v4'],
  ['172.32.0.1',                null,                        'just ABOVE the RFC1918 /12'],
  ['172.15.255.255',            null,                        'just BELOW the RFC1918 /12'],
  ['100.128.0.1',               null,                        'just above the CGNAT /10'],
  ['2001:4860:4860::8888',      null,                        'public v6'],
  ['::ffff:8.8.8.8',            null,                        'v4-mapped PUBLIC address'],
];

console.log('\n[1] lib/node-check.js — blockedReason() over ' + ADDRESSES.length
  + ' addresses (R5 ran 23; the extra rows are the /12 and /10 edges either side)');
for (const [addr, want, what] of ADDRESSES) {
  const verb = want === null ? 'allows' : 'blocks';
  ok(verb + ' ' + addr + '  (' + what + ')', () => {
    const got = nc.blockedReason(addr);
    assert.strictEqual(got, want,
      'expected ' + JSON.stringify(want) + ', got ' + JSON.stringify(got));
  });
}

ok('an address it cannot parse is REFUSED, never dialled', () => {
  for (const junk of ['', null, undefined, 'not-an-ip', '999.1.1.1', {}]) {
    assert.strictEqual(nc.blockedReason(junk), 'unparseable', String(junk));
  }
});

// ═══ 2. parseTarget() — R5's 14 inputs, plus the accepted forms ══════════════
//
// Accepted rows assert the WHOLE resolved tuple: a target that parsed but landed
// on the wrong port or scheme is a worse outcome than one that was rejected.
const ACCEPT = [
  ['node.example.com',                    'http',  'node.example.com', 3413],
  ['node.example.com:13413',              'http',  'node.example.com', 13413],
  ['https://node.example.com',            'https', 'node.example.com', 443],
  ['http://node.example.com:3413',        'http',  'node.example.com', 3413],
  ['https://node.example.com/v2/foreign', 'https', 'node.example.com', 443],
  ['  NODE.Example.COM.  ',               'http',  'node.example.com', 3413],
  ['[2001:db8::1]:3413',                  'http',  '2001:db8::1',      3413],
  ['2001:db8::1',                         'http',  '2001:db8::1',      3413],
  ['203.0.113.9:443',                     'https', '203.0.113.9',      443],
];

const REJECT = [
  ['user:pw@node.example.com',   'credentials in the URL'],
  ['http://x.com/evil',          'a path that is not /v2/foreign'],
  ['node example.com',           'a space'],
  ['node.example.com:0',         'port 0'],
  ['node.example.com:99999',     'port out of range'],
  ['ftp://node.example.com',     'a scheme that is not http(s)'],
  ['[2001:db8::1',               'an unclosed IPv6 bracket'],
  ['node.example.com:abc',       'a non-numeric port'],
  ['-bad-.example.com',          'a host name that is not one'],
  ['x'.repeat(301),              'longer than 300 characters'],
  ['',                           'empty'],
];

console.log('\n[2] lib/node-check.js — parseTarget() over ' + (ACCEPT.length + REJECT.length)
  + ' inputs (R5 ran 14)');

for (const [input, scheme, host, port] of ACCEPT) {
  ok('accepts ' + JSON.stringify(input) + ' -> ' + scheme + '://' + host + ':' + port, () => {
    const t = nc.parseTarget(input);
    assert.strictEqual(t.scheme, scheme);
    assert.strictEqual(t.host,   host);
    assert.strictEqual(t.port,   port);
    assert.strictEqual(t.path,   nc.RPC_PATH);
  });
}

for (const [input, why] of REJECT) {
  ok('rejects ' + JSON.stringify(input.length > 24 ? input.slice(0, 21) + '...' : input) + '  (' + why + ')', () => {
    assert.throws(() => nc.parseTarget(input), (e) => {
      assert.strictEqual(e.code, 'bad_input', 'wrong code: ' + e.code);
      assert.ok(e.message && e.message.length > 5, 'a refusal must carry a sentence');
      return true;
    });
  });
}

ok('a non-string target is rejected, not coerced', () => {
  for (const v of [null, undefined, 42, {}, ['node.example.com']]) {
    assert.throws(() => nc.parseTarget(v), (e) => e.code === 'bad_input');
  }
});

// ═══ 3. readTip() — an HTTP 200 proves nothing ═══════════════════════════════
console.log('\n[3] lib/node-check.js — readTip() unwraps Result<T,E>');

ok('a {"Ok":{height}} envelope yields the height', () => {
  const t = nc.readTip(JSON.stringify({
    jsonrpc: '2.0', id: 1, result: { Ok: { height: 3967196, last_block_pushed: 'ab'.repeat(32) } },
  }));
  assert.strictEqual(t.height, 3967196);
  assert.strictEqual(t.last_block_pushed, 'ab'.repeat(32));
});

ok('a {"Err":...} envelope is node_error, not a tip', () => {
  assert.throws(
    () => nc.readTip(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { Err: 'boom' } })),
    (e) => e.code === 'node_error');
});

ok('a parked page / CDN error page / bare 200 is not_json_rpc', () => {
  for (const body of ['<html>hello</html>', '{}', '[]', '{"result":{"Ok":{}}}', 'null']) {
    assert.throws(() => nc.readTip(body), (e) => e.code === 'not_json_rpc', body);
  }
});

module.exports = { report: () => ({ pass, fail }) };

if (require.main === module) {
  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
