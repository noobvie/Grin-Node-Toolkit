'use strict';

// ── Slatepack decoder — pure JS, zero dependencies, 100% client-side ──────────
//
// Reads an armored Grin slatepack (BEGINSLATEPACK. … ENDSLATEPACK.) and returns
// the human-readable facts inside it. Nothing is sent to the server: the whole
// pipeline runs in the visitor's browser, so a pasted slate never leaves the
// machine. Also loadable under Node (for the test harness) — it only relies on
// WebCrypto (`globalThis.crypto.subtle`), present in browsers and Node 18+.
//
// WIRE FORMAT (verified against mimblewimble/grin-wallet libwallet/src/slatepack/
// {armor.rs,types.rs,address.rs} + slate_versions/v4_bin.rs, and RFC-0015):
//
//   ARMOR      "BEGINSLATEPACK." <SimpleBase58Check> ". ENDSLATEPACK."
//              SimpleBase58Check = base58( first4(SHA256(SHA256(bin))) || bin )
//              Formatting only: a space every 15 chars, newline every 200 words.
//              NO compression at any layer (no deflate/zlib).
//
//   ENVELOPE   version        2 bytes  (major u8, minor u8)
//              mode           1 byte   (0 = plaintext, 1 = age-encrypted)
//              opt flags      2 bytes  (u16; bit 0x01 = sender present)
//              bytes_to_pay   4 bytes  (u32; length of the optional-field block)
//              [sender]       u8 len + bech32 STRING  (only when flag 0x01)
//              payload        u64 length prefix + bytes
//
//   PAYLOAD    SlateV4 BINARY (VersionedBinSlate), never JSON in practice.
//
// MODE 1 IS OPAQUE BY DESIGN. When mode == 1 the wallet MOVES the sender out of
// the header into the age-encrypted metadata (header sender = None). So for an
// encrypted slatepack a keyless reader can only ever recover the version and the
// mode — no sender, no network, no amount. That is not a gap in this decoder; it
// is the privacy property of the format. Only the recipient's wallet can open it.
//
// NETWORK DETECTION. SlateV4 carries NO chain/network/genesis field whatsoever —
// which is exactly why a testnet slate can be signed by a mainnet wallet and only
// fails at broadcast. The one network signal available is the bech32 HRP of the
// sender address: "grin" = mainnet, "tgrin" = testnet.

