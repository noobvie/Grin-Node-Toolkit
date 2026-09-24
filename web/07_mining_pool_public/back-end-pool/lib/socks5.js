'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// socks5.js — a SOCKS5 CONNECT client (RFC 1928 + RFC 1929), zero dependencies.
//
// PORTED 2026-09-23 from web/06d_tiny_explorer/lib/socks5.js (itself a port of
// web/052_accio/gateway/socks5.js). It is a COPY, not a require across products:
// 06d and the pool deploy separately, to different directories on different
// boxes, so a relative require into another product's tree would break the day
// either one is installed alone.
//
// Why it is here at all: the pool's Tor reachability probe used the `socks` npm
// lib, which reports a proxy timeout as the bare string 'Proxy connection timed
// out' — no reply byte, no "did tor say anything" — so the probe could not tell
// OUR tor being slow from THEIR wallet being down, and read a timeout as a
// confident "offline". That confident offline is also the withdraw pre-flight
// gate's refusal. 06d's copy stamps every rejection with `proxyResponded`:
//
//   proxyResponded true  → tor greeted us and then the stream failed, so the
//                          failure belongs to the hidden service (→ offline)
//   proxyResponded false → we never got a byte out of 127.0.0.1:<socks>, so the
//                          failure is OURS (→ indeterminate, never "offline")
//
// Keep behaviour in step with 06d; the pool's copy may diverge only
// deliberately, and every divergence is listed here. There is ONE: the SOCKS
// isolation-credential literal is `grinpool` instead of `tinyexp` (handshake()).
// Everything below this header is otherwise byte-identical to 06d's file, so
//   diff <(sed -n '/^const net/,$p' web/06d_tiny_explorer/lib/socks5.js) \
//        <(sed -n '/^const net/,$p' web/07_mining_pool_public/back-end-pool/lib/socks5.js)
// must print only that one line pair. Anything else is an unreviewed drift.
//
// ATYP is always 0x03 (domain name): Tor must do the resolving, because there
// is no A record behind an .onion. That also means this process never resolves
// a name, so there is no window between "the guard checked the host" and "the
// socket connected" for DNS rebinding to slip through.
// ─────────────────────────────────────────────────────────────────────────────

const net = require('net');

const VERSION     = 0x05;
const CMD_CONNECT = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV4   = 0x01;
const ATYP_IPV6   = 0x04;

const METHOD_NONE         = 0x00;
const METHOD_USERPASS     = 0x02;
const METHOD_UNACCEPTABLE = 0xff;

// RFC 1928 §6. Tor reuses these; 0x04 is what an unreachable or unpublished
// onion descriptor comes back as, which is the failure operators actually hit.
const REPLY_TEXT = {
  0x00: 'succeeded',
  0x01: 'general SOCKS server failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable (onion descriptor not found, or the service is offline)',
  0x05: 'connection refused (the onion is reachable but nothing is listening on that port)',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported',
};

class SocksError extends Error {
  constructor(message, code, proxyResponded) {
    super(message);
    this.name = 'SocksError';
    this.code = code;                          // SOCKS reply byte, or null for local failures
    this.proxyResponded = Boolean(proxyResponded);
  }
}

// Read exactly `n` bytes without ever putting the socket in flowing mode.
//
// ⚠ 'readable' + socket.read(n), NOT a 'data' handler, and that is load-bearing
// rather than stylistic. The socket does not belong to us — it is handed to
// Node's HTTP client the moment the handshake ends, and the client attaches its
// own parser. Attaching 'data' puts the stream in flowing mode; removing the
// handler does not take it back out, so bytes keep being emitted to nobody; and
// pause()ing to stop that sets flowing = false permanently as far as the next
// consumer is concerned, so the HTTP client's parser never sees a byte and the
// request hangs until the read timeout. Paused reads sidestep all three:
// anything past the handshake stays in the stream's own buffer, and removing
// the 'readable' listener leaves flowing = null, the neutral state.
function createReader(socket, state) {
  let want = 0;
  let resolveFn = null;
  let rejectFn  = null;

  const tryRead = () => {
    if (!resolveFn) return;
    const chunk = socket.read(want);
    if (chunk === null) return;                // fewer than `want` bytes so far
    const done = resolveFn;
    resolveFn = rejectFn = null;
    want = 0;
    done(chunk);
  };
  const fail = (err) => {
    if (!rejectFn) return;
    const done = rejectFn;
    resolveFn = rejectFn = null;
    done(err);
  };

  socket.on('readable', tryRead);
  socket.once('error', fail);
  socket.once('close', () => fail(new SocksError(
    'SOCKS proxy closed the connection during the handshake', null, state.proxyResponded)));

  return {
    read(n) {
      return new Promise((resolve, reject) => {
        want = n;
        resolveFn = resolve;
        rejectFn  = reject;
        tryRead();
      });
    },
    detach() {
      socket.removeListener('readable', tryRead);
      socket.removeListener('error', fail);
    },
  };
}

function buildGreeting(withAuth) {
  const methods = withAuth ? [METHOD_NONE, METHOD_USERPASS] : [METHOD_NONE];
  return Buffer.from([VERSION, methods.length, ...methods]);
}

