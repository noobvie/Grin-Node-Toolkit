const { getDb } = require('./db');

// Blog posts — the dated, chronological content type (WordPress-style "Posts"), distinct
// from the static `pages` CMS. A post has a publish date, a draft|published status, an
// optional cover image + tags, and appears in a reverse-chronological feed at /blog.
// body_html is operator-trusted (authored via the admin Quill editor, rendered as-is).
const STATUSES = ['draft', 'published'];

const str = (v) => (v === null || v === undefined) ? null : String(v);

function slugify(s) {
  const out = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return out || ('post-' + Math.random().toString(36).slice(2, 8));
}

// Build a short plain-text excerpt from authored HTML when the operator didn't supply one.
function autoExcerpt(html, max = 200) {
  const text = String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

// Normalise a tags input (CSV string or array) → clean CSV string, or null.
function cleanTags(v) {
  if (v === null || v === undefined || v === '') return null;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const list = arr.map(t => String(t).trim()).filter(Boolean).slice(0, 12);
  return list.length ? list.join(', ') : null;
}

class PostsManager {
  constructor(config) {
    this.config = config || {};
    this.db = getDb();
  }

  static get STATUSES() { return STATUSES.slice(); }

  _uniqueSlug(slug, exceptId = null) {
    let base = slugify(slug);
    let candidate = base;
    let n = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const row = this.db.prepare('SELECT id FROM posts WHERE slug = ?').get(candidate);
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
    if (!partial || data.body_html !== undefined) out.body_html = str(data.body_html) || '';
    if (!partial || data.cover_image !== undefined) out.cover_image = str(data.cover_image);
    if (!partial || data.tags !== undefined) out.tags = cleanTags(data.tags);
    if (!partial || data.excerpt !== undefined) {
      const ex = (str(data.excerpt) || '').trim();
      out.excerpt = ex || (out.body_html !== undefined ? autoExcerpt(out.body_html) : '');
    }
    if (!partial || data.status !== undefined) {
      const s = str(data.status) || 'draft';
      out.status = STATUSES.includes(s) ? s : 'draft';
    }
    // published_at: explicit value wins; else set on first transition to published.
    if (data.published_at !== undefined && data.published_at !== null && data.published_at !== '') {
      const t = parseInt(data.published_at, 10);
      if (Number.isFinite(t)) out.published_at = t;
    }
    return out;
  }

  // Admin: every post newest-first (optionally filtered by status).
  list(status) {
    if (status && STATUSES.includes(status)) {
      return this.db.prepare(
        'SELECT * FROM posts WHERE status = ? ORDER BY COALESCE(published_at, created_at) DESC, id DESC'
      ).all(status);
    }
    return this.db.prepare(
      'SELECT * FROM posts ORDER BY COALESCE(published_at, created_at) DESC, id DESC'
    ).all();
  }

  get(id) {
    return this.db.prepare('SELECT * FROM posts WHERE id = ?').get(id) || null;
  }

  create(data) {
    const c = this._clean(data);
    // A post published with no explicit date gets "now".
    let publishedAt = c.published_at != null ? c.published_at : null;
    if (c.status === 'published' && publishedAt == null) publishedAt = Math.floor(Date.now() / 1000);
    const r = this.db.prepare(`
      INSERT INTO posts (slug, title, body_html, excerpt, cover_image, tags, status, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      c.slug, c.title, c.body_html || '', c.excerpt || null,
      c.cover_image || null, c.tags || null, c.status || 'draft', publishedAt
    );
    return this.get(r.lastInsertRowid);
  }

  update(id, data) {
    const existing = this.get(id);
    if (!existing) throw new Error('not found');
    const c = this._clean(data, { partial: true, id });
    // Stamp published_at the first time a draft becomes published (unless caller set one).
    if (c.status === 'published' && !existing.published_at && c.published_at == null) {
      c.published_at = Math.floor(Date.now() / 1000);
    }
    const keys = Object.keys(c);
    if (!keys.length) return existing;
    const set = keys.map(k => `${k} = ?`).join(', ');
    const vals = keys.map(k => c[k]);
    this.db.prepare(`UPDATE posts SET ${set}, updated_at = unixepoch() WHERE id = ?`)
      .run(...vals, id);
    return this.get(id);
  }

  remove(id) {
    const r = this.db.prepare('DELETE FROM posts WHERE id = ?').run(id);
    return r.changes > 0;
  }

  // ── Public ───────────────────────────────────────────────────────────────
  _toCard(r) {
    return {
      slug: r.slug, title: r.title, excerpt: r.excerpt || '',
      cover_image: r.cover_image || null,
      tags: r.tags ? r.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      published_at: r.published_at || r.created_at,
    };
  }

  // Published posts, newest-first, paginated. Returns { posts, total }.
  listPublished({ limit = 10, offset = 0 } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    const total = this.db.prepare(
      "SELECT COUNT(*) AS n FROM posts WHERE status = 'published'"
    ).get().n;
    const rows = this.db.prepare(`
      SELECT slug, title, excerpt, cover_image, tags, published_at, created_at
      FROM posts WHERE status = 'published'
      ORDER BY published_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(lim, off);
    return { posts: rows.map(r => this._toCard(r)), total, limit: lim, offset: off };
  }

  // Full published post by slug (for the permalink page + RSS).
  getPublic(slug) {
    const r = this.db.prepare(`
      SELECT slug, title, body_html, excerpt, cover_image, tags, published_at, created_at
      FROM posts WHERE slug = ? AND status = 'published'
    `).get(String(slug || ''));
    if (!r) return null;
    return {
      slug: r.slug, title: r.title, body_html: r.body_html || '',
      excerpt: r.excerpt || '', cover_image: r.cover_image || null,
      tags: r.tags ? r.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      published_at: r.published_at || r.created_at,
    };
  }
}

module.exports = PostsManager;
