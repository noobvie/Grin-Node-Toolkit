// =============================================================================
// Grin Node Status Page — availability.js
// web/04_node_api/public_html/js/availability.js
//
// Fills the "Availability" section from /rest/availability.json (and checks the
// hash chain in /rest/history.json). Both files are copied from the node event
// recorder by node-collector.py, and exist only while publishing is enabled.
//
// The section is hidden unless availability.json loads and has the expected
// shape — a missing or malformed file shows visitors nothing, never an error.
// File data is rendered with textContent only, never as HTML.
// =============================================================================

(function () {
  const REFRESH_MS = 120000;                 // the recorder republishes every few minutes
  const STALE_MS   = 3 * 3600 * 1000;        // > 3x the longest publish interval: nothing refreshes it
  const STATES = {
    up:       ['Up',       'ok'],
    starting: ['Starting', 'warn'],
    down:     ['Down',     'err'],
    unknown:  ['Unknown',  'dim'],
  };

  // ── Small helpers ───────────────────────────────────────────────────────────
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const num   = v => (typeof v === 'number' && isFinite(v) ? v : null);
  const txt   = v => String(v ?? '').slice(0, 80);
  const day   = v => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '—');
  // Whole seconds, rounded by the recorder: 0 is a compaction under a second.
  const secs  = v => (num(v) === null ? '— s' : v < 1 ? '< 1 s' : v + ' s');

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtDur(min) {
    const m = num(min);
    if (m === null) return '—';
    return m < 120 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }

  function put(id, ...children) {
    const e = document.getElementById(id);
    if (e) e.replaceChildren(...children);
  }

  function list(id, rows, emptyText) {
    if (!rows.length) rows.push(el('li', 'none', emptyText));
    put(id, ...rows);
  }

  function row(date, dur, ...rest) {
    const li = el('li');
    li.append(el('span', 'when', day(date)), el('span', 'dur', fmtDur(dur)));
    rest.filter(Boolean).forEach(t => li.append(el('span', null, t)));
    return li;
  }

  // ── Sections ────────────────────────────────────────────────────────────────
  // A record nobody refreshes (recorder removed or stopped) says nothing about now.
  function renderState(d) {
    const g = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})Z$/.exec(d.generated);
    const stale = !g || !(Date.now() - Date.parse(d.generated) <= STALE_MS);
    const [label, cls] = (!stale && STATES[d.state]) || STATES.unknown;
    const days = !stale && d.state === 'up' ? num(d.up_days) : null;
    const s = document.getElementById('av-state');
    s.textContent = label + (days === null ? '' : ' · up ' + days + (days === 1 ? ' day' : ' days'));
    s.className = 'card-value ' + cls;
    put('av-updated', g ? (stale ? 'Not refreshed since ' : 'Updated ') + g[1] + ' ' + g[2] + ' UTC' : '');
  }

  function renderWindows(w) {
    const rows = [];
    for (const k of ['7', '30', '90']) {
      const x = w[k];
      if (!isObj(x)) continue;
      const pct = num(x.pct), obs = num(x.observed_d);
      const tr = el('tr');
      tr.append(el('td', null, k + ' d'),
                el('td', 'pct', pct === null ? 'n/a' : pct.toFixed(2) + ' %'),
                el('td', null, obs === null ? '—' : obs.toFixed(1) + ' of ' + k + ' d'),
                el('td', null, (num(x.planned_min) ?? 0) + ' min'),
                el('td', null, String(num(x.outages) ?? 0)));
      rows.push(tr);
    }
    if (!rows.length) throw new Error('no windows');
    put('av-windows', ...rows);
  }

  function renderCompactions(c) {
    if (!isObj(c) || c.logged !== true) {
      put('av-compactions', el('div', 'none', 'Not logged by this grin build.'));
      return;
    }
    const out = [];
    const d30 = isObj(c.d30) ? c.d30 : null;
    if (d30) out.push(el('div', 'card-sub',
      'Last 30 d: ' + (num(d30.count) ?? 0) + ' · median ' + secs(d30.median_s) +
      ' · max ' + secs(d30.max_s)));
    const ul = el('ul', 'avail-list');
    const last = Array.isArray(c.last) ? c.last.filter(isObj).slice(0, 10) : [];
    if (!last.length) ul.append(el('li', 'none', 'None recorded yet.'));
    last.forEach(x => {
      const li = el('li');
      li.append(el('span', 'when', day(x.date)), el('span', 'dur', secs(x.duration_s)));
      ul.append(li);
    });
    out.push(ul);
    put('av-compactions', ...out);
  }

  function renderChain(d) {
    const c = isObj(d.chain) ? d.chain : {};
    const head = /^[0-9a-f]{64}$/.test(c.head) ? c.head : null;
    const n = num(c.lines) ?? 0;
    put('av-chain', n + ' history entries · chain head ', el('code', null, head || '—'));
    const origin = window.location.origin;
    const curl = document.getElementById('av-curl');
    curl.textContent =
      `curl -s -X POST ${origin}/v2/foreign \\\n` +
      `     -H 'Content-Type: application/json' \\\n` +
      `     -d '{"jsonrpc":"2.0","method":"get_tip","params":[],"id":1}'`;
    document.getElementById('av-verify').textContent =
      `curl -s ${origin}/rest/history.json | jq -r '.lines[]' | { p=null\n` +
      `while IFS= read -r l; do\n` +
      `  [ "$(printf %s "$l" | jq -r .prev)" = "$p" ] || echo "BROKEN before: $l"\n` +
      `  p=$(printf %s "$l" | sha256sum | cut -d' ' -f1)\n` +
      `done; echo "head $p"; }`;
    return head;
  }

  // ── Chain check in the browser (informational; the recipe above is the proof) ─
  async function sha256(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }

  async function checkChain(head) {
    let msg = '';
    try {
      if (!(window.crypto && crypto.subtle)) return;
      const res = await fetch('/rest/history.json', { cache: 'no-cache' });
      const h = res.ok ? await res.json() : null;
      if (!h || !Array.isArray(h.lines) || !h.lines.length || !h.lines.every(l => typeof l === 'string')) return;
      let prev = null;
      for (let i = 0; i < h.lines.length; i++) {
        if (JSON.parse(h.lines[i]).prev !== prev) { msg = 'Chain check in this browser: entry ' + i + ' does not match the one before it.'; break; }
        prev = await sha256(h.lines[i]);
      }
      if (!msg) msg = 'Chain check in this browser: ' + h.lines.length + ' entries link correctly' +
                      (head && head === prev ? ', head matches the summary above.' : '.');
    } catch (e) { return; }
    put('av-browser-check', msg);
  }

  // ── Load ────────────────────────────────────────────────────────────────────
  async function load() {
    const section = document.getElementById('avail-section');
    if (!section) return;
    try {
      const res = await fetch('/rest/availability.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      if (!isObj(d) || d.v !== 1 || !isObj(d.windows)) throw new Error('unexpected shape');
      renderState(d);
      renderWindows(d.windows);
      list('av-outages', (Array.isArray(d.outages) ? d.outages : []).filter(isObj)
        .map(o => row(o.date, o.duration_min, txt(o.kind), o.error ? '· ' + txt(o.error) : '')),
        'No outages in the last 90 days.');
      list('av-planned', (Array.isArray(d.planned) ? d.planned : []).filter(isObj)
        .map(p => row(p.date, p.duration_min)), 'No planned restarts in the last 90 days.');
      renderCompactions(d.compactions);
      const head = renderChain(d);
      section.hidden = false;
      checkChain(head);
    } catch (e) {
      section.hidden = true;
    }
  }

  load();
  setInterval(load, REFRESH_MS);
})();
