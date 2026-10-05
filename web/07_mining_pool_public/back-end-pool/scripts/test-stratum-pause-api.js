'use strict';

// Stratum pause — admin API + public surface regression tests (design §21.8–§21.10, Part 2).
//
// What this pins:
//   [1] request parsing: window times are zone-qualified ISO-8601 ONLY (a zone-less string is a
//       400 — Date.parse would read it as the server's local time), offsets are applied the right
//       way round, calendar-impossible dates are refused; duration_min accepts an integer or a
//       digit string and nothing else.
//   [2] guard tiers read from index.js: control is secureAdmin, EVERY mutation (resume included,
//       Q3) is freshAdmin; the pairing route surfaces `deferred`; health + stats carry `stratum`.
//   [3] the REAL route handlers (cut out of index.js, as test-payout-guard.js does) against a real
//       StratumPause + DB and a stub stratum server: validation rejects (past / over-cap /
//       malformed) change nothing and write no audit row; every state change writes one, with
//       the admin's id and the reason/until; a 409 carries the current state.
//   [4] maintenance coupling, both directions: operator overlay ON before a pause stays ON (and
//       theirs) after resume; OFF before stays OFF after; maintenance_mode is never written. The
//       synthetic banner: while paused, and from 24 h (not 25 h) before a window. The reason is
//       never in a public payload.
//
// In-process only: :memory: DB, no sockets, nothing left running.
// Run: node scripts/test-stratum-pause-api.js

const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const StratumPause = require(path.join(APP, 'lib/stratum-pause.js'));
const { StratumPauseError, parseZonedIso, parseDurationMin } = StratumPause;
const PoolSettings = require(path.join(APP, 'lib/pool-settings.js'));
const { stratumPauseBanners } = PoolSettings;
const { initDb, getDb, createSchema, closeDb } = require(path.join(APP, 'lib/db.js'));

