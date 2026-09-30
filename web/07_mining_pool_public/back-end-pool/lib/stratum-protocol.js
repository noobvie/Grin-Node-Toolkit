'use strict';

// Grin stratum protocol message builders.
// Reference: https://github.com/mimblewimble/grin/blob/master/doc/stratum.md
// Messages are newline-delimited JSON over a plain TCP socket.
// Protocol methods used:
//   client → server: login, submit, getjobtemplate, status
//   server → client: job (push), and responses to the above

function parseStratumMessage(jsonStr) {
  try {
    const msg = JSON.parse(jsonStr.trim());
    // u64 nonce guard: JSON.parse rounds integers past 2^53, so a miner's nonce like
    // 17293822569102704642 silently becomes …640 — the node then rejects the share as
    // "Invalid PoW" (its log shows nonces ending in zeros). Re-extract the literal
    // digits and carry the nonce as a STRING; NodeStratumClient.send() re-emits it as
    // a bare number on the node's wire.
    if (msg && msg.params && msg.params.nonce !== undefined) {
      const m = jsonStr.match(/"nonce"\s*:\s*(\d+)/);
      if (m) msg.params.nonce = m[1];
    }
    return msg;
  } catch {
    return null;
  }
}

// Validate a Grin address with optional .worker_name suffix and optional donation token.
// The worker part (everything after the first '.') is case-folded to lowercase BEFORE the grammar
// runs, so `MyBrand-donate10` logs in as worker `mybrand-donate10` donating 10 %. The ADDRESS is
// never folded — grin never emits uppercase bech32 and mixed case is invalid bech32, so `GRIN1…`
// stays refused (design §16.2). Until 2026-09-21 an uppercase worker was refused at login.
// Bech32 charset excludes b, i, o, 1 → [ac-hj-np-z02-9]
// A Grin Slatepack address is the bech32 encoding of a 32-byte ed25519 key:
// 52 data symbols + 6 checksum symbols = 58 bech32 chars after the prefix.
// Mainnet: grin1 + 58 bech32 chars = 63 chars total
// Testnet: tgrin1 + 58 bech32 chars = 64 chars total
//
// Donation (register-free, self-service): a `donateN` token in the worker name donates N% of
// the PPLNS credit THAT RIG's shares earn to the pool prize pool — per share, read when a block
// matures (lib/rewards.js, design §18.2); the address's other rigs are unaffected and nothing is
// stored. Rename the rig and restart the miner to change or stop it. It can be the whole worker
// name or a `-`/`_`-separated suffix. The `+` form is deliberately NOT used — some miners read
// a `+NNNN` username suffix as a fixed-difficulty request.
//   grin1abc….donate10      → worker "donate10",       this rig donates 10%
//   grin1abc….rig01-donate10 → worker "rig01-donate10", this rig donates 10%
//   grin1abc….rig01          → worker "rig01",          no donation
// The token is READ, never stripped: the worker label is whatever the miner typed. Until
// 2026-09-21 it was cut out (`.donate10` became worker "default"), and the first miner to try it
// read that as a bug — nothing on screen said why their name had changed. The literal name is
// also the one place a miner can SEE that a donation is set on this rig, which is what audit
// §J3-5 wanted: a tag that reduces earnings must not be invisible.
// Edge handling: only N in 1-100 donates (donate0 is a tag of 0 %, the same as no tag). Anything else is
// treated as NOT a donation and kept as a literal worker name — a typo like `donate101`,
// `donate999`, `donate-1`, `donatexx`, or `donate` alone never causes an accidental donation.
//
// Worker label length — accept-and-shorten, never reject a realistic login:
//   · The *visible* label is capped at MAX_WORKER_NAME_LEN and a longer one is TRUNCATED, not
//     rejected — a miner with a long rig name still connects and just shows a tidy shortened
//     label in public stats.
//   · MAX_WORKER_RAW_LEN is the raw accept ceiling (label + any donate token). It exists ONLY to
//     refuse pathological/abuse input; it sits above a full 32-char label + the longest
//     `-donate100` token (32 + 10 = 42 < 48), so no real miner is ever rejected for length.
//
// Why the token is parsed from the FULL raw suffix before any cut: it lives at the END of the
// name, so a plain slice(0,N) would silently corrupt it — `…rig-donate100` clipped to
// `…rig-donate10` would donate 10% instead of 100%, or drop the donation entirely. The
// donation % is therefore always honored no matter how long the raw name was; and when a
// name that carries a token must be shortened, the cut lands on the label part so the token
// stays visible — the shortened label must not hide the cue the full one gave. The cut label
// also loses any trailing `-`/`_`, so it never reads `…long--donate100`.
// ── bech32 checksum (BIP-173) ───────────────────────────────────────────────────────────
// A Grin Slatepack address is `bech32::encode(hrp, ed25519_pubkey.to_base32())` — the CLASSIC
// bech32 variant (checksum constant 1), not bech32m: grin-wallet pins the `bech32` 0.7 crate,
// which predates the variant split. So the last 6 symbols of every address are a checksum over
// the other 52, and verifying it is the difference between "looks like an address" and "is one".
//
// Why this is here at all (audit §J6-6): validateUsername used to check the bech32 CHARSET and
// the length and stop. Any 58 charset-valid characters were therefore a working stratum login,
// which (a) gave an anonymous client an unbounded supply of distinct addresses, each of which
// took a miner_accounts row plus three synchronous statements on the shared DB at login, and
// (b) silently accepted a miner who fat-fingered one character of their own address and then
// accrued a balance to a key nobody holds. The checksum catches exactly (b) — that is what it
// was designed for — and puts a real cost on (a).
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk >>> 0;
}

