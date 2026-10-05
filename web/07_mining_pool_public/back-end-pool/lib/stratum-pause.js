'use strict';

// Stratum pause — POLICY (design §21). An operator switch that makes the pool stop accepting
// miners on every stratum listener (public + every region), with a mandatory auto-resume, an
// optional one-off planned window, and state that survives a restart.
//
// Split of responsibilities:
//   · lib/stratum-server.js owns the MECHANISM: pause() / resume() / acceptState / inflight.
//   · this module owns everything else: the single-row `stratum_control` table (lib/db.js), the
//     caps (§21.7), the transition guard (§21.2.1), the one 15 s tick (§21.6), the boot re-derive
//     (§21.5), the audit rows (§21.10) and the stratum_bind_failed alert (§21.11).
//
// ⚠ The state is deliberately NOT a pool_config key (§21.1): the section Save, the section
// restore and resetAll all write that table wholesale, and none of them may flip intake.
//
// Times are integer unix seconds everywhere in here — UTC by construction. Parsing an operator's
// typed time (zone-qualified ISO only) is the HTTP layer's job; this module takes integers.

// §21.7 caps — server-side; the UI is not the control.
const MANUAL_DURATIONS_MIN = Object.freeze([15, 30, 60, 120]);   // until ≤ now + 2 h
const WINDOW_MIN_S     = 5 * 60;
const WINDOW_MAX_S     = 6 * 3600;
const WINDOW_LEAD_S    = 15 * 60;
const WINDOW_HORIZON_S = 30 * 86400;
const REASON_MIN = 3;
const REASON_MAX = 300;

// §21.5: a row read that THROWS at boot fails CLOSED for this long. A DB that cannot read a
// one-row table cannot credit shares either; the cap stops it stranding the pool. Also the cap
// given to a paused row that somehow has no `until` (the invariant is "every pause auto-resumes").
const FAIL_CLOSED_S = 2 * 3600;

// §21.6: one tick drives every deadline. Never a setTimeout per deadline — Node clamps a delay
// over 2^31-1 ms (24.8 days) to 1 ms, and a window may be up to 30 days ahead.
const TICK_MS = 15000;

const COLUMNS = ['paused', 'source', 'reason', 'paused_by', 'since', 'settled_at', 'until',
  'planned_start', 'planned_end', 'planned_reason', 'planned_by', 'last_result'];

// Carries the HTTP status the route should answer with (400 validation, 409 state conflict).
class StratumPauseError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'StratumPauseError';
    this.status = status;
  }
}

function emptyRow() {
  const r = {};
  for (const c of COLUMNS) r[c] = null;
  r.paused = 0;
  return r;
}

function cleanReason(reason) {
  const s = typeof reason === 'string' ? reason.trim() : '';
  if (s.length < REASON_MIN || s.length > REASON_MAX) {
    throw new StratumPauseError(400, `A reason of ${REASON_MIN}–${REASON_MAX} characters is required`);
  }
  return s;
}

function cleanDuration(durationMin) {
  const d = Number(durationMin);
  if (!MANUAL_DURATIONS_MIN.includes(d)) {
    throw new StratumPauseError(400, `duration_min must be one of ${MANUAL_DURATIONS_MIN.join(', ')}`);
  }
  return d;
}

class StratumPause {
  // opts.now()     → unix seconds (injected by the tests; default = the wall clock)
  // opts.settleMs  → the pause settle bound (default: the stratum server's PAUSE_SETTLE_MS, 30 s)
  // opts.tickMs    → the evaluate() interval (default 15 s)
  // opts.alertMonitor → optional; otherwise the one AlertMonitor attaches to the stratum server
  constructor({ db, stratumServer, now, settleMs, tickMs, alertMonitor } = {}) {
    if (!db || !stratumServer) throw new Error('StratumPause needs { db, stratumServer }');
    this.db = db;
    this.server = stratumServer;
    this._now = typeof now === 'function' ? now : () => Math.floor(Date.now() / 1000);
    this.settleMs = settleMs;
    this.tickMs = tickMs || TICK_MS;
    this.alertMonitor = alertMonitor || null;
    this.row = emptyRow();
    // Result of the LAST write attempt. false = the in-memory state is ahead of the DB, so a
    // restart would re-derive something else (§21.2.2 — "will NOT survive a restart").
    this.persisted = true;
    this._transition = null;
    this._timer = null;
    this._pendingAlerts = [];
    // Set by index.js (setupRoutes) to invalidateBranding: every transition — timer-driven ones
    // included — must drop the 60 s branding memo so the overlay and banner follow (§21.8).
    this.onChange = null;
  }

