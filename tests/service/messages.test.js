// Messages service against the test database. Services use the pool (no transaction client), so data is committed
// and tables are emptied between tests, like the API tests.
import * as service from '../../src/modules/messages/service.js';
import * as store from '../../src/modules/messages/store.js';
import { pool, resetDatabase } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';
import { decodeCursor as decode } from '../../src/pagination.js';

afterEach(() => resetDatabase());
afterAll(() => pool.end());

const NO_ID = '00000000-0000-0000-0000-000000000000';

// A conversation's inbox sort key, which the store doesn't return on its own.
async function lastActivityAt(conversationId) {
  const { rows } = await pool.query('SELECT last_activity_at FROM conversations WHERE conversation_id = $1', [
    conversationId,
  ]);
  return rows[0].last_activity_at;
}

let alice;
let bob;
let groupId;
beforeEach(async () => {
  alice = await createUser(pool);
  bob = await createUser(pool);
  ({ conversationId: groupId } = await store.createGroup({ name: 'Old name' }));
  await store.addParticipants(groupId, [alice.userId, bob.userId]);
});

describe('createConversation', () => {
  const memberIds = (conversation) => conversation.participants.map((p) => p.userId).sort();

  async function conversationCount() {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM conversations');
    return rows[0].n;
  }

  describe('direct', () => {
    test('one other user creates a direct chat with both of them in it', async () => {
      const carol = await createUser(pool);

      const { conversation, created } = await service.createConversation(alice.userId, { userIds: [carol.userId] });

      expect(created).toBe(true);
      expect(conversation).toMatchObject({ kind: 'direct', name: null });
      expect(memberIds(conversation)).toEqual([alice.userId, carol.userId].sort());
    });

    test('a repeat request, from either side, returns the same chat', async () => {
      const first = await service.createConversation(alice.userId, { userIds: [bob.userId] });
      const again = await service.createConversation(alice.userId, { userIds: [bob.userId] });
      const reverse = await service.createConversation(bob.userId, { userIds: [alice.userId] });

      expect(again.created).toBe(false);
      expect(reverse.created).toBe(false);
      expect(again.conversation.conversationId).toBe(first.conversation.conversationId);
      expect(reverse.conversation.conversationId).toBe(first.conversation.conversationId);
      expect(again.conversation.participants).toHaveLength(2);
    });

    test('both sides starting it at once get the same chat, created once', async () => {
      const results = await Promise.all([
        service.createConversation(alice.userId, { userIds: [bob.userId] }),
        service.createConversation(bob.userId, { userIds: [alice.userId] }),
      ]);

      expect(results.map((r) => r.created).sort()).toEqual([false, true]);
      expect(results[0].conversation.conversationId).toBe(results[1].conversation.conversationId);
      expect(results[0].conversation.participants).toHaveLength(2);
    });

    test('a repeated id counts once, so it is still a direct chat', async () => {
      const { conversation } = await service.createConversation(alice.userId, { userIds: [bob.userId, bob.userId] });
      expect(conversation.kind).toBe('direct');
    });

    test('a name gets 400', async () => {
      await expect(
        service.createConversation(alice.userId, { userIds: [bob.userId], name: 'Us' }),
      ).rejects.toMatchObject({ status: 400 });
    });

    test('an unknown user gets 404 and nothing is created', async () => {
      const before = await conversationCount();
      await expect(service.createConversation(alice.userId, { userIds: [NO_ID] })).rejects.toMatchObject({
        status: 404,
        message: 'User not found',
      });
      expect(await conversationCount()).toBe(before);
    });
  });

  describe('group', () => {
    test('two or more others create a group with the caller in it', async () => {
      const carol = await createUser(pool);

      const { conversation, created } = await service.createConversation(alice.userId, {
        userIds: [bob.userId, carol.userId],
        name: 'Trio',
      });

      expect(created).toBe(true);
      expect(conversation).toMatchObject({ kind: 'group', name: 'Trio' });
      expect(memberIds(conversation)).toEqual([alice.userId, bob.userId, carol.userId].sort());
    });

    test('the name is optional', async () => {
      const carol = await createUser(pool);
      const { conversation } = await service.createConversation(alice.userId, { userIds: [bob.userId, carol.userId] });
      expect(conversation.name).toBeNull();
    });

    test('the same members again make a new group', async () => {
      const carol = await createUser(pool);
      const userIds = [bob.userId, carol.userId];

      const first = await service.createConversation(alice.userId, { userIds });
      const second = await service.createConversation(alice.userId, { userIds });

      expect(second.created).toBe(true);
      expect(second.conversation.conversationId).not.toBe(first.conversation.conversationId);
    });

    test('the group can start full', async () => {
      const others = [bob.userId];
      for (let i = 0; i < 18; i++) {
        others.push((await createUser(pool)).userId);
      }

      const { conversation } = await service.createConversation(alice.userId, { userIds: others });
      expect(conversation.participants).toHaveLength(20);
    });

    test('over the cap gets 400', async () => {
      const userIds = Array.from({ length: 20 }, () => crypto.randomUUID());
      await expect(service.createConversation(alice.userId, { userIds })).rejects.toMatchObject({ status: 400 });
    });

    test('an unknown user gets 404 and no group is left behind', async () => {
      const before = await conversationCount();
      await expect(
        service.createConversation(alice.userId, { userIds: [bob.userId, NO_ID], name: 'Nope' }),
      ).rejects.toMatchObject({ status: 404, message: 'User not found' });
      expect(await conversationCount()).toBe(before);
    });
  });

  test('no users gets 400', async () => {
    await expect(service.createConversation(alice.userId, { userIds: [] })).rejects.toMatchObject({ status: 400 });
  });

  test('including yourself gets 400', async () => {
    await expect(service.createConversation(alice.userId, { userIds: [alice.userId] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service.createConversation(alice.userId, { userIds: [alice.userId, bob.userId] }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('renameGroup', () => {
  test('any member can rename; returns the conversation view with every member', async () => {
    const view = await service.renameGroup(bob.userId, groupId, 'New name');

    expect(view).toEqual({
      conversationId: groupId,
      kind: 'group',
      name: 'New name',
      participants: expect.any(Array),
      createdAt: expect.any(Date),
      lastReadAt: expect.any(Date),
    });
    expect(view.participants.map((p) => p.userId).sort()).toEqual([alice.userId, bob.userId].sort());
  });

  test('the new name is saved', async () => {
    await service.renameGroup(alice.userId, groupId, 'New name');
    expect((await store.getMembership(groupId, bob.userId)).name).toBe('New name');
  });

  test('null clears the name', async () => {
    const view = await service.renameGroup(alice.userId, groupId, null);
    expect(view.name).toBeNull();
    expect((await store.getMembership(groupId, alice.userId)).name).toBeNull();
  });

  test('a non-member gets 404 and the name stays', async () => {
    const carol = await createUser(pool);
    await expect(service.renameGroup(carol.userId, groupId, 'Nope')).rejects.toMatchObject({ status: 404 });
    expect((await store.getMembership(groupId, alice.userId)).name).toBe('Old name');
  });

  test('an unknown conversation gets the same 404', async () => {
    await expect(service.renameGroup(alice.userId, NO_ID, 'Nope')).rejects.toMatchObject({
      status: 404,
      message: 'Conversation not found',
    });
  });

  test('a direct chat gets 400', async () => {
    const { conversationId } = await store.findOrCreateDirect(alice.userId, bob.userId);
    await store.addParticipants(conversationId, [alice.userId, bob.userId]);

    await expect(service.renameGroup(alice.userId, conversationId, 'Nope')).rejects.toMatchObject({ status: 400 });
    expect((await store.getMembership(conversationId, alice.userId)).name).toBeNull();
  });
});

describe('getConversation', () => {
  test('returns the conversation view with every member', async () => {
    const view = await service.getConversation(alice.userId, groupId);

    expect(view).toEqual({
      conversationId: groupId,
      kind: 'group',
      name: 'Old name',
      participants: expect.any(Array),
      createdAt: expect.any(Date),
      lastReadAt: expect.any(Date),
    });
    expect(view.participants.map((p) => p.userId).sort()).toEqual([alice.userId, bob.userId].sort());
  });

  test("lastReadAt is the caller's own", async () => {
    await pool.query(
      `UPDATE conversation_participants SET last_read_at = now() - interval '1 hour'
       WHERE conversation_id = $1 AND user_id = $2`,
      [groupId, bob.userId],
    );

    const aliceView = await service.getConversation(alice.userId, groupId);
    const bobView = await service.getConversation(bob.userId, groupId);
    expect(bobView.lastReadAt.getTime()).toBeLessThan(aliceView.lastReadAt.getTime());
  });

  test('a direct chat has no name and both members', async () => {
    const { conversationId } = await store.findOrCreateDirect(alice.userId, bob.userId);
    await store.addParticipants(conversationId, [alice.userId, bob.userId]);

    const view = await service.getConversation(bob.userId, conversationId);
    expect(view).toMatchObject({ kind: 'direct', name: null });
    expect(view.participants).toHaveLength(2);
  });

  test('a non-member gets null', async () => {
    const carol = await createUser(pool);
    expect(await service.getConversation(carol.userId, groupId)).toBeNull();
  });

  test('an unknown conversation gets null', async () => {
    expect(await service.getConversation(alice.userId, NO_ID)).toBeNull();
  });
});

describe('listConversations', () => {
  // A group with alice in it, `minutesAgo` minutes since its last activity.
  async function groupActiveAgo(name, minutesAgo) {
    const { conversationId } = await store.createGroup({ name });
    await store.addParticipants(conversationId, [alice.userId]);
    await pool.query(
      `UPDATE conversations SET last_activity_at = now() - make_interval(mins => $2) WHERE conversation_id = $1`,
      [conversationId, minutesAgo],
    );
    return conversationId;
  }

  test('pages through the inbox, most recent activity first', async () => {
    // The beforeEach group is the most recent.
    await groupActiveAgo('C', 30);
    await groupActiveAgo('A', 10);
    await groupActiveAgo('B', 20);

    const first = await service.listConversations(alice.userId, { limit: 2 });
    const second = await service.listConversations(alice.userId, { limit: 2, cursor: decode(first.nextCursor) });

    expect([...first.items, ...second.items].map((c) => c.name)).toEqual(['Old name', 'A', 'B', 'C']);
    expect(second.nextCursor).toBeNull();
  });

  test('a send moves the conversation to the top', async () => {
    const older = await groupActiveAgo('Older', 10);

    await service.sendMessage(alice.userId, older, 'bump');

    const { items } = await service.listConversations(alice.userId, { limit: 20 });
    expect(items.map((c) => c.name)).toEqual(['Older', 'Old name']);
  });

  test("only lists the caller's own conversations", async () => {
    const carol = await createUser(pool);
    const { items } = await service.listConversations(carol.userId, { limit: 20 });
    expect(items).toEqual([]);
  });

  test('a direct chat shows up only once it has a message', async () => {
    const carol = await createUser(pool);
    const { conversationId } = await store.findOrCreateDirect(carol.userId, bob.userId);
    await store.addParticipants(conversationId, [carol.userId, bob.userId]);
    expect((await service.listConversations(carol.userId, { limit: 20 })).items).toEqual([]);

    await service.sendMessage(carol.userId, conversationId, 'hi');

    const { items } = await service.listConversations(bob.userId, { limit: 20 });
    expect(items.map((c) => c.conversationId)).toContain(conversationId);
  });
});

describe('listMessages', () => {
  const send = (senderId, content) => store.createMessage({ conversationId: groupId, senderId, content });

  test('pages through every message, newest first', async () => {
    for (const content of ['one', 'two', 'three', 'four', 'five']) {
      await send(alice.userId, content);
    }

    const first = await service.listMessages(bob.userId, groupId, { limit: 2 });
    const second = await service.listMessages(bob.userId, groupId, { limit: 2, cursor: decode(first.nextCursor) });
    const third = await service.listMessages(bob.userId, groupId, { limit: 2, cursor: decode(second.nextCursor) });

    const contents = [...first.items, ...second.items, ...third.items].map((m) => m.content);
    expect(contents).toEqual(['five', 'four', 'three', 'two', 'one']);
    expect(third.nextCursor).toBeNull();
  });

  test('a page that fits everything has no next cursor', async () => {
    await send(alice.userId, 'hi');
    expect(await service.listMessages(bob.userId, groupId, { limit: 20 })).toEqual({
      items: [expect.objectContaining({ content: 'hi' })],
      nextCursor: null,
    });
  });

  test('an empty conversation gives an empty page', async () => {
    expect(await service.listMessages(alice.userId, groupId, { limit: 20 })).toEqual({ items: [], nextCursor: null });
  });

  test('deleted messages are listed as deleted', async () => {
    const { messageId } = await send(alice.userId, 'oops');
    await service.deleteMessage(alice.userId, groupId, messageId);

    const { items } = await service.listMessages(bob.userId, groupId, { limit: 20 });
    expect(items).toEqual([expect.objectContaining({ messageId, content: null, deleted: true })]);
  });

  test('a later member only sees messages from after they joined', async () => {
    // The first members joined two hours ago and the message is from an hour ago, so it's clearly before carol's
    // joined_at but after theirs.
    await pool.query(
      `UPDATE conversation_participants SET joined_at = now() - interval '2 hours' WHERE conversation_id = $1`,
      [groupId],
    );
    const { messageId } = await send(alice.userId, 'before');
    await pool.query(`UPDATE messages SET created_at = created_at - interval '1 hour' WHERE message_id = $1`, [
      messageId,
    ]);
    const carol = await createUser(pool);
    await service.addMembers(alice.userId, groupId, [carol.userId]);
    await send(alice.userId, 'after');

    const { items } = await service.listMessages(carol.userId, groupId, { limit: 20 });
    expect(items.map((m) => m.content)).toEqual(['after']);
    // Earlier members still see both.
    expect((await service.listMessages(bob.userId, groupId, { limit: 20 })).items).toHaveLength(2);
  });

  test('a non-member gets null', async () => {
    await send(alice.userId, 'secret');
    const carol = await createUser(pool);
    expect(await service.listMessages(carol.userId, groupId, { limit: 20 })).toBeNull();
  });

  test('an unknown conversation gets null', async () => {
    expect(await service.listMessages(alice.userId, NO_ID, { limit: 20 })).toBeNull();
  });
});

describe('sendMessage', () => {
  test('returns the message view with its sender', async () => {
    const message = await service.sendMessage(alice.userId, groupId, 'hello');

    expect(message).toEqual({
      messageId: expect.any(String),
      conversationId: groupId,
      sender: { userId: alice.userId, username: alice.username, displayName: alice.displayName },
      content: 'hello',
      createdAt: expect.any(Date),
      deleted: false,
    });
  });

  test('other members see it', async () => {
    const { messageId } = await service.sendMessage(alice.userId, groupId, 'hello');

    const { joinedAt } = await store.getMembership(groupId, bob.userId);
    const messages = await store.listMessages(groupId, { visibleFrom: joinedAt, limit: 10 });
    expect(messages.map((m) => m.messageId)).toEqual([messageId]);
  });

  test("moves the conversation's last activity to the message", async () => {
    const { createdAt } = await service.sendMessage(alice.userId, groupId, 'hello');
    expect(await lastActivityAt(groupId)).toEqual(createdAt);
  });

  test('unread for the others; read for the sender, along with anything before it', async () => {
    await store.createMessage({ conversationId: groupId, senderId: bob.userId, content: 'earlier' });
    const [before] = await store.listConversations(alice.userId, { limit: 10 });
    expect(before.unreadCount).toBe(1);

    const { createdAt } = await service.sendMessage(alice.userId, groupId, 'reply');

    expect((await store.getMembership(groupId, alice.userId)).lastReadAt).toEqual(createdAt);
    const [aliceInbox] = await store.listConversations(alice.userId, { limit: 10 });
    expect(aliceInbox.unreadCount).toBe(0);
    const [bobInbox] = await store.listConversations(bob.userId, { limit: 10 });
    expect(bobInbox.unreadCount).toBe(1);
  });

  test('works in a direct chat', async () => {
    const { conversationId } = await store.findOrCreateDirect(alice.userId, bob.userId);
    await store.addParticipants(conversationId, [alice.userId, bob.userId]);

    const message = await service.sendMessage(alice.userId, conversationId, 'hi');
    expect(message.conversationId).toBe(conversationId);
  });

  test('two sends by the same user at once both go through', async () => {
    const results = await Promise.all([
      service.sendMessage(alice.userId, groupId, 'one'),
      service.sendMessage(alice.userId, groupId, 'two'),
    ]);

    expect(results).toHaveLength(2);
    const { lastReadAt } = await store.getMembership(groupId, alice.userId);
    expect(lastReadAt).toEqual(new Date(Math.max(...results.map((m) => m.createdAt.getTime()))));
  });

  test('sending and leaving at once: no deadlock, and no message from a non-member', async () => {
    const [send, leave] = await Promise.allSettled([
      service.sendMessage(alice.userId, groupId, 'hi'),
      service.leaveConversation(alice.userId, groupId),
    ]);

    expect(leave.status).toBe('fulfilled');
    // Either the send went first, or it waited for the leave and then found Alice gone.
    if (send.status === 'rejected') {
      expect(send.reason).toMatchObject({ status: 404 });
    }
  });

  test('a non-member gets 404 and nothing is sent', async () => {
    const carol = await createUser(pool);

    await expect(service.sendMessage(carol.userId, groupId, 'hi')).rejects.toMatchObject({
      status: 404,
      message: 'Conversation not found',
    });
    const { joinedAt } = await store.getMembership(groupId, alice.userId);
    expect(await store.listMessages(groupId, { visibleFrom: joinedAt, limit: 10 })).toEqual([]);
  });

  test('an unknown conversation gets the same 404', async () => {
    await expect(service.sendMessage(alice.userId, NO_ID, 'hi')).rejects.toMatchObject({
      status: 404,
      message: 'Conversation not found',
    });
  });
});

describe('deleteMessage', () => {
  const send = (senderId, content = 'hi', conversationId = groupId) =>
    store.createMessage({ conversationId, senderId, content });

  test('soft-deletes your own message: it stays, without content', async () => {
    const { messageId } = await send(alice.userId);

    await service.deleteMessage(alice.userId, groupId, messageId);

    const { joinedAt } = await store.getMembership(groupId, bob.userId);
    const [message] = await store.listMessages(groupId, { visibleFrom: joinedAt, limit: 10 });
    expect(message).toMatchObject({ messageId, content: null, deleted: true });
  });

  test("someone else's message gets 403 and stays", async () => {
    const { messageId } = await send(bob.userId);

    await expect(service.deleteMessage(alice.userId, groupId, messageId)).rejects.toMatchObject({ status: 403 });
    expect((await store.getMessageById(messageId)).deletedAt).toBeNull();
  });

  test("someone else's already-deleted message still gets 403", async () => {
    const { messageId } = await send(bob.userId);
    await service.deleteMessage(bob.userId, groupId, messageId);

    await expect(service.deleteMessage(alice.userId, groupId, messageId)).rejects.toMatchObject({ status: 403 });
  });

  test('deleting your own message twice is a no-op', async () => {
    const { messageId } = await send(alice.userId);
    await service.deleteMessage(alice.userId, groupId, messageId);
    const { deletedAt } = await store.getMessageById(messageId);

    await expect(service.deleteMessage(alice.userId, groupId, messageId)).resolves.toBeUndefined();
    expect((await store.getMessageById(messageId)).deletedAt).toEqual(deletedAt);
  });

  test('a non-member gets 404, even for their own old message', async () => {
    const { messageId } = await send(alice.userId);
    await service.leaveConversation(alice.userId, groupId);

    await expect(service.deleteMessage(alice.userId, groupId, messageId)).rejects.toMatchObject({
      status: 404,
      message: 'Conversation not found',
    });
  });

  test('an unknown message gets 404', async () => {
    await expect(service.deleteMessage(alice.userId, groupId, NO_ID)).rejects.toMatchObject({
      status: 404,
      message: 'Message not found',
    });
  });

  test('a message from another conversation gets 404, even your own', async () => {
    const { conversationId: otherId } = await store.createGroup();
    await store.addParticipants(otherId, [alice.userId, bob.userId]);
    const { messageId } = await send(alice.userId, 'hi', otherId);

    await expect(service.deleteMessage(alice.userId, groupId, messageId)).rejects.toMatchObject({
      status: 404,
      message: 'Message not found',
    });
    expect((await store.getMessageById(messageId)).deletedAt).toBeNull();
  });

  test('a message from before you joined gets 404, not 403', async () => {
    const { messageId } = await send(bob.userId);
    // An hour back, so it's clearly before carol's joined_at.
    await pool.query(`UPDATE messages SET created_at = created_at - interval '1 hour' WHERE message_id = $1`, [
      messageId,
    ]);
    const carol = await createUser(pool);
    await store.addParticipants(groupId, [carol.userId]);

    await expect(service.deleteMessage(carol.userId, groupId, messageId)).rejects.toMatchObject({
      status: 404,
      message: 'Message not found',
    });
  });
});

describe('markRead', () => {
  // Back an hour, so a move to now can't be lost to two timestamps landing in the same millisecond.
  async function readAnHourAgo(userId) {
    await pool.query(
      `UPDATE conversation_participants SET last_read_at = now() - interval '1 hour'
       WHERE conversation_id = $1 AND user_id = $2`,
      [groupId, userId],
    );
    return (await store.getMembership(groupId, userId)).lastReadAt;
  }

  test("moves the caller's read time up to now, and only theirs", async () => {
    const aliceBefore = await readAnHourAgo(alice.userId);
    const bobBefore = await readAnHourAgo(bob.userId);

    await service.markRead(alice.userId, groupId);

    expect((await store.getMembership(groupId, alice.userId)).lastReadAt.getTime()).toBeGreaterThan(
      aliceBefore.getTime(),
    );
    expect((await store.getMembership(groupId, bob.userId)).lastReadAt).toEqual(bobBefore);
  });

  test('clears the unread count', async () => {
    await readAnHourAgo(alice.userId);
    await store.createMessage({ conversationId: groupId, senderId: bob.userId, content: 'hi' });
    const [before] = await store.listConversations(alice.userId, { limit: 10 });
    expect(before.unreadCount).toBe(1);

    await service.markRead(alice.userId, groupId);

    const [after] = await store.listConversations(alice.userId, { limit: 10 });
    expect(after.unreadCount).toBe(0);
  });

  test('repeating it is fine', async () => {
    await service.markRead(alice.userId, groupId);
    await expect(service.markRead(alice.userId, groupId)).resolves.toBeUndefined();
  });

  test('a non-member gets 404', async () => {
    const carol = await createUser(pool);
    await expect(service.markRead(carol.userId, groupId)).rejects.toMatchObject({
      status: 404,
      message: 'Conversation not found',
    });
  });

  test('an unknown conversation gets the same 404', async () => {
    await expect(service.markRead(alice.userId, NO_ID)).rejects.toMatchObject({
      status: 404,
      message: 'Conversation not found',
    });
  });
});

describe('addMembers', () => {
  // Fills the group (alice and bob) up to `size` members.
  async function fillGroup(size) {
    const users = [];
    for (let i = 2; i < size; i++) {
      users.push((await createUser(pool)).userId);
    }
    await store.addParticipants(groupId, users);
  }

  test('any member can add; returns every member', async () => {
    const carol = await createUser(pool);

    const participants = await service.addMembers(bob.userId, groupId, [carol.userId]);

    expect(participants.map((p) => p.userId).sort()).toEqual([alice.userId, bob.userId, carol.userId].sort());
    expect(participants[0]).toEqual({
      userId: expect.any(String),
      username: expect.any(String),
      displayName: expect.any(String),
      joinedAt: expect.any(Date),
    });
  });

  test('new members see only messages sent after they joined', async () => {
    await store.createMessage({ conversationId: groupId, senderId: alice.userId, content: 'before' });
    const carol = await createUser(pool);

    await service.addMembers(alice.userId, groupId, [carol.userId]);

    const { joinedAt } = await store.getMembership(groupId, carol.userId);
    expect(await store.listMessages(groupId, { visibleFrom: joinedAt, limit: 10 })).toEqual([]);
  });

  test('existing members are skipped and keep their joined_at', async () => {
    const before = await store.getMembership(groupId, bob.userId);

    const participants = await service.addMembers(alice.userId, groupId, [bob.userId]);

    expect(participants).toHaveLength(2);
    expect((await store.getMembership(groupId, bob.userId)).joinedAt).toEqual(before.joinedAt);
  });

  test('moves the group up the inbox only when someone was added', async () => {
    // Back an hour first, so the move can't be lost to two timestamps landing in the same millisecond.
    await pool.query(
      `UPDATE conversations SET last_activity_at = last_activity_at - interval '1 hour' WHERE conversation_id = $1`,
      [groupId],
    );
    const start = await lastActivityAt(groupId);

    await service.addMembers(alice.userId, groupId, [bob.userId]);
    expect(await lastActivityAt(groupId)).toEqual(start);

    const carol = await createUser(pool);
    await service.addMembers(alice.userId, groupId, [carol.userId]);
    expect((await lastActivityAt(groupId)).getTime()).toBeGreaterThan(start.getTime());
  });

  test('the group can fill up to the cap exactly', async () => {
    await fillGroup(19);
    const carol = await createUser(pool);

    expect(await service.addMembers(alice.userId, groupId, [carol.userId])).toHaveLength(20);
  });

  test('going over the cap gets 400 and nobody is added', async () => {
    await fillGroup(19);
    const carol = await createUser(pool);
    const dave = await createUser(pool);

    await expect(service.addMembers(alice.userId, groupId, [carol.userId, dave.userId])).rejects.toMatchObject({
      status: 400,
    });
    expect(await store.countParticipants(groupId)).toBe(19);
  });

  test("existing members in the request don't count against the cap", async () => {
    await fillGroup(19);
    const carol = await createUser(pool);

    const participants = await service.addMembers(alice.userId, groupId, [alice.userId, bob.userId, carol.userId]);
    expect(participants).toHaveLength(20);
  });

  test('two adds at once into the last place: one succeeds, the other gets 400', async () => {
    await fillGroup(19);
    const carol = await createUser(pool);
    const dave = await createUser(pool);

    const results = await Promise.allSettled([
      service.addMembers(alice.userId, groupId, [carol.userId]),
      service.addMembers(bob.userId, groupId, [dave.userId]),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ status: 400 });
    expect(await store.countParticipants(groupId)).toBe(20);
  });

  test('an unknown user gets 404 and nobody is added', async () => {
    const carol = await createUser(pool);

    await expect(service.addMembers(alice.userId, groupId, [carol.userId, NO_ID])).rejects.toMatchObject({
      status: 404,
      message: 'User not found',
    });
    expect(await store.getMembership(groupId, carol.userId)).toBeNull();
  });

  test('a non-member gets 404 and nobody is added', async () => {
    const carol = await createUser(pool);
    const dave = await createUser(pool);

    await expect(service.addMembers(carol.userId, groupId, [dave.userId])).rejects.toMatchObject({
      status: 404,
      message: 'Conversation not found',
    });
    expect(await store.countParticipants(groupId)).toBe(2);
  });

  test('an unknown conversation gets the same 404', async () => {
    await expect(service.addMembers(alice.userId, NO_ID, [bob.userId])).rejects.toMatchObject({
      status: 404,
      message: 'Conversation not found',
    });
  });

  test('a direct chat gets 400', async () => {
    const { conversationId } = await store.findOrCreateDirect(alice.userId, bob.userId);
    await store.addParticipants(conversationId, [alice.userId, bob.userId]);
    const carol = await createUser(pool);

    await expect(service.addMembers(alice.userId, conversationId, [carol.userId])).rejects.toMatchObject({
      status: 400,
    });
    expect(await store.countParticipants(conversationId)).toBe(2);
  });
});

describe('leaveConversation', () => {
  test('removes the caller; the group and the other members stay', async () => {
    const carol = await createUser(pool);
    await store.addParticipants(groupId, [carol.userId]);

    await service.leaveConversation(alice.userId, groupId);

    expect(await store.getMembership(groupId, alice.userId)).toBeNull();
    expect((await store.listParticipants(groupId)).map((p) => p.userId).sort()).toEqual(
      [bob.userId, carol.userId].sort(),
    );
  });

  test("the leaver's messages stay", async () => {
    const { messageId } = await store.createMessage({ conversationId: groupId, senderId: alice.userId, content: 'hi' });

    await service.leaveConversation(alice.userId, groupId);

    expect(await store.getMessageById(messageId)).toMatchObject({ senderId: alice.userId, deletedAt: null });
  });

  test('the last member out deletes the group', async () => {
    await service.leaveConversation(alice.userId, groupId);
    await service.leaveConversation(bob.userId, groupId);

    expect(await store.lockConversation(groupId)).toBe(false);
  });

  test('the last two leaving at once still delete the group', async () => {
    await Promise.all([
      service.leaveConversation(alice.userId, groupId),
      service.leaveConversation(bob.userId, groupId),
    ]);

    expect(await store.lockConversation(groupId)).toBe(false);
  });

  test('a non-member gets 404', async () => {
    const carol = await createUser(pool);
    await expect(service.leaveConversation(carol.userId, groupId)).rejects.toMatchObject({ status: 404 });
    expect(await store.countParticipants(groupId)).toBe(2);
  });

  test('leaving twice gets 404 the second time', async () => {
    await service.leaveConversation(alice.userId, groupId);
    await expect(service.leaveConversation(alice.userId, groupId)).rejects.toMatchObject({ status: 404 });
  });

  test('an unknown conversation gets the same 404', async () => {
    await expect(service.leaveConversation(alice.userId, NO_ID)).rejects.toMatchObject({
      status: 404,
      message: 'Conversation not found',
    });
  });

  test('a direct chat gets 400 and both members stay', async () => {
    const { conversationId } = await store.findOrCreateDirect(alice.userId, bob.userId);
    await store.addParticipants(conversationId, [alice.userId, bob.userId]);

    await expect(service.leaveConversation(alice.userId, conversationId)).rejects.toMatchObject({ status: 400 });
    expect(await store.countParticipants(conversationId)).toBe(2);
  });
});