// hrp expansion per BIP-173: high bits, a 0 separator, then low bits.
function bech32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

// Verify the 6-symbol checksum of `data` (the part AFTER the '1' separator) against `hrp`.
// Lowercase only — grin never emits an uppercase address and mixed case is invalid bech32.
function bech32ChecksumValid(hrp, data) {
  if (typeof hrp !== 'string' || typeof data !== 'string') return false;
  if (data.length < 6) return false;
  const values = [];
  for (const ch of data) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v < 0) return false;              // outside the charset (the regex already refuses these)
    values.push(v);
  }
  return bech32Polymod(bech32HrpExpand(hrp).concat(values)) === 1;
}

const MAX_WORKER_NAME_LEN = 32;   // visible label; 25 until 2026-09-21 (a 27-char brand was clipped)
const MAX_WORKER_RAW_LEN = 48;    // raw accept ceiling, label + token; was 40

// The donate token: the whole worker name, or a `-`/`_`-separated suffix. dm[1] is the label
// (undefined when the token is the whole name), dm[2] the digits. ONE definition — validateUsername
// parses logins with it, and parseDonateToken() is what rewards.js reads PER SHARE to move money
// (design §18.2) and what every live "who is donating" reading uses, so the login, the money and
// the display can never disagree about whether a rig is tagged.
const DONATE_TOKEN_RE = /^(?:(.*?)[-_])?donate(\d{1,3})$/;

