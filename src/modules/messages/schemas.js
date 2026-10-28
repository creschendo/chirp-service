// Zod validation schemas for the messages module.
//
// PLAN (not implemented yet):
//
// createConversationSchema: POST /conversations. strictObject {
//   userIds: array of z.uuid('Invalid user id'), 1 to MAX_GROUP_SIZE - 1 (the creator isn't listed),
//   name: optional, trimmed, 1–50 (conversations_name_length)
// }. Self, duplicates and "name on a direct chat" are checked in the service.
//
// conversationIdParamSchema: /conversations/:conversation_id routes. z.uuid, .describe('Invalid conversation id').
//
// messageParamsSchema: /conversations/:conversation_id/messages/:message_id. Both uuids,
//   .describe('Invalid id').
//
// sendMessageSchema: POST /conversations/:id/messages. strictObject { content: trimmed, 1–1000
//   (messages_content_length) } with 'Message cannot be empty' / 'Message must be at most 1000 characters'.
//
// addMembersSchema: POST /conversations/:id/participants. strictObject { userIds: array of uuid, at least 1 }.
//
// renameGroupSchema: PATCH /conversations/:id. strictObject { name: trimmed 1–50, or null to clear }.
//
// conversationsQuerySchema: GET /conversations. pageQuerySchema(z.object({ lastActivityAt: z.iso.datetime(),
//   conversationId: z.uuid() })).
//
// messagesQuerySchema: GET /conversations/:id/messages. pageQuerySchema(z.object({ createdAt: z.iso.datetime(),
//   messageId: z.uuid() })).
