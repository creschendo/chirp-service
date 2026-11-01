// Database access for the messages module.
// Owns conversations, conversation_participants and messages; queries join users read-only for public fields
// (userId, username, displayName). Every function takes an optional `db` (defaults to the pool) so a service can
// run it inside withTransaction. Functions take user ids, never usernames.
// "Visible" messages for a member are those with created_at >= their joined_at (earlier history stays hidden).
import { pool } from '../../db/index.js';

// --- Conversations ---

// POST /conversations with one other user. Returns the pair's direct chat, creating it if needed, as
// { conversationId, created }. The service adds both participants, in the same transaction, only when created is true.
// LEAST/GREATEST sort the ids in Postgres, so the order always matches conversations_direct_pair_order however the
// ids are written (JavaScript would compare upper and lower case hex differently). If a concurrent request is creating
// the same chat, the insert waits for it: on commit, DO NOTHING returns no row and the SELECT finds the chat (READ
// COMMITTED lets it see the newly committed row); on rollback, this insert goes ahead.
// Errors: 23503 unknown user (-> 404), 23514 conversations_direct_pair_order if both ids are equal (-> 400).
export async function findOrCreateDirect(userId, otherUserId, db = pool) {
  const { rows: inserted } = await db.query(
    `INSERT INTO conversations (kind, direct_user_low_id, direct_user_high_id)
     VALUES ('direct', LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))
     ON CONFLICT (direct_user_low_id, direct_user_high_id) DO NOTHING
     RETURNING conversation_id AS "conversationId"`,
    [userId, otherUserId],
  );
  if (inserted[0]) {
    return { conversationId: inserted[0].conversationId, created: true };
  }

  const { rows } = await db.query(
    `SELECT conversation_id AS "conversationId"
     FROM conversations
     WHERE direct_user_low_id = LEAST($1::uuid, $2::uuid)
       AND direct_user_high_id = GREATEST($1::uuid, $2::uuid)`,
    [userId, otherUserId],
  );
  return { conversationId: rows[0].conversationId, created: false };
}

// POST /conversations with two or more other users. Creates a group, always a new one (groups are never deduplicated),
// and returns { conversationId }. It has no members yet: the service adds them with addParticipants in the same
// transaction. Errors: 23514 conversations_name_length.
export async function createGroup({ name = null } = {}, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO conversations (kind, name)
     VALUES ('group', $1)
     RETURNING conversation_id AS "conversationId"`,
    [name],
  );
  return rows[0];
}

// Holds the conversation's row until the transaction ends, so membership changes to it run one at a time and a count
// taken afterwards is accurate (the group cap, and "last one out" on leave). Pass a transaction client.
// NO KEY UPDATE rather than UPDATE so other members' message inserts, whose foreign key only needs the row to keep
// existing, aren't blocked by it. Lock order: always the caller's participant row first (getMembership with lock), then
// this, the same order sendMessage takes them in, so the two can't deadlock.
// Returns true if the conversation exists, false if not (including if it was deleted while waiting for the lock).
export async function lockConversation(conversationId, db = pool) {
  const { rows } = await db.query(
    `SELECT 1
     FROM conversations
     WHERE conversation_id = $1
     FOR NO KEY UPDATE`,
    [conversationId],
  );
  return rows.length > 0;
}

// Hard-deletes a group whose last member just left; its participants and messages cascade. There's no undo, so the
// service must have checked the group is empty, in the same transaction. Direct chats are never deleted this way
// (they go when a user is deleted). Returns true if a group was deleted, false if there's no such group.
export async function deleteConversation(conversationId, db = pool) {
  const { rowCount } = await db.query(
    `DELETE FROM conversations
     WHERE conversation_id = $1 AND kind = 'group'`,
    [conversationId],
  );
  return rowCount > 0;
}

// Moves a conversation's last_activity_at, the inbox's sort key, up to `at` (a Date; null means the database's
// now()), never backwards, so concurrent sends can't undo each other. sendMessage passes the new message's createdAt;
// adding members passes null, so the group surfaces in the new members' inboxes.
// Returns true if the conversation exists (whether or not the time moved), false if not. A malformed id throws 22P02,
// so routes validate ids first.
export async function touchConversation(conversationId, at = null, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE conversations
     SET last_activity_at = GREATEST(last_activity_at, COALESCE($2::timestamptz, now()))
     WHERE conversation_id = $1`,
    [conversationId, at],
  );
  return rowCount > 0;
}

