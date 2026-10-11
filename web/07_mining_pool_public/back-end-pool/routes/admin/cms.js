// /api/admin CMS — ads, ads-config, media upload, pages, posts, branding assets. Moved verbatim out
// of routes/index.js (code-layout refactor P7); registrations stay at 2-space indent and write FULL
// paths. Instances come from ctx; the guard chain is the ONE createGuards(ctx) instance (I7).

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const AssetManager = require('../../lib/asset-manager');
const AdsManager = require('../../lib/ads');
const PagesManager = require('../../lib/pages');
const PostsManager = require('../../lib/posts');
const caches = require('../_shared/caches');

module.exports = function createAdminCmsRoutes(ctx, guards) {
  const { adsManager, pagesManager, postsManager, assetManager, uploadsDir, mediaUpload } = ctx;
  const { invalidateBranding } = caches;
  const { secureAdmin } = guards;
  const router = express.Router();

  // ─── ADS (Admin CRUD) ──────────────────────────────────────────────
  // Operator-managed promotions (a banner image or a native text card) bound to a public
  // placement. secureAdmin (not freshAdmin) — ads are not money/destructive of funds, and
  // since design §19.17 D22 removed the `code` type an ad can no longer carry script, so
  // secureAdmin is no longer a route to code on the public origin. An attempt to create a
  // code ad, or to edit a legacy one, is a 400 that says why (lib/ads.js).
  router.get('/api/admin/ads', secureAdmin, (req, res) => {
    try {
      res.json({
        ads: adsManager.list(req.query.placement),
        placements: AdsManager.PLACEMENTS,
        config: adsManager.getConfig()
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/api/admin/ads', secureAdmin, (req, res) => {
    try {
      res.json({ ad: adsManager.create(req.body || {}) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/api/admin/ads/:id', secureAdmin, (req, res) => {
    try {
      res.json({ ad: adsManager.update(parseInt(req.params.id, 10), req.body || {}) });
    } catch (err) {
      res.status(err.message === 'not found' ? 404 : 400).json({ error: err.message });
    }
  });

  router.delete('/api/admin/ads/:id', secureAdmin, (req, res) => {
    try {
      const ok = adsManager.remove(parseInt(req.params.id, 10));
      if (!ok) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Render settings for the public renderer — rotation interval, sidebar layout mode
  // and rail peek timings (stored in pool_config, each clamped to a sane range).
  router.post('/api/admin/ads-config', secureAdmin, (req, res) => {
    try {
      res.json({ config: adsManager.setConfig(req.body || {}) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // ─── MEDIA UPLOAD (Admin) ──────────────────────────────────────────
  // Image upload for the CMS editor (cover images + in-body images). secureAdmin — not
  // money/destructive. Returns { url } pointing at the persistent /uploads dir. multer
  // errors (bad type, too big) are surfaced as 400 via the wrapper.
  router.post('/api/admin/media', secureAdmin, (req, res) => {
    mediaUpload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'upload failed' });
      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        return res.status(400).json({ error: 'no file' });
      }
      // The decisive check (audit §J10-1): the extension — which is what decides the
      // Content-Type nginx serves this back with — comes from the BYTES, never from the
      // uploader's declared MIME or filename. WEBP is passed in explicitly because the
      // branding-asset endpoint does not accept it (see lib/asset-manager.js).
      const detected = AssetManager.detectImage(req.file.buffer, [AssetManager.WEBP_SNIFFER]);
      if (!detected) {
        return res.status(400).json({ error: 'File content is not a valid PNG, JPEG, GIF, WEBP or SVG image' });
      }
      const safe = (req.file.originalname || 'image').toLowerCase()
        .replace(/\.[^.]*$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
      const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}.${detected.ext}`;
      const destPath = path.join(uploadsDir, filename);
      // Defence in depth, mirroring saveAsset(): the joined path must stay in the dir.
      if (path.dirname(destPath) !== uploadsDir) {
        return res.status(400).json({ error: 'upload failed' });
      }
      try {
        fs.writeFileSync(destPath, req.file.buffer, { mode: 0o644 });
      } catch (e) {
        console.error(`[media] write failed for ${destPath}: ${e.message}`);
        return res.status(500).json({ error: 'upload failed' });
      }
      res.json({ url: '/uploads/' + filename, filename });
    });
  });

  // ─── PAGES (Admin CRUD) ────────────────────────────────────────────
  // Dynamic content pages (the CMS that replaced the fixed 5-slot config). secureAdmin.
  router.get('/api/admin/pages', secureAdmin, (req, res) => {
    try {
      res.json({ pages: pagesManager.list(), nav_locations: PagesManager.NAV_LOCATIONS });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/api/admin/pages', secureAdmin, (req, res) => {
    try {
      res.json({ page: pagesManager.create(req.body || {}) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/api/admin/pages/:id', secureAdmin, (req, res) => {
    try {
      res.json({ page: pagesManager.update(parseInt(req.params.id, 10), req.body || {}) });
    } catch (err) {
      res.status(err.message === 'not found' ? 404 : 400).json({ error: err.message });
    }
  });

  router.delete('/api/admin/pages/:id', secureAdmin, (req, res) => {
    try {
      const ok = pagesManager.remove(parseInt(req.params.id, 10));
      if (!ok) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ─── POSTS / BLOG (Admin CRUD) ─────────────────────────────────────
  // Dated blog/announcement posts. secureAdmin — content, not funds.
  router.get('/api/admin/posts', secureAdmin, (req, res) => {
    try {
      res.json({ posts: postsManager.list(req.query.status), statuses: PostsManager.STATUSES });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/api/admin/posts', secureAdmin, (req, res) => {
    try {
      res.json({ post: postsManager.create(req.body || {}) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/api/admin/posts/:id', secureAdmin, (req, res) => {
    try {
      res.json({ post: postsManager.update(parseInt(req.params.id, 10), req.body || {}) });
    } catch (err) {
      res.status(err.message === 'not found' ? 404 : 400).json({ error: err.message });
    }
  });

  router.delete('/api/admin/posts/:id', secureAdmin, (req, res) => {
    try {
      const ok = postsManager.remove(parseInt(req.params.id, 10));
      if (!ok) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ─── ASSET UPLOAD ENDPOINTS (Admin only) ──────────────────────────

  // Upload an asset (logo, favicon, og_image)
  router.post('/api/admin/assets/upload', secureAdmin, (req, res) => {
    try {
      const upload = assetManager.getMulterInstance().single('file');
      upload(req, res, async (err) => {
        if (err) {
          return res.status(400).json({ error: err.message });
        }
        if (!req.file) {
          return res.status(400).json({ error: 'No file provided' });
        }

        try {
          // No 'custom' fallback: it was never in allowedTypes, so an omitted ?type= always
          // failed with "Invalid asset type: custom" — an error naming an internal constant
          // the operator cannot act on (audit §J10-5). Refuse up front and name the valid set.
          const assetType = String(req.query.type || '');
          if (!assetManager.allowedTypes.includes(assetType)) {
            return res.status(400).json({
              error: `?type= is required and must be one of: ${assetManager.allowedTypes.join(', ')}`
            });
          }
          const saved = await assetManager.saveAsset(req.file, assetType, req.user.user_id);
          invalidateBranding();   // §J12-8: assetUrlFor() feeds the memoised branding payload
          res.json({ success: true, asset: saved });
        } catch (err) {
          res.status(400).json({ error: err.message });
        }
      });
    } catch (err) {
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  // List uploaded assets
  router.get('/api/admin/assets', secureAdmin, (req, res) => {
    try {
      const assets = assetManager.listAssets(true);
      res.json({ success: true, assets });
    } catch (err) {
      res.status(500).json({ error: 'Failed to list assets' });
    }
  });

  // Delete an asset
  router.delete('/api/admin/assets/:filename', secureAdmin, (req, res) => {
    try {
      const result = assetManager.deleteAsset(req.params.filename);
      invalidateBranding();   // §J12-8
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
