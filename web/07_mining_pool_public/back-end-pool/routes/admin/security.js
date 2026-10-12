// /api/admin/audit-log, security/*, alerts/*, me, _authcheck. Moved verbatim out of routes/index.js
// (code-layout refactor P8); registrations stay at 2-space indent and write FULL paths.

const express = require('express');
const { requireAdmin } = require('../../lib/auth-middleware');
const AlertMonitor = require('../../lib/alert-monitor');

module.exports = function createAdminSecurityRoutes(ctx, guards) {
  const { config, db, authManager, rateLimiter, ipFilter, alertMonitor, alertDelivery, poolSettings } = ctx;
  const { secureAdmin, freshAdmin, totpIsMandatory } = guards;
  const router = express.Router();

  router.get('/api/admin/audit-log', secureAdmin, (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      const stmt = db.prepare(`
        SELECT * FROM admin_audit_log
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `);
      const logs = stmt.all(limit, offset);

      res.json({
        count: logs.length,
        logs
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Security Management (Rate Limiting & IP Filtering) ──────────────────────
  router.get('/api/admin/security/rate-limit-status', secureAdmin, (req, res) => {
    try {
      const clientIp = rateLimiter.getClientIp(req);
      const status = rateLimiter.getStatus(clientIp);
      const violations = rateLimiter.getViolations();
      res.json({ my_status: status, all_violations: violations });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // freshAdmin, not secureAdmin (audit §J1-4). resetIp() deletes EVERY bucket and violation
  // entry keyed on this IP — including the `auth` bucket, i.e. the login brute-force lockout —
  // so this is the third route meaning "stop throttling this address". The other two,
  // security/temp-ban/clear and security/ip-blacklist/remove, were already behind step-up;
  // this one was the way to clear a lockout and then grind the password toward freshAdmin
  // without ever passing through it. Three routes with one effect now share one tier.
  router.post('/api/admin/security/rate-limit-reset', freshAdmin, (req, res) => {
    try {
      const { ip } = req.body;
      if (!ip) {
        return res.status(400).json({ error: 'IP address required' });
      }
      rateLimiter.resetIp(ip);
      // §J1-2: lifting a throttle for an arbitrary address is a security-relevant mutation and
      // wrote no audit row. Its two siblings do.
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'rate_limit_reset', 'security', ?, ?, ?)`)
        .run(req.user.user_id, String(ip), JSON.stringify({ target_ip: String(ip) }), req.ip);
      res.json({ success: true, message: `Rate limit reset for ${ip}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/admin/security/ip-filter-status', secureAdmin, (req, res) => {
    try {
      const status = ipFilter.getStatus();
      // Surface the caller's IP so the UI can warn before an allowlist locks them out.
      status.your_ip = ipFilter.getClientIp(req);
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/security/ip-allowlist/add', freshAdmin, (req, res) => {
    try {
      const { ip } = req.body;
      if (!ip) {
        return res.status(400).json({ error: 'IP address or CIDR required' });
      }
      const result = ipFilter.addAllowed(ip);
      if (result.success) {
        res.json({ success: true, message: `Added ${ip} to allowlist`, status: ipFilter.getStatus() });
      } else {
        res.status(400).json({ error: result.error });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/security/ip-allowlist/remove', freshAdmin, (req, res) => {
    try {
      const { ip } = req.body;
      if (!ip) {
        return res.status(400).json({ error: 'IP address required' });
      }
      ipFilter.removeAllowed(ip);
      res.json({ success: true, message: `Removed ${ip} from allowlist`, status: ipFilter.getStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/security/ip-blacklist/add', freshAdmin, (req, res) => {
    try {
      const { ip } = req.body;
      if (!ip) {
        return res.status(400).json({ error: 'IP address or CIDR required' });
      }
      const result = ipFilter.addBlocked(ip);
      if (result.success) {
        res.json({ success: true, message: `Added ${ip} to blacklist`, status: ipFilter.getStatus() });
      } else {
        res.status(400).json({ error: result.error });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/security/ip-blacklist/remove', freshAdmin, (req, res) => {
    try {
      const { ip } = req.body;
      if (!ip) {
        return res.status(400).json({ error: 'IP address required' });
      }
      ipFilter.removeBlocked(ip);
      res.json({ success: true, message: `Removed ${ip} from blacklist`, status: ipFilter.getStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── ADMIN SESSIONS / LOGIN ACTIVITY (Admin) ───────────────────────
  // Sessions are stateless JWTs (no server-side session table), so there is no per-device
  // list to enumerate. What the operator CAN see + control: recent login activity (from the
  // audit log) and a "revoke sessions" kill-switch (bumps token_version → invalidates all
  // refresh tokens for the account).
  //
  // KNOWN LIMIT, state it plainly: revoke does NOT kill live ACCESS tokens. Only refresh
  // tokens carry a token_version check (that asymmetry is deliberate — it's what stops one
  // tab's rotation from logging every other tab out), so an already-issued access token stays
  // valid until its own expiry, i.e. for up to access.session_timeout_hours. That setting is
  // therefore clamped to 24 h in auth.js/pool-settings.js: it is the true "time to revoke".
  // Anything longer needs a token_version check on access tokens plus a non-rotating refresh
  // scheme, which is a bigger change than this endpoint.
  router.get('/api/admin/security/login-history', secureAdmin, (req, res) => {
    try {
      // Clamped low as well as high: a negative LIMIT means "no limit" to SQLite, and a
      // non-numeric one binds as NaN and throws — so ?limit=-1 quietly returned the whole
      // audit table. Same idiom as /api/admin/withdrawals.
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      // The action list MUST match what the writers actually emit. It previously asked for
      // 'login_failure' while the login route writes 'login_failed' (and the 2FA step writes
      // 'login_2fa_failed'), so this endpoint returned successes and auto-bans only — the
      // panel's "Failed login" row could never appear and the operator had no way to see a
      // brute-force attempt. 'login_failure' is kept for rows written by older builds.
      //
      // Username comes from the audit row's details when admin_id is NULL, which is the case
      // for every failed attempt (a bad username has no user row to join to) — without this
      // the User column would be '—' on exactly the rows that matter.
      const rows = db.prepare(`
        SELECT a.id, a.action, a.ip, a.created_at, a.details, u.username
        FROM admin_audit_log a LEFT JOIN users u ON u.id = a.admin_id
        WHERE a.action IN ('login_success','login_failed','login_failure','login_2fa_failed',
                           'ip_autoban','logout','2fa_enabled','2fa_disabled','admin_cli_reset')
        ORDER BY a.id DESC LIMIT ?
      `).all(limit);
      const history = rows.map((r) => {
        let username = r.username;
        if (!username && r.details) {
          try { username = JSON.parse(r.details).username || null; } catch (e) { /* not JSON */ }
        }
        return { id: r.id, action: r.action, ip: r.ip, created_at: r.created_at, username: username || null };
      });
      res.json({ success: true, count: history.length, history });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Login security summary (Admin) ────────────────────────────────────────
  // Answers "is anyone attacking my login right now, and from where?" — the counts, the
  // worst source addresses, and the locks/bans currently in force.
  //
  // Two honesty requirements, same as the payout-request audit panel:
  //   * the window is CLAMPED to the audit retention, and the response says so, so a gap
  //     caused by pruning is never displayed as "no attempts";
  //   * requests refused by the rate limiter, the IP filter or the CAPTCHA gate are rejected
  //     BEFORE the login route writes any row, so they are invisible here. The panel states
  //     this — otherwise a quiet table would read as "no attack" during a live flood.
  router.get('/api/admin/security/auth-activity', secureAdmin, (req, res) => {
    try {
      let retentionDays = 180;
      try { retentionDays = parseInt(poolSettings.getSection('database').audit_log_keep_days, 10) || 180; } catch (e) {}

      const askedHours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 365);
      const maxHours = retentionDays * 24;
      const hours = Math.min(askedHours, maxHours);
      const since = Math.floor(Date.now() / 1000) - (hours * 3600);

      const FAIL_ACTIONS = ['login_failed', 'login_failure', 'login_2fa_failed'];
      const failPlaceholders = FAIL_ACTIONS.map(() => '?').join(',');

      // Every query below pins target_type AND target_id so idx_audit_target
      // (target_type, target_id, created_at DESC) is usable as a range seek. Without the
      // target_id term the index can only match the first column and the created_at filter
      // degrades to a scan of the whole audit table — and a full scan on this DB blocks
      // SHARE writes, not just this page (see the hashrate-scan fix in db capacity notes).
      const counts = {};
      for (const r of db.prepare(
        `SELECT action, COUNT(*) AS c FROM admin_audit_log
          WHERE target_type = 'auth' AND target_id = 'login' AND created_at >= ?
          GROUP BY action`
      ).all(since)) counts[r.action] = r.c;

      // ip_autoban is written with target_type 'security', so it is NOT in the set above.
      const autobans = db.prepare(
        `SELECT COUNT(*) AS c FROM admin_audit_log
          WHERE target_type = 'security' AND action = 'ip_autoban' AND created_at >= ?`
      ).get(since).c;

      const failures = FAIL_ACTIONS.reduce((n, a) => n + (counts[a] || 0), 0);

      // Worst source addresses for failed attempts. Pure aggregate, bounded output — no
      // json_extract: JSON1 availability isn't verifiable from this repo (better-sqlite3 is a
      // native module built on the target box), and a security panel is the wrong place to
      // discover a missing SQLite extension via a 500.
      const topOrigins = db.prepare(
        `SELECT ip, COUNT(*) AS attempts, MAX(created_at) AS last_at
           FROM admin_audit_log
          WHERE target_type = 'auth' AND target_id = 'login' AND created_at >= ?
            AND action IN (${failPlaceholders})
            AND ip IS NOT NULL AND ip <> ''
          GROUP BY ip ORDER BY attempts DESC, last_at DESC LIMIT 20`
      ).all(since, ...FAIL_ACTIONS);

      // Which usernames are being tried, across all sources. This is the sweep-vs-grind
      // signal the raw failure count can't give: many usernames from one place is a scanner
      // working a wordlist, repeated hits on one real username is someone targeting YOU.
      // Grouped on the raw details string in SQL (bounded by distinct usernames tried, and
      // capped at 10), then parsed in JS — so no JSON support is needed in SQLite.
      const targeted = db.prepare(
        `SELECT details, COUNT(*) AS attempts, MAX(created_at) AS last_at
           FROM admin_audit_log
          WHERE target_type = 'auth' AND target_id = 'login' AND created_at >= ?
            AND action IN (${failPlaceholders}) AND details IS NOT NULL
          GROUP BY details ORDER BY attempts DESC LIMIT 10`
      ).all(since, ...FAIL_ACTIONS).map((r) => {
        let username = null;
        try { username = JSON.parse(r.details).username; } catch (e) { /* not JSON */ }
        // Usernames are attacker-supplied free text. Cap the length here so one absurd
        // 10 KB "username" can't bloat the response or wreck the table layout; the panel
        // escapes it on render.
        if (typeof username === 'string' && username.length > 64) username = username.slice(0, 64) + '…';
        return { username: username || '(blank)', attempts: r.attempts, last_at: r.last_at };
      });

      // Per-account failure counters (visibility signal kept by AuthManager.login) — shows
      // WHICH account is being ground even when the sources rotate.
      const accounts = db.prepare(
        `SELECT username, failed_login_attempts, totp_enabled, is_active
           FROM users WHERE is_admin = 1 ORDER BY failed_login_attempts DESC, username ASC`
      ).all();

      res.json({
        success: true,
        window_hours: hours,
        requested_hours: askedHours,
        truncated_by_retention: hours < askedHours,
        retention_days: retentionDays,
        totals: {
          success: counts.login_success || 0,
          failed: failures,
          failed_password: (counts.login_failed || 0) + (counts.login_failure || 0),
          failed_2fa: counts.login_2fa_failed || 0,
          autobans,
        },
        top_origins: topOrigins,
        targeted_usernames: targeted,
        // In-memory and process-local: both lists reset on a service restart, which the panel
        // says out loud so an empty list after a deploy isn't read as "the attack stopped".
        active_lockouts: authManager.getActiveLockouts(),
        banned_ips: ipFilter ? ipFilter.getTempBans() : [],
        accounts,
        totp_mandatory: totpIsMandatory(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Lift a temporary auto-ban early. Step-up gated: it re-opens login attempts from an
  // address the pool decided to shut out, and the common legitimate use (the operator banned
  // their own office IP by fumbling a password) is exactly when a hijacked session would
  // most like to do the same.
  router.post('/api/admin/security/temp-ban/clear', freshAdmin, (req, res) => {
    try {
      const ip = String((req.body || {}).ip || '').trim();
      if (!ip) return res.status(400).json({ error: 'IP address required' });
      const had = ipFilter.clearTempBan(ip);
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'temp_ban_cleared', 'security', ?, ?, ?)`)
        .run(req.user.user_id, ip, JSON.stringify({ was_banned: had }), req.ip);
      res.json({ success: true, was_banned: had, banned_ips: ipFilter.getTempBans() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/security/revoke-sessions', freshAdmin, (req, res) => {
    try {
      authManager.revokeUserTokens(req.user.user_id);
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'revoke_sessions', 'auth', ?, '{}', ?)
      `).run(req.user.user_id, String(req.user.user_id), req.ip);
      // Say what this actually does. It bumps token_version, which kills every REFRESH token —
      // no device can renew. It does NOT kill an access token already in someone's hands:
      // requireAdmin/requireFreshAuth never compare `tv` against the DB (that asymmetry is what
      // makes multi-tab refresh rotation safe), so a live access token stays valid until it
      // expires. The window is access.session_timeout_hours, operator-set 1-24 h — the old
      // hardcoded "1-hour" text under-reported it by up to 24x, to an operator reading it
      // mid-incident. Report the LIVE value and name the only control that is faster.
      const idleHours = Math.round((authManager.sessionPolicy().idle / 3600) * 10) / 10;
      res.json({
        success: true,
        idle_window_hours: idleHours,
        message: `Refresh tokens revoked — no device can renew this session. Access tokens ` +
                 `already issued cannot be revoked and stay valid for up to ${idleHours} h ` +
                 `(access.session_timeout_hours). To cut a live intruder off sooner, rotate ` +
                 `jwt_secret in pool.json and restart the service — that invalidates every token at once.`
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── ALERT TEST DELIVERY (Admin) ───────────────────────────────────
  // Fire a synthetic alert through the live delivery channels (email/Discord/Slack/Telegram)
  // so the operator can confirm notifications actually arrive before relying on them. Channels
  // are read from the running config (pool.json) — the response reports which are configured.
  router.post('/api/admin/alerts/test', secureAdmin, async (req, res) => {
    try {
      if (!alertDelivery) return res.status(503).json({ error: 'alert delivery not initialised' });
      const channels = alertDelivery.configuredChannels ? alertDelivery.configuredChannels() : {};
      const anyConfigured = Object.values(channels).some(Boolean);
      if (!anyConfigured) {
        return res.status(400).json({ error: 'No alert channels are configured. Set a webhook / email / Telegram in pool.json first.', channels });
      }
      await alertDelivery.send({
        type: 'test_alert',
        level: 'info',
        message: `Test alert from ${config.pool_name || 'Grin Pool'} — if you see this, notifications work.`,
        occurrence_count: 1,
        triggered_at: Date.now(),
        data: JSON.stringify({ test: true, network: config.network }),
      });
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'alert_test', 'alerts', 'test', ?, ?)
      `).run(req.user.user_id, JSON.stringify({ channels }), req.ip);
      res.json({ success: true, channels, message: 'Test alert dispatched to all configured channels.' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/admin/alerts', secureAdmin, (req, res) => {
    try {
      const status = req.query.status || 'active'; // 'active' or 'resolved'
      let alerts;

      if (status === 'resolved') {
        alerts = alertMonitor.getResolvedAlerts(50);
      } else {
        alerts = alertMonitor.getActiveAlerts();
      }

      res.json({
        status,
        count: alerts.length,
        alerts
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/alerts/:alertId/acknowledge', secureAdmin, (req, res) => {
    try {
      const { alertId } = req.params;
      const success = alertMonitor.acknowledgeAlert(parseInt(alertId, 10));
      if (success) {
        res.json({ success: true, message: `Alert ${alertId} acknowledged` });
      } else {
        res.status(400).json({ error: 'Failed to acknowledge alert' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Close an alert that nothing resolves on its own (AlertMonitor.MANUAL_RESOLVE_TYPES): today only
  // slate_refunded_but_mined, the "paid twice?" alarm the Health page's Grin Wallet card shows until
  // the operator has reconciled it by hand. Step-up + audited, and a note is REQUIRED — closing it
  // silences a money alarm, so the audit row must say what the operator found. Any other type is
  // refused (409): those are resolved by the code that raised them.
  router.post('/api/admin/alerts/:alertId/resolve', freshAdmin, (req, res) => {
    try {
      const id = parseInt(req.params.alertId, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid alert id' });
      const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
      if (!note) return res.status(400).json({ error: 'say what you found or did — the note goes in the audit log' });
      const r = AlertMonitor.resolveManual(db, id, req.user.user_id);
      if (!r.ok) return res.status(r.code).json({ error: r.error });
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'alert_resolve', 'alert', ?, ?, ?)
      `).run(req.user.user_id, String(id), JSON.stringify({ type: r.alert.type, message: r.alert.message, note }), req.ip);
      res.json({ success: true, id, type: r.alert.type });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/alerts/:alertId/snooze', secureAdmin, (req, res) => {
    try {
      const { alertId } = req.params;
      const { minutes } = req.body;
      const snoozeMinutes = minutes || 60;
      // The revenue-address alarm cannot be hidden during its hold (AlertMonitor.closeLockedUntil).
      const target = db.prepare('SELECT type FROM alerts WHERE id = ?').get(parseInt(alertId, 10));
      if (target && AlertMonitor.closeLockedUntil(db, target.type)) {
        return res.status(409).json({ error: 'this alert cannot be snoozed until the 24 h revenue-address hold ends' });
      }

      const success = alertMonitor.snoozeAlert(parseInt(alertId, 10), snoozeMinutes);
      if (success) {
        res.json({
          success: true,
          message: `Alert ${alertId} snoozed for ${snoozeMinutes} minutes`
        });
      } else {
        res.status(400).json({ error: 'Failed to snooze alert' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/admin/alerts/config', secureAdmin, (req, res) => {
    try {
      res.json({
        enabled_alerts: alertMonitor.enabledAlerts,
        thresholds: alertMonitor.thresholds,
        check_interval_secs: config.alert_check_interval_secs || 60,
        delivery: {
          email: !!config.alert_email_address,
          discord: !!config.discord_webhook_url,
          slack: !!config.slack_webhook_url
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Identity of the currently-authenticated admin. The session token is an httpOnly cookie,
  // so the browser CANNOT decode it (that's the point of httpOnly). Admin pages therefore
  // can't read the username/is_admin client-side — they must ask the server. Without this,
  // the pages tried to decode the cookie locally, always got null, and bounced to /login.html
  // in an infinite loop. Gated by secureAdmin: a 200 here is itself the "you're logged in"
  // signal; 401/403 means redirect to login.
  router.get('/api/admin/me', secureAdmin, (req, res) => {
    // `session` drives AdminSession (admin-shell.js): the idle window it counts user
    // interaction against, the absolute cap, and when THIS session actually began. The
    // client can't derive any of it — the token is httpOnly and page-load time is not
    // session start (a reload mid-session would otherwise reset the cap client-side).
    const policy = authManager.sessionPolicy();
    res.json({
      username: req.user?.username || null,
      is_admin: !!req.user?.is_admin,
      user_id: req.user?.user_id || null,
      session: {
        idle_seconds: policy.idle,
        absolute_seconds: policy.abs,
        started_at: Number(req.user?.sst) || null,
        now: Math.floor(Date.now() / 1000)   // lets the client correct for clock skew
      }
    });
  });

  // Lightweight gate for nginx `auth_request` in front of the static /admin/ pages.
  // Purpose: stop nginx serving the admin HTML to an unauthenticated browser AT ALL —
  // no render, no "flash of admin page then redirect to /login.html". nginx subrequests
  // this on every /admin/* hit and only serves the page on a 2xx; 401/403 → redirect to
  // /login.html (handled in the nginx @admin_login fallback). Deliberately bypasses the
  // `admin` rate limiter (just requireAdmin = a cheap cookie+JWT verify, no DB) because it
  // fires per page AND per admin asset (admin-shell.js, styles.css) — running it through
  // the brute-force budget would throttle normal navigation. The network perimeter is
  // already enforced at the nginx `location /admin/` level ($admin_rules); the real
  // /api/admin/* data endpoints keep the full secureAdmin stack. Returns 204 (no body —
  // auth_request ignores it). client-side API.guardAdminPage() stays as a fallback for
  // installs whose nginx wasn't re-run.
  router.get('/api/admin/_authcheck', requireAdmin(authManager), (req, res) => {
    res.status(204).end();
  });

  return router;
};
