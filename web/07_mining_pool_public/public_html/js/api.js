// Missing API helper module — restores compatibility for admin-panel pages
// All admin-panel/*.html pages reference <script src="/js/api.js"> but it didn't exist
// This module wraps Auth.fetch() and provides the expected API interface

const API = {
  // Check if user is logged in
  isLoggedIn: async () => {
    try {
      return await Auth.isLoggedIn();
    } catch (err) {
      return false;
    }
  },

  // Decode JWT payload (no longer needed with httpOnly cookies, returns null)
  decodePayload: () => {
    return null;
  },

  // GET request
  get: async (url) => {
    try {
      const response = await Auth.fetch(url, { method: 'GET' });
      return response;
    } catch (err) {
      console.error(`API.get(${url}) failed:`, err);
      throw err;
    }
  },

  // POST request
  post: async (url, data) => {
    try {
      const response = await Auth.fetch(url, {
        method: 'POST',
        body: JSON.stringify(data)
      });
      return response;
    } catch (err) {
      console.error(`API.post(${url}) failed:`, err);
      throw err;
    }
  },

  // PUT request
  put: async (url, data) => {
    try {
      const response = await Auth.fetch(url, {
        method: 'PUT',
        body: JSON.stringify(data)
      });
      return response;
    } catch (err) {
      console.error(`API.put(${url}) failed:`, err);
      throw err;
    }
  },

  // DELETE request
  del: async (url) => {
    try {
      const response = await Auth.fetch(url, { method: 'DELETE' });
      return response;
    } catch (err) {
      console.error(`API.delete(${url}) failed:`, err);
      throw err;
    }
  },

  // Clear tokens and logout
  clearTokens: async () => {
    try {
      return await Auth.logout();
    } catch (err) {
      console.error('API.clearTokens() failed:', err);
      throw err;
    }
  },

  // Admin-page guard. The session is an httpOnly cookie that JS cannot read, so we ask the
  // SERVER who we are (/api/admin/me, secureAdmin-gated). 200 → logged in (returns the user
  // and wires up the nav username + Logout); 401/403/anything-else → redirect to /login.html.
  // This replaces the old client-side decodePayload() check, which always returned null and
  // bounced every admin page straight back to login in an infinite loop.
  guardAdminPage: async () => {
    let me = null;
    try {
      const res = await fetch('/api/admin/me', { credentials: 'include' });
      // Only a genuine auth failure should bounce to the login page. A 429 (app rate
      // limit) or 503 (nginx rate limit) is TRANSIENT — clicking around fast must not log
      // you out. On those (and on network errors) we stay put and let the page's own data
      // loaders surface a soft error; the cookie is still valid.
      if (res.status === 401 || res.status === 403) { window.location.href = '/login.html'; return null; }
      if (res.status !== 200) { console.warn('guardAdminPage: transient', res.status); return null; }
      me = await res.json();
    } catch (e) {
      console.warn('guardAdminPage: network error, staying on page', e);
      return null;
    }
    if (!me || !me.is_admin) { window.location.href = '/login.html'; return null; }

    const nav = document.getElementById('nav-user');
    if (nav) {
      const safe = String(me.username || 'admin').replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      nav.style.display = '';
      nav.innerHTML = `<span class="nav-username">${safe}</span> <a href="#" id="nav-logout">Logout</a>`;
      const lo = document.getElementById('nav-logout');
      if (lo) lo.addEventListener('click', (e) => { e.preventDefault(); API.clearTokens(); });
    }
    return me;
  }
};
