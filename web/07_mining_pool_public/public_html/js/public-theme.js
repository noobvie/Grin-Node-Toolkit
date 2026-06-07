// public-theme.js — site-wide theme switcher for the public pool pages.
//
// Themes are applied by toggling a class on <body>:
//   · dark    → (no class; the inline :root default)
//   · light   → body.light-theme        (built-in inline styles)
//   · atomic  → body.atomic-theme        (built-in inline styles)
//   · the 10 extras → body.<name>-theme + body.themed   (styled in /css/themes.css)
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

  // group: shown as an <optgroup>. builtin themes keep their existing inline CSS.
  var THEMES = [
    { key: 'dark',      label: 'Dark',          group: 'Classic',  builtin: true },
    { key: 'light',     label: 'Light',         group: 'Classic',  builtin: true },
    { key: 'atomic',    label: 'Atomic',        group: 'Classic',  builtin: true },
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

  // Every class this module might add — used to fully clear before applying.
  function allThemeClasses() {
    var classes = ['light-theme', 'atomic-theme', 'themed'];
    KEYS.forEach(function (k) {
      if (k !== 'dark' && k !== 'light' && k !== 'atomic') classes.push(k + '-theme');
    });
    return classes;
  }

  // Which body classes a given theme key needs.
  function classesFor(key) {
    if (key === 'dark') return [];
    if (key === 'light') return ['light-theme'];
    if (key === 'atomic') return ['atomic-theme'];
    return [key + '-theme', 'themed'];
  }

  function isKnown(key) { return KEYS.indexOf(key) !== -1; }

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
    if (!body) return 'dark';
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i];
      if (k === 'dark') continue;
      if (body.classList.contains(k + '-theme')) return k;
    }
    return 'dark';
  }

  function applyTheme(key, persist) {
    if (!isKnown(key)) key = 'dark';
    var body = document.body;
    if (!body) return;

    allThemeClasses().forEach(function (c) { body.classList.remove(c); });
    classesFor(key).forEach(function (c) { body.classList.add(c); });

    var select = document.getElementById('grinium-theme-select');
    if (select && isKnown(select.value) && hasOption(select, key)) select.value = key;

    if (persist) setSaved(key);
  }

  function hasOption(select, key) {
    return !!select.querySelector('option[value="' + key + '"]');
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

  // Build a grouped <select> containing ONLY the given enabled keys (in THEMES order).
  function buildSwitcher(enabledKeys) {
    var container = getContainer(true);
    if (!container) return;
    container.style.display = '';
    container.innerHTML = '';

    var select = document.createElement('select');
    select.id = 'grinium-theme-select';
    select.className = 'theme-select';
    select.setAttribute('aria-label', 'Choose colour theme');

    var groups = {};
    var order = [];
    THEMES.forEach(function (t) {
      if (enabledKeys.indexOf(t.key) === -1) return;
      if (!groups[t.group]) { groups[t.group] = []; order.push(t.group); }
      groups[t.group].push(t);
    });
    order.forEach(function (groupName) {
      var og = document.createElement('optgroup');
      og.label = groupName;
      groups[groupName].forEach(function (t) {
        var opt = document.createElement('option');
        opt.value = t.key;
        opt.textContent = t.label;
        og.appendChild(opt);
      });
      select.appendChild(og);
    });

    select.addEventListener('change', function () {
      applyTheme(select.value, true);
    });

    container.appendChild(select);
  }

  function hideSwitcher() {
    var container = getContainer(false);
    if (container) { container.innerHTML = ''; container.style.display = 'none'; }
  }

  // Called by branding.js once the operator config is fetched.
  // enabledThemes: array of theme keys the operator allows visitors to switch between.
  function applyDefault(defaultTheme, allowSwitch, enabledThemes) {
    var def = isKnown(defaultTheme) ? defaultTheme : 'dark';

    // Normalise the enabled list: known keys only, de-duped, in THEMES order.
    var enabled = [];
    if (Array.isArray(enabledThemes)) {
      KEYS.forEach(function (k) {
        if (enabledThemes.indexOf(k) !== -1 && enabled.indexOf(k) === -1) enabled.push(k);
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
