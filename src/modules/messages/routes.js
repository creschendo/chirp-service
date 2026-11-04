// HTTP routes and thin handlers for the messages module (validate input, call the service, send the response).
// Mounted at /conversations. Every route requires auth. Messages are sent over REST; delivery to the other
// participants goes out over Socket.IO afterwards (see service.js). Non-members get 404, never 403.
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as service from './service.js';
import {
  addMembersSchema,
  conversationIdParamSchema,
  conversationsQuerySchema,
  createConversationSchema,
  messageParamsSchema,
  messagesQuerySchema,
  renameGroupSchema,
  sendMessageSchema,
} from './schemas.js';

const router = Router();

// POST /conversations (auth) { userIds, name? } -> the conversation view. One other user: their direct chat with you,
// 201 if it was just created or 200 if it already existed. Two or more: a new group, always 201.
// 400 invalid input, yourself in userIds, a name on a direct chat, or over the group cap; 401 not logged in;
// 404 unknown user.
router.post('/', requireAuth, validate({ body: createConversationSchema }), async (req, res) => {
  // The 400s the schema can't catch and the 404 are thrown by the service.
  const { conversation, created } = await service.createConversation(req.userId, req.valid.body);
  res.status(created ? 201 : 200).json(conversation);
});

// GET /conversations (auth) ?limit=1–100 (default 20)&cursor= -> 200 + { items, nextCursor }: the caller's inbox,
// most recent activity first (see src/pagination.js). Each item: { conversationId, kind, name, participants (the
// others), lastMessage | null, unreadCount, lastActivityAt }. Direct chats with no messages yet are left out.
// 400 invalid query, 401 not logged in.
router.get('/', requireAuth, validate({ query: conversationsQuerySchema }), async (req, res) => {
  res.json(await service.listConversations(req.userId, req.valid.query));
});

// GET /conversations/:conversation_id (auth) -> 200 + the conversation view: { conversationId, kind, name,
// participants (everyone, the caller included), createdAt, lastReadAt (the caller's) }.
// 400 invalid id, 401 not logged in, 404 not found or not a member (the same 404, so existence isn't leaked).
router.get('/:conversation_id', requireAuth, validate({ params: conversationIdParamSchema }), async (req, res) => {
  const conversation = await service.getConversation(req.userId, req.valid.params.conversation_id);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  res.json(conversation);
});

// GET /conversations/:conversation_id/messages (auth) ?limit=1–100 (default 20)&cursor= -> 200 + { items, nextCursor }:
// message views, newest first (see src/pagination.js), only those sent since the caller joined. Deleted messages
// appear as deleted: true with no content. 400 invalid id or query, 401 not logged in, 404 not found or not a member.
router.get(
  '/:conversation_id/messages',
  requireAuth,
  validate({ params: conversationIdParamSchema, query: messagesQuerySchema }),
  async (req, res) => {
    const page = await service.listMessages(req.userId, req.valid.params.conversation_id, req.valid.query);
    if (!page) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json(page);
  },
);

// POST /conversations/:conversation_id/messages (auth) { content } -> 201 + the message view. The sender comes from the
// token. The conversation moves to the top of every member's inbox, and it's marked read for the sender.
// 400 invalid id or content, 401 not logged in, 404 not found or not a member.
router.post(
  '/:conversation_id/messages',
  requireAuth,
  validate({ params: conversationIdParamSchema, body: sendMessageSchema }),
  async (req, res) => {
    // Not found or not a member (404) is thrown by the service.
    const message = await service.sendMessage(req.userId, req.valid.params.conversation_id, req.valid.body.content);
    res.status(201).json(message);
  },
);

// DELETE /conversations/:conversation_id/messages/:message_id (auth, sender only) -> 204; soft delete, for everyone.
// Deleting your own already-deleted message is still 204. 400 invalid id, 401 not logged in, 403 not your message,
// 404 not a member, or the message doesn't exist, is in another conversation, or is from before you joined.
router.delete(
  '/:conversation_id/messages/:message_id',
  requireAuth,
  validate({ params: messageParamsSchema }),
  async (req, res) => {
    // Not found (404) and not yours (403) are thrown by the service.
    const { conversation_id: conversationId, message_id: messageId } = req.valid.params;
    await service.deleteMessage(req.userId, conversationId, messageId);
    res.status(204).end();
  },
);

// PUT /conversations/:conversation_id/read (auth) -> 204: everything up to now is read for the caller, clearing the
// inbox's unread count. Idempotent. 400 invalid id, 401 not logged in, 404 not found or not a member.
router.put('/:conversation_id/read', requireAuth, validate({ params: conversationIdParamSchema }), async (req, res) => {
  // Not found or not a member (404) is thrown by the service.
  await service.markRead(req.userId, req.valid.params.conversation_id);
  res.status(204).end();
});

// POST /conversations/:conversation_id/participants (auth) { userIds } -> 200 + the updated participant list. Groups
// only; any member can add. Users already in the group are skipped, so repeating a request is harmless. New members
// only see messages sent from now on. 400 invalid input, a direct chat, or over the group cap (nobody is added);
// 401 not logged in; 404 not found or not a member ('Conversation not found'), or an unknown user ('User not found').
router.post(
  '/:conversation_id/participants',
  requireAuth,
  validate({ params: conversationIdParamSchema, body: addMembersSchema }),
  async (req, res) => {
    // The 400s the schema can't catch and both 404s are thrown by the service.
    const participants = await service.addMembers(req.userId, req.valid.params.conversation_id, req.valid.body.userIds);
    res.json(participants);
  },
);

// DELETE /conversations/:conversation_id/participants/me (auth) -> 204: the caller leaves the group. Their messages
// stay. The last member out deletes the group. Being re-added later only shows messages from then on.
// 400 invalid id or a direct chat, 401 not logged in, 404 not found or not a member (including already left).
router.delete(
  '/:conversation_id/participants/me',
  requireAuth,
  validate({ params: conversationIdParamSchema }),
  async (req, res) => {
    // Not found or not a member (404) and a direct chat (400) are thrown by the service.
    await service.leaveConversation(req.userId, req.valid.params.conversation_id);
    res.status(204).end();
  },
);

// PATCH /conversations/:conversation_id (auth) { name } -> 200 + the conversation view with the new name. Groups only;
// any member can rename, and null clears the name. 400 invalid id or input, or a direct chat; 401 not logged in;
// 404 not found or not a member.
router.patch(
  '/:conversation_id',
  requireAuth,
  validate({ params: conversationIdParamSchema, body: renameGroupSchema }),
  async (req, res) => {
    // Not found or not a member (404) and a direct chat (400) are thrown by the service.
    const conversation = await service.renameGroup(req.userId, req.valid.params.conversation_id, req.valid.body.name);
    res.json(conversation);
  },
);

// Deferred: editing messages, removing other members, group roles, typing indicators and read receipts (see
// service.js).

export default router;
