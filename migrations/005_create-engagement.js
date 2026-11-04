// Migration: engagement. likes, reposts and bookmarks: each a user -> post relationship with a time.
// Decisions: one of each per user per post (the key or a unique constraint), so liking, reposting or bookmarking
// twice is a no-op rather than a duplicate. Counts are computed on read from these tables, never stored.
// A repost is an item in timelines (new activity at the time of the repost; the original post isn't changed), so
// unlike likes and bookmarks it has its own repost_id: timeline items are keyed by (activity time, item id), where
// the item id is a post_id or a repost_id, both uuids. Reposting your own post is allowed.
// Posts are soft-deleted, so the post_id cascades only fire when a post's author is deleted; engagement on a
// soft-deleted post stays here and is hidden by the queries. Deleting a user removes all of their engagement.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE likes (
      user_id    uuid           NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
      post_id    uuid           NOT NULL REFERENCES posts (post_id) ON DELETE CASCADE,
      created_at timestamptz(3) NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, post_id)
    );

    -- Like counts and "who liked this"; also covers the post_id foreign key. The primary key covers the user_id
    -- foreign key and "did I like these posts".
    CREATE INDEX likes_post_id_idx ON likes (post_id);

    -- A user's likes, newest first (cursor on created_at + post_id).
    CREATE INDEX likes_user_id_created_at_idx ON likes (user_id, created_at DESC, post_id DESC);

    CREATE TABLE reposts (
      repost_id  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    uuid           NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
      post_id    uuid           NOT NULL REFERENCES posts (post_id) ON DELETE CASCADE,
      created_at timestamptz(3) NOT NULL DEFAULT now(),
      -- One repost per user per post. Also covers the user_id foreign key and "did I repost these posts".
      CONSTRAINT reposts_user_id_post_id_key UNIQUE (user_id, post_id)
    );

    -- Repost counts, and picking the newest repost of a post in the home timeline; also covers the post_id
    -- foreign key.
    CREATE INDEX reposts_post_id_idx ON reposts (post_id);

    -- A user's reposts, newest first: their profile timeline, and the home timeline's reposts by people you follow
    -- (cursor on created_at + repost_id).
    CREATE INDEX reposts_user_id_created_at_idx ON reposts (user_id, created_at DESC, repost_id DESC);

    CREATE TABLE bookmarks (
      user_id    uuid           NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
      post_id    uuid           NOT NULL REFERENCES posts (post_id) ON DELETE CASCADE,
      created_at timestamptz(3) NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, post_id)
    );

    -- Covers the post_id foreign key (bookmarks have no public count).
    CREATE INDEX bookmarks_post_id_idx ON bookmarks (post_id);

    -- Your bookmarks, newest first (cursor on created_at + post_id).
    CREATE INDEX bookmarks_user_id_created_at_idx ON bookmarks (user_id, created_at DESC, post_id DESC);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS bookmarks;
    DROP TABLE IF EXISTS reposts;
    DROP TABLE IF EXISTS likes;
  `);
};
