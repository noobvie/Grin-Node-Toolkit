// node-availability.html page script — moved BYTE-verbatim out of the page's inline script block (code-layout F5).
// Classic script (no defer/module) loaded at the same position as the old block, after the <script src> tags before it, whose globals it uses (H14).
// Auth gate (httpOnly-cookie aware): redirects to /login.html if not an admin, else wires
// up the topbar username + Logout. Pool name + testnet banner are handled by admin-shell.js.
API.guardAdminPage();

// ── NA-VIEW BEGIN ── pure view helpers: no DOM, no fetch. scripts/test-admin-panel.js runs this
// block on its own in a vm, so keep everything between the markers free of document/window.

var NA_SOURCES = ['pool', 'recorder'];
var NA_SOURCE_LABEL = { pool: 'Pool view', recorder: 'Node box' };

// Row states (lib/node-availability.js ROW_STATES). Only 'down' is counted.
var NA_STATE = {
  down:       ['badge-error', 'Outage'],
  planned:    ['badge-dim',   'Planned'],
  unobserved: ['badge-dim',   'Not watched'],
  fault:      ['badge-warn',  'Fault'],
  degraded:   ['badge-warn',  'Degraded'],
  restart:    ['badge-dim',   'Restart'],
  info:       ['badge-dim',   'Info']
};

// Class meanings, for the class cards and the cell titles. Pool classes come from the probe's
// tags (design §20.2); recorder classes are leans, not verdicts (086 design §8).
var NA_CLASS = {
  timeout:          'API took the connection but did not answer in time',
  starting:         'API port refused while a node process was starting',
  refused:          'API port refused; no node process seen',
  other:            'no JSON-RPC answer (HTTP error, proxy page, reset)',
  node_error:       'node replied with an error envelope',
  auth:             'node rejected the credential (not downtime)',
  stratum_drop:     'node stratum link closed while the API stayed up',
  crashed:          'process exited non-zero (panic or rc 101)',
  killed:           'killed (rc 137 or the kernel OOM killer)',
  hung:             'process alive, API not answering',
  wedged:           'API answers but the chain tip stopped',
  failed_start:     'never answered after a start',
  corrupted:        'chain_data integrity error — restarts will not fix it; resync',
  unexplained_stop: 'process gone, clean exit, no toolkit stop recorded'
};

function naEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function naIsInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

