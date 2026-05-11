// theme.js — Theme switcher, persists to localStorage

const THEMES = ['dark', 'light', 'neon', 'matrix'];
const THEME_CSS = {
  dark:   'css/themes/dark.css',
  light:  'css/themes/light.css',
  neon:   'css/themes/neon.css',
  matrix: 'css/themes/matrix.css',
};
const THEME_LABELS = { dark: '🌑 Dark', light: '☀️ Light', neon: '⚡ Neon', matrix: '🟢 Matrix' };
// Single key — no network suffix. Mainnet/testnet are on different origins so
// localStorage is already partitioned; the suffix was redundant and caused
// wrong-key lookups when GRINSCAN_NETWORK was momentarily undefined.
const STORAGE_KEY = 'grinscan-theme';

function _defaultTheme() {
  return window.GRINSCAN_NETWORK === 'mainnet' ? 'neon' : 'matrix';
}

// Apply theme CSS early — called immediately (before DOMContentLoaded) to avoid FOUC.
(function () {
  const link = document.getElementById('theme-css');
  const saved = localStorage.getItem(STORAGE_KEY) || _defaultTheme();
  if (link && THEME_CSS[saved]) link.href = THEME_CSS[saved];
})();

function applyTheme(name) {
  if (!THEMES.includes(name)) name = _defaultTheme();
  localStorage.setItem(STORAGE_KEY, name);
  const link = document.getElementById('theme-css');
  if (link && THEME_CSS[name]) link.href = THEME_CSS[name];
  document.querySelectorAll('[data-theme]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === name);
  });
  const lbl = document.getElementById('theme-current-label');
  if (lbl) lbl.textContent = THEME_LABELS[name] || name;
}

function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY) || _defaultTheme();
  applyTheme(saved);

  document.querySelectorAll('[data-theme]').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });

  const toggleBtn = document.getElementById('theme-toggle-btn');
  const dropdown  = document.getElementById('theme-dropdown');
  if (toggleBtn && dropdown) {
    toggleBtn.addEventListener('click', e => {
      e.stopPropagation();
      const open = dropdown.hidden;
      dropdown.hidden = !open;
      toggleBtn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', () => {
      dropdown.hidden = true;
      toggleBtn.setAttribute('aria-expanded', 'false');
    });
    dropdown.addEventListener('click', () => {
      dropdown.hidden = true;
      toggleBtn.setAttribute('aria-expanded', 'false');
    });
  }
}

document.addEventListener('DOMContentLoaded', initTheme);
