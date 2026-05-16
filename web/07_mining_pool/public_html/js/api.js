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
  }
};
