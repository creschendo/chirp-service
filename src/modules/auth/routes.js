// HTTP routes and thin handlers for the auth module (validate input, call the service, send the response).
// Mounted at /auth. Access token: 15-min JWT cookie (Path=/). Refresh token: 30-day cookie (Path=/auth, so refresh
// and logout get it); only its SHA-256 hash is stored in sessions. "Who am I" is GET /users/me.
import { Router } from 'express';
import config from '../../config/index.js';
import { ACCESS_TOKEN_COOKIE } from '../../middleware/auth.js';
import * as service from './service.js';
import { loginSchema, registerSchema } from './schemas.js';
import { ACCESS_TOKEN_TTL_SECONDS } from './tokens.js';

export const REFRESH_TOKEN_COOKIE = 'refresh_token';

const router = Router();

// httpOnly: page JavaScript can't read the tokens. secure: HTTPS only, outside local development.
// sameSite lax: localhost:5173 and localhost:4000 count as the same site; production settings still to decide.
const baseCookie = { httpOnly: true, secure: config.env === 'production', sameSite: 'lax' };

function setAuthCookies(res, { accessToken, refreshToken, refreshExpiresAt }) {
  res.cookie(ACCESS_TOKEN_COOKIE, accessToken, { ...baseCookie, path: '/', maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000 });
  res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, { ...baseCookie, path: '/auth', expires: refreshExpiresAt });
}

// Clearing needs the same path each cookie was set with, or the browser keeps it.
function clearAuthCookies(res) {
  res.clearCookie(ACCESS_TOKEN_COOKIE, { ...baseCookie, path: '/' });
  res.clearCookie(REFRESH_TOKEN_COOKIE, { ...baseCookie, path: '/auth' });
}

// POST /auth/register { username, email, password, displayName? } -> 201 + user, logged in (sets cookies).
// 400 invalid input, 409 username or email taken (ignoring case).
router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
  }

  const { user, ...tokens } = await service.register(parsed.data);
  setAuthCookies(res, tokens);
  res.status(201).json(user);
});

// POST /auth/login { login (username or email), password } -> 200 + user, sets cookies, new session.
// 400 invalid input, 401 invalid credentials (same message for unknown login and wrong password).
router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
  }

  const { user, ...tokens } = await service.login(parsed.data);
  setAuthCookies(res, tokens);
  res.json(user);
});

// POST /auth/refresh (refresh cookie) -> 204 + new cookies; rotates the session (each refresh token works once).
// 401 missing/unknown/expired/revoked token; a reused token revokes all the user's sessions. Every 401 clears cookies.
router.post('/refresh', async (req, res) => {
  try {
    const tokens = await service.refresh(req.cookies?.[REFRESH_TOKEN_COOKIE]);
    setAuthCookies(res, tokens);
    res.status(204).end();
  } catch (err) {
    if (err.status === 401) {
      clearAuthCookies(res);
    }
    throw err;
  }
});

// POST /auth/logout (refresh cookie) -> always 204, clears cookies; revokes this device's session.
// The access token stays valid until it expires (max 15 min). A spent token revokes all the user's sessions.
router.post('/logout', async (req, res) => {
  await service.logout(req.cookies?.[REFRESH_TOKEN_COOKIE]);
  clearAuthCookies(res);
  res.status(204).end();
});

export default router;
