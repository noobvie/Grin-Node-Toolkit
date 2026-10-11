// games-events.html page script — moved BYTE-verbatim out of the page's inline script block (code-layout F5).
// Classic script (no defer/module) loaded at the same position as the old block, after the <script src> tags before it, whose globals it uses (H14).
// Games → Events (design §19.9, §19.11). Every call goes through the pool's admin proxy
// (/api/admin/games/* → games /internal/admin/*). Create and update are plain admin writes;
// cancel and finalise-now need step-up, which the POOL enforces before proxying — adminFetch
// (stepup.js) shows the in-page password dialog when the pool asks. No native dialogs.
API.guardAdminPage();

const DAY = 86400;
let _meta = null;          // { kinds, badges, games, limits }
let _events = [];
let _state = '';
let _editing = null;       // the event being edited, or null for a new one

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function flash(id, msg, isErr) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = isErr ? 'error-msg' : 'success-msg';
  el.style.display = msg ? '' : 'none';
  if (msg) setTimeout(() => { if (el.textContent === msg) el.style.display = 'none'; }, isErr ? 12000 : 6000);
}
// YYYY-MM-DD (a date input, read as UTC) ↔ unix seconds at 00:00 UTC.
function dayToEpoch(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return null;
  const ms = Date.parse(v + 'T00:00:00Z');
  return isNaN(ms) ? null : ms / 1000;
}
function epochToDay(s) { return new Date(s * 1000).toISOString().slice(0, 10); }
function todayDay() { return new Date().toISOString().slice(0, 10); }

// ── Proxy calls ────────────────────────────────────────────────────────────────────────
// Not API.get: Auth.fetch sends the admin to the login page on ANY 401, and the proxy passes
// the games service's own 401 (a link-secret mismatch) through. A games answer always has an
// `ok` field; the pool's own 401 (session expired) never does — that is how the two differ.
const FIELD_TEXT = {
  kind: 'Kind', title: 'Title (1–60 characters; no control or direction-override characters)',
  starts_at: 'First day (today or later, at most a year ahead)', ends_at: 'Last day (after the first day, at most 366 days, not already over)',
  body: 'The request', rules: 'Rules', reward: 'Rewards', 'reward.tiers': 'Reward tiers (at most 10)',
  'reward.tiers.rank_from': 'Reward tiers: ranks must go up and must not overlap',
  'reward.tiers.rank_to': 'Reward tiers: "to rank" must be ≥ "from rank" (max 1000)',
  'reward.tiers.points': 'Reward tiers: points must be 0–10000', 'reward.tiers.badge': 'Reward tiers: badge',
  'reward.participation.min_value': 'Participation: minimum value', 'reward.participation.points': 'Participation: points (0–1000)',
  reason: 'Reason',
};
const ERROR_TEXT = {
  games_offline: 'The games service is not answering. Mining is unaffected; check the service under P) Play & chat in the Script 07 pool menu.',
  link_not_configured: 'The games link is not set up. Install or repair the games from P) Play & chat in the Script 07 pool menu.',
  unauthorised: 'The pool and the games service disagree on the link secret. Rotate it from P) Play & chat → 7 in the Script 07 pool menu.',
  games_bad_response: 'The games service sent an unreadable answer.',
};
async function games(method, rel, body) {
  const opts = { method, credentials: 'include', headers: { Accept: 'application/json' } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await adminFetch('/api/admin/games/' + rel, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (res.status === 401 && !(data && data.ok === false)) {
    window.location.href = '/login.html';
    throw new Error('Your admin session has ended.');
  }
  if (res.ok && data && data.ok === true) return data;
  const code = data && data.error;
  let msg = ERROR_TEXT[code] || (data && (data.message || data.error)) || ('HTTP ' + res.status);
  if (code === 'bad_request' && data.field) {
    const f = String(data.field);
    msg = 'Check: ' + (FIELD_TEXT[f] || (f.startsWith('rules.') ? 'Rules — ' + f.slice(6).replace(/_/g, ' ') : f));
  }
  const err = new Error(msg);
  err.code = code;
  err.status = res.status;
  throw err;
}

// ── Form ───────────────────────────────────────────────────────────────────────────────
function kindOf(name) { return (_meta.kinds || []).find(k => k.kind === name) || null; }
function badgeOptions(sel, value) {
  sel.textContent = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— none —';
  sel.appendChild(none);
  (_meta.badges || []).forEach(b => {
    const o = document.createElement('option');
    o.value = b.id;
    o.textContent = b.label;
    sel.appendChild(o);
  });
  sel.value = value || '';
}

// Kind-specific rule inputs, built from the kind's `fields` (game / enum / int).
function renderRuleFields(rules) {
  const box = document.getElementById('ge-rule-fields');
  box.textContent = '';
  const kind = kindOf(document.getElementById('ge-kind').value);
  document.getElementById('ge-kind-help').textContent = kind ? kindHelp(kind.kind) : '';
  document.getElementById('ge-part-min-label').textContent = 'Minimum value' + (kind && kind.unit ? ' (' + kind.unit + ')' : '');
  if (!kind) return;
  (kind.fields || []).forEach(f => {
    const g = document.createElement('div');
    g.className = 'form-group';
    const lab = document.createElement('label');
    lab.htmlFor = 'ge-rule-' + f.key;
    lab.textContent = f.label;
    let input;
    if (f.type === 'game' || f.type === 'enum') {
      input = document.createElement('select');
      const opts = f.type === 'game' ? (_meta.games || []).map(x => [x.id, x.title]) : f.values.map(v => [v, v]);
      opts.forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; input.appendChild(o); });
    } else {
      input = document.createElement('input');
      input.type = 'number';
      input.min = f.min; input.max = f.max; input.step = 1;
      input.value = f.def;
    }
    input.id = 'ge-rule-' + f.key;
    input.className = 'settings-skip';
    input.dataset.key = f.key;
    input.dataset.type = f.type;
    if (rules && rules[f.key] !== undefined) input.value = String(rules[f.key]);
    g.appendChild(lab);
    g.appendChild(input);
    box.appendChild(g);
  });
}
function kindHelp(k) {
  return {
    mining_minutes: 'Ranks addresses by active mining minutes at this pool in the window. Cheat-proof: the pool verified every share.',
    active_days: 'Ranks addresses by the number of days in the window on which they mined at least the minutes below.',
    game_results: 'Ranks addresses by wins or match points in one game and mode. Points are what matches actually paid (after the daily cap).',
  }[k] || '';
}
function readRules() {
  const out = {};
  document.querySelectorAll('#ge-rule-fields [data-key]').forEach(el => {
    out[el.dataset.key] = el.dataset.type === 'int' ? Number(el.value) : el.value;
  });
  return out;
}

