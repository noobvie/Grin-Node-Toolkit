const { getDb } = require('./db');

// Operator-managed ads shown on public pages. Three kinds:
//   · banner — self-hosted image (image_url) linking to link_url
//   · text   — a native card composed from headline + body_text + cta_label (+ link_url);
//              no image or HTML needed, so the operator writes/edits copy in plain fields
//   · code   — a raw HTML/JS snippet from an ad network (operator-trusted, like the
//              analytics snippet the operator already pastes)
// Each ad is bound to one placement and an optional active window. Admin CRUD is
// secureAdmin-gated; the public read endpoint returns only active, in-window ads.
const PLACEMENTS = ['header', 'sidebar', 'in-content', 'footer'];
const AD_TYPES = ['banner', 'text', 'code'];

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
    // Native text-ad fields (used when ad_type === 'text').
    if (!partial || data.headline !== undefined)  out.headline = str(data.headline);
    if (!partial || data.body_text !== undefined) out.body_text = str(data.body_text);
    if (!partial || data.cta_label !== undefined) out.cta_label = str(data.cta_label);
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
      if (finalType === 'text' && !(out.headline && out.headline.trim())) throw new Error('text ads need a headline');
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
                       headline, body_text, cta_label,
                       notes, is_active, weight, start_at, end_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      c.name, c.placement, c.ad_type,
      c.image_url || null, c.link_url || null, c.alt_text || null, c.html_code || null,
      c.headline || null, c.body_text || null, c.cta_label || null,
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
      SELECT id, placement, ad_type, image_url, link_url, alt_text, html_code,
             headline, body_text, cta_label
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

  // Render settings for the public renderer. Stored in pool_config (same 'ads'
  // section as the seed marker — deliberately NOT a PoolSettings section); every
  // value is clamped so a typo can't make ads strobe or freeze.
  //   rotate_ms    — how fast a multi-ad placement cycles
  //   sidebar_mode — how the sidebar placement is laid out:
  //                    rail   = fixed elastic strip in the empty page gutter (costs
  //                             the layout nothing; peeks in/out on a timer)
  //                    inline = plain centred block in the page flow
  //                    off    = sidebar placement not rendered at all
  //   rail_show_ms — how long the rail stays out before tucking away
  //   rail_hide_ms — how long it stays tucked (0 = never tuck, always visible)
  static get CONFIG_SPEC() {
    return {
      rotate_ms:    { type: 'number', def: 8000,  min: 2000, max: 60000 },
      sidebar_mode: { type: 'enum',   def: 'rail', values: ['rail', 'inline', 'off'] },
      rail_show_ms: { type: 'number', def: 12000, min: 3000, max: 120000 },
      rail_hide_ms: { type: 'number', def: 45000, min: 0,    max: 600000 }
    };
  }

  getConfig() {
    const spec = AdsManager.CONFIG_SPEC;
    const rows = this.db.prepare(
      "SELECT key, value FROM pool_config WHERE section = 'ads'"
    ).all();
    const stored = {};
    for (const r of rows) stored[r.key] = r.value;

    const out = {};
    for (const [key, s] of Object.entries(spec)) {
      const raw = stored[key];
      if (raw === undefined) { out[key] = s.def; continue; }
      if (s.type === 'enum') {
        out[key] = s.values.includes(raw) ? raw : s.def;
      } else {
        const n = parseInt(raw, 10);
        out[key] = Number.isInteger(n) ? Math.min(s.max, Math.max(s.min, n)) : s.def;
      }
    }
    return out;
  }

  // Partial patch — only the keys present in `patch` are written. Returns the full
  // effective config so a caller can echo it straight back to the admin UI.
  setConfig(patch) {
    const spec = AdsManager.CONFIG_SPEC;
    const stmt = this.db.prepare(`
      INSERT INTO pool_config (section, key, value, value_type) VALUES ('ads', ?, ?, ?)
      ON CONFLICT(section, key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
    `);
    for (const [key, s] of Object.entries(spec)) {
      const v = (patch || {})[key];
      if (v === undefined || v === null || v === '') continue;
      if (s.type === 'enum') {
        const val = String(v);
        if (!s.values.includes(val)) throw new Error(`${key} must be one of ${s.values.join(', ')}`);
        stmt.run(key, val, 'string');
      } else {
        const n = parseInt(v, 10);
        if (!Number.isInteger(n)) throw new Error(`${key} must be a number`);
        stmt.run(key, String(Math.min(s.max, Math.max(s.min, n))), 'number');
      }
    }
    return this.getConfig();
  }

  // Starter content: seed the shipped GRINIUM self-promo creatives (SVGs in
  // public_html/promo/, plus native text ads) so placements aren't empty on a fresh pool.
  // Seeds are starter inventory, not campaigns — the operator repoints, edits or deletes
  // them from the admin panel (their click targets follow the LINK POLICY below).
  //
  // Gated by a pool_config marker rather than "table is empty", so an operator who
  // deletes a seed does not get it back on the next restart. The marker is versioned and
  // each generation inserts only what it introduced (`v` on each seed, vs seededMax):
  //   v2 — 160×600 rail creatives (the sidebar became a narrow fixed rail, where a 300×250
  //        square no longer fits); also re-homes a v1 pool's sidebar squares to in-content.
  //   v3 — a second header strip + the first native text ad, so the header has a rotation.
  //   v4 — the in-content band defaults to one responsive text banner.
  //   v5 — the two 300×250 squares return as INACTIVE starter banners (see below).
  //   v6 — link policy (below) + a "join the Grin team" header strip pointing at the forum.
  //
  // LINK POLICY (v6). A seed gets a click target only when the click takes the visitor
  // SOMEWHERE — another page of this site, or a genuinely useful external destination:
  //   · homepage/anchor-only targets ('/#connect', '/#info') → NO link at all. The visitor
  //     is already on the site; a banner that reloads the page they are on wastes the click
  //     and trains people to distrust our own ads. renderAd() draws those as a plain
  //     image/card (hasLink() rejects null and '#'), impressions still count.
  //   · internal PAGES ('/donate.html', '/fortune-board.html') keep their link.
  //   · "Buy GRIN" → the Gate GRIN/USDT market; "Why GRIN?" → grin.money/#why-grin (the
  //     section that answers the creative's question, not the site root). Those answer the
  //     question the creative asks, which no page of ours can. External seeds render with
  //     target=_blank + rel="noopener nofollow sponsored" (renderAd/linkOpen).
  //
  // A seed is active unless it sets `is_active: 0`; an inactive seed is a ready-made
  // creative parked in the admin panel, invisible publicly until the operator enables it.
  //
  // The sidebar seeds deliberately share one placement: they demo the rail rotation.
  seedSelfPromo() {
    const cfgGet = (key) => this.db.prepare(
      "SELECT value FROM pool_config WHERE section = 'ads' AND key = ?"
    ).get(key);
    if (cfgGet('selfpromo_seeded_v6')) return false;
    // Highest seed generation already applied to this pool (0 = brand-new). Each upgrade
    // inserts only creatives NEWER than what's been seeded, so a deleted seed stays deleted.
    let seededMax = 0;
    if (cfgGet('selfpromo_seeded')) seededMax = 1;
    if (cfgGet('selfpromo_seeded_v2')) seededMax = 2;
    if (cfgGet('selfpromo_seeded_v3')) seededMax = 3;
    if (cfgGet('selfpromo_seeded_v4')) seededMax = 4;
    if (cfgGet('selfpromo_seeded_v5')) seededMax = 5;

    // v1 → v2 boundary only: the sidebar became a narrow rail, so old square seeds move
    // in-content (skip if the pool was already at/after v2).
    if (seededMax === 1) {
      this.db.prepare(`
        UPDATE ads SET placement = 'in-content'
        WHERE placement = 'sidebar'
          AND image_url IN ('/promo/grinium-fortune-300x250.svg', '/promo/grinium-privacy-300x250.svg')
      `).run();
    }

    // v5 → v6 boundary: retarget the already-seeded creatives to the link policy above.
    // Each UPDATE matches the ORIGINAL seed link as well as the creative, so an operator
    // who already repointed an ad keeps their own target — only untouched seeds move.
    if (seededMax >= 1 && seededMax < 6) {
      const retarget = this.db.prepare(
        'UPDATE ads SET link_url = ?, updated_at = unixepoch() WHERE image_url = ? AND link_url = ?'
      );
      // Homepage-anchor seeds lose their link entirely (a click that goes nowhere).
      for (const img of ['/promo/grinium-mine-728x90.svg', '/promo/grinium-mine-160x600.svg',
                         '/promo/grinium-privacy-160x600.svg']) {
        retarget.run(null, img, '/#connect');
      }
      // …except the privacy square, whose painted CTA reads "SEE POOL PAYOUTS →" — that is
      // a real page, so the artwork and the click agree instead of going nowhere.
      retarget.run('/payment-history.html', '/promo/grinium-privacy-300x250.svg', '/#connect');
      retarget.run('https://www.gate.com/trade/GRIN_USDT', '/promo/grinium-buy-grin-160x600.svg', '/#info');
      retarget.run('https://grin.money/#why-grin', '/promo/grinium-why-grin-160x600.svg', '/#info');
      retarget.run('https://grin.money/#why-grin', '/promo/grinium-why-grin-728x90.svg', '/#info');
      // The v3 text ad has no image — match it by the internal name the seed created it with.
      this.db.prepare(`
        UPDATE ads SET link_url = NULL, updated_at = unixepoch()
        WHERE name = 'GRINIUM text — Private by design (header)' AND link_url = '/#connect'
      `).run();
    }

    // `v` = the seed generation a creative was introduced in; only seeds with v > seededMax
    // are inserted on this run. `link_url: null` = deliberately unclickable under the link
    // policy above, NOT an unfinished seed. Internal page links stay same-tab (renderAd
    // keeps site paths in-page); the two external seeds open in a new tab.
    const seeds = [
      // Wide strips — header/footer.
      { v: 1, name: 'GRINIUM promo — Mine GRIN (header 728×90)', placement: 'header',
        image_url: '/promo/grinium-mine-728x90.svg', weight: 10, link_url: null,
        alt_text: 'Mine GRIN on GRINIUM — no sign-up, PPLNS rewards, your address is your account' },
      { v: 1, name: 'GRINIUM promo — Donate (footer 728×90)', placement: 'footer',
        image_url: '/promo/grinium-donate-728x90.svg', weight: 10, link_url: '/donate.html',
        alt_text: 'Keep the reactor running — donate GRIN and join the donor wall' },

      // Vertical rail creatives — several on purpose, so the rail has a rotation to demo.
      { v: 2, name: 'GRINIUM rail — Mine here (160×600)', placement: 'sidebar',
        image_url: '/promo/grinium-mine-160x600.svg', weight: 50, link_url: null,
        alt_text: 'Mine GRIN here — no sign-up, PPLNS rewards, anonymous Tor payouts' },
      { v: 2, name: 'GRINIUM rail — Why GRIN? (160×600)', placement: 'sidebar',
        image_url: '/promo/grinium-why-grin-160x600.svg', weight: 40,
        link_url: 'https://grin.money/#why-grin',
        alt_text: 'Why GRIN? Private by default, no addresses on chain, fair launch, no premine' },
      { v: 2, name: 'GRINIUM rail — Buy GRIN (160×600)', placement: 'sidebar',
        image_url: '/promo/grinium-buy-grin-160x600.svg', weight: 30,
        link_url: 'https://www.gate.com/trade/GRIN_USDT',
        alt_text: 'Buy GRIN — trade the GRIN/USDT market, or earn it by pointing a miner here' },
      { v: 2, name: 'GRINIUM rail — Feeling lucky? (160×600)', placement: 'sidebar',
        image_url: '/promo/grinium-fortune-160x600.svg', weight: 20, link_url: '/fortune-board.html',
        alt_text: 'Feeling lucky? Block jackpots, prize draws, streak rewards and a monthly lottery' },
      { v: 2, name: 'GRINIUM rail — Anonymous (160×600)', placement: 'sidebar',
        image_url: '/promo/grinium-privacy-160x600.svg', weight: 10, link_url: null,
        alt_text: 'Mine anonymously — no accounts, no emails, Tor payouts' },

      // Squares — in-content, seeded INACTIVE (is_active: 0). The v4 text banner below is
      // what the in-content band actually shows by default; these two ship as ready-made
      // starter banners the operator can flip on (or edit) from the admin panel without
      // having to author a creative first. A pool that seeded them under v1–v3 keeps them
      // exactly as-is — the dedup below matches on image_url, so an already-live square is
      // never switched off. The re-home block above still moves a v1 pool's old sidebar
      // squares in-content on upgrade.
      { v: 5, name: 'GRINIUM promo — Fortune board (in-content 300×250)', placement: 'in-content',
        image_url: '/promo/grinium-fortune-300x250.svg', weight: 10, link_url: '/fortune-board.html',
        is_active: 0,
        alt_text: 'Feeling lucky? Block jackpots, prize draws, streak rewards and a monthly lottery' },
      { v: 5, name: 'GRINIUM promo — Anonymous mining (in-content 300×250)', placement: 'in-content',
        image_url: '/promo/grinium-privacy-300x250.svg', weight: 5,
        link_url: '/payment-history.html',
        is_active: 0,
        alt_text: 'Mine anonymously — no accounts, no emails — see every pool payout' },

      // v3 — give the header a rotation: a second graphical strip + a native TEXT ad, so the
      // header cycles Mine → Why GRIN → Private-by-design and the text-ad type is demoed.
      { v: 3, name: 'GRINIUM promo — Why GRIN? (header 728×90)', placement: 'header',
        image_url: '/promo/grinium-why-grin-728x90.svg', weight: 8,
        link_url: 'https://grin.money/#why-grin',
        alt_text: 'Why GRIN? No ICO, no premine, tail emission, private by default' },
      // No link: the CTA is an instruction, not a destination — everything it asks for is
      // already on this page (the connect panel is a scroll away).
      { v: 3, name: 'GRINIUM text — Private by design (header)', placement: 'header',
        ad_type: 'text', weight: 6, link_url: null,
        headline: 'PRIVATE BY DESIGN',
        body_text: 'No accounts · no emails · Tor payouts · your address is your account',
        cta_label: 'Start anonymously →' },

      // v4 — the in-content band now defaults to ONE responsive TEXT banner instead of two
      // 300×250 squares. A text card reflows and stays readable at every width (a fixed square
      // marooned in the wide band looked imbalanced, and an image strip goes unreadable on a
      // phone), and at ~1 line tall it reclaims vertical space in the main pool column.
      { v: 4, name: 'GRINIUM text — Feeling lucky? (in-content)', placement: 'in-content',
        ad_type: 'text', weight: 10, link_url: '/fortune-board.html',
        headline: 'FEELING LUCKY?',
        body_text: 'Block jackpots · prize draws · streak rewards · a monthly lottery — every share is a ticket',
        cta_label: 'Open the Fortune Board →' },

      // v6 — recruit for the wider Grin project, not for the pool: the header strip sends
      // devs / marketing / AI / mining / trading people to the community forum. It is the
      // one header seed with a genuinely off-site destination, so it carries real weight in
      // the rotation (10) alongside the Mine strip.
      { v: 6, name: 'GRINIUM promo — Join the Grin team (header 728×90)', placement: 'header',
        image_url: '/promo/grinium-join-team-728x90.svg', weight: 10,
        link_url: 'https://forum.grin.mw',
        alt_text: 'Join the Grin community — dev, marketing, AI, mining and trading talk on the Grin forum' }
    ];

    const seenImg = this.db.prepare('SELECT 1 FROM ads WHERE image_url = ? LIMIT 1');
    const seenName = this.db.prepare('SELECT 1 FROM ads WHERE name = ? LIMIT 1');
    let added = 0;
    for (const s of seeds) {
      if (s.v <= seededMax) continue;                         // already seeded in an earlier gen
      if (s.image_url ? seenImg.get(s.image_url)              // banner: dedup by image
                      : seenName.get(s.name)) continue;       // text: dedup by internal name
      const { v, ...ad } = s;
      // Defaults first so a seed can opt out (is_active: 0 → an off-by-default starter ad).
      this.create({ ad_type: 'banner', link_url: '#', is_active: 1, ...ad });
      added++;
    }

    for (const key of ['selfpromo_seeded', 'selfpromo_seeded_v2', 'selfpromo_seeded_v3',
                       'selfpromo_seeded_v4', 'selfpromo_seeded_v5', 'selfpromo_seeded_v6']) {
      this.db.prepare(`
        INSERT INTO pool_config (section, key, value, value_type) VALUES ('ads', ?, '1', 'boolean')
        ON CONFLICT(section, key) DO NOTHING
      `).run(key);
    }
    return added > 0;
  }
}

module.exports = AdsManager;
