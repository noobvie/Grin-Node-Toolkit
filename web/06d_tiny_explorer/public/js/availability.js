// Node Availability page. Fills the page from /api/availability and checks the
// hash chain from /api/availability/history. File data is rendered with
// textContent only, never as HTML. When the API answers 404 (publishing is off)
// or the shape is wrong, only the "not published" note is shown.
(function () {
  'use strict';
  if (document.body.dataset.page !== 'availability') return;

  const STATES = { up: 'Up', starting: 'Starting', down: 'Down', unknown: 'Unknown' };
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
  const day = v => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '—');
  // Whole seconds, rounded by the recorder: 0 is a compaction under a second.
  const secs = v => (num(v) === null ? '— s' : v < 1 ? '< 1 s' : v + ' s');
  const $ = id => document.getElementById(id);

  function el(tag, text) {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    return e;
  }
  const put = (id, ...kids) => $(id).replaceChildren(...kids);

  function dur(min) {
    const m = num(min);
    if (m === null) return '—';
    return m < 120 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }

  // One line per event: "date · duration · extra". Empty list shows the fallback.
  function lines(id, rows, none) {
    const kids = rows.filter(isObj).slice(0, 50).map(r =>
      el('div', [day(r.date), dur(r.duration_min),
        r.kind ? String(r.kind).slice(0, 80) : '',
        r.error ? String(r.error).slice(0, 80) : ''].filter(Boolean).join(' · ')));
    put(id, ...(kids.length ? kids : [el('div', none)]));
  }

  function renderWindows(w) {
    const rows = ['7', '30', '90'].filter(k => isObj(w[k])).map(k => {
      const x = w[k], pct = num(x.pct), obs = num(x.observed_d);
      const tr = el('tr');
      [k + ' d', pct === null ? 'n/a' : pct.toFixed(2) + ' %',
       obs === null ? '—' : obs.toFixed(1) + ' of ' + k + ' d observed',
       (num(x.planned_min) ?? 0) + ' min', String(num(x.outages) ?? 0)]
        .forEach(t => tr.append(el('td', t)));
      return tr;
    });
    if (!rows.length) throw new Error('no windows');
    put('av-windows', ...rows);
  }

  function renderCompactions(c) {
    if (!isObj(c) || c.logged !== true) return put('av-compactions', el('div', 'Not logged by this grin build.'));
    const d = isObj(c.d30) ? c.d30 : {};
    const kids = [el('div', 'Last 30 d: ' + (num(d.count) ?? 0) + ' · median ' + secs(d.median_s) +
      ' · max ' + secs(d.max_s))];
    (Array.isArray(c.last) ? c.last : []).filter(isObj).slice(0, 10)
      .forEach(x => kids.push(el('div', day(x.date) + ' · ' + secs(x.duration_s))));
    put('av-compactions', ...kids);
  }

  function renderCheck(d) {
    const o = location.origin;
    const head = isObj(d.chain) && /^[0-9a-f]{64}$/.test(d.chain.head) ? d.chain.head : '—';
    put('av-chain', (num(d.chain && d.chain.lines) ?? 0) + ' history entries · chain head ', el('code', head));
    $('av-curl').textContent = 'curl -s ' + o + '/api/tip';
    $('av-verify').textContent =
      'curl -s ' + o + "/api/availability/history | jq -r '.lines[]' | { p=null\n" +
      'while IFS= read -r l; do\n' +
      '  [ "$(printf %s "$l" | jq -r .prev)" = "$p" ] || echo "BROKEN before: $l"\n' +
      "  p=$(printf %s \"$l\" | sha256sum | cut -d' ' -f1)\n" +
      'done; echo "head $p"; }';
    return head;
  }

  async function sha256(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }

  // Informational only; the command above is the proof. Silent when it cannot run.
  async function checkChain(head) {
    try {
      if (!(window.crypto && crypto.subtle)) return;
      const res = await fetch('/api/availability/history', { cache: 'no-cache' });
      const h = res.ok ? await res.json() : null;
      if (!h || !Array.isArray(h.lines) || !h.lines.length || !h.lines.every(l => typeof l === 'string')) return;
      let prev = null, msg = '';
      for (let i = 0; i < h.lines.length && !msg; i++) {
        if (JSON.parse(h.lines[i]).prev !== prev) msg = 'Chain check in this browser: entry ' + i + ' does not match the one before it.';
        else prev = await sha256(h.lines[i]);
      }
      put('av-browser-check', msg || 'Chain check in this browser: ' + h.lines.length +
        ' entries link correctly' + (head === prev ? ', head matches the summary above.' : '.'));
    } catch { /* leave the line empty */ }
  }

  async function load() {
    try {
      const res = await fetch('/api/availability', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      if (!isObj(d) || d.v !== 1 || !isObj(d.windows)) throw new Error('unexpected shape');
      // Older than 3x the longest publish interval: nothing refreshes it, so it says nothing about now.
      const g = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})Z$/.exec(d.generated);
      const stale = !g || !(Date.now() - Date.parse(d.generated) <= 3 * 3600 * 1000);
      const days = !stale && d.state === 'up' ? num(d.up_days) : null;
      put('av-state', ((!stale && STATES[d.state]) || STATES.unknown) + (days === null ? '' : ' · up ' + days + (days === 1 ? ' day' : ' days')));
      put('av-updated', g ? (stale ? 'Not refreshed since ' : 'Updated ') + g[1] + ' ' + g[2] + ' UTC' : '');
      renderWindows(d.windows);
      lines('av-outages', Array.isArray(d.outages) ? d.outages : [], 'No outages in the last 90 days.');
      lines('av-planned', Array.isArray(d.planned) ? d.planned : [], 'No planned restarts in the last 90 days.');
      renderCompactions(d.compactions);
      const head = renderCheck(d);
      $('av-none').hidden = true;
      $('av-content').hidden = false;
      checkChain(head);
    } catch {
      $('av-content').hidden = true;
      $('av-none').hidden = false;
    }
  }

  load();
  setInterval(load, 120000);
})();
