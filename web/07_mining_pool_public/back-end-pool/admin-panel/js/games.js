// games.html page script — moved BYTE-verbatim out of the page's inline script block (code-layout F5).
// Classic script (no defer/module) loaded at the same position as the old block, after the <script src> tags before it, whose globals it uses (H14).
// Games → Overview & settings (design §19.6, §19.10, §19.11; games Part 9). Every call goes
// through GamesAdmin.call (the admin proxy, adminFetch — never API.*). A settings save is
// step-up: the POOL asks for the password before it proxies (lib/games-link.js).
API.guardAdminPage();
const G = window.GamesAdmin;

// Labels + grouping. `scale` shows a seconds value in hours (stored as seconds).
const GROUPS = [
  { title: 'Plays (earned from mining minutes)', keys: {
    minutes_per_play: 'Active mining minutes per play',
    plays_daily_cap: 'Plays earned per UTC day, at most',
    plays_balance_cap: 'Plays (tickets) a miner may bank, at most (minutes over the cap are lost)',
  } },
  { title: 'Bot games & points', keys: {
    bot_play_cost: 'Plays one game against the bot costs (0 = free — and a free game pays no points)',
    points_daily_cap: 'Points earned per UTC day, at most (event rewards and adjustments are exempt)',
  } },
  { title: 'Games between players (PvP)', keys: {
    pvp_play_cost: 'Plays each side pays for a game against a person (0 = free — and a free game pays no points)',
    pair_rated_daily: 'Rated games per UTC day between the same two addresses (0 = none rated: no rating moves, no PvP points)',
    pvp_active_max: 'Games in progress per address, at most',
    pvp_open_max: 'Open seeks + challenges per address, at most',
  } },
  { title: 'Chat — who may post', keys: {
    chat_min_proof_age: { label: 'The sign-in proof must be at least this old (hours)', scale: 3600, floor: 'chat_min_proof_age' },
    chat_requires_password: 'Chat needs a sign-in with the rig PASSWORD (IP sign-ins can read but not post)',
    chat_min_minutes: 'Mining minutes needed in the recent window (0 = no mining gate)',
    chat_recent_days: 'The recent window, in days (today counts)',
  } },
  { title: 'Chat — pace & review', keys: {
    chat_posts_per_hour: 'Posts per address per hour, at most',
    chat_slow_seconds: 'Slow mode: seconds between one address\'s posts (0 = off; moderators exempt)',
    chat_hold_links: 'Hold messages with a link or a GRIN address for review',
    chat_report_threshold: 'Reports from different addresses that hold a message',
  } },
  { title: 'Chat — retention', keys: {
    chat_retention_days: 'Keep messages this many days',
    chat_retention_max: 'Keep at most this many messages',
  } },
  { title: 'Moderators', keys: {
    mod_requires_password: 'Moderators act only from a sign-in with their rig PASSWORD (recommended: an IP proof can be a neighbour on the same network)',
  } },
  { title: 'Guest accounts (players who do not mine)', keys: {
    guest_signup_enabled: 'New guests may sign up on /play/ (off = existing guests still sign in)',
    guest_signups_per_ip: 'Sign-ups per network (/24, or /48 for IPv6) per 24 hours, at most',
    signup_pow_bits: { label: 'Sign-up proof-of-work difficulty, in bits (each +1 doubles the work; at 18 a desktop browser needs about half a second)', floor: 'signup_pow_bits' },
    guest_daily_plays: 'Tickets a guest gets each UTC day (topped back up at 00:00 UTC, never saved up)',
    chat_guests_enabled: 'Guests may post in chat',
    guest_chat_min_age: { label: 'A guest account must be at least this old before it can post (hours)', scale: 3600, floor: 'guest_chat_min_age' },
    guest_idle_days: 'Delete a guest account after this many days with no sign-in',
  } },
  { title: 'Nicknames', keys: {
    nicknames_enabled: 'Players may set a nickname (checked automatically, live at once; off = no new names, and every page shows the masked address only; live names come back when it is on again)',
    nickname_change_days: 'A player may change their nickname once every this many days (0 = any time; removing their own is always allowed)',
  } },
];
const FLOOR_TEXT = {
  chat_min_proof_age: s => 'A proof is always at least ' + (s / 3600) + ' h old before chat, whatever the setting says.',
  chat_min_interval_s: s => 'One address can post at most once every ' + s + ' s.',
  chat_ip_posts_per_hour: n => 'One IP can post at most ' + n + ' times an hour, across all addresses.',
  signup_pow_bits: b => 'The sign-up proof-of-work is never below ' + b + ' bits, whatever the setting says.',
  guest_chat_min_age: s => 'A guest account is always at least ' + (s / 3600) + ' h old before it can post.',
  guest_chat_pace: g => 'A guest can post at most once every ' + g.min_interval_s + ' s and ' + g.posts_per_hour + ' times an hour; a link from a guest is always held.',
  mod_mute_max_minutes: m => 'A moderator can mute for at most ' + (m / 60) + ' h; only you can mute for longer (up to 30 days).',
};

