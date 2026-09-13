// ─────────────────────────────────────────────────────────────────────────────
// Wallet Checker — TIER 1 (client-side), plus the tier-2 probe CONTROL
//
// A Grin Slatepack address IS a 32-byte ed25519 public key in bech32, and the
// v3 onion the wallet publishes over Tor is a deterministic function of that
// same key. So with no network call at all we can answer three questions:
//
//   1. is the address intact?      (bech32 checksum — catches the truncation
//                                   or typo that is the common real failure)
//   2. which network is it for?    (the HRP, and ONLY the HRP — see below)
//   3. what is its .onion?         (base32(pubkey ‖ checksum ‖ 0x03))
//
// None of that can say whether the wallet is LISTENING. That is tier 2, and it
// is a server-side Tor probe (lib/wallet-tor.js, POST /api/wallet-check). This
// file owns only its control and its rendering, and only when the server says
// the probe is switched on — see "Tier 2" further down. Until the visitor
// presses that button nothing here has touched the network, and no wording
// above it may imply the wallet was reached.
//
// Network detection: per memory project_slate_inspector_06d, a Grin slate
// carries no network field whatsoever — the address prefix is the only signal
// that exists anywhere in the format. `grin1…` mainnet, `tgrin1…` testnet.
//
// Reuse, not re-implementation:
//   • bech32 comes from /js/slatepack-decode.js (_internal.bech32Decode,
//     _internal.wordsToBytes). This page must not carry a third copy.
//   • the onion derivation is a port of the PURE helpers in
//     web/07_mining_pool_public/back-end-pool/lib/wallet-tor.js
//     (base32LowerNoPad, onionV3FromPubkey), which were validated against an
//     independent Python reference. Do not redesign it.
//
// The one thing that could not be ported: wallet-tor.js takes sha3-256 from
// node's crypto, which the browser has no equivalent for — crypto.subtle
// implements SHA-1/256/384/512 and no SHA-3 at all. Hence the self-contained
// Keccak below. 06d has exactly one npm dependency (express) and keeps it.
// ─────────────────────────────────────────────────────────────────────────────

