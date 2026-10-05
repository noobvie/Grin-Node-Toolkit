'use strict';

// Stratum pause — restore / Migrate IN boot paused (design §21.13 Q1, plan Part 1b).
//
// The writer is bash: pbk_pause_stratum in scripts/lib/07_lib_pool_backup.sh runs a `node -e`
// against the restored pool.db while the service is stopped. This test extracts that exact JS
// from the .sh file (it sits in a single-quoted node -e precisely so it can be lifted verbatim)
// and runs it as the shell would, then boots StratumPause.load() on the result.
//
// What this pins:
//   [1] the DDL in the .sh is lib/db.js's stratum_control DDL, token for token.
//   [2] a pool.db WITHOUT the table (an archive older than the pause) → table created, row paused,
//       source 'restore', paused_by 'system:restore', settled_at + until written; load() → PAUSED.
//   [3] a full-schema pool.db with an ACCEPTING row, a scheduled window and a stale last_result →
//       paused, the window KEPT, last_result cleared; an old manual pause is overwritten.
//   [4] a bad duration → exit 1 and nothing on stdout (the bash caller then reports "will OPEN").
//   [5] the bash wiring (static): both _pbk_restore_extract branches pause before returning; the
//       reporter is called by 2) Restore; Migrate IN re-stamps BEFORE `systemctl start` and
//       rechowns after; step 7 treats a paused pool's empty stratum port as the pass.
//
// One-shot: temp DBs under os.tmpdir() are removed; no server is started. Run:
//   node scripts/test-stratum-pause-restore.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const APP = path.resolve(__dirname, '..');
const REPO = path.resolve(APP, '../../..');
const BACKUP_SH = path.join(REPO, 'scripts/lib/07_lib_pool_backup.sh');
const MIGRATE_SH = path.join(REPO, 'scripts/lib/07_lib_pool_migrate.sh');
const StratumServer = require(path.join(APP, 'lib/stratum-server.js'));
const StratumPause = require(path.join(APP, 'lib/stratum-pause.js'));
const { initDb, getDb, closeDb } = require(path.join(APP, 'lib/db.js'));

