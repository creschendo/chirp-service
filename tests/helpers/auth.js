// Auth helpers for API tests: sign access tokens the same way login will, without going through login.
import jwt from 'jsonwebtoken';
import config from '../../src/config/index.js';
import { ACCESS_TOKEN_COOKIE } from '../../src/middleware/auth.js';

// Cookie header value for a logged-in user. Pass { expiresIn: -1 } for an expired token,
// or { secret: 'other' } for a forged one.
export function authCookie(userId, { expiresIn = '15m', secret = config.jwtSecret } = {}) {
  const token = jwt.sign({ sub: userId }, secret, { algorithm: 'HS256', expiresIn });
  return `${ACCESS_TOKEN_COOKIE}=${token}`;
}
