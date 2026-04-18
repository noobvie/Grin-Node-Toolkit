// theme.js — Theme switcher, persists to localStorage

const THEMES = ["matrix", "warcraft", "win98", "light", "dark", "cute"];
const THEME_CSS = {
  matrix:  "css/themes/matrix.css",
  warcraft:"css/themes/warcraft.css",
  win98:   "css/themes/win98.css",
  light:   "css/themes/light.css",
  dark:    "css/themes/dark.css",
  cute:    "css/themes/cute.css",
};
const THEME_LOGO = {
  matrix:  "img/grin-logo-lime.svg",
  warcraft:"img/grin-logo-purple.svg",
  win98:   "img/grin-logo-gray.svg",
  light:   "img/grin-logo-gold.svg",
  dark:    "img/grin-logo-lime.svg",
  cute:    "img/grin-logo-pink.svg",
};
const STORAGE_KEY = "grin-faucet-theme";
let _current = null;

// Apply CSS + logo early (before DOMContentLoaded) to avoid flash of wrong theme/logo.
(function() {
  const link = document.getElementById("theme-css");
  const saved = localStorage.getItem(STORAGE_KEY) || "matrix";
  if (link && THEME_CSS[saved]) link.href = THEME_CSS[saved];
  // Logo swap runs after DOM is parsed — img element not available yet.
  // initTheme() handles it on DOMContentLoaded.
})();

function applyTheme(name) {
  if (!THEMES.includes(name)) name = "matrix";
  _current = name;
  localStorage.setItem(STORAGE_KEY, name);

  document.body.className = document.body.className
    .replace(/\btheme-\S+/g, "")
    .trim();
  document.body.classList.add("theme-" + name);

  // Swap CSS file
  const link = document.getElementById("theme-css");
  if (link && THEME_CSS[name]) link.href = THEME_CSS[name];

  // Swap logo
  const logo = document.querySelector(".site-logo");
  if (logo && THEME_LOGO[name]) logo.src = THEME_LOGO[name];

  // Matrix rain
  if (name === "matrix") {
    if (window.MatrixRain) MatrixRain.init();
  } else {
    if (window.MatrixRain) MatrixRain.destroy();
  }

  // Sync all theme buttons active state
  document.querySelectorAll("[data-theme]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.theme === name);
  });
}

function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY) || "matrix";
  applyTheme(saved);

  // Theme button clicks
  document.querySelectorAll("[data-theme]").forEach(btn => {
    btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
  });

  // Paint-icon dropdown toggle
  const toggleBtn = document.getElementById("theme-toggle-btn");
  const dropdown  = document.getElementById("theme-dropdown");
  if (toggleBtn && dropdown) {
    toggleBtn.addEventListener("click", e => {
      e.stopPropagation();
      const nowOpen = dropdown.hidden;
      dropdown.hidden = !nowOpen;
      toggleBtn.setAttribute("aria-expanded", String(nowOpen));
      toggleBtn.classList.toggle("open", nowOpen);
    });
    // Close on outside click
    document.addEventListener("click", () => {
      dropdown.hidden = true;
      toggleBtn.setAttribute("aria-expanded", "false");
      toggleBtn.classList.remove("open");
    });
    // Close after a theme is picked
    dropdown.addEventListener("click", () => {
      dropdown.hidden = true;
      toggleBtn.setAttribute("aria-expanded", "false");
      toggleBtn.classList.remove("open");
    });
  }
}

document.addEventListener("DOMContentLoaded", initTheme);
