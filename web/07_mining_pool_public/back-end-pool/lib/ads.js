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
                       is_active, weight, start_at, end_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      c.name, c.placement, c.ad_type,
      c.image_url || null, c.link_url || null, c.alt_text || null, c.html_code || null,
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
}

module.exports = AdsManager;
