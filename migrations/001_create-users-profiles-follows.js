// Migration: users (accounts/credentials), profiles, and follows.
// Decisions: UUID ids, citext for case-insensitive username/email, timestamptz,
// ON DELETE CASCADE from users, timestamps on profiles only (updated_at set by app code).

export const up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS citext;

    CREATE TABLE users (
      user_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      username      citext NOT NULL,
      email         citext NOT NULL,
      password_hash text   NOT NULL,
      CONSTRAINT users_username_key    UNIQUE (username),
      CONSTRAINT users_email_key       UNIQUE (email),
      CONSTRAINT users_username_format CHECK (username ~ '^[A-Za-z0-9_]{3,15}$'),
      CONSTRAINT users_email_length    CHECK (char_length(email) <= 254)
    );

    CREATE TABLE profiles (
      user_id      uuid PRIMARY KEY REFERENCES users (user_id) ON DELETE CASCADE,
      display_name text        NOT NULL,
      bio          text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT profiles_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 50),
      CONSTRAINT profiles_bio_length          CHECK (char_length(bio) <= 160)
    );

    CREATE TABLE follows (
      follower_id uuid        NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
      followed_id uuid        NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
      created_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (follower_id, followed_id),
      CONSTRAINT follows_no_self_follow CHECK (follower_id <> followed_id)
    );

    -- Reverse direction ("who follows me"); the primary key covers "who do I follow".
    CREATE INDEX follows_followed_id_follower_id_idx ON follows (followed_id, follower_id);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS follows;
    DROP TABLE IF EXISTS profiles;
    DROP TABLE IF EXISTS users;
    DROP EXTENSION IF EXISTS citext;
  `);
};
