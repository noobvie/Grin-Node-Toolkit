// Authentication helper module
// Provides token management, API fetch wrapper, and login/logout

const Auth = {

  getToken() {
    return localStorage.getItem('access_token') || null;
  },

  setToken(access_token, refresh_token) {
    localStorage.setItem('access_token', access_token);
    localStorage.setItem('refresh_token', refresh_token);
  },

  clearToken() {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    window.location.href = '/login.html';
  },

  // Fetch wrapper with auth header - FIX #8: Validate response type and handle errors safely
  async fetch(url, options = {}) {
    const token = this.getToken();
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers
      });

      if (response.status === 401) {
        this.clearToken();
        return null;
      }

      // Validate response is JSON to prevent XSS
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        console.error(`Invalid response type: ${contentType}. Expected application/json`);
        return null;
      }

      const data = await response.json();

      // Validate response object has expected structure
      if (data === null || typeof data !== 'object') {
        console.error('Invalid JSON response: expected object');
        return null;
      }

      return data;
    } catch (error) {
      console.error(`Fetch error: ${url}`, error);
      return null;
    }
  },

  // Login
  async login(username, password) {
    try {
      const data = await this.fetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });

      if (data && data.success) {
        this.setToken(data.access_token, data.refresh_token);
        return true;
      } else {
        console.error('Login failed:', data?.message || 'Unknown error');
        return false;
      }
    } catch (error) {
      console.error('Login error:', error);
      return false;
    }
  },

  // Logout
  logout() {
    this.clearToken();
  },

  // Check if logged in
  isLoggedIn() {
    return !!this.getToken();
  }
};

// Redirect to login if not authenticated (for protected pages)
function requireAuth() {
  if (!Auth.isLoggedIn()) {
    window.location.href = '/login.html';
  }
}

// Show error message in UI
function showError(message) {
  const errorDiv = document.querySelector('[data-error-container]') ||
                   document.getElementById('error-message') ||
                   (() => {
                     const div = document.createElement('div');
                     div.style.cssText = 'background: #fee; color: #c00; padding: 1em; margin: 1em 0; border-radius: 4px; display: none;';
                     document.body.insertBefore(div, document.body.firstChild);
                     return div;
                   })();

  errorDiv.textContent = message;
  errorDiv.style.display = 'block';
  setTimeout(() => { errorDiv.style.display = 'none'; }, 5000);
}

// Show loading spinner
function showLoading(show = true) {
  let spinner = document.querySelector('[data-loading-spinner]');
  if (!spinner) {
    spinner = document.createElement('div');
    spinner.setAttribute('data-loading-spinner', '');
    spinner.style.cssText = `
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: rgba(0,0,0,0.8); color: #0f0; padding: 2em; border-radius: 8px;
      font-family: monospace; z-index: 9999; display: none;
    `;
    spinner.textContent = 'Loading...';
    document.body.appendChild(spinner);
  }
  spinner.style.display = show ? 'block' : 'none';
}
