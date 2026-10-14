// Migration: sessions for refresh tokens (auth option B: short-lived access JWT + rotating refresh token).
// Only the SHA-256 hash of each refresh token is stored. Each refresh creates a new session row and
// links the old one via replaced_by_session_id; reuse of an already-replaced token signals theft.
// Logout sets revoked_at.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE sessions (
      session_id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id                uuid        NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
      refresh_token_hash     text        NOT NULL,
      created_at             timestamptz NOT NULL DEFAULT now(),
      expires_at             timestamptz NOT NULL,
      revoked_at             timestamptz,
      replaced_by_session_id uuid        REFERENCES sessions (session_id) ON DELETE SET NULL,
      CONSTRAINT sessions_refresh_token_hash_key    UNIQUE (refresh_token_hash),
      CONSTRAINT sessions_expires_after_created     CHECK (expires_at > created_at)
    );

    -- "Log out everywhere" and revoking a user's whole token chain.
    CREATE INDEX sessions_user_id_idx ON sessions (user_id);

    -- Cleanup of expired sessions.
    CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS sessions;
  `);
};