// { label, percent } for a worker name that carries a LIVE token (0-100), else null. An
// out-of-range `donate101` is a plain name here exactly as it is at login — a typo donates
// nothing and is not "tagged".
function parseDonateToken(workerName) {
  const dm = String(workerName == null ? '' : workerName).match(DONATE_TOKEN_RE);
  if (!dm) return null;
  const n = parseInt(dm[2], 10);
  if (n < 0 || n > 100) return null;
  return { label: dm[1] || '', percent: n };
}
// `network` — 'mainnet' | 'testnet'. When given, ONLY that chain's prefix is accepted.
//
// Why it must be given (audit §J17-4): a Slatepack address is bech32(hrp, ed25519_pubkey), and
// the SAME 32-byte key encodes to two different, fully-valid, checksum-correct strings depending
// on whether the hrp is `grin` or `tgrin`. Accepting both meant one miner could hold TWO
// miner_accounts rows — two balances, each measured separately against min_withdrawal, two
// ownership proofs, no way for the product to show they are the same key — and a MAINNET pool
// would credit real GRIN to a `tgrin1…` account and then hand it to `grin-wallet send -d`,
// which is chain-aware and refuses it. The result is a stuck payout on a balance the miner
// cannot move.
//
// §J6-6 added the checksum verification that closed the charset hole; it could not close this
// one, because the checksum is computed OVER the hrp — the two spellings are not each other's
// typo, they are two correct encodings. Only the pool's own network settles which is right.
//
// The parameter is optional so the BIP-173 vector tests can exercise the encoding alone, but
// every production call site passes it. It is checked BEFORE the checksum so a wrong-network
// address is rejected on identity, not on a technicality.
function validateUsername(username, network = null) {
  if (!username || typeof username !== 'string') return null;

  // Case-fold the WORKER part only: split at the first '.', fold ASCII A-Z after it, and leave
  // the address exactly as typed so an uppercase address still fails the bech32 regex below.
  // ASCII only on purpose — toLowerCase() maps a few non-ASCII letters INTO the charset
  // (U+212A KELVIN SIGN → 'k'), and a byte outside [a-z0-9_-] should keep failing the grammar,
  // not be quietly adopted.
  const dot = username.indexOf('.');
  if (dot !== -1) {
    username = username.slice(0, dot) + username.slice(dot).replace(/[A-Z]/g, c => c.toLowerCase());
  }

  const bech32 = '[ac-hj-np-z02-9]';
  const re = new RegExp(`^(grin1|tgrin1)(${bech32}{58})(\\.([a-z0-9_-]{1,${MAX_WORKER_RAW_LEN}}))?$`);
  const m = username.match(re);
  if (!m) return null;

  if (network) {
    const want = network === 'mainnet' ? 'grin1' : 'tgrin1';
    if (m[1] !== want) return null;
  }

  // Charset + length are not identity — verify the checksum those last 6 symbols ARE (§J6-6).
  // m[1] is the prefix INCLUDING the '1' separator, so the hrp is it minus the last character.
  if (!bech32ChecksumValid(m[1].slice(0, -1), m[2])) return null;

  let worker_name = m[4] || 'default';
  let donation_percent = null;

  // Read a `donateN` token: whole worker name, or a `-`/`_`-separated suffix. Only apply it
  // when N is a sane percentage (0-100); out-of-range is a typo and donates nothing. The
  // worker name is left exactly as typed either way (see the note above).
  const dm = worker_name.match(DONATE_TOKEN_RE);
  if (dm) {
    const n = parseInt(dm[2], 10);
    if (n >= 0 && n <= 100) donation_percent = n;
  }

  // Cap the visible label: truncate (don't reject) anything over the limit. A name carrying a
  // live token is cut on its LABEL part so the token stays on screen (`-donate100` is 10 chars,
  // so at least 22 of the label survive); a whole-name token is ≤ 9 chars and never gets here.
  // The cut label loses any trailing '-'/'_' so the join never doubles a separator:
  // `rig-name-that-is-long-enough-donate100` → `rig-name-that-is-long-donate100`, not `…long--donate100`.
  // Keeping the token intact matters more since design §18.2: the stored worker name is now the
  // ONLY donation input (rewards.js reads it per share), so a cut token would change the money.
  if (worker_name.length > MAX_WORKER_NAME_LEN) {
    if (donation_percent !== null) {
      const label = dm[1] || '';
      const token = worker_name.slice(label.length);       // separator + donateN
      worker_name = label.slice(0, MAX_WORKER_NAME_LEN - token.length).replace(/[-_]+$/, '') + token;
    } else {
      worker_name = worker_name.slice(0, MAX_WORKER_NAME_LEN);
    }
  }

  // `donation_percent` is informational (the login log line, the grammar tests): nothing stores
  // it. The label in front of the token is only a rig name again — v1 captured it as a donor
  // name, which design §18.1 #3 removed along with the field that carried it.
  return {
    grin_address: m[1] + m[2],
    worker_name,
    donation_percent
  };
}

