// fortune-board-offers.js — the "What's on offer" cards of fortune-board.html, plus the small
// formatters the page script (js/pages/fortune-board.js, loaded right after this) shares.
//
// Contract: FbOffers.render(container, offers, byKind, streakActive) draws one card per key PRESENT
// in /api/public/incentives/overview `offers`. The server includes a key only while its payer
// would actually pay (lib/incentives-public.js offers()), so an absent key means no card — never
// an "off" badge.
//
// Every sentence on a card restates what the payer code does, not what the settings page says:
//   daily giveaway  lib/daily-giveaway.js (eligibleEntries, plan, settle)
//   weekly draw     lib/lottery.js dueDraws + runDraw + resolveDraw (7-day window, Pot A by work
//                   with the optional whale cap, Pot B one ticket per address, the rest of the pot
//                   never leaves the prize pool)
//   special/contest lib/lottery.js dueDraws (MM-DD every year) and runDueCampaigns (after ends_at)
//   join bonus      lib/incentives.js maybePayJoinBonus, run at each confirmed withdrawal
//   jackpot         lib/incentives.js payBlockFinderJackpot, run when the block matures, and
//                   payPendingJackpots (a jackpot the prize pool cannot cover waits, oldest first)
//   streak          lib/incentives.js updateStreaks (hourly, from hashrate_history) +
//                   streakMultiplier + applyToDistribution step 3
// Change a payer and its card must change with it. Fixed pots are "up to" because runDraw clamps
// a fixed pot to the prize-pool balance.
//
// Every server string goes through esc() before it reaches markup.
(function () {
    'use strict';

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // An operator-set figure, exactly as configured ("0.5", "2", "1,000").
    function num(n) { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 9 }); }
    function pct(n) { return num(n) + '%'; }
    function plural(n, one, many) { return Number(n) === 1 ? one : many; }

    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    // UTC calendar date "Nov 8, 2026" (the page states UTC once, in its heading).
    function fmtDate(sec) {
        if (!sec) return '—';
        var d = new Date(sec * 1000);
        return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
    }
    function fmtDateTime(sec) {
        if (!sec) return '—';
        var d = new Date(sec * 1000);
        return fmtDate(sec) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
    }
    // "12-25" → "Dec 25"; the raw string if it is not MM-DD.
    function fmtMonthDay(mmdd) {
        var m = /^(\d{2})-(\d{2})$/.exec(String(mmdd || ''));
        if (!m || +m[1] < 1 || +m[1] > 12) return String(mmdd || '');
        return MONTHS[+m[1] - 1] + ' ' + (+m[2]);
    }

    // "1–5", or "2" when the operator set one fixed figure.
    function rangeText(lo, hi) { return lo === hi ? num(lo) : num(lo) + '–' + num(hi); }

    // ── card copy ──────────────────────────────────────────────────────────────

    function dailyCopy(r) {
        var who = r.max_winners === 1 ? ' to 1 miner'
            : ', split into ' + rangeText(r.min_winners, r.max_winners) + ' equal prizes';
        return {
            rule: 'Every day the pool gives away ' + rangeText(r.min_grin, r.max_grin) + ' GRIN' + who + '. ' +
                (r.max_winners === 1
                    ? 'Your chance follows the work you did that day. '
                    : 'Each prize is drawn separately and your chance of each one follows the work you did that day, so one miner can win more than one. ') +
                'Winners are drawn within about two hours of 00:00 UTC. Prizes go to your pool balance, ' +
                'which you can withdraw from your Account page once it reaches the payout minimum.',
            how: 'Mine for at least ' + r.min_active_hours + plural(r.min_active_hours, ' hour', ' hours') +
                ' in a UTC day to enter that day\'s draw. A very slow rig may need longer, because only ' +
                'minutes with an accepted share count.'
        };
    }

    // Who wins a draw, from its two pot percents (runDraw: Pot A by work, Pot B one ticket per
    // address; A + B is already clamped to ≤ 100 by the server). `span` names the scored window.
    function potSentence(a, b, span) {
        var byWork = 'one miner picked by the work they did ' + span + ' (more work, better odds)';
        var equal = 'one miner picked at random, every entrant with the same chance';
        var s;
        if (a > 0 && b > 0) s = pct(a) + ' of it goes to ' + byWork + ', and ' + pct(b) + ' to ' + equal + '.';
        else if (a > 0) s = pct(a) + ' of it goes to ' + byWork + '.';
        else s = pct(b) + ' of it goes to ' + equal + '.';
        if (a + b < 100) s += ' The rest stays in the prize pool.';
        return s;
    }

    // How to qualify for a draw with these rules (runDraw: lottery_min_active_days over the window,
    // buildWeightedTickets' cap — one pass against the original total, so a capped address can still
    // hold more than the cap's share of the tickets).
    function drawHow(r, span) {
        var days = Number(r.min_active_days) || 1;
        var cap = Number(r.max_ticket_share_percent) || 0;
        var a = Number(r.pot_share_weighted_percent) || 0;
        return 'Mine on at least ' + days + plural(days, ' UTC day', ' different UTC days') + ' ' + span + '.' +
            (cap > 0 && a > 0 ? ' Each address\'s work is capped at ' + pct(cap) + ' of all entrants\' work before tickets ' +
                'are drawn, so a capped address can still hold more than ' + pct(cap) + ' of the tickets.' : '');
    }

    function weeklyCopy(w) {
        var a = Number(w.pot_share_weighted_percent) || 0;
        var b = Number(w.pot_equal_chance_percent) || 0;
        var next;
        var nowSec = Date.now() / 1000;
        if (w.next_draw_at == null) next = 'The first draw starts at the pool\'s next hourly check.';
        else if (w.next_draw_at <= nowSec) next = 'The next draw is due and starts at the pool\'s next hourly check.';
        else next = 'Next draw: soon after ' + fmtDateTime(w.next_draw_at) + ' (the pool checks once an hour).';
        return {
            rule: 'Once a week the pool puts ' + pct(w.pot_fraction_percent) + ' of the prize pool into a draw. ' +
                potSentence(a, b, 'in the 7 days before the draw') + ' Prizes go to your pool balance.',
            how: drawHow(w, 'in the 7 days before the draw'),
            extra: next + ' Winners are picked about ten blocks later, from a Grin block that did not exist yet when the entries were fixed.'
        };
    }

    // ── markup ─────────────────────────────────────────────────────────────────

    function paidLine(entry, label) {
        var count = entry ? Number(entry.count) || 0 : 0;
        var grin = entry ? Number(entry.grin) || 0 : 0;
        if (count <= 0 && grin <= 0) return '<p class="fb-offer-paid">' + esc(label) + ' nothing yet.</p>';
        return '<p class="fb-offer-paid">' + esc(label) + ' <b title="' + esc(PoolFmt.grinExact(grin, 'GRIN')) + '">' +
            esc(PoolFmt.grinTile(grin, 'GRIN')) + '</b> in ' + esc(count.toLocaleString('en-US')) +
            plural(count, ' payment', ' payments') + '.</p>';
    }

    // cover: the closing funding line, for a payer that does not simply skip when the prize pool
    // is short (the jackpot waits for it instead).
    function card(icon, title, body, cover) {
        return '<article class="fb-offer"><h3 class="fb-offer-title"><span aria-hidden="true">' + icon + '</span> ' +
            esc(title) + '</h3>' + body +
            '<p class="fb-offer-cover">' + esc(cover || 'Paid while the prize pool can cover it.') + '</p></article>';
    }
    function para(text, cls) { return '<p' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(text) + '</p>'; }
    function how(text) { return '<p class="fb-offer-how"><b>How to qualify:</b> ' + esc(text) + '</p>'; }

    function render(container, offers, byKind, streakActive) {
        offers = offers || {};
        var kinds = {};
        (Array.isArray(byKind) ? byKind : []).forEach(function (k) { if (k && k.kind) kinds[k.kind] = k; });
        var cards = [];
        // Weekly, special and contest draws share one ledger kind, so their paid-so-far is shown
        // once, on whichever of their cards comes first.
        var drawsPaidShown = false;
        var drawsPaid = function () {
            if (drawsPaidShown) return para('Prizes from these draws are counted on the weekly draw card.', 'fb-offer-paid');
            drawsPaidShown = true;
            return paidLine(kinds.lottery, 'Weekly, special and contest draws have paid');
        };

        if (offers.daily_giveaway) {
            var d = dailyCopy(offers.daily_giveaway);
            cards.push(card('🎁', 'Daily giveaway', para(d.rule) + how(d.how) +
                paidLine(kinds.giveaway, 'Paid so far:')));
        }

        if (offers.lottery_weekly) {
            var w = weeklyCopy(offers.lottery_weekly);
            cards.push(card('🎟️', 'Weekly prize draw', para(w.rule) + how(w.how) + para(w.extra, 'fb-offer-note') +
                drawsPaid()));
        }

        var events = Array.isArray(offers.special_events) ? offers.special_events : [];
        var campaigns = Array.isArray(offers.campaigns) ? offers.campaigns : [];
        if (events.length || campaigns.length) {
            // Each event / campaign carries its own resolved rules; never the weekly card's.
            var item = function (name, when, r, span, description) {
                var a = Number(r.pot_share_weighted_percent) || 0;
                var b = Number(r.pot_equal_chance_percent) || 0;
                var pot = Number(r.pot_grin) > 0
                    ? 'Up to ' + num(r.pot_grin) + ' GRIN goes into the draw.'
                    : pct(r.pot_fraction_percent) + ' of the prize pool goes into the draw.';
                return '<li><b>' + esc(name) + '</b> — ' + esc(when) + ' ' + esc(pot + ' ' + potSentence(a, b, span)) +
                    (description ? '<br><span class="dim">' + esc(description) + '</span>' : '') +
                    '<br><span class="fb-offer-how"><b>How to qualify:</b> ' + esc(drawHow(r, span)) + '</span></li>';
            };
            var items = events.map(function (ev) {
                return item(ev.name || 'Special draw', 'every year on ' + fmtMonthDay(ev.date) + '.', ev, 'in the 7 days before the draw');
            }).concat(campaigns.map(function (c) {
                return item(c.name, 'counts mining from ' + fmtDateTime(c.starts_at) + ' to ' + fmtDateTime(c.ends_at) +
                    ', drawn soon after it ends.', c, 'during the contest', c.description);
            }));
            cards.push(card('🏆', 'Special draws & contests',
                para('Extra draws on the dates below, each with its own rules. Prizes go to your pool balance.') +
                '<ul class="fb-offer-list">' + items.join('') + '</ul>' +
                para('Winners are picked about ten blocks after a draw starts, from a Grin block that did not exist yet when the entries were fixed.', 'fb-offer-note') +
                drawsPaid()));
        }

        if (offers.jackpot) {
            cards.push(card('💎', 'Block-finder jackpot',
                para('When a share from your miner solves a block for the pool, you get ' + num(offers.jackpot.amount_grin) +
                    ' GRIN on top of your normal reward for that block.') +
                how('Paid to the address that found the block, once the block matures. An orphaned block pays no jackpot.') +
                para('If the prize pool is short when the block matures, the jackpot waits, at the amount set when its block matured, and is paid as soon as the prize pool can cover it, oldest first.', 'fb-offer-note') +
                paidLine(kinds.jackpot, 'Paid so far:'),
                'Paid from the prize pool.'));
        }

        if (offers.streak) {
            var per = Number(offers.streak.bonus_per_week_percent) || 0;
            var max = Number(offers.streak.max_percent) || 0;
            var active = Number(streakActive) || 0;
            cards.push(card('🔥', 'Loyalty streak',
                para('Mine every day and earn a bonus on top of your block rewards: +' + pct(per) +
                    ' for each full week of days in a row, up to +' + pct(max) + '.') +
                how('Mine on every UTC day: a day counts once the pool has recorded hashrate from your address that day, checked every hour. Miss a whole day and the streak starts again from day one. ' +
                    'The bonus is added to your reward for each block the pool pays while your streak lasts.') +
                para(active.toLocaleString('en-US') + plural(active, ' miner is', ' miners are') + ' on a streak right now.', 'fb-offer-note') +
                paidLine(kinds.streak, 'Paid so far:')));
        }

        if (offers.join_bonus) {
            cards.push(card('👋', 'Join bonus',
                para('Every mining address gets a one-time bonus of ' + num(offers.join_bonus.amount_grin) + ' GRIN.') +
                how('Withdraw your earnings once. When that withdrawal is confirmed, the bonus is added to your pool balance. ' +
                    'If the prize pool cannot cover it at that moment, it is added at your next confirmed withdrawal instead.') +
                paidLine(kinds.join_bonus, 'Paid so far:')));
        }

        if (!cards.length) {
            container.innerHTML = '<p class="fb-state">No prizes or bonuses are running right now.</p>';
            return 0;
        }
        container.innerHTML = '<div class="fb-offers">' + cards.join('') + '</div>';
        return cards.length;
    }

    window.FbOffers = {
        render: render, esc: esc, fmtDate: fmtDate, fmtDateTime: fmtDateTime
    };
})();
