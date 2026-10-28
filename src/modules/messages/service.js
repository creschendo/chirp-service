// Business logic for the messages module.
// Anyone can message anyone (no follow requirement). Non-members get 404 for every per-conversation route, the
// same as a conversation that doesn't exist. Realtime emits happen after the transaction commits, through
// src/realtime/ (milestone 5); until that exists, these functions just skip the emit.
//
// PLAN (not implemented yet):
//
// MAX_GROUP_SIZE = 20, counting the creator.
//
// createConversation(userId, { userIds, name = null })
//   POST /conversations. Dedupe userIds; including yourself -> 400.
//   - One other user, no name -> direct: store.findOrCreateDirect in withTransaction, adding both participants
//     if it was created. Returns { conversation, created } (the route sends 201 or 200). A name with one other
//     user -> 400 (direct chats have no name).
//   - Two or more -> group: over MAX_GROUP_SIZE -> 400. createGroup + addParticipants (creator included) in one
//     transaction. Always new, never deduplicated. Returns { conversation, created: true }.
//   Unknown user ids surface as 23503 from the inserts -> 404 'User not found'.
//   Later: emit conversation:new to the other members of a new group.
//
// getConversation(userId, conversationId)
//   GET /conversations/:id. getMembership (null -> null, the route 404s), plus listParticipants. Returns
//   { conversationId, kind, name, participants, createdAt, lastReadAt }.
//
// listConversations(userId, { limit, cursor })
//   GET /conversations. store.listConversations with limit + 1, toPage with
//   { lastActivityAt, conversationId } as the cursor.
//
// listMessages(userId, conversationId, { limit, cursor })
//   GET /conversations/:id/messages. getMembership (null -> null, 404), then store.listMessages with
//   visibleFrom = joinedAt, limit + 1, toPage with { createdAt, messageId }.
//
// sendMessage(userId, conversationId, content)
//   POST /conversations/:id/messages. In withTransaction: getMembership FOR SHARE (null -> 404), createMessage,
//   touchConversation(created_at), markRead for the sender at created_at. After commit: emit message:new with the
//   message view to every other participant's user room. Returns the message view.
//
// deleteMessage(userId, conversationId, messageId)
//   DELETE /conversations/:id/messages/:message_id. Not a member, message missing, in another conversation, or
//   before your joined_at -> 404. Someone else's -> 403 (checked before "already deleted", like posts). Already
//   deleted -> no-op. After a real delete: emit message:deleted { conversationId, messageId } to the others.
//
// markRead(userId, conversationId)
//   PUT /conversations/:id/read. getMembership (null -> 404), store.markRead at now(). Idempotent.
//   Later: emit conversation:read to the user's own room so their other tabs clear the badge.
//
// addMembers(userId, conversationId, userIds)
//   POST /conversations/:id/participants. Any member can add. Not a member -> 404, direct chat -> 400, current
//   count + new ids over MAX_GROUP_SIZE -> 400. In one transaction: addParticipants (new members' joined_at =
//   now(), so earlier history stays hidden from them) and touchConversation. Already-members are ignored.
//   Returns the updated participant list. Later: emit conversation:new to the added users, and
//   conversation:updated to the existing members.
//
// leaveConversation(userId, conversationId)
//   DELETE /conversations/:id/participants/me. Not a member -> 404, direct chat -> 400. In one transaction:
//   removeParticipant; if countParticipants is now 0, deleteConversation. Rejoining later (being re-added) gets a
//   new joined_at, so messages from before then are hidden again.
//
// renameGroup(userId, conversationId, name)
//   PATCH /conversations/:id. Any member. Not a member -> 404, direct chat -> 400. null clears the name.
//   Later: emit conversation:updated to the members.
//
// Deferred: editing messages, group roles (owner/admin, who may add or remove others), removing other members,
// DM notifications, typing indicators and read receipts shown to others.
