// The settings pages' browser behaviour: admin-panel/settings-common.js and its page scripts run in
// a fake DOM parsed from the real settings-*.html (scripts/lib/fake-dom.js), against a mock API.
// Layout and CSS are not covered here.
//
//   [1] a failed settings load: Save is refused on every page and every failure mode
//   [2] Retry opens Save only after a load that worked
//   [3] a normal load is unaffected, and saves what is stored
//   [4] the SEO page's GA4 mirror never merges into a guessed analytics section
//   [5] donors.html, which saves part of the incentives section with its own form
//   [6] the note that a daily maximum at one block reward will be refused
//   [7] Run a real draw now: the confirm shows the saved figures, and no figures means no draw
//   [8] Preview: real odds above the simulated days, pretend miners labelled a capacity test
//   [9] Recent giveaway draws: failed never reads as loading or as empty
//
// Run: node scripts/test-settings-ui.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { FakeDocument } = require('./lib/fake-dom');
const PoolSettings = require('../lib/pool-settings');

const PANEL = path.resolve(__dirname, '../admin-panel');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

const PAGES = {
  'settings-access.html': 'access', 'settings-analytics.html': 'analytics',
  'settings-announcements.html': 'notices', 'settings-branding.html': 'branding',
  'settings-database.html': 'database', 'settings-games.html': 'games',
  'settings-incentives.html': 'incentives', 'settings-names.html': 'names',
  'settings-payout.html': 'payout', 'settings-pool-info.html': 'pool_info', 'settings-seo.html': 'seo',
};

// What the live GET returns, with the giveaway and master switch moved off the HTML defaults.
const stored = () => {
  const s = JSON.parse(JSON.stringify(PoolSettings.defaults));
  Object.assign(s.incentives, {
    incentives_enabled: 'true', daily_giveaway_enabled: 'true',
    daily_giveaway_min_grin: 10, daily_giveaway_max_grin: 50,
  });
  s.analytics.provider = 'plausible';
  s.analytics.plausible_domain = 'kept.example';
  return s;
};

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (body === undefined) throw new SyntaxError('Unexpected token <');
    return body;
  },
});
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };
const isGet = (o) => !o || !o.method;

