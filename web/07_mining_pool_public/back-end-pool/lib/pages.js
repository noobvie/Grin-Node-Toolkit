const { getDb } = require('./db');

// Operator-authored standalone content pages (the dynamic CMS that replaced the old
// fixed 5-slot config section). Each page is rendered at /page.html?p=<slug>; HTML is
// operator-trusted (rendered as-is, same trust model as ad code snippets). nav_location
// decides where the page is auto-linked: footer | header | none.
const NAV_LOCATIONS = ['footer', 'header', 'none'];

const str = (v) => (v === null || v === undefined) ? null : String(v);
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

// kebab-case slug from arbitrary text; falls back to a timestamp-ish token if empty.
function slugify(s) {
  const out = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return out || ('page-' + Math.random().toString(36).slice(2, 8));
}

class PagesManager {
  constructor(config) {
    this.config = config || {};
    this.db = getDb();
  }

  static get NAV_LOCATIONS() { return NAV_LOCATIONS.slice(); }

  // Ensure a slug is unique, appending -2, -3, … if needed (ignoring `exceptId` on edit).
  _uniqueSlug(slug, exceptId = null) {
    let base = slugify(slug);
    let candidate = base;
    let n = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const row = this.db.prepare('SELECT id FROM pages WHERE slug = ?').get(candidate);
      if (!row || row.id === exceptId) return candidate;
      n += 1;
      candidate = `${base}-${n}`;
    }
  }

  _clean(data, { partial = false, id = null } = {}) {
    const out = {};
    if (!partial || data.title !== undefined) {
      const title = (str(data.title) || '').trim();
      if (!title) throw new Error('title is required');
      out.title = title;
    }
    if (!partial || data.slug !== undefined || data.title !== undefined) {
      const wanted = (str(data.slug) || '').trim() || out.title || '';
      out.slug = this._uniqueSlug(wanted, id);
    }
    if (!partial || data.html !== undefined) out.html = str(data.html) || '';
    if (!partial || data.nav_location !== undefined) {
      const loc = str(data.nav_location) || 'footer';
      out.nav_location = NAV_LOCATIONS.includes(loc) ? loc : 'footer';
    }
    if (data.is_published !== undefined) {
      out.is_published = (data.is_published === true || data.is_published === 'true'
        || data.is_published === 1 || data.is_published === '1') ? 1 : 0;
    } else if (!partial) {
      out.is_published = 1; // new pages are published by default unless told otherwise
    }
    if (!partial || data.sort_order !== undefined) out.sort_order = num(data.sort_order) || 0;
    if (!partial || data.seo_title !== undefined) out.seo_title = str(data.seo_title);
    if (!partial || data.seo_desc !== undefined) out.seo_desc = str(data.seo_desc);
    return out;
  }

  // Admin: every page, ordered for the management table.
  list() {
    return this.db.prepare(
      'SELECT * FROM pages ORDER BY nav_location, sort_order, title'
    ).all();
  }

  get(id) {
    return this.db.prepare('SELECT * FROM pages WHERE id = ?').get(id) || null;
  }

  create(data) {
    const c = this._clean(data);
    const r = this.db.prepare(`
      INSERT INTO pages (slug, title, html, is_published, nav_location, sort_order, seo_title, seo_desc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      c.slug, c.title, c.html || '',
      c.is_published === undefined ? 1 : c.is_published,
      c.nav_location || 'footer', c.sort_order || 0,
      c.seo_title || null, c.seo_desc || null
    );
    return this.get(r.lastInsertRowid);
  }

  update(id, data) {
    if (!this.get(id)) throw new Error('not found');
    const c = this._clean(data, { partial: true, id });
    const keys = Object.keys(c);
    if (!keys.length) return this.get(id);
    const set = keys.map(k => `${k} = ?`).join(', ');
    const vals = keys.map(k => c[k]);
    this.db.prepare(`UPDATE pages SET ${set}, updated_at = unixepoch() WHERE id = ?`)
      .run(...vals, id);
    return this.get(id);
  }

  remove(id) {
    const r = this.db.prepare('DELETE FROM pages WHERE id = ?').run(id);
    return r.changes > 0;
  }

  // Public: full content for one published page by slug (for /api/public/page/:key).
  getPublic(slug) {
    const row = this.db.prepare(
      'SELECT slug, title, html, seo_title, seo_desc FROM pages WHERE slug = ? AND is_published = 1'
    ).get(String(slug || ''));
    if (!row || String(row.html).trim() === '') return null;
    return { key: row.slug, title: row.title, html: row.html,
             seo_title: row.seo_title || null, seo_desc: row.seo_desc || null };
  }

  // Published, linked pages for footer/header link lists + the sitemap. Excludes
  // nav_location='none' (those are "direct URL only" — intentionally unadvertised, so
  // they stay out of nav AND the sitemap). [{ key, title, nav_location }], non-empty HTML.
  listEnabled() {
    return this.db.prepare(`
      SELECT slug, title, nav_location FROM pages
      WHERE is_published = 1 AND TRIM(html) <> '' AND nav_location <> 'none'
      ORDER BY sort_order, title
    `).all().map(r => ({ key: r.slug, title: r.title, nav_location: r.nav_location }));
  }
}

module.exports = PagesManager;
