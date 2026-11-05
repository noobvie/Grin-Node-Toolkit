// settings-incentives.html page script: the Daily giveaway admin code.
// Classic script (no defer/module) loaded after settings-common.js, whose globals it uses
// (showToast, escapeHtmlSafe, loadIncentiveData). settings-common.js calls back into it for the
// draws list (renderGiveawayDraws, showGiveawayDraws*).
// One block reward. The server refuses a limit at or above this (GIVEAWAY_GRIN_LIMIT in
// lib/pool-settings.js); this copy only says so while the operator types.
const BLOCK_REWARD_GRIN = 60;

function giveawayMaxWarning(maxGrin) {
  const max = parseFloat(maxGrin);
  if (!(max >= BLOCK_REWARD_GRIN)) return '';
  return `A daily maximum of ${max} GRIN will be refused: it must be below ${BLOCK_REWARD_GRIN} GRIN (one block reward). `
    + "A day's total above a block reward means a miner can gain by discarding a block to re-roll the draw.";
}

function updateGiveawayMaxWarning() {
  const box = document.getElementById('daily-max-warning');
  const text = giveawayMaxWarning(document.getElementById('daily_giveaway_max_grin').value);
  box.textContent = text;
  box.className = text ? 'giveaway-warning' : '';
}

const shortAddr = (a) => (a.length > 18 ? a.slice(0, 12) + '…' + a.slice(-4) : a);
const winnerWord = (n) => (n === 1 ? '1 winner' : n + ' winners');
const prizeWord = (n) => (n === 1 ? '1 prize' : n + ' prizes');
// First five names, so a draw with many winners stays readable. Plain text: escape it for innerHTML.
const prizeNames = (list) => list.slice(0, 5)
  .map((w) => shortAddr(w.address) + (w.wins > 1 ? ` ×${w.wins}` : '')).join(', ')
  + (list.length > 5 ? ` +${list.length - 5} more` : '');
const utcDay = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

function giveawayDrawState(dr, holds) {
  const n = (dr.winners || []).length;
  if (dr.status === 'paid') {
    const total = dr.winners.reduce((s, w) => s + w.amount, 0);
    const wins = dr.winners.map((w) => ({ address: w.grin_address, wins: w.ticket_count || 1 }));
    const prizes = wins.reduce((s, w) => s + w.wins, 0);
    return `Paid ${total.toFixed(4)} GRIN as ${prizeWord(prizes)} to ${winnerWord(n)}: ${escapeHtmlSafe(prizeNames(wins))}`;
  }
  if (dr.status === 'empty') return 'Nobody qualified. Nothing paid.';
  if (dr.status === 'drawn') return 'Nothing paid: every winner was banned.';
  if (holds[dr.id] === 'short') return 'On hold: the prize pool is too low. It pays once you top it up.';
  if (holds[dr.id] === 'off') return 'On hold: the giveaway is switched off. It pays when you switch it back on.';
  return `Waiting for block ${escapeHtmlSafe(dr.seed_height)}. Winners are picked at the first hourly check after it.`;
}

function showGiveawayDrawsLoading() {
  document.getElementById('daily-draws').textContent = 'Loading…';
}

// Failed reads differently from "No giveaway draws yet." on purpose: the operator must not take a
// dropped connection for an empty history.
function showGiveawayDrawsFailed() {
  const el = document.getElementById('daily-draws');
  el.textContent = 'Could not load draws. ';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn-secondary';
  retry.dataset.action = 'daily-refresh';
  retry.textContent = 'Try again';
  el.appendChild(retry);
}

const SKIP_REASONS = {
  no_seed: 'the node did not answer',
  bad_rules: 'the saved limits are not valid',
  already_drawn: 'that day was already drawn',
};

function renderGiveawayDraws(draws, status) {
  const el = document.getElementById('daily-draws');
  if (!el) return;
  const st = status || {};
  const lines = [];
  if (st.last_skip) {
    const s = st.last_skip;
    const why = s.reason === 'underfunded'
      ? `the prize pool holds ${Number(s.prize_pool).toFixed(4)} GRIN, below the ${Number(s.min_grin).toFixed(4)} GRIN minimum`
      : SKIP_REASONS[s.reason] || 'the draw could not start';
    lines.push(`Last check ${new Date(s.at * 1000).toISOString().slice(11, 16)} UTC: skipped, ${why}.`);
  }
  for (const dr of draws.slice(0, 7)) {
    // A scheduled draw covers one exact UTC day; Run now covers the 24 h before it was pressed.
    const label = dr.period_start % 86400 === 0 ? utcDay(dr.period_start) : `Run now, ${utcDay(dr.period_end)}`;
    lines.push(`#${escapeHtmlSafe(dr.id)} ${label}: ${giveawayDrawState(dr, st.holds || {})}`);
  }
  el.innerHTML = lines.length ? lines.join('<br>') : 'No giveaway draws yet.';
}

