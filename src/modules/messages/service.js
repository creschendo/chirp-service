// Business logic for the messages module.
// Anyone can message anyone (no follow requirement). Non-members get 404 for every per-conversation route, the
// same as a conversation that doesn't exist. Realtime emits happen after the transaction commits, through
// src/realtime/ (milestone 5); until that exists, these functions just skip the emit.
import * as store from './store.js';
import { withTransaction } from '../../db/index.js';
import { badRequest, forbidden, notFound } from '../../errors.js';
import { toPage } from '../../pagination.js';

// Most members a group can have, counting its creator.
const MAX_GROUP_SIZE = 20;

// Deferred: editing messages, group roles (owner/admin, who may add or remove others), removing other members,
// DM notifications, typing indicators and read receipts shown to others.

// A conversation as the API returns it, from a getMembership result. participants includes the caller.
async function conversationView({ conversationId, kind, name, createdAt, lastReadAt }) {
  const participants = await store.listParticipants(conversationId);
  return { conversationId, kind, name, participants, createdAt, lastReadAt };
}

// POST /conversations. userIds are the other users, deduplicated, so [bob, bob] is one other user.
// - One other user and no name: their direct chat with the caller, created if it doesn't exist yet. There's only ever
//   one per pair, so a repeat request returns the existing chat.
// - Two or more: a new group, with the caller as a member. Groups are never deduplicated.
// Returns { conversation, created }: the conversation view, and whether it's new (the route sends 201 or 200).
// Throws 400 if userIds is empty or includes the caller, for a name with one other user (direct chats have no name),
// or if the group would go over MAX_GROUP_SIZE; 404 'User not found' for an unknown user id.
// Later: emit conversation:new to the other members of a new group.
export async function createConversation(userId, { userIds, name = null }) {
  const others = [...new Set(userIds)];
  if (others.length === 0) {
    throw badRequest('Pick at least one user');
  }
  if (others.includes(userId)) {
    throw badRequest('You cannot start a conversation with yourself');
  }
  if (others.length === 1 && name !== null) {
    throw badRequest('Direct conversations have no name');
  }
  if (others.length + 1 > MAX_GROUP_SIZE) {
    throw badRequest(`A group can have at most ${MAX_GROUP_SIZE} members`);
  }

  let result;
  try {
    result = await withTransaction(async (client) => {
      if (others.length === 1) {
        const direct = await store.findOrCreateDirect(userId, others[0], client);
        if (direct.created) {
          await store.addParticipants(direct.conversationId, [userId, others[0]], client);
        }
        return direct;
      }
      const { conversationId } = await store.createGroup({ name }, client);
      await store.addParticipants(conversationId, [userId, ...others], client);
      return { conversationId, created: true };
    });
  } catch (err) {
    // The only foreign keys these inserts can fail are to users: the conversation was found or made just above.
    // Caught out here because the failed insert has already aborted the transaction.
    if (err.code === '23503') {
      throw notFound('User not found');
    }
    throw err;
  }

  const membership = await store.getMembership(result.conversationId, userId);
  return { conversation: await conversationView(membership), created: result.created };
}

// PATCH /conversations/:conversation_id. Any member can set a group's name; null clears it. Returns the conversation
// view. Throws 404 if the caller isn't a member or the conversation doesn't exist, 400 for a direct chat.
// Later: emit conversation:updated to the members.
export async function renameGroup(userId, conversationId, name) {
  const membership = await store.getMembership(conversationId, userId);
  if (!membership) {
    throw notFound('Conversation not found');
  }
  if (membership.kind !== 'group') {
    throw badRequest('Direct conversations have no name');
  }
  // false if the group was deleted after the check above (its last member left).
  if (!(await store.renameGroup(conversationId, name))) {
    throw notFound('Conversation not found');
  }
  return conversationView({ ...membership, name });
}

// GET /conversations/:conversation_id. The conversation view, with every member including the caller. Returns null if
// the caller isn't a member or the conversation doesn't exist (the route 404s).
export async function getConversation(userId, conversationId) {
  const membership = await store.getMembership(conversationId, userId);
  return membership ? conversationView(membership) : null;
}

// GET /conversations. A page of the caller's inbox, most recent activity first: { items, nextCursor } (see
// src/pagination.js). Each item has the other participants, the last message and the unread count (see
// store.listConversations). Direct chats with no messages yet are left out.
export async function listConversations(userId, { limit, cursor = null }) {
  // One extra row only tells toPage whether another page exists.
  const rows = await store.listConversations(userId, { limit: limit + 1, cursor });
  return toPage(rows, limit, (last) => ({
    lastActivityAt: last.lastActivityAt.toISOString(),
    conversationId: last.conversationId,
  }));
}

// GET /conversations/:conversation_id/messages. A page of message views, newest first: { items, nextCursor } (see
// src/pagination.js). Only messages from after the caller joined are listed; deleted ones are included, shown as
// deleted. Returns null if the caller isn't a member or the conversation doesn't exist (the route 404s).
export async function listMessages(userId, conversationId, { limit, cursor = null }) {
  const membership = await store.getMembership(conversationId, userId);
  if (!membership) {
    return null;
  }
  // One extra row only tells toPage whether another page exists.
  const rows = await store.listMessages(conversationId, { visibleFrom: membership.joinedAt, limit: limit + 1, cursor });
  return toPage(rows, limit, (last) => ({ createdAt: last.createdAt.toISOString(), messageId: last.messageId }));
}

