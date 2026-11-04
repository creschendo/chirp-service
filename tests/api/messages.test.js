// HTTP tests for the messages routes. Requests go through the real app and pool; tables are emptied between tests.
import request from 'supertest';
import app from '../../src/app.js';
import { pool, resetDatabase } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';
import { authCookie } from '../helpers/auth.js';
import * as store from '../../src/modules/messages/store.js';
import { encodeCursor } from '../../src/pagination.js';

afterEach(() => resetDatabase());
afterAll(() => pool.end());

const NO_ID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';

let alice;
let bob;
let cookie;
beforeEach(async () => {
  alice = await createUser(pool);
  bob = await createUser(pool);
  cookie = authCookie(alice.userId);
});

describe('POST /conversations', () => {
  const create = (body, as = cookie) => {
    const req = request(app).post('/conversations');
    if (as) req.set('Cookie', as);
    return req.send(body);
  };

  test('201 with the conversation view for a new direct chat', async () => {
    const res = await create({ userIds: [bob.userId] });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      conversationId: expect.any(String),
      kind: 'direct',
      name: null,
      participants: expect.any(Array),
      createdAt: expect.any(String),
      lastReadAt: expect.any(String),
    });
    expect(res.body.participants.map((p) => p.userId).sort()).toEqual([alice.userId, bob.userId].sort());
  });

  test('200 with the same chat when it already exists, from either side', async () => {
    const first = await create({ userIds: [bob.userId] });
    const again = await create({ userIds: [bob.userId] });
    const reverse = await create({ userIds: [alice.userId] }, authCookie(bob.userId));

    expect(again.status).toBe(200);
    expect(reverse.status).toBe(200);
    expect(again.body.conversationId).toBe(first.body.conversationId);
    expect(reverse.body.conversationId).toBe(first.body.conversationId);
  });

  test('201 with a new group for two or more others, the caller included', async () => {
    const carol = await createUser(pool);

    const res = await create({ userIds: [bob.userId, carol.userId], name: '  Trio  ' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'group', name: 'Trio' });
    expect(res.body.participants).toHaveLength(3);
  });

  test('401 when not logged in', async () => {
    const res = await create({ userIds: [bob.userId] }, null);
    expect(res.status).toBe(401);
  });

  test.each([
    ['no users', { userIds: [] }],
    ['a malformed user id', { userIds: ['nope'] }],
    ['an unknown field', { userIds: [NO_ID], kind: 'group' }],
  ])('400 for %s (the schema)', async (_, body) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid input', issues: expect.any(Array) });
  });

  test('400 for yourself in userIds (the service)', async () => {
    const res = await create({ userIds: [alice.userId, bob.userId] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'You cannot start a conversation with yourself' });
  });

  test('400 for a name on a direct chat (the service)', async () => {
    const res = await create({ userIds: [bob.userId], name: 'Us' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Direct conversations have no name' });
  });

  test('404 for an unknown user, and nothing is created', async () => {
    const res = await create({ userIds: [bob.userId, NO_ID] });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM conversations');
    expect(rows[0].n).toBe(0);
  });
});

