// Database access for the auth module.
// Owns the sessions table. User data (credentials, account) goes through users/store.js.
// Every function takes an optional `db` (defaults to the pool) so a service can run it inside withTransaction.
// Only SHA-256 hashes of refresh tokens are passed in; the raw token never reaches this layer.
import { pool } from '../../db/index.js';

// Login, refresh (the new session), and register if sign-up logs you in.
// INSERT INTO sessions (user_id, refresh_token_hash, expires_at) ... RETURNING session_id.
// Returns { sessionId }.
export async function createSession({ userId, refreshTokenHash, expiresAt }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING session_id AS "sessionId"`,
    [userId, refreshTokenHash, expiresAt],
  );
  return rows[0];
}

// Refresh and logout: look up the session for a refresh cookie.
// Selects session_id, user_id, expires_at, revoked_at, replaced_by_session_id; the service decides
// what each state means (expired, revoked, replaced = reuse). Returns null if no session matches.
export async function getSessionByTokenHash(refreshTokenHash, db = pool) {
  const { rows } = await db.query(
    `SELECT session_id AS "sessionId", user_id AS "userId", expires_at AS "expiresAt",
            revoked_at AS "revokedAt", replaced_by_session_id AS "replacedBySessionId"
     FROM sessions
     WHERE refresh_token_hash = $1`,
    [refreshTokenHash],
  );
  return rows[0] ?? null;
}

// Refresh rotation: point the old session at its replacement.
// Conditional UPDATE (WHERE replaced_by_session_id IS NULL AND revoked_at IS NULL) so only one of two
// concurrent refreshes with the same token wins. Returns false if it was already replaced or revoked.
export async function markSessionReplaced(sessionId, newSessionId, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE sessions
     SET replaced_by_session_id = $2
     WHERE session_id = $1 AND replaced_by_session_id IS NULL AND revoked_at IS NULL`,
    [sessionId, newSessionId],
  );
  return rowCount > 0;
}

// Logout: SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL.
// Returns false if the session was missing or already revoked.
export async function revokeSession(sessionId, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE sessions
     SET revoked_at = now()
     WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
  return rowCount > 0;
}

// Refresh-token reuse (likely theft): revoke every session of the user.
// Password change: same, but pass exceptSessionId to keep the current session.
// Returns the number of sessions revoked.
export async function revokeAllUserSessions(userId, { exceptSessionId = null } = {}, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE sessions
     SET revoked_at = now()
     WHERE user_id = $1 AND session_id IS DISTINCT FROM $2 AND revoked_at IS NULL`,
    [userId, exceptSessionId],
  );
  return rowCount;
}

// Periodic cleanup: DELETE sessions past expires_at. Returns the number deleted.
export async function deleteExpiredSessions(db = pool) {
  const { rowCount } = await db.query(
    `DELETE FROM sessions
     WHERE expires_at < now()`,
  );
  return rowCount;
}