// POST /conversations/:conversation_id/messages. Sends a message and returns its message view. The conversation moves
// to the top of every member's inbox, and the sender's read state moves up to the message: replying means you've seen
// the chat, so anything unread before it is cleared too. Throws 404 if the caller isn't a member or the conversation
// doesn't exist.
// Later: listParticipants in the transaction, then after commit emit message:new with the message view to every
// member's user room except the sender's.
export async function sendMessage(userId, conversationId, content) {
  return withTransaction(async (client) => {
    // Locked so the caller can't leave (say, from another tab) before the message is in. Their row is locked first
    // and the conversation's (touchConversation) second, the same order as leaving and adding, so none of them can
    // deadlock with each other.
    if (!(await store.getMembership(conversationId, userId, { lock: true }, client))) {
      throw notFound('Conversation not found');
    }
    const message = await store.createMessage({ conversationId, senderId: userId, content }, client);
    await store.touchConversation(conversationId, message.createdAt, client);
    await store.markRead(conversationId, userId, message.createdAt, client);
    return message;
  });
}

// DELETE /conversations/:conversation_id/messages/:message_id. Soft-deletes the caller's own message for everyone;
// it stays in the history as deleted. Throws 404 if the caller isn't a member of the conversation, or the message
// doesn't exist, is in another conversation, or is from before the caller joined (the same 404 for all, so nothing
// they can't see is revealed). 403 if it's someone else's, checked before "already deleted" like posts. Deleting
// your own already-deleted message is a no-op.
// Later, after a real delete: emit message:deleted { conversationId, messageId } to the other members.
export async function deleteMessage(userId, conversationId, messageId) {
  const membership = await store.getMembership(conversationId, userId);
  if (!membership) {
    throw notFound('Conversation not found');
  }
  const message = await store.getMessageById(messageId);
  if (!message || message.conversationId !== conversationId || message.createdAt < membership.joinedAt) {
    throw notFound('Message not found');
  }
  if (message.senderId !== userId) {
    throw forbidden('You can only delete your own messages');
  }
  // false if it was already deleted, including by a concurrent request after the check above: still a no-op.
  await store.softDeleteMessage(messageId, userId);
}

// PUT /conversations/:conversation_id/read. Marks everything in the conversation up to now as read for the caller.
// Repeating it is harmless, and the read time never moves backwards. Throws 404 if the caller isn't a member or the
// conversation doesn't exist.
// Later: emit conversation:read to the caller's own room so their other tabs clear the badge.
export async function markRead(userId, conversationId) {
  // No getMembership first: store.markRead only updates the caller's own participant row, so false already means
  // they aren't a member.
  if (!(await store.markRead(conversationId, userId))) {
    throw notFound('Conversation not found');
  }
}

// POST /conversations/:conversation_id/participants. Any member can add users to a group. New members' joined_at is
// now, so history from before they joined stays hidden from them. Users already in the group are skipped and don't
// count against the cap. Returns the updated participant list, the same shape as the conversation view's.
// Throws 404 if the caller isn't a member or the conversation doesn't exist, 400 for a direct chat or if the group
// would go over MAX_GROUP_SIZE (nobody is added), 404 'User not found' for an unknown user id.
// Later, if someone was added: emit conversation:new to the added users and conversation:updated to the others.
export async function addMembers(userId, conversationId, userIds) {
  try {
    return await withTransaction(async (client) => {
      const membership = await store.getMembership(conversationId, userId, { lock: true }, client);
      if (!membership) {
        throw notFound('Conversation not found');
      }
      if (membership.kind !== 'group') {
        throw badRequest('You cannot add members to a direct conversation');
      }
      // Without this, two adds at once could each count the group before the other's insert and both pass the cap.
      await store.lockConversation(conversationId, client);
      const added = await store.addParticipants(conversationId, userIds, client);
      // Counted after the insert so already-members, which addParticipants skips, don't count twice. Throwing rolls
      // the insert back.
      if ((await store.countParticipants(conversationId, client)) > MAX_GROUP_SIZE) {
        throw badRequest(`A group can have at most ${MAX_GROUP_SIZE} members`);
      }
      // Only when someone joined, so repeating a request doesn't move the group up everyone's inbox.
      if (added.length > 0) {
        await store.touchConversation(conversationId, null, client);
      }
      return store.listParticipants(conversationId, client);
    });
  } catch (err) {
    // The conversation is locked above, so a foreign key failure can only be an unknown user. Caught out here because
    // the failed insert has already aborted the transaction.
    if (err.code === '23503') {
      throw notFound('User not found');
    }
    throw err;
  }
}

// DELETE /conversations/:conversation_id/participants/me. Leaves a group; the caller's messages stay. The last member
// out deletes the group. Being re-added later gives a new joined_at, so messages from before then are hidden again.
// Throws 404 if the caller isn't a member or the conversation doesn't exist, 400 for a direct chat.
// Later: emit conversation:updated to the remaining members, unless the group was deleted.
export async function leaveConversation(userId, conversationId) {
  await withTransaction(async (client) => {
    const membership = await store.getMembership(conversationId, userId, { lock: true }, client);
    if (!membership) {
      throw notFound('Conversation not found');
    }
    if (membership.kind !== 'group') {
      throw badRequest('You cannot leave a direct conversation');
    }
    // Without this, the last two members leaving at once would each still count the other and leave an empty group
    // behind. The participant row locked above can't be deleted under us, and the group can't be either (that would
    // cascade to the row), so lockConversation and removeParticipant both succeed.
    await store.lockConversation(conversationId, client);
    await store.removeParticipant(conversationId, userId, client);
    if ((await store.countParticipants(conversationId, client)) === 0) {
      await store.deleteConversation(conversationId, client);
    }
  });
}