  // ─── boot (§21.5) ─────────────────────────────────────────────────────────────────────────

  // Read the row. MUST run before stratumServer.start(), whose `paused` argument is this return
  // value. A missing row = accepting (as payout_control). A read that THROWS fails closed.
  load() {
    try {
      const r = this.db.prepare('SELECT * FROM stratum_control WHERE id = 1').get();
      this.row = emptyRow();
      if (r) for (const c of COLUMNS) this.row[c] = r[c] === undefined ? null : r[c];
      this.row.paused = this.row.paused ? 1 : 0;
      this.persisted = true;
      let repaired = false;
      if (this.row.paused && this.row.until == null) {
        this.row.until = this._now() + FAIL_CLOSED_S;
        this._log('warn', `paused row had no auto-resume time — capped at ${new Date(this.row.until * 1000).toISOString()}`);
        repaired = true;
      }
      // Paused but never settled: the process that paused died mid-settle (§21.11). Whatever was
      // in flight died with it and intake has been shut since, so nothing more can land. Stamp it
      // now, or the page would say "not settled yet — wait" for the rest of the pause.
      if (this.row.paused && this.row.settled_at == null) {
        this.row.settled_at = this._now();
        repaired = true;
      }
      if (repaired) this._persist();
    } catch (err) {
      const now = this._now();
      this.row = Object.assign(emptyRow(), {
        paused: 1, source: 'manual', paused_by: 'system:db_error', since: now, until: now + FAIL_CLOSED_S,
        reason: `stratum pause state unreadable at boot: ${String(err.message).slice(0, 200)}`,
      });
      this.persisted = false;
      this._log('error', `[CRITICAL] cannot read stratum_control (${err.message}) — starting PAUSED (fail closed) ` +
        `until ${new Date(this.row.until * 1000).toISOString()}. A DB that cannot read this row cannot credit shares.`);
      this._alert('stratum_state_unreadable', {
        level: 'critical',
        message: `The stratum pause state could not be read at boot (${err.message}). Stratum started PAUSED ` +
          `and will auto-resume at ${new Date(this.row.until * 1000).toISOString()} unless the database is fixed first.`,
        data: { error: err.message, until: this.row.until },
      });
    }
    if (this.row.paused) {
      this._log('log', `boot: PAUSED (source=${this.row.source || '?'}) until ${new Date(this.row.until * 1000).toISOString()}`);
    }
    return this.isPaused();
  }

