// Authentication helper module.
// Session tokens live in httpOnly cookies (not localStorage), so JS never sees them and
// every request just carries them via credentials:'include'.

const Auth = {

  // Tokens are in httpOnly cookies (not accessible to JS), so there is nothing to return:
  // the only way to answer "am I authenticated?" is to ask a protected endpoint.
  async getToken() {
    // Make a test request to check if authenticated
    try {
      const response = await fetch('/api/admin/dashboard', { credentials: 'include' });
      return response.status === 200;
    } catch {
      return false;
    }
  },

  // Deprecated no-op — the server sets httpOnly cookies on login; nothing to store here.
  setToken(access_token, refresh_token) {
    // Deprecated: Server sets httpOnly cookies on login
    console.log('[Auth] Tokens set as httpOnly cookies by server');
  },

  // Logout: call server to clear cookies
  async clearToken() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include'
      });
    } catch (e) {
      console.warn('Logout request failed');
    }
    window.location.href = '/login.html';
  },

  // Fetch wrapper — credentials:'include' sends the httpOnly session cookies automatically.
  async fetch(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        credentials: 'include'  // send the session cookies with every request
      });

      if (response.status === 401) {
        // Token expired or missing
        window.location.href = '/login.html';
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

  // Login - tokens now returned as httpOnly cookies
  async login(username, password) {
    try {
      const data = await this.fetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });

      if (data && data.success) {
        // The token is in an httpOnly cookie, not in the response body.
        console.log('Login successful - token in httpOnly cookie');
        return true;
      } else {
        console.error('Login failed:', data?.error || 'Unknown error');
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

  // Check if logged in. Must hit an AUTH-GATED endpoint: /api/health is public and
  // returns 200 for everyone, so it can't tell logged-in from logged-out. The admin
  // dashboard endpoint returns 200 only with a valid admin cookie (401/403 otherwise),
  // which is the right signal here since only admins have accounts on this pool.
  async isLoggedIn() {
    try {
      const response = await fetch('/api/admin/dashboard', { credentials: 'include' });
      return response.status === 200;
    } catch {
      return false;
    }
  }
};

// Redirect to login if not authenticated (for protected pages).
// isLoggedIn() is async — must be awaited, or `!Promise` is always false and this never fires.
async function requireAuth() {
  const ok = await Auth.isLoggedIn();
  if (!ok) {
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