function addLine(parent, text, className) {
  const line = document.createElement('div');
  line.textContent = text;
  if (className) line.className = className;
  parent.appendChild(line);
  return line;
}

const percent = (share) => (share > 0 && share < 0.001 ? '<0.1%' : (share * 100).toFixed(1) + '%');

// Real miners only: pretend miners never reach these figures, so they cannot dilute them.
function renderGiveawayOdds(out, d) {
  if (!d.real_eligible) {
    addLine(out, 'No real miner qualified yesterday, so there are no real odds to show.');
    return;
  }
  const box = document.createElement('div');
  box.className = 'giveaway-odds';
  const word = d.real_eligible === 1 ? '1 real miner' : d.real_eligible + ' real miners';
  addLine(box, `Real odds: ${word} qualified yesterday. A miner's share of the day's work is their chance of winning each prize.`);
  addLine(box, "Chance per prize, from yesterday's work:");
  const list = document.createElement('ol');
  for (const m of d.top_real) {
    const row = document.createElement('li');
    const addr = document.createElement('span');
    addr.className = 'mono';
    addr.title = m.address;
    addr.textContent = shortAddr(m.address);
    const share = document.createElement('strong');
    share.textContent = percent(m.work_share);
    row.append(addr, share);
    list.appendChild(row);
  }
  box.appendChild(list);
  if (d.real_eligible > d.top_real.length) addLine(box, `+${d.real_eligible - d.top_real.length} more`);
  out.appendChild(box);
}

