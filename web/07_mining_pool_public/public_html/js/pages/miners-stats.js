// miners-stats.js — the miners-stats page's own script. Until 2026-10 (pool code-layout refactor,
// part F2) this was miners-stats.html's inline <script> block; it moved out byte-for-byte so
// a strict script-src can drop 'unsafe-inline'. The block's indent is kept.
//
// The page loads it as a CLASSIC script at the block's old position. Never add defer / async /
// type="module": the order and the shared global scope are what this code was written against.
        // Escape any value before it goes into innerHTML. Defense-in-depth: the stratum
        // layer already restricts grin_address to bech32 chars (lib/stratum-protocol.js),
        // but escaping here protects every interpolated field regardless of source.
        function escHtml(v) {
            return String(v == null ? '' : v)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        // ═════════════════════════════════════════════════════════════════
        // API Integration — public endpoints only.
        //   /api/pool/stats                 active miners / connections (placard)
        //   /api/stratum/hashrate           pool GPS 24h avg (placard)
        //   /api/pool/poolstats             24h-avg network GPS → Est. G1 mini / day (placard)
        //   /api/stratum/top-miners         top miners by 24h hashrate (P-04)
        //   /api/pool/top-block-finders     top lucky miners by blocks found, 30d (P-05)
        //   /api/stratum/top-avg-hashrate   top miners by avg hashrate, 30d (P-06)
        //   /api/pool/metrics/history       durable pool trend series → P-01/P-02/P-03
        // ═════════════════════════════════════════════════════════════════

        function fmtGpsLabel(gps) {
            if (!isFinite(gps)) return '—';
            if (gps >= 1e6) return (gps / 1e6).toFixed(2) + ' MG/s';
            if (gps >= 1e3) return (gps / 1e3).toFixed(2) + ' kG/s';
            return gps.toFixed(2) + ' G/s';
        }

        const G1_MINI_GPS  = 1.2;         // IPOLLO G1 mini, manufacturer spec
        const DAY_COINBASE = 60 * 1440;   // 86,400 ツ mined network-wide per day

        // GRIN amount for the ledger chart y-axis / tooltips (ツ = Grin symbol, matches the tables).
        function fmtGrin(v) {
            return Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 3 }) + ' ツ';
        }

        // Full miner address rendered as a link into the account view.
        // Plain text, NOT a link to /account-settings.html?addr= (audit §J11-1, 2026-09-02).
        // The three leaderboards below are the pool's largest address surface (up to 500 rows
        // each), and the server now masks the address on all three. The deep-link was what made
        // that mask worthless: it needed the FULL address to build the href, so every row put
        // one in the page — which then inverted the mask on /api/pool/miners,
        // /api/stratum/stats and, worst, /api/pool/unclaimed's list of unwatched balances.
        // A miner reaches their own account by pasting their address into the lookup box on
        // account-settings.html; that costs them one paste and costs a scraper the whole pool.
        // Do not "restore the convenience" here without re-reading §J11-1.
        function addrCell(addr) {
            return '<span class="addr-plain">' + escHtml(String(addr || '')) + '</span>';
        }

        function setStat(id, text) {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        }

        function tableMessage(tbody, cols, msg) {
            tbody.innerHTML = '<tr><td colspan="' + cols + '">' + escHtml(msg) + '</td></tr>';
        }

        // ── Client-side pagination (20 rows/page) ────────────────────────────
        const PAGE_SIZE = 20;
        let hrMiners = [], hrPage = 0;    // top miners by 24h hashrate
        let fndMiners = [], fndPage = 0;  // top lucky miners by blocks found (30d)
        let fndTotalBlocks = 0;           // every landed pool block in that window (% of pool)
        let avgMiners = [], avgPage = 0;  // top miners by avg hashrate (30d)

        function updatePager(prefix, page, pages) {
            const pager = document.getElementById(prefix + '-pager');
            if (pager) pager.style.display = pages > 1 ? 'flex' : 'none';
            const label = document.getElementById(prefix + '-page-label');
            if (label) label.textContent = 'Page ' + (page + 1) + ' of ' + Math.max(pages, 1);
            const prev = document.getElementById(prefix + '-prev');
            const next = document.getElementById(prefix + '-next');
            if (prev) prev.disabled = page <= 0;
            if (next) next.disabled = page >= pages - 1;
        }

        // ── Leaderboard cell helpers ─────────────────────────────────────────
        // Every helper returns escaped HTML; numbers go through Number() first so a malformed
        // API value renders as "—", never as markup.
        function fmtPct(p) {
            p = Number(p);
            if (!isFinite(p) || p <= 0) return '0%';
            if (p < 0.01) return '<0.01%';
            return (p >= 10 ? p.toFixed(1) : p.toFixed(2)) + '%';
        }
        function fmtUtc(ts) {
            return new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
        }
        function fmtAgo(ts) {
            const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
            if (s < 60) return 'just now';
            if (s < 3600) return Math.floor(s / 60) + 'm ago';
            if (s < 86400) return Math.floor(s / 3600) + 'h ago';
            return Math.floor(s / 86400) + 'd ago';
        }
        // Share-of-pool cell: a bar scaled to the board's largest share (width applied after
        // render via CSSOM, not an inline style attribute) + the exact percentage.
        function shareCell(p, maxP) {
            const w = maxP > 0 ? Math.min(100, Math.max(0, Number(p) / maxP * 100)) : 0;
            return '<span class="sharebar"><i data-w="' + w.toFixed(1) + '"></i></span>' + escHtml(fmtPct(p));
        }
        function applyBars(tbody) {
            tbody.querySelectorAll('.sharebar i[data-w]').forEach(function (el) {
                el.style.width = el.getAttribute('data-w') + '%';
            });
        }
        // Last-hour vs window figure: ▲/▼ only past ±10%, so normal share variance reads flat.
        function trendCell(h1, h24) {
            if (h1 == null || !isFinite(Number(h1))) return '<span class="mute">—</span>';
            h1 = Number(h1); h24 = Number(h24) || 0;
            let cls = 't-flat', arrow = '▬';
            if (h24 > 0 && h1 > h24 * 1.1) { cls = 't-up'; arrow = '▲'; }
            else if (h1 < h24 * 0.9) { cls = 't-down'; arrow = '▼'; }
            return escHtml(fmtGpsLabel(h1)) + ' <span class="' + cls + '">' + arrow + '</span>';
        }
        function lastShareCell(ts) {
            ts = Number(ts);
            if (!ts) return '<span class="mute">—</span>';
            const age = Math.floor(Date.now() / 1000) - ts;
            const cls = age < 600 ? 'on' : age < 3600 ? 'idle' : '';
            return '<span class="lamp-dot ' + cls + '"></span><span title="' + escHtml(fmtUtc(ts)) + '">' +
                escHtml(fmtAgo(ts)) + '</span>';
        }
        // One bar per UTC day, scaled to the row's own best day; a zero day is a faint stub so
        // a gap reads as a gap rather than as missing data.
        function sparkSvg(daily) {
            const v = Array.isArray(daily) ? daily.map(x => Math.max(0, Number(x) || 0)) : [];
            if (!v.length) return '<span class="mute">—</span>';
            const W = 96, H = 20, n = v.length, slot = W / n, bw = Math.max(1, slot - (slot > 2.5 ? 1 : 0));
            const max = Math.max.apply(null, v);
            let bars = '';
            for (let i = 0; i < n; i++) {
                const h = max > 0 && v[i] > 0 ? Math.max(2, v[i] / max * H) : 1.5;
                bars += '<rect' + (v[i] > 0 ? '' : ' class="z"') + ' x="' + (i * slot).toFixed(2) +
                    '" y="' + (H - h).toFixed(2) + '" width="' + bw.toFixed(2) + '" height="' + h.toFixed(2) + '"/>';
            }
            return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' + bars + '</svg>';
        }
        function blockLinkCell(height, ts) {
            const h = Number(height);
            if (!h) return '<span class="mute">—</span>';
            const label = '#' + h.toLocaleString('en-US');
            const link = window.Explorer ? Explorer.link('block', String(h), label) : escHtml(label);
            const when = Number(ts) ? '<span class="sub" title="' + escHtml(fmtUtc(Number(ts))) + '">' + escHtml(fmtAgo(Number(ts))) + '</span>' : '';
            return link + when;
        }
        const maxOf = (rows, key) => rows.reduce((m, r) => Math.max(m, Number(r[key]) || 0), 0);

        function renderHrPage() {
            const tbody = document.getElementById('top-hashrate');
            if (!tbody) return;
            const total = hrMiners.length;
            if (!total) { tableMessage(tbody, 8, 'No active miners in the last 24 hours'); updatePager('hr', 0, 0); return; }
            const pages = Math.ceil(total / PAGE_SIZE);
            if (hrPage >= pages) hrPage = pages - 1;
            if (hrPage < 0) hrPage = 0;
            const start = hrPage * PAGE_SIZE;
            const maxShare = maxOf(hrMiners, 'share_pct');
            tbody.innerHTML = hrMiners.slice(start, start + PAGE_SIZE).map((m, i) => `
                <tr>
                    <td>#${start + i + 1}</td>
                    <td>${addrCell(m.grin_address)}</td>
                    <td class="num">${escHtml(fmtGpsLabel(m.hashrate_gps || 0))}</td>
                    <td class="num col-x">${trendCell(m.hashrate_1h_gps, m.hashrate_gps)}</td>
                    <td>${shareCell(m.share_pct, maxShare)}</td>
                    <td class="num col-x">${Number(m.rigs || 0).toLocaleString('en-US')}</td>
                    <td class="num col-x">${Number(m.shares || 0).toLocaleString('en-US')}</td>
                    <td class="col-x">${lastShareCell(m.last_share_at)}</td>
                </tr>
            `).join('');
            applyBars(tbody);
            updatePager('hr', hrPage, pages);
        }

        function renderFndPage() {
            const tbody = document.getElementById('top-finders');
            if (!tbody) return;
            const total = fndMiners.length;
            if (!total) { tableMessage(tbody, 8, 'No blocks found in the last 30 days yet — be the first!'); updatePager('fnd', 0, 0); return; }
            const pages = Math.ceil(total / PAGE_SIZE);
            if (fndPage >= pages) fndPage = pages - 1;
            if (fndPage < 0) fndPage = 0;
            const start = fndPage * PAGE_SIZE;
            tbody.innerHTML = fndMiners.slice(start, start + PAGE_SIZE).map((m, i) => {
                const found = Number(m.blocks_found || 0);
                const orph = Number(m.orphaned || 0);
                const pct = fndTotalBlocks > 0 ? found / fndTotalBlocks * 100 : 0;
                const fees = m.total_fees == null ? '<span class="mute">—</span>' : Number(m.total_fees).toFixed(4);
                return `
                <tr>
                    <td>#${start + i + 1}</td>
                    <td>${addrCell(m.grin_address)}</td>
                    <td class="num">${found.toLocaleString('en-US')}</td>
                    <td class="num col-x">${escHtml(fmtPct(pct))}</td>
                    <td class="num">${Number(m.total_reward || 0).toFixed(2)}</td>
                    <td class="num col-x">${fees}</td>
                    <td class="num col-x${orph ? '' : ' mute'}">${orph.toLocaleString('en-US')}</td>
                    <td class="col-x">${blockLinkCell(m.last_height, m.last_found_at)}</td>
                </tr>`;
            }).join('');
            updatePager('fnd', fndPage, pages);
        }

        function renderAvgPage() {
            const tbody = document.getElementById('top-avg');
            if (!tbody) return;
            const total = avgMiners.length;
            if (!total) { tableMessage(tbody, 7, 'No mining activity in the last 30 days yet'); updatePager('avg', 0, 0); return; }
            const pages = Math.ceil(total / PAGE_SIZE);
            if (avgPage >= pages) avgPage = pages - 1;
            if (avgPage < 0) avgPage = 0;
            const start = avgPage * PAGE_SIZE;
            const maxShare = maxOf(avgMiners, 'share_pct');
            tbody.innerHTML = avgMiners.slice(start, start + PAGE_SIZE).map((m, i) => {
                const daily = Array.isArray(m.daily_gps) ? m.daily_gps : [];
                const peak = Number(m.peak_day_gps);
                const today = daily.length ? Number(daily[daily.length - 1]) || 0 : 0;
                const sparkTitle = daily.length
                    ? 'Today so far: ' + fmtGpsLabel(today) + (peak > 0 ? ' · best full day: ' + fmtGpsLabel(peak) : '')
                    : '';
                return `
                <tr>
                    <td>#${start + i + 1}</td>
                    <td>${addrCell(m.grin_address)}</td>
                    <td class="num">${escHtml(fmtGpsLabel(m.avg_hashrate_gps || 0))}</td>
                    <td class="col-x">${shareCell(m.share_pct, maxShare)}</td>
                    <td class="num col-x">${peak > 0 ? escHtml(fmtGpsLabel(peak)) : '<span class="mute">—</span>'}</td>
                    <td class="num col-x">${Number(m.days_active || 0)}<span class="mute"> / ${daily.length}</span></td>
                    <td title="${escHtml(sparkTitle)}">${sparkSvg(daily)}</td>
                </tr>`;
            }).join('');
            applyBars(tbody);
            updatePager('avg', avgPage, pages);
        }

        // ── Historical trend charts (P-01/P-02/P-03), driven by the shared range toggle ──────
        let msRange = 'day';
        const RANGE_NOTE = {
            day:   'last 24h · hourly',
            week:  'last 7 days · hourly',
            month: 'last 30 days · daily',
            year:  'last 365 days · daily',
            all:   'all time · auto-scaled'
        };

        function toggleEmpty(emptyId, show) {
            const el = document.getElementById(emptyId);
            if (el) el.style.display = show ? 'flex' : 'none';
        }

        async function loadMetrics() {
            const note = document.getElementById('ms-range-note');
            if (note) note.textContent = RANGE_NOTE[msRange] || '';
            if (typeof PoolCharts === 'undefined') return;
            try {
                const data = await Auth.read('/api/pool/metrics/history?range=' + encodeURIComponent(msRange));
                if (data === null) throw new Error('unavailable');   // audit §J15-2
                const points = Array.isArray(data.points) ? data.points : [];
                const bucket = data && data.bucket_seconds;
                const has = points.length > 0;

                toggleEmpty('ms-empty-hashrate', !has);
                toggleEmpty('ms-empty-miners', !has);
                toggleEmpty('ms-empty-ledger', !has);

                PoolCharts.renderTrendLine('ms-chart-hashrate',
                    points.map(p => ({ t: p.t, v: p.hashrate_gps })),
                    { label: 'Pool hashrate', bucketSeconds: bucket, valueFmt: PoolCharts.fmtGps });

                // P-02: miners + workers on one count axis (a miner runs ≥1 worker, so the
                // workers line always sits on or above the miners line). worker_count is null
                // for hours rolled up before the column existed — a null stays a gap in
                // renderMultiTrendLine, never a 0 — and the whole series is dropped (no legend
                // entry) while nothing has been recorded yet. Colours are the blue/amber pair,
                // the CVD-safe two-series choice.
                const minerPts  = points.map(p => ({ t: p.t, v: p.miner_count }));
                const workerPts = points.map(p => ({ t: p.t, v: p.worker_count }));
                const minerSeries = [{ label: 'Miners', color: '#58a6ff', points: minerPts }];
                if (workerPts.some(p => p.v != null)) {
                    minerSeries.push({ label: 'Workers', color: '#c98500', points: workerPts });
                }
                PoolCharts.renderMultiTrendLine('ms-chart-miners', minerSeries,
                    { bucketSeconds: bucket, valueFmt: PoolCharts.fmtInt });
                // Coarser buckets carry the PEAK hour, not the average (an average counts every
                // idle hour as zero and rounded a 3-hour session on a 16-hour day to 0 miners).
                // Say so on the panel, since the same line reads differently by range.
                const agg = document.getElementById('ms-miners-agg');
                if (agg) {
                    agg.textContent = !bucket || bucket <= 3600 ? 'distinct per hour'
                        : bucket <= 86400 ? 'peak hour per day'
                        : bucket <= 7 * 86400 ? 'peak hour per week' : 'peak hour per month';
                }

                // Shared elastic UTC labeller (charts-init.js) — the same span-aware format the
                // trend lines use, so all three panels read consistently at every range.
                const labels = PoolCharts.timeLabels(points.map(p => p.t), bucket);
                PoolCharts.renderGroupedBarChart('ms-chart-ledger', labels, [
                    { label: 'Earnings', data: points.map(p => p.earnings), color: '#7cb342' },
                    { label: 'Payout',   data: points.map(p => p.payout),   color: '#d29922' }
                ], { valueFmt: fmtGrin });
            } catch (e) {
                toggleEmpty('ms-empty-hashrate', true);
                toggleEmpty('ms-empty-miners', true);
                toggleEmpty('ms-empty-ledger', true);
            }

            // P-02b: miners per gateway region (multi-line, same range). The whole panel stays
            // hidden when there's nothing regional to show. Colours are keyed to the region
            // NAME in fixed alphabetical slot order — colour follows the entity, so the
            // busiest-first legend order never repaints a line as rankings shift.
            const regionPanel = document.getElementById('panel-regions');
            try {
                const rd = await Auth.read('/api/pool/metrics/history/regions?range=' + encodeURIComponent(msRange));
                let series = (rd && Array.isArray(rd.series)) ? rd.series : [];
                series = series.filter(s => s.points && s.points.length).slice(0, 8); // palette is 8 slots, UI caps regions at 8
                const onlyDefault = series.length === 1 && series[0].region === 'default';
                if (!series.length || onlyDefault) {
                    if (regionPanel) regionPanel.style.display = 'none';
                } else {
                    if (regionPanel) regionPanel.style.display = '';
                    toggleEmpty('ms-empty-regions', false);
                    const names = series.map(s => s.region).slice().sort();
                    PoolCharts.renderMultiTrendLine('ms-chart-regions',
                        series.map(s => ({
                            label: String(s.region).toUpperCase(),
                            color: PoolCharts.PALETTE[names.indexOf(s.region) % PoolCharts.PALETTE.length],
                            points: s.points.map(p => ({ t: p.t, v: p.miner_count }))
                        })),
                        { bucketSeconds: rd.bucket_seconds, valueFmt: PoolCharts.fmtInt });
                }
            } catch (e) {
                if (regionPanel) regionPanel.style.display = 'none';
            }
        }

        async function loadMinersStats() {
            try {
                const stats = await Auth.read('/api/pool/stats');
                if (stats) {   // null (429/5xx/network) leaves the placeholders — audit §J15-2
                    setStat('ms-miners', stats.active_miners || 0);
                    setStat('ms-connections', (stats.active_workers != null ? stats.active_workers : stats.active_connections) || 0);
                }
            } catch (e) { /* tiles keep placeholders */ }

            // Pool hashrate tile is the 24h AVERAGE (smooth, like the solo pool's tiles); the
            // P-01 chart shows the selected timeframe.
            try {
                const hr = await Auth.read('/api/stratum/hashrate');
                if (hr) setStat('ms-hashrate', fmtGpsLabel(hr.pool_hashrate_24h_gps || 0));
            } catch (e) { /* tile keeps placeholder */ }

            // Est. G1 mini / day — a fixed yardstick, same formula as the solo pool and
            // scan.grin.money: 1.2 G/s ÷ network GPS × 86,400 ツ (60 ツ × 1,440 blocks/day).
            // Denominator is the SMOOTH 24h-average network hashrate from the hourly rollup
            // (/api/pool/poolstats, served from a 60s cache), so 1/hashrate doesn't inherit
            // per-block jitter; the live rate is the fallback only until an hour of history
            // exists (hashrate_gps_24h is null before that).
            try {
                const ps = await Auth.read('/api/pool/poolstats');
                const n = ps && ps.network;
                if (n) {
                    const netGps = n.hashrate_gps_24h != null ? n.hashrate_gps_24h : n.hashrate_gps;
                    const el = document.getElementById('ms-g1est');
                    if (netGps != null && netGps > 0) PoolFmt.setGrinTile(el, G1_MINI_GPS / netGps * DAY_COINBASE);
                    else PoolFmt.setGrinTile(el, null);
                }
            } catch (e) { /* tile keeps placeholder */ }

            const hrTbody = document.getElementById('top-hashrate');
            try {
                const data = await Auth.read('/api/stratum/top-miners?window=1440&limit=500');
                // null = the endpoint did not answer. Auth.read never throws, so without this
                // the catch below was unreachable and an outage rendered as "no miners"
                // rather than "unavailable" (audit §J15-2).
                if (data === null) throw new Error('unavailable');
                hrMiners = Array.isArray(data.top_miners) ? data.top_miners : [];
                setStat('ms-top', hrMiners.length ? fmtGpsLabel(hrMiners[0].hashrate_gps || 0) : '—');
                renderHrPage();
            } catch (e) {
                hrMiners = [];
                if (hrTbody) tableMessage(hrTbody, 8, 'Hashrate data unavailable');
                updatePager('hr', 0, 0);
            }

            const fndTbody = document.getElementById('top-finders');
            try {
                const data = await Auth.read('/api/pool/top-block-finders?days=30&limit=500');
                // null = the endpoint did not answer. Auth.read never throws, so without this
                // the catch below was unreachable and an outage rendered as "no miners"
                // rather than "unavailable" (audit §J15-2).
                if (data === null) throw new Error('unavailable');
                fndMiners = Array.isArray(data.top_finders) ? data.top_finders : [];
                fndTotalBlocks = Number(data.total_blocks) || 0;
                renderFndPage();
            } catch (e) {
                fndMiners = [];
                if (fndTbody) tableMessage(fndTbody, 8, 'Block-finder data unavailable');
                updatePager('fnd', 0, 0);
            }

            const avgTbody = document.getElementById('top-avg');
            try {
                const data = await Auth.read('/api/stratum/top-avg-hashrate?days=30&limit=500');
                // null = the endpoint did not answer. Auth.read never throws, so without this
                // the catch below was unreachable and an outage rendered as "no miners"
                // rather than "unavailable" (audit §J15-2).
                if (data === null) throw new Error('unavailable');
                avgMiners = Array.isArray(data.top_miners) ? data.top_miners : [];
                renderAvgPage();
            } catch (e) {
                avgMiners = [];
                if (avgTbody) tableMessage(avgTbody, 7, 'Hashrate history unavailable');
                updatePager('avg', 0, 0);
            }
        }

        document.addEventListener('DOMContentLoaded', function () {
            document.getElementById('hr-prev').addEventListener('click', function () {
                if (hrPage > 0) { hrPage--; renderHrPage(); }
            });
            document.getElementById('hr-next').addEventListener('click', function () {
                hrPage++; renderHrPage();
            });
            document.getElementById('fnd-prev').addEventListener('click', function () {
                if (fndPage > 0) { fndPage--; renderFndPage(); }
            });
            document.getElementById('fnd-next').addEventListener('click', function () {
                fndPage++; renderFndPage();
            });
            document.getElementById('avg-prev').addEventListener('click', function () {
                if (avgPage > 0) { avgPage--; renderAvgPage(); }
            });
            document.getElementById('avg-next').addEventListener('click', function () {
                avgPage++; renderAvgPage();
            });

            // Timeframe toggle → reload the three trend charts (leaderboards are unaffected).
            const bar = document.getElementById('ms-rangebar');
            if (bar) {
                bar.addEventListener('click', function (e) {
                    const btn = e.target.closest('.rng-btn');
                    if (!btn) return;
                    const r = btn.getAttribute('data-range');
                    if (!r || r === msRange) return;
                    msRange = r;
                    bar.querySelectorAll('.rng-btn').forEach(b => b.classList.toggle('active', b === btn));
                    loadMetrics();
                });
            }

            loadMinersStats();
            loadMetrics();
        });

        // Refresh live tiles, leaderboards and the selected trend charts every 60s.
        setInterval(function () { loadMinersStats(); loadMetrics(); }, 60000);