// Boots one page. route(url, opts) may answer any fetch; anything it leaves gets the normal reply.
async function boot(page, { route = () => null, scripts = ['settings-common.js'], section, confirmAnswer = true } = {}) {
  const doc = new FakeDocument(fs.readFileSync(path.join(PANEL, page), 'utf8'));
  const posts = [], gets = [], toasts = [], confirms = [];
  const realAppend = doc.body.appendChild.bind(doc.body);
  doc.body.appendChild = (el) => {
    if (!/\btoast\b/.test(el.className)) return realAppend(el);
    toasts.push({ text: el.textContent, kind: el.className.replace('toast', '').trim() });
    return el;
  };
  const answer = async (url, opts = {}) => {
    const post = (opts.method || 'GET').toUpperCase() === 'POST';
    if (post) posts.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    else gets.push(url);
    const r = await route(url, opts);
    if (r) return r;
    if (post) return reply(200, { success: true });
    if (url === '/api/admin/settings') return reply(200, { success: true, data: stored() });
    return reply(404, { error: 'no mock' });
  };
  const winListeners = {};
  const sandbox = {
    document: doc,
    console: { log() {}, warn() {}, error() {} },
    fetch: answer,
    adminFetch: answer,
    AbortSignal,
    confirm: (text) => { confirms.push(text); return confirmAnswer; },
    setTimeout: (fn) => setImmediate(fn),
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    location: { hash: '', pathname: '/admin/' + page, reload() {} },
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
    API: {
      guardAdminPage: async () => ({ is_admin: true }),
      get: async (url) => (await answer(url)).json(),
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of scripts) {
    doc.currentScript = { getAttribute: (k) => (k === 'data-section' && file === 'settings-common.js' ? section : null) };
    vm.runInContext(fs.readFileSync(path.join(PANEL, file), 'utf8'), sandbox, { filename: file });
  }
  doc.currentScript = null;
  return {
    doc, sandbox, posts, gets, toasts, confirms,
    fire() {
      for (const fn of doc.listeners.DOMContentLoaded || []) fn({});
      for (const fn of winListeners.DOMContentLoaded || []) fn({});
    },
    call: (src) => vm.runInContext(src, sandbox),
    buttons: (sel) => doc.querySelectorAll(sel),
  };
}

const WRITES = '[data-action="save-section"], [data-action="restore-section"], [data-action="save-campaign"]';
const scriptsFor = (page) => (page === 'settings-incentives.html'
  ? ['settings-common.js', 'js/settings-incentives.js'] : ['settings-common.js']);
const incentivesPage = (opts = {}) => boot('settings-incentives.html', {
  section: 'incentives', scripts: scriptsFor('settings-incentives.html'), ...opts,
});
const onSettingsGet = (fn) => (url, o) => (url === '/api/admin/settings' && isGet(o) ? fn() : null);

const FAILURES = {
  'HTTP 500': () => reply(500, { error: 'boom' }),
  '429 after its retries': () => reply(429, { error: 'slow down' }),
  '503 after its retries': () => reply(503, {}),
  'a dropped connection': () => { throw new TypeError('Failed to fetch'); },
  'a 200 that is not JSON': () => reply(200),
  'a 200 with no data': () => reply(200, { success: true }),
  'a 200 with an empty data object': () => reply(200, { success: true, data: {} }),
};

(async () => {
  console.log('\n[1] a failed load refuses every write, on every settings page');
  ok('every page section exists in the live settings', Object.values(PAGES).every((s) => s in PoolSettings.defaults));
  for (const [page, section] of Object.entries(PAGES)) {
    const problems = [];
    for (const [label, fn] of Object.entries(FAILURES)) {
      const t = await boot(page, { route: onSettingsGet(fn), section, scripts: scriptsFor(page) });
      t.fire();
      await settle();
      const writes = t.buttons(WRITES);
      const banner = t.doc.getElementById('settings-load-failed');
      for (const b of writes) b.click();
      t.call(`saveSection(${JSON.stringify(section)})`);
      t.call(`restoreSection(${JSON.stringify(section)})`);
      await settle();
      const good = writes.length >= 2 && writes.every((b) => b.disabled)
        && banner && banner.getAttribute('role') === 'alert'
        && /did not load/i.test(banner.textContent) && /cannot be saved/i.test(banner.textContent)
        && /act straight away/.test(t.doc.getElementById('settings-load-why').textContent)
        && t.posts.length === 0 && t.confirms.length === 0 && !t.toasts.some((x) => x.kind === 'success');
      if (!good) {
        problems.push(`${label}: disabled=${writes.map((b) => b.disabled)} banner=${!!banner} posts=${JSON.stringify(t.posts).slice(0, 120)}`);
      }
    }
    ok(`${page}: all ${Object.keys(FAILURES).length} failure modes refuse Save and show the banner`,
      problems.length === 0, problems.join('\n        '));
  }
  {
    const t = await incentivesPage({ route: onSettingsGet(() => reply(429, {})) });
    t.fire();
    await settle();
    ok('a 429 is retried twice before it counts as a failure', t.gets.filter((u) => u === '/api/admin/settings').length === 3);
    t.call('saveCampaign()');
    await settle();
    ok('Save campaign is refused in code too', t.posts.length === 0);

    let release;
    const hold = new Promise((r) => { release = r; });
    const p = await incentivesPage({ route: async (url, o) => { if (url === '/api/admin/settings' && isGet(o)) await hold; return null; } });
    p.fire();
    await settle();
    p.call("saveSection('incentives')");
    await settle();
    ok('while the load is in flight Save is off and refused', p.buttons(WRITES).every((b) => b.disabled) && p.posts.length === 0);
    ok('and no failure banner shows yet', !p.doc.getElementById('settings-load-failed'));
    release();
    await settle();
    ok('then it opens', p.buttons(WRITES).every((b) => !b.disabled));

    const a = await incentivesPage({ route: onSettingsGet(() => reply(401, { error: 'no' })) });
    a.fire();
    await settle();
    a.call("saveSection('incentives')");
    await settle();
    ok('a 401 refuses Save as well', a.posts.length === 0 && a.buttons(WRITES).every((b) => b.disabled));
  }

  console.log('\n[2] Retry opens Save only after a load that worked');
  {
    let mode = 'fail', hold = null;
    const t = await incentivesPage({
      route: async (url, o) => {
        if (url !== '/api/admin/settings' || !isGet(o)) return null;
        if (hold) await hold;
        return mode === 'fail' ? reply(500, {}) : null;
      },
    });
    t.fire();
    await settle();
    const retry = () => t.doc.querySelector('#settings-load-failed button');
    ok('the banner carries a Retry button', retry() && retry().textContent === 'Retry' && retry().type === 'button');
    retry().click();
    await settle();
    ok('a Retry that fails keeps Save off and the banner up, and Retry works again',
      t.buttons(WRITES).every((b) => b.disabled) && !!retry() && !retry().disabled);
    let release;
    hold = new Promise((r) => { release = r; });
    mode = 'ok';
    retry().click();
    await settle();
    ok('while a Retry is in flight Save stays off and Retry cannot be pressed twice',
      t.buttons(WRITES).every((b) => b.disabled) && retry().disabled);
    release();
    hold = null;
    await settle();
    ok('a Retry that works removes the banner and opens Save',
      !t.doc.getElementById('settings-load-failed') && t.buttons(WRITES).every((b) => !b.disabled));
    t.doc.querySelector('[data-action="save-section"]').click();
    await settle();
    const body = (t.posts[0] || {}).body || {};
    ok('and Save then sends the stored values, not the HTML defaults',
      body.daily_giveaway_min_grin === '10' && body.daily_giveaway_max_grin === '50'
      && body.daily_giveaway_enabled === true && body.incentives_enabled === true, JSON.stringify(body).slice(0, 200));
  }

  console.log('\n[3] a normal load is unaffected');
  for (const [page, section] of Object.entries(PAGES)) {
    const t = await boot(page, { section, scripts: scriptsFor(page) });
    t.fire();
    await settle();
    const writes = t.buttons(WRITES);
    const banner = t.doc.getElementById('settings-load-failed');
    t.doc.querySelector(`[data-action="save-section"][data-section="${section}"]`).click();
    await settle();
    ok(`${page}: no banner, Save on, Save posts to its section`,
      !banner && writes.every((b) => !b.disabled) && t.posts.length >= 1 && t.posts[0].url === `/api/admin/settings/${section}`,
      `banner=${!!banner} posts=${JSON.stringify(t.posts.map((p) => p.url))}`);
  }

  console.log('\n[4] the SEO page GA4 mirror');
  for (const [label, second] of [
    ['HTTP 429', () => reply(429, { error: 'slow' })],
    ['a 200 with no analytics', () => reply(200, { success: true, data: { seo: {} } })],
  ]) {
    let reads = 0;
    const t = await boot('settings-seo.html', {
      section: 'seo',
      route: (url, o) => (url === '/api/admin/settings' && isGet(o) && ++reads > 1 ? second() : null),
    });
    t.fire();
    await settle();
    t.doc.querySelector('[data-action="save-section"]').click();
    await settle();
    ok(`${label} on the re-read: analytics is not posted, and the page says so`,
      t.posts.length === 1 && t.posts[0].url === '/api/admin/settings/seo'
      && t.toasts.some((x) => x.kind === 'warn' && /GA4/.test(x.text)),
      JSON.stringify(t.posts.map((p) => p.url)));
  }
  {
    const t = await boot('settings-seo.html', { section: 'seo' });
    t.fire();
    await settle();
    t.doc.querySelector('[data-action="save-section"]').click();
    await settle();
    const mirror = t.posts.find((p) => p.url === '/api/admin/settings/analytics');
    ok('a working mirror keeps the stored provider',
      mirror && mirror.body.provider === 'plausible' && mirror.body.plausible_domain === 'kept.example');
  }

  console.log('\n[5] donors.html saves part of the incentives section');
  {
    // Only the donation form: the rest of donors.js is queues and tables with their own tests.
    const src = fs.readFileSync(path.join(PANEL, 'js/donors.js'), 'utf8');
    const start = src.indexOf('const FORM_SEL = ');
    const end = src.indexOf("document.addEventListener('DOMContentLoaded'", start);
    const part = 'function loadQueue() {} function loadLinkQueue() {} function loadDonors() {}\n'
      + "function flashInto(id, m) { document.getElementById(id).textContent = m; }\n" + src.slice(start, end);
    const run = async (route) => {
      const t = await boot('donors.html', { route, scripts: [] });
      vm.runInContext(part, t.sandbox, { filename: 'donors-form.js' });
      t.call('loadDonationSettings()');
      await settle();
      return t;
    };
    const save = (t) => t.doc.querySelector('[data-action="save-donation-settings"]');
    const onIncentives = (fn) => (url, o) => (url === '/api/admin/settings/incentives' && isGet(o) ? fn() : null);
    for (const [label, r] of [
      ['a failed load', () => reply(500, { success: false, error: 'boom' })],
      ['a reply with no data', () => reply(200, { success: true })],
    ]) {
      const t = await run(onIncentives(r));
      t.call('saveDonationSettings()');
      await settle();
      const box = t.doc.getElementById('donation-load-failed');
      ok(`${label}: Save is off, refused in code, and the banner stays`,
        save(t).disabled && t.posts.length === 0 && box && box.getAttribute('role') === 'alert' && /did not load/i.test(box.textContent),
        JSON.stringify(t.posts).slice(0, 160));
    }
    let bad = true;
    const t = await run(onIncentives(() => (bad ? reply(500, {}) : reply(200, { success: true, data: { donor_loyalty_cap: 7 } }))));
    bad = false;
    const retry = t.doc.querySelector('#donation-load-failed button');
    bad = true;
    retry.click();
    ok('its Retry shows it is working', retry.disabled && /Retrying/.test(retry.textContent));
    await settle();
    ok('a Retry that fails keeps the same button, ready again',
      t.doc.querySelector('#donation-load-failed button') === retry && !retry.disabled && retry.textContent === 'Retry');
    bad = false;
    retry.click();
    await settle();
    ok('its Retry opens Save once a load works', !save(t).disabled && !t.doc.getElementById('donation-load-failed')
      && !t.doc.getElementById('donation-load-why'));
    t.call('saveDonationSettings()');
    await settle();
    ok('and Save posts the stored value', t.posts.length === 1 && t.posts[0].body.donor_loyalty_cap === '7', JSON.stringify(t.posts).slice(0, 160));
  }

  console.log('\n[6] a daily maximum at one block reward is refused, and the page says so first');
  {
    const setMax = (t, v) => {
      const el = t.doc.getElementById('daily_giveaway_max_grin');
      el.value = v;
      el.dispatch('input');
    };
    const box = (t) => t.doc.getElementById('daily-max-warning');
    const t = await incentivesPage();
    t.fire();
    await settle();
    for (const v of ['60', '60.5', '500']) {
      setMax(t, v);
      ok(`${v} GRIN: the note says it will be refused, and why`, /will be refused/.test(box(t).textContent)
        && /re-roll/.test(box(t).textContent) && box(t).className === 'giveaway-warning', box(t).textContent);
    }
    setMax(t, '59.999');
    ok('59.999 GRIN: no note', box(t).textContent === '' && box(t).className === '');

    const hi = await incentivesPage({ route: onSettingsGet(() => {
      const s = stored();
      s.incentives.daily_giveaway_max_grin = 75;
      return reply(200, { success: true, data: s });
    }) });
    hi.fire();
    await settle();
    ok('a stored value at the limit shows the note on load', /75 GRIN/.test(box(hi).textContent));

    const refused = await incentivesPage({ route: (url, o) => (o && o.method === 'POST' ? reply(400, { error: 'must be below 60 GRIN' }) : null) });
    refused.fire();
    await settle();
    refused.doc.querySelector('[data-action="save-section"]').click();
    await settle();
    ok('the server\'s refusal reaches the operator', refused.toasts.some((x) => x.kind === 'error' && /below 60 GRIN/.test(x.text)), JSON.stringify(refused.toasts));

    const src = fs.readFileSync(path.join(PANEL, 'js/settings-incentives.js'), 'utf8');
    const page = fs.readFileSync(path.join(PANEL, 'settings-incentives.html'), 'utf8');
    const reward = /BLOCK_REWARD_GRIN = (\d+)/.exec(src);
    ok('the page, the note and the server name the same block reward', reward
      && page.includes(`below ${reward[1]} GRIN (one block reward)`) && Number(reward[1]) === PoolSettings.GIVEAWAY_GRIN_LIMIT);
  }

  console.log('\n[7] Run a real draw now');
  {
    const RUN = '/api/admin/incentives/daily-giveaway/run';
    const savedLimits = (over = {}) => ({
      success: true, enabled: true, real_eligible: 0, pretend_miners: 0, prize_pool: 123.4567, days: [],
      rules: { min_grin: 10, max_grin: 50, min_winners: 1, max_winners: 3, min_active_hours: 6 }, ...over,
    });
    // The stored incentive defaults keep the prize limits at 1 to 3 and the hours at 6.
    const page = async (previewFn, opts = {}) => {
      const t = await incentivesPage({
        ...opts,
        route: (url, o) => {
          if (url === '/api/admin/settings' && opts.noSettings) return reply(500, {});
          if (url.startsWith('/api/admin/incentives/daily-giveaway/preview')) return previewFn(url);
          if (url === RUN) return reply(200, { success: true, result: { success: true, draw_id: 9, eligible: 3, seed_height: 1010 } });
          return null;
        },
      });
      t.fire();
      await settle();
      return t;
    };
    const press = async (t) => { t.doc.querySelector('[data-action="daily-run-now"]').click(); await settle(); };
    const ran = (t) => t.posts.some((p) => p.url === RUN);
    const out = (t) => t.doc.getElementById('daily-run-out').textContent;

    let asked = '';
    const t = await page((url) => { asked = url; return reply(200, savedLimits()); });
    await press(t);
    const text = t.confirms[0] || '';
    ok('it reads the saved values with no pretend miners', /[?&]extra_miners=0$/.test(asked), asked);
    ok('the confirm shows the total range and says it is random', /10 to 50 GRIN/.test(text) && /random amount inside this range/.test(text), text);
    ok('the confirm shows the prize count range', /Prizes: 1 to 3/.test(text), text);
    ok('the confirm shows the prize pool', /Prize pool now: 123\.4567 GRIN/.test(text), text);
    ok('the accurate text stays', /extra draw/.test(text) && /REAL miners only/.test(text) && /next hourly check/.test(text)
      && /does not replace the scheduled one/.test(text) && /cannot be undone/.test(text), text);
    ok('a form matching the saved values raises no unsaved note', !/UNSAVED/.test(text), text);
    ok('accepting runs the draw', ran(t));

    const e = await page(() => reply(200, savedLimits()));
    e.doc.getElementById('daily_giveaway_max_grin').value = '500';
    e.doc.getElementById('daily_giveaway_min_active_hours').value = '';
    e.doc.getElementById('daily_giveaway_enabled').checked = false;
    await press(e);
    const edited = e.confirms[0] || '';
    ok('an edited form is called out, with saved against shown', /UNSAVED CHANGES/.test(edited)
      && /Maximum per day: saved 50, form shows 500/.test(edited), edited);
    ok('a blank field counts as a difference', /Hours mined that day to qualify: saved 6, form shows \(blank\)/.test(edited), edited);
    ok('so does the on switch', /Giveaway switched on: saved yes, form shows no/.test(edited), edited);
    ok('and the figures shown are still the saved ones', /10 to 50 GRIN/.test(edited) && !/10 to 500/.test(edited), edited);

    const low = await page(() => reply(200, savedLimits({ prize_pool: 20 })));
    await press(low);
    ok('a pool below the maximum is stated', /never more than the prize pool/.test(low.confirms[0] || ''), low.confirms[0]);

    const fixed = await page(() => reply(200, savedLimits({
      rules: { min_grin: 2, max_grin: 2, min_winners: 3, max_winners: 3, min_active_hours: 6 },
    })));
    await press(fixed);
    ok('fixed limits read as one figure', /Total: 2 GRIN\n/.test(fixed.confirms[0] || '') && /Prizes: 3, shared equally/.test(fixed.confirms[0] || ''), fixed.confirms[0]);

    for (const [label, over, want] of [
      ['the giveaway saved off', { enabled: false }, /The giveaway is off/],
      ['a pool below the minimum', { prize_pool: 3 }, /less than your minimum/],
    ]) {
      const r = await page(() => reply(200, savedLimits(over)));
      await press(r);
      ok(`${label}: refused with no confirm`, r.confirms.length === 0 && !ran(r) && want.test(out(r)), out(r));
    }

    const unloaded = await page(() => reply(200, savedLimits()), { noSettings: true });
    await press(unloaded);
    ok('after a failed settings load the page defaults are not called unsaved edits',
      unloaded.confirms.length === 1 && !/UNSAVED/.test(unloaded.confirms[0]), unloaded.confirms[0]);

    const no = await page(() => reply(200, savedLimits()), { confirmAnswer: false });
    await press(no);
    ok('cancelling runs nothing', no.confirms.length === 1 && !ran(no));

    for (const [label, fn, want] of [
      ['HTTP 500', () => reply(500, { error: 'Failed to build the preview' }), /Failed to build the preview/],
      ['a dropped connection', () => { throw new TypeError('Failed to fetch'); }, /Failed to fetch/],
      ['saved limits that are not valid', () => reply(200, { success: false, reason: 'bad_rules' }), /not valid/],
      ['a reply with no figures', () => reply(200, { success: true }), /no limits/],
    ]) {
      const f = await page(fn);
      await press(f);
      ok(`${label}: no confirm, no draw, and #daily-run-out says why`,
        f.confirms.length === 0 && !ran(f) && /Nothing was drawn/.test(out(f)) && want.test(out(f)), out(f));
    }
  }

  console.log('\n[8] Preview shows real odds');
  {
    const addr = 'grin1' + 'abcdefghij'.repeat(5);
    const body = (over = {}) => ({
      success: true, enabled: true, pretend_miners: 0, prize_pool: 100, real_eligible: 7,
      rules: { min_grin: 1, max_grin: 5, min_winners: 1, max_winners: 3, min_active_hours: 6 },
      top_real: [{ address: addr, work_share: 0.9 }, { address: 'grin1tiny', work_share: 0.0004 }],
      days: [{ day: 1, winners: [{ address: addr, wins: 2 }], share_grin: 1, total_grin: 2, prize_pool_after: 98 }],
      ...over,
    });
    const show = async (b) => {
      let asked = '';
      const t = await incentivesPage({ route: (url) => {
        if (!url.startsWith('/api/admin/incentives/daily-giveaway/preview')) return null;
        asked = url;
        return reply(200, b);
      } });
      t.fire();
      await settle();
      t.doc.querySelector('[data-action="daily-preview"]').click();
      await settle();
      return { t, asked, text: t.doc.getElementById('daily-preview-out').textContent };
    };
    const { t, asked, text } = await show(body());
    const shown = addr.slice(0, 12) + '…' + addr.slice(-4);
    ok('the field defaults to no pretend miners', /extra_miners=0$/.test(asked), asked);
    ok('the field is labelled a capacity test that does not show real odds',
      /capacity test/i.test(t.doc.querySelector('label[for="daily-preview-extra"]').textContent)
      && /does not show real odds/.test(t.doc.getElementById('daily-preview-extra').parentElement.textContent));
    ok('it stays out of the settings harvest', t.doc.getElementById('daily-preview-extra').classList.contains('settings-skip'));
    ok('it shows how many real miners qualified, and that the share is the chance per prize',
      /7 real miners qualified/.test(text) && /chance of winning each prize/.test(text), text);
    ok('it uses the short address form with the share', text.includes(shown) && text.includes('90.0%') && !text.includes(addr), text);
    ok('a tiny share does not read as zero', text.includes('<0.1%'), text);
    ok('and says how many are not listed', text.includes('+5 more'), text);
    ok('the odds come above the simulated days', text.indexOf('Real odds') < text.indexOf('Day 1:') && text.indexOf('Real odds') >= 0, text);
    ok('no capacity note without pretend miners', !/capacity test/.test(text), text);
    const withPretend = await show(body({ pretend_miners: 20 }));
    ok('with pretend miners the days are labelled', /20 pretend miners/.test(withPretend.text) && /does not show real odds/.test(withPretend.text), withPretend.text);
    const none = await show(body({ real_eligible: 0, top_real: [], days: [] }));
    ok('with nobody qualified it says so', /no real odds to show/.test(none.text) && /Nobody qualified/.test(none.text), none.text);
    const hostile = await show(body({ top_real: [{ address: '<img src=x>', work_share: 1 }] }));
    ok('an address reaches the page as text, never as markup',
      hostile.t.doc.querySelectorAll('#daily-preview-out img').length === 0 && hostile.text.includes('<img src=x>'), hostile.text);
  }

  console.log('\n[9] Recent giveaway draws');
  {
    const DRAWS = '/api/admin/incentives/lottery/draws';
    const empty = () => reply(200, { success: true, draws: [], daily_status: { holds: {} } });
    const box = (t) => t.doc.getElementById('daily-draws');
    {
      const paid = { id: 2, draw_type: 'daily', status: 'paid', period_start: 86400, period_end: 172800, winners: [
        { grin_address: 'grin1aaaaaaaaaaaaaaaaaaaaaaaaaaaa', amount: 4, ticket_count: 2 },
        { grin_address: 'grin1bbbbbbbbbbbbbbbbbbbbbbbbbbbb', amount: 2, ticket_count: 1 },
      ] };
      const s = await incentivesPage({ route: (url) => (url === '/api/admin/incentives/lottery/draws'
        ? reply(200, { draws: [paid], daily_status: { last_skip: { at: 1, reason: 'already_drawn' } } }) : null) });
      s.fire();
      await settle();
      ok('a paid draw shows prizes against winners, with the repeat marked', /Paid 6\.0000 GRIN as 3 prizes to 2 winners/.test(box(s).textContent)
        && /×2/.test(box(s).textContent), box(s).textContent);
      ok('each skip reason reads as itself', /that day was already drawn/.test(box(s).textContent), box(s).textContent);
    }
    const onDraws = (fn) => (url) => (url === DRAWS ? fn() : null);
    ok('the element announces changes', (await incentivesPage()).doc.getElementById('daily-draws').getAttribute('role') === 'status');
    for (const [label, fn] of [
      ['HTTP 500', () => reply(500, {})],
      ['a 401', () => reply(401, {})],
      ['a dropped connection', () => { throw new TypeError('Failed to fetch'); }],
      ['a 200 that is not JSON', () => reply(200)],
      ['a draw the page cannot read', () => reply(200, { draws: [{ id: 1, draw_type: 'daily', status: 'paid', period_start: 0, period_end: 0 }] })],
    ]) {
      const t = await incentivesPage({ route: onDraws(fn) });
      t.fire();
      await settle();
      ok(`${label}: says it failed, and offers a retry`,
        /^Could not load draws\./.test(box(t).textContent) && !/Loading/.test(box(t).textContent)
        && !!t.doc.querySelector('#daily-draws button[data-action="daily-refresh"]'), box(t).textContent);
    }
    const none = await incentivesPage({ route: onDraws(empty) });
    none.fire();
    await settle();
    ok('an empty history reads as empty, not failed', box(none).textContent === 'No giveaway draws yet.', box(none).textContent);

    let mode = 'down', release = null, signal = null;
    const t = await incentivesPage({ route: async (url, o) => {
      if (url !== DRAWS) return null;
      signal = o && o.signal;
      if (release) await release;
      return mode === 'down' ? reply(500, {}) : empty();
    } });
    t.fire();
    await settle();
    ok('the read cannot hang for good', signal instanceof AbortSignal);
    {
      const signals = {};
      const s = await incentivesPage({ route: (url, o) => { signals[url] = o && o.signal; return null; } });
      s.fire();
      await settle();
      ok('neither can the settings or prize pool read', signals['/api/admin/settings'] instanceof AbortSignal
        && signals['/api/admin/incentives/prize-pool'] instanceof AbortSignal);
    }
    {
      // Two loads overlap and the older one answers last, for each way it can answer.
      const draw = (status) => ({ id: 1, draw_type: 'daily', status, period_start: 86400, period_end: 172800, seed_height: 5, winners: status === 'paid' ? [{ grin_address: 'grin1a', amount: 2, ticket_count: 2 }] : [] });
      for (const [label, older] of [
        ['an older list', () => reply(200, { draws: [draw('committed')] })],
        ['an older failure', () => reply(500, {})],
      ]) {
        const held = [];
        let armed = false;
        const s = await incentivesPage({ route: (url) => {
          if (url !== '/api/admin/incentives/lottery/draws' || !armed) return null;
          return new Promise((resolve) => held.push(resolve));
        } });
        armed = false;
        s.fire();
        await settle();
        armed = true;
        s.call('loadIncentiveData()');
        await settle();
        s.call('loadIncentiveData()');
        await settle();
        held[1](reply(200, { draws: [draw('paid')] }));
        await settle();
        held[0](older());
        await settle();
        ok(`${label} landing last does not replace the newer one`, /Paid 2\.0000 GRIN/.test(box(s).textContent), box(s).textContent);
      }
    }
    mode = 'up';
    let open;
    release = new Promise((r) => { open = r; });
    t.doc.querySelector('#daily-draws button').click();
    await settle();
    ok('the retry shows it is working', box(t).textContent === 'Loading…', box(t).textContent);
    open();
    release = null;
    await settle();
    ok('and a retry that works shows the real answer', box(t).textContent === 'No giveaway draws yet.', box(t).textContent);
    mode = 'down';
    t.doc.querySelector('[data-action="daily-refresh"]').click();
    await settle();
    ok('Refresh on a dropped API shows the failure, not the old list', /^Could not load draws\./.test(box(t).textContent), box(t).textContent);

    const f = await incentivesPage({ route: (url, o) => {
      if (url === '/api/admin/settings' && isGet(o)) return reply(500, {});
      return url === DRAWS ? empty() : null;
    } });
    f.fire();
    await settle();
    ok('a failed settings load does not strand the draws on Loading', box(f).textContent === 'No giveaway draws yet.', box(f).textContent);
  }

  console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
