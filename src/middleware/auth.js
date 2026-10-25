// Auth middleware: identifies the caller from the access-token cookie.
// The access token is a short-lived JWT ({ sub: userId }) signed with JWT_SECRET; verifying it needs no DB lookup.
import jwt from 'jsonwebtoken';
import config from '../config/index.js';

export const ACCESS_TOKEN_COOKIE = 'access_token';

// Protects a route: sets req.userId from a valid token, otherwise responds 401.
// Missing, malformed, expired and forged tokens all get the same response.
export function requireAuth(req, res, next) {
  const token = req.cookies?.[ACCESS_TOKEN_COOKIE];
  if (!token) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Not logged in' });
  }
}
