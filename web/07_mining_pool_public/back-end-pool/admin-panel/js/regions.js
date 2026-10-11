// regions.html page script — moved BYTE-verbatim out of the page's inline script block (code-layout F5).
// Classic script (no defer/module) loaded at the same position as the old block, after the <script src> tags before it, whose globals it uses (H14).
API.guardAdminPage();

let _regions = [];          // last-loaded pool_locations rows, looked up by id
let _hb = {};               // region → gateway health (live status)
let STRATUM_PORT = '3333';  // shared across all regions (from pool.json via /api/public/branding)

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ISO-3166 alpha-2 → flag emoji. '' when not a clean 2-letter code.
function flagEmoji(cc) {
  if (!cc) return '';
  cc = String(cc).toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  const emoji = String.fromCodePoint(0x1F1E6 + cc.charCodeAt(0) - 65) +
                String.fromCodePoint(0x1F1E6 + cc.charCodeAt(1) - 65);
  // Wrap in .flag-emoji so the Twemoji flag font applies (fixes Chrome/Edge
  // on Windows, which otherwise show the bare ISO letters).
  return '<span class="flag-emoji">' + emoji + '</span>';
}

// Flag as HTML: VN uses the custom yellow Heritage & Freedom SVG (same as the
// public dashboard — no Unicode emoji exists for it); everyone else gets the
// regional-indicator emoji. '' when no flag. Output is fixed markup or a
// validated emoji, so it's safe to inject.
function flagHtml(cc) {
  cc = String(cc || '').toUpperCase();
  if (cc === 'VN') return '<img class="flag-img" src="/images/flags/vn-future.svg" alt="Vietnam">';
  return flagEmoji(cc);
}

function syncFlag() {
  const f = flagHtml(document.getElementById('r-cc').value);
  document.getElementById('flag-preview').innerHTML = f || '—';
}

// Split a stored "host:port" into just the host (the port is fixed pool-wide).
function hostOf(stratumUrl) {
  return String(stratumUrl || '').split(':')[0] || '';
}

const STATUS_META = {
  online:  { cls: 'badge-ok',    label: '● Active',  tip: 'Shares or a WireGuard handshake seen within the last 3 minutes' },
  stale:   { cls: 'badge-warn',  label: '● Stalling', tip: 'Last share / tunnel handshake 3–10 minutes ago' },
  offline: { cls: 'badge-error', label: '● Silent',  tip: 'No shares and no tunnel handshake for over 10 minutes' },
  unknown: { cls: 'badge-dim',   label: '○ No signal', tip: 'Never seen shares or a tunnel handshake from this region' }
};
function statusBadge(region) {
  const hb = _hb[region];
  const m = (!hb || !STATUS_META[hb.status]) ? STATUS_META.unknown : STATUS_META[hb.status];
  return `<span class="badge ${m.cls}" title="${m.tip}">${m.label}</span>`;
}