  // Arm the tick and run the boot evaluate (expired → resume, window started while down →
  // convert, window wholly missed → drop). Call after the stratum server is started and wired.
  start() {
    if (!this._timer) {
      this._timer = setInterval(() => {
        this.evaluate().catch((err) => this._log('error', `tick failed: ${err.message}`));
      }, this.tickMs);
    }
    return this.evaluate({ boot: true });
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  isPaused() {
    return !!this.row.paused;
  }

  // Admin view (reason included — this is NEVER a public payload; §21.9's public block is built
  // from it by the HTTP layer with the reason left out).
  status() {
    const r = this.row;
    let lastResult = null;
    if (r.last_result) { try { lastResult = JSON.parse(r.last_result); } catch (e) { lastResult = null; } }
    return {
      accept_state: this.server.acceptState,
      paused: !!r.paused,
      source: r.source,
      reason: r.reason,
      paused_by: r.paused_by,
      since: r.since,
      settled_at: r.settled_at,
      until: r.until,
      planned: r.planned_start != null
        ? { start: r.planned_start, end: r.planned_end, reason: r.planned_reason, by: r.planned_by }
        : null,
      last_result: lastResult,
      persisted: this.persisted,
      transition: !!this._transition,
      inflight: this.server.inflight.size,
      connections: this.server.sockets.size,
      listeners: this.server.listenerView(),
    };
  }

  // §21.9 public block, for /api/public/branding and /api/pool/stats. Built from the row, with
  // reason, paused_by, the listeners and every admin field left OUT — free text can carry
  // internal detail. Times are ISO-8601 with `Z`.
  publicStatus() {
    const r = this.row;
    const paused = !!r.paused;
    return {
      accepting: !paused,
      paused_since: paused ? isoZ(r.since) : null,
      resumes_at: paused ? isoZ(r.until) : null,
      planned: r.planned_start != null ? { start: isoZ(r.planned_start), end: isoZ(r.planned_end) } : null,
    };
  }

  // ─── operator actions (the HTTP layer adds step-up + request parsing) ──────────────────────

  // Manual pause (§21.2). `by` is 'admin:<username>'.
  async pause({ reason, durationMin, by, adminId = null, ip = null } = {}) {
    const why = cleanReason(reason);
    const d = cleanDuration(durationMin);
    return this._exclusive(async () => {
      if (this.row.paused || this.server.acceptState !== 'accepting') {
        throw new StratumPauseError(409, 'Stratum is already paused — use extend to change the resume time');
      }
      return this._doPause({ source: 'manual', reason: why, by, until: this._now() + d * 60,
        action: 'stratum_pause', adminId, ip });
    });
  }

  // New `until` in (now, now + 2 h] — each extension is its own step-up + audit row (§21.7).
  async extend({ durationMin, by, adminId = null, ip = null } = {}) {
    const d = cleanDuration(durationMin);
    return this._exclusive(async () => {
      if (!this.row.paused) throw new StratumPauseError(409, 'Stratum is not paused');
      const from = this.row.until;
      this.row.until = this._now() + d * 60;
      const persisted = this._persist();
      this._changed();
      this._audit('stratum_extend', adminId, ip, { by, from, until: this.row.until, persisted });
      return { persisted, state: this.status() };
    });
  }

  // While paused: §21.3. While accepting: re-bind whatever is missing (the retry button).
  async resume({ by, adminId = null, ip = null } = {}) {
    return this._exclusive(async () => {
      const wasPaused = !!this.row.paused || this.server.acceptState === 'paused';
      return this._doResume({ action: wasPaused ? 'stratum_resume' : 'stratum_rebind', by, adminId, ip });
    });
  }

  // One-off planned window (§21.7). start/end are unix seconds. Replaces any scheduled window.
  async scheduleWindow({ start, end, reason, by, adminId = null, ip = null } = {}) {
    const why = cleanReason(reason);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new StratumPauseError(400, 'start and end must be unix seconds');
    }
    const now = this._now();
    if (start < now + WINDOW_LEAD_S) {
      throw new StratumPauseError(400, `A planned window must start at least ${WINDOW_LEAD_S / 60} minutes ahead — pause manually for anything sooner`);
    }
    if (start > now + WINDOW_HORIZON_S) {
      throw new StratumPauseError(400, `A planned window must start within ${WINDOW_HORIZON_S / 86400} days`);
    }
    const len = end - start;
    if (len < WINDOW_MIN_S || len > WINDOW_MAX_S) {
      throw new StratumPauseError(400, `A planned window must last ${WINDOW_MIN_S / 60} minutes to ${WINDOW_MAX_S / 3600} hours`);
    }
    return this._exclusive(async () => {
      const replaced = this.row.planned_start != null
        ? { start: this.row.planned_start, end: this.row.planned_end, reason: this.row.planned_reason, by: this.row.planned_by }
        : null;
      Object.assign(this.row, { planned_start: start, planned_end: end, planned_reason: why, planned_by: by || null });
      const persisted = this._persist();
      this._changed();
      this._audit('stratum_window_schedule', adminId, ip, { by, start, end, reason: why, replaced, persisted });
      return { replaced, persisted, state: this.status() };
    });
  }

  // Cancel the SCHEDULED window. A window that has started is an ordinary pause by then (its
  // planned_* columns were cleared when it converted) — that is ended with resume.
  async cancelWindow({ by, adminId = null, ip = null } = {}) {
    return this._exclusive(async () => {
      if (this.row.planned_start == null) {
        throw new StratumPauseError(409, this.row.paused && this.row.source === 'planned'
          ? 'The planned window is already running — use resume to end it'
          : 'No planned window is scheduled');
      }
      const window = this._takeWindow();
      const persisted = this._persist();
      this._changed();
      this._audit('stratum_window_cancel', adminId, ip, { by, window, persisted });
      return { persisted, state: this.status() };
    });
  }

  // ─── the tick (§21.6) — idempotent; also the boot re-derive ────────────────────────────────