(function (root) {

  // ── base58 (Bitcoin alphabet, as used by the `bs58` crate) ─────────────────

  const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const B58_MAP = (() => {
    const m = Object.create(null);
    for (let i = 0; i < B58_ALPHABET.length; i++) m[B58_ALPHABET[i]] = i;
    return m;
  })();

  // Classic byte-array long division — avoids BigInt so multi-KB slates stay fast.
  function base58Decode(str) {
    const bytes = [0];
    for (const ch of str) {
      const val = B58_MAP[ch];
      if (val === undefined) throw new SlatepackError(`Invalid base58 character "${ch}"`, 'armor');
      let carry = val;
      for (let j = 0; j < bytes.length; j++) {
        carry += bytes[j] * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    // Every leading '1' is a literal leading zero byte.
    for (let k = 0; k < str.length && str[k] === '1'; k++) bytes.push(0);
    return new Uint8Array(bytes.reverse());
  }

  // ── bech32 (validation only — we need the HRP, but refuse to trust a bad sum) ─

  const B32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

  function b32Polymod(values) {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
    }
    return chk;
  }

  function b32HrpExpand(hrp) {
    const out = [];
    for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
    out.push(0);
    for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
    return out;
  }

  // → { hrp, words } or null. Mirrors web/093_transporter/server.js bech32Decode.
  function bech32Decode(str) {
    if (typeof str !== 'string') return null;
    if (str.length < 8 || str.length > 120) return null;
    if (str !== str.toLowerCase() && str !== str.toUpperCase()) return null;
    str = str.toLowerCase();
    const pos = str.lastIndexOf('1');
    if (pos < 1 || pos + 7 > str.length) return null;
    const hrp = str.slice(0, pos);
    const words = [];
    for (const c of str.slice(pos + 1)) {
      const v = B32_CHARSET.indexOf(c);
      if (v === -1) return null;
      words.push(v);
    }
    if (b32Polymod(b32HrpExpand(hrp).concat(words)) !== 1) return null;
    return { hrp, words: words.slice(0, -6) };
  }

  function wordsToBytes(words) {
    let acc = 0, bits = 0;
    const out = [];
    for (const w of words) {
      acc = (acc << 5) | w;
      bits += 5;
      while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
    }
    if (bits >= 5 || ((acc << (8 - bits)) & 0xff)) return null;
    return new Uint8Array(out);
  }

  // ── Big-endian byte reader (grin's ser is big-endian throughout) ────────────

  class Reader {
    constructor(bytes) { this.b = bytes; this.o = 0; }
    _need(n, what) {
      if (this.o + n > this.b.length) {
        throw new SlatepackError(`Truncated slatepack: wanted ${n} more byte(s) for ${what}`, 'binary');
      }
    }
    u8(what)  { this._need(1, what); return this.b[this.o++]; }
    u16(what) { this._need(2, what); const v = (this.b[this.o] << 8) | this.b[this.o + 1]; this.o += 2; return v; }
    u32(what) {
      this._need(4, what);
      const v = ((this.b[this.o] << 24) >>> 0) + (this.b[this.o + 1] << 16) + (this.b[this.o + 2] << 8) + this.b[this.o + 3];
      this.o += 4; return v >>> 0;
    }
    // u64 → BigInt, never Number. Amounts are nanogrin (u64); anything above
    // 2^53 would silently round in a JS Number — the same class of bug that bit
    // the PoW nonce in tiny-explorer-server.js.
    u64(what) {
      this._need(8, what);
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(this.b[this.o + i]);
      this.o += 8; return v;
    }
    bytes(n, what) { this._need(n, what); const s = this.b.slice(this.o, this.o + n); this.o += n; return s; }
    get remaining() { return this.b.length - this.o; }
  }

  class SlatepackError extends Error {
    constructor(message, stage) { super(message); this.name = 'SlatepackError'; this.stage = stage || 'unknown'; }
  }

  // ── SHA-256 (WebCrypto). Absent on plain-HTTP origins → skip the checksum ────

  async function sha256(bytes) {
    const subtle = root.crypto && root.crypto.subtle;
    if (!subtle) return null;                       // caller degrades gracefully
    const digest = await subtle.digest('SHA-256', bytes);
    return new Uint8Array(digest);
  }

  // ── Armor ──────────────────────────────────────────────────────────────────

  function looksLikeSlatepack(text) {
    return typeof text === 'string'
      && text.includes('BEGINSLATEPACK')
      && text.includes('ENDSLATEPACK');
  }

  // Strip the framing and every character the armor uses purely for layout. The
  // payload is base58, which never contains whitespace, '.' or '>' — so removing
  // them is lossless and makes email-quoted ("> BEGINSLATEPACK…") pastes work.
  function stripArmor(text) {
    const begin = text.indexOf('BEGINSLATEPACK');
    const end   = text.indexOf('ENDSLATEPACK');
    if (begin === -1 || end === -1 || end <= begin) {
      throw new SlatepackError('No BEGINSLATEPACK … ENDSLATEPACK block found', 'armor');
    }
    const body = text.slice(begin + 'BEGINSLATEPACK'.length, end);
    const cleaned = body.replace(/[\s>.]+/g, '');
    if (!cleaned) throw new SlatepackError('Slatepack body is empty', 'armor');
    return cleaned;
  }

  // ── SlateV4 state (`sta`) ──────────────────────────────────────────────────
  //
  // Binary encodes the state as a u8 in SlateStateV4 declaration order. The
  // familiar "S1"/"I2" strings are the JSON form only.
  const SLATE_STATES = {
    0: { code: 'NA', label: 'Unknown',    flow: null },
    1: { code: 'S1', label: 'Standard 1', flow: 'standard' },
    2: { code: 'S2', label: 'Standard 2', flow: 'standard' },
    3: { code: 'S3', label: 'Standard 3', flow: 'standard' },
    4: { code: 'I1', label: 'Invoice 1',  flow: 'invoice'  },
    5: { code: 'I2', label: 'Invoice 2',  flow: 'invoice'  },
    6: { code: 'I3', label: 'Invoice 3',  flow: 'invoice'  },
  };

  // Plain-English "what is this and whose move is it" for each round.
  const STATE_GUIDE = {
    S1: {
      title: 'Payment offer — awaiting the receiver',
      step: 1, of: 3,
      whose: 'receiver',
      says: 'The sender has built a payment and is offering it to you.',
      next: 'Receive this in your wallet, then send the resulting slatepack back to the sender.',
    },
    S2: {
      title: 'Signed by the receiver — awaiting the sender',
      step: 2, of: 3,
      whose: 'sender',
      says: 'The receiver has added their output and signed.',
      next: 'The SENDER finalizes this and broadcasts it to the network.',
    },
    S3: {
      title: 'Finalized',
      step: 3, of: 3,
      whose: null,
      says: 'This transaction is complete and ready to post (or already posted).',
      next: 'Nothing to do — check the kernel on-chain to confirm it settled.',
    },
    I1: {
      title: 'Invoice — you are being asked to pay',
      step: 1, of: 3,
      whose: 'payer',
      says: 'Someone has issued an invoice requesting this amount FROM you.',
      next: 'Verify the amount, then pay it in your wallet and send the result back.',
    },
    I2: {
      title: 'Invoice paid — awaiting the invoicer',
      step: 2, of: 3,
      whose: 'invoicer',
      says: 'The payer has signed and is returning the paid invoice.',
      next: 'The INVOICER finalizes this and broadcasts it to the network.',
    },
    I3: {
      title: 'Finalized',
      step: 3, of: 3,
      whose: null,
      says: 'This invoice is complete and ready to post (or already posted).',
      next: 'Nothing to do — check the kernel on-chain to confirm it settled.',
    },
    NA: {
      title: 'Unknown state',
      step: null, of: null,
      whose: null,
      says: 'This slate does not declare a recognised transaction state.',
      next: 'Treat with caution — it may be malformed or from a newer slate version.',
    },
  };

  // ── Helpers ────────────────────────────────────────────────────────────────

  function toHex(bytes) {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
  }

  function formatUuid(b16) {
    const h = toHex(b16);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  const NANO = 1000000000n;

  // nanogrin (BigInt) → decimal GRIN string, exact, no float anywhere.
  function formatGrin(nano) {
    const neg   = nano < 0n;
    const abs   = neg ? -nano : nano;
    const whole = abs / NANO;
    const frac  = (abs % NANO).toString().padStart(9, '0').replace(/0+$/, '');
    const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + wholeStr + (frac ? '.' + frac : '');
  }

  // grin packs the fee as FeeFields: low 40 bits = fee, bits 40-43 = fee_shift.
  // Masking is safe for the older plain-u64 form too — real fees are far below
  // 2^40 nanogrin, so the masked value is identical either way.
  const FEE_MASK = (1n << 40n) - 1n;
  function unpackFee(raw) {
    return { fee: raw & FEE_MASK, feeShift: Number((raw >> 40n) & 0xfn) };
  }

  function networkFromAddress(addr) {
    if (!addr) return { network: 'unknown', hrp: null, valid: false };
    const dec = bech32Decode(addr);
    if (!dec) return { network: 'unknown', hrp: null, valid: false };
    const key = wordsToBytes(dec.words);
    const valid = !!key && key.length === 32;
    const network = dec.hrp === 'grin' ? 'mainnet'
      : dec.hrp === 'tgrin' ? 'testnet'
      : 'unknown';
    return { network, hrp: dec.hrp, valid };
  }

  // ── Envelope ───────────────────────────────────────────────────────────────

  function parseEnvelope(bin) {
    const r = new Reader(bin);
    const versionMajor = r.u8('version major');
    const versionMinor = r.u8('version minor');
    const mode         = r.u8('mode');
    const flags        = r.u16('optional flags');
    const bytesToPayload = r.u32('bytes-to-payload');

    const optStart = r.o;
    let sender = null;
    if (flags & 0x01) {
      const len = r.u8('sender length');
      sender = new TextDecoder().decode(r.bytes(len, 'sender address'));
    }

    // Jump using bytes_to_payload rather than trusting our own field walk — the
    // field exists precisely so unknown/new optional fields can be skipped.
    r.o = optStart + bytesToPayload;
    if (r.o > bin.length) throw new SlatepackError('bytes-to-payload points past end of data', 'binary');

    const payloadLen = r.u64('payload length');
    if (payloadLen > BigInt(r.remaining)) {
      throw new SlatepackError('Declared payload length exceeds available bytes', 'binary');
    }
    const payload = r.bytes(Number(payloadLen), 'payload');

    return { versionMajor, versionMinor, mode, flags, sender, payload };
  }

  // ── SlateV4 (binary) ───────────────────────────────────────────────────────
  //
  // Only the head of the slate is parsed: ver → id → sta → off → optional fields.
  // Everything of interest to a human (amount, fee, state, participants) lives in
  // that prefix; `sigs`/`coms`/`proof` follow and are deliberately NOT walked —
  // they add no readable value and their variable shapes are the likeliest source
  // of a parse failure. Refusing to parse them keeps the headline facts robust.
  function parseSlateV4Bin(payload) {
    const r = new Reader(payload);
    const verSlate  = r.u16('slate version');
    const verHeader = r.u16('block header version');
    const idBytes   = r.bytes(16, 'slate uuid');
    const staRaw    = r.u8('slate state');
    r.bytes(32, 'offset (blinding factor)');

    const status = r.u8('optional-field status byte');
    let numParts = 2;      // defaults per SlateOptFields
    let amount   = 0n;
    let feeRaw   = 0n;
    let features = 0;
    let ttl      = 0n;

    if (status & 0x01) numParts = r.u8('num_parts');
    if (status & 0x02) amount   = r.u64('amount');
    if (status & 0x04) feeRaw   = r.u64('fee');
    if (status & 0x08) features = r.u8('kernel features');
    if (status & 0x10) ttl      = r.u64('ttl cutoff height');

    const state = SLATE_STATES[staRaw] || SLATE_STATES[0];
    const { fee, feeShift } = unpackFee(feeRaw);

    return {
      slateVersion:  `${verSlate}:${verHeader}`,
      id:            formatUuid(idBytes),
      state:         state.code,
      stateLabel:    state.label,
      flow:          state.flow,
      stateRaw:      staRaw,
      numParts,
      amount,                      // BigInt nanogrin
      amountGrin:    formatGrin(amount),
      fee,                         // BigInt nanogrin
      feeGrin:       formatGrin(fee),
      feeShift,
      kernelFeatures: features,
      ttlCutoffHeight: ttl,
      guide:         STATE_GUIDE[state.code] || STATE_GUIDE.NA,
    };
  }

  // ── Public entry point ─────────────────────────────────────────────────────
  //
  // Resolves to a result object; throws SlatepackError only when the input is
  // not a decodable slatepack at all. An encrypted (mode 1) slatepack is a
  // SUCCESS with `encrypted: true` and no slate — not an error.
  async function decodeSlatepack(text) {
    if (!looksLikeSlatepack(text)) {
      throw new SlatepackError('That does not look like a slatepack — expected a BEGINSLATEPACK … ENDSLATEPACK block.', 'armor');
    }

    const b58 = stripArmor(text);
    const raw = base58Decode(b58);
    if (raw.length < 5) throw new SlatepackError('Slatepack is too short to contain a checksum', 'armor');

    const check = raw.slice(0, 4);
    const bin   = raw.slice(4);

    // SimpleBase58Check: first four bytes of SHA256(SHA256(binary)).
    let checksumOk = null;                        // null = could not be verified
    const once = await sha256(bin);
    if (once) {
      const twice = await sha256(once);
      checksumOk = twice.slice(0, 4).every((b, i) => b === check[i]);
      if (!checksumOk) {
        throw new SlatepackError('Checksum mismatch — the slatepack is corrupt or was truncated in transit.', 'checksum');
      }
    }

    const env = parseEnvelope(bin);
    const encrypted = env.mode === 1;
    const net = networkFromAddress(env.sender);

    const result = {
      ok: true,
      checksumOk,
      slatepackVersion: `${env.versionMajor}.${env.versionMinor}`,
      mode: env.mode,
      encrypted,
      sender: env.sender,
      senderValid: net.valid,
      network: net.network,
      hrp: net.hrp,
      payloadBytes: env.payload.length,
      slate: null,
      slateError: null,
    };

    if (encrypted) return result;                 // opaque by design — stop here

    try {
      result.slate = parseSlateV4Bin(env.payload);
    } catch (e) {
      // Envelope-level facts stay trustworthy even when the slate body doesn't
      // parse (e.g. a future slate version) — surface both rather than failing.
      result.slateError = e.message;
    }
    return result;
  }

  const api = {
    decodeSlatepack,
    looksLikeSlatepack,
    SlatepackError,
    // exported for the test harness / reuse
    _internal: { base58Decode, bech32Decode, stripArmor, parseEnvelope, parseSlateV4Bin, formatGrin, networkFromAddress },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SlatepackDecode = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
