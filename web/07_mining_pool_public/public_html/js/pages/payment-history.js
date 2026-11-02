// payment-history.js — the payment-history page's own script, external (not inline) so a strict script-src needs no 'unsafe-inline'.
// The original indent is kept.
//
// The page loads it as a CLASSIC script at its original position. Never add defer / async /
// type="module": the order and the shared global scope are what this code was written against.
        // Escape any value before it goes into innerHTML (defense-in-depth on grin_address and any
        // operator/miner-derived field rendered into the table).
        function escHtml(v) {
            return String(v == null ? '' : v)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        // Theme switching is handled site-wide by /js/public-theme.js.

        // GRIN amount for tiles / chart axes (ツ = Grin symbol, matches the tables and miners-stats).
        function fmtGrin(v) {
            return Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 3 }) + ' ツ';
        }
        // Value-axis labels for the GRIN charts (P-01, P-04): one k / M / B unit for the whole
        // axis, picked from its max, so the labels stay narrow. Tooltips keep fmtGrin's exact figure.
        fmtGrin.axis = function (v, max) {
            const scale = Math.abs(Number(max)) || Math.abs(Number(v)) || 0;
            const n = Number(v) || 0;
            if (n === 0) return '0';
            const u = scale >= 1e9 ? [1e9, 'B'] : scale >= 1e6 ? [1e6, 'M'] : scale >= 1e3 ? [1e3, 'k'] : [1, ''];
            // Under 1 ツ the ticks are hundredths or finer; 2 dp would print them all as "0".
            const dp = scale < 1 ? 4 : 2;
            return parseFloat((n / u[0]).toFixed(dp)).toLocaleString('en-US', { maximumFractionDigits: dp }) + u[1] + ' ツ';
        };
        function fmtInt(v) { return Number(v || 0).toLocaleString('en-US'); }

        function truncAddr(addr) {
            addr = String(addr || '');
            return addr.length > 16 ? addr.slice(0, 9) + '…' + addr.slice(-4) : addr;
        }
        // Full miner address rendered as a link into the account view.
        // Plain text, NOT a link, and NO `title` tooltip (audit §J11-1). The server
        // masks grin_address on /api/pool/payments now, so `addr` arrives already truncated —
        // truncAddr() below is a no-op on it and stays only as a guard. A cell that put the
        // FULL address in both the href and the title would make every masked feed
        // elsewhere re-attachable by a join. See the note in miners-stats.html addrCell().
        function addrCell(addr) {
            return '<span class="addr-plain">' + escHtml(truncAddr(String(addr || ''))) + '</span>';
        }

        function setStat(id, text) {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        }
        // Placard GRIN tiles: short figure + exact tooltip, the one rule in js/num-format.js.
        // Tables below keep fmtGrin's exact figures.
        function setGrinStat(id, v) { PoolFmt.setGrinTile(document.getElementById(id), Number(v || 0)); }
        function toggleEmpty(emptyId, show, text) {
            const el = document.getElementById(emptyId);
            if (!el) return;
            if (text) el.textContent = text;
            el.style.display = show ? 'flex' : 'none';
        }

        // UTC bucket labels for the bar axes — delegated to the shared elastic labeller in
        // charts-init.js (span-aware: adds the day to sub-day buckets spanning more than 2 days,
        // and the year once the window reaches a year), so bars match the trend lines exactly.
        function periodLabels(points, bucket) {
            return PoolCharts.timeLabels(points.map(p => p.t), bucket);
        }

        // ═════════════════════════════════════════════════════════════════
        // API Integration — public endpoints only.
        //   /api/pool/payments/history   durable payments & transparency series (tiles + 4 charts)
        //   /api/pool/payments           recent confirmed withdrawals (P-05 table)
        // Timestamps are unix SECONDS.
        // ═════════════════════════════════════════════════════════════════

        function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

        // The API returns only buckets that had activity. Rebuild the full grid the server
        // bucketed on (unix-epoch aligned, CAST(t / bucket) * bucket) so empty periods keep their
        // slot. Spans mirror getPaymentsHistory; 'all' starts at the first point. The grid is
        // widened to every point it was handed, so a client clock off from the server's drops
        // nothing, and capped so a bad bucket size cannot spin the loop.
        const RANGE_SPAN = { day: 86400, week: 7 * 86400, month: 30 * 86400, year: 365 * 86400 };
        function denseBuckets(points, bucket, range) {
            const b = Number(bucket);
            if (!(b > 0) || !points.length) return points;
            const now = Math.floor(Date.now() / 1000);
            const span = RANGE_SPAN[range];
            let start = span ? Math.floor((now - span) / b) * b : points[0].t;
            let end = Math.floor(now / b) * b;
            start = Math.min(start, points[0].t);
            end = Math.max(end, points[points.length - 1].t);
            if ((end - start) / b > 1000) return points;
            const byT = new Map(points.map(p => [p.t, p]));
            const out = [];
            for (let t = start; t <= end; t += b) {
                out.push(byT.get(t) || { t, payout: 0, to_miners: 0, fee: 0, donations: 0, giveaways: 0 });
            }
            return out;
        }

        let phRange = 'month';
        const RANGE_NOTE = {
            day:   'last 24h · hourly',
            week:  'last 7 days · daily',
            month: 'last 30 days · daily',
            year:  'last 365 days · weekly',
            all:   'all time · auto-scaled'
        };

        async function loadTransparency() {
            const note = document.getElementById('ph-range-note');
            if (note) note.textContent = RANGE_NOTE[phRange] || '';
            if (typeof PoolCharts === 'undefined') return;
            try {
                const data = await Auth.read('/api/pool/payments/history?range=' + encodeURIComponent(phRange));
                // null = no answer (429/5xx/network). Without this the lifetime transparency
                // tiles below rendered 0 ツ paid / 0 payouts / 0 % fee during an outage, which
                // on THIS page is the strongest possible false statement (audit §J15-2).
                if (data === null) throw new Error('unavailable');
                const points = Array.isArray(data.points) ? data.points : [];
                const dist   = Array.isArray(data.distribution) ? data.distribution : [];
                const totals = data.totals || {};
                const bucket = data.bucket_seconds;

                // ── Lifetime transparency tiles (range-independent) ──
                setGrinStat('ph-paid-all', totals.paid_all);
                setStat('ph-count-all', fmtInt(totals.payout_count || 0));
                const avgEl = document.getElementById('ph-avg');
                if (avgEl) {
                    avgEl.textContent = 'avg ' + (totals.payout_count ? PoolFmt.grinTile(totals.avg_payout) : '—');
                    avgEl.title = totals.payout_count ? 'Average payout: ' + PoolFmt.grinExact(totals.avg_payout) : '';
                }
                setGrinStat('ph-giveaways', totals.giveaways_all);
                setGrinStat('ph-donations', totals.donations_all);
                setGrinStat('ph-operator', totals.operator_withdrawn_all);

                // ── P-01 · credited vs sent per bucket (see the panel comment in the page) ──
                // On the dense grid: a quiet day is a zero-height slot, not a missing axis label.
                const flow = denseBuckets(points, bucket, phRange);
                // Rounded to the API's 9 decimals: the sum of three rounded floats can land on 5e-17
                // where the ledger says 0, which would hide the empty state over a blank chart.
                // `|| 0` turns the -0 that rounding a tiny negative leaves into 0 ("-0 ツ" otherwise).
                const credited = flow.map(p => +(num(p.to_miners) + num(p.giveaways) - num(p.donations)).toFixed(9) || 0);
                const sent = flow.map(p => num(p.payout));
                const hasFlow = credited.some(v => v !== 0) || sent.some(v => v !== 0);
                toggleEmpty('ph-empty-flow', !hasFlow);
                // Blue / amber: the CVD-safe pair miners-stats P-02 uses. Not #d29922 — that is
                // "Pool fee" in P-03 below, and "sent to miners" must not read as the fee.
                PoolCharts.renderGroupedBarChart('ph-chart-flow', periodLabels(flow, bucket), [
                    { label: 'Credited to miners', data: credited, color: '#58a6ff' },
                    { label: 'Sent to miners',     data: sent,     color: '#c98500' }
                ], { valueFmt: fmtGrin });

                // ── P-02 · payout size distribution ──
                const distTotal = dist.reduce((s, d) => s + (Number(d.count) || 0), 0);
                toggleEmpty('ph-empty-distribution', distTotal === 0);
                PoolCharts.renderBarChart('ph-chart-distribution',
                    dist.map(d => d.label), dist.map(d => d.count),
                    { label: 'Payouts', valueFmt: fmtInt });

                // ── P-03 · where the reward goes (miners vs pool fee, over the window) ──
                const toMiners = points.reduce((s, p) => s + (Number(p.to_miners) || 0), 0);
                const fee      = points.reduce((s, p) => s + (Number(p.fee) || 0), 0);
                const splitTotal = toMiners + fee;
                if (splitTotal <= 0) {
                    toggleEmpty('ph-empty-split', true, 'NO REWARD DATA YET');
                } else if (fee <= 0) {
                    // 0-fee pool: still render the (single-slice) doughnut, but say it plainly.
                    toggleEmpty('ph-empty-split', false);
                    PoolCharts.renderDoughnutChart('ph-chart-split',
                        ['To miners', 'Pool fee'], [toMiners, 0], { colors: ['#7cb342', '#d29922'] });
                } else {
                    toggleEmpty('ph-empty-split', false);
                    PoolCharts.renderDoughnutChart('ph-chart-split',
                        ['To miners', 'Pool fee'], [toMiners, fee], { colors: ['#7cb342', '#d29922'] });
                }

                // ── P-04 · giveaways distributed to miners ──
                const giveTotal = points.reduce((s, p) => s + (Number(p.giveaways) || 0), 0);
                toggleEmpty('ph-empty-giveaways', giveTotal <= 0);
                PoolCharts.renderBarChart('ph-chart-giveaways',
                    periodLabels(points, bucket), points.map(p => p.giveaways),
                    { label: 'Given away', valueFmt: fmtGrin });
            } catch (e) {
                toggleEmpty('ph-empty-flow', true);
                toggleEmpty('ph-empty-distribution', true);
                toggleEmpty('ph-empty-split', true);
                toggleEmpty('ph-empty-giveaways', true);
            }
        }

        // The live pool fee — the rate the next block found is charged — for the fee tile's
        // headline. A failed read leaves the previous figure (or "—"), never a guessed 0 %.
        async function loadFeeRate() {
            try {
                const info = await Auth.read('/api/config/pool-info');
                if (!info) return;
                const pct = Number(info.pool_fee_percent);
                if (!isFinite(pct)) return;
                // Trailing zeros dropped, like the dashboard terms tile: "0 %", "1 %", "0.5 %".
                setStat('ph-fee-pct', Number(pct.toFixed(2)) + ' %');
            } catch (e) { /* tile keeps its last figure */ }
        }

        // P-05 method + status, ONE column (2026-09-26, mobile width). This feed lists CONFIRMED
        // payouts only — the pool has finalized and broadcast them — so "paid" was the same on
        // every row and the only live bit is whether the tx has been seen MINED:
        // has_kernel_proof turns true once the scheduler's backfill finds the kernel in the pool
        // wallet's tx log (minutes after broadcast; never on a pool with no Owner API wallet,
        // where the row honestly stays "sent"). The cell reads "Tor · mined" / "Slatepack · sent".
        //
        // Tx ID = the payout's kernel excess, linked to the operator's chain explorer so anyone
        // can check the payout was mined. Published here by operator decision,
        // reversing the pool-wide half of audit §J11-2 — the address beside it MUST stay masked
        // (see the note on GET /api/pool/payments). The server sends only a shape-checked
        // 66-hex value or null; Explorer.link() escapes it and branding.js relinks it once the
        // network + explorer are known.
        const PAY_METHOD = { tor: 'Tor', slatepack: 'Slatepack', nostr: 'Goblin', manual: 'Manual' };
        function payMethodCell(w) {
            const method = escHtml(PAY_METHOD[w.method] || w.method || 'Tor');
            // An operator revenue withdrawal (the API sends operator: true and the fixed label
            // "Pool operator" in place of an address) — say so, so it never reads as a miner payout.
            if (w.operator) {
                return '<span class="status-badge" title="The pool operator withdrawing revenue from the pool fee — not a miner payout">Operator revenue · ' + method + '</span>';
            }
            return w.has_kernel_proof
                ? '<span class="status-badge status-active" title="Paid — broadcast and seen mined on the Grin chain">' + method + ' · mined</span>'
                : '<span class="status-badge" title="Paid — finalized and broadcast by the pool; not yet seen mined (or this pool cannot read its wallet tx log)">' + method + ' · sent</span>';
        }
        // Long form on desktop, MM-DD HH:MM under 640px (CSS picks one); both UTC.
        function payWhenCell(ts) {
            const d = new Date(ts * 1000);
            const long = d.toLocaleString('en-US', { timeZone: 'UTC' });
            const short = isNaN(d) ? long : d.toISOString().slice(5, 16).replace('T', ' ');
            return '<span class="dt-long">' + escHtml(long) + '</span>'
                + '<span class="dt-short" title="' + escHtml(long) + ' UTC">' + escHtml(short) + '</span>';
        }
        function txIdCell(w) {
            const k = (typeof w.kernel_excess === 'string' && /^[0-9a-f]{66}$/i.test(w.kernel_excess)) ? w.kernel_excess : '';
            if (!k || !window.Explorer) return '<span class="dim">—</span>';
            return window.Explorer.link('kernel', k, k.slice(0, 8) + '…' + k.slice(-6) + ' ↗', 'tx-id');
        }

        async function loadRecentPayouts() {
            const tbody = document.getElementById('payouts');
            try {
                const data = await Auth.read('/api/pool/payments?limit=100');
                if (!Array.isArray(data)) throw new Error('bad response');
                const when = w => w.confirmed_at || w.created_at || 0;
                if (tbody) {
                    if (!data.length) {
                        tbody.innerHTML = '<tr><td colspan="5">No payouts yet</td></tr>';
                    } else {
                        // The Miner column hides under 480px and .miner-sub (same masked address)
                        // shows under the date instead — see the .ph-pay-table CSS.
                        tbody.innerHTML = data.slice(0, 25).map(w => `
                            <tr>
                                <td>${payWhenCell(when(w))}<div class="miner-sub">${addrCell(w.grin_address)}</div></td>
                                <td class="col-miner">${addrCell(w.grin_address)}</td>
                                <td class="num">${Number(w.amount || 0).toFixed(2)}</td>
                                <td>${payMethodCell(w)}</td>
                                <td>${txIdCell(w)}</td>
                            </tr>
                        `).join('');
                    }
                }
            } catch (error) {
                if (tbody) tbody.innerHTML = '<tr><td colspan="5">Payment data unavailable</td></tr>';
            }
        }

        // ── Unclaimed / abandoned balances (transparency + reunification) ──
        function daysAgoLabel(ts) {
            if (!ts) return '—';
            const d = Math.floor((Date.now() / 1000 - Number(ts)) / 86400);
            return d <= 0 ? 'today' : (fmtInt(d) + ' d');
        }
        async function loadUnclaimed() {
            const block = document.getElementById('unclaimed-block');
            try {
                const data = await Auth.read('/api/pool/unclaimed');
                const dormant = (data && data.dormant) || { totals: {}, list: [] };
                const disp = (data && data.dispositions) || { totals: {}, batches: [] };
                const totals = dormant.totals || {};
                const dispTotals = disp.totals || {};
                const list = Array.isArray(dormant.list) ? dormant.list : [];
                const batches = Array.isArray(disp.batches) ? disp.batches : [];

                // Nothing to show → keep the whole block hidden.
                if ((totals.count || 0) === 0 && batches.length === 0) {
                    if (block) block.style.display = 'none';
                    return;
                }
                if (block) block.style.display = '';

                // Notice wording reflects whether disposition is actually active.
                const months = dormant.dormancy_months || 24;
                const noteEl = document.getElementById('unclaimed-notice-text');
                if (noteEl) {
                    noteEl.textContent = dormant.enabled
                        ? ('If an address stops mining and never withdraws for ' + months + ' months, its unclaimed balance is '
                            + 'swept into the community prize pool — never taken by the pool operator.')
                        : ('Balances from addresses that have stopped mining are shown here for transparency. '
                            + 'Automatic sweeping is not currently active.');
                }

                setGrinStat('uc-total', totals.amount);
                setStat('uc-count',    fmtInt(totals.count || 0));
                setStat('uc-oldest',   daysAgoLabel(totals.oldest_activity_at));
                setGrinStat('uc-disposed', dispTotals.total_disposed);

                // U-02 · dormant list (addresses already masked server-side)
                const dt = document.getElementById('uc-dormant');
                if (dt) {
                    if (!list.length) {
                        dt.innerHTML = '<tr><td colspan="4">No dormant balances</td></tr>';
                    } else {
                        dt.innerHTML = list.map(function (r) {
                            let disposal = '—';
                            if (r.dispose_at) {
                                if (r.eligible) {
                                    disposal = '<span class="uc-eligible">due</span>';
                                } else {
                                    const d = Number(r.days_until_disposal) || 0;
                                    disposal = '<span class="' + (d <= 30 ? 'uc-soon' : '') + '">in ' + fmtInt(d) + ' d</span>';
                                }
                            }
                            return '<tr>'
                                + '<td><span class="addr-link" title="masked for privacy">' + escHtml(r.address) + '</span></td>'
                                + '<td class="num">' + Number(r.balance || 0).toFixed(3) + '</td>'
                                + '<td class="num">' + fmtInt(r.idle_days || 0) + '</td>'
                                + '<td>' + disposal + '</td>'
                                + '</tr>';
                        }).join('');
                    }
                }

                // U-03 · prize-pool sweep ledger
                const ht = document.getElementById('uc-history');
                if (ht) {
                    if (!batches.length) {
                        ht.innerHTML = '<tr><td colspan="4">No sweeps yet</td></tr>';
                    } else {
                        ht.innerHTML = batches.map(function (b) {
                            return '<tr>'
                                + '<td>' + escHtml(new Date((b.created_at || 0) * 1000).toLocaleString('en-US', { timeZone: 'UTC' })) + '</td>'
                                + '<td class="num">' + Number(b.total_swept || 0).toFixed(3) + '</td>'
                                + '<td class="num">' + fmtInt(b.source_count || 0) + '</td>'
                                + '<td>prize pool</td>'
                                + '</tr>';
                        }).join('');
                    }
                }
            } catch (e) {
                if (block) block.style.display = 'none';
            }
        }

        document.addEventListener('DOMContentLoaded', function () {
            const bar = document.getElementById('ph-rangebar');
            if (bar) {
                bar.addEventListener('click', function (e) {
                    const btn = e.target.closest('.rng-btn');
                    if (!btn) return;
                    const r = btn.getAttribute('data-range');
                    if (!r || r === phRange) return;
                    phRange = r;
                    bar.querySelectorAll('.rng-btn').forEach(b => b.classList.toggle('active', b === btn));
                    loadTransparency();
                });
            }
            loadFeeRate();
            loadTransparency();
            loadRecentPayouts();
            loadUnclaimed();
        });

        // Refresh every 60 seconds. The fee is re-read too: an admin save applies it live.
        Auth.poll(function () { loadFeeRate(); loadTransparency(); loadRecentPayouts(); loadUnclaimed(); }, 60000);