function buildUserPass(username, password) {
  const u = Buffer.from(username, 'utf8').subarray(0, 255);
  const p = Buffer.from(password, 'utf8').subarray(0, 255);
  return Buffer.concat([
    Buffer.from([0x01, u.length]), u,
    Buffer.from([p.length]), p,
  ]);
}

function buildConnect(host, port) {
  const h = Buffer.from(host, 'ascii');
  if (h.length === 0 || h.length > 255) {
    throw new SocksError(`destination host length ${h.length} is not addressable over SOCKS5`, null, false);
  }
  return Buffer.concat([
    Buffer.from([VERSION, CMD_CONNECT, 0x00, ATYP_DOMAIN, h.length]), h,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]);
}

// connect({ socksHost, socksPort, host, port, timeoutMs, isolationTag })
//   → Promise<net.Socket> already tunnelled to host:port.
//
// `isolationTag`, when set, is sent as the SOCKS username. Tor's default
// SocksPort has IsolateSOCKSAuth on, so distinct credentials get distinct
// circuits. The probe passes a per-ATTEMPT tag rather than a per-destination
// one: retry 2 exists precisely to dodge a flaky circuit, and reusing the
// circuit would make it a re-run of the same failure. The value is not a secret
// and Tor does not authenticate it — it is a circuit selector, nothing more.
function connect(opts) {
  const {
    socksHost, socksPort, host, port,
    timeoutMs = 60000, isolationTag = null,
  } = opts;

  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: socksHost, port: socksPort });
    const state  = { proxyResponded: false };
    let settled  = false;

    const done = (err, value) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      if (err) {
        socket.destroy();
        if (err.proxyResponded !== true) err.proxyResponded = state.proxyResponded;
        reject(err);
      } else {
        resolve(value);
      }
    };

    socket.setTimeout(timeoutMs, () => {
      done(new SocksError(
        `timed out after ${timeoutMs}ms connecting through the Tor SOCKS proxy`,
        null, state.proxyResponded));
    });
    socket.once('error', (err) => {
      // The overwhelmingly common one: ECONNREFUSED because tor is not running.
      // Say so rather than leaving an operator to guess.
      const hint = err.code === 'ECONNREFUSED'
        ? ` — is tor running and listening on ${socksHost}:${socksPort}?`
        : '';
      const e = new SocksError(
        `SOCKS proxy connection failed: ${err.message}${hint}`, null, state.proxyResponded);
      e.syscallCode = err.code || null;
      done(e);
    });

    socket.once('connect', () => {
      const reader = createReader(socket, state);
      handshake(socket, reader, state, { host, port, isolationTag })
        .then(() => {
          reader.detach();
          done(null, socket);
        })
        .catch((err) => done(err instanceof SocksError
          ? err
          : new SocksError(err.message, null, state.proxyResponded)));
    });
  });
}

async function handshake(socket, reader, state, { host, port, isolationTag }) {
  socket.write(buildGreeting(Boolean(isolationTag)));

  const greeting = await reader.read(2);
  // FIRST byte back from the proxy. Everything after this point is a failure of
  // the destination, not of our tor — which is exactly the tri-state split.
  state.proxyResponded = true;
  if (greeting[0] !== VERSION) {
    throw new SocksError(`SOCKS proxy answered version ${greeting[0]}, expected 5`, null, true);
  }
  if (greeting[1] === METHOD_UNACCEPTABLE) {
    throw new SocksError('SOCKS proxy rejected every authentication method we offered', null, true);
  }
  if (greeting[1] === METHOD_USERPASS) {
    socket.write(buildUserPass(isolationTag || 'grinpool', 'grinpool'));
    const auth = await reader.read(2);
    if (auth[1] !== 0x00) {
      throw new SocksError(`SOCKS proxy rejected the isolation credential (status ${auth[1]})`, null, true);
    }
  } else if (greeting[1] !== METHOD_NONE) {
    throw new SocksError(`SOCKS proxy selected unsupported method ${greeting[1]}`, null, true);
  }

  socket.write(buildConnect(host, port));

  const head = await reader.read(4);
  if (head[0] !== VERSION) {
    throw new SocksError(`SOCKS reply had version ${head[0]}, expected 5`, null, true);
  }
  const rep  = head[1];
  // The bound address must be consumed whatever the reply says, or its bytes
  // would be mistaken for the start of the HTTP response.
  const atyp = head[3];
  if (atyp === ATYP_IPV4) {
    await reader.read(4 + 2);
  } else if (atyp === ATYP_IPV6) {
    await reader.read(16 + 2);
  } else if (atyp === ATYP_DOMAIN) {
    const len = await reader.read(1);
    await reader.read(len[0] + 2);
  } else {
    throw new SocksError(`SOCKS reply used unknown address type ${atyp}`, rep, true);
  }
  if (rep !== 0x00) {
    throw new SocksError(REPLY_TEXT[rep] || `SOCKS connect failed with reply code ${rep}`, rep, true);
  }
}

module.exports = { connect, SocksError, REPLY_TEXT };
