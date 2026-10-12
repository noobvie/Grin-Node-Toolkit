// /blog/rss.xml, /robots.txt, /sitemap.xml, /manifest.json, /blog/:slug and /page.html, with the shell/SEO helpers only they use.
// Moved verbatim out of routes/index.js (code-layout refactor P3); registrations stay at 2-space
// indent and write FULL paths. Instances/state come from ctx.

const express = require('express');
const path = require('path');
const fs = require('fs');

module.exports = function createSeoRoutes(ctx) {
  const {
    assetManager, config, pagesManager, poolSettings, postsManager, rateLimiter
  } = ctx;
  const router = express.Router();

  // Blog RSS 2.0 feed (latest 20 published posts). nginx proxies /blog/rss.xml here.
  router.get('/blog/rss.xml',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const branding = poolSettings.getSection('branding');
        const seo = poolSettings.getSection('seo');
        const origin = siteOrigin(req);
        const title = (branding.pool_name || seo.site_title || 'Grin Pool') + ' — Blog';
        const { posts } = postsManager.listPublished({ limit: 20, offset: 0 });
        const esc = (s) => String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<rss version="2.0"><channel>\n';
        xml += '  <title>' + esc(title) + '</title>\n';
        xml += '  <link>' + esc(origin + '/blog.html') + '</link>\n';
        xml += '  <description>' + esc(seo.site_description || 'Pool news and announcements') + '</description>\n';
        posts.forEach((p) => {
          const url = origin + '/blog/' + encodeURIComponent(p.slug);
          xml += '  <item>\n';
          xml += '    <title>' + esc(p.title) + '</title>\n';
          xml += '    <link>' + esc(url) + '</link>\n';
          xml += '    <guid isPermaLink="true">' + esc(url) + '</guid>\n';
          xml += '    <pubDate>' + new Date((p.published_at || 0) * 1000).toUTCString() + '</pubDate>\n';
          xml += '    <description>' + esc(p.excerpt || '') + '</description>\n';
          xml += '  </item>\n';
        });
        xml += '</channel></rss>\n';
        res.type('application/rss+xml').send(xml);
      } catch (err) {
        res.status(500).type('text/plain').send('Failed to build feed');
      }
    }
  );

  // ─── SEO files: robots.txt, sitemap.xml, PWA manifest (served via nginx proxy) ──
  // Resolve the canonical site origin: configured site_url > installer-set subdomain > Host.
  function siteOrigin(req) {
    const seo = poolSettings.getSection('seo');
    if (seo.site_url) return String(seo.site_url).replace(/\/+$/, '');
    // Installer-set (pool.json `subdomain`, lib/config.js) and therefore NOT client-controlled.
    // It sits ahead of the Host header on purpose: `seo.site_url` used to ship non-empty for
    // every pool (audit §J10-4), so this fallback is new reachable ground and the Host header
    // is attacker-supplied on a vhost that is the box's default :443 server.
    if (config.subdomain) return 'https://' + String(config.subdomain).replace(/\/+$/, '');
    return (req.protocol || 'https') + '://' + req.get('host');
  }

  router.get('/robots.txt',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const seo = poolSettings.getSection('seo');
        const noindex = seo.robots_noindex === true || seo.robots_noindex === 'true';
        const sitemapOn = !(seo.sitemap_enabled === false || seo.sitemap_enabled === 'false');
        let body = 'User-agent: *\n';
        body += noindex ? 'Disallow: /\n' : 'Disallow:\n'; // index by default
        if (sitemapOn && !noindex) body += 'Sitemap: ' + siteOrigin(req) + '/sitemap.xml\n';
        res.type('text/plain').send(body);
      } catch (err) {
        res.type('text/plain').send('User-agent: *\nDisallow:\n');
      }
    }
  );

  // Public pages included in the sitemap. Each URL MUST match that page's own
  // <link rel="canonical"> exactly (the .html form, except the dashboard, whose canonical
  // is the bare origin + '/') — a sitemap URL that
  // differs from the page's canonical makes Google crawl a non-canonical variant.
  // pool-info + connect were merged into the dashboard (index) 2026-06; the dashboard
  // carries the #connect + #info anchors, so only / is listed for that content.
  const SITEMAP_PATHS = ['/', '/miners-stats.html', '/blocks.html', '/network-map.html', '/payment-history.html', '/fortune-board.html', '/donate.html', '/blog.html', '/api-docs.html'];

  router.get('/sitemap.xml',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const seo = poolSettings.getSection('seo');
        const noindex = seo.robots_noindex === true || seo.robots_noindex === 'true';
        const sitemapOn = !(seo.sitemap_enabled === false || seo.sitemap_enabled === 'false');
        if (noindex || !sitemapOn) return res.status(404).type('text/plain').send('Not found');

        const origin = siteOrigin(req);
        const paths = SITEMAP_PATHS.slice();
        // Append authored content pages (dynamic CMS) and published blog posts.
        pagesManager.listEnabled().forEach((p) => paths.push('/page.html?p=' + p.key));
        try {
          postsManager.listPublished({ limit: 50, offset: 0 }).posts
            .forEach((p) => paths.push('/blog/' + p.slug));
        } catch (e) { /* posts optional in sitemap */ }

        const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
        paths.forEach((p) => {
          xml += '  <url><loc>' + esc(origin + p) + '</loc></url>\n';
        });
        xml += '</urlset>\n';
        res.type('application/xml').send(xml);
      } catch (err) {
        res.status(500).type('text/plain').send('Error');
      }
    }
  );

  router.get('/manifest.json',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const pool = poolSettings.getSection('pool_info');
        const seo = poolSettings.getSection('seo');
        const brand = poolSettings.getSection('branding');
        const name = pool.pool_name || 'Grin Mining Pool';
        const themeColor = seo.theme_color || brand.accent_color || '#667eea';

        const icons = [];
        const pushIcon = (type, size) => {
          const asset = assetManager.getActiveAsset(type);
          if (asset) {
            icons.push({ src: assetManager.getAssetUrl(asset.filename), sizes: size, type: asset.mime_type || 'image/png' });
          }
        };
        pushIcon('icon_192', '192x192');
        pushIcon('icon_512', '512x512');

        const manifest = {
          name: name,
          short_name: brand.app_short_name || name,
          start_url: '/',
          display: 'standalone',
          background_color: themeColor,
          theme_color: themeColor,
          icons: icons,
        };
        res.type('application/manifest+json').send(JSON.stringify(manifest, null, 2));
      } catch (err) {
        res.status(500).json({ error: 'Failed to build manifest' });
      }
    }
  );

  // ─── Blog + CMS permalinks with server-rendered <head> (nginx proxies these) ───
  // post.html and page.html are JS shells: they fetch their content and set the title
  // client-side. Google renders JS, but Twitter/Facebook/Discord/Telegram/Slack do NOT —
  // so every shared post or About/Terms link unfurled as "Loading…" with no description
  // and no image, and those URLs are all in sitemap.xml. These routes serve the SAME
  // static shell with the head filled in first, so a crawler gets real metadata and a
  // browser gets the identical page it did before (the client script then runs and
  // rewrites the same values — idempotent, no flicker).

  const HEAD_MARK = '</head>';
  const shellCache = new Map(); // filename → contents; only a restart clears it (no reload signal)

  function readShell(name) {
    if (shellCache.has(name)) return shellCache.get(name);
    let html = null;
    try {
      // Resolve inside web_dir only — `name` is a hardcoded literal at every call
      // site, never user input, but keep the join anchored anyway.
      html = fs.readFileSync(path.join(config.web_dir, name), 'utf8');
    } catch (e) {
      console.warn(`[seo] cannot read ${name} from web_dir (${config.web_dir}): ${e.message}` +
        ' — serving a minimal shell instead. Set "web_dir" in the pool config to fix.');
    }
    shellCache.set(name, html);
    return html;
  }

  // Minimal stand-in used only if web_dir is wrong/unreadable, so a misconfigured box
  // degrades to a working page rather than a 500. Loads the same assets as the real
  // shells; the per-page client script is what fills it in.
  function fallbackShell(bodyId) {
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      '<link rel="icon" type="image/svg+xml" href="/images/favicon.svg">\n' +
      '<link rel="stylesheet" href="/css/dashboard.css">\n' +
      '<link rel="stylesheet" href="/css/themes.css">\n</head>\n<body>\n' +
      '<main class="wrap" id="' + bodyId + '"></main>\n' +
      '<script src="/js/public-shell.js"></script>\n' +
      '<script src="/js/public-theme.js"></script>\n' +
      '<script src="/js/branding.js"></script>\n</body>\n</html>\n';
  }

  const attrEsc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Strip authored HTML to a plain-text description and cap it at a sane card length.
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
  function toDescription(html, fallback) {
    const text = String(html || '')
      // Drop script/style bodies FIRST — tag-stripping alone keeps their contents, so a
      // CMS page with an embedded <style> block put raw CSS in its social card.
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      // Decode after tag-stripping (so escaped "&lt;b&gt;" text can never become a tag).
      // Without this, authored "&amp;" reached attrEsc() as literal text and came back
      // double-escaped — the card rendered "Bob &amp; Alice".
      .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/gi,
        (m, e) => ENTITIES[e.toLowerCase()] || m)
      .replace(/\s+/g, ' ')
      .trim();
    const out = text || String(fallback || '');
    return out.length > 200 ? out.slice(0, 197).trimEnd() + '…' : out;
  }

  // Build the <head> block injected ahead of </head>. The shells declare no description,
  // og:* or canonical, and sendShell() removes their static <title> before injecting this
  // one — a document may hold only one title and every parser keeps the FIRST, so leaving
  // it in place would have made this one dead markup.
  //
  // No <link rel="icon"> here: both shells already carry it, and a SECOND icon link would
  // break branding.js's operator-favicon override (setLinkRel updates the first match
  // while the browser honours the last). fallbackShell() carries its own.
  function seoHead({ title, description, canonical, image, type, publishedAt }) {
    const brand = poolSettings.getSection('branding');
    const siteName = brand.pool_name || 'Grin Mining Pool';
    const full = title ? `${title} — ${siteName}` : siteName;
    let h = '\n<title>' + attrEsc(full) + '</title>\n';
    // Marker read by branding.js: this page's metadata is per-item and server-rendered,
    // so the generic site-wide title/description/og template must NOT overwrite it.
    h += '<meta name="server-seo" content="1">\n';
    h += '<link rel="manifest" href="/manifest.json">\n';
    if (canonical) h += '<link rel="canonical" href="' + attrEsc(canonical) + '">\n';
    if (description) h += '<meta name="description" content="' + attrEsc(description) + '">\n';
    h += '<meta property="og:type" content="' + attrEsc(type || 'website') + '">\n';
    h += '<meta property="og:site_name" content="' + attrEsc(siteName) + '">\n';
    h += '<meta property="og:title" content="' + attrEsc(full) + '">\n';
    if (description) h += '<meta property="og:description" content="' + attrEsc(description) + '">\n';
    if (canonical) h += '<meta property="og:url" content="' + attrEsc(canonical) + '">\n';
    if (image) h += '<meta property="og:image" content="' + attrEsc(image) + '">\n';
    if (publishedAt) {
      h += '<meta property="article:published_time" content="' +
        attrEsc(new Date(publishedAt * 1000).toISOString()) + '">\n';
    }
    h += '<meta name="twitter:card" content="' + (image ? 'summary_large_image' : 'summary') + '">\n';
    h += '<meta name="twitter:title" content="' + attrEsc(full) + '">\n';
    if (description) h += '<meta name="twitter:description" content="' + attrEsc(description) + '">\n';
    if (image) h += '<meta name="twitter:image" content="' + attrEsc(image) + '">\n';
    return h;
  }

  // Remove the shell's own <title> so ours is the only one (HTML allows exactly one, and
  // browsers/Google keep the FIRST — leaving it makes the injected per-post title dead).
  //
  // Comments are MASKED first, and that is not paranoia: the shells carry an explanatory
  // comment that mentions "<title>" in prose. A naive regex matched that occurrence, ran
  // on to the real </title>, and deleted the comment's opening — leaving an unterminated
  // "<!--" that swallowed every stylesheet link after it. The page rendered with NO CSS at
  // all. Masking keeps offsets identical, so the match indices still address the original.
  function stripShellTitle(headHtml) {
    const masked = headHtml.replace(/<!--[\s\S]*?-->/g, (m) => '\u0000'.repeat(m.length));
    const m = /[ \t]*<title\b[^>]*>[\s\S]*?<\/title>[ \t]*\r?\n?/i.exec(masked);
    if (!m) return headHtml;
    return headHtml.slice(0, m.index) + headHtml.slice(m.index + m[0].length);
  }

  function sendShell(res, shellName, fallbackId, head) {
    const shell = readShell(shellName) || fallbackShell(fallbackId);
    const idx = shell.indexOf(HEAD_MARK);
    let html = shell;
    if (idx !== -1) {
      html = stripShellTitle(shell.slice(0, idx)) + head + shell.slice(idx);
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  }

  // First <img src> in an authored HTML body, or '' when there is none. CMS pages have no
  // cover_image column (only posts do), so this is how a page gets a social card picture.
  // Accepts single, double or unquoted src values — the body is operator-authored, so it
  // is not guaranteed to be normalised markup.
  function firstBodyImage(html) {
    const m = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(String(html || ''));
    return m ? (m[1] || m[2] || m[3] || '') : '';
  }

  // Absolute URL for an image path that may already be absolute.
  const absImage = (origin, src) =>
    (!src ? '' : /^https?:\/\//i.test(src) ? src : origin + (src.startsWith('/') ? src : '/' + src));

  // /blog/<slug> — the clean post permalink. Plain :slug, no inline regex: Express 4's
  // path-to-regexp accepts `:slug([A-Za-z0-9_-]+)` but Express 5 THROWS on it at boot,
  // which would take the whole pool down over a blog route. Nothing needs it — nginx
  // already constrains the slug charset, getPublic() runs a parameterised query, and an
  // unknown slug renders the 404 shell. "/blog/rss.xml" is registered earlier, and
  // Express matches in registration order, so it still wins over this.
  router.get('/blog/:slug',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const origin = siteOrigin(req);
        const post = postsManager.getPublic(req.params.slug);
        if (!post) {
          // Still serve the shell (its client script renders a "post not found" state),
          // but say 404 so crawlers don't index a missing post.
          res.status(404);
          return sendShell(res, 'post.html', 'post-body', seoHead({
            title: 'Post not found', canonical: origin + '/blog/' + req.params.slug,
          }));
        }
        sendShell(res, 'post.html', 'post-body', seoHead({
          title: post.title,
          description: post.excerpt || toDescription(post.body_html, ''),
          canonical: origin + '/blog/' + post.slug,
          image: absImage(origin, post.cover_image),
          type: 'article',
          publishedAt: post.published_at,
        }));
      } catch (err) {
        res.status(500).type('text/plain').send('Error');
      }
    }
  );

  // /page.html?p=<key> — the CMS content pages (About / Terms / Privacy / FAQ …).
  router.get('/page.html',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const origin = siteOrigin(req);
        const key = String(req.query.p || '');
        const page = key ? pagesManager.getPublic(key) : null;
        if (!page) {
          // Two ways in: an unknown/unpublished key, or the bare shell with no ?p= at all.
          // Both 404 — /page.html on its own is a shell, not content, and is deliberately
          // absent from sitemap.xml. The shell's client script then fills the body with the
          // list of published pages so a visitor lands on an index, not a dead end. That
          // body is real linked content, so pair the status with an explicit noindex
          // (follow, so the listed pages are still discovered) and drop the canonical: a
          // canonical pointing at a noindex URL just gives a crawler two contradictory
          // signals about a page that should never be indexed in the first place.
          res.status(404);
          return sendShell(res, 'page.html', 'page-body',
            seoHead({ title: key ? 'Page not found' : 'Pages' }) +
            '<meta name="robots" content="noindex, follow">\n');
        }
        sendShell(res, 'page.html', 'page-body', seoHead({
          title: page.seo_title || page.title,
          description: page.seo_desc || toDescription(page.html, ''),
          canonical: origin + '/page.html?p=' + encodeURIComponent(page.key),
          // Pages carry no cover column, so the card picture is the first image in the
          // authored body, falling back to the site-wide card. Before this, every CMS page
          // unfurled on Twitter/Discord/Telegram as a bare text card with no image at all.
          image: absImage(origin, firstBodyImage(page.html) || '/images/og-image.svg'),
        }));
      } catch (err) {
        res.status(500).type('text/plain').send('Error');
      }
    }
  );
  return router;
};