function fmtAge(s) {
  if (s == null) return '—';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// WireGuard tunnel chip (design §13.4): handshake age <3min green / <10min
// yellow / older red; grey "no peer" when the region has no wg peer at all.
function tunnelChip(region) {
  const hb = _hb[region];
  const age = hb ? hb.tunnel_handshake_age : null;
  if (age == null) {
    return '<span class="badge badge-dim" title="No WireGuard peer paired for this region (single-box region, or gateway not paired yet)">— no peer</span>';
  }
  const cls = age < 180 ? 'badge-ok' : age < 600 ? 'badge-warn' : 'badge-error';
  const tip = 'Last WireGuard handshake with this region\'s gateway'
    + (hb.tunnel_rx_bytes != null ? ' · rx ' + fmtBytes(hb.tunnel_rx_bytes) + ' / tx ' + fmtBytes(hb.tunnel_tx_bytes) : '');
  return `<span class="badge ${cls}" title="${tip}">🔒 ${fmtAge(age)}</span>`;
}

function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

// ── Multi-region readiness (the STEP 1 prerequisite) ─────────────────────────
// The hub's own WireGuard tunnel has to exist before ANY gateway can peer with it.
// It used to be reachable only over SSH (Script 07 → W → 1), so the first time an
// operator learned about it was a 502 halfway through saving a region. Read the
// state up front and either offer the button or confirm the tunnel is up.
// _mrReady: null = unknown (never answered), true/false = the last known state.
// Only `false` is actionable — `null` must never be treated as "not enabled".
let _mrReady = null;
async function loadServerState() {
  const banner = document.getElementById('mr-banner');
  const ready  = document.getElementById('mr-ready');
  // API.get → Auth.fetch, which RESOLVES null on any failure (network, non-JSON,
  // rate-limit) instead of throwing. A try/catch here would never fire, and
  // `!d.ready` on a null would nag a perfectly healthy pool to "enable" a tunnel
  // it already runs. Only a well-formed answer is allowed to move the state.
  const d = await API.get('/api/admin/gateways/server');
  if (!d || d.success !== true) {
    _mrReady = null;
    banner.style.display = 'none';
    ready.style.display = 'none';
    return;
  }
  _mrReady = !!d.ready;
  const detail = 'hub ' + (d.hub_tunnel_ip || '?') + '  ·  endpoint ' + (d.hub_endpoint || '?') +
    '  ·  ' + (d.peers || 0) + ' gateway peer' + (d.peers === 1 ? '' : 's') + ' paired';
  if (_mrReady && d.interface_up !== false) {
    banner.style.display = 'none';
    ready.style.display = '';
    document.getElementById('mr-error').style.display = 'none';
    document.getElementById('mr-ready-detail').textContent = detail;
    return;
  }
  ready.style.display = 'none';
  banner.style.display = '';
  if (_mrReady) {
    // Third state: set up, but the interface is DOWN. Same button fixes it —
    // init-server is idempotent and keeps the existing keypair/config, so it
    // raises the tunnel without re-keying and stranding paired gateways.
    document.getElementById('mr-title').textContent = 'Multi-region is set up, but the tunnel is DOWN';
    document.getElementById('mr-body').textContent =
      'The hub keypair and tunnel config are in place, but the WireGuard interface is not running, ' +
      'so no gateway can hand-shake and every region behind one is dark. Bringing it back up keeps ' +
      'the existing keys — already-paired gateways reconnect on their own.';
    document.getElementById('mr-reason').textContent = detail;
    document.getElementById('mr-enable').textContent = 'Bring the tunnel back up';
    document.getElementById('mr-enable-note').textContent = 'Keeps the current keys — nothing needs re-pairing.';
  } else {
    document.getElementById('mr-title').textContent = 'Multi-region is not enabled yet';
    document.getElementById('mr-body').textContent =
      "Pairing a gateway needs this pool's own WireGuard tunnel running first — it's what every gateway " +
      'connects to. One click sets it up here: keypair, tunnel config, firewall rule for the WireGuard ' +
      'UDP port, and the interface enabled at boot. It changes nothing about how your current miners connect.';
    document.getElementById('mr-enable').textContent = 'Enable multi-region';
    document.getElementById('mr-enable-note').textContent = "Takes up to a minute if WireGuard isn't installed yet.";
    document.getElementById('mr-reason').textContent = d.reason ? ('Reported: ' + d.reason) : '';
  }
}

async function enableMultiRegion() {
  const btn = document.getElementById('mr-enable');
  const original = btn.textContent;
  // Names the password step that may follow, so the in-page dialog that opens after this
  // one is expected rather than read as a glitch (§13.12r).
  if (!confirm("Set up this pool's WireGuard tunnel?\n\nThis generates the hub keypair (or keeps the existing one), writes its tunnel config, opens the WireGuard UDP port in the firewall, and brings the interface up. Existing miners are not affected, and gateways that are already paired stay paired.\n\nThis is a protected action: if you haven't entered your password in the last 5 minutes, a password box opens on the page next — type it there and press Authorize.")) return;
  btn.disabled = true;
  btn.textContent = 'Working…';
  const errBox = document.getElementById('mr-error');
  errBox.style.display = 'none';          // a retry starts clean; the catch below refills it
  try {
    // freshAdmin server-side → adminFetch carries the step-up challenge/retry.
    // It always resolves to a Response (never null), so res.ok is safe to read.
    const res = await adminFetch('/api/admin/gateways/server', { method: 'POST' });
    const r = await res.json().catch(() => null);
    if (!res.ok || !r || r.error) {
      const e = new Error(r && r.error ? r.error : 'Enable failed (' + res.status + ')');
      // `step_up` is set only on the 403 adminFetch synthesises in the browser when the
      // password prompt was dismissed or failed: nothing reached the pool, so the
      // journal/SSH footer below would point at the wrong place.
      e.stepUp = !!(r && r.step_up);
      throw e;
    }
    // A caveat means the tunnel IS up but a step this process cannot perform was
    // skipped (boot persistence, firewall). Both are silent until much later — a
    // reboot, or a gateway that never hand-shakes — so they must not be flashed as
    // plain success and must not disappear with the next toast.
    if (r.caveats && r.caveats.length) {
      flash('Multi-region enabled, but ' + r.caveats.length + ' step needs an SSH session — see below.', true);
      const box = document.getElementById('mr-caveats');
      box.innerHTML = '';
      for (const c of r.caveats) {
        const li = document.createElement('li');
        li.textContent = c;            // textContent, never innerHTML: this text
        box.appendChild(li);           // originates in a shell helper's output
      }
      box.style.display = '';
    } else {
      document.getElementById('mr-caveats').style.display = 'none';
      flash(r.already_configured
        ? 'Multi-region was already set up — tunnel re-checked and left running.'
        : 'Multi-region enabled — the tunnel is up. You can pair a gateway now.', false);
    }
    // Awaited: loadServerState owns this button's label from here (it may hide the
    // whole card), so restoring a pre-click snapshot afterwards would contradict it.
    await loadServerState();
  } catch (err) {
    flash(err.message, true);
    // The helper's own errors already say what to do ("re-run pool menu 1) Install",
    // "install wireguard-tools"…); a raw exec failure ("sudo: a password is required",
    // "timed out") is the operator's evidence for the next step. Either way it has to
    // stay on screen, next to the button that produced it.
    errBox.textContent = 'Last attempt failed: ' + err.message
      + (err.stepUp ? ''             // the message already says: click again, type the password
         : '\n\nIf the request reached the pool, its service journal has the server-side detail. Pool menu W → 1 (over SSH) performs this step as root, outside the service sandbox.');
    errBox.style.display = '';
    btn.textContent = original;
  } finally {
    btn.disabled = false;
  }
}

// ── Pairing card (GRINGW1 string + copy) ─────────────────────────────────────
let _lastPairing = '';
function showPairingCard(region, pairing, warnMsg) {
  _lastPairing = pairing || '';
  document.getElementById('pairing-region').textContent = region;
  document.getElementById('pairing-string').textContent = pairing || '(no pairing string)';
  const w = document.getElementById('pairing-warn');
  if (warnMsg) { w.textContent = warnMsg; w.style.display = ''; }
  else { w.style.display = 'none'; }
  const card = document.getElementById('pairing-card');
  card.style.display = '';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function copyPairing() {
  if (!_lastPairing) return;
  try {
    await navigator.clipboard.writeText(_lastPairing);
    flash('Pairing string copied to clipboard.', false);
  } catch (e) {
    // Clipboard API can be blocked — the string is selectable in the box.
    flash('Copy blocked by the browser — select the string manually.', true);
  }
}

// Row action: re-derive a lost pairing string (replaces SSH `W → 3`).
async function showPairing(region) {
  try {
    const d = await API.get('/api/admin/gateways/' + encodeURIComponent(region) + '/pairing');
    if (!d || d.error) throw new Error(d && d.error ? d.error : 'No pairing found');
    showPairingCard(region, d.pairing, '');
  } catch (err) {
    flash(err.message, true);
  }
}

function flash(msg, isErr) {
  const el = document.getElementById('r-msg');
  el.textContent = msg;
  el.className = isErr ? 'error-msg' : 'success-msg';
  el.style.display = '';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function resetForm() {
  document.getElementById('r-id').value = '';
  document.getElementById('r-region').value = '';
  document.getElementById('r-region').disabled = false;
  document.getElementById('r-label').value = '';
  document.getElementById('r-country').value = '';
  document.getElementById('r-cc').value = '';
  document.getElementById('r-lat').value = '';
  document.getElementById('r-lng').value = '';
  document.getElementById('r-host').value = '';
  document.getElementById('r-wgkey').value = '';
  document.getElementById('r-active').checked = true;
  document.getElementById('form-title').textContent = 'New region';
  syncFlag();
}

// Form card is collapsed by default — ➕ New region / a row's Edit open it,
// Cancel and a successful save close it again.
function openFormCard() {
  document.getElementById('region-form').style.display = '';
  document.getElementById('new-region-btn').style.display = 'none';
}

function closeForm() {
  resetForm();
  document.getElementById('region-form').style.display = 'none';
  document.getElementById('new-region-btn').style.display = '';
}

function openNewRegion() {
  resetForm();
  openFormCard();
  document.getElementById('r-region').focus();
}

async function loadPort() {
  try {
    const b = await API.get('/api/public/branding');
    const p = b && b.data && b.data.connection ? b.data.connection.stratum_port : null;
    if (p) STRATUM_PORT = String(p);
  } catch (e) { /* keep 3333 */ }
  document.getElementById('port-suffix').textContent = ':' + STRATUM_PORT;
  // Name the check column after the real port it dials — "Port check" alone is
  // ambiguous next to Region port / WG / node stratum ports.
  const th = document.getElementById('th-portcheck');
  if (th) th.textContent = 'Port :' + STRATUM_PORT;
}

async function loadGateways() {
  _hb = {};
  try {
    const d = await API.get('/api/admin/health/gateways');
    if (d && Array.isArray(d.gateways)) {
      d.gateways.forEach(g => { _hb[g.region] = g; });
    }
  } catch (e) { /* health is best-effort; table still renders config */ }
}

async function loadRegions(silent) {
  const tbody = document.getElementById('regions-tbody');
  if (!silent) tbody.innerHTML = '<tr class="loading-row"><td colspan="10"><span class="spinner"></span>Loading…</td></tr>';
  await loadGateways();
  try {
    const d = await API.get('/api/admin/locations');
    if (!d || d.error) throw new Error(d && d.error ? d.error : 'Failed to load regions');
    _regions = d.locations || [];
    if (!_regions.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="10">No regions yet. Add one with the ➕ New region button below.</td></tr>';
      return;
    }
    tbody.innerHTML = _regions.map(r => {
      const hb = _hb[r.region];
      const flag = flagHtml(r.country_code);
      const country = r.country ? `${flag ? flag + ' ' : ''}${escHtml(r.country)}` : '<span class="dim">—</span>';
      // Where the network map pins this gateway. No pin = country centre; two regions in one
      // country then overlap there, so the hint names the fix.
      const pin = (r.lat != null && r.lng != null)
        ? ` <span class="dim" title="Network map pin: ${escHtml(String(r.lat))}, ${escHtml(String(r.lng))} (edit to change)">📍</span>`
        : ` <span class="dim" title="No map position set — the network map puts this marker on the country centre. Edit → Map latitude/longitude to pin it on its city.">○</span>`;
      const url = r.stratum_url ? `stratum+tcp://${escHtml(r.stratum_url)}` : '<span class="dim">—</span>';
      const minersShares = hb
        ? `${(hb.miners || 0).toLocaleString()} <span class="dim">/ ${(hb.shares_window || 0).toLocaleString()} sh</span>`
        : '—';
      const port = hb && hb.port ? `<span class="mono">${hb.port}</span>` : '<span class="dim">—</span>';
      // Show the EXACT port that was dialed (from this row's stratum_url) — with several
      // port kinds on this page (region port, WG, node stratum), a bare "open" is ambiguous.
      const dialM = r.stratum_url ? String(r.stratum_url).match(/:(\d+)$/) : null;
      const dialPort = dialM ? ':' + dialM[1] : '';
      let portCheck = '<span class="dim" title="No stratum host declared — nothing to dial">—</span>';
      if (hb && hb.stratum_reachable === true) {
        portCheck = `<span class="badge badge-ok" title="Pool box TCP-connected to ${escHtml(r.stratum_url || '')} (what a miner does)">✓ ${dialPort} open${hb.stratum_probe_ms != null ? ' · ' + hb.stratum_probe_ms + 'ms' : ''}</span>`;
      } else if (hb && hb.stratum_reachable === false) {
        portCheck = `<span class="badge badge-error" title="TCP dial to ${escHtml(r.stratum_url || '')} failed (refused / timeout / DNS)">✗ ${dialPort} unreachable</span>`;
      }
      const hiddenTag = r.is_active ? '' : ' <span class="badge badge-dim" title="Hidden from the public connect grid (checkbox in the edit form)">hidden</span>';
      // 🔑 only makes sense when a wg peer exists (tunnel age present) OR a region
      // port is mapped — otherwise there is nothing to re-print.
      const hasPeer = hb && (hb.tunnel_handshake_age != null || hb.port);
      // data-region + this.dataset: escHtml() output inside a JS string literal in an onclick
      // is decoded by the HTML parser before the JS runs, so an apostrophe would break out.
      // `region` is only charset-validated on the wg_pubkey branch of POST /api/admin/locations
      // (index.js), so a metadata-only region can hold any characters at all. Audit §J14.
      const pairingBtn = hasPeer
        ? `<button class="btn-icon" data-region="${escHtml(r.region)}" data-action="show-pairing" data-tip="Show pairing string (GRINGW1|…)" aria-label="Show pairing string for ${escHtml(r.region)}">🔑</button>`
        : '';
      return `
        <tr>
          <td><strong>${escHtml(r.label || r.region)}</strong>${hiddenTag}<br><span class="dim mono">${escHtml(r.region)}</span></td>
          <td>${country}${pin}</td>
          <td class="mono" style="word-break:break-all;">${url}</td>
          <td>${portCheck}</td>
          <td>${tunnelChip(r.region)}</td>
          <td>${statusBadge(r.region)}</td>
          <td>${hb && hb.age_seconds != null ? fmtAge(hb.age_seconds) : '—'}</td>
          <td>${minersShares}</td>
          <td>${port}</td>
          <td>
            <div class="row-actions" style="flex-wrap:nowrap;">
              <button class="btn-icon" data-action="edit-region" data-id="${r.id}" data-tip="Edit region" aria-label="Edit region ${escHtml(r.region)}">✏️</button>
              ${pairingBtn}
              <button class="btn-icon btn-icon-danger" data-action="delete-region" data-id="${r.id}" data-tip="Delete region" aria-label="Delete region ${escHtml(r.region)}">🗑️</button>
            </div>
          </td>
        </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="10">Error: ${escHtml(err.message)}</td></tr>`;
  }
}

function editRegion(id) {
  const r = _regions.find(x => x.id === id);
  if (!r) return;
  document.getElementById('r-id').value = r.id;
  document.getElementById('r-region').value = r.region || '';
  document.getElementById('r-region').disabled = true;   // region key is the identity — don't rename in place
  document.getElementById('r-label').value = r.label || '';
  document.getElementById('r-country').value = r.country || '';
  document.getElementById('r-cc').value = r.country_code || '';
  // Strict null test: 0 is a real coordinate (the equator / Greenwich), `|| ''` would blank it.
  document.getElementById('r-lat').value = r.lat != null ? String(r.lat) : '';
  document.getElementById('r-lng').value = r.lng != null ? String(r.lng) : '';
  document.getElementById('r-host').value = hostOf(r.stratum_url);
  // Keys are never stored/echoed back — leave empty; pasting one here (re-)pairs
  // the gateway on save (same region = keeps its tunnel IP + port).
  document.getElementById('r-wgkey').value = '';
  document.getElementById('r-active').checked = !!r.is_active;
  document.getElementById('form-title').textContent = 'Edit region: ' + r.region;
  openFormCard();
  syncFlag();
  document.getElementById('region-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitRegion() {
  const region = document.getElementById('r-region').value.trim().toLowerCase();
  if (!region) { flash('Region key is required.', true); return; }
  const host = hostOf(document.getElementById('r-host').value.trim());  // strip any port the user typed
  const wgKey = document.getElementById('r-wgkey').value.trim();
  if (wgKey && !/^[A-Za-z0-9+/]{43}=$/.test(wgKey)) {
    flash('That is not a WireGuard public key — expected 44 base64 chars ending "=" (from the gateway box\'s 1) Install).', true);
    return;
  }
  if (wgKey && !/^[a-z0-9-]{2,12}$/.test(region)) {
    flash('A gateway region key must be 2–12 lowercase letters/digits/dashes (it becomes the wg peer tag).', true);
    return;
  }
  // Map pin: both or neither, numeric, in range. Same rule as the server (which is the real
  // gate); checking here just saves a round-trip and names the field in the message.
  const latS = document.getElementById('r-lat').value.trim();
  const lngS = document.getElementById('r-lng').value.trim();
  if ((latS === '') !== (lngS === '')) {
    flash('Map latitude and longitude must be given together (or both left blank).', true);
    return;
  }
  if (latS !== '') {
    const la = Number(latS), lo = Number(lngS);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180) {
      flash('Map position must be decimal degrees: latitude -90..90, longitude -180..180 (e.g. 40.71 / -74.01).', true);
      return;
    }
  }
  const body = {
    region,
    label: document.getElementById('r-label').value.trim(),
    country: document.getElementById('r-country').value.trim(),
    country_code: document.getElementById('r-cc').value.trim().toUpperCase(),
    lat: latS,
    lng: lngS,
    stratum_url: host ? `${host}:${STRATUM_PORT}` : '',
    is_active: document.getElementById('r-active').checked
  };
  if (wgKey) body.wg_pubkey = wgKey;
  // Known-not-ready + a key to pair = a guaranteed 409, and adminFetch would
  // prompt for the step-up password on the way to it. Stop here instead.
  // Strictly `=== false`: null means "never answered", which is not evidence.
  if (body.wg_pubkey && _mrReady === false) {
    flash('Multi-region is not enabled on this pool yet, so the gateway key cannot be paired. '
      + 'Turn it on at the top of this page, then save this region again.', true);
    document.getElementById('mr-banner').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  try {
    // adminFetch (not API.post): pairing a gateway key is step-up gated server-side, so the
    // save must go through the challenge_required → reauth → retry flow (same as delete).
    const res = await adminFetch('/api/admin/locations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const r = res ? await res.json().catch(() => null) : null;
    if (!r || r.error) {
      // 409 wg_server_missing = NOTHING was written (the pre-flight refused before
      // the upsert). Must be checked BEFORE the wg_error branch below, which also
      // matches this body but claims the card was saved — the opposite of the truth.
      if (r && r.wg_server_missing) {
        flash(r.error, true);
        loadServerState();
        document.getElementById('mr-banner').scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      // 502 with wg_error = the region card IS saved; only the pairing failed.
      if (r && r.wg_error) {
        flash('Region saved, but gateway pairing FAILED: ' + r.wg_error, true);
        closeForm();
        loadRegions();
        return;
      }
      throw new Error(r && r.error ? r.error : 'Save failed');
    }
    if (r.pairing) {
      let warn = '';
      if (r.existing) warn = '⚠ This key was already paired — the existing tunnel IP and region port were kept, nothing changed.';
      else if (r.replaced) warn = 'ℹ Gateway key replaced for this region — tunnel IP and port kept, paste the new string on the NEW box.';
      // The peer can be in the config yet absent from the running interface. That
      // gateway will never hand-shake, and the symptom shows up on the OTHER box,
      // so it has to be said here rather than left to look like a pairing fault.
      if (r.sync_warning) warn = (warn ? warn + ' ' : '') + '⚠ ' + r.sync_warning;
      // The stratum listener for this region can fail to bind even when everything else
      // succeeded (port already in use, tunnel IP not up yet). The success line below used to
      // say "listener live" unconditionally, because the backend reported an unconditional
      // success for an asynchronous bind it never waited on (audit §J6-12). If that happened,
      // the region is saved and the peer is configured but NO MINER IN IT CAN CONNECT, and the
      // symptom appears on the gateway box — so it has to be said here.
      if (r.stratum_bind_error) {
        warn = (warn ? warn + ' ' : '') +
          '⚠ The stratum listener for this region did NOT bind: ' + r.stratum_bind_error +
          ' — miners in this region cannot connect until it does. Restart the pool backend after freeing the port.';
      }
      // Stratum is paused (design §21.4): nothing was bound, on purpose. "No error" must not
      // read as "listener live" — it opens when stratum resumes.
      if (r.stratum_bind_deferred) {
        warn = (warn ? warn + ' ' : '') + 'ℹ ' + (r.stratum_bind_note ||
          'Stratum is paused — this region\'s listener opens when stratum resumes.');
      }
      const bindFailed = !!r.stratum_bind_error;
      flash(bindFailed
        ? 'Region saved and peer written — but the region stratum listener did not bind (see below).'
        : r.stratum_bind_deferred
        ? 'Region saved and gateway paired — stratum is paused, so its listener opens when stratum resumes.'
        : (r.sync_warning
          ? 'Region saved and peer written — but the running tunnel did not pick it up (see below).'
          : 'Region saved and gateway paired — listener live, no restart needed.'),
        bindFailed || !!r.sync_warning);
      closeForm();
      showPairingCard(region, r.pairing, warn);
    } else {
      flash('Region saved.', false);
      closeForm();
    }
    loadRegions();
  } catch (err) {
    flash(err.message, true);
  }
}

// Delete is freshAdmin (step-up) → adminFetch handles the re-auth challenge.
// 429 (app rate limit) / 503 (nginx rate limit) are TRANSIENT — the admin shell +
// this page's 60s auto-refresh share the same per-IP budget, so a click can land on
// an exhausted window. Deleting is idempotent, so retry once after a short pause
// (same posture as settings-common.js) instead of surfacing "Too many requests".
async function deleteRegion(id) {
  const r = _regions.find(x => x.id === id);
  if (!confirm(`Delete region "${r ? (r.label || r.region) : id}"? This removes the connect card; the next dialog asks whether to also unpair the gateway's WireGuard peer. Share/credit history is kept either way.`)) return;
  // "Checkbox" as a second confirm (native dialogs can't host one): OK = also
  // revoke the wg peer + region port (full unpair, what W → 4 does over SSH);
  // Cancel = card only, the tunnel keeps working.
  const hb = _hb[r ? r.region : ''];
  const hasPeer = hb && (hb.tunnel_handshake_age != null || hb.port);
  let unpair = false;
  if (hasPeer) {
    unpair = confirm(`Also remove the WireGuard peer (unpair the gateway box for "${r.region}")?\n\nOK = revoke the wg key + free the region port — the gateway box loses its tunnel.\nCancel = keep the tunnel wired, delete only the display card.`);
    if (unpair && hb.tunnel_handshake_age != null && hb.tunnel_handshake_age < 180) {
      if (!confirm(`⚠ This gateway handshook ${hb.tunnel_handshake_age}s ago — it looks LIVE (miners may be routed through it right now). Unpair anyway?`)) return;
    }
  }
  try {
    const url = '/api/admin/locations/' + id + (unpair ? '?remove_peer=1' : '');
    let res = await adminFetch(url, { method: 'DELETE' });
    if (res.status === 429 || res.status === 503) {
      await new Promise(w => setTimeout(w, 2500));
      res = await adminFetch(url, { method: 'DELETE' });
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status === 503) {
      const wait = body.retry_after_seconds || 30;
      throw new Error('Rate-limited right now — wait ~' + wait + 's and try again (nothing was deleted).');
    }
    if (!res.ok || body.error) throw new Error(body.error || ('Delete failed (' + res.status + ')'));
    if (unpair && body.wg_removed === false) {
      flash('Region card deleted, but the WireGuard peer could NOT be removed: ' + (body.wg_error || 'unknown') + ' — retry via Script 07 → W → 4.', true);
    } else if (unpair) {
      flash('Region deleted and gateway unpaired (wg key revoked). The freed listener idles until the next service restart.', false);
    } else {
      flash('Region card deleted — the gateway tunnel (if any) stays wired.', false);
    }
    loadRegions();
  } catch (err) {
    flash(err.message, true);
  }
}

document.addEventListener('DOMContentLoaded', () => { syncFlag(); loadPort(); loadServerState(); loadRegions(); });
// Keep live status fresh (heartbeats update ~60s). Silent = no spinner flash, form untouched.
// Skip while the tab is hidden — background polling burns the shared per-IP rate budget
// that user actions (e.g. Delete) draw from.
setInterval(() => { if (!document.hidden) loadRegions(true); }, 60000);

// ==== F5: event wiring — replaces the inline on*= attributes (strict script-src, no inline handlers).
// One delegated listener per event type; data-action names the handler. Every old handler ignored
// the Event and `this` except where noted, so the wrappers pass exactly the arguments the attribute did.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'enable-multi-region': enableMultiRegion(); break;
    case 'load-regions':        loadRegions(); break;
    case 'copy-pairing':        copyPairing(); break;
    case 'close-pairing-card':  document.getElementById('pairing-card').style.display = 'none'; break;
    case 'open-new-region':     openNewRegion(); break;
    case 'submit-region':       submitRegion(); break;
    case 'close-form':          closeForm(); break;
    case 'show-pairing':        showPairing(el.dataset.region); break;
    case 'edit-region':         editRegion(Number(el.dataset.id)); break;
    case 'delete-region':       deleteRegion(Number(el.dataset.id)); break;
  }
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'sync-flag') syncFlag();
});
