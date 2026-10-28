// HTTP routes and thin handlers for the messages module (validate input, call the service, send the response).
// To be mounted at /conversations. Every route requires auth. Messages are sent over REST; delivery to the other
// participants goes out over Socket.IO afterwards (see service.js). Non-members get 404, never 403.
//
// PLAN (not implemented yet):
//
// POST /conversations { userIds, name? } -> one other user: find-or-create a direct chat, 201 if new or 200 if it
//   already existed; two or more: new group, 201. Body is the conversation view.
//   400 invalid input, yourself in userIds, name on a direct chat, over the group cap. 401. 404 unknown user.
//
// GET /conversations ?limit=&cursor= -> 200 + { items, nextCursor }: the inbox, most recent activity first. Each
//   item: { conversationId, kind, name, participants (others), lastMessage | null, unreadCount, lastActivityAt }.
//   Direct chats with no messages yet are left out. 400 invalid query, 401.
//
// GET /conversations/:conversation_id -> 200 + { conversationId, kind, name, participants, createdAt,
//   lastReadAt }. 400 invalid id, 401, 404 not found or not a member.
//
// GET /conversations/:conversation_id/messages ?limit=&cursor= -> 200 + { items, nextCursor }: newest first, only
//   messages since you joined. Deleted messages appear as deleted: true. 400, 401, 404.
//
// POST /conversations/:conversation_id/messages { content } -> 201 + message. 400 invalid content, 401, 404.
//
// DELETE /conversations/:conversation_id/messages/:message_id -> 204, soft delete; already deleted is still 204.
//   400 invalid id, 401, 403 not your message, 404.
//
// PUT /conversations/:conversation_id/read -> 204, idempotent. 400, 401, 404.
//
// POST /conversations/:conversation_id/participants { userIds } -> 200 + participant list. Groups only.
//   400 invalid input, direct chat, over the cap. 401. 404 not a member or unknown user.
//
// DELETE /conversations/:conversation_id/participants/me -> 204. Groups only. 400 direct chat, 401, 404.
//
// PATCH /conversations/:conversation_id { name } -> 200 + conversation view. Groups only; null clears the name.
//   400 invalid input or direct chat, 401, 404.
//
// No default export until the routes exist (app.js mounts only implemented modules).