// PATCH /conversations/:conversation_id. Sets a group's name; null clears it. Returns true if the group was updated,
// false if there's no such conversation or it's a direct chat (those have no name). No access check: the service
// checks membership first and tells the cases apart. Errors: 23514 conversations_name_length. A malformed id throws
// 22P02, so routes validate ids first.
export async function renameGroup(conversationId, name, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE conversations
     SET name = $2
     WHERE conversation_id = $1 AND kind = 'group'`,
    [conversationId, name],
  );
  return rowCount > 0;
}

// --- Participants ---

// The access check behind every per-conversation route. Returns { conversationId, kind, name, joinedAt, lastReadAt },
// or null if the conversation doesn't exist OR the user isn't in it (the service 404s for both, so existence isn't
// leaked). A malformed id throws 22P02, so routes validate ids first.
// lock: true holds the user's participant row until the transaction ends, so a concurrent leave can't slip in before
// the work that depends on the check; pass a transaction client with it. NO KEY UPDATE rather than SHARE because
// sendMessage goes on to update this row (markRead): two sends by one user holding SHARE would each wait for the
// other to release it and deadlock. This way they take turns, and other members' sends aren't affected.
export async function getMembership(conversationId, userId, { lock = false } = {}, db = pool) {
  const { rows } = await db.query(
    `SELECT c.conversation_id AS "conversationId",
            c.kind,
            c.name,
            p.joined_at       AS "joinedAt",
            p.last_read_at    AS "lastReadAt"
     FROM conversation_participants p
     JOIN conversations c ON c.conversation_id = p.conversation_id
     WHERE p.conversation_id = $1 AND p.user_id = $2
     ${lock ? 'FOR NO KEY UPDATE OF p' : ''}`,
    [conversationId, userId],
  );
  return rows[0] ?? null;
}

// Everyone in a conversation, including the caller, for the conversation view and to pick realtime recipients.
// Earliest joined first, with user_id breaking ties (the same order as the inbox's participants).
// Returns [{ userId, username, displayName, joinedAt }]; [] if the conversation doesn't exist. No access check: the
// service checks membership first. Uses the conversation_participants primary key.
export async function listParticipants(conversationId, db = pool) {
  const { rows } = await db.query(
    `SELECT u.user_id      AS "userId",
            u.username,
            u.display_name AS "displayName",
            p.joined_at    AS "joinedAt"
     FROM conversation_participants p
     JOIN users u ON u.user_id = p.user_id
     WHERE p.conversation_id = $1
     ORDER BY p.joined_at, u.user_id`,
    [conversationId],
  );
  return rows;
}

// Adds users to a conversation, in one statement: creating a conversation, and POST
// /conversations/:conversation_id/participants. joined_at and last_read_at both default to now(), so history from
// before now stays hidden and nothing starts out unread. Existing members and repeated ids are skipped, so their
// joined_at doesn't change. Returns the ids actually added, in no particular order. No access or cap checks: the
// service does those first. Errors: 23503 unknown user or conversation (-> 404).
export async function addParticipants(conversationId, userIds, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO conversation_participants (conversation_id, user_id)
     SELECT $1, unnest($2::uuid[])
     ON CONFLICT DO NOTHING
     RETURNING user_id AS "userId"`,
    [conversationId, userIds],
  );
  return rows.map((row) => row.userId);
}

// DELETE /conversations/:conversation_id/participants/me. Removes the user from the conversation; their messages stay.
// Being re-added later creates a new row with a new joined_at, so history from before then is hidden again.
// Returns true if removed, false if they weren't a member. The service decides who may leave (not direct chats) and
// deletes a group its last member just left. A malformed id throws 22P02, so routes validate ids first.
export async function removeParticipant(conversationId, userId, db = pool) {
  const { rowCount } = await db.query(
    `DELETE FROM conversation_participants
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  return rowCount > 0;
}

// How many members a conversation has: the cap check when adding members, and "last one out" on leave. 0 if the
// conversation doesn't exist. Uses the conversation_participants primary key.
export async function countParticipants(conversationId, db = pool) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM conversation_participants
     WHERE conversation_id = $1`,
    [conversationId],
  );
  return rows[0].count;
}

// --- Messages ---

