'use strict';

// Node availability — the pool's own record of its node, beside the node box's recorder.
// Design: docs/generated/script07_design.md §20 (pool side) + script086_design.md §8 (recorder).
//
// Two observers, two sources, never merged (§20.4):
//   source 'pool'     — this module's own 30 s getStatus() probe. It answers "could the POOL get a
//                       status from its node just now?", so it also sees a drifted secret, a moved
//                       node dir or a pool-side fault. It knows nothing about planned stops.
//   source 'recorder' — lines ingested from the node box's read-only event recorder
//                       (/opt/grin/node-events/<net>/ledger.jsonl), which knows the process, the
//                       log and the planned-stop marker. Untrusted input: every line is validated.
//
// What this module must never do:
//   • share block-monitor's getStatus() call or its timing — that module sits on the money path
//     (rewards, orphan detection), and a recorder coupled to it is the HIGH R2 must look for;
//   • classify by error-message text — only by the tags lib/grin-node.js sets (`nodeReplied`,
//     `transport`), memory project_pool_node_error_classification;
//   • put a timestamp, an exact uptime, a class or an error string into a PUBLIC response. The
//     public surface is `upDaysPublic()` → an integer or null, quantised to the UTC day (§20.5).
//
// Cost: one localhost RPC per 30 s, a /proc scan only on a refused probe, a DB write only on a
// transition, a one-row heartbeat UPSERT per minute, and an async ledger read per minute.

const fs = require('fs');
const path = require('path');

const PROBE_MS = 30000;
const INGEST_MS = 60000;              // also the heartbeat cadence
const DOWN_STRIKES = 2;               // one failed probe is not an outage (same rule as the recorder)
const STATUS_FRESH_S = 120;           // recorder status.json older than this is stale (086 §8.8)
const PROBE_FRESH_MS = 2 * PROBE_MS + 15000;  // how old a probe result may be and still count as "now"
const UNOBSERVED_MIN_S = 120;         // pool heartbeat gap above this is recorded as unobserved
const GAP_RESET_S = 900;              // …and above this it also resets the pool's "reachable since"
const DETAIL_MAX = 300;
const LINE_MAX = 2048;                // schema says ≤ 1024; anything past 2 KB is not a ledger line
const CHUNK_BYTES = 1024 * 1024;      // read at most this much per read, …
const CHUNKS_PER_TICK = 4;            // …and this many reads per ingest tick
const STATUS_MAX_BYTES = 64 * 1024;
const GENESIS_TS = 1547510400;        // grin mainnet genesis (2019-01-15); an earlier ts is not real
const LOG_EVERY_MS = 3600000;         // malformed-line / unreadable logging: once per hour per file

const RANGES = { '7d': 7 * 86400, '30d': 30 * 86400, '90d': 90 * 86400, '1y': 365 * 86400 };

// Recorder vocabulary (086 design §8.8, v:1). Anything else is dropped (required fields) or nulled.
const REC_EVENTS = new Set(['recorder_start', 'boot', 'start', 'stop', 'down', 'up', 'reclass',
  'restart_by_watchdog', 'auth_fail', 'auth_ok', 'probe_error', 'gap', 'stale_marker', 'unregistered']);
const REC_STATES = new Set(['up', 'starting', 'stopped', 'down', 'auth_fail', 'unregistered', 'unknown']);
const REC_CLASSES = new Set(['crashed', 'killed', 'hung', 'wedged', 'failed_start', 'corrupted', 'unexplained_stop']);
const POOL_CLASSES = new Set(['timeout', 'starting', 'refused', 'auth', 'other', 'node_error', 'stratum_drop']);

// Row states in node_events. Only 'down' is counted in an uptime %.
//   down        a counted outage (both sources)
//   planned     recorder: a toolkit stop / host boot window — shown, never counted
//   unobserved  nobody was watching: a recorder `gap`, the span before a `recorder_start`, or the pool process not running
//   fault       the node answers but rejects our credential (auth) — its own fault, not downtime
//   degraded    pool: the node stratum link dropped while the API stayed up
//   restart     recorder: a restart inside an outage (watchdog or operator)
//   info        every other recorder line (up, reclass, auth_ok, probe_error, …), point rows
const ROW_STATES = ['down', 'planned', 'unobserved', 'fault', 'degraded', 'restart', 'info'];

const nowS = () => Math.floor(Date.now() / 1000);
const isInt = (v) => Number.isSafeInteger(v);

// ─── pure helpers (exported for scripts/test-node-availability.js) ──────────────────────────────

// One getStatus() result → a verdict. `displayState` is grinNode.downState(status), consulted only
// for a refused probe (it scans /proc for a starting node). Tags only, never the error message.
function classifyProbe(status, displayState) {
  if (status && status.ok === true) return { kind: 'ok' };
  if (status && status.nodeReplied === true) {
    // The node answered with an error (JSON-RPC envelope error such as -32601, or result.Err).
    return { kind: 'fail', origin: 'node_reply', cls: 'node_error' };
  }
  const t = status && status.transport;
  if (t === 'auth') return { kind: 'auth', origin: 'auth', cls: 'auth' };
  if (t === 'timeout') return { kind: 'fail', origin: 'transport', cls: 'timeout' };
  if (t === 'refused') {
    return { kind: 'fail', origin: 'transport', cls: displayState === 'starting' ? 'starting' : 'refused' };
  }
  return { kind: 'fail', origin: 'transport', cls: 'other' };
}

