// Authentication helper module
// FIX #4: Updated to use httpOnly cookies instead of localStorage
// Tokens are now automatically sent with each request via cookies

const Auth = {

  // FIX #4: Tokens are in httpOnly cookies (not accessible to JS)
  // Just check if we can access protected endpoints
  async getToken() {
    // Make a test request to check if authenticated
    try {
      const response = await fetch('/api/admin/dashboard', { credentials: 'include' });
      return response.status === 200;
    } catch {
      return false;
    }
  },

  // FIX #4: No longer needed - tokens are in httpOnly cookies set by server
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

  // FIX #4: Fetch wrapper - credentials:'include' sends httpOnly cookies automatically
  async fetch(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        credentials: 'include'  // FIX #4: Send cookies with every request
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
        // FIX #4: Token is in httpOnly cookie, not in response
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

  // Check if logged in
  async isLoggedIn() {
    try {
      const response = await fetch('/api/health', { credentials: 'include' });
      return response.status === 200;
    } catch {
      return false;
    }
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