describe('GET /conversations', () => {
  const list = (query = {}, as = cookie) => {
    const req = request(app).get('/conversations').query(query);
    if (as) req.set('Cookie', as);
    return req;
  };

  // A group with alice and bob, `minutesAgo` minutes since its last activity.
  async function groupActiveAgo(name, minutesAgo) {
    const { conversationId } = await store.createGroup({ name });
    await store.addParticipants(conversationId, [alice.userId, bob.userId]);
    await pool.query(
      `UPDATE conversations SET last_activity_at = now() - make_interval(mins => $2) WHERE conversation_id = $1`,
      [conversationId, minutesAgo],
    );
    return conversationId;
  }

  test('200 with an inbox item per conversation', async () => {
    const groupId = await groupActiveAgo('Pals', 5);
    await store.createMessage({ conversationId: groupId, senderId: bob.userId, content: 'hi' });

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [
        {
          conversationId: groupId,
          kind: 'group',
          name: 'Pals',
          participants: [{ userId: bob.userId, username: bob.username, displayName: bob.displayName }],
          lastMessage: expect.objectContaining({
            content: 'hi',
            sender: expect.objectContaining({ userId: bob.userId }),
          }),
          unreadCount: 1,
          lastActivityAt: expect.any(String),
        },
      ],
      nextCursor: null,
    });
  });

  test('pages with the cursor, most recent activity first', async () => {
    await groupActiveAgo('C', 30);
    await groupActiveAgo('A', 10);
    await groupActiveAgo('B', 20);

    const first = await list({ limit: 2 });
    const second = await list({ limit: 2, cursor: first.body.nextCursor });

    expect([...first.body.items, ...second.body.items].map((c) => c.name)).toEqual(['A', 'B', 'C']);
    expect(second.body.nextCursor).toBeNull();
  });

  test("only the caller's conversations", async () => {
    await groupActiveAgo('Pals', 5);
    const carol = await createUser(pool);

    const res = await list({}, authCookie(carol.userId));
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  test('401 when not logged in', async () => {
    expect((await list({}, null)).status).toBe(401);
  });

  test.each([
    ['limit 0', { limit: 0 }],
    ['limit over 100', { limit: 101 }],
    ['a garbage cursor', { cursor: 'nope' }],
  ])('400 for %s', async (_, query) => {
    const res = await list(query);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid query' });
  });
});

describe('GET /conversations/:conversation_id', () => {
  const get = (conversationId, as = cookie) => {
    const req = request(app).get(`/conversations/${conversationId}`);
    if (as) req.set('Cookie', as);
    return req;
  };

  let groupId;
  beforeEach(async () => {
    ({ conversationId: groupId } = await store.createGroup({ name: 'Pals' }));
    await store.addParticipants(groupId, [alice.userId, bob.userId]);
  });

  test('200 with the conversation view, every member included', async () => {
    const res = await get(groupId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      conversationId: groupId,
      kind: 'group',
      name: 'Pals',
      participants: expect.any(Array),
      createdAt: expect.any(String),
      lastReadAt: expect.any(String),
    });
    expect(res.body.participants.map((p) => p.userId).sort()).toEqual([alice.userId, bob.userId].sort());
  });

  test('a non-member and an unknown conversation get the same 404', async () => {
    const carol = await createUser(pool);

    const notMember = await get(groupId, authCookie(carol.userId));
    const unknown = await get(NO_ID);

    expect(notMember.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(notMember.body).toEqual({ error: 'Conversation not found' });
    expect(unknown.body).toEqual(notMember.body);
  });

  test('400 for a malformed id', async () => {
    const res = await get('nope');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid conversation id' });
  });

  test('401 when not logged in', async () => {
    expect((await get(groupId, null)).status).toBe(401);
  });
});

