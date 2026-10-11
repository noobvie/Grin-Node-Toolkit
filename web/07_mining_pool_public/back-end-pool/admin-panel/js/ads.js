// ads.html page script — moved BYTE-verbatim out of the page's inline <script> (code-layout F4).
// Classic script (no defer/module) loaded at the same position as the old block, after auth.js, api.js and admin-shell.js, whose globals it uses (H14).
API.guardAdminPage();

let _ads = [];   // last-loaded ads, looked up by id (avoids inlining objects into onclick attrs)

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
const PLACEMENT_LABEL = { header:'Header', sidebar:'Sidebar', 'in-content':'In-content', footer:'Footer' };

// Creative spec per placement — drives the hint box, the option labels and the
// dimension check in the live preview. Sizes follow the IAB standards the slot CSS
// was built around; anything else still renders but is scaled to fit the slot.
const PLACEMENT_SPEC = {
  header:       { w:728, h:90,  alt:'970×90 also fits',  note:'Top of every public page; scales down responsively on mobile.' },
  sidebar:      { w:160, h:600, alt:'120×600 also fits', note:'Fixed edge rail in the page margin on screens ≥1366 px (renders 108–168 px wide, so use a tall vector). Not shown at all below 1366 px — put mobile inventory in the other placements.' },
  'in-content': { w:728, h:90,  alt:'468×60 also fits',  note:'Inside the homepage content flow.' },
  footer:       { w:728, h:90,  alt:'970×90 also fits',  note:'Bottom of every public page.' }
};

// Self-promo SVGs shipped in public_html/promo/ (auto-seeded once on a fresh pool).
// `link` matches what the seeder writes, so picking a starter here reproduces the shipped
// ad exactly — including the ones that deliberately have NO click-through. A creative
// whose only possible target is the page the visitor is already on (the connect panel,
// the info section) is left unlinked rather than reloading the homepage under them; the
// rest point at another page of the site, or off-site where the creative's question is
// actually answered. Fill the Link field in yourself to change any of that.
const STARTERS = [
  { file:'/promo/grinium-mine-728x90.svg',        size:'728×90',  placement:'header', link:'',
    name:'GRINIUM promo — Mine GRIN (header 728×90)',
    alt:'Mine GRIN on GRINIUM — no sign-up, PPLNS rewards, your address is your account' },
  { file:'/promo/grinium-why-grin-728x90.svg',    size:'728×90',  placement:'header',
    link:'https://grin.money/#why-grin',
    name:'GRINIUM promo — Why GRIN? (header 728×90)',
    alt:'Why GRIN? No ICO, no premine, tail emission, private by default' },
  { file:'/promo/grinium-join-team-728x90.svg',   size:'728×90',  placement:'header',
    link:'https://forum.grin.mw',
    name:'GRINIUM promo — Join the Grin team (header 728×90)',
    alt:'Join the Grin community — dev, marketing, AI, mining and trading talk on the Grin forum' },
  { file:'/promo/grinium-mine-160x600.svg',       size:'160×600', placement:'sidebar', link:'',
    name:'GRINIUM rail — Mine here (160×600)',
    alt:'Mine GRIN here — no sign-up, PPLNS rewards, anonymous Tor payouts' },
  { file:'/promo/grinium-why-grin-160x600.svg',   size:'160×600', placement:'sidebar',
    link:'https://grin.money/#why-grin',
    name:'GRINIUM rail — Why GRIN? (160×600)',
    alt:'Why GRIN? Private by default, no addresses on chain, fair launch, no premine' },
  { file:'/promo/grinium-buy-grin-160x600.svg',   size:'160×600', placement:'sidebar',
    link:'https://www.gate.com/trade/GRIN_USDT',
    name:'GRINIUM rail — Buy GRIN (160×600)',
    alt:'Buy GRIN — trade the GRIN/USDT market, or earn it by pointing a miner here' },
  { file:'/promo/grinium-fortune-160x600.svg',    size:'160×600', placement:'sidebar',
    link:'/fortune-board.html',
    name:'GRINIUM rail — Feeling lucky? (160×600)',
    alt:'Feeling lucky? Block jackpots, prize draws, streak rewards and a monthly lottery' },
  { file:'/promo/grinium-privacy-160x600.svg',    size:'160×600', placement:'sidebar', link:'',
    name:'GRINIUM rail — Anonymous (160×600)',
    alt:'Mine anonymously — no accounts, no emails, Tor payouts' },
  { file:'/promo/grinium-fortune-300x250.svg',    size:'300×250', placement:'in-content',
    link:'/fortune-board.html',
    name:'GRINIUM promo — Fortune board (in-content 300×250)',
    alt:'Feeling lucky? Block jackpots, prize draws, streak rewards and a monthly lottery' },
  { file:'/promo/grinium-privacy-300x250.svg',    size:'300×250', placement:'in-content',
    link:'/payment-history.html',
    name:'GRINIUM promo — Anonymous mining (in-content 300×250)',
    alt:'Mine anonymously — no accounts, no emails — see every pool payout' },
  { file:'/promo/grinium-donate-728x90.svg',      size:'728×90',  placement:'footer',
    link:'/donate.html',
    name:'GRINIUM promo — Donate (footer 728×90)',
    alt:'Keep the reactor running — donate GRIN and join the donor wall' }
];

