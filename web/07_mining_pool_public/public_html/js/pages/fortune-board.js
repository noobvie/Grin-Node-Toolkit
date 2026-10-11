// fortune-board.js — the fortune-board page's own script. Until 2026-10 (pool code-layout refactor,
// part F2) this was fortune-board.html's inline <script> block; it moved out byte-for-byte so
// a strict script-src can drop 'unsafe-inline'. The block's indent is kept.
//
// The page loads it as a CLASSIC script at the block's old position. Never add defer / async /
// type="module": the order and the shared global scope are what this code was written against.
        // Paginated fortune board, fed by the public winner-history endpoint. All fetched winners
        // accumulate in `all`; the search box + pot filter narrow them client-side (over what's
        // loaded), and "Load more" pulls older draws into the searchable set. Headline tiles + the
        // three charts come from /api/public/lottery/stats (server-side aggregate over ALL history).
        var offset = 0;
        var PAGE = 25;
        var total = 0;
        var loadedAny = false;
        var all = [];

        function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
        function fmtDate(sec) { return sec ? new Date(sec * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—'; }
        function shortHash(h) { return h ? esc(h.slice(0, 10)) + '…' : '—'; }
        function potLabel(p) { return p === 'a' ? 'Share-weighted' : 'Equal chance'; }
        function fmtGrin(v) { return Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 3 }) + ' GRIN'; }
        function setStat(id, text) { var el = document.getElementById(id); if (el) el.textContent = text; }
        function toggleEmpty(id, show) { var el = document.getElementById(id); if (el) el.style.display = show ? 'flex' : 'none'; }

        // "2026-07" → "Jul 26" (UTC calendar month, matches the server aggregation).
        function monthLabel(ym) {
            var parts = String(ym || '').split('-');
            if (parts.length < 2) return ym || '';
            var d = new Date(Date.UTC(+parts[0], +parts[1] - 1, 1));
            return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
        }

        function filtered() {
            var q = (document.getElementById('fb-search').value || '').trim().toLowerCase();
            var pot = document.getElementById('fb-pot').value;
            return all.filter(function (w) {
                if (pot && w.pot !== pot) return false;
                if (!q) return true;
                var hay = (w.address + ' ' + (w.event || '') + ' ' + (w.seed_hash || '') + ' ' + potLabel(w.pot)).toLowerCase();
                return hay.indexOf(q) !== -1;
            });
        }

        function render() {
            var body = document.getElementById('winners-body');
            var count = document.getElementById('fb-count');
            if (!loadedAny) return; // initial loading / empty states handled in loadWinners
            var rows = filtered();
            var q = (document.getElementById('fb-search').value || '').trim();
            var isFiltering = q || document.getElementById('fb-pot').value;
            if (!rows.length) {
                body.innerHTML = '<tr><td colspan="6">' +
                    (isFiltering ? 'No loaded winners match — try “Load more” to search older draws.' : 'No winners yet.') +
                    '</td></tr>';
            } else {
                body.innerHTML = rows.map(function (w) {
                    // Seed = the verifiable Grin block each draw is derived from. Deep-link the
                    // height out to a chain explorer (new tab) so anyone can audit the draw.
                    var seedH = w.seed_height;
                    var seedLabel = '#' + (seedH || '?') + ' · ' +
                        (w.seed_hash ? w.seed_hash.slice(0, 10) + '…' : '—');
                    var seedCell = (seedH && window.Explorer)
                        ? Explorer.link('block', seedH, seedLabel)
                        : esc(seedLabel);
                    return '<tr>' +
                        '<td>' + esc(w.event) + '</td>' +
                        '<td>' + esc(w.address) + '</td>' +
                        '<td><span class="pot-tag">' + potLabel(w.pot) + '</span></td>' +
                        '<td class="num"><span class="fb-amount">' + (w.amount || 0).toFixed(4) + ' GRIN</span></td>' +
                        '<td>' + fmtDate(w.drawn_at) + '</td>' +
                        '<td class="fb-seed">' + seedCell + '</td>' +
                        '</tr>';
                }).join('');
            }
            count.textContent = isFiltering
                ? (rows.length + ' of ' + all.length + ' loaded' + (all.length < total ? ' · ' + total + ' total' : ''))
                : (all.length + (all.length < total ? ' of ' + total + ' total' : ' total'));
        }

        function loadWinners() {
            var btn = document.getElementById('more-btn');
            var pager = document.getElementById('fb-pager');
            btn.disabled = true;
            fetch('/api/public/lottery/winners?limit=' + PAGE + '&offset=' + offset, { credentials: 'same-origin' })
                // REJECT a non-2xx rather than folding it into `null` (audit §J15-2): `null`
                // already means "answered, but with nothing", and that branch prints "Winners
                // will appear here after the first draw." A 429 or a 5xx is not that fact.
                .then(function (r) {
                    if (!r.ok) return Promise.reject(new Error('HTTP ' + r.status));
                    return r.json();
                })
                .then(function (json) {
                    var body = document.getElementById('winners-body');
                    if (!json || !json.data) { if (!loadedAny) body.innerHTML = '<tr><td colspan="6">Winners will appear here after the first draw.</td></tr>'; return; }
                    total = json.data.total || 0;
                    var rows = json.data.winners || [];
                    if (!rows.length && !loadedAny) {
                        body.innerHTML = '<tr><td colspan="6">Winners will appear here after the first draw.</td></tr>';
                        return;
                    }
                    loadedAny = true;
                    all = all.concat(rows);
                    offset += rows.length;
                    render();
                    pager.style.display = offset < total ? 'flex' : 'none';
                    btn.disabled = false;
                })
                .catch(function () {
                    if (!loadedAny) document.getElementById('winners-body').innerHTML =
                        '<tr><td colspan="6">Could not load winners.</td></tr>';
                });
        }

        // Headline tiles + the two charts, from the server-side aggregate (covers all history).
        function loadStats() {
            fetch('/api/public/lottery/stats', { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (json) {
                    if (!json || !json.data) return;
                    var d = json.data;
                    PoolFmt.setGrinTile(document.getElementById('fb-total-prizes'), Number(d.total_prizes_grin || 0));
                    setStat('fb-draws', Number(d.total_draws || 0).toLocaleString('en-US'));
                    setStat('fb-unique', Number(d.unique_winners || 0).toLocaleString('en-US'));
                    renderCharts(d);
                })
                .catch(function () { /* tiles keep placeholders, charts keep empty state */ });
        }

        function renderCharts(d) {
            if (typeof PoolCharts === 'undefined') return;

            // P-01 — GRIN paid per calendar month (bar).
            var monthly = Array.isArray(d.monthly) ? d.monthly : [];
            toggleEmpty('fb-empty-prizes', monthly.length === 0);
            PoolCharts.renderBarChart('fb-chart-prizes',
                monthly.map(function (m) { return monthLabel(m.month); }),
                monthly.map(function (m) { return m.amount; }),
                { valueFmt: fmtGrin, label: 'Prizes paid' });

            // P-02 — GRIN awarded by pot type (doughnut). a = share-weighted, b = equal chance.
            var byPot = { a: 0, b: 0 };
            (d.by_pot || []).forEach(function (p) { byPot[p.pot] = p.amount; });
            var a = byPot.a || 0, b = byPot.b || 0;
            toggleEmpty('fb-empty-pots', (a + b) === 0);
            PoolCharts.renderDoughnutChart('fb-chart-pots',
                ['Share-weighted (Pot A)', 'Equal chance (Pot B)'],
                [a, b],
                { colors: ['#7cb342', '#58a6ff'] });

            // P-03 — GRIN awarded per event/campaign (horizontal bar, top events by amount).
            var byEvent = Array.isArray(d.by_event) ? d.by_event : [];
            toggleEmpty('fb-empty-events', byEvent.length === 0);
            PoolCharts.renderBarChart('fb-chart-events',
                byEvent.map(function (e) { return e.event; }),
                byEvent.map(function (e) { return e.amount; }),
                { valueFmt: fmtGrin, label: 'Prizes paid', horizontal: true });
        }

        document.getElementById('fb-search').addEventListener('input', render);
        document.getElementById('fb-pot').addEventListener('change', render);
        loadWinners();
        loadStats();

// ==== F2: event wiring — replaces the inline on*= attributes this page used to carry (strict
// script-src blocks them). One delegated listener per event type, keyed on data-action; each
// action calls the SAME function with the SAME arguments the old attribute did (`event` → e).
document.addEventListener('click', function (e) {
  var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
  if (!el) return;
  switch (el.getAttribute('data-action')) {
    case 'load-winners': loadWinners(); break;
  }
});
