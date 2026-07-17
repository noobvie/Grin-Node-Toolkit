const { getDb } = require('./db');

// Operator-managed ads shown on public pages. Two kinds:
//   · banner — self-hosted image (image_url) linking to link_url
//   · code   — a raw HTML/JS snippet from an ad network (operator-trusted, like the
//              analytics snippet the operator already pastes)
// Each ad is bound to one placement and an optional active window. Admin CRUD is
// secureAdmin-gated; the public read endpoint returns only active, in-window ads.
const PLACEMENTS = ['header', 'sidebar', 'in-content', 'footer'];
const AD_TYPES = ['banner', 'code'];

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v === null || v === undefined) ? null : String(v);

class AdsManager {
  constructor(config) {
    this.config = config || {};
    this.db = getDb();
  }

  static get PLACEMENTS() { return PLACEMENTS.slice(); }

  // Normalise + validate an incoming ad payload. Throws Error('...') on bad input.
  _clean(data, { partial = false } = {}) {
    const out = {};
    if (!partial || data.name !== undefined) {
      const name = (str(data.name) || '').trim();
      if (!name) throw new Error('name is required');
      out.name = name;
    }
    if (!partial || data.placement !== undefined) {
      const p = str(data.placement);
      if (!PLACEMENTS.includes(p)) throw new Error('invalid placement');
      out.placement = p;
    }
    if (!partial || data.ad_type !== undefined) {
      const t = str(data.ad_type) || 'banner';
      if (!AD_TYPES.includes(t)) throw new Error('invalid ad_type');
      out.ad_type = t;
    }
    if (!partial || data.image_url !== undefined) out.image_url = str(data.image_url);
    if (!partial || data.link_url !== undefined)  out.link_url = str(data.link_url);
    if (!partial || data.alt_text !== undefined)  out.alt_text = str(data.alt_text);
    if (!partial || data.html_code !== undefined) out.html_code = str(data.html_code);
    // Admin-only sponsor memo (contact, payment terms, …) — never exposed publicly.
    if (!partial || data.notes !== undefined)     out.notes = str(data.notes);
    if (!partial || data.is_active !== undefined) {
      out.is_active = (data.is_active === true || data.is_active === 'true' || data.is_active === 1 || data.is_active === '1') ? 1 : 0;
    }
    if (!partial || data.weight !== undefined) out.weight = num(data.weight) || 0;
    if (!partial || data.start_at !== undefined) out.start_at = num(data.start_at);
    if (!partial || data.end_at !== undefined)   out.end_at = num(data.end_at);

    // Type-specific content requirement (only enforced when we know the final type).
    const finalType = out.ad_type || (partial ? this._existingType(data._id) : 'banner');
    if (!partial) {
      if (finalType === 'banner' && !out.image_url) throw new Error('banner ads need an image_url');
      if (finalType === 'code' && !out.html_code) throw new Error('code ads need html_code');
    }
    return out;
  }

  _existingType(id) {
    if (!id) return 'banner';
    const r = this.db.prepare('SELECT ad_type FROM ads WHERE id = ?').get(id);
    return r ? r.ad_type : 'banner';
  }

  // Admin: every ad, newest first (optionally filtered by placement).
  list(placement) {
    if (placement && PLACEMENTS.includes(placement)) {
      return this.db.prepare(
        'SELECT * FROM ads WHERE placement = ? ORDER BY weight DESC, id DESC'
      ).all(placement);
    }
    return this.db.prepare('SELECT * FROM ads ORDER BY placement, weight DESC, id DESC').all();
  }

  get(id) {
    return this.db.prepare('SELECT * FROM ads WHERE id = ?').get(id) || null;
  }

