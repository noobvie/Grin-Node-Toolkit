// theme.js — Theme switcher with 5 themes, persists to localStorage
// Themes: matrix | dark | light | naruto | japan

const THEMES = ['matrix', 'dark', 'light', 'naruto', 'japan'];
const STORAGE_KEY = 'grin-pool-theme';

const THEME_CSS = {
  matrix: '/css/themes/matrix.css',
  dark:   '/css/themes/dark.css',
  light:  '/css/themes/light.css',
  naruto: '/css/themes/naruto.css',
  japan:  '/css/themes/japan.css',
};

let _current = null;

function applyTheme(name) {
  if (!THEMES.includes(name)) name = 'matrix';
  _current = name;
  localStorage.setItem(STORAGE_KEY, name);

  // Swap body class
  document.body.className = document.body.className
    .replace(/\btheme-\S+/g, '')
    .trim();
  document.body.classList.add('theme-' + name);

  // Swap theme stylesheet
  const link = document.getElementById('theme-css');
  if (link) link.href = THEME_CSS[name] || THEME_CSS.matrix;

  // Matrix rain
  if (name === 'matrix') {
    if (window.MatrixRain) MatrixRain.init();
  } else {
    if (window.MatrixRain) MatrixRain.destroy();
  }

  // Sakura petals
  if (name === 'japan') {
    if (window.SakuraRain) SakuraRain.init();
  } else {
    if (window.SakuraRain) SakuraRain.destroy();
  }

  // Sync all theme buttons
  document.querySelectorAll('[data-theme]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === name);
  });
}

function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY) || 'matrix';
  applyTheme(saved);

  document.querySelectorAll('[data-theme]').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });
}

document.addEventListener('DOMContentLoaded', initTheme);