// '2026-10-03 14:05:22' — UTC, suffix-free (the page states "All times UTC" once).
function naUtc(t) {
  if (!naIsInt(t)) return '—';
  return new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

// 45 s · 12 min · 3 h 05 min · 2 d 4 h
function naDur(s) {
  if (!naIsInt(s) || s < 0) return '—';
  if (s < 60) return s + ' s';
  var m = Math.floor(s / 60);
  if (m < 60) return m + ' min';
  var h = Math.floor(m / 60);
  if (h < 48) return h + ' h ' + String(m % 60).padStart(2, '0') + ' min';
  return Math.floor(h / 24) + ' d ' + (h % 24) + ' h';
}

function naPct(p) {
  if (typeof p !== 'number' || !isFinite(p)) return '—';
  return (p === 100 ? '100' : p.toFixed(2)) + '%';
}

// What to say about the recorder. kind: 'other' | 'none' | 'absent' | 'unreadable' | 'stale' |
// 'ok' | 'unknown'. `html` is page-authored text; the only API value in it is the network,
// which is checked against the two literals before use.
function naRecorderNotice(data) {
  var net = data && (data.network === 'mainnet' || data.network === 'testnet') ? data.network : 'this network';
  if (!data) return { kind: 'none', cls: 'error', html: '' };
  if (data.other_network) {
    return { kind: 'other', cls: 'warn', html:
      'This pool watches its own node only, and it keeps no availability rows for <b>' + naEsc(net) +
      '</b>. Switch the network back to see them.' };
  }
  var rec = data.recorder || {};
  if (rec.ledger === 'absent') {
    return { kind: 'absent', cls: 'warn', html:
      '<b>No node event recorder on this box</b> for ' + naEsc(net) + ', so only the pool view is shown. ' +
      'The recorder is the node-side observer: it tells a planned toolkit stop from a crash, a hang ' +
      'or a corrupted chain, and keeps evidence for an upstream report. Install it from the toolkit: ' +
      '<b>hub 08 → Diagnostics → Node event recorder → Install</b>.' };
  }
  if (rec.ledger === 'unreadable') {
    return { kind: 'unreadable', cls: 'error', html:
      '<b>The recorder\'s ledger exists but the pool cannot read it.</b> The recorder keeps ' +
      '<span class="mono">/opt/grin/node-events/</span> and its network folder at 0755 and the files at 0644. ' +
      'Fix the modes, or re-run <b>hub 08 → Diagnostics → Node event recorder → Install / refresh</b>. ' +
      'Until then the node-box figures are blank.' };
  }
  if (rec.status && rec.status.stale) {
    return { kind: 'stale', cls: 'warn', html:
      '<b>The recorder has stopped updating.</b> Its last status is from ' + naEsc(naUtc(rec.status.updated)) +
      ', so the node-box view after that is counted as not watched. Check its timer: ' +
      '<b>hub 08 → Diagnostics → Node event recorder → Status</b>.' };
  }
  if (rec.ledger === 'ok') return { kind: 'ok', cls: 'ok', html: '' };
  return { kind: 'unknown', cls: 'warn', html: '' };
}

// One source's "right now" text. Pool: an open outage, else time since reachable. Recorder:
// its status.json state (fresh only).
function naNowText(data, source) {
  var now = data && naIsInt(data.to) ? data.to : null;
  var s = data && data.sources ? data.sources[source] : null;
  if (!s || now === null) return { text: '—', down: false };
  if (s.open_outage) return { text: 'DOWN', down: true };
  if (source === 'recorder') {
    var st = data.recorder && data.recorder.status;
    if (!st) return { text: '—', down: false };
    if (st.stale) return { text: 'stale', down: false };
    if (st.state === 'up' && naIsInt(st.up_since)) return { text: 'up ' + naDur(now - st.up_since), down: false };
    if (st.state === 'down') return { text: 'DOWN' + (st.class ? ' · ' + st.class : ''), down: true };
    return { text: st.state || '—', down: false };
  }
  if (naIsInt(s.up_since)) return { text: 'up ' + naDur(now - s.up_since), down: false };
  return { text: '—', down: false };
}

// The KPI figures per source — each source on its own, never combined.
function naKpis(data) {
  var out = {};
  NA_SOURCES.forEach(function (src) {
    var s = data && data.sources ? data.sources[src] : null;
    var absent = src === 'recorder' && data && data.recorder &&
      (data.recorder.ledger === 'absent' || data.recorder.ledger === 'unreadable');
    if (!s || absent) {
      out[src] = { up: '—', outages: '—', mtbf: '—', longest: '—', now: { text: absent ? 'not installed' : '—', down: false } };
      if (absent && data.recorder.ledger === 'unreadable') out[src].now.text = 'unreadable';
      return;
    }
    out[src] = {
      up: naPct(s.uptime_pct),
      outages: String(naIsInt(s.outages) ? s.outages : '—') + (s.open_outage ? ' (1 open)' : ''),
      mtbf: naIsInt(s.mtbf_s) ? naDur(s.mtbf_s) : (s.outages === 0 ? 'no outage' : '—'),
      longest: naIsInt(s.longest_outage_s) ? naDur(s.longest_outage_s) : 'none',
      now: naNowText(data, src)
    };
  });
  return out;
}

// A day's cell state: any counted downtime → out; nothing observed at all → none; else ok.
function naDayState(d) {
  if (!d) return 'none';
  if ((d.down_s || 0) > 0) return 'out';
  if ((d.up_s || 0) + (d.down_s || 0) <= 0) return 'none';
  return 'ok';
}
var NA_DAY_WORD = { ok: 'up', out: 'outage', none: 'no counted time' };

// The last `n` days of a source's daily series, oldest first.
function naStripDays(data, source, n) {
  var s = data && data.sources ? data.sources[source] : null;
  var daily = s && Array.isArray(s.daily) ? s.daily : [];
  return daily.slice(-(n || 90)).map(function (d) {
    return { day: d.day, state: naDayState(d), d: d };
  });
}

// One lane of cells. Each cell is a plain block; the tooltip reads data-i.
function naLaneHtml(days, source) {
  if (!days.length) return '<div class="na-lane-empty">No days in range.</div>';
  var n = { ok: 0, out: 0, none: 0 };
  var cells = days.map(function (x, i) {
    n[x.state]++;
    return '<i class="na-cell na-st-' + x.state + '" data-src="' + source + '" data-i="' + i + '"></i>';
  }).join('');
  var label = NA_SOURCE_LABEL[source] + ', last ' + days.length + ' days: ' + n.ok + ' up, ' +
    n.out + ' with a counted outage, ' + n.none + ' with no counted time.';
  return '<div class="na-cells" role="img" tabindex="0" aria-label="' + naEsc(label) + '">' + cells + '</div>';
}

// The tooltip body for one day.
function naTipHtml(x, source) {
  var d = x.d || {};
  var row = function (k, v) { return '<div class="na-tip-row"><span>' + k + '</span><span>' + v + '</span></div>'; };
  return '<b>' + naEsc(x.day) + ' · ' + naEsc(NA_SOURCE_LABEL[source]) + '</b>' +
    row('State', naEsc(NA_DAY_WORD[x.state])) +
    row('Uptime', naPct(d.uptime_pct)) +
    row('Down', naDur(d.down_s || 0)) +
    ((d.planned_s || 0) > 0 ? row('Planned (not counted)', naDur(d.planned_s)) : '') +
    ((d.fault_s || 0) > 0 ? row('Auth fault (not counted)', naDur(d.fault_s)) : '') +
    ((d.unobserved_s || 0) > 0 ? row('Not watched', naDur(d.unobserved_s)) : '');
}

// Rows for the "Days with downtime" table: any day with down, planned or fault time, newest first.
function naDowntimeDays(data) {
  var rows = [];
  NA_SOURCES.forEach(function (src) {
    naStripDays(data, src, 90).forEach(function (x) {
      var d = x.d;
      if ((d.down_s || 0) + (d.planned_s || 0) + (d.fault_s || 0) > 0) rows.push({ day: x.day, src: src, d: d });
    });
  });
  rows.sort(function (a, b) { return a.day < b.day ? 1 : a.day > b.day ? -1 : (a.src < b.src ? -1 : 1); });
  return rows;
}

// Class counts for one source, largest first.
function naClassCounts(data, source) {
  var s = data && data.sources ? data.sources[source] : null;
  var by = s && s.by_class && typeof s.by_class === 'object' ? s.by_class : {};
  return Object.keys(by).filter(function (k) { return naIsInt(by[k]) && by[k] > 0; })
    .map(function (k) { return { cls: k, n: by[k] }; })
    .sort(function (a, b) { return b.n - a.n || (a.cls < b.cls ? -1 : 1); });
}

function naClassCardHtml(data, source) {
  var s = data && data.sources ? data.sources[source] : null;
  var notice = naRecorderNotice(data);
  if (source === 'recorder' && (notice.kind === 'absent' || notice.kind === 'unreadable')) {
    return '<p class="na-cempty">' + (notice.kind === 'absent' ? 'No recorder installed.' : 'Recorder ledger not readable.') + '</p>';
  }
  if (!s) return '<p class="na-cempty">No data.</p>';
  var list = naClassCounts(data, source);
  var max = list.reduce(function (m, x) { return Math.max(m, x.n); }, 0);
  var body = list.length ? list.map(function (x) {
    var w = max ? Math.max(4, Math.round((x.n / max) * 100)) : 0;
    return '<div class="na-crow" title="' + naEsc(NA_CLASS[x.cls] || x.cls) + '">' +
      '<span class="mono">' + naEsc(x.cls) + '</span>' +
      '<span class="na-track"><span class="na-bar" style="display:block;width:' + w + '%"></span></span>' +
      '<span class="na-n">' + x.n + '</span></div>';
  }).join('') : '<p class="na-cempty">No counted outages in this range.</p>';
  var foot = [];
  if (source === 'recorder' && naIsInt(s.planned_stops) && s.planned_stops > 0) {
    foot.push(s.planned_stops + ' planned stop' + (s.planned_stops === 1 ? '' : 's') + ' (toolkit stops and host boots) — listed, not counted.');
  }
  if (list.some(function (x) { return x.cls === 'corrupted'; })) {
    foot.push('<b style="color:var(--danger)">corrupted</b>: restarts will not fix this — chain_data needs a resync. The evidence bundle is named in the event\'s detail.');
  }
  return body + (foot.length ? '<p class="na-cfoot">' + foot.join('<br>') + '</p>' : '');
}

// A pool outage that overlaps a recorder planned row (a toolkit stop or a host boot) gets a note.
// It is an annotation only: no number on the page changes because of it (design §20.4).
function naAnnotate(events, now) {
  var list = Array.isArray(events) ? events : [];
  var planned = list.filter(function (e) { return e.source === 'recorder' && e.state === 'planned'; });
  return list.map(function (e) {
    if (e.source !== 'pool' || e.state !== 'down') return e;
    var a = e.started_at, b = e.ended_at === null || e.ended_at === undefined ? now : e.ended_at;
    var hit = planned.filter(function (p) {
      var pb = p.ended_at === null || p.ended_at === undefined ? now : p.ended_at;
      if (pb === p.started_at) pb = p.started_at + 1;          // a point row still marks its instant
      return p.started_at < b && a < pb;
    })[0];
    if (!hit) return e;
    var what = /^host boot/.test(String(hit.detail || '')) ? 'a host boot' : 'a planned toolkit stop';
    return Object.assign({}, e, { note: 'overlaps ' + what + ' on the node box — miners still felt it' });
  });
}

// Filter = observer + class + how much to show. 'notable' hides only the info lines.
function naFilter(events, f) {
  f = f || {};
  return (Array.isArray(events) ? events : []).filter(function (e) {
    if (f.source && e.source !== f.source) return false;
    if (f.cls && e['class'] !== f.cls) return false;
    if (f.show === 'outages') return e.state === 'down';
    if (f.show === 'all') return true;
    return e.state !== 'info';
  });
}

// The classes present in a row set, for the Class select.
function naClassOptions(events) {
  var seen = {};
  (Array.isArray(events) ? events : []).forEach(function (e) { if (e['class']) seen[e['class']] = true; });
  return Object.keys(seen).sort();
}

function naDurationCell(e, now) {
  var open = e.ended_at === null || e.ended_at === undefined;
  if (open) return naDur(Math.max(0, now - e.started_at)) + ' · ongoing';
  if (e.ended_at === e.started_at) return '—';                // a point event
  return naDur(naIsInt(e.duration_s) ? e.duration_s : e.ended_at - e.started_at);
}

function naRow(e, now) {
  var st = NA_STATE[e.state] || ['badge-dim', e.state];
  var cls = e['class'];
  var detail = naEsc(e.detail || '') + (e.note ? (e.detail ? ' · ' : '') + '<span class="na-note">' + naEsc(e.note) + '</span>' : '');
  return '<tr data-src="' + naEsc(e.source) + '">' +
    '<td>' + naEsc(NA_SOURCE_LABEL[e.source] || e.source) + '</td>' +
    '<td><span class="badge ' + st[0] + '">' + naEsc(st[1]) + '</span></td>' +
    '<td>' + (cls ? '<span class="mono" title="' + naEsc(NA_CLASS[cls] || cls) + '">' + naEsc(cls) + '</span>' : '—') + '</td>' +
    '<td>' + naEsc(e.origin || '—') + '</td>' +
    '<td class="mono">' + naUtc(e.started_at) + '</td>' +
    '<td>' + naEsc(naDurationCell(e, now)) + '</td>' +
    '<td class="na-detail">' + (detail || '—') + '</td>' +
    '</tr>';
}

function naRowText(e) {
  return [NA_SOURCE_LABEL[e.source], (NA_STATE[e.state] || [])[1], e.state, e['class'], e.origin,
          naUtc(e.started_at), e.detail, e.note].join(' ');
}
// ── NA-VIEW END ──

// ── state + DOM ───────────────────────────────────────────────────────────────────────────────
var naRange = '30d';
var naNetwork = '';          // '' until the first answer says which node this pool watches
var naEvents = [];
var naNow = Math.floor(Date.now() / 1000);
var naStrip = { pool: [], recorder: [] };
var naRangeLabel = { '7d': '7 d', '30d': '30 d', '90d': '90 d', '1y': '1 y' };

var naTable = AdminTable.create({
  tbody: 'na-events-tbody',
  search: 'Search class, detail, date…',
  empty: 'No events in this view.',
  note: 'Closed rows are kept 730 days.',
  text: naRowText,
  row: function (e) { return naRow(e, naNow); }
});

function naSet(id, v, down) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = v;
  el.classList.toggle('na-down', !!down);
}

