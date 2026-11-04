// Zod validation schemas for the messages module.
import { z } from 'zod';
import { pageQuerySchema } from '../../pagination.js';

// Most members a group can have, counting its creator. The service enforces it too: here it only bounds the request,
// since the request doesn't list the creator and may repeat ids.
export const MAX_GROUP_SIZE = 20;

// A group's name. Limits match conversations_name_length; trimmed first, so whitespace-only names are rejected as
// empty.
const groupNameSchema = z
  .string()
  .trim()
  .min(1, 'Group name cannot be empty')
  .max(50, 'Group name must be at most 50 characters');

// POST /conversations. userIds are the other users: one makes a direct chat, two or more a group. Unknown keys are
// rejected. The service removes repeated ids and rejects yourself in the list or a name on a direct chat.
export const createConversationSchema = z.strictObject({
  userIds: z
    .array(z.uuid('Invalid user id'))
    .min(1, 'Pick at least one user')
    .max(MAX_GROUP_SIZE - 1, `A group can have at most ${MAX_GROUP_SIZE} members`),
  name: groupNameSchema.optional(),
});

// PATCH /conversations/:conversation_id. A group's new name, or null to clear it. name is required, so an empty body
// is a 400 instead of a no-op. Unknown keys are rejected.
export const renameGroupSchema = z.strictObject({
  name: groupNameSchema.nullable(),
});

// POST /conversations/:conversation_id/participants. The users to add. Unknown keys are rejected. The caller is
// already a member, so more than MAX_GROUP_SIZE - 1 can never fit; the service checks the real count, which skips
// anyone already in the group.
export const addMembersSchema = z.strictObject({
  userIds: z
    .array(z.uuid('Invalid user id'))
    .min(1, 'Pick at least one user')
    .max(MAX_GROUP_SIZE - 1, `A group can have at most ${MAX_GROUP_SIZE} members`),
});

// /conversations/:conversation_id routes.
// .describe() sets the 400 message validate() sends when this fails.
export const conversationIdParamSchema = z
  .object({
    conversation_id: z.uuid('Invalid conversation id'),
  })
  .describe('Invalid conversation id');

// /conversations/:conversation_id/messages/:message_id routes. One description for both ids, since validate() sends a
// single message per part; the issues still say which one failed.
export const messageParamsSchema = z
  .object({
    conversation_id: z.uuid('Invalid conversation id'),
    message_id: z.uuid('Invalid message id'),
  })
  .describe('Invalid id');

// POST /conversations/:conversation_id/messages. Unknown keys are rejected. Content limits match
// messages_content_length; trimmed first, so whitespace-only content is rejected as empty.
export const sendMessageSchema = z.strictObject({
  content: z.string().trim().min(1, 'Message cannot be empty').max(1000, 'Message must be at most 1000 characters'),
});

// GET /conversations: ?limit=&cursor=. The cursor holds the last conversation's sort keys (most recent activity first).
export const conversationsQuerySchema = pageQuerySchema(
  z.object({
    lastActivityAt: z.iso.datetime(),
    conversationId: z.uuid(),
  }),
);

// GET /conversations/:conversation_id/messages: ?limit=&cursor=. The cursor holds the last message's sort keys
// (newest first).
export const messagesQuerySchema = pageQuerySchema(
  z.object({
    createdAt: z.iso.datetime(),
    messageId: z.uuid(),
  }),
);
