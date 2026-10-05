'use strict';

// grinium-games.db — open, pragmas, numbered migrations (design §19.4, D3).
//
// This is the games service's OWN database and its only one. It never opens pool.db
// (D5): the pool is reached through the three internal routes, never through its files.
//
// Patterns copied (not imported — the two services deploy separately) from the pool's
// lib/db.js and lib/sqlite-compat.js. Two deliberate differences:
//   - busy_timeout is 2000, not the pool's 5000 (D3). Nothing else writes this file while
//     the service runs; the only other openers are the backup's `sqlite3 .backup` (a
//     reader) and the weekly VACUUM, whose cron wrapper stops the service first (§19.12).
//   - the file is created 0600 BEFORE SQLite opens it, instead of chmod'ing it after. The
//     pool's reason for 0600 applies unchanged (its restrictDbFileModes comment: systemd's
//     UMask 0022 makes a new DB 0644, and chat bodies, sessions and addresses would be
//     world-readable). SQLite gives the -wal and -shm files the main file's mode, so
//     pre-creating closes the window between create and chmod. The chmod still runs after,
//     for a file an older build or a hand-copy left 0644.
//
// Every value stays below 2^53: node:sqlite THROWS reading a larger INTEGER, and one such
// row kills the whole result set. Hash- and seed-like values are hex TEXT (§19.4).

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// ── Migrations ────────────────────────────────────────────────────────────────────────
// Append only. A migration's SQL is never edited after it has shipped: a box that already
// ran it would silently disagree with a fresh install. Each one runs inside ONE
// transaction together with its schema_version bump, so it either lands whole or not at
// all — which is what makes a re-run a no-op (the version gate skips it). The statements
// are plain CREATE, not CREATE IF NOT EXISTS, on purpose: a half-matching leftover table
// fails the migration loudly instead of being adopted with the wrong shape.

