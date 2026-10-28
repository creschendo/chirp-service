// Database access for the messages module.
// Owns conversations, conversation_participants and messages; queries join users read-only for public fields
// (userId, username, displayName). Every function takes an optional `db` (defaults to the pool) so a service can
// run it inside withTransaction. Functions take user ids, never usernames.
// "Visible" messages for a member are those with created_at >= their joined_at (earlier history stays hidden).
//
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
//
// listMessages(conversationId, { visibleFrom, limit, cursor = null }, db)
//   GET /conversations/:id/messages. messages LEFT JOIN users on sender_id (a deleted account leaves sender null),
//   WHERE created_at >= visibleFrom (the viewer's joined_at), newest first so chat pages backwards from the bottom.
//   cursor: the last row's { createdAt, messageId }; next page is rows *before* it (<), message_id breaking ties.
//   Uses messages_conversation_id_created_at_idx. Deleted messages are included as { deleted: true }, no content.
//   Returns [{ messageId, conversationId, sender: { userId, username, displayName } | null, content,
//   createdAt, deleted }].
//
// getMessageById(messageId, db)
//   The message's own columns for the service's delete checks: { messageId, conversationId, senderId, createdAt,
//   deletedAt }, or null.
//
// softDeleteMessage(messageId, senderId, db)
//   UPDATE messages SET deleted_at = now(), content = NULL WHERE message_id = $1 AND sender_id = $2 AND
//   deleted_at IS NULL. Returns true if deleted now, false otherwise (the service tells the cases apart first).
//
// --- Read state ---
//
// markRead(conversationId, userId, at, db)
//   UPDATE conversation_participants SET last_read_at = GREATEST(last_read_at, $3). Never moves backwards.
//   PUT /read passes now(); sending passes the new message's created_at (your own messages count as read).