// Message views: a message as the API returns it, with its sender. Every query that returns messages to clients
// selects MESSAGE_VIEW_COLUMNS from a source aliased m (the messages table, or createMessage's inserted row) plus
// SENDER_JOIN, with rows mapped by toMessageView, so the shape is the same everywhere. LEFT JOIN because a deleted
// account leaves sender_id NULL.
const MESSAGE_VIEW_COLUMNS = `
  m.message_id, m.conversation_id, m.content, m.created_at, m.deleted_at,
  s.user_id AS s_user_id, s.username AS s_username, s.display_name AS s_display_name
`;
const SENDER_JOIN = `LEFT JOIN users s ON s.user_id = m.sender_id`;
const MESSAGE_VIEW_SELECT = `SELECT ${MESSAGE_VIEW_COLUMNS} FROM messages m ${SENDER_JOIN}`;

// A deleted message keeps its sender (so the client can still place it on the right side of the chat) but loses
// its content. sender is null if the sender's account was deleted.
function toMessageView(row) {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    sender: row.s_user_id
      ? { userId: row.s_user_id, username: row.s_username, displayName: row.s_display_name }
      : null,
    content: row.content,
    createdAt: row.created_at,
    deleted: row.deleted_at !== null,
  };
}

// POST /conversations/:conversation_id/messages. Inserts a message and returns its message view, the same shape
// listMessages returns. One round trip: the insert runs in a CTE and the outer SELECT joins the sender onto the new
// row. Only inserts; the service checks membership first and, in the same transaction, bumps the conversation's
// last_activity_at and the sender's read state. Errors: 23514 messages_content_length / messages_content_iff_live,
// 23503 unknown conversation or sender.
export async function createMessage({ conversationId, senderId, content }, db = pool) {
  const { rows } = await db.query(
    `WITH m AS (
       INSERT INTO messages (conversation_id, sender_id, content)
       VALUES ($1, $2, $3)
       RETURNING *
     )
     SELECT ${MESSAGE_VIEW_COLUMNS} FROM m ${SENDER_JOIN}`,
    [conversationId, senderId, content],
  );
  return toMessageView(rows[0]);
}

// GET /conversations/:conversation_id/messages. A conversation's messages as message views, newest first so chat
// pages backwards from the bottom (the client reverses them for display). Only messages at or after visibleFrom
// (the viewer's joined_at, a Date) are returned, so history from before a member joined stays hidden. Deleted
// messages are included, shown as deleted. [] if there are none; membership is checked by the service first.
// cursor: the last row's { createdAt, messageId } from the previous page; null for the first page. Descending
// order, so the next page is the rows *before* the cursor (<), with message_id breaking ties between equal
// timestamps. Uses messages_conversation_id_created_at_idx.
export async function listMessages(conversationId, { visibleFrom, limit, cursor = null }, db = pool) {
  const { rows } = await db.query(
    `${MESSAGE_VIEW_SELECT}
     WHERE m.conversation_id = $1
       AND m.created_at >= $2
       AND ($4::timestamptz IS NULL OR (m.created_at, m.message_id) < ($4, $5::uuid))
     ORDER BY m.created_at DESC, m.message_id DESC
     LIMIT $3`,
    [conversationId, visibleFrom, limit, cursor?.createdAt ?? null, cursor?.messageId ?? null],
  );
  return rows.map(toMessageView);
}

// The message's own columns, for the service's delete checks (exists? in this conversation? visible to the
// caller? whose? already deleted?), not for responses: no content and no sender details. Returns null if the
// message doesn't exist; a deleted message is still returned, with deletedAt set. senderId is null if the
// sender's account was deleted. A malformed id throws 22P02, so routes validate ids first.
export async function getMessageById(messageId, db = pool) {
  const { rows } = await db.query(
    `SELECT message_id      AS "messageId",
            conversation_id AS "conversationId",
            sender_id       AS "senderId",
            created_at      AS "createdAt",
            deleted_at      AS "deletedAt"
     FROM messages
     WHERE message_id = $1`,
    [messageId],
  );
  return rows[0] ?? null;
}

