// blocks.js — the blocks page's own script, external (not inline) so a strict script-src needs no 'unsafe-inline'.
// The original indent is kept.
//
// The page loads it as a CLASSIC script at its original position. Never add defer / async /
// type="module": the order and the shared global scope are what this code was written against.
        // Public blocks deck. All data comes from public endpoints:
        //   /api/pool/stats                        summary KPIs (total/confirmed/immature/24h/7d) + their ツ
        //   /api/pool/blocks?limit&offset&status   paginated explorer rows (plain array; last page = short page)
        //   /api/pool/blocks/history?range         durable series → P-01 luck / P-02 found vs expected /
        //                                          P-03 status / P-04 time between blocks / P-05 UTC-hour heatmap
        // Block deep-links are built by window.Explorer (js/branding.js) — the single source of
        // truth for explorer base + path scheme, which differs per explorer. This page only
        // primes the network cache Explorer reads (see the pool-info fetch below). All external
        // fields rendered via textContent / escaped — never trust block.found_by etc. as markup.
        const PAGE_SIZE = 25;
        let _page = 0;       // zero-based
        let _filter = '';
        let _lastFull = false; // did the last fetch return a full page (more may exist)?

        function escHtml(v) {
            return String(v == null ? '' : v)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }
        function shortAddr(a) {
            a = String(a || '');
            if (!a || a === 'unknown') return '—';
            return a.length > 16 ? a.slice(0, 9) + '…' + a.slice(-4) : a;
        }
        // UTC "YYYY-MM-DD HH:MM" — the page states UTC once in its header, so never local time here.
        function fmtTs(t) { return t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—'; }
        function timeAgo(t) {
            if (!t) return '—';
            const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
            if (s < 60) return s + 's ago';
            if (s < 3600) return Math.floor(s / 60) + 'm ago';
            if (s < 86400) return Math.floor(s / 3600) + 'h ago';
            return Math.floor(s / 86400) + 'd ago';
        }
        // GRIN amount for the placard sub-lines (ツ = Grin symbol). Two decimals: a block's fees
        // are a few hundredths, and the small print has no room for more.
        function fmtGrin(v) {
            return Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ツ';
        }

        // Two success labels only: Maturing → Matured. 'paid' is a pool-internal step
        // (rewards.js flips confirmed→paid once the round is credited to miner balances); it
        // says nothing about the block itself, and read as "the miners were paid out", which
        // is a separate withdrawal. Both render as Matured.
        const STATUS = {
            immature:  ['Maturing', '#d29922'],
            confirmed: ['Matured',  '#3fb950'],
            paid:      ['Matured',  '#3fb950'],
            orphaned:  ['Orphaned', '#f85149'],
        };
        function statusCell(st) {
            const [label, color] = STATUS[st] || [st || 'unknown', 'var(--dark-dim)'];
            return '<span class="badge" style="background:' + color + '22;color:' + color +
                   ';border:1px solid ' + color + '55;">' + escHtml(label) + '</span>';
        }
        function luckCell(b) {
            const nd = Number(b.network_difficulty) || 0;
            const rs = Number(b.round_shares) || 0;
            if (nd <= 0 || rs <= 0) return '<td class="num dim">—</td>';
            const v = (rs / nd) * 100;
            const color = v <= 100 ? '#3fb950' : '#f85149';
            return '<td class="num" style="color:' + color + '" title="round shares ÷ network difficulty">' +
                   v.toFixed(0) + '%</td>';
        }
        // The fee recorded on the block when it was found — what its reward is split at. An
        // orphan's reward never arrived, so nothing is split; null = not on record.
        function feeCell(b) {
            const pct = b.fee_percent;
            if (b.status === 'orphaned' || pct === null || pct === undefined || !isFinite(Number(pct))) {
                return '<td class="num dim">—</td>';
            }
            return '<td class="num">' + Number(Number(pct).toFixed(2)) + '%</td>';
        }

        // no-store + a 20 s abort, for the reason given at Auth.read: a fetch on the connection a
        // phone held before sleeping hangs, and the panel keeps its old value meanwhile.
        async function getJson(url) {
            const ctl = (typeof AbortController === 'function') ? new AbortController() : null;
            const timer = ctl ? setTimeout(() => ctl.abort(), 20000) : null;
            try {
                const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: ctl ? ctl.signal : undefined });
                const j = await r.json().catch(() => null);
                if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
                return j;
            } finally {
                if (timer) clearTimeout(timer);
            }
        }

        async function loadSummary() {
            try {
                const s = await getJson('/api/pool/stats');
                const g = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
                g('kpi-total', s.total_blocks_found != null ? s.total_blocks_found : '—');
                g('kpi-confirmed', s.confirmed_blocks != null ? s.confirmed_blocks : '—');
                g('kpi-immature', s.immature_blocks != null ? s.immature_blocks : '—');
                g('kpi-recent', (s.blocks_24h != null ? s.blocks_24h : 0) + ' / ' + (s.blocks_7d != null ? s.blocks_7d : 0));
                // ツ under each count: the recorded rewards, summed server-side. Blocks found
                // counts orphans, but an orphan's reward never arrived, so its ツ is matured +
                // maturing — never total_reward, which also sums orphans. The orphan count is
                // printed beside it, because a tile's title tooltip never shows on a phone.
                const has = v => v != null && isFinite(Number(v));
                const orphans = has(s.total_blocks_found) && has(s.confirmed_blocks) && has(s.immature_blocks)
                    ? Number(s.total_blocks_found) - Number(s.confirmed_blocks) - Number(s.immature_blocks) : 0;
                g('kpi-total-grin', has(s.confirmed_reward) && has(s.immature_reward)
                    ? fmtGrin(Number(s.confirmed_reward) + Number(s.immature_reward)) +
                      (orphans > 0 ? ' · ' + orphans + ' orphaned' : '') : '—');
                g('kpi-confirmed-grin', has(s.confirmed_reward) ? fmtGrin(s.confirmed_reward) : '—');
                g('kpi-immature-grin', has(s.immature_reward) ? fmtGrin(s.immature_reward) : '—');
                g('kpi-recent-grin', has(s.reward_24h) && has(s.reward_7d)
                    ? Number(s.reward_24h).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' / ' + fmtGrin(s.reward_7d) : '—');
            } catch (e) { /* KPIs keep placeholders */ }
        }

        async function loadBlocks() {
            const tbody = document.getElementById('blocks-tbody');
            tbody.innerHTML = '<tr><td colspan="7">Loading…</td></tr>';
            try {
                const q = '?limit=' + PAGE_SIZE + '&offset=' + (_page * PAGE_SIZE) +
                          (_filter ? '&status=' + encodeURIComponent(_filter) : '');
                const blocks = await getJson('/api/pool/blocks' + q);
                const rows = Array.isArray(blocks) ? blocks : [];
                _lastFull = rows.length === PAGE_SIZE;
                if (!rows.length) {
                    tbody.innerHTML = '<tr><td colspan="7">' +
                        (_page === 0 ? 'No blocks found yet — the pool is still searching.' : 'No more blocks.') +
                        '</td></tr>';
                } else {
                    tbody.innerHTML = rows.map(function (b) {
                        var h = Number(b.height || 0);
                        return '<tr>' +
                            '<td>' + Explorer.link('block', h, h.toLocaleString('en-US')) + '</td>' +
                            '<td>' + statusCell(b.status) + '</td>' +
                            luckCell(b) +
                            feeCell(b) +
                            // No `title` tooltip (audit §J11-1): /api/pool/blocks masks found_by
                            // now, so the tooltip would only repeat the visible text — but the
                            // old one carried the FULL address on every row of an offset-paged,
                            // never-pruned table, which was the cheapest full-address walk there
                            // was. shortAddr() stays as a guard; it is a no-op on a masked value.
                            '<td>' + escHtml(shortAddr(b.found_by)) + '</td>' +
                            '<td>' + escHtml(fmtTs(b.found_at)) + '</td>' +
                            '<td class="num">' + escHtml(timeAgo(b.found_at)) + '</td>' +
                            '</tr>';
                    }).join('');
                }
            } catch (e) {
                tbody.innerHTML = '<tr><td colspan="7">Block data unavailable</td></tr>';
                _lastFull = false;
            }
            updatePager();
        }

        function updatePager() {
            document.getElementById('prev-btn').disabled = _page === 0;
            document.getElementById('next-btn').disabled = !_lastFull;
            document.getElementById('page-label').textContent = 'Page ' + (_page + 1);
        }

        // ── Historical charts (P-01…P-05), driven by the shared range toggle ───────────────────
        let bkRange = 'month';
        const RANGE_NOTE = {
            week:  'last 7 days · daily',
            month: 'last 30 days · daily',
            year:  'last 365 days · weekly',
            all:   'all time · auto-scaled'
        };

        function toggleEmpty(emptyId, show) {
            const el = document.getElementById(emptyId);
            if (el) el.style.display = show ? 'flex' : 'none';
        }

        // UTC bucket labels for the column chart — shared elastic labeller (charts-init.js), which
        // picks the format from the actual span/spacing instead of assuming every block bucket is
        // a day (the 24h range buckets hourly, and the all-time range can bucket by month).
        function bucketLabels(points, bucket) {
            return PoolCharts.timeLabels(points.map(p => p.t), bucket);
        }

        // ── P-04 · time between blocks ─────────────────────────────────────────────────────────
        // `intervals` = [{ height, t, gap, expected, orphaned }] oldest → newest (seconds;
        // expected may be null). Every value put into markup goes through Number() and
        // fmtDuration/toLocaleString — nothing from the API is inserted as text.
        //
        // The summary compares MEANS: the average gap against seconds ÷ expected blocks over the
        // same stretches (time-weighted — the same ratio P-02 shows, and unbiased; a plain mean
        // of the per-block expected values reads ~1.5% lucky when hashrate swings). Never the
        // median: an exponential gap's median is ~69% of its mean, so it would read as luck that
        // is not there. Outside 'all' the FIRST gap straddles the window start, and a gap picked
        // that way runs ~2× expected on average (inspection paradox), so it is drawn but kept out
        // of the averages; truncated, the list never starts with one.
        const LONG_FACTOR = 3;
        function renderGapSummary(intervals, truncated, range) {
            const el = document.getElementById('bk-gap-summary');
            const note = document.getElementById('bk-gap-note');
            if (note) note.textContent = 'per block · dashed = expected · log scale' +
                (truncated ? ' · latest ' + intervals.length + ' blocks in range' : '');
            if (!el) return;
            if (!intervals.length) { el.textContent = ''; return; }
            const fd = PoolCharts.fmtDuration;
            const num = v => Number(v) || 0;
            const body = (!truncated && range !== 'all' && intervals.length > 1) ? intervals.slice(1) : intervals;
            const paired = body.filter(x => x.expected != null && num(x.expected) > 0 && num(x.gap) > 0);
            const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
            let html;
            if (paired.length) {
                const sumGap = sum(paired, x => num(x.gap));
                const sumLam = sum(paired, x => num(x.gap) / num(x.expected)); // expected blocks over those stretches
                const long = paired.filter(x => num(x.gap) > LONG_FACTOR * num(x.expected)).length;
                const chance = paired.length * Math.exp(-LONG_FACTOR);
                html = 'Average gap <b>' + fd(sumGap / paired.length) + '</b> &middot; expected <b>' +
                       fd(sumGap / sumLam) + '</b>' +
                       (paired.length < intervals.length ? ' <span class="dim">(over ' + paired.length + ' of ' + intervals.length + ' blocks)</span>' : '') +
                       ' &nbsp;|&nbsp; <b>' + long + '</b> above ' + LONG_FACTOR + '× expected <span class="dim">(about ' +
                       (chance < 10 ? chance.toFixed(1) : Math.round(chance)) + ' by chance)</span>';
            } else {
                html = 'Average gap <b>' + fd(sum(body, x => num(x.gap)) / body.length) + '</b>';
            }
            let longest = intervals[0];
            intervals.forEach(x => { if (num(x.gap) > num(longest.gap)) longest = x; });
            html += ' &nbsp;|&nbsp; longest: <b>' + fd(longest.gap) + '</b> before block ' +
                    num(longest.height).toLocaleString('en-US') +
                    (num(longest.expected) > 0 ? ' <span class="dim">(' + (num(longest.gap) / num(longest.expected)).toFixed(1) + '× expected)</span>' : '');
            // The gap still running. The chart plots only finished gaps, one per block, so time
            // since the last block takes no space on it — a drought in progress is otherwise
            // invisible.
            const last = intervals[intervals.length - 1];
            const since = Math.floor(Date.now() / 1000) - num(last.t);
            let ref = null;
            for (let i = intervals.length - 1; i >= 0 && ref == null; i--) if (num(intervals[i].expected) > 0) ref = num(intervals[i].expected);
            if (since > 0) {
                const dry = ref != null && since > LONG_FACTOR * ref;
                html += ' &nbsp;|&nbsp; <span' + (dry ? ' class="bk-gap-long"' : '') + '>now: <b>' + fd(since) +
                        '</b> since block ' + num(last.height).toLocaleString('en-US') + '</span>' +
                        (ref != null ? ' <span class="dim">(expected about ' + fd(ref) + ')</span>' : '');
            }
            el.innerHTML = html;
        }

        function fmtExpected(v) {
            return v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
        }

        // ── P-05 · found blocks by UTC weekday × hour ──────────────────────────────────────────
        // `hours` = { found: [7][24], expected: [7][24] | null, expected_hours } from the history
        // endpoint, indexed [weekday 0=Sun][UTC hour]. Rows run Monday-first. Every value put into
        // markup goes through Number() — nothing from the API is inserted as text.
        const HEAT_DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
        let _heat = null; // last rendered grid, for the readout

        function hh(h) { return (h < 10 ? '0' : '') + h + ':00'; }
        function heatLevel(n, max) { return n > 0 && max > 0 ? Math.max(1, Math.ceil((n / max) * 4)) : 0; }
        function sumCol(grid, h) { return grid.reduce((a, row) => a + (Number(row[h]) || 0), 0); }

        function heatReadout(wd, h) {
            const out = document.getElementById('bk-heat-readout');
            if (!out || !_heat) return;
            const allDays = wd === 'all';
            const found = allDays ? sumCol(_heat.found, h) : (Number(_heat.found[wd][h]) || 0);
            const exp = _heat.expected
                ? (allDays ? sumCol(_heat.expected, h) : (Number(_heat.expected[wd][h]) || 0)) : null;
            const day = allDays ? 'All days' : (HEAT_DAYS.find(d => d[0] === wd) || [0, ''])[1];
            out.textContent = day + ' · ' + hh(h) + '–' + hh((h + 1) % 24) + ' UTC — ' +
                found + ' found' + (exp != null ? ' · ' + fmtExpected(exp) + ' expected' : '');
        }

        function renderHeatmap(hours) {
            const wrap = document.getElementById('bk-heat-wrap');
            const foot = document.getElementById('bk-heat-foot');
            const summary = document.getElementById('bk-heat-summary');
            const readout = document.getElementById('bk-heat-readout');
            if (!wrap) return;
            const found = (hours && Array.isArray(hours.found) && hours.found.length === 7) ? hours.found : null;
            const total = found ? found.reduce((a, row) => a + row.reduce((b, n) => b + (Number(n) || 0), 0), 0) : 0;
            if (!total) {
                _heat = null;
                wrap.innerHTML = '';
                if (foot) foot.hidden = true;
                if (summary) summary.textContent = '';
                toggleEmpty('bk-empty-heat', true);
                return;
            }
            const expected = (Array.isArray(hours.expected) && hours.expected.length === 7) ? hours.expected : null;
            _heat = { found, expected };
            toggleEmpty('bk-empty-heat', false);
            if (foot) foot.hidden = false;
            if (readout) readout.textContent = 'Hover or tap a cell';

            let max = 0;
            found.forEach(row => row.forEach(n => { max = Math.max(max, Number(n) || 0); }));
            const colTot = [];
            for (let h = 0; h < 24; h++) colTot.push(sumCol(found, h));
            const topCol = Math.max.apply(null, colTot);

            let html = '<table class="bk-heat" aria-label="Blocks found by UTC weekday and hour">' +
                '<thead><tr><th scope="col"><span class="sr">Day</span></th>';
            for (let h = 0; h < 24; h++) html += '<th scope="col">' + (h < 10 ? '0' : '') + h + '</th>';
            html += '<th scope="col" title="Blocks found on that weekday">Σ</th></tr></thead><tbody>';
            HEAT_DAYS.forEach(function (d) {
                const wd = d[0], row = found[wd] || [];
                let rowTot = 0;
                html += '<tr><th scope="row">' + d[1] + '</th>';
                for (let h = 0; h < 24; h++) {
                    const n = Number(row[h]) || 0;
                    rowTot += n;
                    html += '<td class="c l' + heatLevel(n, max) + '" data-wd="' + wd + '" data-h="' + h + '">' +
                            '<span class="sr">' + n + '</span></td>';
                }
                html += '<td class="tot">' + rowTot + '</td></tr>';
            });
            html += '</tbody><tfoot><tr><th scope="row" title="Every weekday added together">All</th>';
            for (let h = 0; h < 24; h++) {
                html += '<td class="tot' + (colTot[h] === topCol ? ' top' : '') + '" data-wd="all" data-h="' + h + '">' +
                        colTot[h] + '</td>';
            }
            html += '<td class="tot">' + total + '</td></tr></tfoot></table>';
            wrap.innerHTML = html;

            // Summary: the busiest and quietest UTC hour over all weekdays, each with its expected
            // count, so a reader can tell "more hashrate then" from "luckier then".
            if (summary) {
                let lo = 0, hi = 0;
                colTot.forEach((n, h) => { if (n > colTot[hi]) hi = h; if (n < colTot[lo]) lo = h; });
                const ex = h => expected ? ' (' + fmtExpected(sumCol(expected, h)) + ' expected)' : '';
                summary.innerHTML = 'Most blocks: <b>' + hh(hi) + ' UTC</b> &middot; ' + colTot[hi] + ' found' + ex(hi) +
                    ' &nbsp;|&nbsp; fewest: <b>' + hh(lo) + ' UTC</b> &middot; ' + colTot[lo] + ' found' + ex(lo) +
                    (expected ? '' : ' <span class="dim">&middot; expected appears once the pool has an hour of hashrate history</span>');
            }
        }

        // Only the newest request may draw: a slow 'all' answer landing after a quick switch back
        // to 'week' would otherwise paint the wrong range under the active button.
        let _histSeq = 0;
        async function loadBlockCharts() {
            const note = document.getElementById('bk-range-note');
            if (note) note.textContent = RANGE_NOTE[bkRange] || '';
            if (typeof PoolCharts === 'undefined') return;
            const seq = ++_histSeq;
            const range = bkRange;
            try {
                const data = await getJson('/api/pool/blocks/history?range=' + encodeURIComponent(range));
                if (seq !== _histSeq) return;
                const points = (data && Array.isArray(data.points)) ? data.points : [];
                const luck = (data && Array.isArray(data.luck)) ? data.luck : [];
                const status = (data && data.status) || { confirmed: 0, immature: 0, orphaned: 0 };
                const bucket = data && data.bucket_seconds;
                const hasPeriod = points.length > 0;
                const hasLuck = luck.length > 0;
                const statusTotal = (status.confirmed || 0) + (status.immature || 0) + (status.orphaned || 0);

                // P-01 · luck line (per block over the window; 100% = statistically expected).
                toggleEmpty('bk-empty-luck', !hasLuck);
                PoolCharts.renderTrendLine('bk-chart-luck',
                    luck.map(p => ({ t: p.t, v: p.luck })),
                    // No bucketSeconds: the luck series is PER BLOCK, not per bucket, so its
                    // labels must come from the real block timestamps (a hardcoded 1-day hint
                    // printed the same "MMM D" for every block found on that day).
                    { label: 'Luck', color: '#58a6ff', valueFmt: v => (Number(v) || 0).toFixed(0) + '%' });

                // P-02 · blocks found per period (columns) against the blocks the pool's hashrate
                // share says it should have found (dashed line, same unit, same axis). A null
                // expected — a period with no network sample — is a gap in the line, never 0.
                toggleEmpty('bk-empty-blocks', !hasPeriod);
                PoolCharts.renderBarChart('bk-chart-blocks',
                    bucketLabels(points, bucket),
                    points.map(p => p.blocks),
                    { label: 'Found', valueFmt: PoolCharts.fmtInt,
                      line: { label: 'Expected', data: points.map(p => p.expected), valueFmt: fmtExpected } });

                // P-03 · status breakdown doughnut (window totals; true orphaned count).
                toggleEmpty('bk-empty-status', statusTotal === 0);
                PoolCharts.renderDoughnutChart('bk-chart-status',
                    ['Matured', 'Maturing', 'Orphaned'],
                    [status.confirmed || 0, status.immature || 0, status.orphaned || 0],
                    { colors: ['#3fb950', '#d29922', '#f85149'] });

                // P-04 · time since the previous pool block, one dot per block, log axis, with the
                // expected mean gap as a dashed line (null = a gap in the line, never 0).
                // An orphan keeps its place (dropping it would merge two gaps) and is drawn hollow.
                const intervals = (data && Array.isArray(data.intervals)) ? data.intervals : [];
                toggleEmpty('bk-empty-gap', intervals.length === 0);
                PoolCharts.renderIntervalChart('bk-chart-gap',
                    intervals.map(x => ({ t: x.t, v: x.gap, ref: x.expected,
                                          title: 'Block ' + Number(x.height).toLocaleString('en-US'),
                                          hollow: x.orphaned === true,
                                          note: x.orphaned === true ? 'Orphaned — no reward; still a block the pool found' : '' })),
                    { label: 'Time since previous block', refLabel: 'Expected', longFactor: LONG_FACTOR });
                renderGapSummary(intervals, !!(data && data.intervals_truncated), range);

                // P-05 · UTC weekday × hour heatmap.
                renderHeatmap(data && data.hours);
            } catch (e) {
                if (seq !== _histSeq) return;
                toggleEmpty('bk-empty-luck', true);
                toggleEmpty('bk-empty-blocks', true);
                toggleEmpty('bk-empty-status', true);
                toggleEmpty('bk-empty-gap', true);
                renderGapSummary([], false, range);
                renderHeatmap(null);
            }
        }

        document.addEventListener('DOMContentLoaded', function () {
            document.getElementById('prev-btn').addEventListener('click', function () {
                if (_page > 0) { _page--; loadBlocks(); }
            });
            document.getElementById('next-btn').addEventListener('click', function () {
                if (_lastFull) { _page++; loadBlocks(); }
            });
            document.querySelectorAll('#filter-chips .chip').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    document.querySelectorAll('#filter-chips .chip').forEach(function (b) { b.classList.remove('active'); });
                    btn.classList.add('active');
                    _filter = btn.getAttribute('data-filter') || '';
                    _page = 0;
                    loadBlocks();
                });
            });

            // P-05 readout: hover (mouse) or tap (touch) a cell or an "All" total. Delegated on
            // the wrapper, so it survives every re-render.
            const heatWrap = document.getElementById('bk-heat-wrap');
            if (heatWrap) {
                const pick = function (e) {
                    const td = e.target.closest('td[data-h]');
                    if (!td) return;
                    heatWrap.querySelectorAll('td.sel').forEach(el => el.classList.remove('sel'));
                    if (td.classList.contains('c')) td.classList.add('sel');
                    const wd = td.getAttribute('data-wd');
                    heatReadout(wd === 'all' ? 'all' : Number(wd), Number(td.getAttribute('data-h')));
                };
                heatWrap.addEventListener('mouseover', pick);
                heatWrap.addEventListener('click', pick);
            }

            // Timeframe toggle → reload the charts and the heatmap (explorer table is unaffected).
            const bar = document.getElementById('bk-rangebar');
            if (bar) {
                bar.addEventListener('click', function (e) {
                    const btn = e.target.closest('.rng-btn');
                    if (!btn) return;
                    const r = btn.getAttribute('data-range');
                    if (!r || r === bkRange) return;
                    bkRange = r;
                    bar.querySelectorAll('.rng-btn').forEach(b => b.classList.toggle('active', b === btn));
                    loadBlockCharts();
                });
            }

            // Prime the network + explorer cache BEFORE the first render, so window.Explorer
            // picks the operator's explorer for the chain instead of falling back to its
            // mainnet default (branding.js writes the same two keys, but may not have landed
            // yet). `explorer` is the server-resolved key; Explorer re-validates it.
            fetch('/api/config/pool-info', { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) {
                    if (!d) return;
                    try {
                        if (d.network) sessionStorage.setItem('pool-network', d.network);
                        if (typeof d.explorer === 'string' && d.explorer) sessionStorage.setItem('pool-explorer', d.explorer);
                    } catch (e) {}
                })
                .catch(function () {})
                .finally(function () { loadSummary(); loadBlocks(); loadBlockCharts(); });
            Auth.poll(function () { loadSummary(); loadBlockCharts(); if (_page === 0) loadBlocks(); }, 60000);
        });
