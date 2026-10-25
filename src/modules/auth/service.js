// Business logic for the auth module.
import bcrypt from 'bcrypt';
import * as authStore from './store.js';
import * as usersStore from '../users/store.js';
import { withTransaction } from '../../db/index.js';
import { unauthorized, conflict } from '../../errors.js';
import { signAccessToken, generateRefreshToken, hashRefreshToken, REFRESH_TOKEN_TTL_MS } from './tokens.js';

// bcrypt cost factor for new password hashes (register, password change). compare() reads the cost
// from the stored hash, so changing this only affects hashes created afterwards.
export const BCRYPT_COST = 12;

// Compared against when no account matches, so an unknown login takes as long as a wrong password and
// response timing doesn't reveal which usernames or emails exist. Created once, on first use.
let dummyHashPromise;
const dummyHash = () => (dummyHashPromise ??= bcrypt.hash('dummy-password-for-timing', BCRYPT_COST));

// POST /auth/register. Creates the account and logs it in. Returns { user, accessToken, refreshToken,
// refreshExpiresAt } like login. Throws 409 if the username or email is taken (either case).
export async function register({ username, email, password, displayName }) {
  // Hashed before the transaction: bcrypt is slow on purpose, and the DB connection shouldn't wait on it.
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  try {
    // User and session together: a failed session insert doesn't leave an account behind.
    return await withTransaction(async (client) => {
      const user = await usersStore.createUser(
        { username, email, passwordHash, displayName: displayName ?? username },
        client,
      );
      const tokens = await startSession(user.userId, client);
      return { user, ...tokens };
    });
  } catch (err) {
    // No "is it taken?" query first: the unique constraints decide, so two sign-ups can't race past a check.
    if (err.code === '23505' && err.constraint === 'users_username_key') {
      throw conflict('Username is already taken');
    }
    if (err.code === '23505' && err.constraint === 'users_email_key') {
      throw conflict('Email is already registered');
    }
    throw err;
  }
}

// POST /auth/login. Returns { user, accessToken, refreshToken, refreshExpiresAt }; the route turns the
// tokens into cookies. Throws 401 with the same message for an unknown login or a wrong password.
export async function login({ login, password }) {
  const creds = await usersStore.getCredentialsByLogin(login);
  const valid = await bcrypt.compare(password, creds?.passwordHash ?? (await dummyHash()));
  if (!creds || !valid) {
    throw unauthorized('Invalid credentials');
  }

  const tokens = await startSession(creds.userId);
  const user = await usersStore.getUserById(creds.userId);
  return { user, ...tokens };
}

// Thrown inside the refresh transaction when another request already rotated the same session.
class RefreshTokenReused extends Error {}

// POST /auth/refresh. Exchanges a refresh token for a new access + refresh token pair (rotation: each
// refresh token works once). Returns { sessionId, accessToken, refreshToken, refreshExpiresAt }.
// Throws 401 for a missing, unknown, expired or revoked token. A token that was already used means two
// parties hold a copy (likely theft): every session of that user is revoked, and they must log in again.
export async function refresh(refreshToken) {
  if (!refreshToken) {
    throw unauthorized('Not logged in');
  }

  const session = await authStore.getSessionByTokenHash(hashRefreshToken(refreshToken));
  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    throw unauthorized('Session expired');
  }
  if (session.replacedBySessionId) {
    await authStore.revokeAllUserSessions(session.userId);
    throw unauthorized('Session expired');
  }

  try {
    // New session and the old one's replacement link together, or neither.
    return await withTransaction(async (client) => {
      const next = await startSession(session.userId, client);
      // Conditional update: if a concurrent refresh with the same token got here first, this changes nothing.
      const rotated = await authStore.markSessionReplaced(session.sessionId, next.sessionId, client);
      if (!rotated) {
        throw new RefreshTokenReused();
      }
      return next;
    });
  } catch (err) {
    if (err instanceof RefreshTokenReused) {
      await authStore.revokeAllUserSessions(session.userId);
      throw unauthorized('Session expired');
    }
    throw err;
  }
}

// POST /auth/logout. Ends the session this refresh token belongs to (this device only). Never fails:
// a missing or unknown token has nothing to end. The access token is stateless and stays valid until it
// expires (at most 15 minutes); what logout guarantees is that no new one can be issued.
export async function logout(refreshToken) {
  if (!refreshToken) {
    return;
  }
  const session = await authStore.getSessionByTokenHash(hashRefreshToken(refreshToken));
  if (!session) {
    return;
  }
  if (session.replacedBySessionId) {
    // A spent token: the legitimate client always holds the newest one, so treat this like refresh does.
    await authStore.revokeAllUserSessions(session.userId);
    return;
  }
  await authStore.revokeSession(session.sessionId);
}

// Creates a session for userId and issues its tokens. Shared by register, login and refresh.
// Pass a transaction client as db to include the session insert in a caller's transaction.
async function startSession(userId, db) {
  const refreshToken = generateRefreshToken();
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  const { sessionId } = await authStore.createSession(
    { userId, refreshTokenHash: hashRefreshToken(refreshToken), expiresAt: refreshExpiresAt },
    db,
  );
  return { sessionId, accessToken: signAccessToken(userId), refreshToken, refreshExpiresAt };
}
