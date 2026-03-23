// theme.js — Theme switcher, persists to localStorage
// Themes: matrix | warcraft | win98

const THEMES = ["matrix", "warcraft", "win98"];
const STORAGE_KEY = "grin-faucet-theme";
let _current = null;

function applyTheme(name) {
  if (!THEMES.includes(name)) name = "matrix";
  _current = name;
  localStorage.setItem(STORAGE_KEY, name);

  document.body.className = document.body.className
    .replace(/\btheme-\S+/g, "")
    .trim();
  document.body.classList.add("theme-" + name);

  // Matrix rain
  if (name === "matrix") {
    if (window.MatrixRain) MatrixRain.init();
  } else {
    if (window.MatrixRain) MatrixRain.destroy();
  }

  // Sync selector if present
  const sel = document.getElementById("theme-select");
  if (sel) sel.value = name;

  // Sync all theme buttons
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

  // Select fallback
  const sel = document.getElementById("theme-select");
  if (sel) sel.addEventListener("change", e => applyTheme(e.target.value));
}

document.addEventListener("DOMContentLoaded", initTheme);