let _data = null;

function inputFor(spec, cfg, value) {
  const scale = cfg.scale || 1;
  let input;
  if (spec.type === 'bool') {
    input = G.el('input');
    input.type = 'checkbox';
    input.checked = value === true;
  } else {
    input = G.el('input');
    input.type = 'number';
    input.step = scale === 1 ? '1' : 'any';
    input.min = String(spec.min / scale);
    input.max = String(spec.max / scale);
    input.value = String(value / scale);
  }
  input.id = 'gs-' + spec.key;
  input.className = 'settings-skip';
  input.dataset.key = spec.key;
  input.dataset.scale = String(scale);
  input.addEventListener('input', markChanged);
  input.addEventListener('change', markChanged);
  return input;
}

function readValue(input) {
  if (input.type === 'checkbox') return input.checked;
  const n = Number(input.value) * Number(input.dataset.scale || 1);
  return Number.isFinite(n) ? Math.round(n) : NaN;
}

function changedValues() {
  const out = {};
  document.querySelectorAll('#gs-form [data-key]').forEach(i => {
    const v = readValue(i);
    if (v !== _data.values[i.dataset.key]) out[i.dataset.key] = v;
  });
  return out;
}

function markChanged() {
  document.querySelectorAll('#gs-form [data-key]').forEach(i => {
    i.closest('.form-group').classList.toggle('gs-changed', readValue(i) !== _data.values[i.dataset.key]);
  });
  document.getElementById('gs-save').disabled = Object.keys(changedValues()).length === 0;
}

function render() {
  const box = document.getElementById('gs-form');
  G.clear(box);
  const specs = Object.fromEntries(_data.spec.map(s => [s.key, s]));
  const used = new Set();
  const groups = GROUPS.map(g => ({ title: g.title, keys: Object.entries(g.keys) }));
  // A key the games service has that this page does not know yet still gets a field.
  const extra = _data.spec.filter(s => !GROUPS.some(g => s.key in g.keys)).map(s => [s.key, s.key.replace(/_/g, ' ')]);
  if (extra.length) groups.push({ title: 'Other', keys: extra });
  groups.forEach(g => {
    const card = G.el('div', 'card');
    card.appendChild(G.el('h3', 'sub-title', g.title));
    card.firstChild.style.marginTop = '0';
    const grid = G.el('div', 'gs-grid');
    g.keys.forEach(([key, raw]) => {
      const spec = specs[key];
      if (!spec || used.has(key)) return;
      used.add(key);
      const cfg = typeof raw === 'string' ? { label: raw } : raw;
      const fg = G.el('div', spec.type === 'bool' ? 'form-group checkbox-group' : 'form-group');
      const input = inputFor(spec, cfg, _data.values[key]);
      const lab = G.el('label', null, cfg.label);
      lab.htmlFor = input.id;
      if (spec.type === 'bool') { fg.appendChild(input); fg.appendChild(lab); }
      else { fg.appendChild(lab); fg.appendChild(input); }
      const scale = cfg.scale || 1;
      const def = spec.type === 'bool' ? (spec.def ? 'on' : 'off') : String(spec.def / scale);
      const range = spec.type === 'int' ? ' · range ' + (spec.min / scale) + '–' + (spec.max / scale) : '';
      fg.appendChild(G.el('div', 'gs-floor', 'Default ' + def + range));
      if (cfg.floor && _data.floors[cfg.floor] !== undefined) fg.appendChild(G.el('div', 'gs-floor', FLOOR_TEXT[cfg.floor](_data.floors[cfg.floor])));
      const m = _data.meta[key];
      if (m) fg.appendChild(G.el('div', 'gs-meta', 'Changed ' + G.fmtUtc(m.updated_at) + (m.updated_by ? ' by ' + m.updated_by : '')));
      grid.appendChild(fg);
    });
    card.appendChild(grid);
    box.appendChild(card);
  });
  const fl = document.getElementById('gs-floors');
  G.clear(fl);
  Object.entries(_data.floors || {}).forEach(([k, v]) => { if (FLOOR_TEXT[k]) fl.appendChild(G.el('li', null, FLOOR_TEXT[k](v))); });
  markChanged();
}

