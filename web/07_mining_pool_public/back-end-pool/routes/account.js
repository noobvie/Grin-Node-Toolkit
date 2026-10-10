// /api/account/* — the address-as-identity miner surface: public reads (summary, shares,
// workers, hashrate, ledger, payout history, earnings, Tor check) and the owner-proof-gated
// writes (payouts, payment proofs, Goblin destination, donor profile).
// Moved verbatim out of routes/index.js (code-layout refactor P5); registrations stay at 2-space
// indent and write FULL paths. Instances/state come from ctx. The `/api/account` address shape
// gate (app.use) stays in routes/index.js, mounted before this file (H7).

const express = require('express');
const multer = require('multer');
const { getHorizon: getLedgerRollupHorizon } = require('../lib/ledger-rollup');
const { donorSettings } = require('../lib/donor-names');
const { lastDonatedAt: donorLastDonatedAt, liveDonations: donorLiveDonations,
        leagueRank: donorLeagueRank, NO_LIVE: DONOR_NO_LIVE } = require('../lib/donor-ledger');
const DonorProfiles = require('../lib/donor-profiles');
const { parseDonateToken } = require('../lib/stratum-protocol');
const { verifyOwnerProof, auditOwnerProof, normalizeIp, PROOF_SET_MAX } = require('../lib/owner-proof');