const MIGRATIONS = [
  {
    version: 1,
    name: 'schema v1 (design §19.4)',
    sql: `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE players (
  address       TEXT PRIMARY KEY,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  plays         INTEGER NOT NULL DEFAULT 0 CHECK (plays  >= 0),
  points        INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  points_day    TEXT,
  points_today  INTEGER NOT NULL DEFAULT 0,
  banned_until  INTEGER,
  muted_until   INTEGER,
  badges_json   TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_players_points ON players(points DESC);

CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  address       TEXT NOT NULL REFERENCES players(address),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  ip_coarse     TEXT,
  ua_hint       TEXT,
  proof_kind    TEXT NOT NULL CHECK (proof_kind IN ('ip','password')),
  proof_slot    TEXT NOT NULL CHECK (proof_slot IN ('set','anchor')),
  chat_ok_after INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX idx_sessions_address ON sessions(address, revoked_at);
CREATE INDEX idx_sessions_expiry  ON sessions(expires_at);

CREATE TABLE activity_sync (
  id INTEGER PRIMARY KEY, window_from INTEGER NOT NULL UNIQUE, window_to INTEGER NOT NULL,
  rows INTEGER NOT NULL, synced_at INTEGER NOT NULL
);
CREATE TABLE activity_daily (
  address TEXT NOT NULL, day TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  plays_awarded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (address, day)
);
CREATE INDEX idx_activity_day ON activity_daily(day);

CREATE TABLE ledger (
  id INTEGER PRIMARY KEY, address TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('plays','points')),
  delta INTEGER NOT NULL CHECK (delta <> 0),
  reason TEXT NOT NULL,
  ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ledger_address ON ledger(address, kind, id);
CREATE UNIQUE INDEX uq_ledger_ref ON ledger(address, kind, reason, ref) WHERE ref IS NOT NULL;

CREATE TABLE matches (
  id            INTEGER PRIMARY KEY,
  game_id       TEXT NOT NULL,
  game_version  TEXT NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('bot','pvp')),
  state         TEXT NOT NULL CHECK (state IN ('seek','challenge','active','finished','aborted','declined','expired','void')),
  seat1         TEXT,
  seat2         TEXT,
  created_by    TEXT NOT NULL,
  target        TEXT,
  params_json   TEXT NOT NULL,
  seed          TEXT,
  position      TEXT NOT NULL,
  ply           INTEGER NOT NULL DEFAULT 0,
  turn_deadline INTEGER,
  draw_offer_by INTEGER CHECK (draw_offer_by IN (1,2)),
  result        TEXT CHECK (result IN ('seat1','seat2','draw')),
  reason        TEXT,
  rated         INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, last_move_at INTEGER
);
CREATE INDEX idx_matches_seat1  ON matches(seat1, state);
CREATE INDEX idx_matches_seat2  ON matches(seat2, state);
CREATE INDEX idx_matches_target ON matches(target, state);
CREATE INDEX idx_matches_state  ON matches(state, turn_deadline);
CREATE INDEX idx_matches_pair   ON matches(game_id, seat1, seat2, finished_at);
CREATE UNIQUE INDEX uq_matches_one_bot ON matches(game_id, created_by) WHERE mode = 'bot' AND state = 'active';

CREATE TABLE match_moves (
  match_id INTEGER NOT NULL REFERENCES matches(id), ply INTEGER NOT NULL,
  seat INTEGER NOT NULL CHECK (seat IN (1,2)), move TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (match_id, ply)
) WITHOUT ROWID;

CREATE TABLE ratings (
  game_id TEXT NOT NULL, address TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 1200, games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY (game_id, address)
);
CREATE INDEX idx_ratings_board ON ratings(game_id, rating DESC);

CREATE TABLE results_daily (
  address TEXT NOT NULL, game_id TEXT NOT NULL, mode TEXT NOT NULL, day TEXT NOT NULL,
  games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0, points INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (address, game_id, mode, day)
);
CREATE INDEX idx_results_board ON results_daily(game_id, mode, day);

CREATE TABLE events (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, game_id TEXT,
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
  rules_json TEXT NOT NULL, reward_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('scheduled','running','finalising','done','cancelled')),
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_state ON events(state, ends_at);
CREATE TABLE event_results (
  event_id INTEGER NOT NULL REFERENCES events(id), address TEXT NOT NULL,
  value INTEGER NOT NULL, rank INTEGER NOT NULL, reward_points INTEGER NOT NULL DEFAULT 0, badge TEXT,
  PRIMARY KEY (event_id, address)
);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY, room TEXT NOT NULL DEFAULT 'global',
  role TEXT NOT NULL CHECK (role IN ('player','operator')),
  address TEXT,
  admin_user TEXT,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('visible','held','deleted')),
  hold_reason TEXT, created_at INTEGER NOT NULL, deleted_by TEXT, reason TEXT
);
CREATE INDEX idx_chat_room    ON chat_messages(room, state, id);
CREATE INDEX idx_chat_address ON chat_messages(address, created_at);
CREATE TABLE chat_reports (
  id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES chat_messages(id),
  reporter TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT,
  UNIQUE (message_id, reporter)
);
CREATE INDEX idx_reports_open ON chat_reports(resolved_at, id);

CREATE TABLE mod_actions (
  id INTEGER PRIMARY KEY, admin_user TEXT NOT NULL, action TEXT NOT NULL, target TEXT,
  details_json TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_mod_actions_time ON mod_actions(created_at);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT);
`,
  },
  {
    // Part 8 (design §19.10, D21): chat moderators appointed by the operator, and the
    // operator-edited word list. New tables only — no ALTER, so the stored CREATE text of
    // every v1 table is unchanged and §19.4's block stays comparable as text.
    version: 2,
    name: 'chat moderators + word list (design §19.4, D21)',
    sql: `
CREATE TABLE moderators (
  address  TEXT PRIMARY KEY REFERENCES players(address),
  added_by TEXT NOT NULL, added_at INTEGER NOT NULL, note TEXT
);
CREATE TABLE chat_words (
  word TEXT PRIMARY KEY, added_by TEXT NOT NULL, added_at INTEGER NOT NULL
);
`,
  },
  {
    // Part 12 (design §19.16): approved nicknames. A request log, not a column on players —
    // history and the operator's decisions come free, and the three partial unique indexes
    // make "one pending + one live per address" and "no two live nicknames alike" database
    // facts rather than checks a race could slip past.
    version: 3,
    name: 'approved nicknames (design §19.4, §19.16)',
    sql: `
CREATE TABLE nicknames (
  id           INTEGER PRIMARY KEY,
  address      TEXT NOT NULL REFERENCES players(address),
  name         TEXT NOT NULL,
  norm         TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending','approved','rejected','replaced','withdrawn','removed')),
  submitted_at INTEGER NOT NULL,
  decided_at   INTEGER, decided_by TEXT, reason TEXT
);
CREATE UNIQUE INDEX uq_nick_pending  ON nicknames(address) WHERE state = 'pending';
CREATE UNIQUE INDEX uq_nick_live     ON nicknames(address) WHERE state = 'approved';
CREATE UNIQUE INDEX uq_nick_norm     ON nicknames(norm) WHERE state = 'approved';
CREATE INDEX idx_nick_state ON nicknames(state, id);
CREATE INDEX idx_nick_address ON nicknames(address, submitted_at);
CREATE INDEX idx_nick_norm ON nicknames(norm, state);
`,
  },
  {
    // Part C3 (design §19.17.5, D27): names are checked automatically and live at once. A
    // banned-name table (the matching form is the key, so every spelling of a banned name is
    // refused), and four player columns: the nickname block, the last change (the cooldown),
    // and the refused-attempt counter (so the word list cannot be probed). ADD COLUMN rewrites
    // the stored CREATE text of `players` the same way §19.4's own ALTERs do, so the block
    // stays comparable as text. `pending` stays in the CHECK and simply stops being written.
    version: 4,
    name: 'names v2: banned names + nickname columns (design §19.4, §19.17.5)',
    sql: `
CREATE TABLE banned_names (
  norm      TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  banned_at INTEGER NOT NULL,
  banned_by TEXT NOT NULL,
  reason    TEXT
);
ALTER TABLE players ADD COLUMN nick_blocked INTEGER NOT NULL DEFAULT 0 CHECK (nick_blocked IN (0,1));
ALTER TABLE players ADD COLUMN nick_changed_at INTEGER;
ALTER TABLE players ADD COLUMN nick_refused_day TEXT;
ALTER TABLE players ADD COLUMN nick_refused_n INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_players_nick_blocked ON players(nick_blocked) WHERE nick_blocked = 1;
`,
    // Part 12's rows under the v2 rule, deterministically (§19.17.5): a live name that fails it
    // → removed; a pending one → approved when it passes and no other live name reads the same,
    // else rejected. Only the parts of the rule this DB can know apply here — the seed, the
    // reserved words and the chat word list; the pool's name and its list arrive later over the
    // link. Nothing had deployed v3 when this was written, so no real player is affected; the
    // step exists so a box that did install Part 12 lands in a defined state.
    run(raw, now) {
      const rule = require('./name-rule');
      const ctx = { words: rule.compileList(raw.prepare('SELECT word FROM chat_words').all().map((r) => r.word)) };
      const decide = raw.prepare("UPDATE nicknames SET state = ?, decided_at = ?, decided_by = 'system', reason = ? WHERE id = ?");
      for (const r of raw.prepare("SELECT id, name FROM nicknames WHERE state = 'approved' ORDER BY id").all()) {
        if (!rule.check(r.name, ctx).ok) decide.run('removed', now, 'rule_v2', r.id);
      }
      const takenBy = raw.prepare("SELECT 1 AS x FROM nicknames WHERE norm = ? AND state = 'approved' AND address != ?");
      const liveOf = raw.prepare("SELECT id FROM nicknames WHERE address = ? AND state = 'approved'");
      const approve = raw.prepare("UPDATE nicknames SET state = 'approved', norm = ?, decided_at = ?, decided_by = 'system', reason = NULL WHERE id = ?");
      const stamp = raw.prepare('UPDATE players SET nick_changed_at = ? WHERE address = ?');
      for (const r of raw.prepare("SELECT id, address, name FROM nicknames WHERE state = 'pending' ORDER BY id").all()) {
        const v = rule.check(r.name, ctx);
        if (!v.ok) { decide.run('rejected', now, 'rule_v2', r.id); continue; }
        if (takenBy.get(v.norm, r.address)) { decide.run('rejected', now, 'taken', r.id); continue; }
        const prev = liveOf.get(r.address);
        if (prev) decide.run('replaced', now, null, prev.id);
        approve.run(v.norm, now, r.id);
        stamp.run(now, r.address);
      }
    },
  },
  {
    // Part C5 (design §19.17.3/§19.17.4, D24/D25): guest accounts. A guest is a `players` row
    // like any other (id 'g:' + 16 base32 in the address column, so every games table works
    // unchanged) plus a `guests` row holding the credentials. Deleting a guest deletes the
    // `guests` row (the login name is free at once) and KEEPS the players row, marked
    // deleted_at, so history still resolves. guest_signups is the per-IP sign-up count — a
    // separate table so that deleting an account does not hand its IP a fresh slot, and so the
    // /24 is never stored beside the account it created.
    //
    // sessions: proof_kind must accept 'guest', and SQLite cannot ALTER a CHECK, so the table
    // is REBUILT. Not create-new → rename: RENAME stores the new name quoted ("sessions") in
    // sqlite_master, and §19.4 is compared as text. So: copy out → drop → create (the
    // canonical text) → copy back → drop the copy, all in this one transaction.
    version: 5,
    name: 'guest accounts + sessions rebuild (design §19.4, §19.17.3)',
    sql: `
CREATE TABLE guests (
  id            TEXT PRIMARY KEY REFERENCES players(address),
  login_name    TEXT NOT NULL,
  login_norm    TEXT NOT NULL UNIQUE,
  pass_hash     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);
CREATE INDEX idx_guests_idle ON guests(last_login_at);
CREATE TABLE guest_signups (
  id         INTEGER PRIMARY KEY,
  ip_coarse  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_guest_signups_ip ON guest_signups(ip_coarse, created_at);
ALTER TABLE players ADD COLUMN kind TEXT NOT NULL DEFAULT 'miner' CHECK (kind IN ('miner','guest'));
ALTER TABLE players ADD COLUMN deleted_at INTEGER;
ALTER TABLE players ADD COLUMN guest_day TEXT;
CREATE TABLE sessions_v4_copy AS SELECT * FROM sessions;
DROP TABLE sessions;
CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  address       TEXT NOT NULL REFERENCES players(address),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  ip_coarse     TEXT,
  ua_hint       TEXT,
  proof_kind    TEXT NOT NULL CHECK (proof_kind IN ('ip','password','guest')),
  proof_slot    TEXT NOT NULL CHECK (proof_slot IN ('set','anchor')),
  chat_ok_after INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX idx_sessions_address ON sessions(address, revoked_at);
CREATE INDEX idx_sessions_expiry  ON sessions(expires_at);
INSERT INTO sessions (token_hash, address, created_at, expires_at, last_seen, ip_coarse, ua_hint, proof_kind, proof_slot, chat_ok_after, revoked_at)
  SELECT token_hash, address, created_at, expires_at, last_seen, ip_coarse, ua_hint, proof_kind, proof_slot, chat_ok_after, revoked_at FROM sessions_v4_copy;
DROP TABLE sessions_v4_copy;
`,
  },
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

// ── Transactions ──────────────────────────────────────────────────────────────────────
// Mirrors sqlite-compat.js's nesting semantics: the outermost call is a real transaction,
// a call from inside one becomes a SAVEPOINT that rolls back alone. The outermost is
// BEGIN IMMEDIATE (§19.8): it takes the write lock up front, so two writers can never
// both read under a deferred BEGIN and then deadlock on the upgrade.
//
// The callback must be SYNCHRONOUS. DatabaseSync has one connection for the whole
// process, so an `await` inside a transaction would let every other request's statements
// run inside it — and commit or roll back with it. A returned promise is refused and the
// transaction rolled back.

function makeTransaction(raw) {
  let depth = 0;
  return function transaction(fn) {
    const isPromise = (v) => v !== null && typeof v === 'object' && typeof v.then === 'function';
    if (depth > 0) {
      const sp = `games_sp_${depth}`;
      raw.exec(`SAVEPOINT ${sp}`);
      depth++;
      try {
        const result = fn();
        if (isPromise(result)) throw new Error('transaction callback must be synchronous');
        raw.exec(`RELEASE ${sp}`);
        return result;
      } catch (err) {
        raw.exec(`ROLLBACK TO ${sp}`);
        raw.exec(`RELEASE ${sp}`);
        throw err;
      } finally {
        depth--;
      }
    }
    raw.exec('BEGIN IMMEDIATE');
    depth = 1;
    try {
      const result = fn();
      if (isPromise(result)) throw new Error('transaction callback must be synchronous');
      raw.exec('COMMIT');
      return result;
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    } finally {
      depth = 0;
    }
  };
}

// ── Open ──────────────────────────────────────────────────────────────────────────────

function readSchemaVersion(raw) {
  const hasMeta = raw.prepare(
    "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) return 0;
  const row = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) return 0;
  if (!/^[0-9]{1,6}$/.test(row.value)) throw new Error(`meta.schema_version is not an integer: ${JSON.stringify(row.value).slice(0, 40)}`);
  return Number(row.value);
}

function migrate(raw, transaction, now) {
  const from = readSchemaVersion(raw);
  if (from > LATEST_VERSION) {
    throw new Error(`database schema v${from} is newer than this build (v${LATEST_VERSION}) — refusing to run an older build against it`);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    transaction(() => {
      raw.exec(m.sql);
      // A data step (v4: re-checking Part 12's rows) runs in the SAME transaction, so the
      // schema change and the data it implies land together or not at all.
      if (typeof m.run === 'function') m.run(raw, now);
      raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
                  "ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(m.version));
      if (m.version === 1) {
        raw.prepare("INSERT INTO meta (key, value) VALUES ('created_at', ?)").run(String(now));
        // A brand-new DB starts in preview (§19.17.2, D30): the pool's mode now defaults to
        // 'on', and installing the games must not announce them before the operator's Go live.
        // An upgraded DB has no row and reads as preview anyway (mode.js) — so this is not a
        // migration, only the explicit form of the default.
        raw.prepare("INSERT INTO meta (key, value) VALUES ('launch', 'preview') ON CONFLICT(key) DO NOTHING").run();
      }
    });
  }
  return { from, to: readSchemaVersion(raw) };
}

// A mainnet DB must never open as testnet or the other way round: players, plays and
// ratings are per network. The first open stamps meta.net; every later open checks it.
// Called BEFORE migrating (so a future migration never runs against the other net's
// file) and again after (to stamp a brand-new DB, which has no meta table until v1).
function checkNet(raw, net) {
  const hasMeta = raw.prepare(
    "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) return;
  const row = raw.prepare("SELECT value FROM meta WHERE key = 'net'").get();
  if (!row) {
    raw.prepare("INSERT INTO meta (key, value) VALUES ('net', ?)").run(net);
    return;
  }
  if (row.value !== net) {
    throw new Error(`database belongs to ${JSON.stringify(row.value).slice(0, 20)}, this service is ${net} — refusing to open it`);
  }
}

function restrictFileModes(file, log) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    } catch (e) {
      if (log) log.warn(`[db] could not restrict permissions on ${f}: ${e.code || e.message}`);
    }
  }
}

