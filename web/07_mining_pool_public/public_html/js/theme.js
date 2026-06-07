// Theme switcher module for the admin panel — CSS-variable theme registry.
// Built-in: Matrix, Dark, Light, Naruto, Japan. Plus 10 white-label themes
// (Winter/Spring/Summer/Autumn/Halloween/Christmas/Galaxy/Windows XP/Aqua/Comic)
// that mirror the public-page themes in /css/themes.css so operator default_theme
// looks consistent across the public site and the admin panel.
// All admin-panel/*.html pages reference <script src="/js/theme.js">.

const ThemeSwitcher = {
  STORAGE_KEY: 'admin-theme',
  DEFAULT_THEME: 'dark',

  // Theme color definitions (CSS variables)
  themes: {
    matrix: {
      name: 'Matrix',
      'primary': '#00ff00',
      'secondary': '#00ff00',
      'accent': '#00ff00',
      'bg-body': '#0a0a0a',
      'bg-card': '#1a1a1a',
      'bg-card2': '#0f0f0f',
      'border-color': '#00ff00',
      'text': '#00ff00',
      'text-dim': '#008800',
      'text-muted': '#004400',
      'btn-bg': '#003300',
      'btn-text': '#00ff00',
      'btn-hover': '#005500',
      'error-color': '#ff0000',
      'ok-color': '#00ff00',
      'warn-color': '#ffff00',
      'input-bg': '#111111',
      'input-border': '#00ff00'
    },
    dark: {
      name: 'Dark',
      'primary': '#667eea',
      'secondary': '#764ba2',
      'accent': '#f093fb',
      'bg-body': '#0f1419',
      'bg-card': '#1a1f29',
      'bg-card2': '#252d3d',
      'border-color': '#2d3748',
      'text': '#e0e0e0',
      'text-dim': '#a0aec0',
      'text-muted': '#718096',
      'btn-bg': '#667eea',
      'btn-text': '#ffffff',
      'btn-hover': '#5568d3',
      'error-color': '#f56565',
      'ok-color': '#48bb78',
      'warn-color': '#ed8936',
      'input-bg': '#2d3748',
      'input-border': '#4a5568'
    },
    light: {
      name: 'Light',
      'primary': '#667eea',
      'secondary': '#764ba2',
      'accent': '#f093fb',
      'bg-body': '#ffffff',
      'bg-card': '#f7fafc',
      'bg-card2': '#edf2f7',
      'border-color': '#cbd5e0',
      'text': '#2d3748',
      'text-dim': '#4a5568',
      'text-muted': '#718096',
      'btn-bg': '#667eea',
      'btn-text': '#ffffff',
      'btn-hover': '#5568d3',
      'error-color': '#e53e3e',
      'ok-color': '#38a169',
      'warn-color': '#d69e2e',
      'input-bg': '#f7fafc',
      'input-border': '#cbd5e0'
    },
    naruto: {
      name: 'Naruto',
      'primary': '#ff6b35',
      'secondary': '#004e89',
      'accent': '#f77f00',
      'bg-body': '#0f0f0f',
      'bg-card': '#1a1a1a',
      'bg-card2': '#252525',
      'border-color': '#ff6b35',
      'text': '#ffffff',
      'text-dim': '#cccccc',
      'text-muted': '#999999',
      'btn-bg': '#ff6b35',
      'btn-text': '#000000',
      'btn-hover': '#ff8555',
      'error-color': '#ff3333',
      'ok-color': '#33ff33',
      'warn-color': '#ffff00',
      'input-bg': '#2a2a2a',
      'input-border': '#ff6b35'
    },
    japan: {
      name: 'Japan ✿',
      'primary': '#d4145a',
      'secondary': '#fbb03b',
      'accent': '#009245',
      'bg-body': '#fff8f0',
      'bg-card': '#fffbf7',
      'bg-card2': '#faf5f0',
      'border-color': '#f5e6d3',
      'text': '#2c2c2c',
      'text-dim': '#5a5a5a',
      'text-muted': '#888888',
      'btn-bg': '#d4145a',
      'btn-text': '#ffffff',
      'btn-hover': '#c10050',
      'error-color': '#e74c3c',
      'ok-color': '#27ae60',
      'warn-color': '#f39c12',
      'input-bg': '#ffffff',
      'input-border': '#e8dcc8'
    },
    winter: {
      name: 'Winter Frost ❄️',
      'primary': '#8fd3ff', 'secondary': '#15486e', 'accent': '#8fd3ff',
      'bg-body': '#0b1d33', 'bg-card': '#102a45', 'bg-card2': '#163a5c',
      'border-color': '#27557d', 'text': '#dff3ff', 'text-dim': '#8fb6cf', 'text-muted': '#5f87a3',
      'btn-bg': '#8fd3ff', 'btn-text': '#06243d', 'btn-hover': '#bfe9ff',
      'error-color': '#ff6b6b', 'ok-color': '#7be0c0', 'warn-color': '#ffd166',
      'input-bg': '#102a45', 'input-border': '#27557d'
    },
    spring: {
      name: 'Spring Blossom 🌸',
      'primary': '#ff6f9c', 'secondary': '#7bc47f', 'accent': '#ff6f9c',
      'bg-body': '#fff5f8', 'bg-card': '#ffffff', 'bg-card2': '#ffeef4',
      'border-color': '#f3cdda', 'text': '#3a2b33', 'text-dim': '#8a6b78', 'text-muted': '#b09aa3',
      'btn-bg': '#ff6f9c', 'btn-text': '#ffffff', 'btn-hover': '#e85a87',
      'error-color': '#e74c3c', 'ok-color': '#5cae6a', 'warn-color': '#f39c12',
      'input-bg': '#ffffff', 'input-border': '#f3cdda'
    },
    summer: {
      name: 'Summer Wave 🌊',
      'primary': '#0891b2', 'secondary': '#f97316', 'accent': '#0891b2',
      'bg-body': '#f0fbff', 'bg-card': '#ffffff', 'bg-card2': '#dff6fb',
      'border-color': '#a9e4ef', 'text': '#063b46', 'text-dim': '#4f8593', 'text-muted': '#84b3bf',
      'btn-bg': '#0891b2', 'btn-text': '#ffffff', 'btn-hover': '#0e7490',
      'error-color': '#e74c3c', 'ok-color': '#22c55e', 'warn-color': '#f97316',
      'input-bg': '#ffffff', 'input-border': '#a9e4ef'
    },
    autumn: {
      name: 'Autumn Harvest 🍂',
      'primary': '#f59e0b', 'secondary': '#ea580c', 'accent': '#f59e0b',
      'bg-body': '#1c1206', 'bg-card': '#2a1c0c', 'bg-card2': '#3a2710',
      'border-color': '#5c3d18', 'text': '#f3e2c7', 'text-dim': '#c69d6e', 'text-muted': '#9a7647',
      'btn-bg': '#f59e0b', 'btn-text': '#2a1402', 'btn-hover': '#ea580c',
      'error-color': '#ef4444', 'ok-color': '#84cc16', 'warn-color': '#fbbf24',
      'input-bg': '#2a1c0c', 'input-border': '#5c3d18'
    },
    halloween: {
      name: 'Halloween 🎃',
      'primary': '#ff7518', 'secondary': '#7c3aed', 'accent': '#ff7518',
      'bg-body': '#0d0717', 'bg-card': '#170d28', 'bg-card2': '#22143a',
      'border-color': '#4b2a73', 'text': '#f4e9ff', 'text-dim': '#a98fc4', 'text-muted': '#7a619a',
      'btn-bg': '#ff7518', 'btn-text': '#1a0a00', 'btn-hover': '#ff8f45',
      'error-color': '#ff4d4d', 'ok-color': '#9bff66', 'warn-color': '#ffb703',
      'input-bg': '#170d28', 'input-border': '#4b2a73'
    },
    christmas: {
      name: 'Christmas 🎄',
      'primary': '#e63946', 'secondary': '#2f9e44', 'accent': '#e63946',
      'bg-body': '#0a1f14', 'bg-card': '#0f2b1c', 'bg-card2': '#153a26',
      'border-color': '#1f5236', 'text': '#f1f7f0', 'text-dim': '#9cc3a6', 'text-muted': '#6f9b7d',
      'btn-bg': '#e63946', 'btn-text': '#ffffff', 'btn-hover': '#c92d3a',
      'error-color': '#ff5a5a', 'ok-color': '#2f9e44', 'warn-color': '#ffd700',
      'input-bg': '#0f2b1c', 'input-border': '#1f5236'
    },
    galaxy: {
      name: 'Galaxy ⭐',
      'primary': '#ffe81f', 'secondary': '#3b82f6', 'accent': '#ffe81f',
      'bg-body': '#04060f', 'bg-card': '#0a0f1f', 'bg-card2': '#111933',
      'border-color': '#23335c', 'text': '#cfe3ff', 'text-dim': '#7e93b8', 'text-muted': '#566685',
      'btn-bg': '#ffe81f', 'btn-text': '#0a0a0a', 'btn-hover': '#ffd000',
      'error-color': '#ff5d5d', 'ok-color': '#5eead4', 'warn-color': '#fbbf24',
      'input-bg': '#0a0f1f', 'input-border': '#23335c'
    },
    winxp: {
      name: 'Windows XP 🪟',
      'primary': '#245edb', 'secondary': '#73d216', 'accent': '#245edb',
      'bg-body': '#3a6ea5', 'bg-card': '#ffffff', 'bg-card2': '#eef3fb',
      'border-color': '#9db8d2', 'text': '#1a1a1a', 'text-dim': '#4a5568', 'text-muted': '#7a8aa0',
      'btn-bg': '#245edb', 'btn-text': '#ffffff', 'btn-hover': '#1c4cb8',
      'error-color': '#d32f2f', 'ok-color': '#73d216', 'warn-color': '#f5a623',
      'input-bg': '#ffffff', 'input-border': '#9db8d2'
    },
    aqua: {
      name: 'macOS Aqua 🍎',
      'primary': '#0a84ff', 'secondary': '#34c759', 'accent': '#0a84ff',
      'bg-body': '#ececec', 'bg-card': '#ffffff', 'bg-card2': '#f5f5f7',
      'border-color': '#d2d2d7', 'text': '#1d1d1f', 'text-dim': '#6e6e73', 'text-muted': '#9a9aa0',
      'btn-bg': '#0a84ff', 'btn-text': '#ffffff', 'btn-hover': '#0060df',
      'error-color': '#ff3b30', 'ok-color': '#34c759', 'warn-color': '#ff9500',
      'input-bg': '#ffffff', 'input-border': '#d2d2d7'
    },
    comic: {
      name: 'Comic Pop 💥',
      'primary': '#e63946', 'secondary': '#1d4ed8', 'accent': '#e63946',
      'bg-body': '#fff3bf', 'bg-card': '#ffffff', 'bg-card2': '#fff8db',
      'border-color': '#1a1a1a', 'text': '#1a1a1a', 'text-dim': '#5a4a2a', 'text-muted': '#8a7a4a',
      'btn-bg': '#e63946', 'btn-text': '#ffffff', 'btn-hover': '#1d4ed8',
      'error-color': '#e63946', 'ok-color': '#16a34a', 'warn-color': '#f59e0b',
      'input-bg': '#ffffff', 'input-border': '#1a1a1a'
    }
  },

  // Initialize theme system and load saved theme
  init: () => {
    const savedTheme = localStorage.getItem(ThemeSwitcher.STORAGE_KEY) || ThemeSwitcher.DEFAULT_THEME;
    ThemeSwitcher.applyTheme(savedTheme);

    // Setup theme switcher buttons if they exist
    const themeButtons = document.querySelectorAll('[data-theme]');
    themeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const theme = btn.getAttribute('data-theme');
        ThemeSwitcher.applyTheme(theme);
      });
    });
  },

  // Apply theme by setting CSS variables
  applyTheme: (themeName) => {
    if (!ThemeSwitcher.themes[themeName]) {
      console.warn(`Theme '${themeName}' not found, using default`);
      themeName = ThemeSwitcher.DEFAULT_THEME;
    }

    const theme = ThemeSwitcher.themes[themeName];
    const root = document.documentElement;

    // Set all theme CSS variables
    for (const [key, value] of Object.entries(theme)) {
      if (key !== 'name') {
        root.style.setProperty(`--${key}`, value);
      }
    }

    // Update active button state
    document.querySelectorAll('[data-theme]').forEach((btn) => {
      if (btn.getAttribute('data-theme') === themeName) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Save preference
    localStorage.setItem(ThemeSwitcher.STORAGE_KEY, themeName);
  },

  // Get current theme name
  getCurrentTheme: () => {
    return localStorage.getItem(ThemeSwitcher.STORAGE_KEY) || ThemeSwitcher.DEFAULT_THEME;
  }
};

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => ThemeSwitcher.init());
} else {
  ThemeSwitcher.init();
}