function naShowMsg(text) {
  var el = document.getElementById('na-msg');
  el.textContent = text || '';
  el.style.display = text ? '' : 'none';
}

// Auth.fetch hands back the parsed error body on a non-2xx (a 503 when the module is not
// running is { error }), and null on a network failure — neither is data.
async function naGet(url) {
  var d = await API.get(url);
  if (!d || typeof d !== 'object') throw new Error('no answer from the pool');
  if (d.error) throw new Error(d.error);
  return d;
}

function naQuery(range) {
  return '?range=' + encodeURIComponent(range) + (naNetwork ? '&network=' + encodeURIComponent(naNetwork) : '');
}

function naRenderNotice(data) {
  var n = naRecorderNotice(data);
  var box = document.getElementById('na-recorder-note');
  if (!n.html) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.innerHTML = '<div class="health-card ' + n.cls + '"><div class="health-detail">' + n.html + '</div></div>';
  box.style.display = '';
}

function naRenderKpis(data) {
  var k = naKpis(data);
  NA_SOURCES.forEach(function (src) {
    naSet('k-up-' + src, k[src].up);
    naSet('k-out-' + src, k[src].outages);
    naSet('k-mtbf-' + src, k[src].mtbf);
    naSet('k-long-' + src, k[src].longest);
    naSet('k-now-' + src, k[src].now.text, k[src].now.down);
  });
}