function syncPlacement() {
  const spec = PLACEMENT_SPEC[document.getElementById('ad-placement').value] || PLACEMENT_SPEC.header;
  document.getElementById('spec-size').textContent = `${spec.w}×${spec.h}`;
  document.getElementById('spec-alt').textContent = `(${spec.alt})`;
  document.getElementById('spec-note').textContent = spec.note;
  updatePreview(); // re-check the loaded image against the newly selected placement
}

// Live preview: render the image, report its intrinsic size + file type, and compare
// against the placement spec. Informative only — an off-spec banner still saves (the
// slot CSS scales it), but the operator should know it will be resized.
function updatePreview() {
  const url = document.getElementById('ad-image').value.trim();
  const box = document.getElementById('img-preview');
  const img = document.getElementById('preview-img');
  const meta = document.getElementById('preview-meta');
  // syncPlacement() calls this on every placement change — a stale image URL left in
  // the field must not surface a banner preview while a text/code type is selected.
  if (document.getElementById('ad-type').value !== 'banner') {
    box.style.display = 'none'; refreshPreviewPanel(); return;
  }
  if (!url) { box.style.display = 'none'; img.removeAttribute('src'); refreshPreviewPanel(); return; }
  const spec = PLACEMENT_SPEC[document.getElementById('ad-placement').value] || PLACEMENT_SPEC.header;
  const extMatch = url.split('?')[0].split('#')[0].match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1].toUpperCase() : '?';
  img.onload = () => {
    const w = img.naturalWidth, h = img.naturalHeight;
    const match = w === spec.w && h === spec.h;
    meta.innerHTML = `${w}×${h} px · ${escHtml(ext)} · ` + (match
      ? '<span class="ok-note">matches the recommended size ✓</span>'
      : `<span class="warn-note">recommended for this placement is ${spec.w}×${spec.h} — the image will be scaled to fit</span>`);
  };
  img.onerror = () => { meta.innerHTML = '<span class="warn-note">image failed to load — check the URL</span>'; };
  meta.textContent = 'loading…';
  img.src = url;
  box.style.display = '';
  refreshPreviewPanel();
}

// Upload a local file via the shared CMS media endpoint (multer-validated, stored in
// the persistent /uploads dir) and drop the returned URL into the image field.
async function uploadBanner(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const btn = document.getElementById('upload-btn');
  btn.disabled = true; btn.textContent = 'Uploading…';
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/admin/media', { method: 'POST', body: fd, credentials: 'include' });
    let json = null;
    try { json = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok || !json || !json.url) throw new Error((json && json.error) || `upload failed (${res.status})`);
    document.getElementById('ad-image').value = json.url;
    updatePreview();
    flash('Image uploaded.', false);
  } catch (err) {
    flash(err.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Upload…';
  }
}

function renderStarters() {
  document.getElementById('starter-grid').innerHTML = STARTERS.map((s, i) => `
    <div class="starter-card">
      <img src="${escHtml(s.file)}" alt="${escHtml(s.alt)}" loading="lazy">
      <div class="s-name">${escHtml(s.name.replace(/^GRINIUM promo — /, ''))}</div>
      <div class="s-meta">${escHtml(s.size)} · SVG · ${escHtml(PLACEMENT_LABEL[s.placement])}</div>
      <button class="btn btn-sm btn-outline" data-action="use-starter" data-index="${i}">Use in form</button>
    </div>`).join('');
}

