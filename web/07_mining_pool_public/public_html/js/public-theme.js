// public-theme.js — site-wide theme switcher for the public pool pages.
//
// Themes are applied by toggling a class on <body>:
//   · atomic  → (no class; the inline :root default — mockup-v3 uranium-lime)
//   · everything else → body.<name>-theme + body.themed  (styled in /css/themes.css)
// The legacy key 'dark' (the retired cyan default) is normalised to 'atomic' so
// old localStorage picks and stored operator configs keep working. The old
// dark/atomic/light looks live on in the ADMIN panel registry (js/theme.js) as
// Cyber Classic / Atomic Classic / Gradient Light.
//
// WHAT VISITORS SEE IS OPERATOR-CONTROLLED. The admin panel exposes:
//   · default_theme        — the look applied first
//   · allow_theme_switch   — master on/off for the public switcher
//   · enabled_themes        — the curated list visitors may switch between
// branding.js fetches these and calls GriniumTheme.applyDefault(). The rules:
//   · switching off, or ≤1 enabled theme → NO switcher; default_theme is forced.
//   · 2+ enabled themes → a <select> limited to exactly those is shown.
// A visitor's own pick is remembered in localStorage('grinium-theme') and honoured
// as long as it is still in the enabled list.
//
// Defensive throughout: nothing here throws to the page.