function naRenderStrip(data90) {
  var notice = naRecorderNotice(data90);
  NA_SOURCES.forEach(function (src) {
    var el = document.getElementById('na-lane-' + src);
    if (src === 'recorder' && (notice.kind === 'absent' || notice.kind === 'unreadable')) {
      naStrip[src] = [];
      el.innerHTML = '<div class="na-lane-empty">' + (notice.kind === 'absent'
        ? 'No recorder installed — hub 08 → Diagnostics → Node event recorder.'
        : 'Recorder ledger not readable by the pool.') + '</div>';
      return;
    }
    naStrip[src] = naStripDays(data90, src, 90);
    el.innerHTML = naLaneHtml(naStrip[src], src);
  });
  var rows = naDowntimeDays(data90);
  document.getElementById('na-days-tbody').innerHTML = rows.length ? rows.map(function (r) {
    return '<tr><td class="mono">' + naEsc(r.day) + '</td><td>' + naEsc(NA_SOURCE_LABEL[r.src]) + '</td>' +
      '<td>' + naPct(r.d.uptime_pct) + '</td><td>' + naDur(r.d.down_s || 0) + '</td>' +
      '<td>' + naDur(r.d.planned_s || 0) + '</td><td>' + naDur(r.d.fault_s || 0) + '</td><td>' + naDur(r.d.unobserved_s || 0) + '</td></tr>';
  }).join('') : '<tr class="empty-row"><td colspan="7">No downtime, planned stops or faults in the last 90 days.</td></tr>';
}

