'use strict';

// better-sqlite3 → node:sqlite (DatabaseSync) compatibility wrapper.
//
// The pool migrated off better-sqlite3 (native module, needs node-gyp +
// ABI-matched prebuilds) to Node's built-in sqlite (Node >= 24). The rest of
// the codebase still speaks the better-sqlite3 dialect, so this shim covers
// exactly the surface the pool uses:
//   db.prepare(sql)            -> StatementSync (.run/.get/.all/.iterate are
//                                 API-compatible between the two libraries)
//   db.exec(sql)               -> pass-through
//   db.close()                 -> pass-through
//   db.pragma(str, {simple})   -> PRAGMA via prepare(); {simple:true} returns
//                                 the first column of the first row
//   db.transaction(fn)         -> returns a function that runs fn inside
//                                 BEGIN/COMMIT, or SAVEPOINT when called from
//                                 inside another transaction() (better-sqlite3
//                                 nesting semantics — incentives.js relies on
//                                 participating in the rewards.js transaction)
//
// Do NOT add better-sqlite3-only features (pluck/raw/function/aggregate/...)
// to pool code — extend this shim first.

const { DatabaseSync } = require('node:sqlite');

class Database {
  constructor(filename) {
    this._db = new DatabaseSync(filename);
    this._txDepth = 0;
  }

  prepare(sql) { return this._db.prepare(sql); }
  exec(sql)    { return this._db.exec(sql); }
  close()      { return this._db.close(); }

  pragma(stmt, opts = {}) {
    const rows = this._db.prepare(`PRAGMA ${stmt}`).all();
    if (opts.simple) {
      const row = rows[0];
      return row === undefined ? undefined : row[Object.keys(row)[0]];
    }
    return rows;
  }

  transaction(fn) {
    const self = this;
    return function (...args) {
      if (self._txDepth > 0) {
        const sp = `compat_sp_${self._txDepth}`;
        self._db.exec(`SAVEPOINT ${sp}`);
        self._txDepth++;
        try {
          const result = fn.apply(this, args);
          self._db.exec(`RELEASE ${sp}`);
          return result;
        } catch (err) {
          self._db.exec(`ROLLBACK TO ${sp}`);
          self._db.exec(`RELEASE ${sp}`);
          throw err;
        } finally {
          self._txDepth--;
        }
      }
      self._db.exec('BEGIN');
      self._txDepth = 1;
      try {
        const result = fn.apply(this, args);
        self._db.exec('COMMIT');
        return result;
      } catch (err) {
        self._db.exec('ROLLBACK');
        throw err;
      } finally {
        self._txDepth = 0;
      }
    };
  }
}

module.exports = Database;
