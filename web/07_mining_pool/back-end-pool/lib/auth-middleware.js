function requireAuth(authManager) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);
    const result = authManager.verifyAccessToken(token);

    if (!result.valid) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = result.payload;
    req.token = token;
    next();
  };
}

function requireAdmin(authManager) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);
    const result = authManager.verifyAccessToken(token);

    if (!result.valid) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    if (!result.payload.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.user = result.payload;
    req.token = token;
    next();
  };
}

function requireFreshAuth(authManager, maxAgeSeconds = 300) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);
    const result = authManager.verifyAccessToken(token);

    if (!result.valid) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    if (!result.payload.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
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