function naRenderClasses(data) {
  NA_SOURCES.forEach(function (src) {
    document.getElementById('na-classes-' + src).innerHTML = naClassCardHtml(data, src);
  });
}

function naRenderClassSelect() {
  var sel = document.getElementById('na-f-class');
  var keep = sel.value;
  var opts = naClassOptions(naEvents);
  if (keep && opts.indexOf(keep) === -1) opts.push(keep);       // never drop the active choice
  sel.innerHTML = '<option value="">Any</option>' + opts.map(function (c) {
    return '<option value="' + naEsc(c) + '">' + naEsc(c) + '</option>';
  }).join('');
  sel.value = keep;
}

function naApplyFilter(reset) {
  var rows = naFilter(naEvents, {
    source: document.getElementById('na-f-source').value,
    cls: document.getElementById('na-f-class').value,
    show: document.getElementById('na-f-show').value
  });
  naTable.setRows(rows, { reset: !!reset });
}

function naClearFigures() {
  NA_SOURCES.forEach(function (src) {
    ['up', 'out', 'mtbf', 'long', 'now'].forEach(function (k) { naSet('k-' + k + '-' + src, '—'); });
    document.getElementById('na-lane-' + src).innerHTML = '<div class="na-lane-empty">No data.</div>';
    document.getElementById('na-classes-' + src).innerHTML = '<p class="na-cempty">No data.</p>';
    naStrip[src] = [];
  });
}

