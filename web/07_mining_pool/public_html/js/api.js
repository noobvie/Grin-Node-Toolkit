// api.js — Fetch wrapper with JWT Bearer injection and auto-refresh

const API = {
  _token:   localStorage.getItem('pool-access-token'),
  _refresh: localStorage.getItem('pool-refresh-token'),

  async get(url) {
    return this._fetch(url, { method: 'GET' });
  },

  async post(url, body) {
    return this._fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  async put(url, body) {
    return this._fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  async delete(url) {
    return this._fetch(url, { method: 'DELETE' });
  },

  async _fetch(url, opts, _retry) {
    const headers = { ...(opts.headers || {}) };
    if (this._token) {
      headers['Authorization'] = 'Bearer ' + this._token;
    }

    let res;
    try {
      res = await fetch(url, { ...opts, headers });
    } catch (err) {
      throw new Error('Network error: ' + err.message);
    }

    // 401 — try token refresh once
    if (res.status === 401 && !_retry) {
      const refreshed = await this._tryRefresh();
      if (refreshed) return this._fetch(url, opts, true);
      this.clearTokens();
      window.location.href = '/login.html';
      return;
    }

    // 403 — access denied
    if (res.status === 403) {
      throw new Error('Access denied');
    }

    if (!res.ok) {
      let msg = 'Request failed (' + res.status + ')';
      try {
        const data = await res.json();
        if (data.error || data.detail || data.message) {
          msg = data.error || data.detail || data.message;
        }
      } catch (_) {}
      throw new Error(msg);
    }

    // 204 No Content
    if (res.status === 204) return null;

    try {
      return await res.json();
    } catch (_) {
      return null;
    }
  },

  async _tryRefresh() {
    if (!this._refresh) return false;
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: this._refresh }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (data.access_token) {
        this.saveTokens(data.access_token, data.refresh_token || this._refresh);
        return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  },

  saveTokens(access, refresh) {
    this._token   = access;
    this._refresh = refresh;
    localStorage.setItem('pool-access-token',   access);
    localStorage.setItem('pool-refresh-token', refresh);
  },

  clearTokens() {
    this._token   = null;
    this._refresh = null;
    localStorage.removeItem('pool-access-token');
    localStorage.removeItem('pool-refresh-token');
  },

  isLoggedIn() {
    return !!this._token;
  },

  // Decode JWT payload (no verification — display only)
  decodePayload() {
    if (!this._token) return null;
    try {
      return JSON.parse(atob(this._token.split('.')[1]));
    } catch (_) {
      return null;
    }
  },
};
