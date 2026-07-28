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
  // ── Starter post ─────────────────────────────────────────────────────────
  // A fresh pool ships an empty /blog: the nav points at a blank page, and the whole
  // blog pipeline (clean permalink, RSS, the server-rendered social card) has nothing
  // to exercise. Seed exactly ONE real, publishable post.
  //
  // Marker-guarded like the ads self-promo seed, and the marker is written even when
  // nothing is inserted — so an operator who edits or deletes this post never has it
  // reappear on the next restart. Content is deliberately number-light: anything that
  // moves (hashrate, difficulty, hardware prices) is pointed at the pool's own live
  // pages instead of being baked into prose that silently goes stale.
  seedStarterPost() {
    const seeded = this.db.prepare(
      "SELECT value FROM pool_config WHERE section = 'blog' AND key = 'starter_post_seeded'"
    ).get();
    if (seeded) return false;
    const mark = () => {
      this.db.prepare(`
        INSERT INTO pool_config (section, key, value, value_type)
        VALUES ('blog', 'starter_post_seeded', '1', 'boolean')
        ON CONFLICT(section, key) DO UPDATE SET value = '1'
      `).run();
    };
    // An existing blog is the operator's — never inject into it (covers pools upgraded
    // from a build that predates this seed).
    const have = this.db.prepare('SELECT COUNT(*) AS n FROM posts').get();
    if (have && have.n > 0) { mark(); return false; }

    const body = [
      '<p>Grin is one of the few proof-of-work coins where a small miner can still',
      'make a rational case for switching a machine on. Not because of a price story —',
      'because of the arithmetic. Here is the honest version, including the parts that',
      'argue against it.</p>',

      '<h2>The network is small, and that cuts both ways</h2>',
      '<p>Grin&rsquo;s total hashrate is modest next to the large proof-of-work chains.',
      'For a miner that is the whole point: your share of the network — and so your share',
      'of the emission — is far larger per unit of hardware than it would be on a crowded',
      'chain. The same rig that is a rounding error elsewhere is a visible participant here.</p>',
      '<p>The flip side is that a small network is a <em>volatile</em> one. A single large',
      'farm arriving moves difficulty sharply, and your share falls just as fast as it rose.',
      'Size the decision on what the network looks like today, not on a projection.',
      'The <a href="/miners-stats.html">miners stats page</a> tracks both pool and network',
      'hashrate over time, and <a href="/blocks.html">blocks</a> shows what the pool is',
      'actually finding.</p>',

      '<h2>The hardware is cheap and it sips power</h2>',
      '<p>Grin uses <strong>Cuckatoo32 (C32)</strong>, a proof-of-work chosen to be',
      'ASIC-friendly on purpose rather than fought over. That decision aged into an unusual',
      'situation: purpose-built C32 miners exist, they are years old, and they turn up on the',
      'secondhand market at a fraction of what new equipment costs for other coins.</p>',
      '<p>They are also frugal. A typical secondhand C32 unit draws on the order of',
      '<strong>~120&nbsp;W</strong> — closer to a games console than to a space heater. That',
      'matters more than headline efficiency, because it changes where mining is viable at all:',
      'a machine at this draw can run in a flat, on a domestic tariff, without a dedicated',
      'circuit, without cooling you had to build, and without a noise complaint. Check the',
      'current specification and condition of any unit before buying — figures vary by model',
      'and by how hard a card has been run.</p>',

      '<h2>The emission is simple, and it does not halve</h2>',
      '<p>Grin issues <strong>1 GRIN per second, forever</strong>. There is no pre-mine, no',
      'founder&rsquo;s reward, and no halving schedule to mine into. Your reward per block',
      'does not step down on a calendar; the only thing that changes what you earn is how much',
      'hashrate you are competing against. That makes the arithmetic unusually easy to reason',
      'about — a rare property in this industry.</p>',

      '<h2>Privacy is the default, not a setting</h2>',
      '<p>Grin is built on Mimblewimble. There are no addresses or amounts recorded on the',
      'chain, so the ledger does not accumulate a permanent public history of what you mined',
      'and where you sent it. This pool follows the same principle: your Grin address',
      '<em>is</em> your account, payouts go out over Tor, and there is nothing to register',
      'and no email to hand over.</p>',

      '<h2>The case against</h2>',
      '<p>Any post like this that skips the risks is selling something, so:</p>',
      '<ul>',
      '<li><strong>Liquidity is thin.</strong> Grin trades on comparatively few venues, and',
      'converting a meaningful amount can move the price against you.</li>',
      '<li><strong>Difficulty is jumpy.</strong> On a small network, one new participant can',
      'change your returns substantially and without warning.</li>',
      '<li><strong>Secondhand hardware is secondhand.</strong> No warranty, ageing fans and',
      'thermal paste, and no manufacturer support if a board dies.</li>',
      '<li><strong>Electricity is still the deciding variable.</strong> A low draw widens the',
      'range of tariffs that work; it does not make an expensive one work. Do the sum with',
      'your own rate before buying anything.</li>',
      '</ul>',
      '<p>Mining is a business decision with real downside. Treat any coin you mine as a',
      'speculative asset and do not spend money you need on hardware.</p>',

      '<h2>Starting is a two-line change</h2>',
      '<p>There is no sign-up. Point your miner at the pool, put your Grin address in the',
      'username field, and you are mining — the address is what identifies you, so your stats',
      'and balance exist from the first accepted share. The exact stratum host, port and a',
      'copy-paste configuration are on the <a href="/#connect">connect section of the',
      'homepage</a>, and payout methods, minimums and fees are explained under',
      '<a href="/account-settings.html">your account</a>.</p>',

      '<hr>',
      '<p><em>This is a starter post that shipped with the pool software so the blog is not',
      'empty on day one. Edit it in the admin panel under Content &rarr; Blog to make it',
      'yours, or delete it — it will not come back.</em></p>',
    ].join('\n');

    this.create({
      title: 'Why Grin mining still adds up for a small miner',
      slug: 'why-grin-mining-adds-up',
      status: 'published',
      // Ships with the frontend (public_html/images/blog/). 1200x630 so the same file
      // serves the blog card, the post header and the social share card.
      cover_image: '/images/blog/why-grin-mining-adds-up.svg',
      tags: 'grin, mining, hardware, getting started',
      excerpt: 'A small network, secondhand C32 ASICs at around 120 W, and an emission ' +
        'that never halves — plus the risks that argument usually leaves out.',
      body_html: body,
    });
    mark();
    return true;
  }

  // The starter post shipped with NO cover until 2026-07-27, and seedStarterPost() is
  // one-shot (its marker, plus a bail-out if any post exists) — so on a pool that seeded
  // before that date the post keeps cover_image = NULL and the blog card renders the 📝
  // placeholder instead of the artwork. Adding the field to the seed above only helps
  // brand-new installs, hence this one-time backfill.
  //
  // Deliberately narrow: it touches ONLY the seeded slug, ONLY while the cover is still
  // empty, and never a post the operator wrote. Its own marker means a cover the operator
  // later clears stays cleared.
  backfillStarterCover() {
    try {
      const done = this.db.prepare(
        "SELECT value FROM pool_config WHERE section = 'blog' AND key = 'starter_cover_backfilled'"
      ).get();
      if (done) return false;
      const r = this.db.prepare(`
        UPDATE posts SET cover_image = ?, updated_at = unixepoch()
        WHERE slug = ? AND (cover_image IS NULL OR TRIM(cover_image) = '')
      `).run('/images/blog/why-grin-mining-adds-up.svg', 'why-grin-mining-adds-up');
      this.db.prepare(`
        INSERT INTO pool_config (section, key, value, value_type)
        VALUES ('blog', 'starter_cover_backfilled', '1', 'boolean')
        ON CONFLICT(section, key) DO UPDATE SET value = '1'
      `).run();
      return r.changes > 0;
    } catch (e) {
      console.error(`[posts] backfillStarterCover failed: ${e.message}`);
      return false;
    }
  }
}

module.exports = PostsManager;
