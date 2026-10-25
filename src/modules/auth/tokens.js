// Token helpers for the auth module.
// Access token: short-lived JWT ({ sub: userId }) that requireAuth verifies without a DB lookup.
// Refresh token: long random value; only its SHA-256 hash is stored (sessions.refresh_token_hash).
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import config from '../../config/index.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function signAccessToken(userId) {
  return jwt.sign({ sub: userId }, config.jwtSecret, { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_TTL_SECONDS });
}

// 32 random bytes: unguessable, so a fast hash is enough to store it (unlike passwords, which need bcrypt).
export function generateRefreshToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
