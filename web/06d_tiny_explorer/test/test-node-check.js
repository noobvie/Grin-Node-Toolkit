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
const fs     = require('node:fs');
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
// The 5th column is `assumed` — true only when NEITHER a scheme nor a port was
// given, so the whole endpoint below the host was our choice. It drives the
// "check http://host:3413 instead" retry, and getting it wrong either hides the
// suggestion from the person who needs it or offers it to someone who typed an
// explicit port and does not.
//
// ⚠ An assumed row's scheme/port DEPENDS ON THE HOST TYPE since 2026-09-10 — a
// name lands on https/443, an address on http/3413. Section 8 owns that split
// in full; the two assumed rows here are the ones that would have gone stale
// silently, so they are spelled out rather than left to the table below.
const ACCEPT = [
  ['node.example.com',                    'https', 'node.example.com', 443,   true],
  ['node.example.com:13413',              'http',  'node.example.com', 13413, false],
  ['https://node.example.com',            'https', 'node.example.com', 443,   false],
  ['http://node.example.com:3413',        'http',  'node.example.com', 3413,  false],
  ['https://node.example.com/v2/foreign', 'https', 'node.example.com', 443,   false],
  ['  NODE.Example.COM.  ',               'https', 'node.example.com', 443,   true],
  ['[2001:db8::1]:3413',                  'http',  '2001:db8::1',      3413,  false],
  ['2001:db8::1',                         'http',  '2001:db8::1',      3413,  true],
  ['203.0.113.9:443',                     'https', '203.0.113.9',      443,   false],
  ['http://node.example.com',             'http',  'node.example.com', 80,    false],
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

for (const [input, scheme, host, port, assumed] of ACCEPT) {
  ok('accepts ' + JSON.stringify(input) + ' -> ' + scheme + '://' + host + ':' + port
     + (assumed ? '  (assumed)' : ''), () => {
    const t = nc.parseTarget(input);
    assert.strictEqual(t.scheme, scheme);
    assert.strictEqual(t.host,   host);
    assert.strictEqual(t.port,   port);
    assert.strictEqual(t.path,   nc.RPC_PATH);
    assert.strictEqual(t.assumed, assumed, 'assumed flag wrong for ' + input);
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

// ═══ 4. the retry suggestion is offered to NAMES only ════════════════════════
//
// `assumed` is true for a bare IP as much as for a bare host name, and the
// obvious reading of it — "we picked the port, so offer the other one" — sends
// anyone who typed an IP into a certificate failure: the route verifies certs
// and omits SNI for an IP literal, so https://203.0.113.9 answers `tls_error`
// no matter what is running there. A second dead end dressed as a fix is worse
// than no suggestion, because the visitor now has two verdicts to disbelieve.
//
// The gate lives in the route, not in this lib, so this asserts the CONTRACT
// against the server source rather than re-implementing it here — a copy of the
// expression would agree with itself for ever.
console.log('\n[4] tiny-explorer-server.js — the suggestion is gated on a host NAME');

const serverSrc = fs.readFileSync(path.join(APP, 'tiny-explorer-server.js'), 'utf8');

ok('the suggest gate excludes IP literals', () => {
  assert.match(serverSrc, /suggest:\s*\(target\.assumed\s*&&\s*!net\.isIP\(target\.host\)\)\s*\?/,
    'the `suggest` gate must be (target.assumed && !net.isIP(target.host))');
});

ok('parseTarget still marks a bare IP assumed — the gate is what excludes it', () => {
  // If this ever stops being true the gate above is dead code, and the next
  // person removes it as redundant.
  assert.strictEqual(nc.parseTarget('203.0.113.9').assumed, true);
  assert.strictEqual(nc.parseTarget('2001:db8::1').assumed, true);
  assert.strictEqual(nc.parseTarget('node.example.com').assumed, true);
});

// ═══ 5. p2pPortFor() — which port the second leg dials, and why ══════════════
//
// The P2P leg is the half that can be wrong QUIETLY. A wrong API port produces a
// visible dead end the operator recognises; a wrong P2P port produces a
// confident "filtered" about a port their node never opened. So the `source`
// field is asserted alongside the port on every row — the client words a
// DEFAULTED port more cautiously than a chosen one, and a row that returned the
// right port for the wrong reason would silently drop that hedge.
console.log('\n[5] p2pPortFor() — port, network and where the choice came from');

// [target string, hint, expected port, expected network, expected source]
const P2P_ROWS = [
  // — auto: the only signal is a port the visitor typed themselves —
  ['node.example.com',        'auto',      3414,  'mainnet', 'default'],
  ['node.example.com:3413',   'auto',      3414,  'mainnet', 'default'],
  ['node.example.com:13413',  'auto',      13414, 'testnet', 'derived'],
  ['node.example.com:13414',  'auto',      13414, 'testnet', 'derived'],
  ['node.example.com:3414',   'auto',      3414,  'mainnet', 'default'],
  ['https://api.example.com', 'auto',      3414,  'mainnet', 'default'],
  ['203.0.113.9',             'auto',      3414,  'mainnet', 'default'],
  // — an explicit pick always wins, including over a contradicting port —
  ['node.example.com',        'mainnet',   3414,  'mainnet', 'chosen'],
  ['node.example.com',        'testnet',   13414, 'testnet', 'chosen'],
  ['node.example.com:13413',  'mainnet',   3414,  'mainnet', 'chosen'],
  ['node.example.com:3413',   'testnet',   13414, 'testnet', 'chosen'],
  // — a junk hint degrades to auto, never to an error: the API leg does not
  //   depend on it, so a bad toggle must not fail the whole check —
  ['node.example.com:13413',  'MAINNET',   3414,  'mainnet', 'chosen'],
  ['node.example.com:13413',  'nonsense',  13414, 'testnet', 'derived'],
  ['node.example.com:13413',  '',          13414, 'testnet', 'derived'],
  ['node.example.com',        undefined,   3414,  'mainnet', 'default'],
  ['node.example.com',        null,        3414,  'mainnet', 'default'],
  ['node.example.com',        42,          3414,  'mainnet', 'default'],
  ['node.example.com',        {},          3414,  'mainnet', 'default'],
];

for (const [raw, hint, port, network, source] of P2P_ROWS) {
  ok('p2pPortFor(' + raw + ', ' + JSON.stringify(hint) + ') → ' + port + ' ' + source, () => {
    const got = nc.p2pPortFor(nc.parseTarget(raw), hint);
    assert.strictEqual(got.port, port, 'port');
    assert.strictEqual(got.network, network, 'network');
    assert.strictEqual(got.source, source, 'source');
  });
}

ok('the P2P port is ONLY ever one of the two constants — never visitor input', () => {
  // The line between a reachability checker and a port scanner. If a future
  // edit ever threads a typed port through here, this fails.
  const typed = ['1', '22', '80', '443', '3413', '3414', '8080', '13413', '13414', '65535'];
  const seen = new Set();
  for (const t of typed) {
    for (const h of ['auto', 'mainnet', 'testnet', 'junk']) {
      seen.add(nc.p2pPortFor(nc.parseTarget('node.example.com:' + t), h).port);
    }
  }
  assert.deepStrictEqual([...seen].sort((a, b) => a - b), [nc.P2P_PORT, nc.TESTNET_P2P_PORT],
    'p2pPortFor returned a port that was not 3414 or 13414: ' + [...seen].join(', '));
});

ok('normalizeNetworkHint() collapses everything unknown to auto', () => {
  assert.strictEqual(nc.normalizeNetworkHint('  TestNet '), 'testnet');
  assert.strictEqual(nc.normalizeNetworkHint('Mainnet'), 'mainnet');
  assert.strictEqual(nc.normalizeNetworkHint('auto'), 'auto');
  for (const junk of ['floonet', '', '  ', 'main', undefined, null, 0, [], {}]) {
    assert.strictEqual(nc.normalizeNetworkHint(junk), 'auto', 'hint ' + JSON.stringify(junk));
  }
});

// ═══ 6. The two-leg contract — server states ↔ client labels ═════════════════
//
// WHY THIS EXISTS. The client renders each leg from a lookup table. A state the
// server can emit but the table does not carry falls through to a fallback and
// is drawn as "Not checked" — a probe that RAN and got an answer, shown to the
// operator as though it never happened. Nobody catches that by eye, because the
// fallback looks like a deliberate row.
console.log('\n[6] the two legs — every server state has a client label');

const clientSrc = fs.readFileSync(path.join(APP, 'public/js/node-check.js'), 'utf8');

const mapKeys = (src, name) => {
  const m = new RegExp('const ' + name + ' = \\{([\\s\\S]*?)\\n  \\};').exec(src);
  assert.ok(m, name + ' map not found in public/js/node-check.js');
  return new Set((m[1].match(/^\s{4}([a-z_]+):/gm) || []).map(x => x.trim().replace(':', '')));
};

ok('every state nodeCheckP2pProbe can resolve has a P2P_LEG label', () => {
  const states = new Set((serverSrc.match(/finish\('([a-z_]+)'/g) || [])
    .map(x => x.replace(/finish\('/, '').replace(/'/, '')));
  assert.ok(states.size >= 4, 'expected at least 4 probe states, found ' + states.size);
  const labels = mapKeys(clientSrc, 'P2P_LEG');
  for (const st of states) {
    assert.ok(labels.has(st), 'P2P state "' + st + '" has no row in the client P2P_LEG map');
  }
});

ok('every derived P2P state has a label too', () => {
  // nodeCheckP2pFromApi() is the same-port shortcut; it invents states of its
  // own and they must be drawn identically to a real probe's.
  const fn = /function nodeCheckP2pFromApi[\s\S]*?\n\}/.exec(serverSrc);
  assert.ok(fn, 'nodeCheckP2pFromApi not found');
  const states = new Set((fn[0].match(/state:\s*'([a-z_]+)'/g) || [])
    .map(x => x.replace(/state:\s*'/, '').replace(/'/, '')));
  const labels = mapKeys(clientSrc, 'P2P_LEG');
  for (const st of states) {
    assert.ok(labels.has(st), 'derived P2P state "' + st + '" has no row in P2P_LEG');
  }
});

ok('every DIALLED API verdict has an API_LEG label', () => {
  // The three no-dial codes are excluded by name: nothing was checked, so there
  // is no leg to draw. Every other verdict the client knows about describes a
  // dial that happened and must have a one-word status in the legs block.
  const NO_DIAL = new Set(['blocked', 'bad_input', 'busy']);
  const verdicts = mapKeys(clientSrc, 'VERDICTS');
  const legs     = mapKeys(clientSrc, 'API_LEG');
  assert.ok(verdicts.size > 6, 'VERDICTS map looks unparsed (' + verdicts.size + ' keys)');
  for (const code of verdicts) {
    if (NO_DIAL.has(code)) continue;
    assert.ok(legs.has(code), 'verdict "' + code + '" has no row in the client API_LEG map');
  }
});

ok('the P2P probe sends no bytes — it is a connect, not a request', () => {
  // The whole basis for labelling this leg "port open" rather than "node
  // reachable". A write() added here would change what the probe proves without
  // changing a word of the copy that describes it.
  const fn = /function nodeCheckP2pProbe[\s\S]*?\n\}/.exec(serverSrc);
  assert.ok(fn, 'nodeCheckP2pProbe not found');
  assert.doesNotMatch(fn[0], /\.write\(|\.end\(/, 'the P2P probe must not write to the socket');
});

// ═══ 7. The network picker — HTML control ↔ JS reader ↔ server vocabulary ════
//
// WHY THIS EXISTS. currentNetwork() reads `input[name="nc-net"]:checked` and
// falls back to 'auto' when it finds nothing. That fallback is deliberate — a
// missing control must not break the API leg — but it also means a RENAMED
// control fails silently and for ever: the Testnet button stops working, the
// server keeps dialling mainnet 3414, and the page reports a confident
// "filtered" about a port the operator's testnet node never opened. There is no
// error anywhere in that chain, which is why it is asserted here instead.
console.log('\n[7] the network picker — three files agreeing on three words');

const nodeHtml = fs.readFileSync(path.join(APP, 'public/node-check.html'), 'utf8');

ok('the HTML control name is the one currentNetwork() queries', () => {
  const sel = /querySelector\('input\[name="([a-z-]+)"\]:checked'\)/.exec(clientSrc);
  assert.ok(sel, 'currentNetwork() no longer queries a named radio group');
  assert.match(nodeHtml, new RegExp('name="' + sel[1] + '"'),
    'public/node-check.html has no input named "' + sel[1] + '"');
});

ok('every radio value is a hint the server understands', () => {
  const values = (nodeHtml.match(/name="nc-net"\s+value="([a-z]+)"/g) || [])
    .map(x => /value="([a-z]+)"/.exec(x)[1]);
  assert.deepStrictEqual(values, ['auto', 'mainnet', 'testnet'],
    'the three radios must be auto/mainnet/testnet, in that order — got: ' + values.join(', '));
  for (const v of values) {
    assert.strictEqual(nc.normalizeNetworkHint(v), v,
      'the radio value "' + v + '" does not survive normalizeNetworkHint');
  }
});

ok('exactly one radio ships checked, and it is Auto', () => {
  const checked = (nodeHtml.match(/name="nc-net"[^>]*checked/g) || []);
  assert.strictEqual(checked.length, 1, 'expected exactly one checked radio, got ' + checked.length);
  assert.match(checked[0], /value="auto"/, 'the default must be Auto — an explicit default would '
    + 'silently override a port the visitor typed');
});

ok('the client sends the hint, and the server reads it from the same field', () => {
  assert.match(clientSrc, /network:\s*currentNetwork\(\)/,
    'the POST body no longer carries the network hint');
  assert.match(serverSrc, /p2pPortFor\(target,\s*req\.body && req\.body\.network\)/,
    'the route no longer reads req.body.network');
});

ok('both P2P ports appear on the page, so "Auto" is never a mystery', () => {
  // The labels print the port each choice dials. If those drift from the
  // constants, the page is documenting a port it does not check.
  assert.ok(nodeHtml.includes(String(nc.P2P_PORT)), 'mainnet P2P port missing from the page');
  assert.ok(nodeHtml.includes(String(nc.TESTNET_P2P_PORT)), 'testnet P2P port missing from the page');
});

ok('the page no longer claims it checks only the API', () => {
  // The old copy said "this tool checks the API, because that is the one people
  // publish". Shipping that sentence beside a two-leg result is the doc-drift
  // this repo keeps paying for elsewhere.
  assert.doesNotMatch(nodeHtml, /this tool checks the API/i,
    'node-check.html still says it checks only the API');
});

// ═══ 8. The assumed API endpoint — a NAME gets 443, an IP gets 3413 ══════════
//
// WHY THIS EXISTS. Until 2026-09-10 a bare host defaulted to 3413, and the route
// itself carried a comment calling that "the single commonest wrong verdict this
// tool can give" — Script 04 fronts a node with nginx and publishes it on 443,
// with 3413 bound to localhost. The default now splits on what the host IS, and
// the split is load-bearing in BOTH directions:
//
//   · a NAME → 443/https. Someone who owns a name has DNS and, nearly always, a
//     certificate. Getting this wrong costs one click on the retry.
//   · an IP  → 3413/http. This checker verifies certificates and deliberately
//     sends no SNI for an IP literal, so https on a bare address lands on
//     tls_error whatever is running there. Defaulting an IP to 443 would trade a
//     sometimes-wrong answer for an ALWAYS-wrong one.
console.log('\n[8] parseTarget() — the assumed endpoint splits on host type');

// [input, expected scheme, expected port, expected assumed]
const DEFAULT_ROWS = [
  // — bare names: the nginx-front shape —
  ['node.example.com',            'https', 443,   true],
  ['api.grin.money',             'https', 443,   true],
  ['a.b.c.example.com',          'https', 443,   true],
  ['node.example.com.',          'https', 443,   true],   // trailing root dot
  // — bare addresses: the direct-node shape —
  ['203.0.113.9',                'http',  3413,  true],
  ['2001:db8::1',                'http',  3413,  true],
  ['[2001:db8::1]',              'http',  3413,  true],
  // — anything explicit overrides both, and is NOT "assumed" —
  ['node.example.com:3413',      'http',  3413,  false],
  ['node.example.com:13413',     'http',  13413, false],
  ['203.0.113.9:443',            'https', 443,   false],
  ['http://node.example.com',    'http',  80,    false],
  ['https://node.example.com',   'https', 443,   false],
  ['http://node.example.com:3413', 'http', 3413, false],
  ['https://203.0.113.9:8443',   'https', 8443,  false],
];

for (const [raw, scheme, port, assumed] of DEFAULT_ROWS) {
  ok('parseTarget(' + raw + ') → ' + scheme + ':' + port + (assumed ? ' (assumed)' : ''), () => {
    const t = nc.parseTarget(raw);
    assert.strictEqual(t.scheme, scheme, 'scheme');
    assert.strictEqual(t.port, port, 'port');
    assert.strictEqual(t.assumed, assumed, 'assumed');
  });
}

ok('an IP literal is NEVER assumed onto TLS — that is an unconditional dead end', () => {
  // The one rule in this section that cannot be traded away: no SNI is sent for
  // an IP, and certificates are verified, so an assumed https on an address
  // fails for every host on earth.
  for (const ip of ['203.0.113.9', '198.51.100.1', '2001:db8::1', '64:ff9b::203.0.113.9']) {
    const t = nc.parseTarget(ip);
    assert.strictEqual(t.scheme, 'http', ip + ' was assumed onto ' + t.scheme);
    assert.strictEqual(t.port, nc.DEFAULT_PORT, ip + ' was assumed onto port ' + t.port);
  }
});

ok('the two assumed ports are the exported constants, not literals', () => {
  assert.strictEqual(nc.parseTarget('node.example.com').port, nc.HTTPS_PORT);
  assert.strictEqual(nc.parseTarget('203.0.113.9').port, nc.DEFAULT_PORT);
  assert.strictEqual(nc.HTTPS_PORT, 443);
  assert.strictEqual(nc.DEFAULT_PORT, 3413);
});

// ═══ 9. The retry suggestion points AWAY from the assumption ═════════════════
//
// The default and the retry are two ends of one mechanism: the retry exists to
// undo the assumption in one click. If someone flips the default and forgets the
// retry, the page dials 443 and then offers 443 — a button that re-runs the
// check that just failed. Nothing else in the codebase would notice.
console.log('\n[9] the one-click retry undoes the assumption it is paired with');

ok('the route suggests the DIRECT port, not the TLS front', () => {
  const block = /suggest:\s*\(target\.assumed[\s\S]*?\}\s*:\s*null,/.exec(serverSrc);
  assert.ok(block, 'the suggest block is no longer shaped as expected');
  assert.match(block[0], /scheme:\s*'http'/,
    'the suggestion must offer plain http now that https is the assumption');
  assert.match(block[0], /nodeCheck\.DEFAULT_PORT/,
    'the suggestion must name DEFAULT_PORT, not a literal that can drift from it');
  assert.doesNotMatch(block[0], /scheme:\s*'https'/,
    'the suggestion still offers https — it would re-run the check that just failed');
});

ok('tls_error is in the retry allowlist — it is now the likeliest failure', () => {
  // A name with no nginx front answers 443 with something that is not TLS, or
  // with a certificate that does not verify. Before the flip this code could not
  // arise from an assumption; now it is the commonest way one is wrong.
  const m = /const SUGGEST_OK = \{([^}]*)\}/.exec(clientSrc);
  assert.ok(m, 'SUGGEST_OK not found');
  const keys = (m[1].match(/([a-z_]+):/g) || []).map(x => x.replace(':', ''));
  for (const need of ['refused', 'timeout', 'tls_error', 'http_status', 'not_json_rpc']) {
    assert.ok(keys.includes(need), 'SUGGEST_OK is missing "' + need + '"');
  }
  // node_error must stay out: it means a real Grin node answered.
  assert.ok(!keys.includes('node_error'),
    'node_error must not suggest another port — a Grin node already answered');
});

ok('the page documents the split it actually implements', () => {
  // Doc drift here is invisible: the page would describe a default the parser
  // stopped using, and the operator would blame their node.
  assert.match(nodeHtml, /443/, 'the page never mentions 443');
  assert.doesNotMatch(nodeHtml, /Default port 3413/,
    'the page still advertises 3413 as THE default');
});

module.exports = { report: () => ({ pass, fail }) };

if (require.main === module) {
  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