// DELETE /conversations/:conversation_id/messages/:message_id. Soft delete ("delete for everyone"): the row stays
// so history keeps its place and shows "This message was deleted", but content is cleared
// (messages_content_iff_live requires both changes together). Only the sender's own, live message changes:
// returns true if it was deleted now, false if it's missing, someone else's, or already deleted. The service uses
// getMessageById first to tell those apart (404 / 403 / no-op). A malformed id throws 22P02, so routes validate
// ids first.
export async function softDeleteMessage(messageId, senderId, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE messages
     SET deleted_at = now(), content = NULL
     WHERE message_id = $1 AND sender_id = $2 AND deleted_at IS NULL`,
    [messageId, senderId],
  );
  return rowCount > 0;
}

// --- Inbox ---

// GET /conversations. The user's conversations, most recent activity first. Each item:
//   { conversationId, kind, name, participants, lastMessage, unreadCount, lastActivityAt }
// - participants: everyone else in the chat, earliest joined first, as { userId, username, displayName }.
// - lastMessage: the newest message visible to the user, as a message view (a deleted one comes back as deleted), or
//   null if there is none.
// - unreadCount: messages after the user's last_read_at, not their own and not deleted. last_read_at starts at
//   joined_at and only moves forward, so messages from before they joined are never counted.
// A direct chat with no visible messages is left out, so opening a DM without sending anything doesn't put an empty
// chat in either inbox (the opener's client navigates to it directly). Groups show as soon as you're added.
// The outer query keeps lm's column names, so a row is what toMessageView reads. conversation_id comes from c instead
// of lm, so it's still set when there's no last message.
// cursor: the last row's { lastActivityAt, conversationId } from the previous page; null for the first page.
// The sort spans a join, so no index covers it; fine at this scale (it only reads one user's conversations).
export async function listConversations(userId, { limit, cursor = null }, db = pool) {
  const { rows } = await db.query(
    `SELECT c.conversation_id, c.kind, c.name, c.last_activity_at,
            others.participants,
            lm.message_id, lm.content, lm.created_at, lm.deleted_at,
            lm.s_user_id, lm.s_username, lm.s_display_name,
            unread.unread_count
     FROM conversation_participants p
     JOIN conversations c ON c.conversation_id = p.conversation_id
     CROSS JOIN LATERAL (
       SELECT COALESCE(
                json_agg(
                  json_build_object('userId', u.user_id, 'username', u.username, 'displayName', u.display_name)
                  ORDER BY op.joined_at, u.user_id
                ),
                '[]'::json
              ) AS participants
       FROM conversation_participants op
       JOIN users u ON u.user_id = op.user_id
       WHERE op.conversation_id = p.conversation_id AND op.user_id <> p.user_id
     ) others
     LEFT JOIN LATERAL (
       ${MESSAGE_VIEW_SELECT}
       WHERE m.conversation_id = p.conversation_id AND m.created_at >= p.joined_at
       ORDER BY m.created_at DESC, m.message_id DESC
       LIMIT 1
     ) lm ON true
     CROSS JOIN LATERAL (
       SELECT COUNT(*)::int AS unread_count
       FROM messages m
       WHERE m.conversation_id = p.conversation_id
         AND m.created_at > p.last_read_at
         AND m.sender_id IS DISTINCT FROM p.user_id
         AND m.deleted_at IS NULL
     ) unread
     WHERE p.user_id = $1
       AND (c.kind = 'group' OR lm.message_id IS NOT NULL)
       AND ($3::timestamptz IS NULL OR (c.last_activity_at, c.conversation_id) < ($3, $4::uuid))
     ORDER BY c.last_activity_at DESC, c.conversation_id DESC
     LIMIT $2`,
    [userId, limit, cursor?.lastActivityAt ?? null, cursor?.conversationId ?? null],
  );
  return rows.map((row) => ({
    conversationId: row.conversation_id,
    kind: row.kind,
    name: row.name,
    participants: row.participants,
    lastMessage: row.message_id ? toMessageView(row) : null,
    unreadCount: row.unread_count,
    lastActivityAt: row.last_activity_at,
  }));
}

// --- Read state ---

// PUT /conversations/:conversation_id/read, and the sender's own read state when sending. Moves the member's
// last_read_at up to `at` (a Date; null means the database's now()), never backwards, so a stale or out-of-order
// call can't bring old messages back as unread. PUT /read passes null; sendMessage passes the new message's
// createdAt, so your own messages never count as unread.
// Returns true if the user is a member (whether or not the time moved), false if not. A malformed id throws 22P02,
// so routes validate ids first.
export async function markRead(conversationId, userId, at = null, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE conversation_participants
     SET last_read_at = GREATEST(last_read_at, COALESCE($3::timestamptz, now()))
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId, at],
  );
  return rowCount > 0;
}