// The pool-side strike machine as one pure step. `prev` = { strikes, firstFailTs, downOpen,
// faultOpen }; returns { next, ops } where ops are applied in order by the caller.
//   ok    → close an open fault and an open outage; strikes reset.
//   auth  → the node answered, so an open outage closes; a fault opens (not downtime).
//   fail  → an open fault closes (the node no longer answers at all); with an outage open the
//           class is only noted; otherwise a strike, and the DOWN_STRIKES-th strike opens the
//           outage BACKDATED to the first failed probe.
function stepProbe(prev, verdict, now) {
  const p = Object.assign({ strikes: 0, firstFailTs: null, downOpen: false, faultOpen: false }, prev || {});
  const next = Object.assign({}, p);
  const ops = [];
  if (verdict.kind === 'ok' || verdict.kind === 'auth') {
    if (p.downOpen) { ops.push({ op: 'close_down', at: now }); next.downOpen = false; }
    next.strikes = 0; next.firstFailTs = null;
    if (verdict.kind === 'ok' && p.faultOpen) { ops.push({ op: 'close_fault', at: now }); next.faultOpen = false; }
    if (verdict.kind === 'auth' && !p.faultOpen) {
      ops.push({ op: 'open_fault', at: now, cls: 'auth', origin: 'auth' }); next.faultOpen = true;
    }
    return { next, ops };
  }
  // fail
  if (p.faultOpen) { ops.push({ op: 'close_fault', at: now }); next.faultOpen = false; }
  if (p.downOpen) { ops.push({ op: 'note_class', cls: verdict.cls }); return { next, ops }; }
  next.strikes = p.strikes + 1;
  if (next.strikes === 1 || !isInt(p.firstFailTs)) next.firstFailTs = now;
  if (next.strikes >= DOWN_STRIKES) {
    ops.push({ op: 'open_down', at: next.firstFailTs, cls: verdict.cls, origin: verdict.origin });
    next.downOpen = true; next.strikes = 0; next.firstFailTs = null;
  }
  return { next, ops };
}

// Coarse public uptime (§20.5): whole UTC days between up_since and TODAY's 00:00 UTC, so the
// value flips at midnight for every node and never reveals the hour of a restart.
function upDaysFrom(upSince, now) {
  if (!isInt(upSince) || !isInt(now) || upSince > now) return null;
  const midnight = Math.floor(now / 86400) * 86400;
  return Math.max(0, Math.floor((midnight - upSince) / 86400));
}

// Mask anything address-shaped before it goes into `detail`. Over-masks on purpose.
function maskIps(s) {
  return String(s)
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, 'x.x.x.x')
    .replace(/\b(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b/g, (m) => (/[a-fA-F]|::/.test(m) ? 'x:x::x' : m));
}

// Control characters and bidi overrides go; our own separators (· → ×) stay. Recorder text is
// already reduced to printable ASCII by parseLedgerLine before it gets here.
function clampDetail(s) {
  const t = maskIps(String(s).replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim());
  return t.length > DETAIL_MAX ? t.slice(0, DETAIL_MAX - 1) + '…' : t;
}

const optStr = (v, re, max) => (typeof v === 'string' && v.length <= max && re.test(v) ? v : null);
const optInt = (v, lo, hi) => (isInt(v) && v >= lo && v <= hi ? v : null);

// One ledger line (a string) → { ok: true, ev } | { ok: false, why }. Every field is checked;
// a bad REQUIRED field drops the line, a bad optional one becomes null. Integers must be safe
// integers (node:sqlite throws on a u64 past 2^53, memory reference_nodesqlite_u64_throws).
function parseLedgerLine(line, net, now) {
  if (typeof line !== 'string' || line.length === 0) return { ok: false, why: 'empty' };
  if (line.length > LINE_MAX) return { ok: false, why: 'too long' };
  let o;
  try { o = JSON.parse(line); } catch (_) { return { ok: false, why: 'not JSON' }; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, why: 'not an object' };
  if (o.v !== 1) return { ok: false, why: 'schema version' };
  if (o.net !== net) return { ok: false, why: 'network' };
  const idRe = new RegExp(`^${net}-\\d{9,11}-\\d{1,6}$`);
  if (typeof o.id !== 'string' || !idRe.test(o.id)) return { ok: false, why: 'id' };
  const tsMax = now + 86400;
  if (!isInt(o.ts) || o.ts < GENESIS_TS || o.ts > tsMax) return { ok: false, why: 'ts' };
  if (typeof o.event !== 'string' || !REC_EVENTS.has(o.event)) return { ok: false, why: 'event' };

  const ev = {
    id: o.id,
    ts: o.ts,
    event: o.event,
    state: typeof o.state === 'string' && REC_STATES.has(o.state) ? o.state : null,
    cls: typeof o.class === 'string' && REC_CLASSES.has(o.class) ? o.class : null,
    cls_initial: typeof o.class_initial === 'string' && REC_CLASSES.has(o.class_initial) ? o.class_initial : null,
    sub: optStr(o.sub, /^[a-z0-9_=:.-]+$/, 40),
    outage_id: typeof o.outage_id === 'string' && idRe.test(o.outage_id) ? o.outage_id : null,
    started_at: optInt(o.started_at, GENESIS_TS, tsMax),
    duration_s: optInt(o.duration_s, 0, 20 * 365 * 86400),
    rc: optInt(o.rc, 0, 255),
    by: optStr(o.by, /^[A-Za-z0-9_.-]+$/, 40),
    reason: typeof o.reason === 'string' ? o.reason.replace(/[^\x20-\x7e]/g, ' ').slice(0, 160) : null,
    evidence: optStr(o.evidence, /^[0-9A-Za-z_.-]+$/, 64),
    grin_version: optStr(o.grin_version, /^[0-9A-Za-z_.+-]+$/, 24),
    clean_shutdown: typeof o.clean_shutdown === 'boolean' ? o.clean_shutdown : null,
    observed_gap_s: optInt(o.observed_gap_s, 0, 20 * 365 * 86400),
  };
  // A started_at after its own line is nonsense; fall back to the line's ts.
  if (ev.started_at !== null && ev.started_at > ev.ts + 60) ev.started_at = null;
  return { ok: true, ev };
}

