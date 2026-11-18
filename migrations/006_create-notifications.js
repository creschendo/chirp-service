// Migration: notifications, and each user's read-up-to time.
// Decisions (see src/modules/notifications): likes, reposts, replies, quotes and follows notify; never yourself; only
// new actions notify, and undoing one deletes its notification, so there is at most one per action (the unique key).
// A notification whose post is soft-deleted stays here and is hidden by the queries. No grouping: one row per action.
// Read state is one read_up_to time per user, not a flag per row, so marking read is a single-row write.
// Deleting a user removes the notifications they received and the ones they caused.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE notifications (
      notification_id uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
      recipient_id    uuid           NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
      actor_id        uuid           NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
      type            text           NOT NULL,
      -- like/repost: the recipient's post that was liked or reposted. reply/quote: the new reply or quote.
      -- follow: NULL.
      post_id         uuid           REFERENCES posts (post_id) ON DELETE CASCADE,
      created_at      timestamptz(3) NOT NULL DEFAULT now(),
      CONSTRAINT notifications_type_check CHECK (type IN ('like', 'repost', 'reply', 'quote', 'follow')),
      -- Only follows have no post.
      CONSTRAINT notifications_post_check CHECK ((type = 'follow') = (post_id IS NULL)),
      -- Backstop for "never notify yourself"; the service skips these before inserting.
      CONSTRAINT notifications_no_self_check CHECK (actor_id <> recipient_id),
      -- One notification per action. NULLS NOT DISTINCT so two follow rows (post_id NULL) still collide (Postgres
      -- 15+). Starts with actor_id, so it also covers the actor_id foreign key and undo's delete
      -- (actor, type, post, or actor, type, recipient for a follow).
      CONSTRAINT notifications_action_key UNIQUE NULLS NOT DISTINCT (actor_id, type, post_id, recipient_id)
    );

    -- Your notifications, newest first (cursor on created_at + notification_id), and the unread count (the ones
    -- after your read_up_to). Also covers the recipient_id foreign key.
    CREATE INDEX notifications_recipient_id_created_at_idx
      ON notifications (recipient_id, created_at DESC, notification_id DESC);

    -- Covers the post_id foreign key, for the cascade when a post is hard-deleted.
    CREATE INDEX notifications_post_id_idx ON notifications (post_id) WHERE post_id IS NOT NULL;

    -- Everything at or before read_up_to is read. No row: nothing has been read yet. Its own table rather than a
    -- users column, so the notifications module owns all its data.
    CREATE TABLE notification_reads (
      user_id    uuid           PRIMARY KEY REFERENCES users (user_id) ON DELETE CASCADE,
      read_up_to timestamptz(3) NOT NULL
    );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS notification_reads;
    DROP TABLE IF EXISTS notifications;
  `);
};
