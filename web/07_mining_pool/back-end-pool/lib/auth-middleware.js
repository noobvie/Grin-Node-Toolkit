function requireAuth(authManager) {
  return (req, res, next) => {
    // FIX #4: Read token from httpOnly cookie first, then Authorization header as fallback
    let token = req.cookies?.access_token;

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = authManager.verifyAccessToken(token);

    if (!result.valid) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    req.user = result.payload;
    req.token = token;
    next();
  };
}

function requireAdmin(authManager) {
  return (req, res, next) => {
    // FIX #4: Read token from httpOnly cookie first, then Authorization header as fallback
    let token = req.cookies?.access_token;

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = authManager.verifyAccessToken(token);

    if (!result.valid) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!result.payload.is_admin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    req.user = result.payload;
    req.token = token;
    next();
  };
}

function requireFreshAuth(authManager, maxAgeSeconds = 300) {
  return (req, res, next) => {
    // FIX #4: Read token from httpOnly cookie first, then Authorization header as fallback
    let token = req.cookies?.access_token;

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = authManager.verifyAccessToken(token);

    if (!result.valid) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!result.payload.is_admin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const isFresh = authManager.isTokenFresh(token, maxAgeSeconds);
    if (!isFresh) {
      return res.status(403).json({
        error: 'Session expired',
        challenge_required: true
      });
    }

    req.user = result.payload;
    req.token = token;
    next();
  };
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireFreshAuth
};
