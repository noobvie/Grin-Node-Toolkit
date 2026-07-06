/* settings-common.js — shared logic for the split settings pages (2026-06).
   Extracted verbatim from the old settings.html <script>; init is driven by
   window.SETTINGS_SECTION (set inline on each page). Builder calls are guarded so
   a section absent from the current page never throws. */
    // Tab switching is hash-driven so the sidebar's Settings sub-links (e.g. /admin/settings.html#access)
    // deep-link straight to a tab, and in-page tab clicks update the URL (back/forward + sidebar sync).
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        location.hash = btn.getAttribute('data-tab');
      });
    });

    function tabFromHash() { return (location.hash || '').replace(/^#/, ''); }

    function switchTab(tabName) {
      if (!tabName || !document.getElementById(tabName)) return;
      document.querySelectorAll('.settings-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
      document.getElementById(tabName).classList.add('active');
      const btn = document.querySelector(`[data-tab="${tabName}"]`);
      if (btn) btn.classList.add('active');
      if (tabName === 'database') loadDbStatus();
      if (tabName === 'access') { loadIpFilter(); load2fa(); }
    }

    window.addEventListener('hashchange', () => switchTab(tabFromHash()));

    // Load settings on page load
    window.addEventListener('DOMContentLoaded', () => {
      // Auth gate (server-side, httpOnly-cookie aware): redirects to /login.html if not an
      // admin. The API calls are already secureAdmin-gated, but this avoids showing the
      // settings chrome to a logged-out visitor. See API.guardAdminPage.
      API.guardAdminPage();
      loadAllSettings();
      // Each split settings page declares its section inline (window.SETTINGS_SECTION);
      // fall back to a URL hash for any legacy deep-link.
      switchTab(window.SETTINGS_SECTION || tabFromHash());
    });

    // Guard wrapper: a builder/init call whose target section isn't on THIS page must
    // no-op instead of throwing (every page loads this whole shared script).
    function _safe(fn) { try { fn(); } catch (e) { /* not on this page */ } }

    async function loadAllSettings(_attempt) {
      _attempt = _attempt || 0;
      try {
        const response = await fetch('/api/admin/settings', { credentials: 'include', cache: 'no-store' });
        // A 429 (app rate limit) or 503 (nginx rate limit) is TRANSIENT — every Settings
        // sub-page re-fetches the whole config, so clicking quickly through the sidebar can
        // trip the limiter. Mirror guardAdminPage (api.js): back off briefly and retry a
        // couple of times instead of throwing the scary "Failed to load settings" toast.
        if ((response.status === 429 || response.status === 503) && _attempt < 2) {
          return setTimeout(() => loadAllSettings(_attempt + 1), 1000 + _attempt * 1000);
        }
        // A real auth failure is handled (redirect) by guardAdminPage; don't double-toast it.
        if (response.status === 401 || response.status === 403) return;
        if (!response.ok) throw new Error('Failed to load settings (HTTP ' + response.status + ')');
        const data = await response.json();
        populateForm(data.data);
        populateBuilders(data.data);
      } catch (err) {
        showToast('Error loading settings: ' + err.message, 'error');
      }
    }

    function populateForm(settings) {
      for (const [section, values] of Object.entries(settings)) {
        for (const [key, value] of Object.entries(values)) {
          const el = document.getElementById(key);
          if (!el) continue;

          if (el.type === 'checkbox') {
            el.checked = value === true || value === 'true';
          } else if (el.type === 'color') {
            el.value = value || '#667eea';
            updateColorPreview(el);
          } else if (el.type === 'range') {
            el.value = value;
            updateRangeDisplay(el);
          } else if (el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'email' || el.type === 'url' || el.type === 'number') {
            el.value = value || '';
          } else if (el.tagName === 'SELECT') {
            let v = value || '';
            // Retired key from pre-mockup configs: the 'dark' option no longer
            // exists; without this the select would silently go blank and the
            // next save would submit '' (rejected by the back-end validator).
            if (key === 'default_theme' && v === 'dark') v = 'atomic';
            el.value = v;
          }
        }
      }

      // Update conditional visibility
      updatePoolVisibilityUI();

      // Load asset previews
      loadAssetPreviews();
    }

    // Fire a synthetic alert through the live delivery channels so the operator can confirm
    // notifications actually arrive. secureAdmin (no step-up) → a plain credentialed fetch.
    async function testAlert() {
      const msg = document.getElementById('alert-test-msg');
      msg.textContent = 'Sending…';
      msg.style.color = 'var(--text-dim)';
      try {
        const res = await fetch('/api/admin/alerts/test', { method: 'POST', credentials: 'include' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
        const on = Object.keys(body.channels || {}).filter(k => body.channels[k]);
        msg.textContent = on.length ? ('✓ Sent via: ' + on.join(', ')) : '✓ Sent.';
        msg.style.color = 'var(--success, #3fb950)';
      } catch (err) {
        msg.textContent = '✗ ' + err.message;
        msg.style.color = 'var(--error, #f85149)';
      }
    }

    async function saveSection(section, opts = {}) {
      const form = document.querySelector(`#${section} .settings-form`);
      const data = {};

      // Assemble JSON-backed builders into their hidden inputs before harvesting.
      if (section === 'seo') collectPageSeo();
      if (section === 'notices') collectBanners();
      if (section === 'incentives') collectIncentiveEvents();

      form.querySelectorAll('input, select, textarea').forEach(el => {
        if (!el.id) return;
        if (el.classList.contains('settings-skip')) return; // helper inputs, not config keys
        if (el.type === 'checkbox') {
          data[el.id] = el.checked;
        } else if (el.type === 'hidden') {
          data[el.id] = el.value; // JSON builders: always send, even when '{}'/empty
        } else if (el.tagName === 'TEXTAREA') {
          data[el.id] = el.value; // content fields: send even when cleared (to disable a page)
        } else if (el.value) {
          data[el.id] = el.value;
        }
      });

      // Branding: serialise the visitor theme-switcher. The enable checkboxes carry the
      // `settings-skip` class so the harvester ignores them — we read them directly here into
      // the enabled_themes array. The default theme is always included so the public site can
      // always render it. allow_theme_switch is harvested normally from its checkbox above.
      if (section === 'branding') {
        const enabled = [];
        document.querySelectorAll('#enabled-themes-grid .theme-enable').forEach(cb => {
          if (cb.checked) enabled.push(cb.dataset.theme);
        });
        const def = data.default_theme || 'atomic';
        if (!enabled.includes(def)) enabled.unshift(def);
        data.enabled_themes = JSON.stringify(enabled);
      }

      try {
        const response = await adminFetch(`/api/admin/settings/${section}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });

        if (!response.ok) throw new Error('Save failed');
        if (!opts.quiet) showToast(`${section} settings saved!`, 'success');

        // The SEO tab exposes GA4 as a convenience; persist it through the canonical analytics
        // section (full-form save, so Plausible/Umami/Matomo settings are never clobbered).
        if (section === 'seo' && !opts.quiet) await pushSeoGa4ToAnalytics();
      } catch (err) {
        showToast('Error saving settings: ' + err.message, 'error');
      }
    }

    // Mirror the SEO-tab GA4 Measurement ID into the Analytics-tab fields and save that section,
    // keeping a single source of truth (analytics.provider / analytics.ga_tracking_id) that
    // branding.js loadGa4() already reads.
    async function pushSeoGa4ToAnalytics() {
      const seoGa = document.getElementById('seo_ga_tracking_id');
      if (!seoGa) return;
      const v = (seoGa.value || '').trim();
      // SEO and Analytics are now SEPARATE pages, so the old DOM-mirror (writing #ga_tracking_id
      // / #provider then saving the analytics form) no longer works — those fields aren't on the
      // SEO page. Instead fetch the canonical analytics config, override only the GA4 fields, and
      // save the full section via the API so Plausible/Umami/Matomo are preserved (one source of truth).
      try {
        const r = await fetch('/api/admin/settings', { credentials: 'include' });
        const all = (await r.json()).data || {};
        const cur = all.analytics || {};
        const body = Object.assign({}, cur, {
          ga_tracking_id: v,
          provider: v ? 'ga4' : (cur.provider || '')
        });
        await adminFetch('/api/admin/settings/analytics', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      } catch (e) { /* non-fatal: the GA mirror is a convenience */ }
    }

    async function restoreSection(section) {
      if (!confirm(`Restore ${section} to defaults?`)) return;

      try {
        const response = await adminFetch(`/api/admin/settings/${section}/restore`, {
          method: 'POST',
          credentials: 'include'
        });

        if (!response.ok) throw new Error('Restore failed');
        const data = await response.json();
        location.reload();
      } catch (err) {
        showToast('Error restoring defaults: ' + err.message, 'error');
      }
    }

    // ─── Database / Cleanup status + manual run ───────────────────────
    function fmtBytes(n) {
      if (n === null || n === undefined) return '—';
      const u = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0, v = n;
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      return v.toFixed(i ? 1 : 0) + ' ' + u[i];
    }

    async function loadDbStatus() {
      const box = document.getElementById('db-status');
      if (box) box.textContent = 'Loading…';
      try {
        const r = await fetch('/api/admin/database/status', { credentials: 'include' });
        if (!r.ok) throw new Error('status ' + r.status);
        const { data } = await r.json();
        const c = data.counts || {};
        const last = data.last_run ? new Date(data.last_run * 1000).toLocaleString() : 'never';
        box.innerHTML =
          `<strong>DB size:</strong> ${fmtBytes(data.db_size_bytes)} &nbsp;·&nbsp; ` +
          `<strong>shares:</strong> ${c.shares ?? '—'} &nbsp;·&nbsp; ` +
          `<strong>hashrate rows:</strong> ${c.hashrate_history ?? '—'} &nbsp;·&nbsp; ` +
          `<strong>alerts:</strong> ${c.alerts ?? '—'} &nbsp;·&nbsp; ` +
          `<strong>last cleanup:</strong> ${last}`;
      } catch (err) {
        if (box) box.textContent = 'Failed to load DB status: ' + err.message;
      }
    }

    async function runDbCleanup() {
      if (!confirm('Run database cleanup now?')) return;
      try {
        const r = await adminFetch('/api/admin/database/cleanup', { method: 'POST', credentials: 'include' });
        if (!r.ok) throw new Error('status ' + r.status);
        const { data } = await r.json();
        showToast(`Cleanup done — shares ${data.shares_deleted}, hashrate ${data.hashrate_deleted}, alerts ${data.alerts_deleted}`, 'success');
        loadDbStatus();
      } catch (err) {
        showToast('Cleanup failed: ' + err.message, 'error');
      }
    }

    async function uploadAsset(type) {
      const input = document.getElementById(`${type}-input`);
      if (!input.files.length) return;

      const formData = new FormData();
      formData.append('file', input.files[0]);

      try {
        const response = await fetch(`/api/admin/assets/upload?type=${type}`, {
          method: 'POST',
          credentials: 'include',
          body: formData
        });

        if (!response.ok) throw new Error('Upload failed');
        showToast('Asset uploaded!', 'success');
        loadAssetPreviews();
      } catch (err) {
        showToast('Upload error: ' + err.message, 'error');
      }
    }

    async function loadAssetPreviews() {
      try {
        const response = await fetch('/api/admin/assets', { credentials: 'include' });
        if (!response.ok) return;
        const data = await response.json();

        data.assets.forEach(asset => {
          const previewEl = document.getElementById(`${asset.asset_type}-preview`);
          const currentEl = document.getElementById(`${asset.asset_type}-current`);

          if (previewEl) {
            previewEl.src = `/custom/${asset.filename}`;
            previewEl.style.display = 'block';
          }
          if (currentEl) {
            currentEl.textContent = `Current: ${asset.original_name}`;
          }
        });
      } catch (err) {
        console.error('Failed to load asset previews:', err);
      }
    }

    function updatePoolVisibilityUI() {
      const visibility = document.getElementById('pool_visibility');
      const whitelistGroup = document.getElementById('address-whitelist-group');
      if (visibility && whitelistGroup) {
        whitelistGroup.style.display = visibility.value === 'private' ? 'block' : 'none';
      }
    }

    document.getElementById('pool_visibility')?.addEventListener('change', updatePoolVisibilityUI);

    function updateColorPreview(el) {
      // Prefer a per-input preview span (e.g. theme_color-preview); fall back to accent.
      const preview = document.getElementById(`${el.id}-preview`)
        || (el.id === 'accent_color' ? document.getElementById('accent-preview') : null);
      if (preview) preview.textContent = el.value.toUpperCase();
    }

    function updateRangeDisplay(el) {
      const display = document.getElementById(`${el.id}-value`) || document.getElementById('fee-value');
      if (display) display.textContent = el.value;
    }

    document.getElementById('accent_color')?.addEventListener('change', (e) => updateColorPreview(e.target));
    document.getElementById('pool_fee_percent')?.addEventListener('input', (e) => updateRangeDisplay(e.target));

    function showToast(message, type = 'success') {
      const toast = document.createElement('div');
      toast.className = `toast ${type}`;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 4000);
    }

    function addToWhitelist() {
      const input = document.getElementById('whitelist-input');
      if (!input.value) return;
      addToList('whitelist-list', input.value);
      input.value = '';
    }

    // ─── Admin TOTP 2FA (wired to /api/admin/2fa/*) ─────────────────────────────
    function show2faState(state) {
      ['twofa-disabled', 'twofa-enroll', 'twofa-enabled'].forEach(id => {
        document.getElementById(id).style.display = (id === 'twofa-' + state) ? 'block' : 'none';
      });
    }

    async function load2fa() {
      try {
        const r = await fetch('/api/admin/2fa/status', { credentials: 'include' });
        if (!r.ok) throw new Error('status ' + r.status);
        const d = await r.json();
        if (d.enabled) {
          document.getElementById('twofa-recovery-remaining').textContent =
            (d.recovery_codes_remaining || 0) + ' backup code(s) left.';
          show2faState('enabled');
        } else {
          show2faState('disabled');
        }
        document.getElementById('twofa-status').textContent =
          d.enabled ? 'Two-factor authentication is ON for your account.' : 'Two-factor authentication is OFF for your account.';
      } catch (e) {
        document.getElementById('twofa-status').textContent = 'Could not load 2FA status: ' + e.message;
      }
    }

    async function begin2fa() {
      try {
        const r = await adminFetch('/api/admin/2fa/enroll/begin', { method: 'POST', credentials: 'include' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Could not start enrollment');
        document.getElementById('twofa-secret').textContent = d.secret;
        const link = document.getElementById('twofa-otpauth');
        link.textContent = d.otpauth_uri;
        link.href = d.otpauth_uri;
        // Visual QR only if a QR lib is bundled; manual key/link always work.
        const qr = document.getElementById('twofa-qr');
        qr.textContent = '';
        if (window.qrcode) {
          try { const q = window.qrcode(0, 'M'); q.addData(d.otpauth_uri); q.make(); qr.innerHTML = q.createImgTag(5); }
          catch (e) { qr.textContent = ''; }
        }
        show2faState('enroll');
      } catch (e) { showToast(e.message, 'error'); }
    }

    async function confirm2fa() {
      const code = document.getElementById('twofa-confirm-code').value.trim();
      if (!code) { showToast('Enter the 6-digit code', 'error'); return; }
      try {
        const r = await adminFetch('/api/admin/2fa/enroll/confirm', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Confirmation failed');
        showToast('2FA enabled', 'success');
        showRecoveryCodes(d.recovery_codes || []);
        load2fa();
      } catch (e) { showToast(e.message, 'error'); }
    }

    function cancel2faEnroll() { load2fa(); }

    async function disable2fa() {
      const code = document.getElementById('twofa-action-code').value.trim();
      if (!code) { showToast('Enter your current 2FA or recovery code', 'error'); return; }
      if (!confirm('Disable two-factor authentication for your account?')) return;
      try {
        const r = await adminFetch('/api/admin/2fa/disable', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Disable failed');
        showToast('2FA disabled', 'success');
        document.getElementById('twofa-action-code').value = '';
        load2fa();
      } catch (e) { showToast(e.message, 'error'); }
    }

    async function regen2faRecovery() {
      const code = document.getElementById('twofa-action-code').value.trim();
      if (!code) { showToast('Enter your current 2FA or recovery code', 'error'); return; }
      try {
        const r = await adminFetch('/api/admin/2fa/recovery/regenerate', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Regenerate failed');
        showToast('New recovery codes generated', 'success');
        document.getElementById('twofa-action-code').value = '';
        showRecoveryCodes(d.recovery_codes || []);
        load2fa();
      } catch (e) { showToast(e.message, 'error'); }
    }

    function showRecoveryCodes(codes) {
      document.getElementById('twofa-recovery-list').textContent = codes.join('\n');
      document.getElementById('twofa-recovery').style.display = 'block';
    }

    // ─── Live admin IP filter (wired to /api/admin/security/*) ──────────────────
    // These hit the running ipFilter directly (step-up gated → adminFetch handles the
    // password challenge). Source of truth is the server; we re-render from its response.
    let ipFilterYourIp = '';

    async function loadIpFilter() {
      try {
        const r = await fetch('/api/admin/security/ip-filter-status', { credentials: 'include' });
        if (!r.ok) throw new Error('status ' + r.status);
        renderIpFilter(await r.json());
      } catch (e) {
        document.getElementById('ipfilter-status').textContent = 'Could not load filter status: ' + e.message;
      }
    }

    function renderIpFilter(s) {
      ipFilterYourIp = s.your_ip || '';
      const modeLabel = s.mode === 'whitelist' ? 'Allowlist enforced (only listed IPs)'
                      : (s.mode === 'blacklist' ? 'Blacklist only (listed IPs blocked)' : 'Disabled (all IPs allowed)');
      document.getElementById('ipfilter-status').innerHTML =
        'Mode: <strong>' + escapeHtmlSafe(modeLabel) + '</strong> · Your IP: <code>' + escapeHtmlSafe(ipFilterYourIp || 'unknown') + '</code>';

      renderIpList('admin-allowlist', s.allowlist_entries || [], 'allow');
      renderIpList('admin-blacklist', s.blacklist_entries || [], 'block');

      // Lockout guard: allowlist is on but the caller's IP isn't covered by any entry.
      const warn = document.getElementById('ipfilter-lockout-warn');
      const entries = s.allowlist_entries || [];
      const covered = !entries.length || entries.some(e => e === ipFilterYourIp);
      if (entries.length && !covered) {
        warn.style.display = '';
        warn.textContent = '⚠ Your IP (' + ipFilterYourIp + ') is not in the allowlist. Add it now or you may lose admin access. (Restart the service to clear runtime rules if locked out.)';
      } else {
        warn.style.display = 'none';
      }
    }

    function renderIpList(listId, entries, kind) {
      const list = document.getElementById(listId);
      list.innerHTML = '';
      if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'helper-text';
        empty.textContent = '(none)';
        list.appendChild(empty);
        return;
      }
      entries.forEach(ip => {
        const item = document.createElement('div');
        item.className = 'list-item';
        const span = document.createElement('span');
        span.textContent = ip + (ip === ipFilterYourIp ? '  (you)' : '');
        const btn = document.createElement('button');
        btn.className = 'btn btn-danger';
        btn.style.cssText = 'min-width:auto;padding:0.5rem 1rem;';
        btn.textContent = 'Remove';
        btn.onclick = () => removeIp(kind, ip);
        item.appendChild(span);
        item.appendChild(btn);
        list.appendChild(item);
      });
    }

    function escapeHtmlSafe(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    async function ipFilterCall(path, ip) {
      const r = await adminFetch(path, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ('request failed (' + r.status + ')'));
      if (data.status) renderIpFilter(data.status); // add/remove return the fresh status
      return data;
    }

    async function addToAdminAllowlist() {
      const input = document.getElementById('admin-allowlist-input');
      const ip = input.value.trim();
      if (!ip) return;
      if (ip !== ipFilterYourIp && !confirm('Enabling/extending the allowlist restricts admin access to listed IPs only.\n\nAdd "' + ip + '" to the allowlist?')) return;
      try {
        await ipFilterCall('/api/admin/security/ip-allowlist/add', ip);
        input.value = '';
        showToast('Added to allowlist', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    }

    async function addToAdminBlacklist() {
      const input = document.getElementById('admin-blacklist-input');
      const ip = input.value.trim();
      if (!ip) return;
      if (ip === ipFilterYourIp && !confirm('That is YOUR current IP. Blocking it will lock you out. Continue?')) return;
      try {
        await ipFilterCall('/api/admin/security/ip-blacklist/add', ip);
        input.value = '';
        showToast('Added to blacklist', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    }

    async function removeIp(kind, ip) {
      if (!confirm('Remove "' + ip + '" from the ' + (kind === 'allow' ? 'allowlist' : 'blacklist') + '?')) return;
      const path = kind === 'allow' ? '/api/admin/security/ip-allowlist/remove' : '/api/admin/security/ip-blacklist/remove';
      try {
        await ipFilterCall(path, ip);
        showToast('Removed', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    }

    function addToList(listId, value) {
      const list = document.getElementById(listId);
      const item = document.createElement('div');
      item.className = 'list-item';
      item.innerHTML = `
        <span>${value}</span>
        <button class="btn btn-danger" style="min-width: auto; padding: 0.5rem 1rem;" onclick="this.parentElement.remove()">Remove</button>
      `;
      list.appendChild(item);
    }

    // ─── Custom Theme Builder ──────────────────────────────────────────────
    // CSS variable keys (without the -- prefix) — must match what theme.js/branding.js use.
    const THEME_VARS = [
      ['primary', 'Primary'], ['secondary', 'Secondary'], ['accent', 'Accent'],
      ['bg-body', 'Background'], ['bg-card', 'Card'], ['bg-card2', 'Card (alt)'],
      ['border-color', 'Border'], ['text', 'Text'], ['text-dim', 'Text (dim)'],
      ['text-muted', 'Text (muted)'], ['btn-bg', 'Button'], ['btn-text', 'Button text'],
      ['btn-hover', 'Button hover'], ['error-color', 'Error'], ['ok-color', 'OK'],
      ['warn-color', 'Warning'], ['input-bg', 'Input'], ['input-border', 'Input border']
    ];

    function renderThemeBuilder() {
      const wrap = document.getElementById('theme-builder');
      if (!wrap || wrap.dataset.rendered) return;
      THEME_VARS.forEach(([key, label]) => {
        const group = document.createElement('div');
        group.className = 'form-group';
        group.innerHTML = `
          <label>${label} <span style="color:var(--text-dim);font-weight:400;">(--${key})</span></label>
          <div class="color-input-group">
            <input type="color" class="theme-var-input" data-var="${key}" value="#000000">
          </div>`;
        wrap.appendChild(group);
      });
      wrap.dataset.rendered = '1';
    }

    function populateThemeBuilder(custom) {
      renderThemeBuilder();
      let map = custom;
      if (typeof map === 'string') { try { map = JSON.parse(map); } catch (e) { map = {}; } }
      map = map || {};
      document.querySelectorAll('#theme-builder .theme-var-input').forEach(inp => {
        const v = map[inp.dataset.var];
        if (v && /^#[0-9a-fA-F]{6}$/.test(v)) inp.value = v;
      });
    }

    function collectThemeBuilder() {
      const map = {};
      document.querySelectorAll('#theme-builder .theme-var-input').forEach(inp => {
        // Only record vars the operator actually changed from the #000000 placeholder.
        if (inp.value && inp.value.toLowerCase() !== '#000000') map[inp.dataset.var] = inp.value;
      });
      const hidden = document.getElementById('custom_theme');
      if (hidden) hidden.value = JSON.stringify(map);
    }

    // ── Enabled-themes picker (drives the public theme switcher) ────────────────
    // Must match the public switcher's known themes (public_html/js/public-theme.js).
    const PUBLIC_THEMES = [
      { key: 'atomic', label: 'Atomic ⚛' }, { key: 'nexus', label: 'Nexus' }, { key: 'light', label: 'Light' },
      { key: 'winter', label: 'Winter Frost ❄️' }, { key: 'spring', label: 'Spring Blossom 🌸' },
      { key: 'summer', label: 'Summer Wave 🌊' }, { key: 'autumn', label: 'Autumn Harvest 🍂' },
      { key: 'halloween', label: 'Halloween 🎃' }, { key: 'christmas', label: 'Christmas 🎄' },
      { key: 'galaxy', label: 'Galaxy ⭐' }, { key: 'winxp', label: 'Windows XP 🪟' },
      { key: 'aqua', label: 'macOS Aqua 🍎' }, { key: 'comic', label: 'Comic Pop 💥' },
    ];

    function renderEnabledThemes() {
      const grid = document.getElementById('enabled-themes-grid');
      if (!grid) return;
      grid.innerHTML = '';
      PUBLIC_THEMES.forEach(t => {
        const label = document.createElement('label');
        label.className = 'toggle-wrap';
        label.style.cssText = 'display:flex;align-items:center;gap:.4rem;font-size:.9rem;cursor:pointer;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'settings-skip theme-enable';
        cb.dataset.theme = t.key;
        cb.style.width = 'auto';
        label.appendChild(cb);
        label.appendChild(document.createTextNode(' ' + t.label));
        grid.appendChild(label);
      });
    }

    function collectEnabledThemes() {
      const arr = [];
      document.querySelectorAll('#enabled-themes-grid .theme-enable').forEach(cb => {
        if (cb.checked) arr.push(cb.dataset.theme);
      });
      const hidden = document.getElementById('enabled_themes');
      if (hidden) hidden.value = JSON.stringify(arr);
    }

    function populateEnabledThemes(val) {
      renderEnabledThemes(); // ensure the checkboxes exist before ticking them
      let arr = val;
      if (typeof val === 'string') { try { arr = JSON.parse(val || '[]'); } catch (e) { arr = []; } }
      if (!Array.isArray(arr)) arr = [];
      document.querySelectorAll('#enabled-themes-grid .theme-enable').forEach(cb => {
        cb.checked = arr.indexOf(cb.dataset.theme) !== -1;
      });
    }

    function exportTheme() {
      collectThemeBuilder();
      const json = document.getElementById('custom_theme').value || '{}';
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pool-theme.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      showToast('Theme exported', 'success');
    }

    function importTheme(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const map = JSON.parse(reader.result);
          if (typeof map !== 'object' || map === null) throw new Error('not an object');
          populateThemeBuilder(map);
          showToast('Theme imported — review and Save to apply', 'success');
        } catch (e) {
          showToast('Invalid theme file: ' + e.message, 'error');
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    }

    // ─── Per-Page SEO editor ───────────────────────────────────────────────
    function renderPageSeoRow(key, title, description) {
      const list = document.getElementById('page-seo-list');
      const row = document.createElement('div');
      row.className = 'form-section page-seo-row';
      row.dataset.key = key;
      row.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem;">
          <strong>${key}</strong>
          <button type="button" class="btn btn-danger" style="min-width:auto;padding:.4rem .9rem;" onclick="this.closest('.page-seo-row').remove()">Remove</button>
        </div>
        <div class="form-group">
          <label>Title</label>
          <input type="text" class="page-seo-title settings-skip" value="${(title || '').replace(/"/g, '&quot;')}">
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea class="page-seo-desc settings-skip" rows="2">${description || ''}</textarea>
        </div>`;
      list.appendChild(row);
    }

    function addPageSeoRow() {
      const keyInput = document.getElementById('page-seo-key');
      const key = (keyInput.value || '').trim();
      if (!key) return;
      renderPageSeoRow(key, '', '');
      keyInput.value = '';
    }

    function populatePageSeo(pageSeo) {
      const list = document.getElementById('page-seo-list');
      if (list) list.innerHTML = '';
      let map = pageSeo;
      if (typeof map === 'string') { try { map = JSON.parse(map); } catch (e) { map = {}; } }
      map = map || {};
      Object.keys(map).forEach(key => {
        const entry = map[key] || {};
        renderPageSeoRow(key, entry.title, entry.description);
      });
    }

    function collectPageSeo() {
      const map = {};
      document.querySelectorAll('#page-seo-list .page-seo-row').forEach(row => {
        const key = row.dataset.key;
        const title = row.querySelector('.page-seo-title').value.trim();
        const desc = row.querySelector('.page-seo-desc').value.trim();
        if (title || desc) map[key] = { title, description: desc };
      });
      const hidden = document.getElementById('page_seo');
      if (hidden) hidden.value = JSON.stringify(map);
    }

    // ─── Announcement banner editor ────────────────────────────────────────
    function bannerAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

    function renderBannerRow(b) {
      b = b || {};
      const list = document.getElementById('banners-list');
      const row = document.createElement('div');
      row.className = 'form-section banner-row';
      row.dataset.id = b.id || ('b' + Date.now() + Math.floor(Math.random() * 1000));
      const types = ['news', 'update', 'maintenance', 'warning'];
      const opts = types.map(t =>
        `<option value="${t}"${b.type === t ? ' selected' : ''}>${t}</option>`).join('');
      row.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem;gap:1rem;">
          <div class="checkbox-group">
            <input type="checkbox" class="banner-enabled settings-skip"${(b.enabled === false || b.enabled === 'false') ? '' : ' checked'}>
            <label>Enabled</label>
          </div>
          <button type="button" class="btn btn-danger" style="min-width:auto;padding:.4rem .9rem;" onclick="this.closest('.banner-row').remove()">Remove</button>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Type</label>
            <select class="banner-type settings-skip">${opts}</select>
          </div>
          <div class="checkbox-group" style="align-self:end;padding-bottom:.75rem;">
            <input type="checkbox" class="banner-dismissible settings-skip"${(b.dismissible === false || b.dismissible === 'false') ? '' : ' checked'}>
            <label>Dismissible</label>
          </div>
        </div>
        <div class="form-group">
          <label>Message</label>
          <input type="text" class="banner-message settings-skip" value="${bannerAttr(b.message)}" placeholder="Short announcement text">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Link URL (optional)</label>
            <input type="url" class="banner-link settings-skip" value="${bannerAttr(b.link)}" placeholder="https://...">
          </div>
          <div class="form-group">
            <label>Link Text</label>
            <input type="text" class="banner-linktext settings-skip" value="${bannerAttr(b.link_text)}" placeholder="Learn more">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Start (optional)</label>
            <input type="date" class="banner-start settings-skip" value="${bannerAttr(b.start)}">
          </div>
          <div class="form-group">
            <label>End (optional)</label>
            <input type="date" class="banner-end settings-skip" value="${bannerAttr(b.end)}">
          </div>
        </div>`;
      list.appendChild(row);
    }

    function addBanner() { renderBannerRow({}); }

    function populateBanners(banners) {
      const list = document.getElementById('banners-list');
      if (list) list.innerHTML = '';
      let arr = banners;
      if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }
      if (!Array.isArray(arr)) arr = [];
      arr.forEach(renderBannerRow);
    }

    function collectBanners() {
      const arr = [];
      document.querySelectorAll('#banners-list .banner-row').forEach(row => {
        arr.push({
          id: row.dataset.id,
          type: row.querySelector('.banner-type').value,
          message: row.querySelector('.banner-message').value.trim(),
          link: row.querySelector('.banner-link').value.trim(),
          link_text: row.querySelector('.banner-linktext').value.trim(),
          enabled: row.querySelector('.banner-enabled').checked,
          dismissible: row.querySelector('.banner-dismissible').checked,
          start: row.querySelector('.banner-start').value,
          end: row.querySelector('.banner-end').value,
        });
      });
      const hidden = document.getElementById('banners');
      if (hidden) hidden.value = JSON.stringify(arr);
    }

    // ─── Lottery special-event editor ──────────────────────────────────────
    function eventAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

    function renderEventRow(ev) {
      ev = ev || {};
      const list = document.getElementById('events-list');
      const row = document.createElement('div');
      row.className = 'form-section event-row';
      row.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem;gap:1rem;">
          <div class="checkbox-group">
            <input type="checkbox" class="event-enabled settings-skip"${(ev.enabled === false || ev.enabled === 'false') ? '' : ' checked'}>
            <label>Enabled</label>
          </div>
          <button type="button" class="btn btn-danger" style="min-width:auto;padding:.4rem .9rem;" onclick="this.closest('.event-row').remove()">Remove</button>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Event name</label>
            <input type="text" class="event-name settings-skip" value="${eventAttr(ev.name)}" placeholder="Christmas">
          </div>
          <div class="form-group">
            <label>Date (MM-DD, UTC)</label>
            <input type="text" class="event-date settings-skip" value="${eventAttr(ev.date)}" placeholder="12-25" maxlength="5">
          </div>
          <div class="form-group">
            <label>Fixed pot (GRIN, 0 = use pool %)</label>
            <input type="number" class="event-pot settings-skip" min="0" step="0.01" value="${eventAttr(ev.pot_grin || 0)}">
          </div>
        </div>`;
      list.appendChild(row);
    }

    function addEvent() { renderEventRow({}); }

    function populateEvents(events) {
      const list = document.getElementById('events-list');
      if (list) list.innerHTML = '';
      let arr = events;
      if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }
      if (!Array.isArray(arr)) arr = [];
      arr.forEach(renderEventRow);
    }

    function collectIncentiveEvents() {
      const arr = [];
      document.querySelectorAll('#events-list .event-row').forEach(row => {
        const date = row.querySelector('.event-date').value.trim();
        if (!/^\d{2}-\d{2}$/.test(date)) return; // skip invalid dates
        arr.push({
          name: row.querySelector('.event-name').value.trim() || 'Event',
          date,
          pot_grin: parseFloat(row.querySelector('.event-pot').value) || 0,
          enabled: row.querySelector('.event-enabled').checked,
        });
      });
      const hidden = document.getElementById('lottery_special_events');
      if (hidden) hidden.value = JSON.stringify(arr);
    }

    // ─── Prize pool + lottery dynamic data ──────────────────────────────────
    async function loadIncentiveData() {
      try {
        const r = await fetch('/api/admin/incentives/prize-pool', { credentials: 'include' });
        if (r.ok) {
          const d = await r.json();
          const bal = document.getElementById('prize-pool-balance');
          if (bal) bal.textContent = (d.balance || 0).toFixed(4);
          const led = document.getElementById('prize-pool-ledger');
          if (led) led.innerHTML = (d.ledger || []).slice(0, 8).map(e =>
            `${new Date(e.created_at * 1000).toLocaleString()} — ${e.event_type} ${(e.amount).toFixed(4)} (${e.reference_type})`
          ).join('<br>');
        }
      } catch (e) { /* non-fatal */ }
      try {
        const r = await fetch('/api/admin/incentives/lottery/draws', { credentials: 'include' });
        if (r.ok) {
          const d = await r.json();
          const el = document.getElementById('lottery-draws');
          if (el) el.innerHTML = (d.draws || []).slice(0, 5).map(dr =>
            `#${dr.id} ${dr.event_name || 'weekly'} — ${dr.status} — ${(dr.winners || []).map(w => `${w.grin_address.slice(0, 12)}… ${w.amount.toFixed(4)}`).join(', ') || 'no winners'}`
          ).join('<br>');
        }
      } catch (e) { /* non-fatal */ }
    }

    async function topUpPrizePool() {
      const amount = parseFloat(document.getElementById('prize-topup-amount').value);
      if (!(amount > 0)) { showToast('Enter a top-up amount', 'error'); return; }
      try {
        const r = await adminFetch('/api/admin/incentives/prize-pool/topup', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount })
        });
        if (!r.ok) throw new Error((await r.json()).error || 'Top-up failed');
        showToast('Prize pool topped up', 'success');
        document.getElementById('prize-topup-amount').value = '';
        loadIncentiveData();
      } catch (e) { showToast(e.message, 'error'); }
    }

    async function awardPrize() {
      const address = document.getElementById('award-address').value.trim();
      const amount = parseFloat(document.getElementById('award-amount').value);
      const note = document.getElementById('award-note').value.trim();
      const fromPool = document.getElementById('award-from-prize-pool').checked;
      if (!address) { showToast('Enter a Grin address', 'error'); return; }
      if (!(amount > 0)) { showToast('Enter an award amount', 'error'); return; }
      if (!confirm(`Award ${amount} GRIN to ${address}?`)) return;
      try {
        const r = await adminFetch('/api/admin/incentives/award', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, amount, note, from_prize_pool: fromPool })
        });
        if (!r.ok) throw new Error((await r.json()).error || 'Award failed');
        showToast('Prize awarded', 'success');
        document.getElementById('award-address').value = '';
        document.getElementById('award-amount').value = '';
        document.getElementById('award-note').value = '';
        loadIncentiveData();
      } catch (e) { showToast(e.message, 'error'); }
    }

    async function drawLotteryNow(type) {
      if (!confirm('Run a lottery draw now? This pays real prize-pool GRIN to winners.')) return;
      try {
        const r = await adminFetch('/api/admin/incentives/lottery/draw-now', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Draw failed');
        showToast('Draw complete: ' + (d.result.winners || []).length + ' winner(s)', 'success');
        loadIncentiveData();
      } catch (e) { showToast(e.message, 'error'); }
    }

    // ─── Analytics provider field toggling ─────────────────────────────────
    function updateProviderFields() {
      const provider = document.getElementById('provider');
      if (!provider) return;
      document.querySelectorAll('.provider-fields').forEach(el => {
        el.style.display = el.dataset.provider === provider.value ? 'block' : 'none';
      });
    }

    // Populate the custom builders from loaded settings (called after populateForm).
    function populateBuilders(settings) {
      // The settings response always carries every section, but only THIS page's section
      // markup is present — so each builder is guarded (_safe) against missing elements.
      if (settings.branding) {
        _safe(() => populateThemeBuilder(settings.branding.custom_theme));
        _safe(() => populateEnabledThemes(settings.branding.enabled_themes));
      }
      if (settings.seo)        _safe(() => populatePageSeo(settings.seo.page_seo));
      if (settings.notices)    _safe(() => populateBanners(settings.notices.banners));
      if (settings.incentives) _safe(() => populateEvents(settings.incentives.lottery_special_events));
      // Mirror the canonical GA4 id into the SEO-tab convenience field (single source of truth).
      if (settings.analytics) {
        const g = document.getElementById('seo_ga_tracking_id');
        if (g) g.value = settings.analytics.ga_tracking_id || '';
      }
      _safe(updateProviderFields);
      // loadIncentiveData() hits the API and fills incentive widgets — only on that page.
      if (window.SETTINGS_SECTION === 'incentives') _safe(loadIncentiveData);
    }

    // Wire up dynamic listeners once the DOM is ready.
    document.addEventListener('DOMContentLoaded', () => {
      _safe(renderThemeBuilder);
      _safe(renderEnabledThemes);
      _safe(updateProviderFields);
      document.getElementById('provider')?.addEventListener('change', updateProviderFields);
      document.getElementById('theme_color')?.addEventListener('input', (e) => updateColorPreview(e.target));
    });