  async evaluate({ boot = false } = {}) {
    if (this._transition) return { skipped: true, actions: [] };
    return this._exclusive(async () => {
      this._flushAlerts();
      const actions = [];
      const now = this._now();

      // 1. A window whose start has arrived. Handled BEFORE expiry, so a paused pool whose own
      //    `until` has passed but whose window is now running stays paused through the window
      //    instead of resuming and re-pausing.
      if (this.row.planned_start != null && now >= this.row.planned_start) {
        const window = this._takeWindow();
        if (now >= window.end) {
          // Started AND ended while nothing was evaluating (the process was down).
          this._persist();
          this._changed();
          this._audit('stratum_window_missed', null, null, { window, now });
          this._log('warn', `planned window ${iso(window.start)}–${iso(window.end)} was missed entirely (process down) — dropped`);
          actions.push('window_missed');
        } else if (this.row.paused) {
          // Merge (§21.7): a manual pause overlapping the window's start runs on to its end.
          const from = this.row.until;
          this.row.until = Math.max(this.row.until || 0, window.end);
          this.row.source = 'planned';
          const persisted = this._persist();
          this._changed();
          this._audit('stratum_window_start', null, null, { window, merged: true, from, until: this.row.until, persisted });
          actions.push('window_merged');
        } else {
          await this._doPause({ source: 'planned', reason: window.reason || 'planned window', by: 'system:planned',
            until: window.end, action: 'stratum_window_start', adminId: null, ip: null,
            extra: { window, late_s: now - window.start } });
          actions.push('window_start');
        }
      }

      // 2. Auto-resume at `until`.
      if (this.row.paused && this.row.until != null && now >= this.row.until) {
        await this._doResume({ action: boot ? 'stratum_resume_expired_at_boot' : 'stratum_auto_resume',
          by: 'system:timer', adminId: null, ip: null });
        actions.push('resume');
      }
      return { skipped: false, actions };
    });
  }

  // ─── internals ────────────────────────────────────────────────────────────────────────────

  // §21.2.1: at most one transition at a time. The check-and-set runs synchronously (before the
  // first await), so two calls in one tick cannot both pass it.
  async _exclusive(fn) {
    if (this._transition) {
      throw new StratumPauseError(409, 'A stratum pause/resume is already in progress — try again in a moment');
    }
    const p = (async () => fn())();
    this._transition = p;
    try {
      return await p;
    } finally {
      this._transition = null;
    }
  }

  async _doPause({ source, reason, by, until, action, adminId, ip, extra }) {
    const since = this._now();
    Object.assign(this.row, { paused: 1, source, reason, paused_by: by || null, since, settled_at: null, until });
    // Persist FIRST (§21.2.2): a crash at any later step then boots paused. A failed write does
    // NOT stop the pause — DB trouble is one of the reasons to pause.
    const persistedAtStart = this._persist();
    this._changed();

    const mech = await this.server.pause(this.settleMs != null ? { settleMs: this.settleMs } : {});
    if (mech.settled) {
      this.row.settled_at = this._now();
      this._persist();
    } else {
      // Nothing was abandoned; stamp settled_at when the last in-flight submit lands — unless
      // this pause has been resumed (or replaced) by then.
      this.server.waitSettled().then(() => {
        if (this.row.paused && this.row.since === since && this.row.settled_at == null) {
          this.row.settled_at = this._now();
          this._persist();
          this._changed();
          this._log('log', 'pause settled late — every in-flight submit has now been answered');
        }
      });
    }
    const persisted = persistedAtStart && this.persisted;
    this._audit(action, adminId, ip, Object.assign({
      by, source, reason, until,
      settled: mech.settled, settle_ms: mech.settle_ms, inflight_left: mech.inflight_left,
      blocks_in_flight: mech.blocks_in_flight, sockets_closed: mech.sockets_closed,
      listeners_closed: mech.listeners_closed.map((l) => `${l.region}:${l.port}`), persisted,
    }, extra || {}));
    if (!persisted) {
      this._log('error', '[CRITICAL] stratum PAUSED but the state was NOT persisted — a restart will reopen stratum');
    }
    return Object.assign({}, mech, { persisted, state: this.status() });
  }

