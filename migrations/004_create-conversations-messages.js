// Migration: direct messages. conversations (one row per chat, direct or group), conversation_participants
// (who is in each chat, plus per-user read state) and messages.
// Decisions: one-to-one and group chats share one table so messages, inbox and access checks work the same for
// both; kind only changes the rules at creation. A direct chat stores its two users sorted (low < high) under a
// unique constraint, so a pair can only ever have one and find-or-create can't race into duplicates; groups leave
// both columns NULL (UNIQUE allows any number of NULLs) and are never deduplicated.
// last_activity_at is denormalized (set on create, each message, members added) so the inbox sorts without a
// MAX() per conversation. Members only see messages sent at or after their joined_at (history before they were
// added stays hidden); last_read_at starts at joined_at and drives unread counts.
// Deleting a message is a soft delete, like posts. On user delete: their participant rows go, their direct chats
// go (via the direct pair FKs), and their messages in groups stay with sender_id NULL so others' history reads
// coherently. The service checks a sender is a participant (an FK to participants would break when they leave).

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE conversations (
      conversation_id     uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
      kind                text           NOT NULL,
      direct_user_low_id  uuid           REFERENCES users (user_id) ON DELETE CASCADE,
      direct_user_high_id uuid           REFERENCES users (user_id) ON DELETE CASCADE,
      name                text,
      created_at          timestamptz(3) NOT NULL DEFAULT now(),
      last_activity_at    timestamptz(3) NOT NULL DEFAULT now(),
      CONSTRAINT conversations_kind                CHECK (kind IN ('direct', 'group')),
      -- Direct chats have both users, groups have neither.
      CONSTRAINT conversations_direct_pair_iff_direct CHECK (
        (kind = 'direct' AND direct_user_low_id IS NOT NULL AND direct_user_high_id IS NOT NULL)
        OR (kind = 'group' AND direct_user_low_id IS NULL AND direct_user_high_id IS NULL)
      ),
      -- Sorted, so Alice->Bob and Bob->Alice are the same pair; also rules out a chat with yourself.
      CONSTRAINT conversations_direct_pair_order   CHECK (direct_user_low_id < direct_user_high_id),
      CONSTRAINT conversations_direct_pair_key     UNIQUE (direct_user_low_id, direct_user_high_id),
      CONSTRAINT conversations_name_group_only     CHECK (name IS NULL OR kind = 'group'),
      CONSTRAINT conversations_name_length         CHECK (char_length(name) BETWEEN 1 AND 50)
    );

    -- The unique constraint covers the direct_user_low_id foreign key; this covers the high side, so deleting a
    -- user finds their direct chats either way.
    CREATE INDEX conversations_direct_user_high_id_idx ON conversations (direct_user_high_id)
      WHERE direct_user_high_id IS NOT NULL;

    CREATE TABLE conversation_participants (
      conversation_id uuid           NOT NULL REFERENCES conversations (conversation_id) ON DELETE CASCADE,
      user_id         uuid           NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
      joined_at       timestamptz(3) NOT NULL DEFAULT now(),
      last_read_at    timestamptz(3) NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_id, user_id)
    );

    -- A user's conversations (the inbox); also covers the user_id foreign key. The primary key covers
    -- "who is in this conversation" and the access check.
    CREATE INDEX conversation_participants_user_id_idx ON conversation_participants (user_id, conversation_id);

    CREATE TABLE messages (
      message_id      uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id uuid           NOT NULL REFERENCES conversations (conversation_id) ON DELETE CASCADE,
      sender_id       uuid           REFERENCES users (user_id) ON DELETE SET NULL,
      content         text,
      created_at      timestamptz(3) NOT NULL DEFAULT now(),
      deleted_at      timestamptz(3),
      CONSTRAINT messages_content_length   CHECK (char_length(content) BETWEEN 1 AND 1000),
      -- Live messages have content; deleted messages have none.
      CONSTRAINT messages_content_iff_live CHECK ((content IS NULL) = (deleted_at IS NOT NULL))
    );

    -- History (newest first, cursor on created_at + message_id), last-message previews and unread counts.
    -- Also covers the conversation_id foreign key.
    CREATE INDEX messages_conversation_id_created_at_idx
      ON messages (conversation_id, created_at DESC, message_id DESC);

    -- Covers the sender_id foreign key, so deleting a user doesn't scan every message.
    CREATE INDEX messages_sender_id_idx ON messages (sender_id);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS conversation_participants;
    DROP TABLE IF EXISTS conversations;
  `);
};