// Interval sweep. `intervals` = [{ a, b, cat }] (seconds, a < b); precedence decides which
// category owns a second covered by several: unobserved > down > planned > fault > up (the
// default for uncovered observed time). Returns [{ a, b, cat }] segments tiling [from, to).
const PRECEDENCE = ['unobserved', 'down', 'planned', 'fault'];
function sweep(intervals, from, to) {
  const pts = [];
  for (const iv of intervals) {
    const a = Math.max(iv.a, from), b = Math.min(iv.b, to);
    if (!(b > a) || !PRECEDENCE.includes(iv.cat)) continue;
    pts.push([a, 1, iv.cat], [b, -1, iv.cat]);
  }
  pts.sort((x, y) => x[0] - y[0]);
  const active = { unobserved: 0, down: 0, planned: 0, fault: 0 };
  const segs = [];
  let t = from, i = 0;
  const top = () => PRECEDENCE.find((c) => active[c] > 0) || 'up';
  while (t < to) {
    while (i < pts.length && pts[i][0] <= t) { active[pts[i][2]] += pts[i][1]; i++; }
    const nextT = i < pts.length ? Math.min(pts[i][0], to) : to;
    if (nextT > t) segs.push({ a: t, b: nextT, cat: top() });
    t = nextT;
  }
  return segs;
}

// Totals + per-UTC-day bins + uptime % from sweep segments.
function summarise(segs, from, to) {
  const zero = () => ({ up_s: 0, down_s: 0, planned_s: 0, fault_s: 0, unobserved_s: 0 });
  const tot = zero();
  const days = new Map();
  for (const s of segs) {
    let a = s.a;
    while (a < s.b) {
      const dayStart = Math.floor(a / 86400) * 86400;
      const b = Math.min(s.b, dayStart + 86400);
      const key = new Date(dayStart * 1000).toISOString().slice(0, 10);
      if (!days.has(key)) days.set(key, zero());
      days.get(key)[`${s.cat}_s`] += b - a;
      tot[`${s.cat}_s`] += b - a;
      a = b;
    }
  }
  const pct = (o) => (o.up_s + o.down_s > 0 ? Math.floor((o.up_s * 10000) / (o.up_s + o.down_s)) / 100 : null);
  const daily = [];
  for (let d = Math.floor(from / 86400) * 86400; d < to; d += 86400) {
    const key = new Date(d * 1000).toISOString().slice(0, 10);
    const o = days.get(key) || zero();
    daily.push(Object.assign({ day: key }, o, { uptime_pct: pct(o) }));
  }
  return Object.assign(tot, { uptime_pct: pct(tot), daily });
}

// ─── the module ─────────────────────────────────────────────────────────────────────────────────

class NodeAvailability {
  // grinNode: the GrinNodeAPI instance (its getStatus/downState are called; its timing is NOT
  // shared with block-monitor — this module owns its own probe loop).
  constructor(config, db, grinNode, opts = {}) {
    this.db = db;
    this.grinNode = grinNode;
    this.net = /^main/i.test(String(config.network || '')) ? 'mainnet' : 'testnet';
    const dir = typeof config.node_events_dir === 'string' && config.node_events_dir.trim()
      ? config.node_events_dir.trim() : '/opt/grin/node-events';
    this.netDir = path.join(dir, this.net);
    this.ledgerPath = path.join(this.netDir, 'ledger.jsonl');
    this.statusPath = path.join(this.netDir, 'status.json');
    this.now = opts.now || nowS;            // tests inject a clock
    this.log = opts.log || ((m) => console.log(`[${new Date().toISOString()}] [node-availability] ${m}`));
    this.warn = opts.warn || ((m) => console.error(`[${new Date().toISOString()}] [node-availability] ${m}`));

    this.probe = { strikes: 0, firstFailTs: null, downOpen: false, faultOpen: false };
    this.openPool = { down: null, fault: null, degraded: null };   // row ids
    this.downClasses = [];       // classes seen while the open pool outage lasted
    this.lastStatus = null;      // { at(ms), status } — alert-monitor reads it instead of probing again
    this.lastVerdict = null;     // { at(ms), kind }
    this.stratumDrops = 0;       // drops absorbed into the open outage
    this.recorder = { state: 'unknown', since: null };  // ledger file state for the admin page
    this._logAt = new Map();     // throttled log keys
    this._malformed = new Map(); // file → { n, why }
    this._timers = [];
    this._stopping = false;
    this._ingesting = false;
    this._statusMemo = { at: 0, val: null };
    this._stmts();
  }

