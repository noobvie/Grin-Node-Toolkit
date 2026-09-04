const crypto = require('crypto');

// Self-hosted arithmetic CAPTCHA for the admin login/register forms.
//
// No external service (no Google reCAPTCHA / hCaptcha) — keeps the pool privacy- and
// Tor-friendly and dependency-free. It exists purely to raise the per-attempt cost of
// scripted brute force, on top of the auth rate limiter (this.limits.auth, 200/min since
// the 2026-06 x20 bump) and the per-(username,IP) lockout in auth.js.
//
// Single-use + short TTL + in-memory: the Central API is a single process (single DB
// writer per the hub design), so an in-process Map is sufficient. A challenge is consumed
// on the FIRST verify (right or wrong), so a solved token can't be replayed across many
// password guesses. Restarting the process just invalidates pending challenges (harmless —
// the form fetches a fresh one).
class Captcha {
  // maxPerIp caps how many challenges ONE source can hold open at once. Without it the store
  // is global and un-keyed, and _prune() evicts oldest-inserted first — so an anonymous client
  // issuing 5001 free challenges (GET /api/auth/captcha is unauthenticated) evicts every
  // challenge anyone else is holding, and the operator's login form fails its captcha forever
  // however many times they reload it. That is the same operator-lockout denial the
  // per-(username,IP) lockout in auth.js was written to avoid, arriving through a door with no
  // failed logins in it: no auto-ban, no fail2ban hit, no audit row. Per-IP eviction makes the
  // flood self-inflicted. Audit §J2-4.
  //
  // `max` stays as a pure MEMORY backstop (250 distinct sources at 20 each), not as the
  // brute-force control it was being asked to be.
  constructor({ ttlMs = 300000, max = 5000, maxPerIp = 20 } = {}) {
    this.ttlMs = ttlMs;   // 5 min
    this.max = max;       // hard cap on outstanding challenges (memory guard)
    this.maxPerIp = maxPerIp;
    this.store = new Map(); // id -> { answer, expires, ip }
    this.byIp = new Map();  // ip -> [id, …] in issue order (index into store; may hold stale ids)
  }

  _dropId(id) {
    const entry = this.store.get(id);
    this.store.delete(id);
    if (!entry) return;
    const ids = this.byIp.get(entry.ip);
    if (!ids) return;
    const at = ids.indexOf(id);
    if (at >= 0) ids.splice(at, 1);
    if (ids.length === 0) this.byIp.delete(entry.ip);
  }

  _prune() {
    const now = Date.now();
    for (const [id, v] of this.store) {
      if (v.expires <= now) this._dropId(id);
    }
    if (this.store.size > this.max) {
      let excess = this.store.size - this.max;
      for (const id of Array.from(this.store.keys())) {
        this._dropId(id);
        if (--excess <= 0) break;
      }
    }
  }

  // Evict THIS source's own oldest challenges until it is back under maxPerIp.
  _pruneIp(ip) {
    const ids = this.byIp.get(ip);
    if (!ids) return;
    while (ids.length > this.maxPerIp) this._dropId(ids[0]);
  }

  // Returns { id, question }. The answer never leaves the server.
  //
  // `ip` is the issuing client, used ONLY to bound that client's own outstanding challenges.
  // verify() deliberately does NOT check it: a solved challenge stays redeemable if the client's
  // address changes between the two requests (mobile handover, a Tor circuit rotating), which
  // would otherwise read to the operator as a captcha that is simply wrong.
  issue(ip) {
    this._prune();
    const key = ip || 'unknown';
    const a = 1 + Math.floor(Math.random() * 9);
    const b = 1 + Math.floor(Math.random() * 9);
    const variants = [['+', a + b], ['×', a * b]];
    const pick = variants[Math.floor(Math.random() * variants.length)];
    const id = crypto.randomBytes(16).toString('hex');
    this.store.set(id, { answer: String(pick[1]), expires: Date.now() + this.ttlMs, ip: key });
    let ids = this.byIp.get(key);
    if (!ids) { ids = []; this.byIp.set(key, ids); }
    ids.push(id);
    this._pruneIp(key);
    return { id, question: `What is ${a} ${pick[0]} ${b}?` };
  }

  // Single-use: deletes the challenge whether the answer is right or wrong.
  verify(id, answer) {
    if (!id) return false;
    const entry = this.store.get(id);
    if (!entry) return false;
    this._dropId(id);
    if (entry.expires <= Date.now()) return false;
    return String(answer == null ? '' : answer).trim() === entry.answer;
  }
}

module.exports = Captcha;
