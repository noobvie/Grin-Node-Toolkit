// donate.js — the donate page's own script. Until 2026-10 (pool code-layout refactor,
// part F2) this was donate.html's inline <script> block; it moved out byte-for-byte so
// a strict script-src can drop 'unsafe-inline'. The block's indent is kept.
//
// The page loads it as a CLASSIC script at the block's old position. Never add defer / async /
// type="module": the order and the shared global scope are what this code was written against.
        // ── Slatepack address copy ─────────────────────────────────────────────
        function copyAddress() {
            var el = document.getElementById('donation-address');
            var text = el ? el.textContent.trim() : '';
            if (!text) return;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function () { flash('Copied!'); }, function () { flash('Copy failed'); });
            } else {
                var r = document.createRange(); r.selectNode(el);
                var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
                try { document.execCommand('copy'); flash('Copied!'); } catch (e) { flash('Copy failed'); }
                s.removeAllRanges();
            }
        }
        function flash(msg) {
            var btn = document.querySelector('.copy-btn'); if (!btn) return;
            var old = btn.textContent; btn.textContent = msg;
            setTimeout(function () { btn.textContent = old; }, 1500);
        }

        // ── Donor league (/api/pool/donors v3 — design §16.6 + §18.3/§18.7) ─────
        (function () {
            'use strict';

            function escHtml(s) {
                return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            }
            function truncAddr(a) {
                a = String(a || '');
                return a.length > 22 ? a.slice(0, 12) + '…' + a.slice(-6) : a;
            }
            // Dates shown as plain UTC days (page-wide UTC note in the header strip).
            function utcDay(sec) {
                return sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '—';
            }
            function fmtGrin(v) {
                return (typeof v === 'number' && isFinite(v) ? v : 0).toFixed(4);
            }
            // ×1.4, ×2, ×3 — up to two decimals, no trailing zeros.
            function fmtMult(m) {
                m = typeof m === 'number' && isFinite(m) ? m : 1;
                return String(Math.round(m * 100) / 100);
            }
            function plural(n, one, many) { return n === 1 ? one : many; }

            var windowDays = 0; // set from `ranking` before any card renders

            // What a card is headed by (§18.7): the donor's APPROVED name when the API says
            // `shown`, else the masked address the API already applied. Every name goes through
            // escHtml: the server's name rule is not a reason to trust a string that reaches
            // innerHTML.
            function nameCell(d) {
                if (typeof d.name === 'string' && d.name !== '' && d.name_state === 'shown') {
                    return '<span class="donor-name">' + escHtml(d.name) + '</span>';
                }
                // Plain text, no link and no `title` (audit §J11-1): the address is masked
                // server-side and a donor wall is a thank-you, not an identity register.
                return '<span class="addr-plain">' + escHtml(truncAddr(d.address)) + '</span>';
            }

            function medal(rank) {
                return rank >= 1 && rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : '#' + escHtml(rank);
            }

            // The live donation (§18.3 copy rules): one % → "10 %", mixed rigs → "5–20 %", and
            // no tagged rig mining right now → "paused". rigs_donating / pct_* already read 0
            // while the operator has donations off, so that case needs no branch here.
            function liveCopy(d) {
                var n = Number(d.rigs_donating);
                var hi = Number(d.pct_max), lo = Number(d.pct_min);
                n = isFinite(n) && n > 0 ? Math.floor(n) : 0;
                if (!n || !(isFinite(hi) && hi > 0)) return { n: 0, badge: '<span class="donor-badge off">paused — no tagged rig online</span>' };
                if (!(isFinite(lo) && lo > 0) || lo > hi) lo = hi;
                var pct = (lo === hi ? escHtml(hi) : escHtml(lo) + '–' + escHtml(hi)) + ' %';
                return { n: n, badge: '<span class="donor-badge on">' + pct + ' of new earnings from ' +
                    escHtml(n) + ' ' + plural(n, 'rig', 'rigs') + '</span>' };
            }

            // Everything under a card's name: window total, lifetime, loyalty, the live line and
            // "since <date> · N rigs donating". Shared by the compact and the spotlight cards.
            function cardStats(d) {
                var inWin = typeof d.in_window_donated === 'number' ? d.in_window_donated : 0;
                var life = typeof d.total_donated === 'number' ? d.total_donated : 0;
                var months = Number(d.active_months) || 0;
                var live = liveCopy(d);
                // Lifetime printed only when it differs from the window figure (§16.7) — with an
                // all-time window the two are the same number and printing it twice reads as a bug.
                var lifetime = Math.abs(life - inWin) > 5e-10
                    ? '<div class="donor-lifetime">' + fmtGrin(life) + ' GRIN lifetime</div>'
                    : '';
                return '<div class="donor-total">' + fmtGrin(inWin) + ' <small>GRIN' + (windowDays > 0 ? ' in window' : '') + '</small></div>' +
                    lifetime +
                    '<div class="donor-loyalty">×<b>' + escHtml(fmtMult(d.multiplier)) + '</b> loyalty · <b>' + escHtml(months) + '</b> ' + plural(months, 'month', 'months') + '</div>' +
                    live.badge +
                    '<div class="donor-meta">' +
                        'since <b>' + utcDay(d.first_donated_at) + '</b>' +
                        (live.n > 0 ? ' · <b>' + escHtml(live.n) + '</b> ' + plural(live.n, 'rig', 'rigs') + ' donating' : '') +
                    '</div>';
            }

            function leagueCard(d) {
                return '<div class="donor-card">' +
                    '<div class="donor-rank">' + medal(d.rank) + '</div>' +
                    nameCell(d) +
                    cardStats(d) +
                '</div>';
            }

            // The banner the API sent, or null. The server already refuses to emit anything but
            // its own approved-file URL; this is the second fence (defence in depth against a bad
            // row or a proxy rewriting the response): exactly the shape lib/donor-profiles.js
            // writes, and positive integer dims for the width/height attributes.
            var BANNER_URL_RE = /^\/uploads\/donors\/[0-9a-f]{16}\.(png|jpg|gif)$/;
            function bannerOf(d) {
                var b = d && d.banner;
                if (!b || typeof b.url !== 'string' || !BANNER_URL_RE.test(b.url)) return null;
                var w = Number(b.width), h = Number(b.height);
                if (!(w > 0 && h > 0 && Math.floor(w) === w && Math.floor(h) === h)) return null;
                return { url: b.url, width: w, height: h };
            }

            // A spotlight card (§18.7): the banner in a 4:1 box — or, with no banner, the name
            // large in the same box — then the rank and the same stats as a compact card. The
            // name is repeated under a banner as text, because a banner may be a logo alone.
            function spotCard(d, first) {
                var b = bannerOf(d);
                var named = typeof d.name === 'string' && d.name !== '' && d.name_state === 'shown';
                var alt = named ? d.name : 'Donor #' + d.rank;
                var box = b
                    ? '<div class="spot-banner"><img src="' + escHtml(b.url) + '" width="' + b.width +
                        '" height="' + b.height + '" alt="' + escHtml(alt) + '" loading="lazy" decoding="async"></div>'
                    : '<div class="spot-banner noimg">' + nameCell(d) + '</div>';
                return '<div class="donor-card' + (first ? ' spot-first' : '') + '">' +
                    box +
                    '<div class="spot-body">' +
                        '<div class="donor-rank">' + medal(d.rank) + '</div>' +
                        (b ? nameCell(d) : '') +
                        cardStats(d) +
                    '</div>' +
                '</div>';
            }

            // Past strip row: name/masked + lifetime GRIN + last donation (§16.7).
            function pastRow(d) {
                return '<li>' + nameCell(d) +
                    '<span class="donor-past-amt">' + fmtGrin(d.total_donated) + ' GRIN</span>' +
                    '<span class="donor-past-date">last ' + utcDay(d.last_donated_at) + '</span>' +
                '</li>';
            }

            // The one ranking sentence (§16.6, "published on the page in one sentence"), built
            // from the settings the API sends so it can never disagree with the score.
            function rankingSentence(r) {
                r = r || {};
                var w = Number(r.window_days) || 0;
                var p = Number(r.loyalty_percent_per_month);
                var c = Number(r.loyalty_cap);
                if (!isFinite(p) || p < 0) p = 0;
                if (!isFinite(c) || c < 1) c = 1;
                var span = w > 0 ? 'in the last ' + w + ' ' + plural(w, 'day', 'days') : 'all-time';
                return 'Ranked by GRIN donated ' + span + ' × loyalty (+' + p + ' % per month you’ve donated in, up to ×' + c + ').';
            }

            function render(data) {
                var league = (data && Array.isArray(data.league)) ? data.league : [];
                var past = (data && data.past && Array.isArray(data.past.donors)) ? data.past.donors : [];
                var more = (data && data.past && Number(data.past.more)) || 0;
                var totals = (data && data.totals) || {};
                var ranking = (data && data.ranking) || {};
                windowDays = Number(ranking.window_days) || 0;

                var set = function (id, v) {
                    var el = document.getElementById(id);
                    if (el && v != null) el.textContent = v;
                };
                // Placard tile: short figure + exact tooltip (js/num-format.js).
                if (totals.total_donated != null) PoolFmt.setGrinTile(document.getElementById('dn-total'), Number(totals.total_donated));
                set('dn-count', totals.donor_count != null ? String(totals.donor_count) : '—');
                set('dn-active', totals.active_donors != null ? String(totals.active_donors) : '—');
                set('donor-ranking', rankingSentence(ranking));

                // N of the Top-N spotlight: the operator's donor_banner_slots, 0–10, 0 = off.
                var slots = Number(ranking.banner_slots);
                slots = isFinite(slots) && slots > 0 ? Math.min(10, Math.floor(slots)) : 0;
                // D-01b follows the same two settings, so it never promises what the wall won't do.
                var bannerLi = document.getElementById('dn-banner-li');
                if (bannerLi) {
                    if (slots > 0) set('dn-banner-top', 'the top ' + slots + ' ' + plural(slots, 'donor', 'donors') + ' in the league');
                    else bannerLi.textContent = '🖼️ Banners are switched off on this pool, so the wall shows names only.';
                }
                var exp = Number(ranking.name_expiry_months);
                if (isFinite(exp) && exp >= 0) {
                    set('dn-expiry', exp > 0
                        ? 'A name and banner stop showing ' + exp + ' ' + plural(exp, 'month', 'months') + ' after your last donation, and come back when you donate again.'
                        : 'A name and banner stay up for as long as the pool keeps them up.');
                }

                var grid = document.getElementById('donor-grid');
                var empty = document.getElementById('donor-empty');
                var pastBox = document.getElementById('donor-past');
                var spotWrap = document.getElementById('donor-spot-wrap');

                if (!league.length) {
                    // A card needs an actual slice, and a slice is only taken when a block
                    // MATURES — so a new pool has tags set for days before the first card. Say so,
                    // or the miner who just set donate10 reads "no donors" as "my tag didn't take".
                    // With past donors but an empty window the page says THAT instead.
                    var tagged = Number(totals.active_donors || 0);
                    empty.textContent = past.length
                        ? 'NO DONATIONS IN THE RANKING WINDOW YET — past donors below'
                        : tagged > 0
                            ? tagged + (tagged === 1 ? ' MINER HAS' : ' MINERS HAVE') + ' A DONATE TAG SET 💚 — the first slice is taken when the pool’s next block matures'
                            : 'NO DONORS YET — BE THE FIRST 💚';
                    empty.style.display = '';
                    grid.style.display = 'none';
                    spotWrap.style.display = 'none';
                } else {
                    // Ranks 1..N in the spotlight, N+1.. as today's compact cards. The API sends
                    // the league in rank order; a card only gets a banner if the API attached one.
                    var top = league.slice(0, slots), rest = league.slice(slots);
                    if (top.length) {
                        document.getElementById('donor-spot').innerHTML =
                            top.map(function (d, i) { return spotCard(d, i === 0); }).join('');
                        set('donor-spot-head', 'Top ' + slots);
                        spotWrap.style.display = '';
                    } else {
                        spotWrap.style.display = 'none';
                    }
                    grid.innerHTML = rest.map(leagueCard).join('');
                    grid.style.display = rest.length ? '' : 'none';
                    empty.style.display = 'none';
                }

                if (past.length) {
                    document.getElementById('donor-past-list').innerHTML = past.map(pastRow).join('');
                    var moreEl = document.getElementById('donor-past-more');
                    if (more > 0) {
                        moreEl.textContent = 'and ' + more + ' more past ' + plural(more, 'donor', 'donors');
                        moreEl.style.display = '';
                    } else {
                        moreEl.style.display = 'none';
                    }
                    pastBox.style.display = '';
                } else {
                    pastBox.style.display = 'none';
                }
            }

            // 2xx-only read: a non-2xx (a 429 is an object with `error`) must never render as
            // data — same contract as Auth.read on the other public pages (audit §J15-2).
            fetch('/api/pool/donors', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (json) {
                    if (json && typeof json === 'object') { render(json); }
                    else { document.getElementById('donor-empty').textContent = 'DONOR DATA UNAVAILABLE'; }
                })
                .catch(function () {
                    document.getElementById('donor-empty').textContent = 'DONOR DATA UNAVAILABLE';
                });
        })();

        // ── Prize pool ledger (/api/pool/prize-pool) ───────────────────────────
        (function () {
            'use strict';
            function escHtml(s) {
                return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            }
            function fmtGrin(v) { return (typeof v === 'number' ? v : 0).toFixed(4); }
            function rows(arr) {
                if (!arr || !arr.length) return '<tr><td class="pp-none">none yet</td><td></td></tr>';
                return arr.map(function (x) {
                    return '<tr><td>' + escHtml(x.label) + '</td><td class="pp-amt">' + fmtGrin(x.amount) + '</td></tr>';
                }).join('');
            }
            function set(id, v) { var el = document.getElementById(id); if (el && v != null) el.textContent = v; }

            fetch('/api/pool/prize-pool', { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) {
                    if (!d) { document.getElementById('pp-empty').textContent = 'PRIZE POOL DATA UNAVAILABLE'; return; }
                    set('pp-balance', fmtGrin(d.balance));
                    set('pp-in-total', fmtGrin(d.in && d.in.total));
                    set('pp-out-total', fmtGrin(d.out && d.out.total));
                    document.getElementById('pp-in-body').innerHTML = rows(d.in && d.in.by);
                    document.getElementById('pp-out-body').innerHTML = rows(d.out && d.out.by);
                    document.getElementById('pp-cols').style.display = '';
                    document.getElementById('pp-empty').style.display = 'none';
                })
                .catch(function () {
                    document.getElementById('pp-empty').textContent = 'PRIZE POOL DATA UNAVAILABLE';
                });
        })();

// ==== F2: event wiring — replaces the inline on*= attributes this page used to carry (strict
// script-src blocks them). One delegated listener per event type, keyed on data-action; each
// action calls the SAME function with the SAME arguments the old attribute did (`event` → e).
document.addEventListener('click', function (e) {
  var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
  if (!el) return;
  switch (el.getAttribute('data-action')) {
    case 'copy-address': copyAddress(); break;
  }
});