async function load() {
  try {
    _data = await G.call('GET', 'settings');
    document.getElementById('gs-offline').style.display = 'none';
    render();
  } catch (err) {
    const el = document.getElementById('gs-offline');
    el.textContent = err.message;
    el.style.display = '';
  }
}

document.getElementById('gs-save').addEventListener('click', async () => {
  const values = changedValues();
  const bad = Object.entries(values).find(([, v]) => typeof v === 'number' && !Number.isFinite(v));
  if (bad) { G.flash('gs-msg', 'Check: ' + bad[0].replace(/_/g, ' '), true); return; }
  if (!Object.keys(values).length) return;
  try {
    const r = await G.call('POST', 'settings', { values });
    _data = r;
    render();
    G.flash('gs-msg', r.changed.length ? 'Saved: ' + r.changed.join(', ') + '. They apply from the next request (within 30 s).' : 'Nothing changed.', false);
  } catch (err) {
    G.flash('gs-msg', err.message, true);
  }
});
document.getElementById('gs-reload').addEventListener('click', load);

// ── Launch (§19.17.2) ─────────────────────────────────────────────────────────────────
const MODE_TEXT = { off: 'off', preview: 'preview', on: 'live' };
const MODE_BADGE = { off: 'badge badge-dim', preview: 'badge badge-warn', on: 'badge badge-ok' };
function modeBadge(label, mode) {
  const span = G.el('span');
  span.appendChild(document.createTextNode(label + ' '));
  span.appendChild(G.el('span', MODE_BADGE[mode] || 'badge badge-dim', MODE_TEXT[mode] || String(mode)));
  return span;
}
function renderLaunch(d) {
  const st = document.getElementById('gl-state');
  G.clear(st);
  st.appendChild(modeBadge('Players see:', d.effective));
  st.appendChild(modeBadge('Launch state:', d.launch));
  st.appendChild(modeBadge('Pool master switch:', d.pool_mode));
  const ex = document.getElementById('gl-explain');
  ex.textContent =
    d.effective === 'on' ? 'The games are live: Play is in the Community menu (while the service answers).'
    : d.pool_mode === 'off' ? "The pool's master switch is off (or the pool has not answered this service for 10 minutes), so /play/ is closed whatever the launch state says."
    : d.launch === 'preview' ? 'Preview: /play/ works by direct link and the menu does not show it. Try a game and the chat, then go live.'
    : "Launched, but the pool's master switch is on preview, so the menu does not show Play yet.";
  const act = document.getElementById('gl-actions');
  G.clear(act);
  if (d.launch === 'preview') {
    act.appendChild(G.btn('Go live', 'btn-primary', () => setLaunch('on')));
  } else {
    act.appendChild(G.btn('Back to preview', 'btn-secondary', () => setLaunch('preview')));
  }
}
async function loadLaunch() {
  try {
    renderLaunch(await G.call('GET', 'launch'));
  } catch (err) {
    const st = document.getElementById('gl-state');
    G.clear(st);
    st.textContent = err.message;
    G.clear(document.getElementById('gl-actions'));
  }
}
async function setLaunch(state) {
  const live = state === 'on';
  const ok = await G.askConfirm({
    title: live ? 'Go live?' : 'Back to preview?',
    body: live
      ? "Play appears under Community on every pool page (when the pool's master switch is on), and the games are announced. You can go back to preview at any time."
      : 'Play leaves the menu at once. /play/ keeps working for anyone who has the link; nothing a player has is lost.',
    confirmText: live ? 'Go live' : 'Back to preview',
  });
  if (!ok) return;
  try {
    const r = await G.call('POST', 'launch', { state });
    renderLaunch(r);
    G.flash('gl-msg', r.changed ? (live ? 'Live. The menu follows within a few seconds.' : 'Back in preview. The menu follows within a few seconds.') : 'Nothing changed — it was already ' + MODE_TEXT[r.launch] + '.', false);
  } catch (err) {
    G.flash('gl-msg', err.message, true);
  }
}

document.addEventListener('DOMContentLoaded', () => { loadLaunch(); load(); });