describe('GET /conversations/:conversation_id/messages', () => {
  const listMessages = (conversationId, query = {}, as = cookie) => {
    const req = request(app).get(`/conversations/${conversationId}/messages`).query(query);
    if (as) req.set('Cookie', as);
    return req;
  };

  let groupId;
  beforeEach(async () => {
    ({ conversationId: groupId } = await store.createGroup({ name: 'Pals' }));
    await store.addParticipants(groupId, [alice.userId, bob.userId]);
  });

  test('200 with message views', async () => {
    const { messageId } = await store.createMessage({ conversationId: groupId, senderId: bob.userId, content: 'hi' });

    const res = await listMessages(groupId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [
        {
          messageId,
          conversationId: groupId,
          sender: { userId: bob.userId, username: bob.username, displayName: bob.displayName },
          content: 'hi',
          createdAt: expect.any(String),
          deleted: false,
        },
      ],
      nextCursor: null,
    });
  });

  test('pages with the cursor, newest first', async () => {
    for (const content of ['one', 'two', 'three']) {
      await store.createMessage({ conversationId: groupId, senderId: bob.userId, content });
    }

    const first = await listMessages(groupId, { limit: 2 });
    const second = await listMessages(groupId, { limit: 2, cursor: first.body.nextCursor });

    expect([...first.body.items, ...second.body.items].map((m) => m.content)).toEqual(['three', 'two', 'one']);
    expect(second.body.nextCursor).toBeNull();
  });

  test('a non-member and an unknown conversation get the same 404', async () => {
    const carol = await createUser(pool);

    const notMember = await listMessages(groupId, {}, authCookie(carol.userId));
    const unknown = await listMessages(NO_ID);

    expect(notMember.status).toBe(404);
    expect(notMember.body).toEqual({ error: 'Conversation not found' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(notMember.body);
  });

  test('400 for a malformed id', async () => {
    const res = await listMessages('nope');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid conversation id' });
  });

  test.each([
    ['limit 0', { limit: 0 }],
    ['an inbox cursor', { cursor: encodeCursor({ lastActivityAt: new Date().toISOString(), conversationId: NO_ID }) }],
  ])('400 for %s', async (_, query) => {
    const res = await listMessages(groupId, query);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid query' });
  });

  test('401 when not logged in', async () => {
    expect((await listMessages(groupId, {}, null)).status).toBe(401);
  });
});

describe('POST /conversations/:conversation_id/messages', () => {
  const send = (conversationId, body, as = cookie) => {
    const req = request(app).post(`/conversations/${conversationId}/messages`);
    if (as) req.set('Cookie', as);
    return req.send(body);
  };

  let groupId;
  beforeEach(async () => {
    ({ conversationId: groupId } = await store.createGroup({ name: 'Pals' }));
    await store.addParticipants(groupId, [alice.userId, bob.userId]);
  });

  test('201 with the message view; the sender comes from the token', async () => {
    const res = await send(groupId, { content: '  hey  ' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      messageId: expect.any(String),
      conversationId: groupId,
      sender: { userId: alice.userId, username: alice.username, displayName: alice.displayName },
      content: 'hey',
      createdAt: expect.any(String),
      deleted: false,
    });
  });

  test('the other member sees it, unread', async () => {
    await send(groupId, { content: 'hey' });

    const bobCookie = authCookie(bob.userId);
    const messages = await request(app).get(`/conversations/${groupId}/messages`).set('Cookie', bobCookie);
    const inbox = await request(app).get('/conversations').set('Cookie', bobCookie);

    expect(messages.body.items.map((m) => m.content)).toEqual(['hey']);
    expect(inbox.body.items[0]).toMatchObject({ conversationId: groupId, unreadCount: 1 });
  });

  test('a non-member and an unknown conversation get the same 404, and nothing is sent', async () => {
    const carol = await createUser(pool);

    const notMember = await send(groupId, { content: 'hey' }, authCookie(carol.userId));
    const unknown = await send(NO_ID, { content: 'hey' });

    expect(notMember.status).toBe(404);
    expect(notMember.body).toEqual({ error: 'Conversation not found' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(notMember.body);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM messages');
    expect(rows[0].n).toBe(0);
  });

  test.each([
    ['empty content', { content: '   ' }, 'Message cannot be empty'],
    ['content over 1000 characters', { content: 'x'.repeat(1001) }, 'Message must be at most 1000 characters'],
  ])('400 for %s', async (_, body, message) => {
    const res = await send(groupId, body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid input', issues: [expect.objectContaining({ message })] });
  });

  test('400 for a sender in the body, which can only come from the token', async () => {
    const res = await send(groupId, { content: 'hey', senderId: bob.userId });
    expect(res.status).toBe(400);
  });

  test('400 for a malformed id', async () => {
    const res = await send('nope', { content: 'hey' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid conversation id' });
  });

  test('401 when not logged in', async () => {
    expect((await send(groupId, { content: 'hey' }, null)).status).toBe(401);
  });
});

describe('DELETE /conversations/:conversation_id/messages/:message_id', () => {
  const remove = (conversationId, messageId, as = cookie) => {
    const req = request(app).delete(`/conversations/${conversationId}/messages/${messageId}`);
    if (as) req.set('Cookie', as);
    return req;
  };

  let groupId;
  beforeEach(async () => {
    ({ conversationId: groupId } = await store.createGroup({ name: 'Pals' }));
    await store.addParticipants(groupId, [alice.userId, bob.userId]);
  });

  const sendAs = async (senderId, content = 'hi', conversationId = groupId) =>
    (await store.createMessage({ conversationId, senderId, content })).messageId;

  test('204, and the message shows as deleted to everyone', async () => {
    const messageId = await sendAs(alice.userId);

    const res = await remove(groupId, messageId);

    expect(res.status).toBe(204);
    const messages = await request(app).get(`/conversations/${groupId}/messages`).set('Cookie', authCookie(bob.userId));
    expect(messages.body.items).toEqual([expect.objectContaining({ messageId, content: null, deleted: true })]);
  });

  test('deleting it again is still 204', async () => {
    const messageId = await sendAs(alice.userId);
    await remove(groupId, messageId);
    expect((await remove(groupId, messageId)).status).toBe(204);
  });

  test("403 for someone else's message, which stays", async () => {
    const messageId = await sendAs(bob.userId);

    const res = await remove(groupId, messageId);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'You can only delete your own messages' });
    expect((await store.getMessageById(messageId)).deletedAt).toBeNull();
  });

  test('404 for a non-member', async () => {
    const messageId = await sendAs(alice.userId);
    const carol = await createUser(pool);

    const res = await remove(groupId, messageId, authCookie(carol.userId));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Conversation not found' });
  });

  test('404 for an unknown message, or one from another conversation', async () => {
    const { conversationId: otherId } = await store.createGroup();
    await store.addParticipants(otherId, [alice.userId]);
    const elsewhere = await sendAs(alice.userId, 'hi', otherId);

    for (const messageId of [NO_ID, elsewhere]) {
      const res = await remove(groupId, messageId);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Message not found' });
    }
  });

  test.each([
    ['a malformed conversation id', 'nope', NO_ID, 'Invalid conversation id'],
    ['a malformed message id', NO_ID, 'nope', 'Invalid message id'],
  ])('400 for %s', async (_, conversationId, messageId, message) => {
    const res = await remove(conversationId, messageId);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid id', issues: [expect.objectContaining({ message })] });
  });

  test('401 when not logged in', async () => {
    const messageId = await sendAs(alice.userId);
    expect((await remove(groupId, messageId, null)).status).toBe(401);
  });
});

describe('PUT /conversations/:conversation_id/read', () => {
  const markRead = (conversationId, as = cookie) => {
    const req = request(app).put(`/conversations/${conversationId}/read`);
    if (as) req.set('Cookie', as);
    return req;
  };
  const unreadCount = async () =>
    (await request(app).get('/conversations').set('Cookie', cookie)).body.items[0].unreadCount;

  let groupId;
  beforeEach(async () => {
    ({ conversationId: groupId } = await store.createGroup({ name: 'Pals' }));
    await store.addParticipants(groupId, [alice.userId, bob.userId]);
    // An hour back, so messages sent now are clearly after it.
    await pool.query(
      `UPDATE conversation_participants SET last_read_at = now() - interval '1 hour' WHERE conversation_id = $1`,
      [groupId],
    );
  });

  test('204, and the unread count goes to 0', async () => {
    await store.createMessage({ conversationId: groupId, senderId: bob.userId, content: 'one' });
    await store.createMessage({ conversationId: groupId, senderId: bob.userId, content: 'two' });
    expect(await unreadCount()).toBe(2);

    const res = await markRead(groupId);

    expect(res.status).toBe(204);
    expect(await unreadCount()).toBe(0);
  });

  test('repeating it is still 204', async () => {
    await markRead(groupId);
    expect((await markRead(groupId)).status).toBe(204);
  });

  test('a non-member and an unknown conversation get the same 404', async () => {
    const carol = await createUser(pool);

    const notMember = await markRead(groupId, authCookie(carol.userId));
    const unknown = await markRead(NO_ID);

    expect(notMember.status).toBe(404);
    expect(notMember.body).toEqual({ error: 'Conversation not found' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(notMember.body);
  });

  test('400 for a malformed id', async () => {
    const res = await markRead('nope');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid conversation id' });
  });

  test('401 when not logged in', async () => {
    expect((await markRead(groupId, null)).status).toBe(401);
  });
});

describe('POST /conversations/:conversation_id/participants', () => {
  const add = (conversationId, body, as = cookie) => {
    const req = request(app).post(`/conversations/${conversationId}/participants`);
    if (as) req.set('Cookie', as);
    return req.send(body);
  };
  const countMembers = (conversationId) => store.countParticipants(conversationId);

  let groupId;
  beforeEach(async () => {
    ({ conversationId: groupId } = await store.createGroup({ name: 'Pals' }));
    await store.addParticipants(groupId, [alice.userId, bob.userId]);
  });

  test('200 with every member, the new one included', async () => {
    const carol = await createUser(pool);

    const res = await add(groupId, { userIds: [carol.userId] });

    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.userId).sort()).toEqual([alice.userId, bob.userId, carol.userId].sort());
    expect(res.body[0]).toEqual({
      userId: expect.any(String),
      username: expect.any(String),
      displayName: expect.any(String),
      joinedAt: expect.any(String),
    });
  });

  test('the new member can open the group', async () => {
    const carol = await createUser(pool);
    await add(groupId, { userIds: [carol.userId] });

    const res = await request(app).get(`/conversations/${groupId}`).set('Cookie', authCookie(carol.userId));
    expect(res.status).toBe(200);
  });

  test('existing members are skipped, so a repeat is still 200', async () => {
    const res = await add(groupId, { userIds: [bob.userId] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  test('400 over the group cap, and nobody is added', async () => {
    const others = [];
    for (let i = 2; i < 19; i++) {
      others.push((await createUser(pool)).userId);
    }
    await store.addParticipants(groupId, others);
    const carol = await createUser(pool);
    const dave = await createUser(pool);

    const res = await add(groupId, { userIds: [carol.userId, dave.userId] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'A group can have at most 20 members' });
    expect(await countMembers(groupId)).toBe(19);
  });

  test('400 for a direct chat', async () => {
    const { conversationId } = await store.findOrCreateDirect(alice.userId, bob.userId);
    await store.addParticipants(conversationId, [alice.userId, bob.userId]);
    const carol = await createUser(pool);

    const res = await add(conversationId, { userIds: [carol.userId] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'You cannot add members to a direct conversation' });
  });

  test('404 for an unknown user, and nobody is added', async () => {
    const carol = await createUser(pool);

    const res = await add(groupId, { userIds: [carol.userId, NO_ID] });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
    expect(await countMembers(groupId)).toBe(2);
  });

  test('a non-member and an unknown conversation get the same 404', async () => {
    const carol = await createUser(pool);
    const dave = await createUser(pool);

    const notMember = await add(groupId, { userIds: [dave.userId] }, authCookie(carol.userId));
    const unknown = await add(NO_ID, { userIds: [dave.userId] });

    expect(notMember.status).toBe(404);
    expect(notMember.body).toEqual({ error: 'Conversation not found' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(notMember.body);
  });

  test.each([
    ['no users', { userIds: [] }],
    ['a malformed user id', { userIds: ['nope'] }],
    ['a name, which belongs to a rename', { userIds: [NO_ID], name: 'x' }],
  ])('400 for %s', async (_, body) => {
    const res = await add(groupId, body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid input' });
  });

  test('400 for a malformed conversation id', async () => {
    const res = await add('nope', { userIds: [NO_ID] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid conversation id' });
  });

  test('401 when not logged in', async () => {
    expect((await add(groupId, { userIds: [NO_ID] }, null)).status).toBe(401);
  });
});

describe('DELETE /conversations/:conversation_id/participants/me', () => {
  const leave = (conversationId, as = cookie) => {
    const req = request(app).delete(`/conversations/${conversationId}/participants/me`);
    if (as) req.set('Cookie', as);
    return req;
  };

  let groupId;
  beforeEach(async () => {
    ({ conversationId: groupId } = await store.createGroup({ name: 'Pals' }));
    await store.addParticipants(groupId, [alice.userId, bob.userId]);
  });

  test('204; the caller loses access and the others keep it', async () => {
    const res = await leave(groupId);

    expect(res.status).toBe(204);
    const asAlice = await request(app).get(`/conversations/${groupId}`).set('Cookie', cookie);
    const asBob = await request(app).get(`/conversations/${groupId}`).set('Cookie', authCookie(bob.userId));
    expect(asAlice.status).toBe(404);
    expect(asBob.status).toBe(200);
    expect(asBob.body.participants.map((p) => p.userId)).toEqual([bob.userId]);
  });

  test("the leaver's messages stay", async () => {
    await request(app).post(`/conversations/${groupId}/messages`).set('Cookie', cookie).send({ content: 'bye' });

    await leave(groupId);

    const messages = await request(app).get(`/conversations/${groupId}/messages`).set('Cookie', authCookie(bob.userId));
    expect(messages.body.items).toEqual([
      expect.objectContaining({ content: 'bye', sender: expect.objectContaining({ userId: alice.userId }) }),
    ]);
  });

  test('the last member out deletes the group', async () => {
    await leave(groupId);
    await leave(groupId, authCookie(bob.userId));

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM conversations');
    expect(rows[0].n).toBe(0);
  });

  test('leaving twice is 404 the second time', async () => {
    await leave(groupId);
    const res = await leave(groupId);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Conversation not found' });
  });

  test('400 for a direct chat', async () => {
    const { conversationId } = await store.findOrCreateDirect(alice.userId, bob.userId);
    await store.addParticipants(conversationId, [alice.userId, bob.userId]);

    const res = await leave(conversationId);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'You cannot leave a direct conversation' });
  });

  test('a non-member and an unknown conversation get the same 404', async () => {
    const carol = await createUser(pool);

    const notMember = await leave(groupId, authCookie(carol.userId));
    const unknown = await leave(NO_ID);

    expect(notMember.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(notMember.body);
  });

  test('400 for a malformed id', async () => {
    const res = await leave('nope');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid conversation id' });
  });

  test('401 when not logged in', async () => {
    expect((await leave(groupId, null)).status).toBe(401);
  });
});

describe('PATCH /conversations/:conversation_id', () => {
  const rename = (conversationId, body, as = cookie) => {
    const req = request(app).patch(`/conversations/${conversationId}`);
    if (as) req.set('Cookie', as);
    return req.send(body);
  };

  let groupId;
  beforeEach(async () => {
    ({ conversationId: groupId } = await store.createGroup({ name: 'Old name' }));
    await store.addParticipants(groupId, [alice.userId, bob.userId]);
  });

  test('200 with the conversation view and the new name, trimmed', async () => {
    const res = await rename(groupId, { name: '  New name  ' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      conversationId: groupId,
      kind: 'group',
      name: 'New name',
      participants: expect.any(Array),
      createdAt: expect.any(String),
      lastReadAt: expect.any(String),
    });
  });

  test('any member can rename, and the others see it', async () => {
    await rename(groupId, { name: 'New name' }, authCookie(bob.userId));

    const res = await request(app).get(`/conversations/${groupId}`).set('Cookie', cookie);
    expect(res.body.name).toBe('New name');
  });

  test('null clears the name', async () => {
    const res = await rename(groupId, { name: null });
    expect(res.status).toBe(200);
    expect(res.body.name).toBeNull();
  });

  test('400 for a direct chat', async () => {
    const { conversationId } = await store.findOrCreateDirect(alice.userId, bob.userId);
    await store.addParticipants(conversationId, [alice.userId, bob.userId]);

    const res = await rename(conversationId, { name: 'Us' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Direct conversations have no name' });
  });

  test('a non-member and an unknown conversation get the same 404, and the name stays', async () => {
    const carol = await createUser(pool);

    const notMember = await rename(groupId, { name: 'Nope' }, authCookie(carol.userId));
    const unknown = await rename(NO_ID, { name: 'Nope' });

    expect(notMember.status).toBe(404);
    expect(notMember.body).toEqual({ error: 'Conversation not found' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(notMember.body);
    expect((await store.getMembership(groupId, alice.userId)).name).toBe('Old name');
  });

  test.each([
    ['an empty body', {}],
    ['a whitespace-only name', { name: '   ' }],
    ['a name over 50 characters', { name: 'x'.repeat(51) }],
    ['an unknown field', { name: 'x', kind: 'direct' }],
  ])('400 for %s', async (_, body) => {
    const res = await rename(groupId, body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid input' });
  });

  test('400 for a malformed id', async () => {
    const res = await rename('nope', { name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid conversation id' });
  });

  test('401 when not logged in', async () => {
    expect((await rename(groupId, { name: 'x' }, null)).status).toBe(401);
  });
});