function pragmaValue(raw, name) {
  const row = raw.prepare(`PRAGMA ${name}`).get();
  return row === undefined ? undefined : row[Object.keys(row)[0]];
}

// openDb(file, { net, log, now }) — file is an absolute path or ':memory:' (tests).
// Returns { raw, transaction, schemaVersion(), close(), file }.
function openDb(file, { net, log, now = () => Math.floor(Date.now() / 1000) } = {}) {
  if (net !== 'mainnet' && net !== 'testnet') throw new Error('openDb: net must be mainnet or testnet');
  const memory = file === ':memory:';

  if (!memory) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // 'a' creates the file if missing and never truncates an existing one.
    fs.closeSync(fs.openSync(file, 'a', 0o600));
  }

  const raw = new DatabaseSync(file);
  try {
    if (!memory) {
      const mode = raw.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
      if (mode !== 'wal') throw new Error(`journal_mode is ${mode}, expected wal`);
    }
    raw.exec('PRAGMA synchronous = NORMAL');
    raw.exec('PRAGMA busy_timeout = 2000');
    raw.exec('PRAGMA foreign_keys = ON');
    // foreign_keys is silently a no-op inside a transaction or on a build without FK
    // support; read it back rather than trust the statement.
    if (pragmaValue(raw, 'foreign_keys') !== 1) throw new Error('foreign_keys did not turn on');

    const transaction = makeTransaction(raw);
    checkNet(raw, net);
    const { from, to } = migrate(raw, transaction, now());
    checkNet(raw, net);
    if (!memory) restrictFileModes(file, log);
    if (log && from !== to) log.info(`[db] migrated schema v${from} → v${to}`);

    return {
      raw,
      file,
      transaction,
      schemaVersion: () => readSchemaVersion(raw),
      migrate: () => migrate(raw, transaction, now()),   // idempotent; the tests re-run it
      close: () => { if (raw.isOpen) raw.close(); },
    };
  } catch (err) {
    try { raw.close(); } catch { /* already failing */ }
    throw err;
  }
}

module.exports = { openDb, MIGRATIONS, LATEST_VERSION };