function tierRow(t) {
  const tr = document.createElement('tr');
  const num = (cls, v, min, max) => {
    const td = document.createElement('td');
    const i = document.createElement('input');
    i.type = 'number'; i.min = min; i.max = max; i.step = 1; i.className = 'settings-skip ' + cls; i.value = v;
    td.appendChild(i);
    return td;
  };
  tr.appendChild(num('t-from', t.rank_from, 1, 1000));
  tr.appendChild(num('t-to', t.rank_to, 1, 1000));
  tr.appendChild(num('t-points', t.points, 0, 10000));
  const tdB = document.createElement('td');
  const sel = document.createElement('select');
  sel.className = 'settings-skip t-badge';
  badgeOptions(sel, t.badge);
  tdB.appendChild(sel);
  tr.appendChild(tdB);
  const tdX = document.createElement('td');
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'btn btn-outline btn-sm'; x.textContent = 'Remove';
  x.addEventListener('click', () => tr.remove());
  tdX.appendChild(x);
  tr.appendChild(tdX);
  return tr;
}
function setTiers(tiers) {
  const tb = document.getElementById('ge-tiers');
  tb.textContent = '';
  tiers.forEach(t => tb.appendChild(tierRow(t)));
}
document.getElementById('ge-add-tier').addEventListener('click', () => {
  const tb = document.getElementById('ge-tiers');
  if (tb.children.length >= ((_meta && _meta.limits && _meta.limits.max_tiers) || 10)) return;
  const last = tb.lastElementChild;
  const from = last ? Number(last.querySelector('.t-to').value) + 1 : 1;
  tb.appendChild(tierRow({ rank_from: from, rank_to: from, points: 0, badge: '' }));
});
function readReward() {
  const tiers = [...document.querySelectorAll('#ge-tiers tr')].map(tr => {
    const b = tr.querySelector('.t-badge').value;
    return { rank_from: Number(tr.querySelector('.t-from').value), rank_to: Number(tr.querySelector('.t-to').value),
             points: Number(tr.querySelector('.t-points').value), badge: b || null };
  });
  const on = document.getElementById('ge-part-on').checked;
  return {
    tiers,
    participation: on ? {
      min_value: Number(document.getElementById('ge-part-min').value),
      points: Number(document.getElementById('ge-part-points').value),
      badge: document.getElementById('ge-part-badge').value || null,
    } : null,
  };
}
document.getElementById('ge-part-on').addEventListener('change', e => {
  document.getElementById('ge-part-fields').hidden = !e.target.checked;
});