const realLog = console.log;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; realLog(`  PASS  ${name}`); }
  else { fail++; realLog(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const quiet = async (fn) => {
  const l = console.log, w = console.warn, e = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = l; console.warn = w; console.error = e; }
};
const status400 = (fn) => {
  try { fn(); return false; } catch (e) { return e instanceof StratumPauseError && e.status === 400; }
};
const nowS = () => Math.floor(Date.now() / 1000);
const isoAt = (s) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// A stratum server with the mechanism's shape and none of its sockets.
function stubServer() {
  return {
    acceptState: 'accepting', inflight: new Set(), sockets: new Set(), alertMonitor: null,
    listenerView() {
      return this.acceptState === 'paused' ? [] : [
        { port: 3333, host: '0.0.0.0', region: 'hub', listening: true },
        { port: 3391, host: '10.66.0.1', region: 'eu', listening: true },
      ];
    },
    async pause() {
      this.acceptState = 'paused';
      return { settled: true, settle_ms: 1, inflight_left: 0, blocks_in_flight: 0, sockets_closed: 2,
        listeners_closed: [{ port: 3333, host: '0.0.0.0', region: 'hub' }, { port: 3391, host: '10.66.0.1', region: 'eu' }] };
    },
    async resume() {
      const rebind = this.acceptState === 'accepting';
      this.acceptState = 'accepting';
      return { rebind, results: [{ port: 3333, host: '0.0.0.0', region: 'hub', bound: true, already: rebind, error: null }] };
    },
    waitSettled() { return Promise.resolve(); },
  };
}

(async () => {
  // ── [1] request parsing ────────────────────────────────────────────────────────────────────
  console.log('\n[1] window time + duration parsing (§21.10)');
  ok('Z is UTC', parseZonedIso('2026-10-05T14:00Z', 'start') === Date.UTC(2026, 9, 5, 14, 0) / 1000);
  ok('seconds + fractional seconds accepted (a browser toISOString)',
    parseZonedIso('2026-10-05T14:00:30.000Z', 's') === Date.UTC(2026, 9, 5, 14, 0, 30) / 1000);
  ok('+02:00 is two hours AHEAD of UTC — 16:00+02:00 = 14:00Z',
    parseZonedIso('2026-10-05T16:00+02:00', 's') === Date.UTC(2026, 9, 5, 14, 0) / 1000);
  ok('-05:30 → 19:30Z', parseZonedIso('2026-10-05T14:00-05:30', 's') === Date.UTC(2026, 9, 5, 19, 30) / 1000);
  ok('a zone-less time is a 400 (Date.parse would read it as server-local)', status400(() => parseZonedIso('2026-10-05T14:00', 's')));
  ok('…and so is a zone-less time with seconds', status400(() => parseZonedIso('2026-10-05T14:00:00', 's')));
  ok('a bare date is a 400', status400(() => parseZonedIso('2026-10-05', 's')));
  ok('a space instead of T is a 400', status400(() => parseZonedIso('2026-10-05 14:00Z', 's')));
  ok('2026-02-30 is a 400 (V8 would roll it into March)', status400(() => parseZonedIso('2026-02-30T10:00Z', 's')));
  ok('24:00 is a 400', status400(() => parseZonedIso('2026-10-05T24:00Z', 's')));
  ok('an impossible offset (+15:00) is a 400', status400(() => parseZonedIso('2026-10-05T14:00+15:00', 's')));
  ok('a number (unix seconds) is a 400 — ISO only', status400(() => parseZonedIso(1790000000, 's')));
  ok('missing is a 400', status400(() => parseZonedIso(undefined, 's')));
  ok('duration_min 60 and "60" both parse', parseDurationMin(60) === 60 && parseDurationMin('60') === 60);
  ok('duration_min [60] is a 400 (a bare Number() would pass it)', status400(() => parseDurationMin([60])));
  ok('duration_min 60.5 / true / "" / "1e2" are 400s',
    status400(() => parseDurationMin(60.5)) && status400(() => parseDurationMin(true)) &&
    status400(() => parseDurationMin('')) && status400(() => parseDurationMin('1e2')));

  // ── [2] guard tiers + wiring, read from index.js ───────────────────────────────────────────
  console.log('\n[2] route guards + public wiring (index.js)');
  const src = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');
  const routeGuard = (method, route) => {
    const re = new RegExp("app\\." + method + "\\('" + route.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') + "',\\s*([A-Za-z]+),");
    const m = src.match(re);
    return m ? m[1] : null;
  };
  ok('GET /api/admin/stratum/control is secureAdmin', routeGuard('get', '/api/admin/stratum/control') === 'secureAdmin');
  for (const [m, r] of [['post', '/api/admin/stratum/pause'], ['post', '/api/admin/stratum/extend'],
    ['post', '/api/admin/stratum/resume'], ['post', '/api/admin/stratum/window'], ['delete', '/api/admin/stratum/window']]) {
    ok(`${m.toUpperCase()} ${r} is freshAdmin (step-up — resume too, Q3)`, routeGuard(m, r) === 'freshAdmin', String(routeGuard(m, r)));
  }
  ok('the pairing route surfaces a deferred bind (§21.4)',
    /if \(r && r\.deferred\) bindDeferred = true;/.test(src) && /stratum_bind_deferred: bindDeferred/.test(src));
  ok('/api/health reports stratum accepting|paused', /stratum: stratumPause && stratumPause\.isPaused\(\) \? 'paused' : 'accepting'/.test(src));
  ok('/api/pool/stats + branding read publicStatus() (never status(), which carries the reason)',
    (src.match(/stratumPause\.publicStatus\(\)/g) || []).length >= 2 &&
    !/buildPublicConfig\([^)]*stratumPause\.status\(\)/.test(src));
  ok('no settings route touches the pause (§21.1): the only stratum_control writer is lib/stratum-pause.js',
    !/stratum_control/.test(src.replace(/\/\/[^\n]*/g, '')));

  // ── [3] the real handlers ──────────────────────────────────────────────────────────────────
  console.log('\n[3] admin handlers against a real StratumPause + DB');
  initDb(':memory:');
  createSchema();
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (7, 'route-admin', 'x', 1)").run();

  const routeSrc = (verb, p) => {
    const start = src.indexOf(`app.${verb}('${p}'`);
    if (start < 0) return '';
    const next = src.slice(start + 10).search(/\n\s{0,4}app\.(get|post|put|delete|patch)\(/);
    const whole = next < 0 ? src.slice(start) : src.slice(start, start + 10 + next);
    const end = whole.indexOf('\n  });');
    return end < 0 ? whole : whole.slice(0, end + 6);
  };
  const load = (verb, p, deps) => {
    const s = routeSrc(verb, p);
    if (!s) return null;
    let handler = null;
    const app = { [verb]: (_p, ...fns) => { handler = fns[fns.length - 1]; } };
    // eslint-disable-next-line no-new-func
    new Function('__d', `with (__d) {\n${s}\n}`)({ app, ...deps });
    return handler;
  };
  const call = async (h, req = {}) => {
    const res = {
      statusCode: 200, body: undefined,
      status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
    };
    if (!h) { res.statusCode = -1; return res; }
    await quiet(() => h({ ip: '203.0.113.9', params: {}, query: {}, body: {}, user: { user_id: 7, username: 'route-admin' }, ...req }, res));
    return res;
  };

  const server = stubServer();
  const sp = new StratumPause({ db, stratumServer: server });
  const config = { stratum_port: 3333, region_ports: { eu: 3391, us: 3392 } };
  const deps = { stratumPause: sp, StratumPause, config, secureAdmin: null, freshAdmin: null };
  const H = {
    control: load('get', '/api/admin/stratum/control', deps),
    pause: load('post', '/api/admin/stratum/pause', deps),
    extend: load('post', '/api/admin/stratum/extend', deps),
    resume: load('post', '/api/admin/stratum/resume', deps),
    window: load('post', '/api/admin/stratum/window', deps),
    cancel: load('delete', '/api/admin/stratum/window', deps),
  };
  ok('all six handlers were found in index.js', Object.values(H).every((h) => typeof h === 'function'));
  const audits = (action) => db.prepare("SELECT * FROM admin_audit_log WHERE target_type = 'stratum' AND action = ? ORDER BY id").all(action);
  const auditCount = () => db.prepare("SELECT COUNT(*) AS n FROM admin_audit_log WHERE target_type = 'stratum'").get().n;
  const row = () => db.prepare('SELECT * FROM stratum_control WHERE id = 1').get();

  let n0 = auditCount();
  let r = await call(H.pause, { body: { reason: 'restore test', duration_min: 45 } });
  ok('pause with an off-list duration (45) → 400', r.statusCode === 400, JSON.stringify(r.body));
  r = await call(H.pause, { body: { reason: 'restore test', duration_min: 600 } });
  ok('pause over the 2 h cap (600) → 400', r.statusCode === 400);
  r = await call(H.pause, { body: { reason: 'x', duration_min: 30 } });
  ok('pause with a too-short reason → 400', r.statusCode === 400);
  r = await call(H.pause, { body: { duration_min: 30 } });
  ok('pause with no reason → 400', r.statusCode === 400);
  r = await call(H.pause, { body: { reason: 'restore test', duration_min: [30] } });
  ok('pause with duration_min [30] → 400', r.statusCode === 400);
  ok('…no rejected request paused anything or wrote an audit row',
    !sp.isPaused() && server.acceptState === 'accepting' && auditCount() === n0 && !row());

  const t0 = nowS();
  r = await call(H.pause, { body: { reason: 'restore test', duration_min: '30' } });
  ok('a valid pause → 200, settled, persisted', r.statusCode === 200 && r.body.success && r.body.settled === true && r.body.persisted === true,
    JSON.stringify(r.body));
  let a = audits('stratum_pause').pop();
  let d = a ? JSON.parse(a.details) : {};
  ok('…audit row stratum_pause with the admin\'s id, ip, reason and until',
    !!a && a.admin_id === 7 && a.ip === '203.0.113.9' && d.reason === 'restore test' && d.until >= t0 + 1800 && d.by === 'admin:route-admin',
    a && a.details);
  ok('…row persisted: paused, paused_by admin:route-admin, until = now + 30 min',
    row().paused === 1 && row().paused_by === 'admin:route-admin' && Math.abs(row().until - (t0 + 1800)) <= 2);

  n0 = auditCount();
  r = await call(H.pause, { body: { reason: 'second admin', duration_min: 15 } });
  ok('a second pause → 409 with the CURRENT state (§21.11)', r.statusCode === 409 && r.body.state && r.body.state.paused === true,
    JSON.stringify(r.body));
  ok('…and writes no audit row', auditCount() === n0);

  r = await call(H.control);
  ok('GET control → paused, reason visible to the admin, limits published',
    r.statusCode === 200 && r.body.paused === true && r.body.reason === 'restore test' &&
    Array.isArray(r.body.limits.duration_min) && r.body.limits.window_max_s === 6 * 3600, JSON.stringify(r.body));
  ok('…every recorded region is deferred while paused (nothing held)',
    r.body.regions.length === 2 && r.body.regions.every((x) => x.deferred === true && x.listening === false), JSON.stringify(r.body.regions));

  r = await call(H.extend, { body: { duration_min: 180 } });
  ok('extend past the 2 h cap (180) → 400', r.statusCode === 400);
  const t1 = nowS();
  r = await call(H.extend, { body: { duration_min: 120 } });
  ok('extend 120 → 200, until = now + 2 h', r.statusCode === 200 && Math.abs(r.body.state.until - (t1 + 7200)) <= 2, JSON.stringify(r.body));
  a = audits('stratum_extend').pop();
  ok('…audit row stratum_extend (admin 7, from → until)', !!a && a.admin_id === 7 && JSON.parse(a.details).until === r.body.state.until);

  r = await call(H.resume);
  ok('resume → 200, accepting, row cleared', r.statusCode === 200 && !sp.isPaused() && server.acceptState === 'accepting' &&
    row().paused === 0 && row().until === null, JSON.stringify(r.body));
  a = audits('stratum_resume').pop();
  ok('…audit row stratum_resume with the prior pause and per-port results',
    !!a && a.admin_id === 7 && JSON.parse(a.details).prior.reason === 'restore test' && JSON.parse(a.details).results.length === 1);

  r = await call(H.extend, { body: { duration_min: 30 } });
  ok('extend while accepting → 409', r.statusCode === 409);
  r = await call(H.resume);
  ok('resume while accepting → 200 re-bind (the retry button), audited as stratum_rebind',
    r.statusCode === 200 && r.body.rebind === true && audits('stratum_rebind').length === 1);

  // Windows.
  const now = nowS();
  n0 = auditCount();
  const W = (startS, endS, reason = 'node upgrade') => ({ body: { start: isoAt(startS), end: isoAt(endS), reason } });
  r = await call(H.window, { body: { start: '2026-10-05T14:00', end: '2026-10-05T15:00', reason: 'node upgrade' } });
  ok('window with zone-less times → 400', r.statusCode === 400 && /zone/i.test(r.body.error), JSON.stringify(r.body));
  r = await call(H.window, W(now - 3600, now + 3600));
  ok('window starting in the past → 400', r.statusCode === 400);
  r = await call(H.window, W(now + 5 * 60, now + 3600));
  ok('window inside the 15 min lead → 400', r.statusCode === 400);
  r = await call(H.window, W(now + 3600, now + 3600 + 7 * 3600));
  ok('window longer than 6 h → 400', r.statusCode === 400);
  r = await call(H.window, W(now + 3600, now + 3600 + 60));
  ok('window shorter than 5 min → 400', r.statusCode === 400);
  r = await call(H.window, W(now + 3600, now + 1800));
  ok('window ending before it starts → 400', r.statusCode === 400);
  r = await call(H.window, W(now + 31 * 86400, now + 31 * 86400 + 3600));
  ok('window more than 30 days ahead → 400', r.statusCode === 400);
  r = await call(H.window, W(now + 3600, now + 7200, ''));
  ok('window with no reason → 400', r.statusCode === 400);
  ok('…no rejected window was stored or audited', auditCount() === n0 && (row() || {}).planned_start == null);

  // A window typed with an offset lands at the right UTC instant.
  const startS = Math.ceil((now + 3 * 3600) / 60) * 60;
  const pad = (x) => String(x).padStart(2, '0');
  const dPlus2 = new Date((startS + 7200) * 1000);
  const plus2 = `${dPlus2.getUTCFullYear()}-${pad(dPlus2.getUTCMonth() + 1)}-${pad(dPlus2.getUTCDate())}T${pad(dPlus2.getUTCHours())}:${pad(dPlus2.getUTCMinutes())}+02:00`;
  r = await call(H.window, { body: { start: plus2, end: isoAt(startS + 3600), reason: 'node upgrade' } });
  ok('a +02:00 start is stored as the matching UTC second', r.statusCode === 200 && row().planned_start === startS,
    `${plus2} → ${row() && row().planned_start} vs ${startS}`);
  a = audits('stratum_window_schedule').pop();
  ok('…audit row stratum_window_schedule (admin 7, start/end/reason)',
    !!a && a.admin_id === 7 && JSON.parse(a.details).start === startS && JSON.parse(a.details).reason === 'node upgrade');

  r = await call(H.cancel);
  ok('cancel the window → 200, cleared, audited', r.statusCode === 200 && row().planned_start === null && audits('stratum_window_cancel').length === 1);
  r = await call(H.cancel);
  ok('cancel with nothing scheduled → 409', r.statusCode === 409);

  // ── [4] maintenance coupling + public payload ──────────────────────────────────────────────
  console.log('\n[4] maintenance coupling (computed, never written) + public payload');
  const ps = new PoolSettings(db);
  const mm = () => db.prepare("SELECT value FROM pool_config WHERE section = 'notices' AND key = 'maintenance_mode'").get();
  const pub = () => ps.buildPublicConfig(() => '', sp.publicStatus());

  // OFF before → ON (stratum) while paused → OFF after.
  let c = pub();
  ok('accepting + operator OFF → overlay off, stratum.accepting', c.maintenance.enabled === false && c.stratum.accepting === true);
  await call(H.pause, { body: { reason: 'SECRET-internal-detail', duration_min: 60 } });
  c = pub();
  ok('paused + operator OFF → overlay ON, source stratum, default stratum text, until = resumes_at',
    c.maintenance.enabled === true && c.maintenance.source === 'stratum' && c.maintenance.title === 'Mining paused' &&
    c.maintenance.until === c.stratum.resumes_at && /Z$/.test(c.maintenance.until), JSON.stringify(c.maintenance));
  ok('…announcements lead with the non-dismissible stratum banner',
    c.announcements[0] && c.announcements[0].id === 'stratum-pause' && c.announcements[0].dismissible === false &&
    c.announcements[0].type === 'maintenance' && / UTC/.test(c.announcements[0].message), JSON.stringify(c.announcements[0]));
  ok('…the reason never reaches the public payload', !JSON.stringify(c).includes('SECRET-internal-detail') &&
    !JSON.stringify(sp.publicStatus()).includes('SECRET'));
  ok('…and the pause did not write maintenance_mode', !mm());
  await call(H.resume);
  c = pub();
  ok('resume → overlay OFF again (OFF before stays OFF after), no stratum banner',
    c.maintenance.enabled === false && c.maintenance.source === null && !c.announcements.some((b) => /^stratum-/.test(b.id)));
  ok('…maintenance_mode still never written', !mm());

  // ON before → ON (operator's own) while paused → ON after.
  ps.updateSection('notices', { maintenance_mode: 'true', maintenance_title: 'Operator says hi' }, 7);
  await call(H.pause, { body: { reason: 'restore test', duration_min: 15 } });
  c = pub();
  ok('operator ON + paused → the OPERATOR\'s overlay wins, unchanged', c.maintenance.enabled === true &&
    c.maintenance.source === 'operator' && c.maintenance.title === 'Operator says hi' && c.maintenance.until === null);
  ok('…the stratum banner still shows (exempt pages)', c.announcements[0] && c.announcements[0].id === 'stratum-pause');
  await call(H.resume);
  c = pub();
  ok('resume → the operator\'s overlay is STILL on (ON before stays ON after)',
    c.maintenance.enabled === true && c.maintenance.source === 'operator' && (mm() || {}).value === 'true');
  ps.updateSection('notices', { maintenance_mode: 'false' }, 7);

  // Editable text (Q4), with a fallback for an empty save, bounded.
  ps.updateSection('notices', { stratum_pause_title: 'Back soon', stratum_pause_message: 'Upgrading the node.' }, 7);
  await call(H.pause, { body: { reason: 'restore test', duration_min: 15 } });
  c = pub();
  ok('the editable stratum_pause_title / _message are used', c.maintenance.title === 'Back soon' && c.maintenance.message === 'Upgrading the node.');
  ps.updateSection('notices', { stratum_pause_title: '   ' }, 7);
  ok('an EMPTY saved title falls back to the default (never a bare icon)', pub().maintenance.title === 'Mining paused');
  await call(H.resume);
  let threw = false;
  try { ps.updateSection('notices', { stratum_pause_title: 'x'.repeat(121) }, 7); } catch (e) { threw = true; }
  ok('a 121-char stratum_pause_title is refused', threw);
  threw = false;
  try { ps.updateSection('notices', { stratum_pause_message: 'x'.repeat(1001) }, 7); } catch (e) { threw = true; }
  ok('a 1001-char stratum_pause_message is refused', threw);
  ok('the notices text keys cannot flip the pause (no settings key does)', !sp.isPaused() && row().paused === 0);

  // Q5: the 24 h advance banner.
  const nowMs = Date.parse('2026-10-05T10:00:00Z');
  const win = (startIso, endIso) => ({ accepting: true, paused_since: null, resumes_at: null, planned: { start: startIso, end: endIso } });
  let b = stratumPauseBanners(win('2026-10-06T09:00:00Z', '2026-10-06T11:00:00Z'), nowMs);
  ok('a window 23 h ahead → banner "05/06 Oct 09:00 UTC–11:00 UTC", non-dismissible',
    b.length === 1 && b[0].dismissible === false && b[0].message.includes('06 Oct 09:00 UTC–11:00 UTC'), JSON.stringify(b));
  b = stratumPauseBanners(win('2026-10-06T11:00:00Z', '2026-10-06T12:00:00Z'), nowMs);
  ok('a window 25 h ahead → no banner yet', b.length === 0);
  b = stratumPauseBanners(win('2026-10-05T23:00:00Z', '2026-10-06T01:00:00Z'), nowMs);
  ok('a window crossing midnight names the end date too', b.length === 1 && b[0].message.includes('05 Oct 23:00 UTC–06 Oct 01:00 UTC'), b[0] && b[0].message);
  ok('accepting with no window → no banner', stratumPauseBanners({ accepting: true, planned: null }, nowMs).length === 0);
  ok('null status (no pause module) → no banner, and buildPublicConfig reads it as accepting',
    stratumPauseBanners(null).length === 0 && ps.buildPublicConfig().stratum.accepting === true);

  sp.stop();
  try { closeDb(); } catch (_) {}
  realLog(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  realLog('FATAL', e && e.stack || e);
  process.exit(1);
});