// ── Share work credit ──────────────────────────────────────────────────────────────────────
// The `difficulty` a job carries is the node's `minimum_share_difficulty` (grin-server.toml,
// default 1 — the toolkit never changes it). A miner submits a solution only when that
// solution's UNSCALED difficulty (2^64 / blake2b(packed nonces)) is ≥ the job value — see
// grin-miner cuckoo-miner/src/miner/miner.rs, which filters on `to_difficulty_unscaled()`.
// The chain does not count difficulty in that unit: a header's difficulty (and so the
// per-block network difficulty = total_difficulty delta) is the unscaled value × the graph
// weight, `(2 << (edge_bits − BASE_EDGE_BITS 24)) × edge_bits` = 16384 for Cuckatoo32. So one
// accepted share represents `job_difficulty × 16384` of chain-unit work, which is the number
// every consumer of shares.difficulty needs: /api/pool/effort divides the round's Σ by the
// per-block network difficulty, luck divides blocks.round_shares by the same, and the GPS
// formula divides by this very constant — `GPS = Σ × 42 / window / 16384` collapses to
// `shares × job_diff × 42 / window`, i.e. one C32 graph yields a 42-cycle about once in 42.
//
// Until 2026-09-20 every share was recorded at difficulty 1 — the session's never-tuned
// vardiff placeholder — and every derived figure (pool/miner/worker hashrate, the charts,
// round effort, luck) read 16384× too small: a rig turning in 30 shares an hour showed
// 0.00 G/s. db.js migrateShareCreditUnit rescales rows written before the fix.
//
// This credits the TARGET the miner was told, not the solution's actual difficulty (which is
// heavy-tailed — see the SHARE_CREDIT_DIFF note in scripts/lib/07_mining_block_collector.py).
// The pool does not recompute the proof hash; the node is the PoW authority and, at the
// default target of 1, every valid cycle is a share, so target and actual floor coincide.
const C32_GRAPH_WEIGHT = 16384;

function shareCreditDifficulty(jobDifficulty) {
  const d = Number(jobDifficulty);
  // Difficulty::from_num clamps at 1 in grin; a job can never ask for less.
  return (Number.isFinite(d) && d >= 1 ? d : 1) * C32_GRAPH_WEIGHT;
}

// Server → all miners: push a new job when the node finds a new block height.
// Miners must use the returned job_id in their submit.
function createJobNotification(jobId, height, difficulty, prePow) {
  return {
    id: 'Stratum',
    jsonrpc: '2.0',
    method: 'job',
    params: { difficulty, height, job_id: jobId, pre_pow: prePow }
  };
}

// Server → miner: response to "login"
function createLoginResponse(id, error = null) {
  return {
    id,
    jsonrpc: '2.0',
    method: 'login',
    result: error ? null : 'ok',
    error
  };
}

// Server → miner: response to "submit"
// blockHash is non-null when the submission solved a full block.
function createSubmitResponse(id, accepted, blockHash = null, error = null) {
  return {
    id,
    jsonrpc: '2.0',
    method: 'submit',
    result: accepted ? (blockHash ? `blockfound - ${blockHash}` : 'ok') : null,
    error: accepted ? null : { code: -1, message: error || 'Share rejected' }
  };
}

// Server → miner: response to "getjobtemplate"
// NOTE: the `method` field is REQUIRED. The Grin stratum convention (and the
// grin node's own stratum server) echoes the request method back in the
// response, and grin-miner's RpcResponse struct makes `method` non-optional AND
// routes on it (match res.method => "getjobtemplate"). Omitting it makes the
// response unparseable to grin-miner ("Error parsing response") even though the
// job still arrives via the `job` notification. Keep parity with createLogin/
// SubmitResponse, which already include it.
function createJobTemplateResponse(id, jobId, height, difficulty, prePow) {
  return {
    id,
    jsonrpc: '2.0',
    method: 'getjobtemplate',
    result: { difficulty, height, job_id: jobId, pre_pow: prePow },
    error: null
  };
}

// Server → miner: response to "status"
// sessionStats = { sessionId, height, difficulty, accepted, rejected, stale }
function createStatusResponse(id, sessionStats) {
  return {
    id,
    jsonrpc: '2.0',
    method: 'status',  // required — grin-miner routes responses on `method` (see createJobTemplateResponse)
    result: {
      id:         sessionStats.sessionId,
      height:     sessionStats.height,
      difficulty: sessionStats.difficulty,
      accepted:   sessionStats.accepted,
      rejected:   sessionStats.rejected,
      stale:      sessionStats.stale
    },
    error: null
  };
}

module.exports = {
  parseStratumMessage,
  validateUsername,
  C32_GRAPH_WEIGHT,
  shareCreditDifficulty,
  bech32ChecksumValid,   // exported for scripts/test-stratum-guards.js (BIP-173 vectors)
  MAX_WORKER_NAME_LEN,
  parseDonateToken,      // THE donation input (rewards.js, per share) + every live reading — one grammar
  createJobNotification,
  createLoginResponse,
  createSubmitResponse,
  createJobTemplateResponse,
  createStatusResponse
};