function resetForm() {
  _editing = null;
  document.getElementById('ge-form-title').textContent = 'New event';
  document.getElementById('ge-save').textContent = 'Create event';
  document.getElementById('ge-lock-note').style.display = 'none';
  const kindSel = document.getElementById('ge-kind');
  kindSel.value = (_meta.kinds[0] || {}).kind || '';
  document.getElementById('ge-title-input').value = '';
  document.getElementById('ge-first').value = todayDay();
  document.getElementById('ge-last').value = epochToDay(dayToEpoch(todayDay()) + 6 * DAY);
  setTiers([{ rank_from: 1, rank_to: 1, points: 50, badge: 'gold' }, { rank_from: 2, rank_to: 2, points: 30, badge: 'silver' },
            { rank_from: 3, rank_to: 3, points: 20, badge: 'bronze' }]);
  document.getElementById('ge-part-on').checked = false;
  document.getElementById('ge-part-fields').hidden = true;
  badgeOptions(document.getElementById('ge-part-badge'), 'took_part');
  renderRuleFields(null);
  lockFields(false);
}
function lockFields(on) {
  ['ge-kind', 'ge-first'].forEach(id => { document.getElementById(id).disabled = on; });
  document.querySelectorAll('#ge-rule-fields [data-key]').forEach(el => { el.disabled = on; });
  document.getElementById('ge-rule-fields').classList.toggle('ge-locked', on);
}
function editEvent(ev) {
  _editing = ev;
  document.getElementById('ge-form-title').textContent = 'Edit event #' + ev.id;
  document.getElementById('ge-save').textContent = 'Save changes';
  document.getElementById('ge-kind').value = ev.kind;
  document.getElementById('ge-title-input').value = ev.title;
  document.getElementById('ge-first').value = ev.first_day;
  document.getElementById('ge-last').value = ev.last_day;
  renderRuleFields(ev.rules);
  setTiers(ev.reward.tiers.map(t => ({ rank_from: t.rank_from, rank_to: t.rank_to, points: t.points, badge: t.badge })));
  const p = ev.reward.participation;
  document.getElementById('ge-part-on').checked = !!p;
  document.getElementById('ge-part-fields').hidden = !p;
  if (p) {
    document.getElementById('ge-part-min').value = p.min_value;
    document.getElementById('ge-part-points').value = p.points;
  }
  badgeOptions(document.getElementById('ge-part-badge'), p ? p.badge : 'took_part');
  const running = ev.state === 'running';
  lockFields(running);
  document.getElementById('ge-lock-note').style.display = running ? '' : 'none';
  document.getElementById('ge-form-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
}
document.getElementById('ge-kind').addEventListener('change', () => renderRuleFields(null));
document.getElementById('ge-reset').addEventListener('click', () => { resetForm(); flash('ge-form-msg', ''); });

document.getElementById('ge-save').addEventListener('click', async () => {
  const startsAt = dayToEpoch(document.getElementById('ge-first').value);
  const lastDay = dayToEpoch(document.getElementById('ge-last').value);
  if (startsAt === null) return flash('ge-form-msg', 'Pick the first day.', true);
  if (lastDay === null) return flash('ge-form-msg', 'Pick the last day.', true);
  if (lastDay < startsAt) return flash('ge-form-msg', 'The last day is before the first day.', true);
  const body = {
    kind: document.getElementById('ge-kind').value,
    title: document.getElementById('ge-title-input').value,
    starts_at: startsAt,
    ends_at: lastDay + DAY,               // the last day is included: the event ends at the next midnight
    rules: readRules(),
    reward: readReward(),
  };
  const btn = document.getElementById('ge-save');
  btn.disabled = true;
  try {
    const r = _editing ? await games('POST', 'events/' + _editing.id, body) : await games('POST', 'events', body);
    flash('ge-form-msg', (_editing ? 'Saved event #' : 'Created event #') + r.event.id + ' — ' + r.event.state + '.', false);
    resetForm();
    loadEvents();
  } catch (err) {
    flash('ge-form-msg', err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ── List ───────────────────────────────────────────────────────────────────────────────
const STATE = {
  scheduled:  ['badge-dim',   'Scheduled'],
  running:    ['badge-ok',    'Running'],
  finalising: ['badge-warn',  'Counting'],
  done:       ['badge-ok',    'Done'],
  cancelled:  ['badge-error', 'Cancelled'],
};
const nowS = () => Math.floor(Date.now() / 1000);
function actionsFor(ev) {
  const b = [];
  const id = escHtml(ev.id);
  if (ev.state === 'scheduled' || ev.state === 'running') b.push(`<button type="button" class="btn btn-secondary btn-sm" data-act="edit" data-id="${id}">Edit</button>`);
  if (ev.state !== 'scheduled') b.push(`<button type="button" class="btn btn-secondary btn-sm" data-act="results" data-id="${id}">Results</button>`);
  if ((ev.state === 'running' && nowS() >= ev.ends_at) || ev.state === 'finalising') {
    b.push(`<button type="button" class="btn btn-sm" data-act="finalise" data-id="${id}">Finalise now</button>`);
  }
  if (ev.state === 'scheduled' || ev.state === 'running' || ev.state === 'finalising') {
    b.push(`<button type="button" class="btn btn-danger btn-sm" data-act="cancel" data-id="${id}">Cancel</button>`);
  }
  return `<div class="row-actions">${b.join('')}</div>`;
}
const eventsTable = AdminTable.create({
  tbody: 'ge-tbody',
  search: 'Filter by title, kind or state…',
  empty: 'No events yet. Create one above.',
  note: 'Events and their results are kept permanently — no retention window.',
  text: e => [e.id, e.title, e.kind_label, e.state, (STATE[e.state] || [])[1], e.first_day, e.last_day, e.created_by].join(' '),
  row: e => {
    const [cls, label] = STATE[e.state] || ['badge-dim', e.state];
    const days = e.first_day === e.last_day ? e.first_day : e.first_day + ' → ' + e.last_day;
    return `<tr>
      <td class="mono">${escHtml(e.id)}</td>
      <td class="ge-title" title="${escHtml(e.description)}">${escHtml(e.title)}</td>
      <td>${escHtml(e.kind_label)}${e.game_title ? ' · ' + escHtml(e.game_title) : ''}</td>
      <td class="mono">${escHtml(days)}</td>
      <td><span class="badge ${cls}">${escHtml(label)}</span></td>
      <td class="mono">${e.state === 'done' ? escHtml(e.results) + ' / ' + escHtml(e.points_paid) : '—'}</td>
      <td>${actionsFor(e)}</td>
    </tr>`;
  }
});

async function loadEvents(resetPage) {
  try {
    const r = await games('GET', 'events' + (_state ? '?state=' + encodeURIComponent(_state) : ''));
    _events = r.events || [];
    eventsTable.setRows(_events, { reset: resetPage });
    document.getElementById('ge-offline').style.display = 'none';
  } catch (err) {
    eventsTable.setError(err.message);
  }
}
document.querySelectorAll('#ge-chips .tab-btn').forEach(btn => btn.addEventListener('click', () => {
  _state = btn.dataset.state;
  document.querySelectorAll('#ge-chips .tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  loadEvents(true);
}));

// Row buttons: one delegated listener, the id read from data-id (never spliced into JS).
document.getElementById('ge-tbody').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const ev = _events.find(x => String(x.id) === btn.dataset.id);
  if (!ev) return;
  if (btn.dataset.act === 'edit') editEvent(ev);
  else if (btn.dataset.act === 'results') showResults(ev.id);
  else if (btn.dataset.act === 'cancel') cancelEvent(ev);
  else if (btn.dataset.act === 'finalise') finaliseEvent(ev);
});

// ── Confirm dialog (in-page; stepup.js then asks for the password) ────────────────────
function askConfirm({ title, body, withReason, confirmText }) {
  const ov = document.getElementById('confirm-dialog');
  const form = document.getElementById('confirm-form');
  const input = document.getElementById('confirm-reason');
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-body').textContent = body;
  document.getElementById('confirm-reason-group').style.display = withReason ? '' : 'none';
  const submit = document.getElementById('confirm-submit');
  submit.textContent = confirmText;
  submit.className = withReason ? 'btn btn-danger' : 'btn';
  input.value = '';
  return new Promise(resolve => {
    const done = v => {
      ov.classList.remove('open');
      form.removeEventListener('submit', onSubmit);
      document.getElementById('confirm-cancel').removeEventListener('click', onCancel);
      ov.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onSubmit = e => { e.preventDefault(); done({ reason: input.value.trim() }); };
    const onCancel = () => done(null);
    const onBackdrop = e => { if (e.target === ov) done(null); };
    const onKey = e => { if (e.key === 'Escape') done(null); };
    form.addEventListener('submit', onSubmit);
    document.getElementById('confirm-cancel').addEventListener('click', onCancel);
    ov.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    ov.classList.add('open');
    (withReason ? input : submit).focus();
  });
}

async function cancelEvent(ev) {
  const ok = await askConfirm({
    title: 'Cancel event #' + ev.id + '?',
    body: '“' + ev.title + '” (' + ev.state + ').\nA cancelled event pays no rewards and cannot be restarted. ' +
          (ev.state === 'running' || ev.state === 'finalising' ? 'Players have been competing in it; it stays visible to them as cancelled.' : 'It was never announced as running, so it disappears from /play/.'),
    withReason: true, confirmText: 'Cancel the event',
  });
  if (!ok) return;
  try {
    await games('POST', 'events/' + ev.id + '/cancel', ok.reason ? { reason: ok.reason } : {});
    flash('ge-list-msg', 'Event #' + ev.id + ' cancelled.', false);
    if (_editing && _editing.id === ev.id) resetForm();
  } catch (err) {
    flash('ge-list-msg', err.message, true);
  }
  loadEvents();
}

async function finaliseEvent(ev) {
  const ok = await askConfirm({
    title: 'Count the results of event #' + ev.id + ' now?',
    body: '“' + ev.title + '” ended on ' + ev.last_day + ' (UTC). Results are normally counted 10 minutes after the end, ' +
          'so the last mining minutes have been synced. Counting now ranks the addresses and pays the rewards once; it cannot be undone.',
    withReason: false, confirmText: 'Count and pay now',
  });
  if (!ok) return;
  try {
    const r = await games('POST', 'events/' + ev.id + '/finalise', {});
    flash('ge-list-msg', 'Event #' + ev.id + ' finalised: ' + r.ranked + ' ranked, ' + r.points + ' point(s) paid.', false);
    showResults(ev.id);
  } catch (err) {
    flash('ge-list-msg', err.message, true);
  }
  loadEvents();
}

// ── Results ────────────────────────────────────────────────────────────────────────────
const resultsTable = AdminTable.create({
  tbody: 'ge-res-tbody',
  search: 'Find an address…',
  empty: 'Nobody ranked.',
  text: r => [r.rank, r.address, r.value, r.badge].join(' '),
  row: r => {
    const addr = escHtml(r.address);
    const badge = r.badge ? ((_meta.badges || []).find(b => b.id === r.badge) || { label: r.badge }).label : '—';
    return `<tr>
      <td class="mono">${escHtml(r.rank)}</td>
      <td><button type="button" class="addr-copy" data-copy="${addr}" data-tip="${addr}&#10;Click to copy" aria-label="Copy address">${addr}</button></td>
      <td class="mono">${escHtml(r.value)}</td>
      <td class="mono">${escHtml(r.reward_points)}</td>
      <td>${escHtml(badge)}</td>
    </tr>`;
  }
});
async function showResults(id) {
  const card = document.getElementById('ge-results-card');
  card.hidden = false;
  resultsTable.setLoading();
  try {
    const r = await games('GET', 'events/' + id);
    const ev = r.event;
    document.getElementById('ge-res-title').textContent = 'Results · #' + ev.id + ' ' + ev.title;
    document.getElementById('ge-res-unit').textContent = ev.unit ? ev.unit.charAt(0).toUpperCase() + ev.unit.slice(1) : 'Value';
    document.getElementById('ge-res-note').textContent = r.provisional
      ? 'Provisional standings (the event is ' + ev.state + '); the points and badges shown are what each rank WOULD get. Nothing is paid until the results are counted.'
      : ev.state === 'done' ? 'Final. ' + ev.results + ' ranked, ' + ev.points_paid + ' point(s) paid. Full addresses: admin only — /play/ shows them masked.'
      : 'No results: the event is ' + ev.state + '.';
    resultsTable.setRows(r.results || [], { reset: true });
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (err) {
    resultsTable.setError(err.message);
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    _meta = await games('GET', 'event-kinds');
  } catch (err) {
    const el = document.getElementById('ge-offline');
    el.textContent = err.message;
    el.style.display = '';
    eventsTable.setError(err.message);
    document.getElementById('ge-save').disabled = true;
    return;
  }
  const kindSel = document.getElementById('ge-kind');
  _meta.kinds.forEach(k => { const o = document.createElement('option'); o.value = k.kind; o.textContent = k.label; kindSel.appendChild(o); });
  resetForm();
  loadEvents();
}
document.addEventListener('DOMContentLoaded', boot);
setInterval(() => { if (!document.hidden && _meta) loadEvents(); }, 60000);
