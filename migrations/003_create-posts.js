// Migration: posts. Originals, replies and quote posts share one table (replies are posts, Twitter's model).
// Decisions: a reply has parent_post_id (the post it answers) and root_post_id (the thread's original), so a whole
// conversation is one indexed lookup; nesting is unlimited. Deleting a post is a soft delete (deleted_at set,
// content cleared) so threads and quotes keep something to point at. Reposts are a separate table (engagement).
// The service sets root_post_id and refuses to reply to or quote a deleted post.
// Self-references use the default ON DELETE NO ACTION: posts are never hard-deleted, except by deleting their
// author, which fails while other users' replies or quotes still point at them (account deletion is deferred).

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE posts (
      post_id        uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
      author_id      uuid           NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
      content        text,
      parent_post_id uuid           REFERENCES posts (post_id),
      root_post_id   uuid           REFERENCES posts (post_id),
      quoted_post_id uuid           REFERENCES posts (post_id),
      created_at     timestamptz(3) NOT NULL DEFAULT now(),
      deleted_at     timestamptz(3),
      CONSTRAINT posts_content_length       CHECK (char_length(content) BETWEEN 1 AND 280),
      -- Live posts have content; deleted posts have none.
      CONSTRAINT posts_content_iff_live     CHECK ((content IS NULL) = (deleted_at IS NOT NULL)),
      -- A reply always knows its thread's root, and only replies have one.
      CONSTRAINT posts_reply_has_root       CHECK ((parent_post_id IS NULL) = (root_post_id IS NULL)),
      CONSTRAINT posts_no_self_reference    CHECK (post_id <> parent_post_id AND post_id <> quoted_post_id)
    );

    -- Profile timeline and home timeline (posts by an author, newest first, cursor on created_at + post_id).
    -- Also covers the author_id foreign key.
    CREATE INDEX posts_author_id_created_at_idx ON posts (author_id, created_at DESC, post_id DESC);

    -- Direct replies to a post, oldest first.
    CREATE INDEX posts_parent_post_id_created_at_idx ON posts (parent_post_id, created_at, post_id)
      WHERE parent_post_id IS NOT NULL;

    -- Everything in a conversation.
    CREATE INDEX posts_root_post_id_created_at_idx ON posts (root_post_id, created_at, post_id)
      WHERE root_post_id IS NOT NULL;

    -- Quotes of a post (quote counts and lists).
    CREATE INDEX posts_quoted_post_id_idx ON posts (quoted_post_id)
      WHERE quoted_post_id IS NOT NULL;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS posts;
  `);
};