  _stmts() {
    const d = this.db;
    this.q = {
      metaGet: d.prepare('SELECT value FROM node_availability_meta WHERE network = ? AND key = ?'),
      metaSet: d.prepare(`INSERT INTO node_availability_meta (network, key, value) VALUES (?, ?, ?)
                          ON CONFLICT(network, key) DO UPDATE SET value = excluded.value`),
      metaIns: d.prepare('INSERT OR IGNORE INTO node_availability_meta (network, key, value) VALUES (?, ?, ?)'),
      insert: d.prepare(`INSERT OR IGNORE INTO node_events
        (network, source, started_at, ended_at, duration_s, state, class, origin, detail, recorder_event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      byId: d.prepare('SELECT id, started_at, ended_at, class, detail FROM node_events WHERE id = ?'),
      byRid: d.prepare(`SELECT id, started_at, ended_at, class, detail FROM node_events
                        WHERE network = ? AND recorder_event_id = ?`),
      close: d.prepare(`UPDATE node_events SET ended_at = ?, duration_s = MAX(0, ? - started_at)
                        WHERE id = ? AND ended_at IS NULL`),
      setDetail: d.prepare('UPDATE node_events SET detail = ? WHERE id = ?'),
      setClass: d.prepare('UPDATE node_events SET class = ?, detail = ? WHERE id = ?'),
      openRows: d.prepare(`SELECT id, started_at, state, class, detail FROM node_events
                           WHERE network = ? AND source = ? AND ended_at IS NULL`),
      openDown: d.prepare(`SELECT id FROM node_events WHERE network = ? AND source = 'recorder'
                           AND state = 'down' AND ended_at IS NULL LIMIT 1`),
      lastPoolDownEnd: d.prepare(`SELECT MAX(ended_at) AS t FROM node_events
                                  WHERE network = ? AND source = 'pool' AND state = 'down'`),
      lastLongGapEnd: d.prepare(`SELECT MAX(ended_at) AS t FROM node_events
                                 WHERE network = ? AND source = 'pool' AND state = 'unobserved' AND duration_s > ?`),
      range: d.prepare(`SELECT id, source, started_at, ended_at, duration_s, state, class, origin, detail
                        FROM node_events WHERE network = ? AND started_at < ?
                        AND (ended_at IS NULL OR ended_at >= ?)
                        ORDER BY started_at DESC, id DESC LIMIT ?`),
      // availability() reads only the states it counts. With `range`'s LIMIT over every row, a
      // year of info/restart/degraded points could push the OLDEST rows — a long open outage or
      // unobserved span — past the cut, and that span then summed as up (R2).
      rangeCounted: d.prepare(`SELECT id, source, started_at, ended_at, duration_s, state, class, origin, detail
                        FROM node_events WHERE network = ? AND started_at < ?
                        AND (ended_at IS NULL OR ended_at >= ?)
                        AND state IN ('down', 'planned', 'fault', 'unobserved')`),
      firstRec: d.prepare(`SELECT MIN(started_at) AS t FROM node_events WHERE network = ? AND source = 'recorder'`),
    };
  }

  _meta(key) { const r = this.q.metaGet.get(this.net, key); return r ? r.value : null; }
  _metaInt(key) { const v = parseInt(this._meta(key), 10); return isInt(v) ? v : null; }
  _setMeta(key, val) { this.q.metaSet.run(this.net, key, String(val)); }

  _logOnce(key, msg, everyMs = LOG_EVERY_MS) {
    const t = Date.now();
    const last = this._logAt.get(key);
    if (last && t - last < everyMs) return;
    this._logAt.set(key, t);
    this.warn(msg);
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────────────────────────

  start() {
    try { this._recoverOnBoot(); } catch (e) { this.warn(`boot recovery failed: ${e.message}`); }
    const loop = (fn, ms) => {
      const run = async () => {
        if (this._stopping) return;
        try { await fn(); } catch (e) { this._logOnce(`loop:${fn.name}`, `${fn.name} failed: ${e.message}`); }
        if (!this._stopping) { const t = setTimeout(run, ms); if (t.unref) t.unref(); this._timers.push(t); }
      };
      return run;
    };
    // Self-rescheduling after completion, so a slow probe never overlaps the next one.
    loop(this.probeOnce.bind(this), PROBE_MS)();
    const ingest = loop(this.tick.bind(this), INGEST_MS);
    const t = setTimeout(ingest, 5000); if (t.unref) t.unref(); this._timers.push(t);
    this.log(`started (${this.net}; probe ${PROBE_MS / 1000}s, recorder ledger ${this.ledgerPath})`);
    return this;
  }

  stop() {
    this._stopping = true;
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
    try { this._setMeta('pool_heartbeat', this.now()); } catch (_) { /* DB already closed */ }
  }

  // A pool restart: whatever was open was last confirmed at the last heartbeat, and the time
  // the pool was not running is UNOBSERVED (nobody watched the node), not up and not down.
  // A SHORT restart (heartbeat ≤ UNOBSERVED_MIN_S old) re-adopts the open outage / auth fault
  // instead: closing it there counted the restart as up and split one outage in two (R2). The
  // first probe then closes or continues it as usual. A degraded row is never re-adopted — the
  // stratum client may reconnect before index.js wires onLinkChange, and nothing would close it.
  _recoverOnBoot() {
    const now = this.now();
    const hb = this._metaInt('pool_heartbeat');
    const open = this.q.openRows.all(this.net, 'pool');
    const short = hb !== null && now - hb <= UNOBSERVED_MIN_S;
    const tx = this.db.transaction(() => {
      for (const r of open) {
        if (short && r.state === 'down' && !this.openPool.down) {
          this.openPool.down = r.id; this.probe.downOpen = true; this.downClasses = r.class ? [r.class] : [];
          continue;
        }
        if (short && r.state === 'fault' && !this.openPool.fault) {
          this.openPool.fault = r.id; this.probe.faultOpen = true;
          continue;
        }
        const at = hb !== null && hb >= r.started_at ? hb : r.started_at;
        this.q.close.run(at, at, r.id);
        this.q.setDetail.run(clampDetail(`${r.detail || ''} · pool restarted; closed at its last heartbeat`), r.id);
      }
      if (hb !== null && now - hb > UNOBSERVED_MIN_S) {
        this.q.insert.run(this.net, 'pool', hb, now, now - hb, 'unobserved', null, null,
          'pool process not running (no probes)', null);
        if (now - hb > GAP_RESET_S) this._setMeta('pool_reach_floor', now);
      }
    });
    tx();
  }

  // ─── pool probe ──────────────────────────────────────────────────────────────────────────────

  async probeOnce() {
    const status = await this.grinNode.getStatus();
    const display = status && status.ok !== true && status.transport === 'refused'
      ? await this.grinNode.downState(status) : null;
    const verdict = classifyProbe(status, display);
    const now = this.now();
    this.lastStatus = { at: Date.now(), status };
    this.lastVerdict = { at: Date.now(), kind: verdict.kind };
    this.q.metaIns.run(this.net, 'pool_first_probe', String(now));
    this._applyProbe(verdict, now, status);
    // Heartbeat here too, not only in the 60 s tick: the tick stamps BEFORE its ledger read and
    // reschedules after it, so its stamp could be ~75 s old at a SIGTERM (index.js never calls
    // stop()), which turned a 50 s restart into a >120 s "pool not running" row (R2).
    this._setMeta('pool_heartbeat', now);
  }

  _applyProbe(verdict, now, status) {
    const { next, ops } = stepProbe(this.probe, verdict, now);
    if (ops.length) {
      // The ops also move in-memory row ids; a rolled-back transaction must take those back too,
      // or the next probe would close a row that was never written.
      const saved = { open: Object.assign({}, this.openPool), classes: this.downClasses.slice(), drops: this.stratumDrops };
      try {
        const tx = this.db.transaction(() => { for (const op of ops) this._poolOp(op, verdict, status); });
        tx();
      } catch (e) {
        this.openPool = saved.open; this.downClasses = saved.classes; this.stratumDrops = saved.drops;
        throw e;
      }
    }
    this.probe = next;
  }

  _poolDetail(cls, status) {
    const http = status && isInt(status.http_status) ? ` (HTTP ${status.http_status})` : '';
    switch (cls) {
      case 'timeout': return 'API accepted the connection but did not answer in time';
      case 'starting': return 'API port refused; a node process for this network is running (starting)';
      case 'refused': return 'API port refused; no node process seen';
      case 'auth': return `node rejected the pool's API credential${http} — the node answers; check the secret`;
      case 'node_error': return 'node replied with an error envelope or Err';
      default: return `no JSON-RPC answer${http}`;
    }
  }

  _poolOp(op, verdict, status) {
    const net = this.net;
    if (op.op === 'open_down') {
      const r = this.q.insert.run(net, 'pool', op.at, null, null, 'down', op.cls, op.origin,
        clampDetail(this._poolDetail(op.cls, status)), null);
      this.openPool.down = Number(r.lastInsertRowid);
      this.downClasses = [op.cls];
      this.stratumDrops = 0;
      // A stratum drop just before the API went down is the same event seen first on the
      // stratum socket: fold it into the outage instead of leaving two rows open.
      if (this.openPool.degraded) {
        const d = this.q.byId.get(this.openPool.degraded);
        this.q.close.run(Math.max(d.started_at, op.at), Math.max(d.started_at, op.at), d.id);
        this.openPool.degraded = null;
        this._appendDetail(this.openPool.down, `node stratum dropped ${Math.max(0, op.at - d.started_at)}s before`);
      }
    } else if (op.op === 'close_down' && this.openPool.down) {
      const id = this.openPool.down;
      this.q.close.run(op.at, op.at, id);
      // poolReachableSince() reads this, not only the row: retention prunes closed rows after
      // 730 days, and with the row gone "reachable since" fell back to the first probe ever (R2).
      this._setMeta('pool_reach_floor', op.at);
      const extra = [];
      if (this.downClasses.length > 1) extra.push(`seen: ${this.downClasses.join(' → ')}`);
      if (this.stratumDrops) extra.push(`node stratum dropped ×${this.stratumDrops}`);
      if (extra.length) this._appendDetail(id, extra.join(' · '));
      this.openPool.down = null;
      this.downClasses = [];
      this.stratumDrops = 0;
    } else if (op.op === 'note_class') {
      if (this.downClasses[this.downClasses.length - 1] !== op.cls && this.downClasses.length < 12) {
        this.downClasses.push(op.cls);
      }
    } else if (op.op === 'open_fault') {
      const r = this.q.insert.run(net, 'pool', op.at, null, null, 'fault', op.cls, op.origin,
        clampDetail(this._poolDetail(op.cls, status)), null);
      this.openPool.fault = Number(r.lastInsertRowid);
    } else if (op.op === 'close_fault' && this.openPool.fault) {
      this.q.close.run(op.at, op.at, this.openPool.fault);
      this.openPool.fault = null;
    }
  }

  _appendDetail(id, text) {
    const r = this.q.byId.get(id);
    if (!r) return;
    this.q.setDetail.run(clampDetail(r.detail ? `${r.detail} · ${text}` : text), id);
  }

  // Node-stratum link changes (NodeStratumClient.onLinkChange). A drop while the API outage is
  // open is a detail of that outage; a drop while the API is up is a short `degraded` row.
  noteStratumLink(up) {
    if (this._stopping) return;
    try {
      const now = this.now();
      if (!up) {
        if (this.openPool.down) { this.stratumDrops++; return; }
        if (this.openPool.degraded) return;
        const r = this.q.insert.run(this.net, 'pool', now, null, null, 'degraded', 'stratum_drop', 'transport',
          'node stratum link closed; the pool reconnects every 5 s', null);
        this.openPool.degraded = Number(r.lastInsertRowid);
      } else if (this.openPool.degraded) {
        this.q.close.run(now, now, this.openPool.degraded);
        this.openPool.degraded = null;
      }
    } catch (e) { this._logOnce('stratum', `stratum link note failed: ${e.message}`); }
  }

  // For alert-monitor: the latest probe result if it is fresh, so the node_down alert does not
  // send a second getStatus() of its own. null → the caller probes itself.
  recentStatus(maxAgeMs = PROBE_FRESH_MS) {
    if (!this.lastStatus || Date.now() - this.lastStatus.at > maxAgeMs) return null;
    return this.lastStatus.status;
  }

  // ─── 60 s tick: heartbeat + recorder ingest ──────────────────────────────────────────────────

  async tick() {
    this._setMeta('pool_heartbeat', this.now());
    await this.ingestOnce();
  }

  // `ledger` false = status.json: log it, but leave this.recorder alone — that is the LEDGER's
  // state, and flipping it from a status read blanked a recorder lane whose rows were readable (R2).
  _noteUnreadable(err, what, ledger = true) {
    const code = err && err.code ? err.code : 'error';
    const denied = code === 'EACCES' || code === 'EPERM';
    if (ledger) this.recorder = { state: 'unreadable', since: this.recorder.state === 'unreadable' ? this.recorder.since : this.now() };
    this._logOnce(`unreadable:${what}:${code}`, denied
      ? `recorder ${what} is not readable by the pool user (${code}). The recorder keeps ` +
        `/opt/grin/node-events/ and <net>/ at 0755 and status.json / ledger.jsonl at 0644 — fix the modes, ` +
        `or re-run hub 08 → Diagnostics → Node event recorder → Install / refresh.`
      : `recorder ${what} could not be read (${code}).`);
  }

  async ingestOnce() {
    if (this._ingesting) return;
    this._ingesting = true;
    try { await this._ingest(); } finally { this._ingesting = false; }
  }

  async _ingest() {
    let st;
    try { st = await fs.promises.stat(this.ledgerPath, { bigint: true }); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
        // No recorder on this box (or not for this network) — normal, not an error.
        this.recorder = { state: 'absent', since: null };
        return;
      }
      this._noteUnreadable(e, this.ledgerPath);
      return;
    }
    const ino = st.ino.toString();
    const size = Number(st.size);
    if (!isInt(size)) return;
    if (this.recorder.state !== 'ok') this.recorder = { state: 'ok', since: this.now() };

    let curIno = this._meta('rec_inode');
    let off = this._metaInt('rec_offset') || 0;

    if (curIno && curIno !== ino) {
      // Rename-based rotation (086 §8.7): finish the old file if it is now ledger.jsonl.1.
      try {
        const old = this.ledgerPath + '.1';
        const st1 = await fs.promises.stat(old, { bigint: true });
        // No per-tick chunk limit here: once the cursor moves to the new file, whatever is left
        // of the old one is never read again. Bounded by the recorder's 10 MB rotation size.
        if (st1.ino.toString() === curIno) await this._readFile(old, curIno, off, Number(st1.size), 64);
      } catch (e) {
        if (e.code !== 'ENOENT') this._logOnce('rotated', `could not finish the rotated ledger: ${e.code || e.message}`);
      }
      curIno = null;
    }
    if (!curIno) { off = 0; this._saveCursor(ino, 0); }
    if (size < off) { off = 0; this._saveCursor(ino, 0); }   // truncated: replay; the UNIQUE id absorbs it
    if (size > off) await this._readFile(this.ledgerPath, ino, off, size);
    this._flushMalformed(this.ledgerPath);
  }