  create(data) {
    const c = this._clean(data);
    const r = this.db.prepare(`
      INSERT INTO ads (name, placement, ad_type, image_url, link_url, alt_text, html_code,
                       notes, is_active, weight, start_at, end_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      c.name, c.placement, c.ad_type,
      c.image_url || null, c.link_url || null, c.alt_text || null, c.html_code || null,
      c.notes || null,
      c.is_active === undefined ? 1 : c.is_active,
      c.weight || 0, c.start_at || null, c.end_at || null
    );
    return this.get(r.lastInsertRowid);
  }

  update(id, data) {
    if (!this.get(id)) throw new Error('not found');
    const c = this._clean({ ...data, _id: id }, { partial: true });
    delete c._id;
    const keys = Object.keys(c);
    if (!keys.length) return this.get(id);
    const set = keys.map(k => `${k} = ?`).join(', ');
    const vals = keys.map(k => c[k]);
    this.db.prepare(`UPDATE ads SET ${set}, updated_at = unixepoch() WHERE id = ?`)
      .run(...vals, id);
    return this.get(id);
  }

  remove(id) {
    const r = this.db.prepare('DELETE FROM ads WHERE id = ?').run(id);
    return r.changes > 0;
  }

  // Public: active, in-window ads for one placement, ordered by weight. Only the fields
  // the frontend renders are returned (no internal timestamps/weights leaked).
  publicByPlacement(placement) {
    if (!PLACEMENTS.includes(placement)) return [];
    const now = Math.floor(Date.now() / 1000);
    const rows = this.db.prepare(`
      SELECT id, placement, ad_type, image_url, link_url, alt_text, html_code
      FROM ads
      WHERE placement = ? AND is_active = 1
        AND (start_at IS NULL OR start_at <= ?)
        AND (end_at IS NULL OR end_at >= ?)
      ORDER BY weight DESC, id DESC
    `).all(placement, now, now);
    return rows;
  }

  // Public: all placements at once → { header:[...], sidebar:[...], ... }.
  publicAll() {
    const out = {};
    for (const p of PLACEMENTS) out[p] = this.publicByPlacement(p);
    return out;
  }

  // Public beacon: bump coarse impression/click counters. Aggregates only — no
  // per-visitor rows, no IPs (pool privacy stance). Ids are sanitised and capped so
  // a hostile client can at worst inflate counters, never grow the DB or error out.
  recordEvents(body) {
    const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(x => parseInt(x, 10))
      .filter(n => Number.isInteger(n) && n > 0))].slice(0, 20);
    const impressions = ids(body && body.impressions);
    const clicks = ids(body && body.clicks);
    const bump = (col, list) => {
      if (!list.length) return;
      this.db.prepare(
        `UPDATE ads SET ${col} = ${col} + 1 WHERE id IN (${list.map(() => '?').join(',')})`
      ).run(...list);
    };
    bump('impressions', impressions);
    bump('clicks', clicks);
    return { impressions: impressions.length, clicks: clicks.length };
  }

  // Rotation interval shown to the public renderer. Stored in pool_config (same
  // 'ads' section as the seed marker — deliberately NOT a PoolSettings section);
  // clamped so a typo can't make ads strobe or freeze.
  getRotateMs() {
    const row = this.db.prepare(
      "SELECT value FROM pool_config WHERE section = 'ads' AND key = 'rotate_ms'"
    ).get();
    const n = row ? parseInt(row.value, 10) : NaN;
    return Number.isInteger(n) ? Math.min(60000, Math.max(2000, n)) : 8000;
  }

  setRotateMs(ms) {
    const n = parseInt(ms, 10);
    if (!Number.isInteger(n)) throw new Error('rotate_ms must be a number');
    const clamped = Math.min(60000, Math.max(2000, n));
    this.db.prepare(`
      INSERT INTO pool_config (section, key, value, value_type) VALUES ('ads', 'rotate_ms', ?, 'number')
      ON CONFLICT(section, key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
    `).run(String(clamped));
    return clamped;
  }

  // One-time starter content: seed the shipped GRINIUM self-promo SVG banners
  // (public_html/promo/) so placements aren't empty on a fresh pool. Runs once ever —
  // a pool_config marker (not "table empty") gates it, so an operator deleting the
  // seeds does not get them back on the next restart. The two sidebar ads share one
  // placement on purpose: they demo the front-end rotation.
  seedSelfPromo() {
    const marker = this.db.prepare(
      "SELECT value FROM pool_config WHERE section = 'ads' AND key = 'selfpromo_seeded'"
    ).get();
    if (marker) return false;
    const empty = this.db.prepare('SELECT COUNT(*) AS c FROM ads').get().c === 0;
    if (empty) {
      const seeds = [
        { name: 'GRINIUM promo — Mine GRIN (header 728×90)', placement: 'header',
          image_url: '/promo/grinium-mine-728x90.svg', link_url: '/',
          alt_text: 'Mine GRIN on GRINIUM — no sign-up, PPLNS rewards, your address is your account', weight: 10 },
        { name: 'GRINIUM promo — Fortune board (sidebar 300×250)', placement: 'sidebar',
          image_url: '/promo/grinium-fortune-300x250.svg', link_url: '/fortune-board.html',
          alt_text: 'Feeling lucky? Block jackpots, prize draws, streak rewards and a monthly lottery', weight: 10 },
        { name: 'GRINIUM promo — Anonymous mining (sidebar 300×250)', placement: 'sidebar',
          image_url: '/promo/grinium-privacy-300x250.svg', link_url: '/payment-history.html',
          alt_text: 'Mine anonymously — no accounts, no emails, Tor payouts', weight: 5 },
        { name: 'GRINIUM promo — Donate (footer 728×90)', placement: 'footer',
          image_url: '/promo/grinium-donate-728x90.svg', link_url: '/donate.html',
          alt_text: 'Keep the reactor running — donate GRIN and join the donor wall', weight: 10 }
      ];
      for (const s of seeds) this.create({ ...s, ad_type: 'banner', is_active: 1 });
    }
    this.db.prepare(`
      INSERT INTO pool_config (section, key, value, value_type) VALUES ('ads', 'selfpromo_seeded', '1', 'boolean')
      ON CONFLICT(section, key) DO NOTHING
    `).run();
    return empty;
  }
}

module.exports = AdsManager;
