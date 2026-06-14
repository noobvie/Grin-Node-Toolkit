const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Canonical, server-controlled extension/MIME per detected content type. The uploader's
// declared MIME and original filename are NEVER trusted for what we write to disk — the
// extension drives nginx's served Content-Type, so it must be derived from the actual bytes.
const SNIFFERS = [
  { ext: 'png', mime: 'image/png', test: (b) => b.length > 7 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b.length > 2 &&
      b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.length > 5 &&
      b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61 },
];

// SVG is text/XML, not a binary signature. Accept only if the head clearly parses as SVG.
function looksLikeSvg(buffer) {
  const head = buffer.slice(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  return (head.startsWith('<?xml') || head.startsWith('<!doctype svg') || head.startsWith('<svg')) &&
    head.includes('<svg');
}

// Returns { ext, mime } from the real bytes, or null if it's not an allowed image.
function detectImage(buffer) {
  if (!buffer || buffer.length < 4) return null;
  for (const s of SNIFFERS) {
    if (s.test(buffer)) return { ext: s.ext, mime: s.mime };
  }
  if (looksLikeSvg(buffer)) return { ext: 'svg', mime: 'image/svg+xml' };
  return null;
}

class AssetManager {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    // Resolve relative to cwd so it sits under the app's WorkingDirectory by default.
    // Served by nginx at /custom/<file> (see getAssetUrl + the vhost location /custom/).
    this.uploadDir = path.resolve(
      config.assets_dir ||
      `/opt/grin/mining-pool-${config.network === 'mainnet' ? 'main' : 'test'}/custom_assets`
    );

    // Declared MIME gate (cheap, spoofable — real check is detectImage() on the bytes).
    this.allowedMimeTypes = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/gif'];
    this.maxFileSize = 2 * 1024 * 1024; // 2 MB
    this.allowedTypes = ['logo', 'logo_dark', 'favicon', 'og_image', 'apple_touch_icon', 'icon_192', 'icon_512'];

    this.setupDirectory();
  }

  setupDirectory() {
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  // In-memory storage: nothing is written to disk until the bytes pass validation and we
  // assign a safe, server-controlled filename ourselves (see saveAsset).
  getMulterInstance() {
    const fileFilter = (req, file, cb) => {
      if (!this.allowedMimeTypes.includes(file.mimetype)) {
        cb(new Error(`File type not allowed: ${file.mimetype}`));
        return;
      }
      cb(null, true);
    };

    return multer({
      storage: multer.memoryStorage(),
      fileFilter,
      limits: { fileSize: this.maxFileSize, files: 1 },
    });
  }

  // Validate the in-memory upload, then write it under a generated name. Throws on any
  // problem (caller returns 400). No untrusted file ever lands on disk.
  async saveAsset(file, assetType, userId) {
    if (!this.allowedTypes.includes(assetType)) {
      throw new Error(`Invalid asset type: ${assetType}`);
    }
    if (!file || !file.buffer || !file.buffer.length) {
      throw new Error('No file provided');
    }
    if (file.buffer.length > this.maxFileSize) {
      throw new Error('File too large');
    }

    // The decisive check: content must actually be an allowed image type.
    const detected = detectImage(file.buffer);
    if (!detected) {
      throw new Error('File content is not a valid PNG, JPEG, GIF, or SVG image');
    }

    // Server-controlled filename — never derived from the uploader's name or query string.
    const safeType = String(assetType).replace(/[^a-z0-9_]/gi, '').slice(0, 32) || 'asset';
    const rand = crypto.randomBytes(4).toString('hex');
    const filename = `${safeType}_${Date.now()}_${rand}.${detected.ext}`;
    const destPath = path.join(this.uploadDir, filename);

    // Defence in depth: the joined path must stay inside the upload dir.
    if (path.dirname(destPath) !== this.uploadDir) {
      throw new Error('Resolved path escapes the asset directory');
    }

    fs.writeFileSync(destPath, file.buffer, { mode: 0o644 });

    // Deactivate previous assets of same type
    const deactivateStmt = this.db.prepare(`
      UPDATE pool_assets SET is_active = 0
      WHERE asset_type = ? AND is_active = 1
    `);
    deactivateStmt.run(assetType);

    // Insert new asset record (store the *detected* mime, not the declared one).
    const stmt = this.db.prepare(`
      INSERT INTO pool_assets (asset_type, filename, original_name, mime_type, size_bytes, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      assetType,
      filename,
      (file.originalname || '').slice(0, 255),
      detected.mime,
      file.buffer.length,
      userId
    );

    return {
      id: result.lastInsertRowid,
      filename: filename,
      original_name: file.originalname,
      mime_type: detected.mime,
      size_bytes: file.buffer.length,
      asset_type: assetType
    };
  }

  async deleteAsset(filename) {
    const stmt = this.db.prepare('SELECT * FROM pool_assets WHERE filename = ?');
    const asset = stmt.get(filename);

    if (!asset) {
      throw new Error('Asset not found');
    }

    // Only ever unlink within the upload dir using the stored (already safe) basename.
    const safeName = path.basename(asset.filename);
    const filePath = path.join(this.uploadDir, safeName);
    if (path.dirname(filePath) === this.uploadDir && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    const deleteStmt = this.db.prepare('DELETE FROM pool_assets WHERE id = ?');
    deleteStmt.run(asset.id);

    return { deleted: true, filename };
  }

  getActiveAsset(assetType) {
    const stmt = this.db.prepare(`
      SELECT * FROM pool_assets
      WHERE asset_type = ? AND is_active = 1
      ORDER BY uploaded_at DESC
      LIMIT 1
    `);

    return stmt.get(assetType);
  }

  listAssets(activeOnly = true) {
    const query = activeOnly
      ? 'SELECT * FROM pool_assets WHERE is_active = 1 ORDER BY uploaded_at DESC'
      : 'SELECT * FROM pool_assets ORDER BY uploaded_at DESC';

    const stmt = this.db.prepare(query);
    return stmt.all();
  }

  getAssetUrl(filename) {
    return `/custom/${filename}`;
  }
}

module.exports = AssetManager;
