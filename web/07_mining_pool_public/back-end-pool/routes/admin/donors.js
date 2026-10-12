// /api/admin/donors*. Moved verbatim out of routes/index.js (code-layout refactor P9);
// registrations stay at 2-space indent and write FULL paths.

const express = require('express');
const { getHorizon: getLedgerRollupHorizon } = require('../../lib/ledger-rollup');
const { donorSettings } = require('../../lib/donor-names');
const { donorLedger, donorScore, loyaltyMultiplier: donorLoyaltyMultiplier,
        leagueOrder: donorLeagueOrder, liveDonations: donorLiveDonations,
        NO_LIVE: DONOR_NO_LIVE } = require('../../lib/donor-ledger');
const DonorProfiles = require('../../lib/donor-profiles');
const { parseDonateToken } = require('../../lib/stratum-protocol');
const { GRIN_ADDR_RE } = require('../_shared/grin-address');

module.exports = function createAdminDonorsRoutes(ctx, guards) {
  const { db, minerManager, incentivesManager, poolSettings, uploadsDir, hashrateTracker, donorNameRule } = ctx;
  const { secureAdmin, freshAdmin } = guards;
  const router = express.Router();

  // ─── DONORS (Admin only) — design §18.6 (§18 Part 3, 2026-09-24) ─────────────────────────
  // The operator's review surface for donor profiles. Every donor nickname and banner is
  // PRE-moderated: a submission is a pending donor_requests row (lib/donor-profiles.js) that
  // nothing public reads until an approve here. FULL addresses on purpose — this is the admin
  // side (the public wall masks, §J11-1).
  //
  // Tiers: secureAdmin reads, freshAdmin (step-up) writes — a decision puts words or an image on
  // a public page in someone's name, the same tier as ban/unban. Every write's state change and
  // its admin_audit_log row are ONE transaction inside the lib (fail-closed: no decision lands
  // without its audit row), so these routes only validate input and map result codes to status.
  //
  // v1's censor/uncensor routes and the rescan-on-settings-save hook were REMOVED in this part
  // (§18.6): with pre-moderation there is nothing published to censor after the fact.
  const DONOR_ADMIN_CODES = {
    bad_id:        [400, 'Not a valid request id'],
    bad_status:    [400, `status must be one of ${DonorProfiles.STATUSES.join(', ')}`],
    bad_kind:      [400, 'kind must be "name" or "banner"'],
    not_found:     [404, 'No such request (for an image: no such banner request)'],
    no_image:      [404, 'This request has no image bytes (only a pending or approved banner does)'],
    not_pending:   [409, 'This request has already been decided — reload the queue'],
    blocked:       [409, 'This address is blocked from donor profiles — unblock it first'],
    conflict:      [409, 'Another decision on this donor landed at the same moment — reload and try again'],
    invalid_image: [422, 'The stored image no longer passes the banner rules'],
    write_failed:  [500, 'The banner file could not be written — check the uploads directory'],
    nothing_live:  [404, 'There is no live item of that kind to remove'],
    already:       [409, 'This address is already blocked'],
    not_blocked:   [409, 'This address is not blocked'],
    // Part C4 — donor names
    bad_state:      [400, 'state must be "live" or "removed"'],
    bad_name:       [400, 'Give a name that folds to 1–32 letters and digits (spaces and - _ . & \' are ignored)'],
    already_banned: [409, 'That name (in some spelling) is already banned'],
    not_banned:     [404, 'That name is not on the ban list'],
  };
  const donorAdminRefuse = (res, r) => {
    const [status, text] = DONOR_ADMIN_CODES[r.code] || [400, 'Refused'];
    return res.status(status).json({ error: r.error || text, reason: r.code || 'refused' });
  };
  const donorAdminSettings = () =>
    donorSettings(poolSettings.getSection('incentives'), poolSettings.getSection('pool_info').pool_name);

  // The donor ledger once, with the §16.6 numbers the wall ranks by (same helpers, same order):
  // Map<address, ledger row + multiplier + score + rank>. rank is null with nothing in the window.
  // Not capped at the wall's 100 — the operator sees #150 even though the wall does not.
  const donorLedgerRanked = (ds, now, H) => {
    const rows = donorLedger(db, { H, windowDays: ds.rankWindowDays, now });
    for (const r of rows) {
      r.multiplier = donorLoyaltyMultiplier(r.active_months, ds);
      r.score = donorScore(r.in_window_donated, r.active_months, ds);
      r.rank = null;
    }
    let rank = 0;
    for (const r of rows.filter((x) => x.in_window_donated > 0).sort(donorLeagueOrder)) r.rank = ++rank;
    return new Map(rows.map((r) => [r.address, r]));
  };

  // The donors list. One row per address that has EVER donated (a ledger debit), has a LIVE tag
  // (a tagged rig mining now, liveDonations(), §18.3 — counted only while donations are on), or
  // has a profile on file (an approved or pending request, or a block). The third set keeps a
  // blocked or approved address visible so it can be unblocked or taken down.
  //
  // Cost: the ONE composite ledger scan /api/pool/donors already does, one read of the small
  // donor_requests/donor_blocks tables, and per returned row (cap 500, like /api/admin/miners)
  // getWorkersForAccount over the 24 h window — an indexed (grin_address) lookup on a table
  // pruned to ~31 h. It never walks shares per donor beyond that window.
  router.get('/api/admin/donors', secureAdmin, (req, res) => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const H = getLedgerRollupHorizon(db);
      const ds = donorAdminSettings();
      let active = false;
      try { active = !!(incentivesManager && incentivesManager.donationsActive()); } catch (_) { active = false; }

      const ledgerByAddr = donorLedgerRanked(ds, now, H);
      const live = donorLiveDonations(minerManager ? minerManager.getActiveSessions() : []);
      const liveTagged = active ? [...live].filter(([, v]) => v.rigs_donating > 0).map(([a]) => a) : [];
      const profiles = DonorProfiles.adminProfiles(db, {
        ds, now, lastDonatedAt: (a) => (ledgerByAddr.get(a) || {}).last_donated_at || null
      });

      const addrs = new Set([...ledgerByAddr.keys(), ...liveTagged, ...profiles.keys()]);
      const rows = [];
      for (const address of addrs) {
        const l = ledgerByAddr.get(address) || {};
        const p = profiles.get(address) || { name: null, banner: null, pending: { name: false, banner: false }, blocked: null };
        const lv = live.get(address) || DONOR_NO_LIVE;
        const donating = active ? lv.rigs_donating : 0;
        rows.push({
          address,
          // The LIVE (approved) profile, with the same expiry state the donor and the wall see.
          name: p.name,
          banner: p.banner,
          pending: p.pending,
          blocked: p.blocked,
          // Same readings + gate as the wall and the account page (design §18.3).
          rigs_online: lv.rigs_online,
          rigs_donating: donating,
          pct_min: donating ? lv.pct_min : 0,
          pct_max: donating ? lv.pct_max : 0,
          lifetime_donated: l.total_donated || 0,
          in_window_donated: l.in_window_donated || 0,
          active_months: l.active_months || 0,
          first_donated_at: l.first_donated_at || null,
          last_donated_at: l.last_donated_at || null,
          donation_count: l.donation_count || 0,
          multiplier: l.multiplier || donorLoyaltyMultiplier(0, ds),
          score: l.score || 0,
          rank: l.rank || null,
          workers: []
        });
      }
      rows.sort(donorLeagueOrder);

      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 500);
      const page = rows.slice(0, limit);
      for (const r of page) {
        // 24 h window: name, live flag, and the rig's tag (null = untagged) — same grammar as
        // the login and the per-share money path (parseDonateToken).
        let ws = [];
        try { ws = hashrateTracker.getWorkersForAccount(r.address, 1440) || []; } catch (_) { ws = []; }
        r.workers = ws.map((w) => {
          const t = parseDonateToken(w.worker_name);
          return { name: w.worker_name, online: !!w.online, donate_percent: t ? t.percent : null };
        });
      }

      res.json({
        success: true,
        count: rows.length,
        donors: page,
        window_days: ds.rankWindowDays,
        banner_slots: ds.bannerSlots,
        donations_active: active,
        pending_requests: DonorProfiles.pendingCount(db),
        now
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The nav badge on every admin page reads this instead of /api/admin/dashboard: one COUNT on
  // a partial-indexed status versus the dashboard's dozen queries, per page load.
  router.get('/api/admin/donors/summary', secureAdmin, (req, res) => {
    try {
      res.json({ success: true, pending_requests: DonorProfiles.pendingCount(db) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The review queue (§18.6). ?status= is a closed enum (default pending — oldest first);
  // the decided statuses are the history. ?kind= (name | banner, optional) narrows it: since
  // Part C4 names are auto-checked, so the admin page asks for banners. Each row carries the
  // address's current approved item of that kind and the donor's league rank + lifetime so the
  // reviewer knows who is asking. Never the bytes.
  router.get('/api/admin/donors/requests', secureAdmin, (req, res) => {
    try {
      const ds = donorAdminSettings();
      const limit = parseInt(req.query.limit, 10);
      const q = DonorProfiles.adminQueue(db, {
        status: req.query.status, kind: req.query.kind, limit: Number.isSafeInteger(limit) ? limit : undefined
      });
      if (!q.ok) return donorAdminRefuse(res, q);
      const ledgerByAddr = donorLedgerRanked(ds, Math.floor(Date.now() / 1000), getLedgerRollupHorizon(db));
      for (const r of q.rows) {
        const l = ledgerByAddr.get(r.address) || {};
        r.rank = l.rank || null;
        r.lifetime_donated = l.total_donated || 0;
        r.last_donated_at = l.last_donated_at || null;
      }
      res.json({ success: true, status: q.status, total: q.total, requests: q.rows, banner_slots: ds.bannerSlots });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The bytes behind one banner request (pending blob or approved file) for the queue's
  // preview. The admin page points a plain same-origin <img src> here (the httpOnly SameSite=strict
  // session cookie rides along), so these headers govern every way the image is viewed —
  // including "open image in new tab". Served as the STORED sniffed mime, never
  // sniffed by the browser, and sandboxed with no sub-resources, so a polyglot renders as an
  // image or not at all — never as a document on the admin origin.
  router.get('/api/admin/donors/requests/:id/image', secureAdmin, (req, res) => {
    try {
      const r = DonorProfiles.requestImage(db, req.params.id, { uploadsDir });
      if (!r.ok) return donorAdminRefuse(res, r);
      res.setHeader('Content-Type', r.mime);
      res.setHeader('Content-Length', String(r.bytes.length));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).end(r.bytes);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // A banner decision needs the uploads directory (approve writes the file; removing a live one
  // deletes it). The lib throws without it, so say it here as a clean 503 instead.
  const donorRequestKind = (id) => {
    const n = /^[0-9]{1,15}$/.test(String(id)) ? parseInt(id, 10) : NaN;
    const row = Number.isSafeInteger(n) ? db.prepare('SELECT kind FROM donor_requests WHERE id = ?').get(n) : null;
    return row ? row.kind : null;
  };
  const NO_UPLOADS = { error: 'The uploads directory is not configured on this pool, so a banner cannot be published or removed.' };

  router.post('/api/admin/donors/requests/:id/approve', freshAdmin, (req, res) => {
    try {
      if (!uploadsDir && donorRequestKind(req.params.id) === 'banner') return res.status(503).json(NO_UPLOADS);
      const r = DonorProfiles.approve(db, req.params.id, { adminId: req.user.user_id, ip: req.ip, uploadsDir: uploadsDir || undefined });
      if (!r.ok) return donorAdminRefuse(res, r);
      if (r.warning) console.warn(`[donor-profile] approve #${r.id}: ${r.warning}`);
      res.json({ success: true, id: r.id, kind: r.kind, grin_address: r.address, status: 'approved',
                 url: r.file ? DonorProfiles.publicUrl(r.file) : null, replaced_id: r.replaced_id, warning: r.warning || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The reason is SHOWN to the donor on their account page, which anyone holding the address can
  // open (the admin page says so beside the field). Optional; one line, ≤ 200 chars (cleanReason).
  router.post('/api/admin/donors/requests/:id/reject', freshAdmin, (req, res) => {
    try {
      const r = DonorProfiles.reject(db, req.params.id, { adminId: req.user.user_id, ip: req.ip, reason: (req.body || {}).reason });
      if (!r.ok) return donorAdminRefuse(res, r);
      res.json({ success: true, id: r.id, kind: r.kind, grin_address: r.address, status: 'rejected' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Take a LIVE (approved) name or banner down. :addr through the one gate the account family
  // uses (GRIN_ADDR_RE, §J3-8) — the prize_pool/pool_fee pseudo-accounts are not reachable.
  router.post('/api/admin/donors/:addr/remove', freshAdmin, (req, res) => {
    try {
      const addr = String(req.params.addr || '').trim();
      if (!GRIN_ADDR_RE.test(addr)) return res.status(400).json({ error: 'Not a well-formed Grin address' });
      const body = req.body || {};
      const kind = body.kind;
      if (!DonorProfiles.KINDS.includes(kind)) return donorAdminRefuse(res, { code: 'bad_kind' });
      if (kind === 'banner' && !uploadsDir) return res.status(503).json(NO_UPLOADS);
      const r = DonorProfiles.removeLive(db, addr, kind, { adminId: req.user.user_id, ip: req.ip, reason: body.reason, uploadsDir: uploadsDir || undefined });
      if (!r.ok) return donorAdminRefuse(res, r);
      if (r.warning) console.warn(`[donor-profile] remove ${addr.slice(0, 9)}… ${kind}: ${r.warning}`);
      res.json({ success: true, grin_address: addr, kind, status: 'removed', id: r.id, warning: r.warning || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bar an address from SUBMITTING (its live name/banner stays until removed separately);
  // blocking withdraws its pending requests in the same transaction, so the queue never shows a
  // blocked address's work. The miner routes refuse a blocked address with 403 `blocked`.
  router.post('/api/admin/donors/:addr/block', freshAdmin, (req, res) => {
    try {
      const addr = String(req.params.addr || '').trim();
      if (!GRIN_ADDR_RE.test(addr)) return res.status(400).json({ error: 'Not a well-formed Grin address' });
      const r = DonorProfiles.block(db, addr, { adminId: req.user.user_id, ip: req.ip, reason: (req.body || {}).reason });
      if (!r.ok) {
        if (r.code === 'not_found') return res.status(404).json({ error: 'This address has never mined here', reason: 'not_found' });
        return donorAdminRefuse(res, r);
      }
      res.json({ success: true, grin_address: addr, blocked: true, withdrawn: r.withdrawn });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/donors/:addr/unblock', freshAdmin, (req, res) => {
    try {
      const addr = String(req.params.addr || '').trim();
      if (!GRIN_ADDR_RE.test(addr)) return res.status(400).json({ error: 'Not a well-formed Grin address' });
      const r = DonorProfiles.unblock(db, addr, { adminId: req.user.user_id, ip: req.ip });
      if (!r.ok) return donorAdminRefuse(res, r);
      res.json({ success: true, grin_address: addr, blocked: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Donor NAMES (design §19.17.6, Part C4) ─────────────────────────────────────────────────
  // Names are checked automatically and live at once, so the operator's surface is a LIST with
  // post-moderation, not a queue: remove (POST /api/admin/donors/:addr/remove {kind:'name'},
  // above), ban a name (every spelling, every holder), block a donor (above). Same tiers as the
  // rest of the donor admin: secureAdmin reads, freshAdmin (step-up) writes, each write's audit
  // row inside its transaction in the lib.

  // ?state=live (default) | removed, ?q= an address start or a name fragment (matched on the
  // matching form, so `sh1t` finds "Shit"). Live rows carry `hit` — what the rule says TODAY, so
  // a word added after a name went live shows as a hint — `banned`, `same_as` (pre-C4 approved
  // names may collide) and `blocked`.
  router.get('/api/admin/donors/names', secureAdmin, (req, res) => {
    try {
      const r = DonorProfiles.adminNames(db, {
        state: req.query.state, q: typeof req.query.q === 'string' ? req.query.q : '', rule: donorNameRule()
      });
      if (!r.ok) return donorAdminRefuse(res, r);
      res.json({ success: true, state: r.state, total: r.total, names: r.rows, change_days: DonorProfiles.NAME_CHANGE_DAYS });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/admin/donors/banned-names', secureAdmin, (req, res) => {
    try {
      res.json({ success: true, banned: DonorProfiles.bannedNames(db) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Ban a name: its matching form goes on the list (no spelling of it can be set again) and every
  // live holder loses it now — the reason is shown to them, as for a remove.
  router.post('/api/admin/donors/banned-names', freshAdmin, (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.name !== 'string') return donorAdminRefuse(res, { code: 'bad_name' });
      const r = DonorProfiles.banName(db, body.name, { adminId: req.user.user_id, ip: req.ip, reason: body.reason });
      if (!r.ok) return donorAdminRefuse(res, r);
      res.json({ success: true, norm: r.norm, removed: r.removed.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Lift a ban. Nothing comes back: a removed name stays removed.
  router.post('/api/admin/donors/banned-names/:norm/unban', freshAdmin, (req, res) => {
    try {
      const r = DonorProfiles.unbanName(db, req.params.norm, { adminId: req.user.user_id, ip: req.ip });
      if (!r.ok) return donorAdminRefuse(res, r);
      res.json({ success: true, norm: r.norm });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
