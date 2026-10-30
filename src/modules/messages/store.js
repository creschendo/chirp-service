// Database access for the messages module.
// Owns conversations, conversation_participants and messages; queries join users read-only for public fields
// (userId, username, displayName). Every function takes an optional `db` (defaults to the pool) so a service can
// run it inside withTransaction. Functions take user ids, never usernames.
// "Visible" messages for a member are those with created_at >= their joined_at (earlier history stays hidden).
import { pool } from '../../db/index.js';

// PLAN (not implemented yet):
//
// --- Conversations ---
//
// findOrCreateDirect(userId, otherUserId, db)
//   Sorts the two ids into (low, high), then INSERT INTO conversations (kind, direct_user_low_id,
//   direct_user_high_id) VALUES ('direct', ...) ON CONFLICT (direct_user_low_id, direct_user_high_id) DO NOTHING
//   RETURNING conversation_id. No row back -> SELECT it by the pair. Under READ COMMITTED a racing insert waits
//   for the winner to commit, so the follow-up SELECT always finds it.
//   Returns { conversationId, created }. The service adds both participants only when created is true.
//   Errors: 23503 unknown user (-> 404), 23514 conversations_direct_pair_order if both ids are equal (-> 400).
//
// createGroup({ name = null }, db)
//   INSERT INTO conversations (kind, name) VALUES ('group', $1). Returns { conversationId }.
//
// addParticipants(conversationId, userIds, db)
//   One INSERT ... SELECT unnest($2::uuid[]) ON CONFLICT DO NOTHING RETURNING user_id. joined_at and
//   last_read_at both default to now(). Returns the ids actually added (already-members are skipped).
//   Errors: 23503 unknown user (-> 404).
//
// removeParticipant(conversationId, userId, db)
//   DELETE the participant row. Returns true if removed, false if they weren't a member.
//
// countParticipants(conversationId, db)
//   COUNT(*)::int over the primary key. The cap check when adding members, and "last one out" on leave.
//
// deleteConversation(conversationId, db)
//   Hard delete; participants and messages cascade. Only for a group whose last member just left.
//
// touchConversation(conversationId, at, db)
//   UPDATE conversations SET last_activity_at = GREATEST(last_activity_at, $2). On each message and when members
//   are added. GREATEST so concurrent sends can't move it backwards.
//
// renameGroup(conversationId, name, db)
//   UPDATE conversations SET name = $2 WHERE kind = 'group'. name null clears it. Returns true if updated.
//
// --- Access and views ---
//
// getMembership(conversationId, userId, db)
//   The access check behind every per-conversation route. conversations JOIN conversation_participants on the
//   primary key. Returns { conversationId, kind, name, joinedAt, lastReadAt }, or null if the conversation
//   doesn't exist OR the user isn't in it (the service 404s for both, so existence isn't leaked).
//   Pass a transaction client with FOR SHARE when sending, so a concurrent leave can't slip in between.
//
// listParticipants(conversationId, db)
//   conversation_participants JOIN users. Returns [{ userId, username, displayName, joinedAt }], oldest member
//   first. Used by the conversation view and to pick realtime recipients.
//
// listConversations(userId, { limit, cursor = null }, db)
//   GET /conversations, the inbox. From the user's participant rows (conversation_participants_user_id_idx),
//   JOIN conversations, then per row:
//     - participants: everyone else in the chat (a json_agg subquery; map timestamps back to Dates, or select
//       them flat like posts/views.js if any are needed)
//     - lastMessage: LATERAL newest visible message (messages_conversation_id_created_at_idx, LIMIT 1), with its
//       sender; deleted ones come back as deleted with no content
//     - unreadCount: LATERAL COUNT(*) of messages with created_at > last_read_at, sender_id IS DISTINCT FROM me,
//       deleted_at IS NULL
//   Filter: kind = 'group' OR lastMessage exists, so opening a DM without sending anything doesn't put an empty
//   chat in either inbox (the opener's client navigates to it directly). Groups show as soon as you're added.
//   Order: last_activity_at DESC, conversation_id DESC. cursor: the last row's { lastActivityAt, conversationId }.
//   The sort spans a join, so no index covers it; fine at this scale (it only reads one user's conversations).
//
// --- Messages ---
//
// createMessage({ conversationId, senderId, content }, db)
//   INSERT ... RETURNING the message with its created_at. Returns the message view (see listMessages).
//   The service has already checked membership. Errors: 23514 messages_content_length.

// --- Messages ---

// Message views: a message as the API returns it, with its sender. Every query that returns messages to clients is
// MESSAGE_VIEW_SELECT + its own WHERE / ORDER BY / LIMIT, with rows mapped by toMessageView, so the shape is the
// same everywhere. LEFT JOIN because a deleted account leaves sender_id NULL.
const MESSAGE_VIEW_SELECT = `
  SELECT m.message_id, m.conversation_id, m.content, m.created_at, m.deleted_at,
         s.user_id AS s_user_id, s.username AS s_username, s.display_name AS s_display_name
  FROM messages m
  LEFT JOIN users s ON s.user_id = m.sender_id
`;

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