// reset: the operator changed the range, network or a filter — page 1 of the new set.
// naSeq: the 60 s refresh and a range/network click can overlap, and a slower OLD answer must
// never paint over the new one under the newly highlighted tab — only the latest load renders.
var naSeq = 0;
async function naLoad(reset) {
  var mine = ++naSeq;
  try {
    var both = await Promise.all([
      naGet('/api/admin/node-availability' + naQuery('90d')),
      naRange === '90d' ? null : naGet('/api/admin/node-availability' + naQuery(naRange)),
      naGet('/api/admin/node-events' + naQuery(naRange))
    ]);
    if (mine !== naSeq) return;
    var data90 = both[0], dataSel = both[1] || both[0], ev = both[2];
    naShowMsg('');
    if (!naNetwork && (dataSel.network === 'mainnet' || dataSel.network === 'testnet')) {
      naNetwork = dataSel.network;
      document.getElementById('na-network').value = naNetwork;
    }
    naNow = naIsInt(ev.to) ? ev.to : Math.floor(Date.now() / 1000);
    naRenderNotice(dataSel);
    if (dataSel.other_network) {
      naClearFigures();
      document.getElementById('na-days-tbody').innerHTML = '<tr class="empty-row"><td colspan="7">No rows for this network.</td></tr>';
    } else {
      naRenderKpis(dataSel);
      naRenderStrip(data90);
      naRenderClasses(dataSel);
    }
    naEvents = naAnnotate(Array.isArray(ev.events) ? ev.events : [], naNow);
    naRenderClassSelect();
    naApplyFilter(reset);
    var ts = document.getElementById('na-refresh');
    ts.textContent = '(refreshed ' + new Date().toISOString().slice(11, 19) + ')';
  } catch (err) {
    if (mine !== naSeq) return;
    naShowMsg('Could not load node availability: ' + err.message);
    naTable.setError(err.message);
  }
}

// ── controls ───────────────────────────────────────────────────────────────────────────────────
document.getElementById('na-range').addEventListener('click', function (e) {
  var b = e.target.closest('[data-range]');
  if (!b || b.dataset.range === naRange) return;
  naRange = b.dataset.range;
  document.querySelectorAll('#na-range .tab-btn').forEach(function (x) {
    var on = x === b;
    x.classList.toggle('active', on);
    x.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  document.querySelectorAll('.na-rlabel').forEach(function (x) { x.textContent = naRangeLabel[naRange]; });
  naTable.setLoading();
  naLoad(true);
});
document.getElementById('na-network').addEventListener('change', function (e) {
  naNetwork = e.target.value;
  naTable.setLoading();
  naLoad(true);
});
['na-f-source', 'na-f-class', 'na-f-show'].forEach(function (id) {
  document.getElementById(id).addEventListener('change', function () { naApplyFilter(true); });
});

// ── strip tooltip (mouse/touch). Keyboard and screen-reader users get each lane's summary label
// and the "Days with downtime" table, which carries the same numbers. ──────────────────────────
(function () {
  var card = document.getElementById('na-strip-card');
  var tip = document.getElementById('na-tip');
  function hide() { tip.style.display = 'none'; }
  function show(cell) {
    var src = cell.getAttribute('data-src');
    var x = (naStrip[src] || [])[Number(cell.getAttribute('data-i'))];
    if (!x) { hide(); return; }
    tip.innerHTML = naTipHtml(x, src);
    tip.style.display = '';
    var c = card.getBoundingClientRect(), r = cell.getBoundingClientRect();
    var left = r.left - c.left + r.width / 2 - tip.offsetWidth / 2;
    left = Math.max(6, Math.min(left, card.clientWidth - tip.offsetWidth - 6));
    var top = r.top - c.top - tip.offsetHeight - 8;
    if (top < 4) top = r.bottom - c.top + 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  card.addEventListener('mouseover', function (e) {
    var cell = e.target.closest('.na-cells .na-cell');
    if (cell) show(cell); else hide();
  });
  card.addEventListener('mouseleave', hide);
  card.addEventListener('click', function (e) {
    var cell = e.target.closest('.na-cells .na-cell');
    if (cell) show(cell);
  });
})();

document.addEventListener('DOMContentLoaded', function () { naLoad(); });
// The recorder ledger is ingested every 60 s and the pool probes every 30 s — refreshing faster
// than once a minute would only re-read the same rows.
setInterval(function () { naLoad(); }, 60000);
