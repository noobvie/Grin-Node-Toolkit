'use strict';
/**
 * config.test.js — the loader, and specifically the R6 finding it exists to
 * prevent: a value whose TYPE is wrong silently inverting a security default.
 *
 * The rule at the top of config.js is that the operator who never edits the file
 * must not end up with a more permissive gateway than one who does. Before R6,
 * `"allow_clearnet_destinations": "false"` — a quoted boolean, the commonest
 * hand-edit slip there is — loaded happily and turned the SSRF guard OFF, because
 * the non-empty string "false" is truthy. Every assertion below is that class.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig, DEFAULTS } = require('../config');
const { makeCfg, loadRaw, cleanup } = require('./helpers');

test.after(cleanup);

function rejects(overrides, match) {
	assert.throws(() => makeCfg(overrides), match);
}

// ─── The defaults are the safe values ────────────────────────────────────────

test('the shipped defaults are the closed ones', () => {
	const cfg = makeCfg();
	assert.equal(cfg.allow_clearnet_destinations, false, 'clearnet must be off by default');
	assert.equal(cfg.log_destinations, false, 'destination logging must be off by default');
	assert.equal(cfg.tor_port, 0, 'the onion listener must be closed by default');
	assert.equal(cfg.network, 'testnet', 'the default network must be the harmless one');
	assert.deepEqual([...cfg.destinationPorts], [80, 443]);
});

test('an absent file is fatal, not defaulted', () => {
	// The defaults do not know which network or port this instance is; two
	// instances silently sharing a port is worse than not starting.
	assert.throws(() => loadConfig('/nonexistent/accio/gateway.json'), /cannot read config/);
});

test('invalid JSON is fatal and says so', () => {
	assert.throws(() => loadRaw('{ not json'), /is not valid JSON/);
});

// ─── R6: types ───────────────────────────────────────────────────────────────

test('R6: a QUOTED boolean is refused, on every boolean key', () => {
	for (const key of ['allow_clearnet_destinations', 'log_destinations', 'allow_null_origin',
		'allow_extension_origins', 'listen_enabled', 'socks_isolate_per_destination']) {
		rejects({ [key]: 'false' }, new RegExp(`"${key}" must be true or false`));
		rejects({ [key]: 'true' }, new RegExp(`"${key}" must be true or false`));
		rejects({ [key]: 0 }, new RegExp(`"${key}" must be true or false`));
		rejects({ [key]: 'no' }, new RegExp(`"${key}" must be true or false`));
	}
});

test('R6: the SSRF switch cannot be turned on by accident', () => {
	// The specific case that motivated the whole list: "false" is truthy.
	assert.equal(Boolean('false'), true, 'if this ever changes, JavaScript has been fixed');
	rejects({ allow_clearnet_destinations: 'false' }, /must be true or false/);
	// And turning it on deliberately still works.
	assert.equal(makeCfg({ allow_clearnet_destinations: true }).allow_clearnet_destinations, true);
});

test('R6: a non-string where a string belongs is refused', () => {
	for (const key of ['network', 'domain', 'onion', 'socks_host', 'state_dir',
		'destination_path_pattern', 'session_cookie_name']) {
		rejects({ [key]: 1234 }, new RegExp(`"${key}" must be a string`));
	}
});

test('a non-integer, zero or negative limit is refused', () => {
	for (const key of ['port', 'max_body_bytes', 'max_concurrent', 'session_ttl_days',
		'max_sessions', 'suffix_length', 'ws_message_burst', 'inbound_timeout_ms']) {
		rejects({ [key]: 0 }, new RegExp(`"${key}" must be a positive integer`));
		rejects({ [key]: -1 }, new RegExp(`"${key}" must be a positive integer`));
		rejects({ [key]: '8080' }, new RegExp(`"${key}" must be a positive integer`));
		rejects({ [key]: 1.5 }, new RegExp(`"${key}" must be a positive integer`));
	}
});

// ─── R6: the unknown-key guard ───────────────────────────────────────────────

test('R6: an inherited key does not pass the unknown-key guard', () => {
	// `key in DEFAULTS` walked the prototype chain, so these five satisfied the
	// one guard whose entire job is catching a typo.
	for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
		assert.ok(key in DEFAULTS, 'precondition: it IS on the prototype chain');
		assert.ok(!Object.hasOwn(DEFAULTS, key), 'precondition: it is not a real key');
		const cfg = makeCfg({ [key]: 'pwned' });
		assert.notEqual(cfg[key], 'pwned', `"${key}" must be ignored, not assigned`);
	}
	assert.equal(typeof makeCfg({ toString: 'pwned' }).toString, 'function');
});

test('a genuinely unknown key is ignored and keeps the default', () => {
	const cfg = makeCfg({ max_body_byte: 1 });         // the classic typo
	assert.equal(cfg.max_body_bytes, DEFAULTS.max_body_bytes);
	assert.equal(cfg.max_body_byte, undefined);
});

// ─── R6: port collisions ─────────────────────────────────────────────────────

test('the two fronts may not share a port', () => {
	rejects({ port: 7490, tor_port: 7490 }, /must differ — the port IS the trust boundary/);
});

test('R6: neither front may sit on the Tor SOCKS port', () => {
	// Which process loses depends on boot order, and nothing on the box reports
	// either outcome: the gateway restart-loops, or it proxies to itself.
	rejects({ port: 9050, socks_port: 9050 }, /collides with "socks_port"/);
	rejects({ tor_port: 9050, socks_port: 9050 }, /collides with "socks_port"/);
	// tor_port 0 is "disabled", not a collision.
	assert.equal(makeCfg({ tor_port: 0, socks_port: 9050 }).tor_port, 0);
});

test('a port above 65535 is refused', () => {
	rejects({ port: 70000 }, /is not a valid port/);
	rejects({ tor_port: 70000 }, /is not a valid port/);
});

// ─── R6: the destination port allowlist ──────────────────────────────────────

test('R6: allowed_destination_ports is validated as ports', () => {
	rejects({ allowed_destination_ports: 80 }, /must be an array/);
	rejects({ allowed_destination_ports: ['80'] }, /not a port/);
	rejects({ allowed_destination_ports: [0] }, /not a port/);
	rejects({ allowed_destination_ports: [70000] }, /not a port/);
	assert.deepEqual([...makeCfg({ allowed_destination_ports: [80] }).destinationPorts], [80]);
	assert.equal(makeCfg({ allowed_destination_ports: [] }).destinationPorts.size, 0);
});

// ─── The rest of the validation surface ──────────────────────────────────────

test('network must be one of the two we have', () => {
	rejects({ network: 'mainet' }, /must be "testnet" or "mainnet"/);
	assert.equal(makeCfg({ network: 'mainnet' }).network, 'mainnet');
});

test('a cookie name that could inject a header is refused', () => {
	rejects({ session_cookie_name: 'a b' }, /not a valid cookie name/);
	rejects({ session_cookie_name: 'a;Secure' }, /not a valid cookie name/);
	rejects({ session_cookie_name: '' }, /not a valid cookie name/);
});

test('session_cookie_secure accepts exactly true, false and "auto"', () => {
	for (const v of [true, false, 'auto']) {
		assert.equal(makeCfg({ session_cookie_secure: v }).session_cookie_secure, v);
	}
	rejects({ session_cookie_secure: 'yes' }, /must be true, false or "auto"/);
});

test('suffix_length is bounded at both ends', () => {
	rejects({ suffix_length: 7 }, /must be between 8 and 64/);
	rejects({ suffix_length: 65 }, /must be between 8 and 64/);
	assert.equal(makeCfg({ suffix_length: 16 }).suffix_length, 16);
});

test('a ping slower than a proxy reaper is refused', () => {
	rejects({ ws_ping_interval_ms: 55000 }, /must be well under 60000/);
	rejects({ ws_ping_interval_ms: 90000 }, /must be well under 60000/);
});

test('an uncompilable destination pattern is refused', () => {
	rejects({ destination_path_pattern: '^(' }, /is not a valid regex/);
});

test('extra_allowed_origins must be an array and lands in allowedOrigins', () => {
	rejects({ extra_allowed_origins: 'https://a.example' }, /must be an array/);
	const cfg = makeCfg({ domain: 'w.example', extra_allowed_origins: ['https://staging.example'] });
	assert.ok(cfg.allowedOrigins.has('https://staging.example'));
	assert.ok(cfg.allowedOrigins.has('https://w.example'));
	// Both schemes of our own host, because the vhost is HTTP-only until certbot.
	assert.ok(cfg.allowedOrigins.has('http://w.example'));
});