module.exports = function createAccountRoutes(ctx) {
  const {
    config, db, donorNameRule, dormancyManager, hashrateTracker, incentivesManager, minerManager,
    nostrBridge, poolSettings, rateLimiter, shareValidator, uploadsDir, walletTor, withdrawalScheduler
  } = ctx;
  const router = express.Router();

  router.get('/api/account/:addr/shares', rateLimiter.middleware('public'), (req, res) => {
    try {
      const { addr } = req.params;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      const shares = shareValidator.getSharesForMiner(addr, limit, offset);
      res.json(shares);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // REMOVED (2026-07-28): GET /api/account/:addr/balance — every field it returned
  // (balance, balance_locked, their sum) is already in GET /api/account/:addr, which is what
  // the account page actually calls. Nothing in public_html/ or the admin panel referenced it.
  // A second, undocumented way to read the same number is one more surface to keep honest.


  // ─── Account summary (address-as-identity; no auth) ─────────────────────────
  // One-stop public view for a miner address: balances + lifetime paid + pending
  // withdrawal + share/hashrate snapshot. 404 if the address has never mined here.
  router.get('/api/account/:addr', rateLimiter.middleware('public'), (req, res) => {
    try {
      const { addr } = req.params;
      const acct = db.prepare(
        `SELECT grin_address, balance, balance_locked, is_online, last_seen_at, created_at,
                pass_proof_state, nostr_username, nostr_npub, nostr_registered_at
         FROM miner_accounts WHERE grin_address = ?`
      ).get(addr);
      if (!acct) return res.status(404).json({ error: 'Account not found' });

      // Ownership-proof set (design §17.2 #7) — COUNTS ONLY. Never a value, never a hash,
      // never proof_salt, and never a per-row timestamp: one row's capture time published
      // next to an address rebuilds the (address, origin, time) linkage the hashing exists to
      // remove. `live` counts live rows; `has_anchor` covers the write-once original even
      // once it has been evicted, because it still verifies (as slot 'anchor') and so still
      // means "this address can reach its own wallet".
      const proofAgg = db.prepare(
        `SELECT kind,
                SUM(CASE WHEN evicted_at IS NULL THEN 1 ELSE 0 END) AS live,
                MAX(CASE WHEN evicted_at IS NULL THEN first_seen_at END) AS newest,
                MAX(is_anchor) AS has_anchor
           FROM miner_proofs
          WHERE grin_address = ?
          GROUP BY kind`
      ).all(addr);
      const proofOf = (k) => proofAgg.find((r) => r.kind === k) || { live: 0, newest: null, has_anchor: 0 };
      const ipSet = proofOf('ip');
      const passSet = proofOf('pass');
      const proofs = {
        ip: ipSet.live || 0,
        pass: passSet.live || 0,
        max: PROOF_SET_MAX,
        anchor: !!(ipSet.has_anchor || passSet.has_anchor),
        // Newest first_seen_at across BOTH kinds — the page renders it as "last added", which
        // is what a miner checks after moving a rig. first_seen_at never moves, so a rig
        // reconnecting from a known IP does not bump this.
        last_added_at: [ipSet.newest, passSet.newest]
          .filter((t) => t !== null && t !== undefined)
          .reduce((a, b) => (a === null ? b : Math.max(a, b)), null)
      };

      // Lifetime withdrawals actually paid (confirmed only): total amount + how many.
      const paidAgg = db.prepare(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total FROM withdrawals
         WHERE grin_address = ? AND status = 'confirmed'`
      ).get(addr);
      const paid = paidAgg.total;

      // Pending set must match the scheduler's one-pending-per-address cap (which includes
      // slatepack_pending and tor_held) — otherwise the UI shows 0 pending while a new request
      // would 429. The full row is exposed so the account page can show its status. (No public
      // cancel — a Tor payout is tried once and settles or is Held; slatepack expires on TTL.)
      // retry_count / next_retry_at / retry_reason only mean something on a LEGACY retry_scheduled
      // row until the startup migration settles it.
      const pendingRow = db.prepare(
        `SELECT id, amount, method, status, retry_count, next_retry_at, retry_reason, created_at
         FROM withdrawals
         WHERE grin_address = ? AND status IN ('tor_checking','tor_sending','tor_held','retry_scheduled','slatepack_pending','finalizing')
         ORDER BY created_at DESC LIMIT 1`
      ).get(addr);
      const pending = db.prepare(
        `SELECT COUNT(*) AS c FROM withdrawals
         WHERE grin_address = ? AND status IN ('tor_checking','tor_sending','tor_held','retry_scheduled','slatepack_pending','finalizing')`
      ).get(addr).c;
      // The Tor pause for this address (counts and a timestamp only) — the Tor pane shows "N of 5"
      // and, when paused, the UTC end time. Guarded like the blocks below: a failure degrades one
      // advisory field, never the money page.
      const torPause = (() => {
        try { return withdrawalScheduler ? withdrawalScheduler.torPauseStatus(acct.grin_address) : null; }
        catch (e) { return null; }
      })();
      // A slatepack-pending row expires on the scheduler's clock (manual rail vs Goblin differ);
      // tell the page when, so the miner sees a deadline rather than discovering it on a 409.
      if (pendingRow && pendingRow.status === 'slatepack_pending' && withdrawalScheduler) {
        const ttl = pendingRow.method === 'nostr'
          ? withdrawalScheduler.nostrPendingTtlSeconds : withdrawalScheduler.slatepackTtlSeconds;
        pendingRow.expires_at = Number(pendingRow.created_at) + ttl;
      }

      const shareAgg = db.prepare(
        `SELECT COUNT(*) AS count, MAX(created_at) AS last_share_at FROM shares WHERE grin_address = ?`
      ).get(addr);

      // Blocks this address found (block-finder attribution) — orphaned ones didn't stick,
      // so they don't count. Vanity stat only; rewards are PPLNS, not finder-take-all.
      const blocksFound = db.prepare(
        `SELECT COUNT(*) AS c FROM blocks WHERE found_by = ? AND status != 'orphaned'`
      ).get(addr).c;

      const hr = hashrateTracker.getMinerHashrate(addr, 60) || {};

      // Live donation reading for this address (design §18.3). Guarded on its own: it reads
      // pool_config, and the account page is the miner's money UI — a settings hiccup must
      // degrade one advisory row, never 500 the whole summary.
      const donation = (() => {
        const off = (rigsOnline) => ({ rigs_donating: 0, rigs_online: rigsOnline, pct_min: 0, pct_max: 0, workers: [] });
        try {
          const sessions = minerManager
            ? minerManager.getActiveSessions().filter((sess) => sess.grinAddress === acct.grin_address)
            : [];
          const lv = donorLiveDonations(sessions).get(acct.grin_address) || DONOR_NO_LIVE;
          if (!incentivesManager || !incentivesManager.donationsActive()) return off(lv.rigs_online);
          return {
            rigs_donating: lv.rigs_donating,
            rigs_online: lv.rigs_online,
            pct_min: lv.pct_min,
            pct_max: lv.pct_max,
            workers: lv.donating_workers.map((w) => ({ name: w.name, percent: w.percent }))
          };
        } catch (e) { return off(0); }
      })();

      // Donor profile (design §18.6) — the donor's OWN view of their nickname + banner requests.
      // This page is public to anyone holding the address, so profileFor() never returns the
      // pending name text, image bytes or who decided; a rejection reason IS shown (the admin UI
      // says so beside the field). Guarded on its own like the two blocks above: null on a
      // failure, never a 500 of the money page. slot_rank costs one ledger scan and only runs
      // for an address that has donated.
      const donorProfile = (() => {
        try {
          let active = false;
          try { active = !!(incentivesManager && incentivesManager.donationsActive()); } catch (_) { active = false; }
          const H = getLedgerRollupHorizon(db);
          const last = donorLastDonatedAt(db, acct.grin_address, H);
          const ds = donorSettings(poolSettings.getSection('incentives'), poolSettings.getSection('pool_info').pool_name);
          const slotRank = last !== null ? donorLeagueRank(db, acct.grin_address, { ds, H }) : null;
          return DonorProfiles.profileFor(db, acct.grin_address, { active, lastDonatedAt: last, slotRank, ds });
        } catch (e) { return null; }
      })();

      // Proof values are NOT exposed (they back the ownership gate; hashed at rest anyway) —
      // only whether one is on record, so the UI can hint which proof kinds will work.
      res.json({
        grin_address: acct.grin_address,
        balance: acct.balance,
        balance_locked: acct.balance_locked,
        total: acct.balance + acct.balance_locked,
        total_paid: paid,
        payouts_count: paidAgg.cnt || 0,
        blocks_found: blocksFound,
        pending_withdrawals: pending,
        pending_withdrawal: pendingRow || null,
        is_online: !!acct.is_online,
        last_seen_at: acct.last_seen_at || null,
        created_at: acct.created_at,
        shares: {
          count: shareAgg.count || 0,
          last_share_at: shareAgg.last_share_at || null
        },
        hashrate_gps: parseFloat(((hr.avg_hashrate || 0)).toFixed(6)),
        min_withdrawal: config.min_withdrawal,
        // Flat fee deducted from a payout — the account page shows the miner what they will
        // actually receive BEFORE they submit, so the net amount is never a surprise.
        withdrawal_fee: config.withdrawal_fee || 0,
        // Boolean only — the freeze REASON stays admin-side (it can reveal wallet trouble).
        payouts_frozen: withdrawalScheduler.isFrozen(),
        // Tor pause: { failures_24h, max, paused_until | null } — 5 counted failed Tor payouts in
        // 24 h pause Tor for 24 h from the 5th. Slatepack is never paused.
        tor_pause: torPause,
        // Minutes a Slatepack payout stays answerable — the terms the page states on its "Send as
        // Slatepack instead" offer. The ENFORCED value (the scheduler's, which expires_at uses),
        // a pool setting and not a wallet figure.
        slatepack_window_minutes: withdrawalScheduler ? Math.round(withdrawalScheduler.slatepackTtlSeconds / 60) : null,
        // Abandoned-balance countdown for THIS address (state: active|idle|counting|eligible|
        // disposed|no_balance). Drives the account-page dormancy notice + reclaim CTA.
        dormancy: dormancyManager ? dormancyManager.statusFor(acct.grin_address) : null,
        has_recorded_ip: !!(ipSet.live || ipSet.has_anchor),
        has_recorded_pass: !!(passSet.live || passSet.has_anchor),
        // How many mining IPs and rig passwords are on record for this address, against the
        // cap (design §17.2 #7). Replaced the `evidence` object, which reported WHEN a proof
        // last changed so the page could warn about it: with ten slots per kind a second site
        // no longer pushes the first one out, so a new value beside the old ones is ordinary
        // operation, not an alarm. What a miner actually needs is the count — "are all three
        // of my rigs on record?" — and when one was last added.
        proofs,
        // Who on this address is donating RIGHT NOW (design §18.3): a `donateN` tag on a rig
        // donates that % of what that rig's shares earn (lib/rewards.js, per share). A number
        // the pool acts on to reduce someone's earnings has to be readable by that someone
        // (audit §J3-5), and since the tag is per RIG the reading is too — `workers` names the
        // donating rigs. Zeros while the operator has donations off (nothing moves).
        // The v1 aliases `donation_percent` (= pct_max) and `donor_name` / `donor_name_state`
        // were dropped by §18 Part 5 once the account page read `donation` and `donor_profile`
        // instead, as §18.3 planned. They were read by no other page.
        donation: donation,
        // Design §18.6 — the pre-moderated nickname + banner (see donorProfile above).
        donor_profile: donorProfile,
        // Password-proof diagnostics — why the gate will or won't accept a rig password.
        //   state — the LAST-SEEN login's verdict ('ok' | 'none' | a reject code). Persisted.
        //   live  — cross-rig consistency among CURRENTLY CONNECTED sessions (counts only).
        // Both are deliberately public (the page is address-addressable with no login). A
        // non-compliant password can never be accepted as proof, so telling a visitor it is
        // short or a factory default reveals only that a door they can't open is shut — while
        // hiding it would hide the warning from the one person who needs it.
        password_proof: {
          state: acct.pass_proof_state || null,
          live: minerManager ? minerManager.getPasswordConsistency(acct.grin_address) : null
        },
        // Goblin/Nostr payout rail (design §15). Destination npub is NOT exposed (it's the
        // pinned secret-ish anchor); only the display username + cooldown state, so the UI
        // can show "pending / active at <UTC>". active = past the security cooldown.
        nostr_payouts_enabled: !!(nostrBridge && nostrBridge.isEnabled()),
        nostr_destination: acct.nostr_npub ? {
          username: acct.nostr_username,
          registered_at: acct.nostr_registered_at,
          active_at: acct.nostr_registered_at +
            (config.nostr_destination_cooldown_hours !== undefined ? config.nostr_destination_cooldown_hours : 48) * 3600,
          active: Math.floor(Date.now() / 1000) >=
            acct.nostr_registered_at +
            (config.nostr_destination_cooldown_hours !== undefined ? config.nostr_destination_cooldown_hours : 48) * 3600,
        } : null
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-worker breakdown for an address. Hashrate/share-count/last-share from the SHARES table
  // (all regions, survives restarts); reject%/stale% + online from the live in-memory stratum
  // sessions. Under Model C every region's miners terminate their session here, so reject/stale
  // is complete pool-wide (it is still live-only, so it resets on a worker disconnect).
  router.get('/api/account/:addr/workers', rateLimiter.middleware('public'), (req, res) => {
    try {
      const { addr } = req.params;
      const windowMin = Math.min(Math.max(parseInt(req.query.window, 10) || 10, 1), 1440);
      const workers = hashrateTracker.getWorkersForAccount(addr, windowMin);
      // Per-rig donation tag (design §18.3): the % this rig's shares donate, read from its name
      // with the same parser rewards.js uses per share; null = untagged, and null for every rig
      // while the operator has donations off (a tag then moves nothing).
      let donationsOn = false;
      try { donationsOn = !!(incentivesManager && incentivesManager.donationsActive()); } catch (_) { donationsOn = false; }
      for (const w of (workers || [])) {
        const t = donationsOn ? parseDonateToken(w.worker_name) : null;
        w.donate_percent = t ? t.percent : null;
      }
      res.json({ grin_address: addr, window_min: windowMin, workers });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-address hashrate time-series for charting (downsampled to ~maxPoints buckets).
  router.get('/api/account/:addr/hashrate/history', rateLimiter.middleware('public'), (req, res) => {
    try {
      const { addr } = req.params;
      const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 720);
      const series = hashrateTracker.getAccountHistory(addr, hours);
      res.json({ grin_address: addr, hours, series });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // REMOVED (2026-07-17): POST /api/account/:addr/min-payout — the per-account payout threshold
  // was an auto-payout-era relic. Withdrawals are miner-initiated with an explicit amount, so
  // only the pool-wide config.min_withdrawal floor applies (enforced in withdrawal-scheduler).
  // The miner_accounts.min_payout column stays in the schema but is read by nothing.


  // Append-only ledger for an address (every balance/locked change). No auth — the
  // ledger only exposes the address's own money movements, and the address is identity.
  // Filters: ?direction=in|out splits the ledger by movement of the SPENDABLE balance — the
  // figure the "balance after" column shows. ?days=30|90|365 bounds the window (default: all
  // history). ?format=csv streams the filtered window as a CSV download (row-capped, rate-limited).
  //
  // A scheduler payout touches the ledger two or three times: the 'lock' at request (spendable
  // → locked), then EITHER the settling 'debit' pair at confirm (locked → gone, net +
  // withdrawal_fee) OR a 'reversal' (locked → spendable) when it fails, expires or is cancelled.
  // Only the lock and the reversal move the spendable balance, so those two are the legs shown:
  //   in  = credits + payout reversals (the money coming back)
  //   out = payout LOCKS (the full gross amount, fee included) + debits that draw on spendable
  //         (donations, dormant sweep, admin manual payout) + non-payout reversals (clawbacks)
  // The settling debits are neutral here — they only drain `balance_locked`, which the lock
  // already showed leaving. Until 2026-09-24 this was inverted (the lock hidden, the settling
  // debit shown): a payout that SUCCEEDED balanced by luck, but one that FAILED showed only its
  // return, so Σ in outran Σ out by every failed payout and the balance looked unexplained.
  // Discriminator: a settling 'withdrawal' debit is the only debit that lowers balance_locked
  // (_releaseLockAndDebit); the admin manual payout's debit leaves it equal. 'withdrawal_fee'
  // debits are written ONLY by _releaseLockAndDebit, so they are always settling.
  const LEDGER_DIRECTION_SQL = {
    in: `(event_type = 'credit' OR (event_type = 'reversal' AND reference_type = 'withdrawal'))`,
    out: `((event_type = 'lock' AND reference_type = 'withdrawal')
           OR (event_type = 'debit' AND reference_type != 'withdrawal_fee'
               AND NOT (reference_type = 'withdrawal' AND locked_after < locked_before))
           OR (event_type = 'reversal' AND reference_type != 'withdrawal'))`
  };
  router.get('/api/account/:addr/balance/log', rateLimiter.middleware('public'), (req, res) => {
    try {
      const { addr } = req.params;
      // hasOwn, not a truthiness test on the index (audit §J3-7): a bare object literal
      // resolves `constructor` / `toString` / `hasOwnProperty` through Object.prototype, so
      // `?direction=constructor` passed the guard and spliced a native function's SOURCE into
      // the WHERE clause below. Harmless today — the attacker cannot influence that text and
      // SQLite rejects it — but it is a free 500 that echoes part of the query, and it is a
      // dynamic SQL fragment chosen by an unguarded object index, which is one prototype-
      // polluting path away from being the real thing. Same shape as §J1-6.
      const direction = Object.hasOwn(LEDGER_DIRECTION_SQL, req.query.direction) ? req.query.direction : null;
      const days = parseInt(req.query.days || 0);
      const cutoff = (days > 0) ? Math.floor(Date.now() / 1000) - Math.min(days, 3650) * 86400 : 0;
      const where = `grin_address = ? AND created_at >= ?` +
        (direction ? ` AND ${LEDGER_DIRECTION_SQL[direction]}` : '');

      if (req.query.format === 'csv') {
        // Same dedicated export throttle as the withdrawal-history CSV (anti download-spam).
        const gate = rateLimiter.peek('export', req);
        if (!gate.allowed) return rateLimiter.sendLimited(res, gate);
        rateLimiter.consume('export', req);

        const CSV_MAX_ROWS = 50000;
        const rows = db.prepare(
          `SELECT event_type, reference_type, reference_id, amount, balance_after, created_at
           FROM balance_log WHERE ${where}
           ORDER BY created_at DESC, id DESC LIMIT ${CSV_MAX_ROWS}`
        ).all(addr, cutoff);
        const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
        const lines = ['created_at_utc,event_type,reference_type,reference_id,amount,balance_after'];
        for (const r of rows) {
          lines.push([
            new Date(r.created_at * 1000).toISOString(),
            esc(r.event_type), esc(r.reference_type), r.reference_id,
            r.amount, r.balance_after
          ].join(','));
        }
        const tag = direction || 'all';
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition',
          `attachment; filename="pool-ledger-${tag}-${addr.slice(0, 12)}-${days > 0 ? days + 'd' : 'all'}.csv"`);
        return res.send(lines.join('\n') + '\n');
      }

      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const total = db.prepare(`SELECT COUNT(*) AS c FROM balance_log WHERE ${where}`).get(addr, cutoff).c;
      // payout_method: the rail of a payout row ('tor' | 'slatepack' | 'nostr' | 'manual'), so the
      // ledger can say "payout returned · Tor". A subquery, not a JOIN: `where` and the direction
      // SQL name grin_address / created_at unqualified, and withdrawals has both. Public already —
      // GET …/withdrawals returns the same method per payout.
      const rows = db.prepare(
        `SELECT event_type, amount, balance_before, balance_after, locked_before, locked_after,
                reference_type, reference_id, created_at,
                CASE WHEN reference_type = 'withdrawal' THEN
                  (SELECT w.method FROM withdrawals w
                    WHERE w.id = balance_log.reference_id AND w.grin_address = balance_log.grin_address)
                END AS payout_method
         FROM balance_log WHERE ${where}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      ).all(addr, cutoff, limit, offset);
      res.json({ grin_address: addr, direction, total, count: rows.length, log: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Withdrawal (payout) history for an address — sourced from the `withdrawals` table, which
  // (unlike balance_log, whose raw rows are pruned after ~60 days) is kept forever, so this is
  // the durable record a miner can export for accounting. Payout-only: no donations or orphan
  // clawbacks. Public like the rest of the account page (the address is identity). ?format=csv
  // streams the full all-time history (row-capped, rate-limited); no ?days window by design.
  router.get('/api/account/:addr/withdrawals', rateLimiter.middleware('public'), (req, res) => {
    try {
      const { addr } = req.params;

      if (req.query.format === 'csv') {
        // Tight, dedicated throttle on the all-time bulk export (separate from the loose
        // `public` bucket) — one-click use is fine, download-spam is cut off after a few hits.
        const gate = rateLimiter.peek('export', req);
        if (!gate.allowed) return rateLimiter.sendLimited(res, gate);
        rateLimiter.consume('export', req);

        const CSV_MAX_ROWS = 50000;
        const rows = db.prepare(
          `SELECT id, amount, fee_charged, method, status, created_at, confirmed_at, kernel_excess
           FROM withdrawals WHERE grin_address = ?
           ORDER BY created_at DESC, id DESC LIMIT ${CSV_MAX_ROWS}`
        ).all(addr);
        const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
        // `kernel_excess` REPLACED by a yes/no flag (audit §J11-2). This export is 50,000 rows,
        // all-time, unauthenticated, for ANY address — the single cheapest way to build the
        // address→on-chain-transaction map the pool must not publish. The kernels themselves
        // now come from POST /api/account/:addr/withdrawals/proofs, behind the same ownership
        // proof a withdrawal needs. The flag stays so an accounting export still says which
        // payouts HAVE a proof to fetch.
        // The miner's own terms, not the pool's costs (2026-10-05): `withdrawal_fee` is the flat
        // fee they were charged and `received` what reached their wallet. The REAL on-chain fee
        // (withdrawals.fee) is the pool's expense, paid from the pool wallet — it used to sit in
        // a `fee` column here and read as a second, smaller fee contradicting the one charged.
        // Both are blank unless the payout was paid: a failed or expired one charged nothing.
        const lines = ['id,requested_at_utc,confirmed_at_utc,method,status,amount,withdrawal_fee,received,has_kernel_proof'];
        for (const r of rows) {
          const paid = r.status === 'confirmed';
          const feeC = Number(r.fee_charged) || 0;
          lines.push([
            r.id,
            new Date(r.created_at * 1000).toISOString(),
            r.confirmed_at ? new Date(r.confirmed_at * 1000).toISOString() : '',
            esc(r.method), esc(r.status), r.amount,
            paid ? feeC : '', paid ? parseFloat((Number(r.amount) - feeC).toFixed(9)) : '',
            r.kernel_excess ? 'yes' : 'no'
          ].join(','));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition',
          `attachment; filename="pool-withdrawals-${addr.slice(0, 12)}-all.csv"`);
        return res.send(lines.join('\n') + '\n');
      }

      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const total = db.prepare(
        `SELECT COUNT(*) AS c FROM withdrawals WHERE grin_address = ?`
      ).get(addr).c;
      // `kernel_excess` is NOT in this response (audit §J11-2) — `has_kernel_proof` replaces it,
      // so the account page can render the Proof column's affordance without the value. The
      // value itself needs an ownership proof; see the route directly below.
      // Same treatment for the signed payment proof: it names the miner's address AND the
      // kernel in one signed document, so it is at least as linking as the kernel. Rows carry
      // has_payment_proof only; the proof itself comes from the ownership-gated route below.
      // fail_code (a public-safe enum: why a Tor payout failed) is returned; fail_detail — the CLI
      // error behind it, which can carry pool-wallet figures — is admin-only and never selected here.
      // fee_charged = the flat withdrawal fee the miner pays (the account page's "Withdrawal fee"
      // column); fee = the REAL on-chain fee the pool wallet paid, kept for API compatibility but
      // no longer shown to the miner — it is the pool's cost, not theirs.
      const rows = db.prepare(
        `SELECT id, amount, fee, fee_charged, method, status, fail_code, created_at, confirmed_at, kernel_excess, payment_proof
         FROM withdrawals WHERE grin_address = ?
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      ).all(addr, limit, offset).map((r) => {
        const { kernel_excess, ...rest } = r;
        const { payment_proof, ...pub } = rest;
        return { ...pub, has_kernel_proof: !!kernel_excess, has_payment_proof: !!payment_proof };
      });
      res.json({ grin_address: addr, total, count: rows.length, withdrawals: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── On-chain payment proofs for THIS address (ownership-gated) ─────────────
  // The other half of §J11-2. Grin has no txid; the payment-proof primitive is the kernel
  // excess, and `withdrawals.kernel_excess` exists so a miner can verify their own payout on a
  // chain explorer. That is a real feature and it stays — but it was readable, all-time and in
  // bulk, for ANY address by anyone, which on a privacy coin is a public
  // address ↔ on-chain-transaction index. Nothing else the pool publishes is as durable: a
  // balance changes, a kernel is in the chain forever.
  //
  // So the kernel is now the ONE field on the account page that costs an ownership proof — the
  // same proof (recent mining IP or rig password) a withdrawal needs, verified by the same
  // function, audited on both paths, and on the same `withdraw` bucket. It is a POST because
  // the proof travels in a body, never in a URL that lands in an access log.
  //
  // Deliberately NOT on the loose `public` bucket: verifyOwnerProof runs scrypt (16 MB), so a
  // public-bucket proof endpoint is a CPU lever — that is §F2, and this route must not re-open it.
  router.post('/api/account/:addr/withdrawals/proofs', rateLimiter.middleware('withdraw'), async (req, res) => {
    try {
      const { addr } = req.params;
      const reqIp = normalizeIp(req.ip);
      const submitted = (req.body && (req.body.proof || req.body.ip_proof)) || '';

      // Account-existence check first, matching its GET sibling: an address that never mined
      // here is "not found" whether or not a proof was supplied, so this adds no new signal.
      const acct = db.prepare('SELECT 1 AS x FROM miner_accounts WHERE grin_address = ?').get(addr);
      if (!acct) return res.status(404).json({ error: 'Account not found' });

      const proof = await verifyOwnerProof(db, addr, submitted, reqIp);
      if (!proof.ok) {
        auditOwnerProof(db, { action: 'kernel_proofs', grinAddress: addr, ip: reqIp, ok: false, details: { reason: proof.reason } });
        return res.status(403).json({ error: 'Ownership proof failed', reason: proof.reason });
      }
      auditOwnerProof(db, { action: 'kernel_proofs', grinAddress: addr, ip: reqIp, ok: true, details: { proof_method: proof.method } });

      // Only rows that actually carry a kernel. Keyed by withdrawal id so the client can merge
      // them into the table it already has without re-fetching it.
      const rows = db.prepare(
        `SELECT id, kernel_excess FROM withdrawals
         WHERE grin_address = ? AND kernel_excess IS NOT NULL AND kernel_excess != ''`
      ).all(addr);
      const proofs = {};
      for (const r of rows) proofs[r.id] = r.kernel_excess;

      // Signed payment proofs, behind the same single proof so a miner reveals everything in
      // one press. Served from the DB only — this route never touches the wallet, so it cannot
      // be turned into a wallet-load lever no matter how many payouts an address has. Bounded to
      // the newest 500 (each is ~600 bytes); older ones are still on the operator's side.
      const payment_proofs = {};
      const withProof = db.prepare(
        `SELECT id, payment_proof FROM withdrawals
         WHERE grin_address = ? AND payment_proof IS NOT NULL AND payment_proof != ''
         ORDER BY id DESC LIMIT 500`
      ).all(addr);
      for (const r of withProof) {
        try { payment_proofs[r.id] = JSON.parse(r.payment_proof); } catch (_) { /* skip a bad row, never fail the reveal */ }
      }
      res.json({ grin_address: addr, count: rows.length, proofs, payment_proof_count: withProof.length, payment_proofs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Credited earnings summed per period (block rewards + bonuses/giveaways), plus the 30-day
  // outflow total — drives the account page's earnings table and the ledger Σ titles. Reads RAW
  // balance_log, which retention DOES prune (database.balance_log_keep_days, default 60 with a
  // hard 45-day floor) — that floor is why the longest period here is 30 days. A longer one
  // would have to read the balance_log_daily rollup too, the way /api/pool/donors does.
  router.get('/api/account/:addr/earnings', rateLimiter.middleware('public'), (req, res) => {
    try {
      const { addr } = req.params;
      const now = Math.floor(Date.now() / 1000);
      // Earnings = true credits only. A payout reversal is "money in" for the ledger card but
      // NOT earnings — counting it would inflate the table every time a payout is cancelled.
      const sums = db.prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN created_at > ? THEN amount END), 0) AS h1,
           COALESCE(SUM(CASE WHEN created_at > ? THEN amount END), 0) AS h24,
           COALESCE(SUM(CASE WHEN created_at > ? THEN amount END), 0) AS d7,
           COALESCE(SUM(CASE WHEN created_at > ? THEN amount END), 0) AS d30
         FROM balance_log
         WHERE grin_address = ? AND event_type = 'credit'`
      ).get(now - 3600, now - 86400, now - 7 * 86400, now - 30 * 86400, addr);
      const in30 = db.prepare(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM balance_log
         WHERE grin_address = ? AND created_at > ? AND ${LEDGER_DIRECTION_SQL.in}`
      ).get(addr, now - 30 * 86400).s;
      const out30 = db.prepare(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM balance_log
         WHERE grin_address = ? AND created_at > ? AND ${LEDGER_DIRECTION_SQL.out}`
      ).get(addr, now - 30 * 86400).s;
      res.json({ grin_address: addr, periods: sums, in_30d: in30, out_30d: out30 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Is this miner reachable over Tor right now? Drives the UI hint for whether an
  // auto (Tor) payout can succeed vs. needing a Slatepack claim. No state change.
  // ─── Tor reachability probe cache ───────────────────────────────────────────
  // probeToronlineStatus builds a fresh Tor circuit per attempt and POSTs check_version down it
  // (up to torCheckRetries attempts × connect + reply timeouts — ~32 s worst case at the
  // defaults), so an uncached public endpoint turns one cheap HTTP request into seconds of
  // outbound work. The answer barely changes minute to minute — a wallet listener is either up
  // or it isn't — so a short cache costs the miner nothing and makes repeat clicks free.
  //
  // `?fresh=1` (the page's "Check" button) re-probes instead of serving the cache — the miner
  // who has just started a listener must not be shown the ✗ from a minute ago — but ONLY once
  // the cached answer is TOR_PROBE_FRESH_FLOOR_MS old. The floor stops a click-spammer turning
  // the cache off; the `torcheck` rate bucket still applies to every request, fresh or not, and
  // a fresh request still joins an in-flight probe rather than starting a second one.
  //
  // DELIBERATELY NOT used by the withdraw pre-flight gate. That one is a money decision (it can
  // refuse a payout), so it always takes a fresh probe: a 60s-stale "offline" must never block a
  // listener the miner just started. Caching a UI hint and caching a gate are different calls.
  const TOR_PROBE_TTL_MS = 60000;
  const TOR_PROBE_FRESH_FLOOR_MS = 10000;    // ?fresh=1 cannot re-probe an answer younger than this
  const TOR_PROBE_MAX = 500;                 // bound the map — this is a cache, not a registry
  const torProbeCache = new Map();           // addr -> { at, result }
  const torProbeInflight = new Map();        // addr -> Promise (collapses concurrent probes)

  const torProbeCached = async (addr, fresh = false) => {
    const hit = torProbeCache.get(addr);
    const ttl = fresh ? TOR_PROBE_FRESH_FLOOR_MS : TOR_PROBE_TTL_MS;
    if (hit && (Date.now() - hit.at) < ttl) return hit.result;

    // Rapid repeat clicks are exactly what this endpoint sees, and they arrive before the first
    // probe resolves — so dedup in-flight too, or the cache never gets the chance to help.
    const inflight = torProbeInflight.get(addr);
    if (inflight) return inflight;

    const p = (async () => {
      try {
        const result = await walletTor.probeToronlineStatus(addr);
        const now = Date.now();
        if (torProbeCache.size >= TOR_PROBE_MAX) {
          for (const [k, v] of torProbeCache) {
            if ((now - v.at) >= TOR_PROBE_TTL_MS) torProbeCache.delete(k);
          }
          // Still full → everything is live; drop the oldest insert (Map keeps insertion order)
          // so a sweep across distinct addresses can never grow this without bound.
          if (torProbeCache.size >= TOR_PROBE_MAX) {
            torProbeCache.delete(torProbeCache.keys().next().value);
          }
        }
        torProbeCache.set(addr, { at: now, result });
        return result;
      } finally {
        torProbeInflight.delete(addr);
      }
    })();
    torProbeInflight.set(addr, p);
    return p;
  };

  router.get('/api/account/:addr/tor-check', rateLimiter.middleware('torcheck'), async (req, res) => {
    try {
      const { addr } = req.params;
      // Must have actually mined here. Without this the endpoint was a public oracle: the onion
      // is derived from the bech32 address by pure math, so it answered "is this wallet listener
      // up right now?" for ANY Grin address — an activity side-channel on people who never opted
      // into this pool at all. The 404 matches GET /api/account/:addr exactly, so it reveals
      // nothing that endpoint doesn't already. For miners who ARE here the residual signal is
      // small: the pool already publishes their hashrate, which tracks activity far more closely.
      const known = db.prepare('SELECT 1 AS x FROM miner_accounts WHERE grin_address = ?').get(addr);
      if (!known) return res.status(404).json({ error: 'no mining account for this address' });

      const result = await torProbeCached(addr, req.query.fresh === '1');
      res.json({
        grin_address: addr,
        // Tri-state: true/false when known; null = this pool could not look (its own tor is
        // down or silent) — says nothing about the wallet, and the payout is still allowed
        // (the pre-flight gate fails open; grin-wallet is the authority at send).
        online: result.online === null ? null : !!result.online,
        reason: result.reason || (result.online ? 'reachable' : 'unreachable')
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Miner-initiated withdrawal (address-as-identity). Two rails, BOTH ownership-gated
  // (operator decision 2026-07-17 — "every money action goes behind the gate"): even though
  // neither rail can steal (Tor pays only to the address's own wallet; a slatepack is encrypted
  // to the address), an ungated trigger let anyone reading the public leaderboard force payouts
  // for other people's addresses — burning pool-paid network fees, consuming hot-wallet outputs
  // and force-moving coins the owner didn't ask to move. Proof = a recent mining IP (v4/v6) OR
  // the rig's stratum password (lib/owner-proof.js; single `proof` field, legacy `ip_proof`
  // still accepted). Rate-limited; CAS balance lock + 1-pending-per-address cap in the scheduler.
  router.post('/api/account/:addr/withdraw', rateLimiter.middleware('withdraw'), async (req, res) => {
    try {
      const { addr } = req.params;
      const method = (req.body && req.body.method) || 'tor';
      const reqIp = normalizeIp(req.ip);
      const submitted = (req.body && (req.body.proof || req.body.ip_proof)) || '';

      const proof = await verifyOwnerProof(db, addr, submitted, reqIp);
      if (!proof.ok) {
        auditOwnerProof(db, { action: `withdraw_${method}`, grinAddress: addr, ip: reqIp, ok: false, details: { reason: proof.reason } });
        return res.status(403).json({ error: 'Ownership proof failed', reason: proof.reason });
      }

      if (method === 'tor') {
        // Cheap admission checks FIRST — audit §J12-12. The pre-flight probe below builds up to
        // two fresh Tor circuits (≤~32 s worst case at the 8 s default), and it used to run
        // before any of this, so a miner holding one valid proof could force 20 circuit builds
        // a minute at the `withdraw`
        // bucket while every withdrawal they asked for would have been refused anyway. This is
        // an early refusal, not the gate: createWithdrawal repeats all of it authoritatively
        // inside its transaction, so the ordering change costs nothing and races nothing.
        //
        // It deliberately does NOT weaken the probe's freshness guarantee (index.js:3737): a
        // request that will actually create a withdrawal still takes a fresh probe.
        try {
          withdrawalScheduler.precheckWithdrawable(addr);
        } catch (e) {
          return res.status(e.code && e.code < 600 ? e.code : 400).json({ error: e.message });
        }

        // Tor pause (anti-abuse, 2026-09-26): 5 counted failed Tor payouts in 24 h pause Tor for this
        // address for 24 h from the 5th. Checked BEFORE the pre-flight probe, so a paused address
        // cannot make the pool build Tor circuits either; nothing is locked. Slatepack is not
        // paused — the page shows its offer beside the pause line. createWithdrawal checks again.
        const torPause = withdrawalScheduler.torPauseStatus(addr);
        if (torPause.paused_until) {
          auditOwnerProof(db, { action: 'withdraw_tor', grinAddress: addr, ip: reqIp, ok: false, details: { reason: 'tor_paused', paused_until: torPause.paused_until } });
          return res.status(429).json({
            error: 'tor_paused',
            message: `Tor payouts are paused for this address until ${new Date(torPause.paused_until * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC ` +
              `after ${torPause.max} failed attempts in 24 h. Slatepack is still available.`,
            paused_until: torPause.paused_until,
            failures_24h: torPause.failures_24h,
            max: torPause.max,
            suggest: 'slatepack'
          });
        }

        // "Another payment is ahead" (2026-10-05): other payouts hold the wallet's spendable coins,
        // so this one would fail at send. Refused here, before the probe and before any lock —
        // nothing is deducted, and the miner is told how many payments are ahead and how long.
        // Fails open on an unreadable wallet; the send-time NotEnoughFunds path stays the authority.
        try {
          await withdrawalScheduler.precheckWalletCover(addr, req.body && req.body.amount);
        } catch (e) {
          if (e.retry_after) res.set('Retry-After', String(e.retry_after));
          return res.status(e.code && e.code < 600 ? e.code : 503).json({ error: e.message, retry_after: e.retry_after || null });
        }

        // Pre-flight reachability gate (operator toggle, default ON). Refuse up front — BEFORE
        // any balance lock — if the miner's wallet listener isn't answering over Tor right now,
        // so the funds are never locked into a send that cannot land. The 409 body's
        // `tor_online: false` + `suggest: 'slatepack'` are what the page keys its Slatepack offer
        // on — keep both exactly. A refusal here is not counted toward the Tor pause. Only a CONFIDENT
        // offline (online === false) blocks; online === null (probe couldn't run) falls through
        // and lets grin-wallet be the authority at send, so a pool box without a working probe
        // never blocks every Tor payout.
        if (config.tor_preflight_gate !== false) {
          let reach = { online: null };
          try { reach = await walletTor.probeToronlineStatus(addr); }
          catch (e) { reach = { online: null, reason: `probe_error: ${e.message}` }; }
          // The requester may have LEFT while that ran. The probe can take ~32 s at the defaults
          // and nginx gives /api/ 30 s — past that it has already shown the browser a 504
          // ("Withdrawal failed") and closed our socket, but Express still runs this handler, so
          // it used to lock the balance and queue a payout the miner had just been told failed.
          // res.destroyed, NOT req.destroyed: Node ≥ 16 sets the latter for every request once
          // its body is read (scripts/test-payout-rails.js proves both). (Review fix, Part 5.)
          if (res.destroyed) {
            auditOwnerProof(db, { action: 'withdraw_tor', grinAddress: addr, ip: reqIp, ok: false, details: { reason: 'requester_gone', probe: reach.reason } });
            console.warn(`[tor-preflight] requester left during the probe (${reach.reason || 'unknown'}) — no withdrawal created`);
            return;
          }
          if (reach.online === null) {
            // Fail OPEN is deliberate (memory project_pool_tor_preflight_gate). It must not be
            // fail SILENT: neither the probe nor this route said anything when it could not run,
            // so an operator who switched the gate on had no way to learn it had been inert since
            // the tor daemon died / `socks` went missing (audit §J4-7).
            console.warn(
              `[tor-preflight] gate could not run (${reach.reason || 'unknown'}) — allowing the ` +
              `send; grin-wallet remains the authority at send time`
            );
          }
          if (reach.online === false) {
            auditOwnerProof(db, { action: 'withdraw_tor', grinAddress: addr, ip: reqIp, ok: false, details: { reason: 'tor_unreachable', probe: reach.reason } });
            return res.status(409).json({
              error: 'Your wallet is not reachable over Tor right now. Start your wallet listener and try again, or withdraw via Slatepack (which does not need your wallet online).',
              reason: reach.reason || 'tor_unreachable',
              tor_online: false,
              suggest: 'slatepack'
            });
          }
        }
        const result = withdrawalScheduler.createWithdrawal(addr, req.body && req.body.amount, method);
        auditOwnerProof(db, { action: 'withdraw_tor', grinAddress: addr, ip: reqIp, ok: true, details: { withdrawal_id: result.withdrawal_id, amount: result.amount, proof_method: proof.method } });
        return res.json({ success: true, withdrawal_id: result.withdrawal_id, status: 'tor_checking' });
      }

      if (method === 'slatepack') {
        const result = await withdrawalScheduler.createSlatepackWithdrawal(addr, req.body && req.body.amount);
        auditOwnerProof(db, { action: 'withdraw_slatepack', grinAddress: addr, ip: reqIp, ok: true, details: { withdrawal_id: result.withdrawal_id, amount: result.amount, proof_method: proof.method } });
        return res.json({ success: true, withdrawal_id: result.withdrawal_id, amount: result.amount, status: 'slatepack_pending', slatepack: result.slatepack, expires_at: result.expires_at });
      }

      if (method === 'nostr') {
        if (!nostrBridge || !nostrBridge.isEnabled()) return res.status(503).json({ error: 'nostr payouts are not enabled on this pool' });
        // The destination must be REGISTERED, aged past the cooldown, and still resolve to the
        // SAME npub it was pinned to (TOFU) — this is what stops a passed ownership gate from
        // redirecting funds to an attacker's account (design §15.2). All three are re-checked
        // here at send time, never trusting a username supplied in the request body.
        const dest = db.prepare(
          'SELECT nostr_username, nostr_npub, nostr_registered_at FROM miner_accounts WHERE grin_address = ?'
        ).get(addr);
        if (!dest || !dest.nostr_npub || !dest.nostr_registered_at) {
          return res.status(409).json({ error: 'no Goblin destination registered — add one first' });
        }
        const cooldownH = config.nostr_destination_cooldown_hours !== undefined ? config.nostr_destination_cooldown_hours : 48;
        const activeAt = dest.nostr_registered_at + cooldownH * 3600;
        const nowS = Math.floor(Date.now() / 1000);
        if (nowS < activeAt) {
          return res.status(409).json({ error: 'Goblin destination is still in its security cooldown', active_at: activeAt });
        }
        // TOFU re-pin: re-resolve the stored username and refuse if the npub changed.
        let resolved;
        try { resolved = await nostrBridge.resolveDestination(dest.nostr_username); }
        catch (e) { return res.status(e.code && e.code < 600 ? e.code : 502).json({ error: `could not verify Goblin destination: ${e.message}` }); }
        if (resolved.pubHex !== dest.nostr_npub) {
          auditOwnerProof(db, { action: 'withdraw_nostr', grinAddress: addr, ip: reqIp, ok: false, details: { reason: 'npub_changed', username: dest.nostr_username } });
          return res.status(409).json({ error: 'your Goblin username now points to a different key — re-register the destination (a fresh cooldown applies)' });
        }
        const result = await withdrawalScheduler.createNostrWithdrawal(
          addr, req.body && req.body.amount, dest.nostr_npub, `Grin mining payout — ${dest.nostr_username}`
        );
        auditOwnerProof(db, { action: 'withdraw_nostr', grinAddress: addr, ip: reqIp, ok: true, details: { withdrawal_id: result.withdrawal_id, amount: result.amount, proof_method: proof.method, username: dest.nostr_username } });
        return res.json({ success: true, withdrawal_id: result.withdrawal_id, amount: result.amount, status: 'slatepack_pending' });
      }

      return res.status(400).json({ error: `unsupported withdrawal method: ${method}` });
    } catch (err) {
      res.status(err.code && err.code >= 400 && err.code < 600 ? err.code : 500).json({ error: err.message });
    }
  });

  // Complete a slatepack withdrawal: the miner pastes back the RESPONSE slatepack their wallet
  // produced after `receive`. Ownership-gated like the trigger. The pool finalizes + broadcasts.
  router.post('/api/account/:addr/withdraw/:id/finalize', rateLimiter.middleware('withdraw'), async (req, res) => {
    try {
      const { addr, id } = req.params;
      const reqIp = normalizeIp(req.ip);
      const proof = await verifyOwnerProof(db, addr, (req.body && (req.body.proof || req.body.ip_proof)) || '', reqIp);
      if (!proof.ok) {
        auditOwnerProof(db, { action: 'slatepack_finalize', grinAddress: addr, ip: reqIp, ok: false, details: { reason: proof.reason, withdrawal_id: id } });
        return res.status(403).json({ error: 'Ownership proof failed', reason: proof.reason });
      }
      const result = await withdrawalScheduler.finalizeSlatepackWithdrawal(
        addr, parseInt(id, 10), (req.body && req.body.response_slatepack) || ''
      );
      auditOwnerProof(db, { action: 'slatepack_finalize', grinAddress: addr, ip: reqIp, ok: true, details: { withdrawal_id: id } });
      res.json(result);
    } catch (err) {
      res.status(err.code && err.code >= 400 && err.code < 600 ? err.code : 500).json({ error: err.message });
    }
  });

  // Show a pending slatepack payout's S1 again — the miner closed the tab, reloaded, or never
  // copied it. Before this, the S1 lived only in the create response, so a lost tab meant waiting
  // out the TTL and the post-reversal cooldown (~1 h) even when the wallet already held a valid
  // response. It moves no money and creates nothing: the SAME stored S1 is returned, never a new
  // slate, so re-fetching cannot double anything.
  //
  // Gated like every payout action (the stored S1 is encrypted to this address, so the gate is
  // consistency, not the only defence) and narrowed four ways in the SQL itself: this address's
  // row, the manual rail only (the Goblin rail's S1 is plain armor and is never stored), still
  // slatepack_pending (a settled/expired row is not served even if a copy lingered), and a stored
  // S1 present. Everything else is one 404 — the page cannot tell "not yours" from "gone", which
  // is all it needs. POST, not GET: the proof travels in the body, never in a URL or access log.
  router.post('/api/account/:addr/withdraw/:id/slatepack', rateLimiter.middleware('withdraw'), async (req, res) => {
    try {
      const { addr, id } = req.params;
      const reqIp = normalizeIp(req.ip);
      const wid = /^\d{1,15}$/.test(String(id)) ? Number(id) : 0;
      const proof = await verifyOwnerProof(db, addr, (req.body && (req.body.proof || req.body.ip_proof)) || '', reqIp);
      if (!proof.ok) {
        auditOwnerProof(db, { action: 'slatepack_reshow', grinAddress: addr, ip: reqIp, ok: false, details: { reason: proof.reason, withdrawal_id: wid || null } });
        return res.status(403).json({ error: 'Ownership proof failed', reason: proof.reason });
      }
      const row = wid ? db.prepare(
        `SELECT id, amount, created_at, slatepack_s1 FROM withdrawals
          WHERE id = ? AND grin_address = ? AND method = 'slatepack' AND status = 'slatepack_pending'`
      ).get(wid, addr) : null;
      if (!row || !row.slatepack_s1) {
        return res.status(404).json({ error: 'No slatepack is waiting for this payout — it may already be settled or expired. Refresh the page to see its status.' });
      }
      auditOwnerProof(db, { action: 'slatepack_reshow', grinAddress: addr, ip: reqIp, ok: true, details: { withdrawal_id: row.id, proof_method: proof.method } });
      // The S1 is per-payout and short-lived; keep it out of every cache between here and the tab.
      res.set('Cache-Control', 'no-store');
      res.json({
        success: true, withdrawal_id: row.id, amount: row.amount, slatepack: row.slatepack_s1,
        // Same clock the expiry sweep enforces (created_at + TTL), as on create.
        expires_at: withdrawalScheduler ? Number(row.created_at) + withdrawalScheduler.slatepackTtlSeconds : null
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Goblin/Nostr payout destination (design §15) ────────────────────────────
  // Register/replace the Goblin username funds may be sent to over Nostr. This does NOT move
  // funds — it stores the pinned destination and (re)starts the security cooldown.
  //
  // WHY THIS GATE IS STRICTER THAN A WITHDRAWAL. Tor pays the miner's OWN address and a
  // slatepack is encrypted TO it, so passing the ownership gate on those rails buys an
  // attacker nothing. Goblin pays a USERNAME — so this endpoint, not the withdraw endpoint,
  // is where money can be redirected. It therefore demands BOTH proofs (mining IP AND rig
  // password) where a withdrawal accepts either. The trade is deliberate: a miner with no
  // usable rig password cannot use the Goblin rail until they set one and mine again.
  //
  // Three layers sit behind this, each doing a different job: the AND-gate raises the bar to
  // get in; a DM to the PREVIOUS destination gives the real owner out-of-band detection; the
  // cooldown gives them time to act on it (withdraw via Tor, which an attacker cannot touch).
  // AND-gate + AGE-gate (audit §J3-1). The AND alone was never two factors: both legs are
  // written by ONE call on ONE accepted share
  // (lib/stratum-server.js recordOwnerEvidence), and anyone may mine to anyone's address —
  // so a stranger who pointed a rig at this address for a few seconds, with a password of
  // their choosing, held the mining IP AND the rig password and could re-point the payout.
  //
  // What actually separates the owner from that attacker is AGE: the owner's evidence has been
  // on record since they started mining, the attacker's was minted minutes ago. So each leg
  // must additionally have been captured at least `minAgeSec` ago — the destination cooldown,
  // the same window the operator already accepts as "long enough for the real owner to notice".
  // A miner whose IP has just changed is not locked out by this: their PREVIOUS IP is still in
  // the proof set with its own older timestamp, and submitting that one passes.
  //
  // An EVICTED anchor (slot 'anchor') is refused outright. It is unrevocable by construction (§J3-4), which is
  // exactly right for getting your own money to your own wallet and exactly wrong for changing
  // where the money goes — a leaked first-ever rig password must not be a permanent key to
  // somebody else's payout destination.
  //
  // PURPOSE (design §18.6, 2026-09-24). The same gate guards a donor-profile change, which speaks
  // for the address on a public page. `purpose` picks the WORDING only — the rules are identical
  // — so a donor is never told they are "changing a payout destination". The 'destination' texts
  // are the pre-§18 strings, unchanged byte for byte.
  const PROOF_PURPOSES = {
    destination: {
      required: 'to change a payout destination',
      aged: 'A payout destination can only be changed',
      harm: 're-pointing your payouts',
      anchor: 'changing a payout destination',
    },
    donor_profile: {
      required: 'to change your donor profile',
      aged: 'Your donor profile can only be changed',
      harm: 'putting words or images on the donor wall in your name',
      anchor: 'changing your donor profile',
    },
  };
  const requireBothProofs = async (addr, body, reqIp, action, purpose = 'destination') => {
    const words = PROOF_PURPOSES[purpose] || PROOF_PURPOSES.destination;
    const ipRaw = (body && (body.ip_proof || body.proof)) || '';
    const passRaw = (body && body.password_proof) || '';
    if (!ipRaw || !passRaw) {
      return { ok: false, code: 400, error: `Both your mining IP and your rig password are required ${words.required}`, reason: 'both_proofs_required' };
    }
    const cooldownH = config.nostr_destination_cooldown_hours !== undefined ? config.nostr_destination_cooldown_hours : 48;
    // Floored, and NOT allowed to reach zero. The destination cooldown is an operator dial and
    // 0 is a legitimate setting for it ("don't make me wait after registering") — but the age
    // requirement is a different control that happens to borrow the same number, and letting a
    // 0 there switch it off would silently restore the §J3-1 hole on any pool that turned the
    // cooldown down. An injected proof is minutes old; one hour breaks "mine for ten seconds,
    // then redirect" while staying invisible to anyone who has actually been mining here.
    const MIN_PROOF_AGE_SEC = 3600;
    const minAgeSec = Math.max(MIN_PROOF_AGE_SEC, (Math.max(0, Number(cooldownH) || 0) * 3600));
    // A leg is acceptable only from a LIVE row of the proof set (never an evicted anchor), and
    // only once it has aged — age is first_seen_at, which a refresh never moves (design §17.2
    // #2) and a returning evicted anchor restarts (§17.7), so an anchor cannot be re-activated
    // into an aged leg.
    // age_seconds === null means the row predates the timestamp columns; treat an unknown
    // age as OLD, not as fresh — those rows were written before this attack was reachable,
    // and failing them closed would lock out every miner who mined before the upgrade.
    const legFails = (p) => {
      if (p.slot === 'anchor') return 'anchor_not_accepted_here';
      if (p.age_seconds !== null && p.age_seconds !== undefined && p.age_seconds < minAgeSec) {
        return 'proof_too_recent';
      }
      return null;
    };
    const deny = (leg, reason, code) => {
      auditOwnerProof(db, { action, grinAddress: addr, ip: reqIp, ok: false, details: { reason, leg } });
      return {
        ok: false, code: code || 403, reason,
        error: reason === 'proof_too_recent'
          // minAgeSec, not cooldownH: the age floor is what was enforced, and with the
          // cooldown dial at 0 the old text told the miner "at least 0 h old" while refusing.
          ? `That ${leg === 'ip' ? 'mining IP' : 'rig password'} was only recorded recently. ${words.aged} using evidence at least ${Math.ceil(minAgeSec / 3600)} h old — this is what stops someone who briefly mined to your address from ${words.harm}.`
          : reason === 'anchor_not_accepted_here'
            ? `That proof is your original recorded one, and it has dropped out of the ${PROOF_SET_MAX} most recently used. It can withdraw to your own wallet, but ${words.anchor} needs a mining IP and rig password your rigs are still using.`
            : (leg === 'ip' ? 'Mining IP proof failed' : 'Rig password proof failed'),
      };
    };
    // Checked in order so a wrong IP costs one failed attempt, not two.
    // A leg that VERIFIED but as the other kind (an IP in the password box, or the reverse) is
    // refused as `wrong_kind`: the verifier's own reason there is its success code, `match`,
    // which read as `ok:false, reason:'match'` in the response and the audit row (§18.11 Part 6).
    const ipProof = await verifyOwnerProof(db, addr, ipRaw, reqIp);
    if (!ipProof.ok || ipProof.method !== 'ip') {
      return deny('ip', ipProof.ok ? 'wrong_kind' : (ipProof.reason || 'ip_no_match'));
    }
    const ipBad = legFails(ipProof);
    if (ipBad) return deny('ip', ipBad, 409);
    // method must be 'password' — submitting the password in BOTH fields must not pass.
    const passProof = await verifyOwnerProof(db, addr, passRaw, reqIp);
    if (!passProof.ok || passProof.method !== 'password') {
      return deny('password', passProof.ok ? 'wrong_kind' : (passProof.reason || 'password_no_match'));
    }
    const passBad = legFails(passProof);
    if (passBad) return deny('password', passBad, 409);
    return { ok: true, method: 'ip+password' };
  };

  // Fire the change alert at the destination being REPLACED. Best-effort by contract
  // (publishNotice never throws) — a relay outage must not block a legitimate change — but
  // the outcome is always audited and returned, because an alert nobody received is not a
  // control. Advice order matters: withdrawing via Tor moves the money beyond reach, whereas
  // re-registering only evicts the attacker and leaves the balance sitting there.
  const alertPreviousDestination = async (prevNpub, prevUsername, newUsername, addr, reqIp) => {
    if (!prevNpub || !nostrBridge || !nostrBridge.isEnabled()) return null;
    const text = newUsername
      ? `Your Grin payout destination was CHANGED to "${newUsername}".\n\n`
        + `If this was not you, act now:\n`
        + `1. Withdraw your balance using Tor or Slatepack — those rails still work and can only pay your own mining address.\n`
        + `2. Then re-register your Goblin destination to evict the change.\n\n`
        + `Mining address: ${addr}`
      : `Your Grin payout destination ("${prevUsername || 'previous'}") was REMOVED.\n\n`
        + `If this was not you, withdraw your balance using Tor or Slatepack now — those rails `
        + `still work and can only pay your own mining address.\n\nMining address: ${addr}`;
    const sent = await nostrBridge.publishNotice(prevNpub, text, 'Grin pool: payout destination changed');
    auditOwnerProof(db, {
      action: 'nostr_destination_alert', grinAddress: addr, ip: reqIp, ok: !!sent.ok,
      details: { prev_username: prevUsername || null, new_username: newUsername || null, error: sent.ok ? null : sent.error }
    });
    return sent;
  };

  router.post('/api/account/:addr/nostr-destination', rateLimiter.middleware('withdraw'), async (req, res) => {
    try {
      const { addr } = req.params;
      const reqIp = normalizeIp(req.ip);
      if (!nostrBridge || !nostrBridge.isEnabled()) return res.status(503).json({ error: 'nostr payouts are not enabled on this pool' });

      const proof = await requireBothProofs(addr, req.body, reqIp, 'nostr_destination_register');
      if (!proof.ok) return res.status(proof.code).json({ error: proof.error, reason: proof.reason });

      const acct = db.prepare('SELECT grin_address FROM miner_accounts WHERE grin_address = ?').get(addr);
      if (!acct) return res.status(404).json({ error: 'Account not found' });

      let resolved;
      try { resolved = await nostrBridge.resolveDestination((req.body && req.body.username) || ''); }
      catch (e) { return res.status(e.code && e.code < 600 ? e.code : 400).json({ error: e.message }); }

      // Replacing an existing destination needs an explicit confirmation carrying the username
      // being replaced. Enforced SERVER-side, not just in the UI: a client-side "are you sure"
      // is skippable by anyone posting directly, and this step exists to catch a mistyped
      // username sending real money to a stranger — irreversibly. Echoing `replacing` back
      // means the confirmation the operator saw is the state the server actually holds.
      const prev = db.prepare(
        'SELECT nostr_username, nostr_npub, nostr_prev_username, nostr_prev_npub FROM miner_accounts WHERE grin_address = ?'
      ).get(addr) || {};
      if (prev.nostr_npub && prev.nostr_npub !== resolved.pubHex &&
          String((req.body && req.body.confirm_replace) || '') !== String(prev.nostr_username)) {
        return res.status(409).json({
          error: `This replaces your current destination "${prev.nostr_username}" and restarts the security cooldown.`,
          reason: 'confirm_replace_required',
          replacing: prev.nostr_username,
          replacing_with: resolved.username,
        });
      }

      const nowS = Math.floor(Date.now() / 1000);
      // Carry the outgoing destination forward so a later REMOVE still has somewhere to send
      // the alert. An unchanged re-registration (same npub, cooldown refresh) must not
      // overwrite a genuine previous destination with itself.
      const keepPrevUser = prev.nostr_npub && prev.nostr_npub !== resolved.pubHex
        ? prev.nostr_username : (prev.nostr_prev_username || null);
      const keepPrevNpub = prev.nostr_npub && prev.nostr_npub !== resolved.pubHex
        ? prev.nostr_npub : (prev.nostr_prev_npub || null);
      db.prepare(
        `UPDATE miner_accounts SET nostr_username = ?, nostr_npub = ?, nostr_registered_at = ?,
           nostr_prev_username = ?, nostr_prev_npub = ?, updated_at = unixepoch()
         WHERE grin_address = ?`
      ).run(resolved.username, resolved.pubHex, nowS, keepPrevUser, keepPrevNpub, addr);

      const cooldownH = config.nostr_destination_cooldown_hours !== undefined ? config.nostr_destination_cooldown_hours : 48;
      auditOwnerProof(db, { action: 'nostr_destination_register', grinAddress: addr, ip: reqIp, ok: true, details: { username: resolved.username, replaced: prev.nostr_username || null, proof_method: proof.method } });

      // Alert the destination we just displaced. Only when it actually changed — a cooldown
      // refresh onto the same npub is not a security event and must not cry wolf.
      let alert = null;
      if (prev.nostr_npub && prev.nostr_npub !== resolved.pubHex) {
        alert = await alertPreviousDestination(prev.nostr_npub, prev.nostr_username, resolved.username, addr, reqIp);
      }

      res.json({
        success: true,
        username: resolved.username,
        npub: resolved.npub,
        registered_at: nowS,
        active_at: nowS + cooldownH * 3600,
        cooldown_hours: cooldownH,
        replaced: prev.nostr_username || null,
        // Surfaced so the miner learns the warning did not go out — never silently swallowed.
        previous_notified: alert ? !!alert.ok : null,
      });
    } catch (err) {
      res.status(err.code && err.code >= 400 && err.code < 600 ? err.code : 500).json({ error: err.message });
    }
  });

  // Remove the registered Goblin destination (ownership-gated). Clears the pin + cooldown.
  // Single-proof (OR) on purpose: removal cannot redirect money, it only disables the rail.
  // But it IS the bypass route for the change alert — remove, then register fresh, and there
  // would be no previous destination left to warn. So removal alerts the destination it is
  // clearing: the row is READ into `prev` before the UPDATE blanks nostr_* / nostr_prev_*, so
  // the alert still has somewhere to go. Never move that SELECT below the UPDATE.
  router.delete('/api/account/:addr/nostr-destination', rateLimiter.middleware('withdraw'), async (req, res) => {
    try {
      const { addr } = req.params;
      const reqIp = normalizeIp(req.ip);
      const proof = await verifyOwnerProof(db, addr, (req.body && (req.body.proof || req.body.ip_proof)) || '', reqIp);
      if (!proof.ok) {
        auditOwnerProof(db, { action: 'nostr_destination_remove', grinAddress: addr, ip: reqIp, ok: false, details: { reason: proof.reason } });
        return res.status(403).json({ error: 'Ownership proof failed', reason: proof.reason });
      }
      const prev = db.prepare(
        'SELECT nostr_username, nostr_npub FROM miner_accounts WHERE grin_address = ?'
      ).get(addr) || {};
      db.prepare(
        `UPDATE miner_accounts SET nostr_username = NULL, nostr_npub = NULL, nostr_registered_at = NULL,
           nostr_prev_username = NULL, nostr_prev_npub = NULL, updated_at = unixepoch()
         WHERE grin_address = ?`
      ).run(addr);
      auditOwnerProof(db, { action: 'nostr_destination_remove', grinAddress: addr, ip: reqIp, ok: true, details: { removed: prev.nostr_username || null } });

      const alert = await alertPreviousDestination(prev.nostr_npub, prev.nostr_username, null, addr, reqIp);
      res.json({ success: true, removed: prev.nostr_username || null, previous_notified: alert ? !!alert.ok : null });
    } catch (err) {
      res.status(err.code && err.code >= 400 && err.code < 600 ? err.code : 500).json({ error: err.message });
    }
  });

  // ─── Donor profile — nickname + banner (design §18.4–§18.6, names §19.17.6) ──────────────
  // A donor sets a public name and a banner (the banner shows only for the top N of the league).
  // A NAME is checked automatically and goes live at once (Part C4): the name rule with the donor
  // shape, banned names, "taken", one change per 7 days. A BANNER is still PRE-MODERATED: it
  // becomes a pending donor_requests row that nothing public reads until an admin approves it.
  //
  // The writes are gated like a payout-destination change, BOTH proofs each aged past the same
  // floor (requireBothProofs, audit §J3-1), because a profile speaks for the address on a public
  // page. Two more conditions: ≥ 1 donation debit, which is a cost to post and bounds the queue
  // by real donors, and not blocked. Refusals run cheapest-first, and none of them spends a proof
  // attempt on a request that would be refused anyway: donations off → account → blocked → not a
  // donor → the input itself → the proofs → the write. lib/donor-profiles.js re-checks the account
  // and the block inside its transaction, since the proof check awaits in between.
  const donorBannerUpload = multer({
    storage: multer.memoryStorage(),
    // fileSize bounds MEMORY: multer stops buffering at the cap and discards the rest, so no
    // request holds more than ~300 KB. It does not cut the connection. The remainder is still
    // read (and dropped) before the 413 goes out, so the body's total size is bounded by nginx
    // instead: the public `location /api/` sets no client_max_body_size, so nginx's 1 MB default
    // applies. That fits a 300 KB banner plus multipart overhead. Verified with a fake request
    // stream 2026-09-24.
    // The +1: busboy trips LIMIT_FILE_SIZE when a file REACHES the limit, so a limit of exactly
    // MAX_BANNER_BYTES refused a file of exactly 300 KB, which the rule allows. With +1, 300 KB
    // reaches validateBanner (the precise check) and 300 KB + 1 is refused here.
    // fieldSize bounds the text fields, which carry only the two proofs.
    limits: { fileSize: DonorProfiles.MAX_BANNER_BYTES + 1, files: 1, fields: 10, fieldSize: 4096, parts: 11 },
  });

  const DONOR_REFUSAL = {
    not_found: [404, 'Account not found'],
    blocked: [403, 'This address cannot submit a donor profile. Contact the pool operator if you think this is a mistake.'],
    not_a_donor: [409, "A donor profile unlocks after your first donation. Add a donateN tag to a rig's worker name (for example rig01-donate10); once that rig has earned a share of a matured block, you can set your name and banner here."],
    conflict: [409, 'Another change to this profile was saved at the same moment. Reload the page and try again.'],
    donations_off: [503, 'Donations are switched off on this pool, so donor profiles cannot be changed right now.'],
    // Part C4 — the name answers. not_allowed (a reserved or blocked word) and unavailable (banned
    // OR taken) are generic on purpose: which list hit, and banned vs taken, is the admin's.
    name_not_allowed: [400, DonorProfiles.NAME_TEXT.name_not_allowed],
    name_unavailable: [409, DonorProfiles.NAME_TEXT.name_unavailable],
    unchanged: [409, DonorProfiles.NAME_TEXT.unchanged],
    name_cooldown: [429, `A donor name can be changed once every ${DonorProfiles.NAME_CHANGE_DAYS} days.`],
  };
  const donorRefuse = (res, code, error, extra) => {
    const [status, text] = DONOR_REFUSAL[code] || [code === 'banner_too_large' ? 413 : 400, 'Refused'];
    return res.status(status).json(Object.assign({ error: error || text, reason: code }, extra || {}));
  };
  // null, or the refusal code for a submit that must not go further (the shared precheck).
  const donorSubmitRefusal = (addr) => {
    let on = false;
    try { on = !!(incentivesManager && incentivesManager.donationsActive()); } catch (_) { on = false; }
    if (!on) return 'donations_off';
    if (!db.prepare('SELECT 1 FROM miner_accounts WHERE grin_address = ?').get(addr)) return 'not_found';
    if (db.prepare('SELECT 1 FROM donor_blocks WHERE grin_address = ?').get(addr)) return 'blocked';
    if (donorLastDonatedAt(db, addr, getLedgerRollupHorizon(db)) === null) return 'not_a_donor';
    return null;
  };

  router.post('/api/account/:addr/donor-profile/name', rateLimiter.middleware('withdraw'), async (req, res) => {
    try {
      const { addr } = req.params;
      const reqIp = normalizeIp(req.ip);
      const bad = donorSubmitRefusal(addr);
      if (bad) return donorRefuse(res, bad);
      const v = DonorProfiles.validateName(req.body ? req.body.name : undefined);
      if (!v.ok) return donorRefuse(res, v.code, v.error);
      // Before the proofs: unchanged, the 7-day limit, address-like. None reads a word list, and
      // the account page already shows the live name and when it can change.
      const pre = DonorProfiles.namePrecheck(db, addr, v.name);
      if (pre) return donorRefuse(res, pre.code, pre.error, pre.available_at ? { available_at: pre.available_at } : null);
      // The word lists, banned names and "taken" are checked only AFTER both proofs: a stranger
      // holding the address must not be able to probe the operator's list (the owner can, at the
      // `withdraw` rate — and every answer from a list is the same generic sentence).
      const proof = await requireBothProofs(addr, req.body, reqIp, 'donor_profile_submit', 'donor_profile');
      if (!proof.ok) return res.status(proof.code).json({ error: proof.error, reason: proof.reason });
      const r = DonorProfiles.submitName(db, addr, v.name, { isDonor: true, rule: donorNameRule() });
      if (!r.ok) {
        // The row is about the PROOF, which passed (`ok`); the name was refused. The refused text
        // is stored nowhere and `hit` (which list) never leaves the server.
        auditOwnerProof(db, { action: 'donor_profile_submit', grinAddress: addr, ip: reqIp, ok: true, details: { kind: 'name', refused: r.code, proof_method: proof.method } });
        return donorRefuse(res, r.code, r.error, r.available_at ? { available_at: r.available_at } : null);
      }
      auditOwnerProof(db, { action: 'donor_profile_submit', grinAddress: addr, ip: reqIp, ok: true, details: { kind: 'name', request_id: r.id, replaced_id: r.replaced_id, proof_method: proof.method } });
      // Live at once: the wall and the account page show it from the next read.
      res.json({ success: true, kind: 'name', status: 'approved', name: r.name, submitted_at: r.submitted_at, replaced_id: r.replaced_id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/account/:addr/donor-profile/banner', rateLimiter.middleware('withdraw'), (req, res) => {
    const { addr } = req.params;
    let bad;
    try { bad = donorSubmitRefusal(addr); } catch (err) { return res.status(500).json({ error: err.message }); }
    // Refused BEFORE the body is read: a request that cannot succeed never costs 300 KB of buffer.
    if (bad) return donorRefuse(res, bad);
    donorBannerUpload.single('file')(req, res, async (upErr) => {
      try {
        if (upErr) {
          if (upErr.code === 'LIMIT_FILE_SIZE') {
            return donorRefuse(res, 'banner_too_large', `That image is larger than ${DonorProfiles.MAX_BANNER_BYTES / 1024} KB. Banner: ${DonorProfiles.BANNER_RULE}.`);
          }
          return donorRefuse(res, 'bad_upload', 'The upload could not be read. Send one image in a multipart field named "file", with the two proofs as text fields.');
        }
        // Only the bytes decide: the client's filename and declared MIME are never read.
        const buf = req.file ? req.file.buffer : null;
        const v = DonorProfiles.validateBanner(buf);
        if (!v.ok) return donorRefuse(res, v.code, v.error);
        const reqIp = normalizeIp(req.ip);
        const proof = await requireBothProofs(addr, req.body, reqIp, 'donor_profile_submit', 'donor_profile');
        if (!proof.ok) return res.status(proof.code).json({ error: proof.error, reason: proof.reason });
        const r = DonorProfiles.submitBanner(db, addr, buf, { isDonor: true });
        if (!r.ok) return donorRefuse(res, r.code, r.error);
        auditOwnerProof(db, { action: 'donor_profile_submit', grinAddress: addr, ip: reqIp, ok: true, details: { kind: 'banner', request_id: r.id, bytes: r.bytes, width: r.width, height: r.height, replaced_pending: r.replaced, proof_method: proof.method } });
        res.json({ success: true, kind: 'banner', status: 'pending', mime: r.mime, width: r.width, height: r.height, bytes: r.bytes, submitted_at: r.submitted_at, replaced_pending: r.replaced });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  });

  // Withdraw a request under review (which=pending) or take down the approved one (which=live).
  // Same AND-gate as a submit, since taking a donor's name off the wall is itself a public change
  // made in their name. It deliberately does NOT need donations on, a donation debit, or an
  // unblocked address: removing your own data must always be possible.
  router.delete('/api/account/:addr/donor-profile/:kind', rateLimiter.middleware('withdraw'), async (req, res) => {
    try {
      const { addr, kind } = req.params;
      if (!DonorProfiles.KINDS.includes(kind)) return res.status(404).json({ error: 'Not found' });
      const which = req.body ? req.body.which : undefined;
      if (which !== 'pending' && which !== 'live') {
        return donorRefuse(res, 'bad_which', 'which must be "pending" (withdraw a request under review) or "live" (take down the approved one).');
      }
      if (!db.prepare('SELECT 1 FROM miner_accounts WHERE grin_address = ?').get(addr)) return donorRefuse(res, 'not_found');
      if (kind === 'banner' && which === 'live' && !uploadsDir) return res.status(503).json({ error: 'The uploads directory is not configured on this pool.' });
      // Nothing to act on → say so before spending a proof attempt. Not a new signal: the account
      // summary already publishes pending_at and the live state.
      const status = which === 'pending' ? 'pending' : 'approved';
      const none = { error: which === 'pending' ? `There is no ${kind} waiting for review.` : `There is no live ${kind} to remove.`, reason: which === 'pending' ? 'nothing_pending' : 'nothing_live' };
      if (!db.prepare('SELECT 1 FROM donor_requests WHERE grin_address = ? AND kind = ? AND status = ?').get(addr, kind, status)) {
        return res.status(404).json(none);
      }
      const action = which === 'pending' ? 'donor_profile_withdraw' : 'donor_profile_remove';
      const reqIp = normalizeIp(req.ip);
      const proof = await requireBothProofs(addr, req.body, reqIp, action, 'donor_profile');
      if (!proof.ok) return res.status(proof.code).json({ error: proof.error, reason: proof.reason });
      const r = which === 'pending'
        ? DonorProfiles.withdraw(db, addr, kind)
        : DonorProfiles.removeLive(db, addr, kind, { uploadsDir });
      if (!r.ok) return res.status(404).json(none);
      if (r.warning) console.warn(`[donor-profile] ${addr.slice(0, 9)}… ${kind}: ${r.warning}`);
      auditOwnerProof(db, { action, grinAddress: addr, ip: reqIp, ok: true, details: { kind, request_id: r.id, proof_method: proof.method } });
      res.json({ success: true, kind, which, status: which === 'pending' ? 'withdrawn' : 'removed' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Public cancel REMOVED 2026-07-17 (operator decision). Both parked states self-recover —
  // Tor auto-reverses after max retries, slatepack auto-refunds via TTL expiry — so a public
  // cancel was pure abuse surface: in Grin a "failed" send may actually have posted, and a
  // late cancel reversing the lock would double-pay. Operator support cases go through the
  // admin route (/api/admin/withdrawals/:id/cancel, step-up gated, on the payments page).
  return router;
};