(function () {
  'use strict';

  var STORAGE_KEY = 'grinium-theme';

  // group: shown as an <optgroup>. 'atomic' is the inline no-class default.
  var THEMES = [
    { key: 'atomic',    label: 'Atomic ⚛',      group: 'Classic',  builtin: true },
    { key: 'nexus',     label: 'Nexus',         group: 'Classic' },
    { key: 'light',     label: 'Light',         group: 'Classic' },
    { key: 'winter',    label: 'Winter Frost ❄️',   group: 'Seasonal' },
    { key: 'spring',    label: 'Spring Blossom 🌸', group: 'Seasonal' },
    { key: 'summer',    label: 'Summer Wave 🌊',    group: 'Seasonal' },
    { key: 'autumn',    label: 'Autumn Harvest 🍂', group: 'Seasonal' },
    { key: 'halloween', label: 'Halloween 🎃',      group: 'Seasonal' },
    { key: 'christmas', label: 'Christmas 🎄',      group: 'Seasonal' },
    { key: 'galaxy',    label: 'Galaxy ⭐',         group: 'Fun' },
    { key: 'winxp',     label: 'Windows XP 🪟',     group: 'Fun' },
    { key: 'aqua',      label: 'macOS Aqua 🍎',     group: 'Fun' },
    { key: 'comic',     label: 'Comic Pop 💥',      group: 'Fun' }
  ];

  var KEYS = THEMES.map(function (t) { return t.key; });
  var BY_KEY = {};
  THEMES.forEach(function (t) { BY_KEY[t.key] = t; });

  // Retired key from the pre-mockup era → its modern equivalent.
  function normalizeKey(key) { return key === 'dark' ? 'atomic' : key; }

  // Every class this module might add — used to fully clear before applying.
  // 'atomic-theme'/'dark-theme' are stale classes from older releases.
  function allThemeClasses() {
    var classes = ['atomic-theme', 'dark-theme', 'themed'];
    KEYS.forEach(function (k) {
      if (k !== 'atomic') classes.push(k + '-theme');
    });
    return classes;
  }

  // Which body classes a given theme key needs.
  function classesFor(key) {
    if (key === 'atomic') return []; // the inline no-class default
    return [key + '-theme', 'themed'];
  }

  function isKnown(key) { return KEYS.indexOf(normalizeKey(key)) !== -1; }

  function getSaved() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }
  function setSaved(key) {
    try { localStorage.setItem(STORAGE_KEY, key); } catch (e) {}
  }

  // Read the theme currently expressed on <body> (so we can stay in sync if some
  // other code, e.g. branding.js, set a class before we initialised).
  function currentFromBody() {
    var body = document.body;
    if (!body) return 'atomic';
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i];
      if (k === 'atomic') continue;
      if (body.classList.contains(k + '-theme')) return k;
    }
    return 'atomic';
  }

  function applyTheme(key, persist) {
    key = normalizeKey(key);
    if (!isKnown(key)) key = 'atomic';
    var body = document.body;
    if (!body) return;

    allThemeClasses().forEach(function (c) { body.classList.remove(c); });
    classesFor(key).forEach(function (c) { body.classList.add(c); });

    updateCycleButton(key);

    if (persist) setSaved(key);
  }

  function labelFor(key) { return (BY_KEY[key] && BY_KEY[key].label) || key; }

  // Keep the palette button's tooltip/aria in sync with the active theme.
  function updateCycleButton(key) {
    var btn = document.getElementById('grinium-theme-cycle');
    if (!btn) return;
    btn.setAttribute('aria-label', 'Theme: ' + labelFor(key) + ' — click to switch');
    btn.title = labelFor(key);
  }

  function getContainer(create) {
    var container = document.querySelector('.theme-switcher');
    if (!container && create) {
      container = document.createElement('div');
      container.className = 'theme-switcher';
      // Minimal fixed placement for pages that never had a switcher (login, etc.).
      container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:9999;' +
        'display:flex;align-items:center;padding:6px 8px;border-radius:50px;' +
        'background:rgba(0,0,0,.55);border:1px solid currentColor;';
      document.body.appendChild(container);
    }
    return container;
  }

  // The set of themes the cycle button rotates through (enabled keys, THEMES order).
  var enabledOrder = [];

  // Render the theme control as a single palette icon. Clicking it advances to the next
  // enabled theme (no dropdown) — the operator asked for "just a paint icon, click to
  // switch". Direct jump-to-a-specific-theme is intentionally dropped in favour of this
  // compact, mobile-friendly control. The enabled list still comes from the admin config.
  function buildSwitcher(enabledKeys) {
    enabledOrder = enabledKeys.slice();
    var container = getContainer(true);
    if (!container) return;
    container.style.display = '';
    container.innerHTML = '';

    var btn = document.createElement('button');
    btn.id = 'grinium-theme-cycle';
    btn.type = 'button';
    btn.className = 'theme-cycle-btn';
    btn.innerHTML = '<span class="theme-cycle-ico" aria-hidden="true">🎨</span>';
    btn.addEventListener('click', cycleTheme);
    container.appendChild(btn);

    updateCycleButton(currentFromBody());
  }

  // Advance to the next enabled theme, wrapping around.
  function cycleTheme() {
    if (enabledOrder.length < 2) return;
    var cur = currentFromBody();
    var i = enabledOrder.indexOf(cur);
    var next = enabledOrder[(i + 1) % enabledOrder.length];
    applyTheme(next, true);
  }

  function hideSwitcher() {
    var container = getContainer(false);
    if (container) { container.innerHTML = ''; container.style.display = 'none'; }
  }

  // Called by branding.js once the operator config is fetched.
  // enabledThemes: array of theme keys the operator allows visitors to switch between.
  function applyDefault(defaultTheme, allowSwitch, enabledThemes) {
    var def = isKnown(defaultTheme) ? normalizeKey(defaultTheme) : 'atomic';

    // Normalise the enabled list: known keys only (legacy 'dark' → 'atomic'),
    // de-duped, in THEMES order.
    var enabled = [];
    if (Array.isArray(enabledThemes)) {
      var wanted = enabledThemes.map(normalizeKey);
      KEYS.forEach(function (k) {
        if (wanted.indexOf(k) !== -1 && enabled.indexOf(k) === -1) enabled.push(k);
      });
    }

    // No switcher: either disabled by the operator, or nothing meaningful to choose.
    if (!allowSwitch || enabled.length <= 1) {
      hideSwitcher();
      // With switching off, the operator default wins; with exactly one enabled
      // theme, that single theme wins.
      var forced = (!allowSwitch) ? def : (enabled.length === 1 ? enabled[0] : def);
      applyTheme(forced, false);
      return;
    }

    // Switcher: limited to the enabled themes.
    buildSwitcher(enabled);

    // Honour a saved pick if it is still permitted, else fall back to the default
    // (when the default is itself enabled) or the first enabled theme.
    var saved = getSaved();
    if (saved) saved = normalizeKey(saved);
    var initial;
    if (saved && enabled.indexOf(saved) !== -1) initial = saved;
    else if (enabled.indexOf(def) !== -1) initial = def;
    else initial = enabled[0];

    applyTheme(initial, false);
  }

  // Before branding resolves we don't yet know the operator's enabled list, so we
  // only apply the saved/current look and keep any placeholder switcher hidden to
  // avoid a flash of the wrong options.
  function init() {
    var container = getContainer(false);
    if (container) { container.innerHTML = ''; container.style.display = 'none'; }

    var saved = getSaved();
    var initial = (saved && isKnown(saved)) ? saved : currentFromBody();
    applyTheme(initial, false);
  }

  window.GriniumTheme = {
    applyTheme: applyTheme,
    applyDefault: applyDefault,
    themes: THEMES
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
