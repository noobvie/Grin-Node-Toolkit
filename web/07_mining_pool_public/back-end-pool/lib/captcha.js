const crypto = require('crypto');

// Self-hosted arithmetic CAPTCHA for the admin login/register forms.
//
// No external service (no Google reCAPTCHA / hCaptcha) — keeps the pool privacy- and
// Tor-friendly and dependency-free. It exists purely to raise the per-attempt cost of
// scripted brute force, on top of the auth rate limiter (3/min) and per-account lockout.
//
// Single-use + short TTL + in-memory: the Central API is a single process (single DB
// writer per the hub design), so an in-process Map is sufficient. A challenge is consumed
// on the FIRST verify (right or wrong), so a solved token can't be replayed across many
// password guesses. Restarting the process just invalidates pending challenges (harmless —
// the form fetches a fresh one).
class Captcha {
  constructor({ ttlMs = 300000, max = 5000 } = {}) {
    this.ttlMs = ttlMs;   // 5 min
    this.max = max;       // hard cap on outstanding challenges (flood guard)
    this.store = new Map(); // id -> { answer, expires }
  }

  _prune() {
    const now = Date.now();
    for (const [id, v] of this.store) {
      if (v.expires <= now) this.store.delete(id);
    }
    if (this.store.size > this.max) {
      let excess = this.store.size - this.max;
      for (const id of this.store.keys()) {
        this.store.delete(id);
        if (--excess <= 0) break;
      }
    }
  }

  // Returns { id, question }. The answer never leaves the server.
  issue() {
    this._prune();
    const a = 1 + Math.floor(Math.random() * 9);
    const b = 1 + Math.floor(Math.random() * 9);
    const variants = [['+', a + b], ['×', a * b]]; // ×
    const pick = variants[Math.floor(Math.random() * variants.length)];
    const id = crypto.randomBytes(16).toString('hex');
    this.store.set(id, { answer: String(pick[1]), expires: Date.now() + this.ttlMs });
    return { id, question: `What is ${a} ${pick[0]} ${b}?` };
  }

  // Single-use: deletes the challenge whether the answer is right or wrong.
  verify(id, answer) {
    if (!id) return false;
    const entry = this.store.get(id);
    if (!entry) return false;
    this.store.delete(id);
    if (entry.expires <= Date.now()) return false;
    return String(answer == null ? '' : answer).trim() === entry.answer;
  }
}

module.exports = Captcha;