const realLog = console.log;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; realLog(`  PASS  ${name}`); }
  else { fail++; realLog(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const quiet = (fn) => (...a) => {
  const l = console.log, w = console.warn, e = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return fn(...a); } finally { console.log = l; console.warn = w; console.error = e; }
};

const backupSh = fs.readFileSync(BACKUP_SH, 'utf8');
const migrateSh = fs.readFileSync(MIGRATE_SH, 'utf8');
const dbJs = fs.readFileSync(path.join(APP, 'lib/db.js'), 'utf8');

const norm = (s) => s.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
const fnBody = (src, name) => {
  const m = src.match(new RegExp(`\\n${name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}\\n`));
  return m ? m[1] : '';
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stratum-pause-restore-'));
const NOW = () => Math.floor(Date.now() / 1000);

// The JS between `node -e '` and `' "$db"` inside pbk_pause_stratum.
const writerBody = fnBody(backupSh, 'pbk_pause_stratum');
const jsMatch = writerBody.match(/node -e '\n([\s\S]*?)\n' "\$db" "\$reason" "\$by" "\$PBK_STRATUM_PAUSE_S"/);
const writerJs = jsMatch ? jsMatch[1] : '';

function runWriter(dbPath, secs = '7200', reason = 'pool.db restored — test', by = 'system:restore') {
  // `node -e <js> args…` exactly as the shell runs it (argv[1] is the first arg under -e).
  const r = spawnSync(process.execPath, ['-e', writerJs, dbPath, reason, by, secs], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const bootLoad = quiet((dbPath) => {
  const db = initDb(dbPath);
  const sp = new StratumPause({ db, stratumServer: new StratumServer({ stratum_port: 1 }, { sessions: new Map() }) });
  const paused = sp.load();
  const st = sp.status();
  closeDb();
  return { paused, st };
});

(function main() {
  realLog('\n[1] DDL parity — the .sh repeats lib/db.js verbatim');
  const shDdl = (writerJs.match(/CREATE TABLE IF NOT EXISTS stratum_control \([\s\S]*?\)\)"/) || [''])[0].replace(/"$/, '');
  const jsDdl = (dbJs.match(/CREATE TABLE IF NOT EXISTS stratum_control \([\s\S]*?\n\s*\)`/) || [''])[0].replace(/`$/, '');
  ok('writer JS extracted from pbk_pause_stratum', writerJs.length > 200);
  ok('writer JS has no single quote (it lives in a single-quoted node -e)', writerJs.length > 0 && !writerJs.includes("'"));
  ok('both DDLs found', shDdl.length > 100 && jsDdl.length > 100);
  ok('stratum_control DDL identical (whitespace-normalised)', norm(shDdl) === norm(jsDdl),
    `\n      sh: ${norm(shDdl)}\n      js: ${norm(jsDdl)}`);
  ok('default pause length is 2 h', /PBK_STRATUM_PAUSE_S="\$\{PBK_STRATUM_PAUSE_S:-7200\}"/.test(backupSh));

  realLog('\n[2] a pool.db with no stratum_control table (pre-pause archive)');
  {
    const p = path.join(tmp, 'old.db');
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(p);
    d.exec('CREATE TABLE payout_control (id INTEGER PRIMARY KEY, frozen INTEGER)');
    d.close();
    const t0 = NOW();
    const r = runWriter(p);
    ok('writer exits 0', r.code === 0, r.err);
    const until = Number(r.out);
    ok('stdout is the until, ~now + 7200', Number.isInteger(until) && until >= t0 + 7200 && until <= NOW() + 7200, r.out);
    const { paused, st } = bootLoad(p);
    ok('load() → PAUSED', paused === true);
    ok('source restore, paused_by system:restore', st.source === 'restore' && st.paused_by === 'system:restore');
    ok('until is the printed one', st.until === until);
    ok('since + settled_at stamped (nothing in flight — service stopped)', st.since >= t0 && st.settled_at >= t0);
    ok('reason carried', st.reason === 'pool.db restored — test');
  }

  realLog('\n[3] a full-schema pool.db with an existing row');
  {
    const p = path.join(tmp, 'full.db');
    const db = quiet(initDb)(p);
    const start = NOW() + 86400;
    db.prepare(`INSERT INTO stratum_control (id, paused, planned_start, planned_end, planned_reason, planned_by, last_result)
      VALUES (1, 0, ?, ?, 'node upgrade', 'admin:a', '{"at":1,"results":[]}')`).run(start, start + 3600);
    closeDb();
    const r = runWriter(p);
    ok('writer exits 0 on an existing ACCEPTING row', r.code === 0, r.err);
    const { paused, st } = bootLoad(p);
    ok('load() → PAUSED', paused === true && st.source === 'restore');
    ok('scheduled window kept', st.planned && st.planned.start === start && st.planned.reason === 'node upgrade');
    ok('stale last_result cleared', st.last_result === null);

    // The old hub's own pause (Migrate OUT after "pause 60 min") travels inside pool.db.
    const db2 = quiet(initDb)(p);
    db2.prepare(`UPDATE stratum_control SET source = 'manual', paused_by = 'admin:a', reason = 'hub move',
      since = 100, settled_at = 100, until = 200 WHERE id = 1`).run();
    closeDb();
    const r2 = runWriter(p, '7200', 'hub moved here (Migrate IN) — test');
    const b = bootLoad(p);
    ok('an old (expired) manual pause is overwritten with a fresh 2 h restore pause',
      r2.code === 0 && b.st.source === 'restore' && b.st.until === Number(r2.out) && b.st.since > 200);
  }

  realLog('\n[4] failures report, never half-write');
  {
    const p = path.join(tmp, 'bad.db');
    const r = runWriter(p, 'abc');
    ok('a non-numeric duration → exit 1, empty stdout', r.code === 1 && r.out === '', `code=${r.code} out=${r.out}`);
    const r0 = runWriter(p, '0');
    ok('a zero duration → exit 1 (until must be in the future)', r0.code === 1 && r0.out === '');
    ok('…and nothing was written (the DB was never even created)', !fs.existsSync(p));
  }

  realLog('\n[5] bash wiring (static)');
  {
    const ext = fnBody(backupSh, '_pbk_restore_extract');
    const failBranch = ext.slice(ext.indexOf('if ! tar -xzf'), ext.indexOf('return 1'));
    ok('failed-extract branch pauses before return 1', failBranch.includes('_pbk_restore_pause_stratum'));
    const okBranch = ext.slice(ext.indexOf('if pbk_freeze_payouts "$POOL_APP_DIR/pool.db"'));
    ok('success branch pauses after the freeze', /PBK_EXTRACT_FROZEN=1; else rc=2; fi[\s\S]*?_pbk_restore_pause_stratum[\s\S]*?else\s+rc=3/.test(okBranch));
    ok('PBK_EXTRACT_PAUSED reset on entry', /PBK_EXTRACT_PAUSED=0\n\s+PBK_EXTRACT_PAUSE_UNTIL=""/.test(ext));
    const helper = fnBody(backupSh, '_pbk_restore_pause_stratum');
    ok('helper never fails the restore (returns 0)', /return 0\s*$/.test(helper) && helper.includes("'system:restore'"));
    const restore = fnBody(backupSh, 'pbk_restore');
    ok('2) Restore reports the pause', (restore.match(/_pbk_report_stratum_pause/g) || []).length >= 3);
    ok('pause written before the de-root sweep (pbk_restore)', restore.indexOf('_pbk_restore_extract "$tmp_clear"') < restore.lastIndexOf('_pbk_restore_perms'));

    const start = fnBody(migrateSh, '_pmg_in_start');
    const iPause = start.indexOf('pbk_pause_stratum "$(_pmg_db)"');
    const iChown = start.indexOf('_pmg_rechown_db', iPause);
    const iStart = start.indexOf('systemctl start "$POOL_SERVICE"');
    ok('Migrate IN re-stamps the pause BEFORE systemctl start', iPause > 0 && iStart > iPause);
    ok('…and rechowns pool.db between the two', iChown > iPause && iChown < iStart);
    ok('step 7 reads stratum state from /api/health', /JSON\.parse\(s\)\.stratum/.test(start) && start.includes('"$stst" == "paused"'));
    const pausedArm = start.slice(start.indexOf('"$stst" == "paused"'), start.indexOf('n=0', start.indexOf('"$stst" == "paused"')));
    ok('a paused pool with nothing on the port is NOT a step-7 failure',
      pausedArm.includes('as intended') && !pausedArm.includes('_pmg_in_fail'));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