// Prefill the create form from a starter card (always as a NEW ad).
function useStarter(i) {
  const s = STARTERS[i];
  if (!s) return;
  resetForm();
  document.getElementById('ad-name').value = s.name;
  document.getElementById('ad-placement').value = s.placement;
  document.getElementById('ad-type').value = 'banner';
  document.getElementById('ad-image').value = s.file;
  document.getElementById('ad-link').value = s.link;
  document.getElementById('ad-alt').value = s.alt;
  syncType();
  syncPlacement();
  document.getElementById('ad-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toLocalInput(unix) {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}
function fmtWindow(a) {
  const s = a.start_at ? new Date(a.start_at * 1000).toLocaleDateString() : null;
  const e = a.end_at ? new Date(a.end_at * 1000).toLocaleDateString() : null;
  if (!s && !e) return 'always';
  return `${s || '…'} → ${e || '…'}`;
}

function syncType() {
  const t = document.getElementById('ad-type').value;
  document.getElementById('banner-fields').style.display = t === 'banner' ? '' : 'none';
  document.getElementById('text-fields').style.display   = t === 'text' ? '' : 'none';
  // The size/file-type spec box only makes sense for image banners.
  document.getElementById('placement-spec').style.display = t === 'banner' ? '' : 'none';
  // Refresh whichever preview belongs to the new type; the other one is hidden by
  // its own updater / by refreshPreviewPanel.
  if (t === 'banner') updatePreview();
  else document.getElementById('img-preview').style.display = 'none';
  if (t === 'text') updateTextPreview();
  else document.getElementById('text-preview').style.display = 'none';
  refreshPreviewPanel();
}

// Decide what the preview panel below Save shows: the banner image, the composed text
// card, or a hint telling the operator what is still missing.
function refreshPreviewPanel() {
  const t = document.getElementById('ad-type').value;
  const imgOn  = t === 'banner' && document.getElementById('img-preview').style.display !== 'none';
  const textOn = t === 'text'   && document.getElementById('text-preview').style.display !== 'none';
  const hint = document.getElementById('preview-hint');
  const sub  = document.getElementById('preview-sub');
  let msg = '';
  if (t === 'banner' && !imgOn) msg = 'Add an image URL (or upload a file) to preview the banner.';
  else if (t === 'text' && !textOn) msg = 'Type a headline, body line or button label to preview the card.';
  hint.textContent = msg;
  hint.style.display = msg ? '' : 'none';
  const place = PLACEMENT_LABEL[document.getElementById('ad-placement').value] || '';
  sub.textContent = place ? `— ${place} placement, ${t} ad` : '';
}

// Live preview of the composed text card (headline + body + CTA).
function updateTextPreview() {
  const head = document.getElementById('ad-headline').value.trim();
  const body = document.getElementById('ad-body').value.trim();
  const cta  = document.getElementById('ad-cta').value.trim();
  const box  = document.getElementById('text-preview');
  if (!head && !body && !cta) { box.style.display = 'none'; refreshPreviewPanel(); return; }
  document.getElementById('tp-head').textContent = head;
  document.getElementById('tp-body').textContent = body;
  document.getElementById('tp-cta').textContent  = cta;
  box.style.display = '';
  refreshPreviewPanel();
}

function flash(msg, isErr) {
  const el = document.getElementById('ad-msg');
  el.textContent = msg;
  el.className = isErr ? 'error-msg' : 'success-msg';
  el.style.display = '';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function resetForm() {
  document.getElementById('ad-id').value = '';
  document.getElementById('ad-name').value = '';
  document.getElementById('ad-placement').value = 'header';
  document.getElementById('ad-type').value = 'banner';
  document.getElementById('ad-image').value = '';
  document.getElementById('ad-link').value = '';
  document.getElementById('ad-alt').value = '';
  document.getElementById('ad-headline').value = '';
  document.getElementById('ad-body').value = '';
  document.getElementById('ad-cta').value = '';
  document.getElementById('ad-text-link').value = '';
  document.getElementById('text-preview').style.display = 'none';
  document.getElementById('ad-notes').value = '';
  document.getElementById('ad-weight').value = '0';
  document.getElementById('ad-start').value = '';
  document.getElementById('ad-end').value = '';
  document.getElementById('ad-active').checked = true;
  document.getElementById('form-title').textContent = 'New ad';
  document.getElementById('cancel-btn').style.display = 'none';
  syncType();
  syncPlacement();
}

// Effective status: what the PUBLIC site does with this ad right now — an active ad
// outside its window doesn't show, and the plain On/Off flag used to hide that.
function statusOf(a) {
  const now = Math.floor(Date.now() / 1000);
  // A legacy code ad is never served, whatever its flags say (design §19.17 D22).
  if (a.removed) return ['Unsupported (removed)', 'badge-dim'];
  if (!a.is_active) return ['Off', 'badge-dim'];
  if (a.start_at && a.start_at > now) return ['Scheduled', 'badge-warn'];
  if (a.end_at && a.end_at < now) return ['Expired', 'badge-warn'];
  return ['On', 'badge-ok'];
}

// Audit §J14-9 / §J10-3: these two numbers are bumped by POST /api/public/ads/event, which is
// unauthenticated and undeduped on purpose (the pool stores no per-visitor rows, so it cannot
// tell a real impression from a scripted one). A bare "4.5%" reads as a measurement, so the
// ratio is rendered approximate and the column + the note above the table say "unverified".
// Do not remove those qualifiers while the beacon stays open — an operator who bills a sponsor
// from this column is billing from an attacker-writable number.
function fmtStats(a) {
  const v = a.impressions || 0, c = a.clicks || 0;
  const ctr = v > 0 ? ` (~${(c / v * 100).toFixed(1)}%)` : '';
  return `${v.toLocaleString()} / ${c.toLocaleString()}${ctr}`;
}

async function loadAds() {
  const tbody = document.getElementById('ads-tbody');
  try {
    const d = await API.get('/api/admin/ads');
    if (!d || d.error) throw new Error(d && d.error ? d.error : 'Failed to load ads');
    _ads = d.ads || [];
    applyConfig(d.config);
    renderTable();
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">Error: ${escHtml(err.message)}</td></tr>`;
  }
}

function renderTable() {
  const tbody = document.getElementById('ads-tbody');
  const filter = document.getElementById('filter-placement').value;
  const rows = filter ? _ads.filter(a => a.placement === filter) : _ads;
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">${_ads.length ? 'No ads in this placement.' : 'No ads yet. Create one in the form below.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(a => {
    const [label, cls] = statusOf(a);
    return `
      <tr>
        <td>${a.ad_type === 'banner' && a.image_url
              ? `<img class="ad-thumb" src="${escHtml(a.image_url)}" alt="" loading="lazy" data-fallback="broken-img">`
              : a.ad_type === 'text'
              ? `<span class="ad-thumb-code" title="${escHtml(a.headline || '')}">“${escHtml((a.headline || 'text ad').slice(0, 18))}”</span>`
              : '<span class="ad-thumb-code" title="Code ads were removed for security — design §19.17 D22. This one is never shown; delete it.">code — removed</span>'}</td>
        <td>${escHtml(a.name)}${a.notes ? `<span class="notes-flag" title="${escHtml(a.notes)}">📝</span>` : ''}</td>
        <td>${escHtml(PLACEMENT_LABEL[a.placement] || a.placement)}</td>
        <td>${escHtml(a.ad_type)}</td>
        <td><span class="badge ${cls}">${label}</span></td>
        <td class="mono">${a.weight}</td>
        <td>${escHtml(fmtWindow(a))}</td>
        <td class="stats-cell" title="Unverified client-reported counters — see the note above the table.">${escHtml(fmtStats(a))}</td>
        <td>
          <div class="row-actions">
            ${a.removed ? '' : `<button class="btn-icon" data-action="edit-ad" data-id="${a.id}" data-tip="Edit this ad" aria-label="Edit this ad">✏️</button>
            <button class="btn-icon" data-action="duplicate-ad" data-id="${a.id}" data-tip="Duplicate as a new ad" aria-label="Duplicate as a new ad">📋</button>
            <button class="btn-icon" data-action="toggle-ad" data-id="${a.id}" data-tip="${a.is_active ? 'Turn off (stop showing it)' : 'Turn on (start showing it)'}" aria-label="${a.is_active ? 'Turn off' : 'Turn on'}">${a.is_active ? '⏸️' : '▶️'}</button>`}
            <button class="btn-icon btn-icon-danger" data-action="delete-ad" data-id="${a.id}" data-tip="Delete this ad" aria-label="Delete this ad">🗑️</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

// Quick on/off without opening the edit form (backend partial update).
async function toggleAd(id) {
  const a = _ads.find(x => x.id === id);
  if (!a) return;
  try {
    const r = await API.post('/api/admin/ads/' + id, { is_active: a.is_active ? 0 : 1 });
    if (!r || r.error) throw new Error(r && r.error ? r.error : 'Update failed');
    flash(a.is_active ? `"${a.name}" turned off.` : `"${a.name}" turned on.`, false);
    loadAds();
  } catch (err) { flash(err.message, true); }
}

// Prefill the form as a NEW ad copied from an existing one (nothing saved until Save).
function duplicateAd(id) {
  const a = _ads.find(x => x.id === id);
  if (!a || a.removed) return;
  resetForm();
  document.getElementById('ad-name').value = (a.name || '') + ' (copy)';
  document.getElementById('ad-placement').value = a.placement || 'header';
  document.getElementById('ad-type').value = a.ad_type || 'banner';
  document.getElementById('ad-image').value = a.image_url || '';
  document.getElementById('ad-link').value = a.link_url || '';
  document.getElementById('ad-text-link').value = a.link_url || '';
  document.getElementById('ad-alt').value = a.alt_text || '';
  document.getElementById('ad-headline').value = a.headline || '';
  document.getElementById('ad-body').value = a.body_text || '';
  document.getElementById('ad-cta').value = a.cta_label || '';
  document.getElementById('ad-notes').value = a.notes || '';
  document.getElementById('ad-weight').value = a.weight != null ? a.weight : 0;
  document.getElementById('form-title').textContent = `New ad (copy of #${a.id})`;
  syncType();
  syncPlacement();
  document.getElementById('ad-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Reflect the stored render settings into the toolbar controls.
function applyConfig(c) {
  if (!c) return;
  if (c.rotate_ms > 0) {
    document.getElementById('rotate-secs').value = Math.round(c.rotate_ms / 1000);
    document.getElementById('rotate-now').textContent = Math.round(c.rotate_ms / 1000);
  }
  if (c.sidebar_mode) document.getElementById('sidebar-mode').value = c.sidebar_mode;
  if (c.rail_show_ms > 0) document.getElementById('rail-show-secs').value = Math.round(c.rail_show_ms / 1000);
  if (typeof c.rail_hide_ms === 'number') document.getElementById('rail-hide-secs').value = Math.round(c.rail_hide_ms / 1000);
}

// One save for every public render setting (rotation + sidebar rail layout).
async function saveAdsConfig() {
  const rotate = parseInt(document.getElementById('rotate-secs').value, 10);
  const show   = parseInt(document.getElementById('rail-show-secs').value, 10);
  const hide   = parseInt(document.getElementById('rail-hide-secs').value, 10);
  if (!Number.isInteger(rotate) || rotate < 2 || rotate > 60) { flash('Rotation interval must be 2–60 seconds.', true); return; }
  if (!Number.isInteger(show) || show < 3 || show > 120) { flash('Rail show time must be 3–120 seconds.', true); return; }
  if (!Number.isInteger(hide) || hide < 0 || hide > 600) { flash('Rail tuck time must be 0–600 seconds (0 = never tuck).', true); return; }
  try {
    const r = await API.post('/api/admin/ads-config', {
      rotate_ms: rotate * 1000,
      sidebar_mode: document.getElementById('sidebar-mode').value,
      rail_show_ms: show * 1000,
      rail_hide_ms: hide * 1000
    });
    if (!r || r.error) throw new Error(r && r.error ? r.error : 'Save failed');
    applyConfig(r.config);
    flash('Ad layout saved (public pages pick it up within ~1 min).', false);
  } catch (err) { flash(err.message, true); }
}

function editAd(id) {
  const a = _ads.find(x => x.id === id);
  if (!a || a.removed) return;
  document.getElementById('ad-id').value = a.id;
  document.getElementById('ad-name').value = a.name || '';
  document.getElementById('ad-placement').value = a.placement || 'header';
  document.getElementById('ad-type').value = a.ad_type || 'banner';
  document.getElementById('ad-image').value = a.image_url || '';
  document.getElementById('ad-link').value = a.link_url || '';
  document.getElementById('ad-text-link').value = a.link_url || '';
  document.getElementById('ad-alt').value = a.alt_text || '';
  document.getElementById('ad-headline').value = a.headline || '';
  document.getElementById('ad-body').value = a.body_text || '';
  document.getElementById('ad-cta').value = a.cta_label || '';
  document.getElementById('ad-notes').value = a.notes || '';
  document.getElementById('ad-weight').value = a.weight != null ? a.weight : 0;
  document.getElementById('ad-start').value = toLocalInput(a.start_at);
  document.getElementById('ad-end').value = toLocalInput(a.end_at);
  document.getElementById('ad-active').checked = !!a.is_active;
  document.getElementById('form-title').textContent = 'Edit ad #' + a.id;
  document.getElementById('cancel-btn').style.display = '';
  syncType();
  syncPlacement();
  document.getElementById('ad-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitAd() {
  const id = document.getElementById('ad-id').value;
  const type = document.getElementById('ad-type').value;
  // The click-through comes from the banner Link field or the text-card Link field
  // depending on the ad type.
  const linkUrl = (type === 'text'
    ? document.getElementById('ad-text-link').value
    : document.getElementById('ad-link').value).trim();
  const body = {
    name: document.getElementById('ad-name').value.trim(),
    placement: document.getElementById('ad-placement').value,
    ad_type: type,
    image_url: document.getElementById('ad-image').value.trim(),
    link_url: linkUrl,
    alt_text: document.getElementById('ad-alt').value.trim(),
    headline: document.getElementById('ad-headline').value.trim(),
    body_text: document.getElementById('ad-body').value.trim(),
    cta_label: document.getElementById('ad-cta').value.trim(),
    notes: document.getElementById('ad-notes').value.trim(),
    weight: parseInt(document.getElementById('ad-weight').value, 10) || 0,
    start_at: fromLocalInput(document.getElementById('ad-start').value),
    end_at: fromLocalInput(document.getElementById('ad-end').value),
    is_active: document.getElementById('ad-active').checked
  };
  try {
    const r = id ? await API.post('/api/admin/ads/' + id, body)
                 : await API.post('/api/admin/ads', body);
    if (!r || r.error) throw new Error(r && r.error ? r.error : 'Save failed');
    flash('Ad saved.', false);
    resetForm();
    loadAds();
  } catch (err) {
    flash(err.message, true);
  }
}

async function deleteAd(id) {
  const a = _ads.find(x => x.id === id);
  if (!confirm(`Delete ad "${a ? a.name : id}"?`)) return;
  try {
    const r = await API.del('/api/admin/ads/' + id);
    if (!r || r.error) throw new Error(r && r.error ? r.error : 'Delete failed');
    flash('Ad deleted.', false);
    loadAds();
  } catch (err) {
    flash(err.message, true);
  }
}

document.addEventListener('DOMContentLoaded', () => { syncType(); syncPlacement(); renderStarters(); loadAds(); });

// ==== F4: event wiring — replaces the on*= attributes (inline handlers are blocked by a strict script-src) ====
document.addEventListener('click', function (e) {
  var el = e.target.closest && e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'save-ads-config': saveAdsConfig(); break;
    case 'pick-upload': document.getElementById('ad-upload').click(); break;
    case 'submit-ad': submitAd(); break;
    case 'reset-form': resetForm(); break;
    case 'use-starter': useStarter(Number(el.dataset.index)); break;
    case 'edit-ad': editAd(Number(el.dataset.id)); break;
    case 'duplicate-ad': duplicateAd(Number(el.dataset.id)); break;
    case 'toggle-ad': toggleAd(Number(el.dataset.id)); break;
    case 'delete-ad': deleteAd(Number(el.dataset.id)); break;
  }
});
document.addEventListener('change', function (e) {
  var el = e.target.closest && e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'render-table': renderTable(); break;
    case 'sync-placement': syncPlacement(); break;
    case 'sync-type': syncType(); break;
    case 'upload-banner': uploadBanner(el); break;
  }
});
document.addEventListener('input', function (e) {
  var el = e.target.closest && e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'update-preview': updatePreview(); break;
    case 'update-text-preview': updateTextPreview(); break;
  }
});
// <img onerror> does not bubble: a capturing listener on document is the delegated equivalent.
document.addEventListener('error', function (e) {
  var el = e.target;
  if (el && el.tagName === 'IMG' && el.getAttribute('data-fallback') === 'broken-img') {
    el.outerHTML = '<span class="ad-thumb-code">broken img</span>';
  }
}, true);
