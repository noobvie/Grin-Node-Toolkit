// fortune-board.js — the fortune-board page's own script, external (not inline) so a strict script-src needs no 'unsafe-inline'.
// The original indent is kept.
//
// The page loads it as a CLASSIC script at its original position. Never add defer / async /
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
        var POT_LABELS = { a: 'Share-weighted', b: 'Equal chance', d: 'Daily giveaway' };
        function potLabel(p) { return POT_LABELS[p] || 'Equal chance'; }
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

        // A giveaway winner with several prizes shows a multiple of the prize, so say why. Weekly
        // rows use ticket_count for tickets, which is not for display.
        function prizeCount(w) {
            var n = Number(w.ticket_count);
            return w.pot === 'd' && n > 1 ? ' <span class="dim">×' + n + ' prizes</span>' : '';
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
                    // Seed = the Grin block each draw is derived from. Deep-link the height out to a
                    // chain explorer (new tab) so anyone can look up the seed block. Giveaway
                    // entries are not published, so this shows the seed, not the whole draw.
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
                        '<td class="num"><span class="fb-amount">' + (w.amount || 0).toFixed(4) + ' GRIN</span>' + prizeCount(w) + '</td>' +
                        '<td>' + fmtDate(w.drawn_at) + '</td>' +
                        '<td class="fb-seed">' + seedCell + '</td>' +
                        '</tr>';
                }).join('');
            }
            count.textContent = isFiltering
                ? (rows.length + ' shown from the ' + all.length + ' loaded' + (all.length < total ? ' · load more to search all ' + total : ''))
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
                    renderDaily(d.daily_giveaway);
                })
                .catch(function () { /* tiles keep placeholders, charts keep empty state */ });
        }

        // "1–5 GRIN", or "2 GRIN" when the operator set one fixed figure.
        function rangeText(lo, hi) {
            var fmt = function (n) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: 9 }); };
            return lo === hi ? fmt(lo) : fmt(lo) + '–' + fmt(hi);
        }

        function renderDaily(r) {
            var box = document.getElementById('fb-daily');
            if (!r) { box.style.display = 'none'; return; }
            var who = r.max_winners === 1 ? ' to 1 miner'
                : ', split into ' + rangeText(r.min_winners, r.max_winners) + ' equal prizes';
            setStat('fb-daily-text', 'Every day, while the prize pool can cover it, the pool gives away ' + rangeText(r.min_grin, r.max_grin) + ' GRIN' + who + '. ' +
                'Mine for at least ' + r.min_active_hours + (r.min_active_hours === 1 ? ' hour' : ' hours') +
                ' in a UTC day to enter that day\'s draw. ' +
                (r.max_winners === 1
                    ? 'Your chance follows the work you did that day. '
                    : 'Each prize is drawn separately and your chance of each one follows the work you did that day, so one miner can win more than one. ') +
                'A very slow rig may need longer, because only minutes with an accepted share count. ' +
                'Winners are drawn within about two hours of 00:00 UTC. Prizes go to your pool balance, ' +
                'which you can withdraw from your Account page once it reaches the payout minimum.');
            box.style.display = '';
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

            // P-02 — GRIN awarded by pot type (doughnut). a = share-weighted, b = equal chance,
            // d = daily giveaway.
            var byPot = { a: 0, b: 0, d: 0 };
            (d.by_pot || []).forEach(function (p) { byPot[p.pot] = p.amount; });
            var a = byPot.a || 0, b = byPot.b || 0, dg = byPot.d || 0;
            toggleEmpty('fb-empty-pots', (a + b + dg) === 0);
            PoolCharts.renderDoughnutChart('fb-chart-pots',
                ['Share-weighted (Pot A) · ' + fmtGrin(a), 'Equal chance (Pot B) · ' + fmtGrin(b), 'Daily giveaway · ' + fmtGrin(dg)],
                [a, b, dg],
                { colors: ['#7cb342', '#58a6ff', '#f2cc60'] });
            document.getElementById('fb-chart-pots').setAttribute('aria-label',
                'GRIN awarded by pot: share-weighted ' + fmtGrin(a) + ', equal chance ' + fmtGrin(b) + ', daily giveaway ' + fmtGrin(dg));

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

// ==== Event wiring — delegated listeners stand in for inline on*= attributes (strict
// script-src blocks them). One listener per event type, keyed on data-action; each
// action calls the page function with the arguments the attribute would have passed (`event` → e).
document.addEventListener('click', function (e) {
  var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
  if (!el) return;
  switch (el.getAttribute('data-action')) {
    case 'load-winners': loadWinners(); break;
  }
});
