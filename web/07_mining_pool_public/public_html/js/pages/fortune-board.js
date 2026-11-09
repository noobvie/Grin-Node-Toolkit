// fortune-board.js — the fortune-board page's own script, external (not inline) so a strict
// script-src needs no 'unsafe-inline'. Loaded deferred, after js/pages/fortune-board-offers.js
// (FbOffers: the offer cards + shared formatters), charts-init.js and num-format.js.
//
// Feeds:
//   /api/public/incentives/overview  placard, offer cards, P-01..P-04 (all history, server-side)
//   /api/public/incentives/history   the reward-history table, keyset-paged: Load more passes the
//                                    previous answer's `next` as `before`; the Type filter is a
//                                    server-side `kind` and restarts with no cursor; the search
//                                    box narrows what is loaded
//
// Every GRIN figure in text, legends and tooltips goes through PoolFmt (grinTile short with the
// exact figure as its title, grinExact where there is no title); only chart axis ticks use the
// compact gAxis form.
//
// Traps:
//   - A failed fetch must never read as "nothing paid yet" (audit §J15-2): every non-2xx is a
//     rejection and has its own "could not load" text. A 400 (bad cursor or kind) is a failure too.
//   - history refuses kind=streak with a 400. Streak bonuses are totals only (operator decision:
//     a per-address row would publish that miner's per-block earnings), so the filter never
//     offers it.
//   - A history row older than the ledger rollup horizon keeps only its UTC day: `at` is that
//     midnight, block_height is null, the amount can sum several credits of that day, and a
//     rolled jackpot's clawed_back is null (unknown). Those rows say "daily total", show a date
//     without a time, and carry no block link and no clawback tag.
(function () {
    'use strict';

    var esc = FbOffers.esc;
    var PAGE = 25;
    var DAY = 86400;
    var KIND_ORDER = ['lottery', 'giveaway', 'jackpot', 'join_bonus', 'streak', 'award'];
    var KIND_LABELS = {
        lottery: 'Prize draws', giveaway: 'Daily giveaway', jackpot: 'Block-finder jackpot',
        join_bonus: 'Join bonus', streak: 'Loyalty streak', award: 'Operator award'
    };
    // Fixed slot per kind (never by rank), from the shared chart palette.
    var KIND_COLORS = {
        lottery: '#3987e5', giveaway: '#c98500', jackpot: '#d55181',
        join_bonus: '#199e70', streak: '#d95926', award: '#9085e9'
    };
    var CHARTS = [
        ['fb-chart-monthly', 'fb-empty-monthly'], ['fb-chart-kinds', 'fb-empty-kinds'],
        ['fb-chart-flows', 'fb-empty-flows'], ['fb-chart-events', 'fb-empty-events']
    ];

    function $(id) { return document.getElementById(id); }
    function gExact(v) { return PoolFmt.grinExact(Number(v) || 0, 'GRIN'); }
    // HTML: the short tile figure, the exact one as its title.
    function gHtml(v) { return '<b title="' + esc(gExact(v)) + '">' + esc(PoolFmt.grinTile(Number(v) || 0, 'GRIN')) + '</b>'; }
    // Chart value formatter: exact in tooltips, compact on the axis (charts-init reads .axis).
    function gChart(v) { return gExact(v); }
    gChart.axis = function (v) { return PoolFmt.grinTile(Number(v) || 0, ''); };

    function setText(id, text) { var el = $(id); if (el) el.textContent = text; }
    function show(el, on) { if (el) el.style.display = on ? '' : 'none'; }
    function announce(text) { setText('fb-status', text); }
    // A chart's overlay: '' hides it, any text shows it over the empty canvas.
    function chartState(id, text) {
        var el = $(id);
        if (!el) return;
        el.textContent = text || '';
        el.style.display = text ? 'flex' : 'none';
    }
    function chartsFailed() {
        CHARTS.forEach(function (c) {
            chartState(c[1], 'COULD NOT LOAD');
            var cv = $(c[0]);
            if (cv) cv.setAttribute('aria-label', 'Chart could not load');
        });
    }

    // "2026-07" → "Jul 2026" (UTC calendar month, as the server buckets it).
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function monthLabel(ym) {
        var m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
        return m ? MONTHS[+m[2] - 1] + ' ' + m[1] : String(ym || '');
    }

    function getJson(url) {
        return fetch(url, { credentials: 'same-origin' }).then(function (r) {
            if (!r.ok) return Promise.reject(new Error('HTTP ' + r.status));
            return r.json();
        }).then(function (json) {
            if (!json || !json.data) return Promise.reject(new Error('no data'));
            return json.data;
        });
    }

    // ── overview: placard, offers, P-01..P-04 ──────────────────────────────────

    function renderPlacard(d) {
        var g = d.given || {};
        PoolFmt.setGrinTile($('fb-prize-pool'), Number(d.prize_pool_grin || 0), 'GRIN');
        PoolFmt.setGrinTile($('fb-total-given'), Number(g.total_grin || 0), 'GRIN');
        setText('fb-miners', Number(g.miners_rewarded || 0).toLocaleString('en-US'));
        setText('fb-draws', Number(g.draws_held || 0).toLocaleString('en-US'));
    }

    function renderCharts(g, flows) {
        if (typeof PoolCharts === 'undefined' || typeof window.Chart === 'undefined') { chartsFailed(); return; }
        var byKind = Array.isArray(g.by_kind) ? g.by_kind : [];
        var monthly = Array.isArray(g.monthly) ? g.monthly : [];

        // P-01: stacked GRIN per month, one series per kind that has ever paid.
        var used = KIND_ORDER.filter(function (k) {
            return monthly.some(function (m) { return Number(m[k]) > 0; });
        });
        chartState('fb-empty-monthly', used.length ? '' : 'NOTHING PAID YET');
        PoolCharts.renderGroupedBarChart('fb-chart-monthly',
            monthly.map(function (m) { return monthLabel(m.month); }),
            used.map(function (k) {
                return { label: KIND_LABELS[k], color: KIND_COLORS[k], data: monthly.map(function (m) { return Number(m[k]) || 0; }) };
            }),
            { valueFmt: gChart, stacked: true });
        $('fb-chart-monthly').setAttribute('aria-label', used.length
            ? 'GRIN given per month: ' + monthly.map(function (m) {
                var sum = KIND_ORDER.reduce(function (s, k) { return s + (Number(m[k]) || 0); }, 0);
                return monthLabel(m.month) + ' ' + gExact(sum);
            }).join(', ')
            : 'Nothing given yet');

        // P-02: lifetime GRIN by kind. The legend names the kind; the amount is in the tooltip.
        var slices = byKind.filter(function (k) { return Number(k.grin) > 0 && KIND_LABELS[k.kind]; });
        chartState('fb-empty-kinds', slices.length ? '' : 'NOTHING PAID YET');
        PoolCharts.renderDoughnutChart('fb-chart-kinds',
            slices.map(function (k) { return KIND_LABELS[k.kind]; }),
            slices.map(function (k) { return Number(k.grin) || 0; }),
            { colors: slices.map(function (k) { return KIND_COLORS[k.kind]; }), valueFmt: gExact });
        $('fb-chart-kinds').setAttribute('aria-label', slices.length
            ? 'GRIN given by kind: ' + slices.map(function (k) { return KIND_LABELS[k.kind] + ' ' + gExact(k.grin); }).join(', ')
            : 'Nothing given yet');

        renderFlows(flows || {});
        renderEvents(Array.isArray(g.by_event) ? g.by_event : []);
    }

    // P-03: prize pool in vs out, two bars plus the breakdown by source and by use.
    function renderFlows(f) {
        var inn = f.in || { total: 0, by: [] };
        var out = f.out || { total: 0, by: [] };
        var inTotal = Number(inn.total) || 0;
        var outTotal = Number(out.total) || 0;
        var any = inTotal > 0 || outTotal > 0;
        chartState('fb-empty-flows', any ? '' : 'NO PRIZE POOL ACTIVITY YET');
        PoolCharts.renderBarChart('fb-chart-flows', ['Paid in', 'Paid out'], [inTotal, outTotal],
            { valueFmt: gChart, label: 'Prize pool', horizontal: true });
        $('fb-chart-flows').setAttribute('aria-label',
            'Prize pool: paid in ' + gExact(inTotal) + ', paid out ' + gExact(outTotal));

        var rows = function (list) {
            return (Array.isArray(list) ? list : []).filter(function (x) { return Number(x.amount) > 0; }).map(function (x) {
                return '<li><span>' + esc(x.label || x.key) + '</span>' + gHtml(x.amount) + '</li>';
            }).join('') || '<li><span class="dim">None yet</span></li>';
        };
        var box = $('fb-flows-detail');
        box.innerHTML =
            '<div><div class="fb-flow-head">Paid in · ' + gHtml(inTotal) + '</div><ul class="fb-flow-list">' + rows(inn.by) + '</ul></div>' +
            '<div><div class="fb-flow-head">Paid out · ' + gHtml(outTotal) + '</div><ul class="fb-flow-list">' + rows(out.by) + '</ul></div>';
        show(box, any);

        var balance = Number(f.balance) || 0;
        var diff = inTotal - outTotal;
        setText('fb-flows-balance', any
            ? (Math.abs(diff - balance) < 1e-6
                ? 'Paid in ' + gExact(inTotal) + ' − paid out ' + gExact(outTotal) + ' = ' + gExact(balance) + ', the prize pool balance now.'
                : 'Paid in − paid out = ' + gExact(diff) + '. Prize pool balance now: ' + gExact(balance) + '.')
            : '');
    }

    // P-04: prizes by event (overview given.by_event). Hidden when no draw has paid. The canvas
    // grows with the bar count so every event keeps a readable row.
    function renderEvents(list) {
        var byEvent = list.filter(function (e) { return Number(e.amount) > 0; });
        if (!byEvent.length) { show($('fb-events-panel'), false); return; }
        chartState('fb-empty-events', '');
        var cv = $('fb-chart-events');
        cv.style.height = Math.max(240, byEvent.length * 26 + 60) + 'px';
        PoolCharts.renderBarChart('fb-chart-events',
            byEvent.map(function (e) { return e.event; }),
            byEvent.map(function (e) { return Number(e.amount) || 0; }),
            { valueFmt: gChart, label: 'Prizes paid', horizontal: true });
        cv.setAttribute('aria-label', 'GRIN awarded by event: ' +
            byEvent.map(function (e) { return e.event + ' ' + gExact(e.amount); }).join(', '));
    }

    function loadOverview() {
        announce('Loading prizes and bonuses…');
        getJson('/api/public/incentives/overview').then(function (d) {
            if (!d.enabled) {
                show($('fb-off'), true);
                show($('fb-live'), false);
                announce('This pool is not running any prizes or bonuses right now.');
                return;
            }
            renderPlacard(d);
            FbOffers.render($('fb-offers'), d.offers, (d.given || {}).by_kind, (d.given || {}).streak_active_miners);
            renderCharts(d.given || {}, d.pool_flows);
            announce('Prizes and bonuses loaded.');
        }).catch(function () {
            $('fb-offers').innerHTML = '<p class="fb-state">Could not load the current prizes and bonuses. Reload the page to try again.</p>';
            show($('fb-overview-failed'), true);
            chartsFailed();
            announce('Could not load the prizes and bonuses.');
        });
    }

    // ── reward history ─────────────────────────────────────────────────────────

    var hist = { kind: '', next: null, total: 0, rows: [], loaded: false, seq: 0, plainLinks: false };

    // Rolled rows keep only their UTC day (see the header). A raw jackpot always has a boolean
    // clawed_back; join-bonus and award rows carry no height, so midnight is their only mark.
    function isRolled(r) {
        if (r.kind === 'lottery' || r.kind === 'giveaway') return false;
        if (r.kind === 'jackpot') return r.clawed_back == null;
        return r.at % DAY === 0;
    }
    function rowDate(r) { return isRolled(r) ? FbOffers.fmtDate(r.at) : FbOffers.fmtDateTime(r.at); }

    function blockLink(height, label) {
        if (window.Explorer) return Explorer.link('block', height, label);
        hist.plainLinks = true;
        return esc(label);
    }

    function seedCell(r) {
        if (!r.seed_height) return '<span class="dim">seed pending</span>';
        return blockLink(r.seed_height, 'Seed #' + r.seed_height + ' · ' + (r.seed_hash ? String(r.seed_hash).slice(0, 10) + '…' : '—'));
    }

    function detailCell(r) {
        var daily = isRolled(r) ? ' <span class="fb-tag">daily total</span>' : '';
        switch (r.kind) {
            case 'lottery':
                return esc(r.event || 'Draw') + ' · <span class="fb-seed">' + seedCell(r) + '</span>';
            case 'giveaway':
                return (Number(r.prizes) > 1 ? '×' + esc(r.prizes) + ' prizes · ' : '') + '<span class="fb-seed">' + seedCell(r) + '</span>';
            case 'jackpot':
                if (isRolled(r)) return 'Found a block' + daily;
                return (r.block_height != null ? blockLink(r.block_height, 'Block #' + r.block_height) : 'Found a block') +
                    (r.clawed_back ? ' <span class="fb-tag fb-tag--warn">Clawed back · block orphaned</span>' : '');
            case 'join_bonus': return 'Paid at a confirmed withdrawal' + daily;
            case 'award': return 'Awarded by the operator' + daily;
            default: return '';
        }
    }

    function matches(r, q) {
        if (!q) return true;
        var hay = [r.address, r.event, r.seed_hash, r.seed_height, r.block_height, KIND_LABELS[r.kind]]
            .filter(function (x) { return x != null; }).join(' ').toLowerCase();
        return hay.indexOf(q) !== -1;
    }

    function renderHistory() {
        if (!hist.loaded) return;
        hist.plainLinks = false;
        var body = $('fb-history-body');
        var q = ($('fb-search').value || '').trim().toLowerCase();
        var rows = hist.rows.filter(function (r) { return matches(r, q); });
        var more = !!hist.next;
        if (!hist.rows.length) {
            body.innerHTML = '<tr><td colspan="5">' + (hist.kind ? 'Nothing of this type has been paid yet.' : 'Nothing paid yet.') + '</td></tr>';
        } else if (!rows.length) {
            body.innerHTML = '<tr><td colspan="5">No loaded rows match' + (more ? ' — try “Load more” to search older rewards.' : '.') + '</td></tr>';
        } else {
            body.innerHTML = rows.map(function (r) {
                return '<tr' + (r.clawed_back ? ' class="fb-clawed"' : '') + '>' +
                    '<td><span class="fb-tag">' + esc(KIND_LABELS[r.kind] || r.kind) + '</span></td>' +
                    '<td class="fb-addr">' + esc(r.address) + '</td>' +
                    '<td class="num"><span class="fb-amount">' + esc(gExact(r.amount)) + '</span></td>' +
                    '<td class="fb-when">' + esc(rowDate(r)) + '</td>' +
                    '<td>' + detailCell(r) + '</td>' +
                    '</tr>';
            }).join('');
        }
        setText('fb-count', q
            ? rows.length + ' shown from the ' + hist.rows.length + ' loaded' + (more ? ' · load more to search all ' + hist.total : '')
            : hist.rows.length + (more ? ' of ' + hist.total : ' total'));
    }

    function loadHistory(reset) {
        var btn = $('fb-more');
        var pager = $('fb-pager');
        if (reset) {
            hist.seq++;
            hist.next = null; hist.total = 0; hist.rows = []; hist.loaded = false;
            $('fb-history-body').innerHTML = '<tr><td colspan="5">Loading…</td></tr>';
            setText('fb-count', '');
            show(pager, false);
        }
        var seq = hist.seq;
        btn.disabled = true;
        var url = '/api/public/incentives/history?limit=' + PAGE +
            (hist.kind ? '&kind=' + encodeURIComponent(hist.kind) : '') +
            (!reset && hist.next ? '&before=' + encodeURIComponent(hist.next) : '');
        getJson(url).then(function (d) {
            if (seq !== hist.seq) return; // the filter changed while this page was in flight
            var rows = Array.isArray(d.rows) ? d.rows : [];
            hist.total = Number(d.total) || 0;
            hist.rows = hist.rows.concat(rows);
            hist.next = typeof d.next === 'string' && d.next ? d.next : null;
            hist.loaded = true;
            renderHistory();
            btn.textContent = 'Load more';
            btn.disabled = false;
            show(pager, !!hist.next);
        }).catch(function () {
            if (seq !== hist.seq) return;
            btn.disabled = false;
            if (!hist.loaded) {
                $('fb-history-body').innerHTML = '<tr><td colspan="5">Could not load the reward history. Reload the page to try again.</td></tr>';
                show(pager, false);
                announce('Could not load the reward history.');
            } else {
                btn.textContent = 'Could not load — try again';
            }
        });
    }

    // Rows drawn before branding.js defined window.Explorer show plain seed/block text; draw
    // them once more as links when it is there.
    function relinkHistory() { if (hist.plainLinks && window.Explorer) renderHistory(); }

    // ── event wiring ───────────────────────────────────────────────────────────
    // Delegated listeners stand in for inline on*= attributes (strict script-src blocks them),
    // one per event type, keyed on data-action.
    document.addEventListener('click', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
        if (!el) return;
        switch (el.getAttribute('data-action')) {
            case 'load-history': loadHistory(false); break;
        }
    });
    document.addEventListener('input', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
        if (!el) return;
        switch (el.getAttribute('data-action')) {
            case 'search-history': renderHistory(); break;
        }
    });
    document.addEventListener('change', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
        if (!el) return;
        switch (el.getAttribute('data-action')) {
            case 'filter-history': hist.kind = el.value; loadHistory(true); break;
        }
    });
    document.addEventListener('DOMContentLoaded', relinkHistory);
    window.addEventListener('load', relinkHistory);

    loadOverview();
    loadHistory(true);
})();