  async _doResume({ action, by, adminId, ip }) {
    const prior = this.row.paused
      ? { source: this.row.source, reason: this.row.reason, since: this.row.since,
          settled_at: this.row.settled_at, until: this.row.until }
      : null;
    const { rebind, results } = await this.server.resume();
    const failed = results.filter((r) => !r.bound);

    this.row.last_result = JSON.stringify({ at: this._now(), action, results });
    if (prior) {
      Object.assign(this.row, { paused: 0, source: null, reason: null, paused_by: null,
        since: null, settled_at: null, until: null });
    }
    const persisted = this._persist();
    this._changed();
    this._audit(action, adminId, ip, {
      by, prior, persisted,
      results: results.map((r) => ({ port: r.port, region: r.region, bound: r.bound, already: !!r.already, error: r.error || null })),
    });
    if (prior && !persisted) {
      this._log('error', `[CRITICAL] stratum RESUMED but the state was NOT persisted — a restart will boot PAUSED until ${iso(prior.until)}`);
    }
    if (failed.length) {
      const list = failed.map((r) => `:${r.port} (${r.region}) — ${r.error}`).join('; ');
      this._log('error', `[CRITICAL] stratum ${rebind ? 're-bind' : 'resume'}: ${failed.length} listener(s) NOT listening: ${list}`);
      this._alert('stratum_bind_failed', {
        level: 'critical',
        message: `Stratum ${rebind ? 're-bind' : 'resume'} left ${failed.length} listener(s) down: ${list}. ` +
          'Miners on those ports cannot connect. Fix the cause, then press Re-bind in admin → Announcements → Stratum.',
        data: { failed: failed.map((r) => ({ port: r.port, region: r.region, error: r.error })) },
      });
    } else {
      this._alert('stratum_bind_failed', null, 'resolve');
    }
    return { rebind, results, failed: failed.length, persisted, state: this.status() };
  }

  _takeWindow() {
    const w = { start: this.row.planned_start, end: this.row.planned_end,
      reason: this.row.planned_reason, by: this.row.planned_by };
    Object.assign(this.row, { planned_start: null, planned_end: null, planned_reason: null, planned_by: null });
    return w;
  }

  _persist() {
    try {
      const vals = COLUMNS.map((c) => (this.row[c] === undefined ? null : this.row[c]));
      this.db.prepare(
        `INSERT INTO stratum_control (id, ${COLUMNS.join(', ')}, updated_at)
         VALUES (1, ${COLUMNS.map(() => '?').join(', ')}, unixepoch())
         ON CONFLICT(id) DO UPDATE SET ${COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')},
           updated_at = excluded.updated_at`
      ).run(...vals);
      this.persisted = true;
    } catch (err) {
      this.persisted = false;
      this._log('error', `[CRITICAL] could not write stratum_control: ${err.message}`);
    }
    return this.persisted;
  }

