// Auth middleware: identifies the caller from the access-token cookie.
// The access token is a short-lived JWT ({ sub: userId }) signed with JWT_SECRET; verifying it needs no DB lookup.
import jwt from 'jsonwebtoken';
import config from '../config/index.js';

export const ACCESS_TOKEN_COOKIE = 'access_token';

// The caller's user id from a valid token, or null if there's no token or it's malformed, expired or forged.
function userIdFromToken(req) {
  const token = req.cookies?.[ACCESS_TOKEN_COOKIE];
  if (!token) {
    return null;
  }
  try {
    return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }).sub;
  } catch {
    return null;
  }
}

// Protects a route: sets req.userId from a valid token, otherwise responds 401.
// Missing, malformed, expired and forged tokens all get the same response.
export function requireAuth(req, res, next) {
  const userId = userIdFromToken(req);
  if (!userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  req.userId = userId;
  next();
}

// For public routes that show more to a logged-in viewer (their own "did I like this" flags): sets req.userId from a
// valid token, or to null, and always continues. A missing, malformed, expired or forged token all count as logged
// out rather than a 401, so a public page still loads with a stale cookie; the client's refresh flow deals with
// expiry. Use requireAuth instead wherever the route needs to know who the caller is.
export function optionalAuth(req, res, next) {
  req.userId = userIdFromToken(req);
  next();
}
