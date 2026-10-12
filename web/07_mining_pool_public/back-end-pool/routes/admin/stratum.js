// /api/admin/stratum/* — the stratum pause (design §21.10): read the state, pause, extend,
// resume, schedule / cancel a maintenance window. The policy lives in lib/stratum-pause.js.
// Moved verbatim out of routes/index.js (code-layout refactor P6); registrations stay at 2-space
// indent and write FULL paths. Instances/state come from ctx; the guard chains are the ONE
// createGuards(ctx) instance routes/index.js built (I7), handed in as `guards`.

const express = require('express');
const StratumPause = require('../../lib/stratum-pause');

module.exports = function createAdminStratumRoutes(ctx, guards) {
  const { config, stratumPause } = ctx;
  const { secureAdmin, freshAdmin } = guards;
  const router = express.Router();

  // ─── STRATUM PAUSE (Admin) — design §21.10 ─────────────────────────
  // Stop / start miner intake on EVERY stratum listener (public + each region). The policy, the
  // caps (§21.7), the transition guard, the audit rows and the 15 s tick all live in
  // lib/stratum-pause.js; these handlers only parse the request and map the answer.
  // Reading is secureAdmin. EVERY mutation is freshAdmin — resume included (Q3): an early resume
  // during a restore acks shares into a DB about to be replaced, which is the one outcome this
  // feature exists to prevent. The state is the stratum_control table, never a pool_config key,
  // so no settings route (Save, section restore, resetAll) can reach it (§21.1).
  router.get('/api/admin/stratum/control', secureAdmin, (req, res) => {
    try {
      const st = stratumPause.status();
      // Every region recorded in config.region_ports, beside whether this process holds its
      // listener. While paused nothing is held, so EVERY region shows as `deferred` (one paired
      // during the pause included) — it opens on resume (§21.4). While accepting, a region not listening is a
      // failed bind, and Resume re-binds it.
      const held = new Map(st.listeners.map((l) => [Number(l.port), l]));
      const regions = Object.entries(config.region_ports || {}).map(([region, port]) => {
        const l = held.get(Number(port));
        return { region, port: Number(port) || null, listening: !!(l && l.listening), deferred: st.paused && !l };
      });
      res.json({ success: true, ...st, public_port: config.stratum_port || null, regions,
        limits: StratumPause.LIMITS, now: Math.floor(Date.now() / 1000) });
    } catch (err) { StratumPause.sendError(res, err, null); }
  });

  // { reason, duration_min } → the §21.2 report (settled, inflight_left, blocks_in_flight, …).
  // 409 while already paused (use extend). Can take up to ~35 s: it waits for in-flight submits.
  router.post('/api/admin/stratum/pause', freshAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const out = await stratumPause.pause({
        reason: b.reason, durationMin: StratumPause.parseDurationMin(b.duration_min), ...StratumPause.actorOf(req),
      });
      res.json({ success: true, ...out });
    } catch (err) { StratumPause.sendError(res, err, stratumPause); }
  });

  // { duration_min } → a new `until` = now + duration (never beyond now + 2 h). Only while paused.
  router.post('/api/admin/stratum/extend', freshAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const out = await stratumPause.extend({
        durationMin: StratumPause.parseDurationMin(b.duration_min), ...StratumPause.actorOf(req),
      });
      res.json({ success: true, ...out });
    } catch (err) { StratumPause.sendError(res, err, stratumPause); }
  });

  // While paused: re-bind everything and accept again (§21.3). While accepting: re-bind only what
  // is missing — the retry button for a failed bind. `failed` > 0 = some listener is still down.
  router.post('/api/admin/stratum/resume', freshAdmin, async (req, res) => {
    try {
      const out = await stratumPause.resume(StratumPause.actorOf(req));
      res.json({ success: true, ...out });
    } catch (err) { StratumPause.sendError(res, err, stratumPause); }
  });

  // { start, end, reason } — ZONE-QUALIFIED ISO-8601 only (…Z or ±hh:mm); a zone-less time is a
  // 400, since Date.parse would read it as the server's local time. Replaces any scheduled window.
  router.post('/api/admin/stratum/window', freshAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const out = await stratumPause.scheduleWindow({
        start: StratumPause.parseZonedIso(b.start, 'start'),
        end: StratumPause.parseZonedIso(b.end, 'end'),
        reason: b.reason, ...StratumPause.actorOf(req),
      });
      res.json({ success: true, ...out });
    } catch (err) { StratumPause.sendError(res, err, stratumPause); }
  });

  // Cancel the SCHEDULED window. A window that has started is an ordinary pause → 409, use resume.
  router.delete('/api/admin/stratum/window', freshAdmin, async (req, res) => {
    try {
      const out = await stratumPause.cancelWindow(StratumPause.actorOf(req));
      res.json({ success: true, ...out });
    } catch (err) { StratumPause.sendError(res, err, stratumPause); }
  });

  return router;
};