(function (root) {
  'use strict';

  // ── SHA3-256 (Keccak-f[1600], rate 136, domain 0x06) ───────────────────────
  // Lanes are held as 32-bit hi/lo pairs: JS has no 64-bit integer outside
  // BigInt, and BigInt through 24 rounds is pointless overhead for a 48-byte
  // input. Verified against node crypto's sha3-256 in the test harness.

  const RC_LO = new Int32Array([
    0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001,
    0x80008081, 0x00008009, 0x0000008a, 0x00000088, 0x80008009, 0x8000000a,
    0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080,
    0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008
  ]);
  const RC_HI = new Int32Array([
    0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000,
    0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000,
    0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000,
    0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000
  ]);

  // ρ offsets and the π permutation, by lane index i = x + 5y. Built once from
  // the spec's r[x][y] table rather than pasted as a flat array, so the
  // mapping stays checkable against the standard.
  const ROT = new Int32Array(25);
  const PI  = new Int32Array(25);
  (function () {
    const R = [
      [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
      [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]
    ];
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        ROT[x + 5 * y] = R[x][y];
        PI[x + 5 * y]  = y + 5 * ((2 * x + 3 * y) % 5);   // B[y][2x+3y] ← A[x][y]
      }
    }
  })();

  function keccakF(sLo, sHi) {
    const bLo = new Int32Array(25), bHi = new Int32Array(25);
    const cLo = new Int32Array(5),  cHi = new Int32Array(5);

    for (let round = 0; round < 24; round++) {
      // θ
      for (let x = 0; x < 5; x++) {
        cLo[x] = sLo[x] ^ sLo[x + 5] ^ sLo[x + 10] ^ sLo[x + 15] ^ sLo[x + 20];
        cHi[x] = sHi[x] ^ sHi[x + 5] ^ sHi[x + 10] ^ sHi[x + 15] ^ sHi[x + 20];
      }
      for (let x = 0; x < 5; x++) {
        const n = (x + 1) % 5, p = (x + 4) % 5;
        const rLo = (cLo[n] << 1) | (cHi[n] >>> 31);      // rot(C[x+1], 1)
        const rHi = (cHi[n] << 1) | (cLo[n] >>> 31);
        const dLo = cLo[p] ^ rLo, dHi = cHi[p] ^ rHi;
        for (let y = 0; y < 25; y += 5) { sLo[x + y] ^= dLo; sHi[x + y] ^= dHi; }
      }
      // ρ + π
      for (let i = 0; i < 25; i++) {
        const n = ROT[i], j = PI[i], lo = sLo[i], hi = sHi[i];
        if (n === 0)        { bLo[j] = lo; bHi[j] = hi; }
        else if (n < 32)    { bLo[j] = (lo << n) | (hi >>> (32 - n));
                              bHi[j] = (hi << n) | (lo >>> (32 - n)); }
        else if (n === 32)  { bLo[j] = hi; bHi[j] = lo; }   // >>> 32 is a no-op in JS
        else                { const m = n - 32;
                              bLo[j] = (hi << m) | (lo >>> (32 - m));
                              bHi[j] = (lo << m) | (hi >>> (32 - m)); }
      }
      // χ
      for (let y = 0; y < 25; y += 5) {
        for (let x = 0; x < 5; x++) {
          const a = y + x, b = y + ((x + 1) % 5), c = y + ((x + 2) % 5);
          sLo[a] = bLo[a] ^ (~bLo[b] & bLo[c]);
          sHi[a] = bHi[a] ^ (~bHi[b] & bHi[c]);
        }
      }
      // ι
      sLo[0] ^= RC_LO[round];
      sHi[0] ^= RC_HI[round];
    }
  }

  function sha3_256(msg) {
    const RATE = 136;                                     // 1600 − 2×256 bits
    const len  = msg.length;
    const buf  = new Uint8Array(len + (RATE - (len % RATE)));   // pad is never 0
    buf.set(msg);
    buf[len] = 0x06;                                      // SHA-3 domain separation
    buf[buf.length - 1] |= 0x80;

    const sLo = new Int32Array(25), sHi = new Int32Array(25);
    for (let off = 0; off < buf.length; off += RATE) {
      for (let i = 0; i < RATE / 8; i++) {
        const p = off + i * 8;
        sLo[i] ^= buf[p]     | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24);
        sHi[i] ^= buf[p + 4] | (buf[p + 5] << 8) | (buf[p + 6] << 16) | (buf[p + 7] << 24);
      }
      keccakF(sLo, sHi);
    }

    const out = new Uint8Array(32);                       // 4 lanes; 32 < rate, one squeeze
    for (let i = 0; i < 4; i++) {
      const lo = sLo[i], hi = sHi[i], o = i * 8;
      out[o]     =  lo         & 0xff; out[o + 1] = (lo >>> 8)  & 0xff;
      out[o + 2] = (lo >>> 16) & 0xff; out[o + 3] = (lo >>> 24) & 0xff;
      out[o + 4] =  hi         & 0xff; out[o + 5] = (hi >>> 8)  & 0xff;
      out[o + 6] = (hi >>> 16) & 0xff; out[o + 7] = (hi >>> 24) & 0xff;
    }
    return out;
  }

  // ── v3 onion, ported from wallet-tor.js ────────────────────────────────────

  function base32LowerNoPad(bytes) {
    const A = 'abcdefghijklmnopqrstuvwxyz234567';
    let bits = 0, value = 0, out = '';
    for (const b of bytes) {
      value = ((value << 8) | b) & 0x1fff;
      bits += 8;
      while (bits >= 5) { bits -= 5; out += A[(value >>> bits) & 31]; }
    }
    if (bits > 0) out += A[(value << (5 - bits)) & 31];
    return out;
  }

  // v3 onion = base32(pubkey ‖ checksum ‖ 0x03),
  // checksum = SHA3-256(".onion checksum" ‖ pubkey ‖ 0x03)[:2].
  function onionV3FromPubkey(pubkey) {
    const TAG = '.onion checksum';
    const pre = new Uint8Array(TAG.length + pubkey.length + 1);
    for (let i = 0; i < TAG.length; i++) pre[i] = TAG.charCodeAt(i);
    pre.set(pubkey, TAG.length);
    pre[pre.length - 1] = 0x03;

    const sum  = sha3_256(pre);
    const full = new Uint8Array(pubkey.length + 3);
    full.set(pubkey, 0);
    full[pubkey.length]     = sum[0];
    full[pubkey.length + 1] = sum[1];
    full[pubkey.length + 2] = 0x03;
    return base32LowerNoPad(full) + '.onion';
  }

  // ── Address check ──────────────────────────────────────────────────────────

  const B32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

  function bech32Parts() {
    const sp = root.SlatepackDecode;
    if (!sp || !sp._internal || !sp._internal.bech32Decode || !sp._internal.wordsToBytes) {
      return null;                                        // /js/slatepack-decode.js missing
    }
    return sp._internal;
  }

  function fail(code, message, extra) {
    return Object.assign({ ok: false, code, message, address: null, hrp: null,
                           network: null, pubkeyHex: null, onion: null }, extra || {});
  }

  function toHex(bytes) {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
  }

  // → { ok, code, message, address, hrp, network, pubkeyHex, onion }
  //
  // The failure codes are deliberately specific. bech32Decode returns a bare
  // null for every kind of bad input, and "invalid address" tells the user
  // nothing about whether they mistyped a character or lost the tail off a
  // copy-paste — which is the whole point of the tool.
  function checkAddress(input) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw) return fail('empty', 'Paste a Slatepack address to check.');

    const parts = bech32Parts();
    if (!parts) return fail('internal', 'The bech32 decoder failed to load. Reload the page.');

    if (/\s/.test(raw)) {
      return fail('charset', 'That contains a space. A Slatepack address is one unbroken word — check for a line break in the copy.');
    }
    if (/[a-z]/.test(raw) && /[A-Z]/.test(raw)) {
      return fail('mixed-case', 'Mixed upper and lower case. bech32 is all-lower or all-upper, never both, so this address has been altered.');
    }

    const addr = raw.toLowerCase();
    const pos  = addr.lastIndexOf('1');
    if (pos < 1) {
      return fail('no-separator', 'No "1" separator found. Every Slatepack address is a prefix, a "1", then the data — e.g. grin1….');
    }
    const hrp  = addr.slice(0, pos);
    const data = addr.slice(pos + 1);

    if (data.length < 6) {
      return fail('length', 'Nothing after the separator but a partial checksum — the address is truncated.');
    }
    const bad = [...data].find(c => B32_CHARSET.indexOf(c) === -1);
    if (bad) {
      // 1, b, i and o are excluded from the bech32 alphabet precisely because
      // they are the characters people mis-read, so naming the offender helps.
      return fail('charset', `"${bad}" is not a bech32 character. The alphabet deliberately omits 1, b, i and o to avoid look-alikes — check for a mis-typed l/1, 0/o or 8/b.`);
    }

    const dec = parts.bech32Decode(addr);
    if (!dec) {
      // Charset, case, separator and length are all already ruled out above,
      // so the polymod is the only thing left that can have failed.
      return fail('checksum', 'The bech32 checksum does not match. One or more characters are wrong, or the address was cut short — ask the sender for it again rather than guessing.');
    }

    const network = dec.hrp === 'grin' ? 'mainnet' : dec.hrp === 'tgrin' ? 'testnet' : null;
    if (!network) {
      return fail('hrp', `The checksum is valid, but "${dec.hrp}" is not a Grin prefix. Grin uses grin1… (mainnet) and tgrin1… (testnet); this looks like an address for another chain.`,
                  { hrp: dec.hrp, address: addr });
    }

    const key = parts.wordsToBytes(dec.words);
    if (!key || key.length !== 32) {
      return fail('payload', `The checksum is valid but the payload is ${key ? key.length : 0} bytes, not the 32 of an ed25519 public key.`,
                  { hrp: dec.hrp, network, address: addr });
    }

    return {
      ok: true,
      code: 'ok',
      message: 'Valid Slatepack address.',
      address: addr,
      hrp: dec.hrp,
      network,
      pubkeyHex: toHex(key),
      onion: onionV3FromPubkey(key)
    };
  }

  // ── Page wiring ────────────────────────────────────────────────────────────

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function row(label, value, copyVal) {
    const r = el('div', 'tx-row');
    r.appendChild(el('div', 'tx-row-label', label));
    r.appendChild(el('div', 'tx-row-value', value));
    if (copyVal) {
      const b = el('button', 'tx-copy', 'Copy');
      b.type = 'button';
      b.addEventListener('click', () => {
        if (typeof root.copyText === 'function') root.copyText(copyVal, b);
      });
      r.appendChild(b);
    }
    return r;
  }

  // ── Tier 2: the optional Tor liveness probe ────────────────────────────────
  //
  // Everything above this line is arithmetic in your browser. This is the one
  // thing that is not: pressing the button sends the address to THIS server,
  // which derives the same onion and tries to talk to it over Tor.
  //
  // Two rules the copy has to keep:
  //
  //   · The button only exists when the server says the probe is switched on
  //     (window.TINYEXP_WALLET_PROBE, injected per page). A button that could
  //     only ever answer "could not check" is worse than no button — it reads
  //     as a broken wallet rather than an unequipped server.
  //   · THREE outcomes, never two. `online: null` means WE could not run the
  //     check, and it must never be drawn as the wallet being offline. That is
  //     the same lie as reporting a healthy node's peer count as 0 — the
  //     visitor cannot tell our outage from their outage unless we say which.

  const PROBE_STATE = {
    // online → [verdict class, mark, headline]. The headline is written from
    // the visitor's side of the question, so `null` talks about US.
    true:  ['is-ok',   '✓', 'Answering over Tor right now.'],
    false: ['is-bad',  '✕', 'Not reachable over Tor right now.'],
    null:  ['is-warn', '?', 'Could not check — this is our end, not yours.'],
  };

  function probeEnabled() {
    return root.TINYEXP_WALLET_PROBE === true;
  }

  function renderProbeResult(box, data) {
    // ORDER IS LOAD-BEARING: unhide FIRST, then mutate. `hidden` is display:none,
    // and a subtree that is display:none is not in the accessibility tree — so a
    // childList change made while it is still hidden happens to a node the AT
    // cannot see, and several screen readers never announce the aria-live region
    // when it later appears. Appending first and unhiding last (what this did
    // until R8) is the one order that loses the announcement. It matters most
    // here: this is the Tor liveness probe, the only slow ASYNCHRONOUS result on
    // any of these pages, i.e. the one result a non-sighted visitor most needs
    // spoken. #wc-out, #nc-out, #pf-out and /slate's #out all already unhide
    // first; this was the odd one out.
    box.hidden = false;
    box.textContent = '';
    const online = (data && 'online' in data) ? data.online : null;
    const [cls, mark, headline] = PROBE_STATE[String(online)] || PROBE_STATE['null'];

    const v = el('div', 'tx-wc-verdict ' + cls);
    v.appendChild(el('span', 'tx-wc-mark', mark));
    const txt = el('span', 'tx-wc-verdict-text');
    txt.appendChild(el('strong', null, headline));
    txt.appendChild(document.createTextNode(' ' + ((data && data.message) || '')));
    if (online === false) {
      // A real <code> element, not backticks. This is rendered copy, not
      // markdown: a text node keeps the grave accents literal, so the visitor
      // reads `grin-wallet listen` with the quotes showing.
      txt.appendChild(document.createTextNode(' A wallet only answers while '));
      txt.appendChild(el('code', null, 'grin-wallet listen'));
      txt.appendChild(document.createTextNode(
        ' is running — an address stays valid whether or not anything is behind it.'));
    }
    v.appendChild(txt);
    box.appendChild(v);
  }

  function probeSection(address) {
    const wrap = el('div', 'tx-wc-probe');

    const head = el('div', 'tx-wc-probe-head');
    head.appendChild(el('strong', null, 'Is it listening?'));
    head.appendChild(document.createTextNode(
      ' Nothing above answers that. This server can try the Tor address for you — '
      + 'which means sending it the address you pasted.'));
    wrap.appendChild(head);

    const actions = el('div', 'tx-wc-actions');
    const btn = el('button', 'tx-btn', 'Check over Tor');
    btn.type = 'button';
    actions.appendChild(btn);
    const status = el('span', 'tx-wc-probe-status');
    actions.appendChild(status);
    wrap.appendChild(actions);

    const box = el('div', 'tx-wc-probe-out');
    box.hidden = true;
    box.setAttribute('aria-live', 'polite');
    wrap.appendChild(box);

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      box.hidden = true;
      box.textContent = '';
      // Tor circuit-building is slow and retried once, so say so rather than
      // leaving a dead button for ten seconds.
      status.textContent = 'Asking over Tor — this can take a few seconds…';
      try {
        const r = await fetch('/api/wallet-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address })
        });
        let data = null;
        try { data = await r.json(); } catch { /* nginx's own 503 page is not JSON */ }
        if (!data || !('online' in data)) {
          data = { online: null, message: r.status === 503 || r.status === 429
            ? 'This server is refusing checks right now — it limits how often this can run. Try again in a minute.'
            : 'The check could not be completed here. This says nothing about the wallet.' };
        }
        renderProbeResult(box, data);
      } catch {
        renderProbeResult(box, { online: null,
          message: 'The request did not get through from your browser. This says nothing about the wallet.' });
      } finally {
        status.textContent = '';
        btn.disabled = false;
      }
    });

    return wrap;
  }

  function render(out, res) {
    out.textContent = '';
    out.hidden = false;

    const verdict = el('div', 'tx-wc-verdict ' + (res.ok ? 'is-ok' : 'is-bad'));
    verdict.appendChild(el('span', 'tx-wc-mark', res.ok ? '✓' : '✕'));
    verdict.appendChild(el('span', 'tx-wc-verdict-text',
      res.ok ? 'Checksum valid — this is a well-formed Slatepack address.' : res.message));
    out.appendChild(verdict);

    if (!res.ok) return;

    const rows = el('div', 'tx-rows');
    rows.appendChild(row('Network',
      (res.network === 'mainnet' ? 'Mainnet' : 'Testnet') + ' — prefix "' + res.hrp + '"'));
    rows.appendChild(row('Public key', res.pubkeyHex, res.pubkeyHex));
    rows.appendChild(row('Tor address', res.onion, res.onion));
    out.appendChild(rows);

    const note = el('div', 'tx-note');
    note.appendChild(el('strong', null, 'This does not mean the wallet is online.'));
    note.appendChild(document.createTextNode(
      ' Everything above is derived from the address itself. Whether anything is ' +
      'listening at that Tor address is a separate question' +
      (probeEnabled() ? ' — the one below.' : ' this page does not ask.')));
    out.appendChild(note);

    // Only when the server has the probe switched on. Otherwise the tile stays
    // exactly as it shipped in Part 3: complete, offline, and honest about it.
    if (probeEnabled()) out.appendChild(probeSection(res.address));
  }

  // ── Page copy follows the capability, not the other way round ───────────────
  //
  // The static HTML describes the tier-1-only page, and it still does even
  // though a freshly installed box now has the probe ON. The reason changed: it
  // is no longer "that is what ships", it is that THE BUTTON IS BUILT BY THIS
  // SCRIPT. A visitor whose browser never runs this file has no control on the
  // page whatever config.json says, so static copy promising a liveness check
  // would over-promise in exactly the state that cannot deliver it.
  //
  // What the static copy must no longer do is the mirror of that. It used to
  // say "this server does not offer the optional Tor liveness check" — a claim
  // about the SERVER, which is false on most deployments now. It is written
  // config-neutral instead: it says what this page has done, never what the box
  // is capable of, so it is true in all four combinations of flag and script.
  //
  // So when the probe IS on, the hedged phrasing is replaced here with definite
  // phrasing. Nothing on this page may say "where this server offers…": the page
  // KNOWS which server it is on (window.TINYEXP_WALLET_PROBE is injected per
  // request), and making the visitor guess which half of a conditional applies
  // to them is not caution, it is just an unanswered question.
  function applyProbeCopy() {
    if (!probeEnabled()) return;

    // REBUILT, not appended to. The static lede ends "with nothing sent
    // anywhere" — true of the page that ships, and false the moment a probe
    // button exists below it. Appending the second question left that absolute
    // standing in the same paragraph, so the lede both promised and withdrew
    // the same guarantee and the visitor had to work out which half was live.
    // The claim is narrowed to the part that is still unconditionally true —
    // the address check — and the network call is named in the same breath.
    const lede = document.getElementById('wc-lede');
    if (lede) {
      lede.textContent = '';
      lede.appendChild(document.createTextNode('A Slatepack address is a '));
      lede.appendChild(el('strong', null, '32-byte public key'));
      lede.appendChild(document.createTextNode(
        ' wearing a checksum. Paste one to see whether it survived the copy intact, which '
        + 'network it belongs to, and the '));
      lede.appendChild(el('strong', null, 'Tor address'));
      lede.appendChild(document.createTextNode(
        ' the same key derives to — all worked out in this page, with the address itself never '
        + 'leaving your browser. Then, if you want it, one more question this server can put to '
        + 'the network on your behalf: '));
      lede.appendChild(el('strong', null, 'is that wallet answering right now?'));
    }

    const note = document.getElementById('wc-scope-note');
    if (note) {
      note.textContent = '';
      note.appendChild(el('strong', null, 'Two checks, and only the second one connects.'));
      note.appendChild(document.createTextNode(
        ' Pasting an address makes no connection at all — not to that wallet, not to Tor, not to '
        + 'any server; an address can be perfectly valid while the wallet behind it has been '
        + 'offline for a year. Whether it is answering is a separate question, and this server '
        + 'can try the wallet\'s Tor address for you. That check appears as a button once you '
        + 'check an address, it sends the address to this server, and nothing leaves your '
        + 'browser until you press it.'));
    }

    const li = document.getElementById('wc-detail-live');
    if (li) {
      li.textContent = '';
      li.appendChild(el('strong', null,
        'The address check does not say the wallet is listening — the Tor check does.'));
      li.appendChild(document.createTextNode(
        ' The .onion shown is arithmetic on the address, not evidence that anything answers '
        + 'there. Press "Check over Tor" and this server dials that onion and asks a real '
        + 'grin-wallet question (check_version); a reply proves a wallet is there — even a '
        + 'refusal to authenticate counts, because only a wallet could refuse. The answer has '
        + 'three outcomes, not two: answering, not answering, and "we could not check", which '
        + 'is about this server and not about your wallet. Collapsing that third one into '
        + '"offline" would blame you for our outage.'));
    }
  }

  function initWalletCheck() {
    const input = document.getElementById('wc-input');
    const out   = document.getElementById('wc-out');
    if (!input || !out) return;

    applyProbeCopy();

    const btn   = document.getElementById('wc-check');
    const clear = document.getElementById('wc-clear');

    function run() {
      const v = input.value.trim();
      if (!v) { out.hidden = true; out.textContent = ''; return; }
      render(out, checkAddress(v));
    }

    if (btn) btn.addEventListener('click', run);
    if (clear) clear.addEventListener('click', () => {
      input.value = ''; out.hidden = true; out.textContent = ''; input.focus();
    });
    input.addEventListener('input', run);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); run(); }
    });

    // Deep link: /wallet-check?a=<address>, the same convenience /slate?s= has.
    // Nothing here ever puts the address into the URL itself — a query string
    // is the one place a checked address could leak into a browser history or
    // a referrer, so it stays the link author's deliberate choice.
    try {
      const q = new URLSearchParams(location.search).get('a');
      if (q) { input.value = q; run(); }
    } catch { /* no-op */ }
  }

  const api = {
    checkAddress,
    onionV3FromPubkey,
    sha3_256,
    initWalletCheck,
    _internal: { base32LowerNoPad, keccakF, render, probeEnabled, renderProbeResult, applyProbeCopy, PROBE_STATE }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WalletCheck = api;

  // Self-initialising, like slate-ui.js: this file is only loaded by the page
  // that needs it, so it does not go through tiny-explorer.js's page router.
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initWalletCheck);
    } else {
      initWalletCheck();
    }
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