  _saveCursor(ino, off) {
    this._setMeta('rec_inode', ino);
    this._setMeta('rec_offset', off);
  }

  // Read [off, size) of `file` in chunks, never past the last complete line. The cursor moves in
  // the SAME transaction as the rows, so a crash can neither skip nor double-apply a line.
  async _readFile(file, ino, off, size, maxChunks = CHUNKS_PER_TICK) {
    let fh;
    try { fh = await fs.promises.open(file, 'r'); } catch (e) { this._noteUnreadable(e, file); return; }
    try {
      const fst = await fh.stat({ bigint: true });
      if (fst.ino.toString() !== ino) return;      // rotated between stat and open: next tick
      const end = Math.min(size, Number(fst.size));
      for (let n = 0; n < maxChunks && off < end; n++) {
        const want = Math.min(CHUNK_BYTES, end - off);
        const buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, off);
        if (bytesRead <= 0) break;
        const chunk = buf.subarray(0, bytesRead);
        const last = chunk.lastIndexOf(0x0a);
        if (last < 0) {
          if (bytesRead === CHUNK_BYTES) {          // a "line" bigger than a chunk is not a ledger line
            this._countMalformed(file, 'oversized line');
            off += bytesRead;
            this._saveCursor(ino, off);
            continue;
          }
          break;                                     // partial trailing line: wait for the newline
        }
        const lines = chunk.subarray(0, last).toString('utf8').split('\n');
        off += last + 1;
        const newOff = off;
        const tx = this.db.transaction(() => {
          for (const line of lines) this._applyLine(line.replace(/\r$/, ''), file);
          this._saveCursor(ino, newOff);
        });
        tx();
      }
    } finally {
      await fh.close().catch(() => {});
    }
  }

  _countMalformed(file, why) {
    const m = this._malformed.get(file) || { n: 0, why };
    m.n++;
    this._malformed.set(file, m);
  }

  _flushMalformed(file) {
    const m = this._malformed.get(file);
    if (!m || !m.n) return;
    const key = `malformed:${file}`;
    const last = this._logAt.get(key);
    if (last && Date.now() - last < LOG_EVERY_MS) return;   // keep counting until the hour is up
    this._logAt.set(key, Date.now());
    this.warn(`dropped ${m.n} malformed line(s) from ${file} (first reason: ${m.why})`);
    this._malformed.delete(file);
  }

  // ─── one recorder line → rows ────────────────────────────────────────────────────────────────

  _recDetail(ev) {
    const parts = [];
    if (ev.cls && ev.cls_initial && ev.cls_initial !== ev.cls) parts.push(`initially ${ev.cls_initial}`);
    if (ev.sub) parts.push(ev.sub);
    if (ev.rc !== null) parts.push(`rc=${ev.rc}`);
    if (ev.by) parts.push(`by=${ev.by}`);
    if (ev.reason) parts.push(ev.reason);
    if (ev.event === 'boot' && ev.clean_shutdown !== null) {
      parts.push(ev.clean_shutdown ? 'previous boot ended cleanly' : 'previous boot ended UNCLEANLY');
    }
    if (ev.evidence) parts.push(`evidence: ${ev.evidence}`);
    if (ev.grin_version) parts.push(`grin ${ev.grin_version}`);
    return parts.length ? clampDetail(parts.join(' · ')) : null;
  }

  // `prevLast` = the ts of the latest line ingested before this one (rec_last_ts), or null.
  _rowFor(ev, prevLast) {
    const d = this._recDetail(ev);
    switch (ev.event) {
      case 'down':
        return { state: 'down', cls: ev.cls || ev.cls_initial, start: ev.started_at || ev.ts, open: true, detail: d };
      case 'stop': return { state: 'planned', start: ev.ts, open: true, detail: clampDetail(`toolkit stop${d ? ' · ' + d : ''}`) };
      case 'boot': return { state: 'planned', start: ev.ts, open: true, detail: clampDetail(`host boot${d ? ' · ' + d : ''}`) };
      case 'auth_fail':
        return { state: 'fault', cls: null, origin: 'auth', start: ev.ts, open: true, detail: clampDetail(`node rejects the recorder's credential${d ? ' · ' + d : ''}`) };
      case 'gap':
        if (ev.observed_gap_s !== null && ev.observed_gap_s > 0) {
          return { state: 'unobserved', start: Math.max(GENESIS_TS, ev.ts - ev.observed_gap_s), end: ev.ts, detail: clampDetail(`recorder saw no checks for ${ev.observed_gap_s}s`) };
        }
        return { state: 'info', start: ev.ts, end: ev.ts, detail: clampDetail(`gap${d ? ' · ' + d : ''}`) };
      case 'restart_by_watchdog': return { state: 'restart', start: ev.ts, end: ev.ts, detail: clampDetail(`restart by watchdog${d ? ' · ' + d : ''}`) };
      case 'start':
        return { state: this.q.openDown.get(this.net) ? 'restart' : 'planned', start: ev.ts, end: ev.ts, detail: clampDetail(`node start${d ? ' · ' + d : ''}`) };
      case 'reclass':
        return { state: 'info', start: ev.ts, end: ev.ts, detail: clampDetail(`reclass → ${ev.cls || '?'}${d ? ' · ' + d : ''}`) };
      case 'recorder_start':
        // A first run with no status.json (fresh install, or a ledger restored by 089): nothing was
        // observed between the previous line and this one, so that span is UNOBSERVED — the same
        // rule as 086's dgr_availability. As an info point it read as "up" for the whole gap (R2).
        if (prevLast !== null && prevLast < ev.ts) {
          return { state: 'unobserved', start: prevLast, end: ev.ts,
            detail: clampDetail(`recorder restarted without its status; nothing observed since its previous line${d ? ' · ' + d : ''}`) };
        }
        return { state: 'info', start: ev.ts, end: ev.ts, detail: clampDetail(`recorder_start${d ? ' · ' + d : ''}`) };
      default:
        return { state: 'info', start: ev.ts, end: ev.ts, detail: clampDetail(`${ev.event}${d ? ' · ' + d : ''}`) };
    }
  }

  // Close every open recorder row of the given states at `at` (never before its own start),
  // except `keepId` — the row the current line just opened.
  _closeOpenRec(states, at, note, keepId = null) {
    for (const r of this.q.openRows.all(this.net, 'recorder')) {
      if (!states.includes(r.state) || r.id === keepId) continue;
      const t = Math.max(r.started_at, at);
      this.q.close.run(t, t, r.id);
      if (note) this.q.setDetail.run(clampDetail(r.detail ? `${r.detail} · ${note}` : note), r.id);
    }
  }

  // Apply one line. Every valid line inserts exactly one row keyed by its id; side effects run
  // only when that insert happened, so a replay after truncation (or a re-read) is a no-op.
  _applyLine(line, file) {
    if (!line.trim()) return;
    const p = parseLedgerLine(line, this.net, this.now());
    if (!p.ok) { this._countMalformed(file, p.why); return; }
    const ev = p.ev;
    const prevLast = this._metaInt('rec_last_ts');
    const row = this._rowFor(ev, prevLast);
    const end = row.open ? null : (isInt(row.end) ? row.end : row.start);
    const res = this.q.insert.run(this.net, 'recorder', row.start, end,
      end === null ? null : Math.max(0, end - row.start), row.state,
      row.cls || null, row.origin || null, row.detail || null, ev.id);
    if (Number(res.changes) !== 1) return;     // already ingested
    const own = Number(res.lastInsertRowid);
    if (prevLast === null || ev.ts > prevLast) this._setMeta('rec_last_ts', ev.ts);

    // 1. A line that closes the open outage (`up`, `boot`, `stop`, `auth_fail`, `unregistered`,
    //    … — 086 §8.15) carries its outage_id and, usually, duration_s.
    if (ev.outage_id && !['down', 'reclass', 'restart_by_watchdog', 'start'].includes(ev.event)) {
      const o = this.q.byRid.get(this.net, ev.outage_id);
      if (o && o.ended_at === null) {
        const at = ev.duration_s !== null ? o.started_at + ev.duration_s : ev.ts;
        this.q.close.run(at, at, o.id);
      }
    }
    // 2. Per-event side effects.
    switch (ev.event) {
      case 'down': this._closeOpenRec(['planned', 'fault'], row.start, null, own); break;
      case 'up':
        // The recorder keeps one outage open at a time and `up` ends it. Step 1 closed the one this
        // line names; any OTHER open recorder outage lost its closing line (unread past a second
        // rotation, or an outage_id that failed validation) and would read as down forever (R2).
        this._closeOpenRec(['planned', 'fault'], ev.ts, null, own);
        this._closeOpenRec(['down'], ev.ts, 'closed by a later up line (its own closing line was never ingested)', own);
        break;
      case 'boot':
      case 'stop':
      case 'auth_fail':
      case 'unregistered':
        this._closeOpenRec(['planned', 'fault'], ev.ts, null, own);
        break;
      case 'auth_ok': this._closeOpenRec(['fault'], ev.ts, null, own); break;
      case 'reclass':
        if (ev.outage_id && ev.cls) {
          const o = this.q.byRid.get(this.net, ev.outage_id);
          if (o && o.class !== ev.cls) {
            this.q.setClass.run(ev.cls, clampDetail(`${o.detail ? o.detail + ' · ' : ''}reclassified from ${o.class || '?'}`), o.id);
          }
        }
        break;
      case 'recorder_start':
        // The recorder (re)started without its status: whatever was open was last seen at the
        // previous line, and the span since is unobserved (086 §8.18).
        this._closeOpenRec(['down', 'planned', 'fault'], prevLast !== null ? Math.min(prevLast, ev.ts) : ev.ts,
          'recorder restarted; closed at its last line', own);
        break;
      default: break;
    }
  }

  // ─── reads ────────────────────────────────────────────────────────────────────────────────────

  // The recorder's status.json, validated. { state, updated, up_since, stale } or null.
  readRecorderStatus() {
    const t = Date.now();
    if (t - this._statusMemo.at < 10000) return this._statusMemo.val;
    let val = null;
    try {
      const st = fs.statSync(this.statusPath);
      if (st.isFile() && st.size <= STATUS_MAX_BYTES) {
        const o = JSON.parse(fs.readFileSync(this.statusPath, 'utf8'));
        const now = this.now();
        if (o && o.v === 1 && o.net === this.net && isInt(o.updated) && o.updated >= GENESIS_TS && o.updated <= now + 60) {
          val = {
            state: typeof o.state === 'string' && REC_STATES.has(o.state) ? o.state : null,
            cls: typeof o.class === 'string' && REC_CLASSES.has(o.class) ? o.class : null,
            updated: o.updated,
            up_since: isInt(o.up_since) && o.up_since >= GENESIS_TS && o.up_since <= now ? o.up_since : null,
            stale: now - o.updated > STATUS_FRESH_S,
          };
        }
      }
    } catch (e) {
      if (e.code && e.code !== 'ENOENT' && e.code !== 'ENOTDIR') this._noteUnreadable(e, this.statusPath, false);
    }
    this._statusMemo = { at: t, val };
    return val;
  }

  // The pool's own "reachable since" (§20.5 source 2): the end of the last counted pool outage,
  // or of the last long pool-not-running gap, never earlier than the first probe ever stored.
  // null while the pool's own probe is not currently ok.
  poolReachableSince() {
    if (!this.lastVerdict || this.lastVerdict.kind !== 'ok' || Date.now() - this.lastVerdict.at > PROBE_FRESH_MS) return null;
    if (this.openPool.down) return null;
    const first = this._metaInt('pool_first_probe');
    if (first === null) return null;
    const a = this.q.lastPoolDownEnd.get(this.net);
    const b = this.q.lastLongGapEnd.get(this.net, GAP_RESET_S);
    const floor = this._metaInt('pool_reach_floor');      // survives retention pruning those rows
    return Math.max(first, (a && isInt(a.t)) ? a.t : 0, (b && isInt(b.t)) ? b.t : 0, floor !== null ? floor : 0);
  }

  // The public value (§20.5): the recorder's up_since when its status is fresh and `up`, else
  // the pool's own reachable-since, else null. `reachableNow` is the caller's own probe result —
  // unreachable now means null, whatever the history says. Never a timestamp, never `0` for unknown.
  upDaysPublic(reachableNow) {
    if (reachableNow !== true) return null;
    const now = this.now();
    try {
      const rec = this.readRecorderStatus();
      if (rec && !rec.stale && rec.state === 'up' && rec.up_since !== null) return upDaysFrom(rec.up_since, now);
      const since = this.poolReachableSince();
      return since === null ? null : upDaysFrom(since, now);
    } catch (_) { return null; }
  }

  static parseRange(r) {
    if (r === undefined || r === null || r === '') return { key: '30d', secs: RANGES['30d'] };
    return Object.prototype.hasOwnProperty.call(RANGES, r) ? { key: r, secs: RANGES[r] } : null;
  }

  // Rows of both sources overlapping [now - secs, now], newest first (admin only).
  events(secs, limit = 2000) {
    const now = this.now();
    const from = now - secs;
    const rows = this.q.range.all(this.net, now + 1, from, Math.min(Math.max(limit, 1), 5000));
    return {
      network: this.net, from, to: now,
      recorder: this._recorderInfo(),
      events: rows.map((r) => Object.assign({}, r, { open: r.ended_at === null })),
    };
  }

  _recorderInfo() {
    const st = this.readRecorderStatus();
    return {
      ledger: this.recorder.state,           // 'absent' | 'unreadable' | 'ok' | 'unknown'
      status: st ? { state: st.state, class: st.cls, updated: st.updated, stale: st.stale, up_since: st.up_since } : null,
    };
  }

  // Availability summary per source over [now - secs, now] (admin only).
  availability(secs) {
    const now = this.now();
    const from = now - secs;
    const rows = this.q.rangeCounted.all(this.net, now + 1, from);
    const out = { network: this.net, from, to: now, recorder: this._recorderInfo(), sources: {} };
    for (const source of ['pool', 'recorder']) {
      const mine = rows.filter((r) => r.source === source);
      const ivs = [];
      for (const r of mine) {
        if (r.state === 'down' || r.state === 'planned' || r.state === 'fault' || r.state === 'unobserved') {
          ivs.push({ a: r.started_at, b: r.ended_at === null ? now : r.ended_at, cat: r.state });
        }
      }
      // Before the first observation nothing was watched.
      let obsStart;
      if (source === 'pool') obsStart = this._metaInt('pool_first_probe');
      else { const f = this.q.firstRec.get(this.net); obsStart = f && isInt(f.t) ? f.t : null; }
      if (obsStart === null) obsStart = now;
      if (obsStart > from) ivs.push({ a: from, b: obsStart, cat: 'unobserved' });
      if (source === 'recorder') {
        // A recorder that stopped writing: the tail after its last status update is unobserved.
        // With no status.json at all, the tail after the last ingested line is.
        const st = this.readRecorderStatus();
        const lastLine = this._metaInt('rec_last_ts');
        if (st && st.stale) ivs.push({ a: st.updated, b: now, cat: 'unobserved' });
        else if (!st && lastLine !== null) ivs.push({ a: lastLine, b: now, cat: 'unobserved' });
      }
      const sum = summarise(sweep(ivs, from, now), from, now);
      const downs = mine.filter((r) => r.state === 'down');
      const started = downs.filter((r) => r.started_at >= from);
      const byClass = {};
      for (const r of started) byClass[r.class || 'unknown'] = (byClass[r.class || 'unknown'] || 0) + 1;
      let longest = null;
      for (const r of downs) {
        const d = (r.ended_at === null ? now : r.ended_at) - r.started_at;
        if (longest === null || d > longest) longest = d;
      }
      out.sources[source] = Object.assign(sum, {
        outages: started.length,
        by_class: byClass,
        mtbf_s: started.length ? Math.floor(sum.up_s / started.length) : null,
        longest_outage_s: longest,
        open_outage: downs.some((r) => r.ended_at === null),
        planned_stops: mine.filter((r) => r.state === 'planned' && r.started_at >= from && r.ended_at !== r.started_at).length,
        up_since: source === 'pool' ? this.poolReachableSince()
          : (out.recorder.status && !out.recorder.status.stale && out.recorder.status.state === 'up' ? out.recorder.status.up_since : null),
      });
      out.sources[source].up_days = upDaysFrom(out.sources[source].up_since, now);
    }
    return out;
  }
}

module.exports = NodeAvailability;
module.exports.classifyProbe = classifyProbe;
module.exports.stepProbe = stepProbe;
module.exports.upDaysFrom = upDaysFrom;
module.exports.parseLedgerLine = parseLedgerLine;
module.exports.sweep = sweep;
module.exports.summarise = summarise;
module.exports.clampDetail = clampDetail;
module.exports.ROW_STATES = ROW_STATES;
module.exports.POOL_CLASSES = POOL_CLASSES;
module.exports.REC_CLASSES = REC_CLASSES;
module.exports.DOWN_STRIKES = DOWN_STRIKES;
module.exports.GAP_RESET_S = GAP_RESET_S;