  _audit(action, adminId, ip, details) {
    try {
      this.db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                       VALUES (?, ?, 'stratum', 'stratum', ?, ?)`)
        .run(adminId == null ? null : adminId, action, JSON.stringify(details || {}), ip == null ? null : ip);
    } catch (err) {
      this._log('error', `audit write failed (${action}): ${err.message}`);
    }
  }

  _changed() {
    if (typeof this.onChange !== 'function') return;
    try { this.onChange(); } catch (err) { this._log('error', `onChange failed: ${err.message}`); }
  }

  // The AlertMonitor is built long after the stratum server (index.js), so a boot-time alert is
  // queued and flushed by the first tick that finds the monitor.
  _monitor() {
    return this.alertMonitor || this.server.alertMonitor || null;
  }

  _alert(type, details, kind = 'trigger') {
    const m = this._monitor();
    if (!m) { this._pendingAlerts.push({ type, details, kind }); return; }
    const fn = kind === 'resolve' ? m.resolveAlert : m.triggerAlert;
    if (typeof fn !== 'function') return;
    Promise.resolve(kind === 'resolve' ? fn.call(m, type) : fn.call(m, type, details))
      .catch((e) => this._log('error', `alert ${kind} ${type} failed: ${e.message}`));
  }

  _flushAlerts() {
    if (!this._pendingAlerts.length || !this._monitor()) return;
    for (const a of this._pendingAlerts.splice(0)) this._alert(a.type, a.details, a.kind);
  }

  _log(level, msg) {
    console[level](`[${new Date().toISOString()}] [stratum-pause] ${msg}`);
  }
}

function iso(s) {
  return s == null ? '?' : new Date(s * 1000).toISOString();
}

// Unix seconds → '2026-10-05T14:00:00Z' (no milliseconds — every value here is whole seconds).
function isoZ(s) {
  return s == null ? null : new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ─── HTTP request parsing (design §21.10) — used by the admin routes in index.js ─────────────

// An operator-typed window time. Zone-qualified ISO-8601 ONLY (`Z` or `±hh:mm`): a zone-less
// string is REFUSED, because Date.parse reads one as the SERVER's local time — a window typed as
// 14:00 would silently land at 14:00 in whatever zone the VPS is set to. Parsed by hand rather
// than by Date.parse so that a calendar-impossible date (2026-02-30, which V8 rolls into March)
// is a 400 too. Fractional seconds are accepted (a browser's toISOString() sends them) and
// dropped. Returns unix SECONDS.
const ISO_ZONED = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|([+-])(\d{2}):(\d{2}))$/;
function parseZonedIso(value, field) {
  const hint = 'e.g. 2026-10-05T14:00Z or 2026-10-05T16:00+02:00';
  if (typeof value !== 'string' || !value.trim()) {
    throw new StratumPauseError(400, `${field} is required: an ISO-8601 time with a zone (${hint})`);
  }
  const m = ISO_ZONED.exec(value.trim());
  if (!m) {
    throw new StratumPauseError(400, `${field} must be ISO-8601 WITH a zone — Z or ±hh:mm (${hint}). ` +
      'A time without one would be read as the server\'s local time.');
  }
  const [, y, mo, d, h, mi, s = '00', z, sign, oh, om] = m;
  const Y = +y, MO = +mo, D = +d, H = +h, MI = +mi, S = +s;
  const ms = Date.UTC(Y, MO - 1, D, H, MI, S);
  const c = new Date(ms);
  if (H > 23 || MI > 59 || S > 59 || c.getUTCFullYear() !== Y || c.getUTCMonth() !== MO - 1 || c.getUTCDate() !== D) {
    throw new StratumPauseError(400, `${field} is not a real date/time: ${value.trim()}`);
  }
  let offsetS = 0;
  if (z !== 'Z') {
    if (+oh > 14 || +om > 59) throw new StratumPauseError(400, `${field} has an impossible zone offset: ${z}`);
    offsetS = (sign === '-' ? -1 : 1) * (+oh * 3600 + +om * 60);
  }
  // Local wall time minus its offset = UTC (16:00+02:00 is 14:00Z).
  return Math.floor(ms / 1000) - offsetS;
}

// duration_min from a JSON body: an integer, or a string of digits (a <select> value). Anything
// else — a float, an array ([60] would pass a bare Number()), a boolean — is a 400 here, before
// pause()/extend() check it is one of MANUAL_DURATIONS_MIN.
function parseDurationMin(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,4}$/.test(value.trim())) return Number(value.trim());
  throw new StratumPauseError(400, `duration_min must be one of ${MANUAL_DURATIONS_MIN.join(', ')}`);
}

// Who acted, in the shape every operator action takes (paused_by / audit admin_id / ip).
function actorOf(req) {
  return { by: `admin:${req.user && req.user.username}`, adminId: req.user ? req.user.user_id : null, ip: req.ip || null };
}

// Map a thrown error to the HTTP answer. A StratumPauseError carries its status (400 / 409); a
// 409 also carries the CURRENT state, so a second admin acting on a stale page sees what is
// really true (§21.11). Anything else is a 500.
function sendError(res, err, pauseInst) {
  if (err instanceof StratumPauseError) {
    const body = { error: err.message };
    if (err.status === 409 && pauseInst) {
      try { body.state = pauseInst.status(); } catch (e) { /* the error still goes out */ }
    }
    return res.status(err.status).json(body);
  }
  return res.status(500).json({ error: err && err.message ? err.message : 'stratum control failed' });
}

// The caps, published to the admin page so its controls offer exactly what the server accepts.
const LIMITS = Object.freeze({
  duration_min: MANUAL_DURATIONS_MIN,
  window_min_s: WINDOW_MIN_S, window_max_s: WINDOW_MAX_S,
  window_lead_s: WINDOW_LEAD_S, window_horizon_s: WINDOW_HORIZON_S,
  reason_min: REASON_MIN, reason_max: REASON_MAX,
});

module.exports = StratumPause;
module.exports.parseZonedIso = parseZonedIso;
module.exports.parseDurationMin = parseDurationMin;
module.exports.actorOf = actorOf;
module.exports.sendError = sendError;
module.exports.LIMITS = LIMITS;
module.exports.StratumPauseError = StratumPauseError;
module.exports.MANUAL_DURATIONS_MIN = MANUAL_DURATIONS_MIN;
module.exports.WINDOW_MIN_S = WINDOW_MIN_S;
module.exports.WINDOW_MAX_S = WINDOW_MAX_S;
module.exports.WINDOW_LEAD_S = WINDOW_LEAD_S;
module.exports.WINDOW_HORIZON_S = WINDOW_HORIZON_S;
module.exports.FAIL_CLOSED_S = FAIL_CLOSED_S;
module.exports.TICK_MS = TICK_MS;