async function previewDailyGiveaway() {
  const out = document.getElementById('daily-preview-out');
  const extra = document.getElementById('daily-preview-extra').value || 0;
  out.textContent = 'Working…';
  try {
    const r = await fetch('/api/admin/incentives/daily-giveaway/preview?extra_miners=' + encodeURIComponent(extra), { credentials: 'include' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Preview failed');
    if (!d.success) { out.textContent = 'Check the limits above and press Save first.'; return; }
    out.textContent = '';
    addLine(out, `Simulated with saved limits, using miners who qualified yesterday (UTC): ${d.real_eligible} real + ${d.pretend_miners} pretend. Prize pool ${d.prize_pool.toFixed(4)} GRIN. Nothing was paid.`);
    if (!d.enabled) addLine(out, 'The giveaway is off, so no real draw will run. It needs "Run the daily giveaway" and "Enable incentive features" ticked and saved.');
    renderGiveawayOdds(out, d);
    if (d.real_eligible + d.pretend_miners === 0) {
      addLine(out, 'Nobody qualified yesterday, so no day would pay. Add pretend miners to test capacity.');
      return;
    }
    if (d.pretend_miners) {
      addLine(out, `The days below include ${d.pretend_miners} pretend miners. That is a capacity test: it does not show real odds, the figures above do.`);
    }
    for (const x of d.days) {
      if (x.skipped) { addLine(out, `Day ${x.day}: skipped, prize pool below the minimum`); continue; }
      const line = addLine(out, `Day ${x.day}: `);
      const total = document.createElement('strong');
      total.textContent = x.total_grin.toFixed(4);
      const prizes = x.winners.reduce((s, w) => s + w.wins, 0);
      const split = prizes === 1 ? '1 prize' : `${prizes} prizes at ${x.share_grin.toFixed(4)} each`;
      line.append(total, ` GRIN, ${split}: ${prizeNames(x.winners)} (pool left ${x.prize_pool_after.toFixed(4)})`);
    }
  } catch (e) { out.textContent = e.message; }
}

// The form field behind each saved limit, for telling the operator what a draw will really use.
const GIVEAWAY_FIELDS = [
  ['daily_giveaway_min_grin', 'min_grin', 'Minimum per day'],
  ['daily_giveaway_max_grin', 'max_grin', 'Maximum per day'],
  ['daily_giveaway_min_winners', 'min_winners', 'Minimum prizes per day'],
  ['daily_giveaway_max_winners', 'max_winners', 'Maximum prizes per day'],
  ['daily_giveaway_min_active_hours', 'min_active_hours', 'Hours mined that day to qualify'],
];

// The server's saved limits and prize pool; the preview route is read-only. Throws the reason.
async function fetchSavedGiveaway() {
  const r = await fetch('/api/admin/incentives/daily-giveaway/preview?extra_miners=0', { credentials: 'include', cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
  if (!d.success) throw new Error('the saved limits are not valid. Check the limits above and press Save');
  if (!d.rules || !Number.isFinite(d.prize_pool)) throw new Error('the reply held no limits');
  return d;
}

function unsavedGiveawayEdits(saved) {
  const lines = [];
  for (const [id, key, label] of GIVEAWAY_FIELDS) {
    const shown = document.getElementById(id).value.trim();
    if (shown === '' || Number(shown) !== saved.rules[key]) {
      lines.push(`${label}: saved ${saved.rules[key]}, form shows ${shown || '(blank)'}`);
    }
  }
  const formOn = document.getElementById('incentives_enabled').checked && document.getElementById('daily_giveaway_enabled').checked;
  if (formOn !== saved.enabled) {
    lines.push(`Giveaway switched on: saved ${saved.enabled ? 'yes' : 'no'}, form shows ${formOn ? 'yes' : 'no'}`);
  }
  return lines;
}

// After a failed settings load the form holds page defaults, so comparing it would invent edits.
function giveawayRunConfirmText(saved) {
  const { rules, prize_pool: pool } = saved;
  const edits = settingsLoaded ? unsavedGiveawayEdits(saved) : [];
  const total = rules.min_grin === rules.max_grin
    ? `${rules.min_grin} GRIN`
    : `${rules.min_grin} to ${rules.max_grin} GRIN, a random amount inside this range`;
  const prizes = rules.min_winners === rules.max_winners
    ? `${rules.min_winners}`
    : `${rules.min_winners} to ${rules.max_winners}, a random number inside this range`;
  return 'Run a real giveaway draw now?\n\n'
    + 'SAVED limits, which this draw uses:\n'
    + `Total: ${total}`
    + (pool < rules.max_grin ? ' (never more than the prize pool)' : '') + '\n'
    + `Prizes: ${prizes}, shared equally\n`
    + `Prize pool now: ${pool.toFixed(4)} GRIN\n\n`
    + (edits.length
      ? 'THE FORM HAS UNSAVED CHANGES. This draw ignores them:\n' + edits.join('\n')
        + '\nCancel and press Save first if you want them used.\n\n'
      : '')
    + 'This pays from the prize pool to REAL miners only. Pretend miners are not included. '
    + 'It is an extra draw over the last 24 hours and does not replace the scheduled one. '
    + 'Winners are picked at the next hourly check after the seed block is mined. This cannot be undone.';
}

async function runDailyGiveawayNow() {
  const out = document.getElementById('daily-run-out');
  const tell = (text, kind) => { out.textContent = text; showToast(text, kind); };
  out.textContent = 'Reading the saved limits…';
  let saved;
  try {
    saved = await fetchSavedGiveaway();
  } catch (e) {
    tell(`Nothing was drawn: could not read the saved limits and prize pool (${e.message}).`, 'error');
    return;
  }
  out.textContent = '';
  const failure = (res) => ({
    disabled: 'The giveaway is off. Tick "Run the daily giveaway" and "Enable incentive features", then press Save.',
    draw_open: `Draw #${res.draw_id || '?'} is still open: it is waiting for its block, or on hold. See Recent giveaway draws below.`,
    underfunded: `Not drawn: the prize pool holds ${Number(res.prize_pool).toFixed(4)} GRIN, less than your minimum of ${Number(res.min_grin).toFixed(4)} GRIN. Add funds under Prize Pool Funding.`,
    bad_rules: 'Check the limits above and press Save first.',
    no_seed: 'The node did not answer, so no draw was made and nothing changed. Try again in a few minutes.',
  })[res.reason] || 'Nothing was drawn.';
  // Refused now, not after a confirm that asks about a draw the server would turn down.
  if (!saved.enabled) { tell(failure({ reason: 'disabled' }), 'warn'); return; }
  if (saved.prize_pool < saved.rules.min_grin) {
    tell(failure({ reason: 'underfunded', prize_pool: saved.prize_pool, min_grin: saved.rules.min_grin }), 'warn');
    return;
  }
  if (!confirm(giveawayRunConfirmText(saved))) return;
  try {
    const r = await adminFetch('/api/admin/incentives/daily-giveaway/run', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Draw failed');
    const res = d.result || {};
    if (!res.success) tell(failure(res), 'warn');
    else if (res.eligible === 0) tell('Nobody mined enough in the last 24 hours, so nothing will be paid. To test alone, set "Hours mined that day to qualify" to 1, press Save, and mine for an hour.', 'warn');
    else tell(`Draw #${res.draw_id} started with ${res.eligible === 1 ? '1 miner' : res.eligible + ' miners'}. Winners are picked after block ${res.seed_height} (about 10 minutes), at the next hourly check. Press Refresh below to see the result.`, 'success');
    loadIncentiveData();
  } catch (e) { tell(e.message, 'error'); }
}

document.getElementById('daily_giveaway_max_grin').addEventListener('input', updateGiveawayMaxWarning);

document.addEventListener('click', (e) => {
  const el = e.target.closest && e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'daily-preview': previewDailyGiveaway(); break;
    case 'daily-run-now': runDailyGiveawayNow(); break;
    case 'daily-refresh': {
      // Try again sits inside the list and is replaced by it, so focus must not fall to the page.
      const list = el.closest('#daily-draws');
      loadIncentiveData().then(() => {
        if (!list) return;
        const target = list.querySelector('button') || list;
        if (target === list) list.tabIndex = -1;
        target.focus();
      });
      break;
    }
  }
});
