'use strict';

// Asks the chain about submits whose reply can no longer arrive. A submit that dies with the node
// link, or outlives the late-reply window, may still have been a block: the node took it, and the
// answer was lost. The reward then reaches the wallet with no `blocks` row, which looks exactly
// like bad luck.
//
// Each height costs one header read, however many submits it holds. A match is reported, not
// credited: the operator enters the block by hand. Nothing here touches the database.
//
// Matching takes two steps, because the node sends a header's nonce as a bare JSON number, so a
// u64 above 2^53 arrives rounded while the pool holds the exact string. Number(nonce) rounds both
// sides alike and finds the submits it could be, and a rig stepping nonces by one puts many
// neighbours on one key. The proof then picks the exact submit. A proof that matches none of them
// still reports them all: a false report costs a person a look, a missed block costs a reward.
//
// Held in memory only: a pool restart forgets what it held.

const RETRY_MS = 60 * 1000;
// One hour of retries at the default rate: long enough for a node restart and a compaction freeze.
const MAX_ATTEMPTS = 60;
// A stall can hand over every share miners send. Plain candidates are small, so this bounds memory
// at tens of MB. Past it new submits go unchecked, and the next report says how many.
const MAX_CANDIDATES = 100000;
// Blocks already reported, so a repeat of the same submit is not a second alert.
const REPORTED_KEEP = 100;

class LostBlockCheck {
  // getHeader(height) → { nonce, hash, cuckoo_solution }, throwing while the node cannot answer or
  // lacks the height. onFound(candidates, header) and onGaveUp([{ height, submits }], why, dropped)
  // report the outcomes, and must throw if the report was not stored: the height is then retried.
  constructor({
    getHeader, onFound, onGaveUp,
    retryMs = RETRY_MS, maxAttempts = MAX_ATTEMPTS, maxCandidates = MAX_CANDIDATES,
  }) {
    this.getHeader = getHeader;
    this.onFound = onFound;
    this.onGaveUp = onGaveUp;
    this.retryMs = retryMs;
    this.maxAttempts = maxAttempts;
    this.maxCandidates = maxCandidates;
    this.heights = new Map();   // height → { nonces: Map<number, candidate[]>, attempts }
    this.total = 0;
    this.dropped = 0;
    this.reported = new Set();
    this.timer = null;
    this.running = false;
    this.stopped = false;
  }

  // Heights still waiting for an answer.
  get size() {
    return this.heights.size;
  }

  // candidates: [{ height, nonce, pow, miner, feePercent }]
  add(candidates) {
    for (const c of candidates) {
      if (!c || !Number.isSafeInteger(c.height)) continue;
      if (this.total >= this.maxCandidates) { this.dropped += 1; continue; }
      let entry = this.heights.get(c.height);
      if (!entry) {
        entry = { nonces: new Map(), attempts: 0 };
        this.heights.set(c.height, entry);
      }
      const key = Number(c.nonce);
      const held = entry.nonces.get(key);
      if (held) held.push(c); else entry.nonces.set(key, [c]);
      entry.attempts = 0;   // a newcomer gets the full retry budget
      this.total += 1;
    }
    this._schedule(0);
  }

  _schedule(ms) {
    if (this.stopped || this.timer || this.running || this.heights.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run().catch((err) => console.error(`[lost-block-check] ${err.message}`));
    }, ms);
    if (this.timer.unref) this.timer.unref();
  }

  _submits(entry) {
    let n = 0;
    for (const held of entry.nonces.values()) n += held.length;
    return n;
  }

  _forget(height, entry) {
    this.total -= this._submits(entry);
    this.heights.delete(height);
  }

  // The submit whose proof is the block's, or every submit on this nonce key if none is.
  _bestMatch(held, header) {
    const solution = header.cuckoo_solution;
    if (!Array.isArray(solution)) return held;
    const exact = held.filter((c) => Array.isArray(c.pow) && c.pow.length === solution.length &&
      c.pow.every((v, i) => Number(v) === Number(solution[i])));
    return exact.length ? exact : held;
  }

  _remember(hash) {
    this.reported.add(hash);
    if (this.reported.size > REPORTED_KEEP) this.reported.delete(this.reported.values().next().value);
  }

  // A height stays held until its report is stored. One transport failure ends the reads for this
  // pass: a frozen node would otherwise cost a full timeout per height.
  async run() {
    if (this.running) return;
    this.running = true;
    const gaveUp = [];
    let why = '';
    let nodeDown = false;
    // A height that matched is never given up: its block is known, only the report is failing.
    const failed = (height, entry) => {
      entry.attempts += 1;
      if (entry.attempts >= this.maxAttempts && !entry.matched) gaveUp.push({ height, entry });
    };
    try {
      for (const [height, entry] of [...this.heights]) {
        if (nodeDown) { failed(height, entry); continue; }
        try {
          const header = await this.getHeader(height);
          const held = entry.nonces.get(Number(header.nonce));
          if (held && !this.reported.has(header.hash)) {
            entry.matched = true;
            await this.onFound(this._bestMatch(held, header), header);
            this._remember(header.hash);
          }
          this._forget(height, entry);
        } catch (err) {
          why = err.message;
          nodeDown = err.nodeReplied === false;
          if (entry.matched) console.error(`[lost-block-check] block at ${height} not reported yet: ${err.message}`);
          failed(height, entry);
        }
      }
      if (gaveUp.length || this.dropped) {
        const heights = gaveUp.map(({ height, entry }) => ({ height, submits: this._submits(entry) }));
        await this.onGaveUp(heights, why, this.dropped);
        // A submit added during the report reset attempts, so its height stays for another pass.
        for (const { height, entry } of gaveUp) {
          if (entry.attempts >= this.maxAttempts) this._forget(height, entry);
        }
        this.dropped = 0;
      }
    } catch (err) {
      console.error(`[lost-block-check] could not report ${gaveUp.length} unchecked height(s): ${err.message}`);
    } finally {
      this.running = false;
    }
    this._schedule(this.retryMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = LostBlockCheck;
