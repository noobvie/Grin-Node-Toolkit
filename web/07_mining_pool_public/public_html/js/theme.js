// Theme switcher module — handles 5 themes: Matrix, Dark, Light, Naruto, Japan
// All admin-panel/*.html pages reference <script src="/js/theme.js"> but it didn't exist

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
