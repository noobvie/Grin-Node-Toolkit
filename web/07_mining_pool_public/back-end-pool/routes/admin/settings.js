// /api/admin/settings* and /api/admin/database*. Moved verbatim out of routes/index.js (code-layout refactor P9);
// registrations stay at 2-space indent and write FULL paths.

const express = require('express');
const caches = require('../_shared/caches');

module.exports = function createAdminSettingsRoutes(ctx, guards) {
  const { poolSettings, retentionManager, authManager } = ctx;
  const { secureAdmin, freshAdmin, stepUpRefused, STEP_UP_MAX_AGE_S } = guards;
  const { invalidateBranding } = caches;
  const router = express.Router();

  // ─── POOL SETTINGS ENDPOINTS (Admin only) ─────────────────────────

  // Get all settings sections
  router.get('/api/admin/settings', secureAdmin, (req, res) => {
    try {
      const allSettings = poolSettings.getAll();
      res.json({ success: true, data: allSettings });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch settings' });
    }
  });

  // Get one settings section
  router.get('/api/admin/settings/:section', secureAdmin, (req, res) => {
    try {
      const section = poolSettings.getSection(req.params.section);
      res.json({ success: true, section: req.params.section, data: section });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Update one settings section
  // High-risk sections require step-up auth; cosmetic ones (branding/seo/…) save with a normal
  // admin session. A section is listed here when EVERY key in it is money- or access-critical:
  //   payout      fees, min withdrawal, dormancy, the Goblin destination cooldown
  //   access      admin IP rules, mandatory-2FA switch
  //   incentives  every key sets an amount that auto-credits miner balances (jackpot, join
  //               bonus, streak, lottery pots, the % of pool fee diverted to the prize pool)
  //   database    retention windows that DELETE the money trail — balance_log_keep_days and
  //               audit_log_keep_days prune the ledger and the admin audit log
  //   games       turns a public feature and a public CHAT on for the live pool (design §19.11:
  //               every games-settings write is step-up)
  //   names       the blocked-word list every public name is checked against (design §19.17.5):
  //               emptying it is how a stolen session would let offensive names go live unseen
  const STEP_UP_SETTINGS_SECTIONS = new Set(['payout', 'access', 'incentives', 'database', 'games', 'names']);

  // Individually critical keys that live in an otherwise cosmetic section. pool_info is mostly
  // name/tagline/description, but it also carries the pool's cut and who may mine at all.
  //
  // Gate on a real VALUE CHANGE, not on the key being present: the settings form harvester
  // posts EVERY field in the section on every save, so "the body mentions pool_fee_percent"
  // is true even when the operator only edited the tagline — that would demand a TOTP code
  // for cosmetic edits and train the operator to reflex-approve challenges.
  //
  // The analytics/branding entries below are NOT cosmetic despite living in cosmetic sections
  // (audit §J1-1). They are script/CSS execution sinks on the PUBLIC origin, and public_html/
  // login.html loads branding.js — so an attacker on a stolen session (which, per §C3, survives
  // logout, a password change AND "revoke sessions" until the access token expires) could write
  // a keylogger onto the admin login form, harvest the password + a live TOTP code, and thereby
  // reach every freshAdmin route. Gating them here is what makes secureAdmin genuinely weaker
  // than freshAdmin for this write. Do not "tidy" them out as branding fields.
  const STEP_UP_SETTINGS_KEYS = new Set([
    'pool_fee_percent',   // the pool's cut of every block
    // 'address_whitelist' / 'max_miners' / 'pool_visibility' were gated here until 2026-09-02.
    // The keys are gone (audit §J9-1): nothing enforced them, and the step-up gate on a key no
    // consumer reads is the strongest signal the surface can give that a control is real.
    // 'custom_head_html' / 'custom_body_html' (raw HTML whose <script> nodes branding.js
    // re-created so they ran) were gated here until 2026-10-03. They are not merely un-gated:
    // the keys are DELETED (design §19.17 D22, Option B) and updateSection() refuses a write
    // to either, so there is nothing left for step-up to protect.
    // analytics — third-party script ORIGINS, loaded as <script src> by the matching provider.
    'plausible_src',
    'umami_src',
    'matomo_url',
    // branding — CSS injection sinks. custom_css and font_family both land in a <style>
    // (font_family by string concatenation, so it breaks out of the rule), and font_url is a
    // <link rel=stylesheet> to an operator-chosen origin. CSS alone cannot run JS, but it can
    // restyle the payout form or overlay a fake one, which is money-relevant on its own.
    'custom_css',
    'font_url',
    'font_family',
    // branding — the theme-builder map. applyTheme() writes every entry with
    // style.setProperty() onto BOTH <html> and <body>, and unlike custom_css/font_* it runs
    // ABOVE branding.js's isCredentialPage() guard, so it reaches login.html (audit §J9-3).
    // Same class of sink as custom_css; it was the only one of the four left at secureAdmin.
    'custom_theme',
    // branding — reaches an <a href> verbatim, so a javascript: URI executes on click.
    'cta_link',
  ]);

  // Compare a submitted value against the stored one. Stored rows are TEXT while the form may
  // send numbers, booleans or arrays, so compare by shape: numerically when both are numeric
  // (1.0 vs '1.0'), canonical JSON when either side is a structure ([] vs '[]'), else trimmed
  // strings. Ambiguity resolves to "changed" — a false positive costs one extra TOTP prompt,
  // a false negative silently lets the fee move on a plain session.
  const settingValueUnchanged = (submitted, stored) => {
    if (submitted === undefined || stored === undefined) return submitted === stored;
    const sa = typeof submitted === 'string' ? submitted.trim() : submitted;
    const sb = typeof stored === 'string' ? stored.trim() : stored;
    const structural = (v) => (v && typeof v === 'object') ||
      (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{')));
    if (structural(sa) || structural(sb)) {
      const canon = (v) => {
        if (v && typeof v === 'object') return JSON.stringify(v);
        try { return JSON.stringify(JSON.parse(v)); } catch (e) { return String(v); }
      };
      return canon(sa) === canon(sb);
    }
    // Compare numerically only when BOTH sides are plain decimal — `Number()` also accepts
    // 0x/0b/0o literals while every validator in pool-settings.js uses parseFloat/parseInt,
    // which stop at the 'x'. That mismatch made `0x1` compare EQUAL to a stored `1` (so no
    // step-up was demanded) and then store `0` (audit §J9-2): the pool fee went to zero on a
    // plain secureAdmin session, past the gate that exists to survive a stolen one. Anything
    // this rejects falls through to the string compare and reads as CHANGED, which is the
    // direction this function already says it resolves ambiguity in.
    const plainDecimal = (v) =>
      typeof v === 'number' || /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(String(v));
    const na = Number(sa), nb = Number(sb);
    if (sa !== '' && sb !== '' && plainDecimal(sa) && plainDecimal(sb) &&
        Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
    return String(sa) === String(sb);
  };

  const criticalSettingChanged = (section, body) => {
    if (!body || typeof body !== 'object') return false;
    let current;
    // An unreadable section means we cannot prove nothing critical moved → demand step-up.
    try { current = poolSettings.getSection(section); } catch (e) { return true; }
    return Object.keys(body).some((key) =>
      STEP_UP_SETTINGS_KEYS.has(key) && !settingValueUnchanged(body[key], current[key]));
  };

  router.post('/api/admin/settings/:section', secureAdmin, (req, res) => {
    try {
      const sectionGated = STEP_UP_SETTINGS_SECTIONS.has(req.params.section);
      if (sectionGated || criticalSettingChanged(req.params.section, req.body)) {
        // Freshness + mandatory-2FA, both halves (audit §I7). Keep the section-specific
        // wording on the freshness refusal — the operator needs to know WHY they are being
        // challenged for what may look like a cosmetic save.
        if (!authManager.isTokenFresh(req.token, STEP_UP_MAX_AGE_S)) {
          return res.status(403).json({
            error: sectionGated
              ? 'Re-authentication required for this section'
              : 'Re-authentication required to change a fee, whitelist or visibility setting',
            challenge_required: true
          });
        }
        if (stepUpRefused(req, res)) return;
      }
      // Refuse to switch mandatory 2FA ON unless the admin doing it is already enrolled.
      // Otherwise the save succeeds (the gate read `false` when the middleware ran) and the
      // operator's very next step-up action — including editing this section back — is
      // refused, leaving enrollment or the break-glass CLI as the only ways out. Making the
      // requirement satisfiable at the moment it's imposed avoids that entirely.
      if (req.params.section === 'access' &&
          String((req.body || {}).require_admin_totp) === 'true' &&
          !authManager.isTotpEnabled(req.user.user_id)) {
        return res.status(400).json({
          error: 'Set up 2FA on your own account first — otherwise enabling this would immediately block your own admin actions.',
          totp_enrollment_required: true
        });
      }
      // (The donor-name rescan that ran here on a changed word list was removed in design §18
      // Part 3: names are pre-moderated, so the list only flags queued names at read time.)
      const updated = poolSettings.updateSection(req.params.section, req.body, req.user.user_id);
      invalidateBranding();   // §J12-8: /api/public/branding is memoised; an edit must show at once
      res.json({ success: true, section: req.params.section, data: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Restore section to defaults
  router.post('/api/admin/settings/:section/restore', freshAdmin, (req, res) => {
    try {
      const restored = poolSettings.resetSection(req.params.section, req.user.user_id);
      invalidateBranding();   // §J12-8
      res.json({ success: true, section: req.params.section, data: restored });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── DATABASE / CLEANUP (Admin only) ──────────────────────────────
  // Scalar retention config is handled by /api/admin/settings/database; these expose
  // the live DB size + row counts and a manual "run cleanup now" trigger.
  router.get('/api/admin/database/status', secureAdmin, (req, res) => {
    try {
      res.json({ success: true, data: retentionManager.status() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/database/cleanup', freshAdmin, (req, res) => {
    try {
      const result = retentionManager.runOnce();
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
