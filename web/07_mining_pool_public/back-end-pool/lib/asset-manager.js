const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class AssetManager {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    this.uploadDir = `/opt/grin/mining-pool-${
      config.network === 'mainnet' ? 'main' : 'test'
    }/custom_assets`;

    this.allowedMimeTypes = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/gif'];
    this.maxFileSize = 2 * 1024 * 1024; // 2 MB
    this.allowedTypes = ['logo', 'favicon', 'og_image'];

    this.setupDirectory();
  }

  setupDirectory() {
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  getMulterInstance() {
    const fileFilter = (req, file, cb) => {
      if (!this.allowedMimeTypes.includes(file.mimetype)) {
        cb(new Error(`File type not allowed: ${file.mimetype}`));
        return;
      }
      cb(null, true);
    };

    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        cb(null, this.uploadDir);
      },
      filename: (req, file, cb) => {
        const type = req.query.type || 'custom';
        const timestamp = Date.now();
        const sanitized = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        const filename = `${type}_${timestamp}_${sanitized}`;
        cb(null, filename);
      }
    });

    return multer({
      storage,
      fileFilter,
      limits: { fileSize: this.maxFileSize }
    });
  }

  async saveAsset(file, assetType, userId) {
    if (!this.allowedTypes.includes(assetType)) {
      throw new Error(`Invalid asset type: ${assetType}`);
    }

    if (!file || !file.filename || !file.path) {
      throw new Error('No file provided');
    }

    // Deactivate previous assets of same type
    const deactivateStmt = this.db.prepare(`
      UPDATE pool_assets SET is_active = 0
      WHERE asset_type = ? AND is_active = 1
    `);
    deactivateStmt.run(assetType);

    // Insert new asset record
    const stmt = this.db.prepare(`
      INSERT INTO pool_assets (asset_type, filename, original_name, mime_type, size_bytes, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      assetType,
      file.filename,
      file.originalname,
      file.mimetype,
      file.size,
      userId
    );

    return {
      id: result.lastInsertRowid,
      filename: file.filename,
      original_name: file.originalname,
      mime_type: file.mimetype,
      size_bytes: file.size,
      asset_type: assetType
    };
  }

  async deleteAsset(filename) {
    const stmt = this.db.prepare('SELECT * FROM pool_assets WHERE filename = ?');
    const asset = stmt.get(filename);

    if (!asset) {
      throw new Error('Asset not found');
    }

    const filePath = path.join(this.uploadDir, filename);
    if (fs.existsSync(filePath)) {
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
