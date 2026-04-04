'use strict';
/**
 * db.js — SQLite schema and helpers for Grin Drop (better-sqlite3).
 *
 * DB path:
 *   Mainnet: /opt/grin/drop-main/grin_drop_main.db
 *   Testnet: /opt/grin/drop-test/grin_drop_test.db
 *   (set via DROP_DB environment variable)
 *
 * Tables:
 *   claims    — one row per giveaway transaction
 *               status: pending → waiting_finalize → confirmed | failed | cancelled
 *   donations — recorded incoming donations
 *               type:   'manual' | 'slatepack' | 'invoice'
 *               status: 'pending' | 'confirmed' | 'expired'
 *
 * Migration: ALTER TABLE ADD COLUMN is used for columns new to the Node.js
 * version so existing Python-created DBs are upgraded in-place without data loss.
 */

const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DROP_DB
  || '/opt/grin/drop-test/grin_drop_test.db';

let _db = null;

function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _initSchema(_db);
  return _db;
}

// ── Schema ────────────────────────────────────────────────────────────────────

function _initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS claims (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      grin_address  TEXT    NOT NULL,
      amount        REAL    NOT NULL,
      tx_slate_id   TEXT    DEFAULT '',
      slatepack_out TEXT    DEFAULT '',
      slatepack_in  TEXT    DEFAULT '',
      status        TEXT    NOT NULL DEFAULT 'pending',
      created_at    TEXT    NOT NULL,
      expires_at    TEXT    NOT NULL,
      confirmed_at  TEXT    DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_claims_address ON claims(grin_address);
    CREATE INDEX IF NOT EXISTS idx_claims_status  ON claims(status);

    CREATE TABLE IF NOT EXISTS donations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      amount        REAL    NOT NULL DEFAULT 0,
      tx_id         TEXT    DEFAULT '',
      from_address  TEXT    DEFAULT '',
      note          TEXT    DEFAULT '',
      type          TEXT    DEFAULT 'manual',
      status        TEXT    DEFAULT 'confirmed',
      invoice_id    TEXT    DEFAULT '',
      slatepack_in  TEXT    DEFAULT '',
      expires_at    TEXT    DEFAULT '',
      created_at    TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_donations_created    ON donations(created_at);
    CREATE INDEX IF NOT EXISTS idx_donations_invoice_id ON donations(invoice_id);
  `);

  // Migration: add new columns to existing Python-created DBs
  const donationNewCols = [
    ['type',         "TEXT DEFAULT 'manual'"],
    ['status',       "TEXT DEFAULT 'confirmed'"],
    ['invoice_id',   "TEXT DEFAULT ''"],
    ['slatepack_in', "TEXT DEFAULT ''"],
    ['expires_at',   "TEXT DEFAULT ''"],
  ];
  for (const [col, def] of donationNewCols) {
    try {
      db.exec(`ALTER TABLE donations ADD COLUMN ${col} ${def}`);
    } catch {
      // Column already exists — expected on second+ startup
    }
  }
}

// ── Time helper ───────────────────────────────────────────────────────────────

function _nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function _addMinutes(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ── Claims — reads ─────────────────────────────────────────────────────────────

function getClaim(id) {
  return getDb().prepare('SELECT * FROM claims WHERE id = ?').get(id) || null;
}

/**
 * Return the most recent active claim for this address (pending, waiting, or confirmed).
 * Used to enforce the claim window rate limit.
 */
function lastActiveClaim(address) {
  return getDb().prepare(
    `SELECT * FROM claims
     WHERE grin_address = ?
       AND status IN ('confirmed', 'waiting_finalize', 'pending')
     ORDER BY created_at DESC LIMIT 1`
  ).get(address) || null;
}

function countClaimsToday() {
  const today = new Date().toISOString().slice(0, 10);
  return getDb()
    .prepare("SELECT COUNT(*) as c FROM claims WHERE created_at LIKE ? AND status = 'confirmed'")
    .get(today + '%').c;
}

function countClaimsTotal() {
  return getDb()
    .prepare("SELECT COUNT(*) as c FROM claims WHERE status = 'confirmed'")
    .get().c;
}

function getExpiredClaims() {
  const now = _nowIso();
  return getDb().prepare(
    "SELECT * FROM claims WHERE status = 'waiting_finalize' AND expires_at <= ?"
  ).all(now);
}

function getTotalGivenGrin() {
  return getDb()
    .prepare("SELECT COALESCE(SUM(amount), 0) as s FROM claims WHERE status = 'confirmed'")
    .get().s || 0;
}

function getClaimsPaginated(page, perPage, statusFilter = '') {
  const offset = (page - 1) * perPage;
  if (statusFilter) {
    return getDb().prepare(
      'SELECT * FROM claims WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(statusFilter, perPage, offset);
  }
  return getDb().prepare(
    'SELECT * FROM claims ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(perPage, offset);
}

function countClaimsFiltered(statusFilter = '') {
  if (statusFilter) {
    return getDb()
      .prepare('SELECT COUNT(*) as c FROM claims WHERE status = ?')
      .get(statusFilter).c;
  }
  return getDb().prepare('SELECT COUNT(*) as c FROM claims').get().c;
}

function searchClaims(query, page, perPage) {
  const offset = (page - 1) * perPage;
  const like = `%${query}%`;
  const rows = getDb().prepare(
    'SELECT * FROM claims WHERE grin_address LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(like, perPage, offset);
  const total = getDb()
    .prepare('SELECT COUNT(*) as c FROM claims WHERE grin_address LIKE ?')
    .get(like).c;
  return { rows, total };
}

// ── Claims — writes ────────────────────────────────────────────────────────────

function createClaim(address, amount, timeoutMin) {
  const now      = _nowIso();
  const expiresAt = _addMinutes(timeoutMin);
  const stmt = getDb().prepare(
    `INSERT INTO claims (grin_address, amount, status, created_at, expires_at)
     VALUES (?, ?, 'pending', ?, ?)`
  );
  return stmt.run(address, amount, now, expiresAt).lastInsertRowid;
}

function setSlatepackOut(id, slatepack) {
  getDb().prepare(
    "UPDATE claims SET slatepack_out = ?, status = 'waiting_finalize' WHERE id = ?"
  ).run(slatepack, id);
}

function setClaimFinalized(id, slatepackIn, txSlateId) {
  getDb().prepare(
    `UPDATE claims
     SET slatepack_in = ?, tx_slate_id = ?, status = 'confirmed', confirmed_at = ?
     WHERE id = ?`
  ).run(slatepackIn, txSlateId, _nowIso(), id);
}

function setClaimStatus(id, status) {
  getDb().prepare('UPDATE claims SET status = ? WHERE id = ?').run(status, id);
}

function cancelExpiredClaim(id) {
  getDb().prepare(
    "UPDATE claims SET status = 'cancelled' WHERE id = ? AND status = 'waiting_finalize'"
  ).run(id);
}

// ── Donations — reads ──────────────────────────────────────────────────────────

function getTotalReceivedGrin() {
  return getDb()
    .prepare("SELECT COALESCE(SUM(amount), 0) as s FROM donations WHERE status = 'confirmed'")
    .get().s || 0;
}

function getDonationsList(limit = 100) {
  return getDb().prepare(
    'SELECT * FROM donations ORDER BY id DESC LIMIT ?'
  ).all(limit);
}

function getDonationByInvoiceId(invoiceId) {
  return getDb().prepare(
    "SELECT * FROM donations WHERE invoice_id = ? AND status = 'pending'"
  ).get(invoiceId) || null;
}

// ── Donations — writes ─────────────────────────────────────────────────────────

function addManualDonation(amount, txId = '', fromAddress = '', note = '') {
  return getDb().prepare(
    `INSERT INTO donations (amount, tx_id, from_address, note, type, status, created_at)
     VALUES (?, ?, ?, ?, 'manual', 'confirmed', ?)`
  ).run(amount, txId, fromAddress, note, _nowIso()).lastInsertRowid;
}

function createSlatepackDonation(address) {
  return getDb().prepare(
    `INSERT INTO donations (amount, from_address, type, status, created_at)
     VALUES (0, ?, 'slatepack', 'pending', ?)`
  ).run(address, _nowIso()).lastInsertRowid;
}

function createInvoiceDonation(amount, address, invoiceId, timeoutMin) {
  const expiresAt = _addMinutes(timeoutMin);
  return getDb().prepare(
    `INSERT INTO donations (amount, from_address, type, status, invoice_id, expires_at, created_at)
     VALUES (?, ?, 'invoice', 'pending', ?, ?, ?)`
  ).run(amount, address, invoiceId, expiresAt, _nowIso()).lastInsertRowid;
}

function confirmInvoiceDonation(invoiceId, txId) {
  getDb().prepare(
    "UPDATE donations SET status = 'confirmed', tx_id = ? WHERE invoice_id = ? AND status = 'pending'"
  ).run(txId, invoiceId);
}

function expireOldInvoices() {
  const now = _nowIso();
  const result = getDb().prepare(
    "UPDATE donations SET status = 'expired' WHERE type = 'invoice' AND status = 'pending' AND expires_at <= ?"
  ).run(now);
  return result.changes;
}

// ── Aggregates ─────────────────────────────────────────────────────────────────

function getStatsSummary() {
  const db    = getDb();
  const today = new Date().toISOString().slice(0, 10);
  return {
    claims_today:    db.prepare("SELECT COUNT(*) as c FROM claims WHERE created_at LIKE ? AND status = 'confirmed'").get(today + '%').c,
    claims_total:    db.prepare("SELECT COUNT(*) as c FROM claims WHERE status = 'confirmed'").get().c,
    pending_count:   db.prepare("SELECT COUNT(*) as c FROM claims WHERE status IN ('waiting_finalize','pending')").get().c,
    failed_count:    db.prepare("SELECT COUNT(*) as c FROM claims WHERE status = 'failed'").get().c,
    total_given:     db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM claims WHERE status = 'confirmed'").get().s || 0,
    total_received:  db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM donations WHERE status = 'confirmed'").get().s || 0,
    donations_count: db.prepare("SELECT COUNT(*) as c FROM donations").get().c,
  };
}

function getPublicStats() {
  const db = getDb();
  return {
    total_given:     db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM claims WHERE status = 'confirmed'").get().s || 0,
    total_received:  db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM donations WHERE status = 'confirmed'").get().s || 0,
    claims_total:    db.prepare("SELECT COUNT(*) as c FROM claims WHERE status = 'confirmed'").get().c,
    donations_total: db.prepare("SELECT COUNT(*) as c FROM donations WHERE status = 'confirmed'").get().c,
  };
}

// ── CSV export ─────────────────────────────────────────────────────────────────

function getConfirmedClaimsForExport() {
  return getDb().prepare(
    `SELECT id, grin_address, amount, confirmed_at, tx_slate_id
     FROM claims WHERE status = 'confirmed' ORDER BY id ASC`
  ).all();
}

module.exports = {
  // Claims
  getClaim,
  lastActiveClaim,
  countClaimsToday,
  countClaimsTotal,
  getExpiredClaims,
  getTotalGivenGrin,
  getClaimsPaginated,
  countClaimsFiltered,
  searchClaims,
  createClaim,
  setSlatepackOut,
  setClaimFinalized,
  setClaimStatus,
  cancelExpiredClaim,
  // Donations
  getTotalReceivedGrin,
  getDonationsList,
  getDonationByInvoiceId,
  addManualDonation,
  createSlatepackDonation,
  createInvoiceDonation,
  confirmInvoiceDonation,
  expireOldInvoices,
  // Aggregates
  getStatsSummary,
  getPublicStats,
  getConfirmedClaimsForExport,
};
