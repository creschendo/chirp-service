// Messages store: direct and group messages (milestone 6). Each test runs in a rolled-back transaction (see
// helpers/db.js). Turn the remaining todos into tests as the store is built.
import * as store from '../../src/modules/messages/store.js';
import { useTransaction, pgErrorCode } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';

const ctx = useTransaction();
const NO_ID = '00000000-0000-0000-0000-000000000000';

// Conversations, participants and messages are inserted directly until their store functions exist.
// now() is fixed for the whole transaction, so tests that care about order pass explicit times.
async function insertGroup() {
  const { rows } = await ctx.db.query(
    `INSERT INTO conversations (kind) VALUES ('group') RETURNING conversation_id AS "conversationId"`,
  );
  return rows[0].conversationId;
}

async function insertParticipant(conversationId, userId, joinedAt = new Date('2026-01-01T00:00:00Z')) {
  await ctx.db.query(
    `INSERT INTO conversation_participants (conversation_id, user_id, joined_at, last_read_at)
     VALUES ($1, $2, $3, $3)`,
    [conversationId, userId, joinedAt],
  );
}

async function insertDirect(userA, userB) {
  const [low, high] = [userA, userB].sort();
  const { rows } = await ctx.db.query(
    `INSERT INTO conversations (kind, direct_user_low_id, direct_user_high_id)
     VALUES ('direct', $1, $2)
     RETURNING conversation_id AS "conversationId"`,
    [low, high],
  );
  await insertParticipant(rows[0].conversationId, userA);
  await insertParticipant(rows[0].conversationId, userB);
  return rows[0].conversationId;
}

async function insertMessage(conversationId, senderId, { content = 'hi', createdAt = new Date() } = {}) {
  const { rows } = await ctx.db.query(
    `INSERT INTO messages (conversation_id, sender_id, content, created_at)
     VALUES ($1, $2, $3, $4)
     RETURNING message_id AS "messageId"`,
    [conversationId, senderId, content, createdAt],
  );
  return rows[0].messageId;
}

async function lastReadAt(conversationId, userId) {
  const { rows } = await ctx.db.query(
    `SELECT last_read_at FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  return rows[0].last_read_at;
}

const at = (minute) => new Date(`2026-01-01T10:${String(minute).padStart(2, '0')}:00Z`);

let alice;
let bob;
let conversationId;
beforeEach(async () => {
  alice = await createUser(ctx.db);
  bob = await createUser(ctx.db);
  conversationId = await insertGroup();
  await insertParticipant(conversationId, alice.userId);
  await insertParticipant(conversationId, bob.userId);
});

describe('findOrCreateDirect', () => {
  test('creates a direct chat with the pair sorted, and no members yet', async () => {
    const { conversationId: id, created } = await store.findOrCreateDirect(alice.userId, bob.userId, ctx.db);
    expect(created).toBe(true);

    const { rows } = await ctx.db.query(
      `SELECT kind, name, direct_user_low_id AS low, direct_user_high_id AS high
       FROM conversations WHERE conversation_id = $1`,
      [id],
    );
    const [low, high] = [alice.userId, bob.userId].sort();
    expect(rows[0]).toEqual({ kind: 'direct', name: null, low, high });
    expect(await store.countParticipants(id, ctx.db)).toBe(0);
  });

  test('the same pair returns the same conversation in either order', async () => {
    const first = await store.findOrCreateDirect(alice.userId, bob.userId, ctx.db);

    expect(await store.findOrCreateDirect(alice.userId, bob.userId, ctx.db)).toEqual({
      conversationId: first.conversationId,
      created: false,
    });
    expect(await store.findOrCreateDirect(bob.userId, alice.userId, ctx.db)).toEqual({
      conversationId: first.conversationId,
      created: false,
    });
  });

  test('a different pair gets a different conversation', async () => {
    const carol = await createUser(ctx.db);
    const first = await store.findOrCreateDirect(alice.userId, bob.userId, ctx.db);
    const second = await store.findOrCreateDirect(alice.userId, carol.userId, ctx.db);
    expect(second.created).toBe(true);
    expect(second.conversationId).not.toBe(first.conversationId);
  });

  test('ids in upper case find the same conversation', async () => {
    const first = await store.findOrCreateDirect(alice.userId, bob.userId, ctx.db);
    const again = await store.findOrCreateDirect(bob.userId.toUpperCase(), alice.userId, ctx.db);
    expect(again).toEqual({ conversationId: first.conversationId, created: false });
  });

  test('cannot start a conversation with yourself -> 23514', async () => {
    const code = await pgErrorCode(ctx.db, () => store.findOrCreateDirect(alice.userId, alice.userId, ctx.db));
    expect(code).toBe('23514');
  });

  test('unknown user -> 23503', async () => {
    const code = await pgErrorCode(ctx.db, () => store.findOrCreateDirect(alice.userId, NO_ID, ctx.db));
    expect(code).toBe('23503');
  });
});

describe('group conversations', () => {
  test.todo('remove participant; the last one out deletes the conversation');

  // renameGroup never writes to a direct chat, so these go straight to the table to reach the constraints.
  test('a name on a direct conversation is rejected by a constraint', async () => {
    const direct = await insertDirect(alice.userId, bob.userId);
    const code = await pgErrorCode(ctx.db, () =>
      ctx.db.query(`UPDATE conversations SET name = 'Nope' WHERE conversation_id = $1`, [direct]),
    );
    expect(code).toBe('23514');
  });

  test('a name over 50 characters is rejected by a constraint', async () => {
    const code = await pgErrorCode(ctx.db, () =>
      ctx.db.query(`UPDATE conversations SET name = $2 WHERE conversation_id = $1`, [conversationId, 'x'.repeat(51)]),
    );
    expect(code).toBe('23514');
  });
});

describe('listConversations', () => {
  const inbox = (userId, page = {}) => store.listConversations(userId, { limit: 10, ...page }, ctx.db);
  const inboxItem = async (userId, id) => (await inbox(userId)).find((c) => c.conversationId === id);

  // A group with the given activity time and members.
  async function groupActiveAt(activityAt, ...userIds) {
    const id = await insertGroup();
    await ctx.db.query('UPDATE conversations SET last_activity_at = $2 WHERE conversation_id = $1', [id, activityAt]);
    for (const userId of userIds) {
      await insertParticipant(id, userId);
    }
    return id;
  }

  test('returns the item shape, with everyone else as participants', async () => {
    const messageId = await insertMessage(conversationId, bob.userId, { content: 'hey', createdAt: at(1) });

    const [item] = await inbox(alice.userId);
    expect(item).toEqual({
      conversationId,
      kind: 'group',
      name: null,
      participants: [{ userId: bob.userId, username: bob.username, displayName: bob.displayName }],
      lastMessage: {
        messageId,
        conversationId,
        sender: { userId: bob.userId, username: bob.username, displayName: bob.displayName },
        content: 'hey',
        createdAt: at(1),
        deleted: false,
      },
      unreadCount: 1,
      lastActivityAt: expect.any(Date),
    });
  });

  test('orders by most recent activity and paginates, ties broken by conversation id', async () => {
    const carol = await createUser(ctx.db);
    const older = await groupActiveAt(at(1), carol.userId);
    const tiedA = await groupActiveAt(at(2), carol.userId);
    const tiedB = await groupActiveAt(at(2), carol.userId);

    const seen = [];
    let cursor = null;
    do {
      const page = await inbox(carol.userId, { limit: 2, cursor });
      seen.push(...page.map((c) => c.conversationId));
      const last = page.at(-1);
      cursor =
        page.length === 2
          ? { lastActivityAt: last.lastActivityAt.toISOString(), conversationId: last.conversationId }
          : null;
    } while (cursor);

    expect(seen).toEqual([...[tiedA, tiedB].sort().reverse(), older]);
  });

  test("only returns the user's own conversations", async () => {
    const carol = await createUser(ctx.db);
    expect(await inbox(carol.userId)).toEqual([]);
  });

  test('leaves out a direct conversation with no messages, but lists an empty group', async () => {
    const direct = await insertDirect(alice.userId, bob.userId);
    expect(await inboxItem(alice.userId, direct)).toBeUndefined();

    const empty = await inboxItem(alice.userId, conversationId);
    expect(empty).toMatchObject({ lastMessage: null, unreadCount: 0 });

    await insertMessage(direct, alice.userId);
    expect(await inboxItem(bob.userId, direct)).toMatchObject({ kind: 'direct' });
  });

  test('the preview is the newest message, shown as deleted if it was deleted', async () => {
    await insertMessage(conversationId, bob.userId, { content: 'older', createdAt: at(1) });
    const newest = await insertMessage(conversationId, bob.userId, { content: 'newer', createdAt: at(2) });
    expect((await inboxItem(alice.userId, conversationId)).lastMessage.content).toBe('newer');

    await store.softDeleteMessage(newest, bob.userId, ctx.db);
    expect((await inboxItem(alice.userId, conversationId)).lastMessage).toMatchObject({
      messageId: newest,
      content: null,
      deleted: true,
    });
  });

  test('a late joiner sees no earlier messages in the preview or the unread count', async () => {
    const carol = await createUser(ctx.db);
    await insertMessage(conversationId, bob.userId, { createdAt: at(1) });
    await insertParticipant(conversationId, carol.userId, at(2));

    expect(await inboxItem(carol.userId, conversationId)).toMatchObject({ lastMessage: null, unreadCount: 0 });

    await insertMessage(conversationId, bob.userId, { content: 'welcome', createdAt: at(3) });
    expect(await inboxItem(carol.userId, conversationId)).toMatchObject({
      lastMessage: { content: 'welcome' },
      unreadCount: 1,
    });
  });

  test("unread count leaves out read, deleted and the viewer's own messages", async () => {
    await insertMessage(conversationId, bob.userId, { createdAt: at(1) });
    await store.markRead(conversationId, alice.userId, at(1), ctx.db);

    await insertMessage(conversationId, bob.userId, { createdAt: at(2) });
    await insertMessage(conversationId, alice.userId, { createdAt: at(3) });
    const deleted = await insertMessage(conversationId, bob.userId, { createdAt: at(4) });
    await store.softDeleteMessage(deleted, bob.userId, ctx.db);

    expect((await inboxItem(alice.userId, conversationId)).unreadCount).toBe(1);
  });

  test('messages from a deleted account still count as unread', async () => {
    await insertMessage(conversationId, bob.userId, { createdAt: at(1) });
    await ctx.db.query('DELETE FROM users WHERE user_id = $1', [bob.userId]);

    expect(await inboxItem(alice.userId, conversationId)).toMatchObject({
      participants: [],
      lastMessage: { sender: null },
      unreadCount: 1,
    });
  });
});

describe('listMessages', () => {
  const visibleFrom = new Date('2026-01-01T00:00:00Z');

  test('returns message views, newest first', async () => {
    const first = await insertMessage(conversationId, alice.userId, { content: 'first', createdAt: at(1) });
    const second = await insertMessage(conversationId, bob.userId, { content: 'second', createdAt: at(2) });

    const messages = await store.listMessages(conversationId, { visibleFrom, limit: 10 }, ctx.db);
    expect(messages).toEqual([
      {
        messageId: second,
        conversationId,
        sender: { userId: bob.userId, username: bob.username, displayName: bob.displayName },
        content: 'second',
        createdAt: at(2),
        deleted: false,
      },
      expect.objectContaining({ messageId: first, content: 'first' }),
    ]);
  });

  test('paginates with a cursor, ties broken by message id', async () => {
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(await insertMessage(conversationId, alice.userId, { createdAt: at(5) }));
    }
    ids.push(await insertMessage(conversationId, alice.userId, { createdAt: at(4) }));

    const seen = [];
    let cursor = null;
    do {
      const page = await store.listMessages(conversationId, { visibleFrom, limit: 2, cursor }, ctx.db);
      seen.push(...page.map((m) => m.messageId));
      const last = page.at(-1);
      cursor = page.length === 2 ? { createdAt: last.createdAt.toISOString(), messageId: last.messageId } : null;
    } while (cursor);

    expect(seen).toHaveLength(4);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(seen.at(-1)).toBe(ids[3]);
  });

  test('hides messages from before visibleFrom', async () => {
    await insertMessage(conversationId, alice.userId, { content: 'before', createdAt: at(1) });
    const after = await insertMessage(conversationId, alice.userId, { content: 'after', createdAt: at(3) });

    const messages = await store.listMessages(conversationId, { visibleFrom: at(2), limit: 10 }, ctx.db);
    expect(messages.map((m) => m.messageId)).toEqual([after]);
  });

  test('includes deleted messages without content, keeping the sender', async () => {
    const messageId = await insertMessage(conversationId, alice.userId);
    await store.softDeleteMessage(messageId, alice.userId, ctx.db);

    const [message] = await store.listMessages(conversationId, { visibleFrom, limit: 10 }, ctx.db);
    expect(message).toMatchObject({ messageId, content: null, deleted: true, sender: { userId: alice.userId } });
  });

  test("a deleted sender's messages have sender null", async () => {
    await insertMessage(conversationId, bob.userId);
    await ctx.db.query('DELETE FROM users WHERE user_id = $1', [bob.userId]);

    const [message] = await store.listMessages(conversationId, { visibleFrom, limit: 10 }, ctx.db);
    expect(message.sender).toBeNull();
  });

  test('only returns messages from the given conversation', async () => {
    const other = await insertGroup();
    await insertMessage(other, alice.userId);

    expect(await store.listMessages(conversationId, { visibleFrom, limit: 10 }, ctx.db)).toEqual([]);
  });
});

describe('createMessage', () => {
  const send = (fields) => store.createMessage({ conversationId, senderId: alice.userId, ...fields }, ctx.db);

  test('inserts a message and returns its message view with the sender', async () => {
    const message = await send({ content: 'hello' });
    expect(message).toEqual({
      messageId: expect.any(String),
      conversationId,
      sender: { userId: alice.userId, username: alice.username, displayName: alice.displayName },
      content: 'hello',
      createdAt: expect.any(Date),
      deleted: false,
    });
  });

  test('returns the same view listMessages does', async () => {
    const message = await send({ content: 'hello' });
    const [listed] = await store.listMessages(
      conversationId,
      { visibleFrom: new Date('2026-01-01T00:00:00Z'), limit: 10 },
      ctx.db,
    );
    expect(listed).toEqual(message);
  });

  test('empty or over-length message is rejected by a constraint', async () => {
    expect(await pgErrorCode(ctx.db, () => send({ content: '' }))).toBe('23514');
    expect(await pgErrorCode(ctx.db, () => send({ content: 'x'.repeat(1001) }))).toBe('23514');
  });

  test('unknown conversation -> 23503', async () => {
    const code = await pgErrorCode(ctx.db, () =>
      store.createMessage({ conversationId: NO_ID, senderId: alice.userId, content: 'hi' }, ctx.db),
    );
    expect(code).toBe('23503');
  });
});

describe('createGroup', () => {
  const row = async (id) => {
    const { rows } = await ctx.db.query(
      `SELECT kind, name, direct_user_low_id, direct_user_high_id FROM conversations WHERE conversation_id = $1`,
      [id],
    );
    return rows[0];
  };

  test('creates a named group and returns { conversationId }', async () => {
    const created = await store.createGroup({ name: 'Weekend plans' }, ctx.db);
    expect(created).toEqual({ conversationId: expect.any(String) });
    expect(await row(created.conversationId)).toEqual({
      kind: 'group',
      name: 'Weekend plans',
      direct_user_low_id: null,
      direct_user_high_id: null,
    });
  });

  test('the name is optional', async () => {
    const { conversationId: id } = await store.createGroup({}, ctx.db);
    expect((await row(id)).name).toBeNull();
  });

  test('starts with no members', async () => {
    const { conversationId: id } = await store.createGroup({}, ctx.db);
    expect(await store.countParticipants(id, ctx.db)).toBe(0);
  });

  test('the same name twice makes two groups', async () => {
    const first = await store.createGroup({ name: 'Same' }, ctx.db);
    const second = await store.createGroup({ name: 'Same' }, ctx.db);
    expect(first.conversationId).not.toBe(second.conversationId);
  });

  test('an empty or over-length name is rejected by a constraint', async () => {
    expect(await pgErrorCode(ctx.db, () => store.createGroup({ name: '' }, ctx.db))).toBe('23514');
    expect(await pgErrorCode(ctx.db, () => store.createGroup({ name: 'x'.repeat(51) }, ctx.db))).toBe('23514');
  });
});

describe('lockConversation', () => {
  test('returns true for an existing conversation', async () => {
    expect(await store.lockConversation(conversationId, ctx.db)).toBe(true);
  });

  test('returns false for an unknown conversation', async () => {
    expect(await store.lockConversation(NO_ID, ctx.db)).toBe(false);
  });

  test('still allows a message insert in the same transaction', async () => {
    await store.lockConversation(conversationId, ctx.db);
    expect(await insertMessage(conversationId, alice.userId)).toEqual(expect.any(String));
  });
});

describe('deleteConversation', () => {
  const count = async (table, id) => {
    const { rows } = await ctx.db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE conversation_id = $1`, [id]);
    return rows[0].n;
  };

  test('deletes a group along with its participants and messages', async () => {
    await insertMessage(conversationId, alice.userId);

    expect(await store.deleteConversation(conversationId, ctx.db)).toBe(true);

    expect(await count('conversations', conversationId)).toBe(0);
    expect(await count('conversation_participants', conversationId)).toBe(0);
    expect(await count('messages', conversationId)).toBe(0);
  });

  test('leaves other conversations alone', async () => {
    const other = await insertGroup();
    await insertMessage(other, alice.userId);

    await store.deleteConversation(conversationId, ctx.db);

    expect(await count('conversations', other)).toBe(1);
    expect(await count('messages', other)).toBe(1);
  });

  test('returns false for a direct chat and leaves it in place', async () => {
    const direct = await insertDirect(alice.userId, bob.userId);
    expect(await store.deleteConversation(direct, ctx.db)).toBe(false);
    expect(await count('conversations', direct)).toBe(1);
  });

  test('returns false for an unknown conversation', async () => {
    expect(await store.deleteConversation(NO_ID, ctx.db)).toBe(false);
  });
});

describe('touchConversation', () => {
  const activityOf = async (id) => {
    const { rows } = await ctx.db.query('SELECT last_activity_at FROM conversations WHERE conversation_id = $1', [id]);
    return rows[0].last_activity_at;
  };

  // New conversations default to now(), which is later than the at() times.
  beforeEach(async () => {
    await ctx.db.query('UPDATE conversations SET last_activity_at = $2 WHERE conversation_id = $1', [
      conversationId,
      at(1),
    ]);
  });

  test('moves last_activity_at forward to the given time', async () => {
    expect(await store.touchConversation(conversationId, at(5), ctx.db)).toBe(true);
    expect(await activityOf(conversationId)).toEqual(at(5));
  });

  test('never moves last_activity_at backwards', async () => {
    await store.touchConversation(conversationId, at(5), ctx.db);
    expect(await store.touchConversation(conversationId, at(2), ctx.db)).toBe(true);
    expect(await activityOf(conversationId)).toEqual(at(5));
  });

  test("with no time, uses the database's now()", async () => {
    await store.touchConversation(conversationId, null, ctx.db);
    const { rows } = await ctx.db.query('SELECT now()::timestamptz(3) AS now');
    expect(await activityOf(conversationId)).toEqual(rows[0].now);
  });

  test('only changes the given conversation', async () => {
    const other = await insertGroup();
    const before = await activityOf(other);
    await store.touchConversation(conversationId, new Date('2030-01-01T00:00:00Z'), ctx.db);
    expect(await activityOf(other)).toEqual(before);
  });

  test('returns false for an unknown conversation', async () => {
    expect(await store.touchConversation(NO_ID, at(5), ctx.db)).toBe(false);
  });
});

describe('renameGroup', () => {
  const nameOf = async (id) => {
    const { rows } = await ctx.db.query('SELECT name FROM conversations WHERE conversation_id = $1', [id]);
    return rows[0].name;
  };

  test('sets the name, and null clears it', async () => {
    expect(await store.renameGroup(conversationId, 'Weekend plans', ctx.db)).toBe(true);
    expect(await nameOf(conversationId)).toBe('Weekend plans');

    expect(await store.renameGroup(conversationId, null, ctx.db)).toBe(true);
    expect(await nameOf(conversationId)).toBeNull();
  });

  test('only changes the given group', async () => {
    const other = await insertGroup();
    await store.renameGroup(conversationId, 'Weekend plans', ctx.db);
    expect(await nameOf(other)).toBeNull();
  });

  test('returns false for a direct chat and leaves it unnamed', async () => {
    const direct = await insertDirect(alice.userId, bob.userId);
    expect(await store.renameGroup(direct, 'Nope', ctx.db)).toBe(false);
    expect(await nameOf(direct)).toBeNull();
  });

  test('returns false for an unknown conversation', async () => {
    expect(await store.renameGroup(NO_ID, 'Nope', ctx.db)).toBe(false);
  });

  test('an empty or over-length name is rejected by a constraint', async () => {
    expect(await pgErrorCode(ctx.db, () => store.renameGroup(conversationId, '', ctx.db))).toBe('23514');
    expect(await pgErrorCode(ctx.db, () => store.renameGroup(conversationId, 'x'.repeat(51), ctx.db))).toBe('23514');
  });
});

describe('listParticipants', () => {
  test('returns every member, including the caller, earliest joined first', async () => {
    const carol = await createUser(ctx.db);
    await insertParticipant(conversationId, carol.userId, new Date('2025-12-31T00:00:00Z'));

    const participants = await store.listParticipants(conversationId, ctx.db);
    expect(participants[0]).toEqual({
      userId: carol.userId,
      username: carol.username,
      displayName: carol.displayName,
      joinedAt: new Date('2025-12-31T00:00:00Z'),
    });
    expect(participants.map((p) => p.userId)).toEqual([
      carol.userId,
      ...[alice.userId, bob.userId].sort(), // same joined_at: user id breaks the tie
    ]);
  });

  test("only returns the given conversation's members", async () => {
    const carol = await createUser(ctx.db);
    const other = await insertGroup();
    await insertParticipant(other, carol.userId);

    const participants = await store.listParticipants(other, ctx.db);
    expect(participants.map((p) => p.userId)).toEqual([carol.userId]);
  });

  test('returns [] for an unknown conversation', async () => {
    expect(await store.listParticipants(NO_ID, ctx.db)).toEqual([]);
  });
});

describe('addParticipants', () => {
  let carol;
  let dan;
  beforeEach(async () => {
    carol = await createUser(ctx.db);
    dan = await createUser(ctx.db);
  });

  test('adds every user and returns their ids', async () => {
    const added = await store.addParticipants(conversationId, [carol.userId, dan.userId], ctx.db);
    expect(added.sort()).toEqual([carol.userId, dan.userId].sort());
    expect(await store.countParticipants(conversationId, ctx.db)).toBe(4);
  });

  test('joined_at and last_read_at both default to now()', async () => {
    await store.addParticipants(conversationId, [carol.userId], ctx.db);

    const { rows } = await ctx.db.query('SELECT now()::timestamptz(3) AS now');
    expect(await store.getMembership(conversationId, carol.userId, {}, ctx.db)).toMatchObject({
      joinedAt: rows[0].now,
      lastReadAt: rows[0].now,
    });
  });

  test('skips existing members, keeping their joined_at, and returns only the new ones', async () => {
    const before = await store.getMembership(conversationId, alice.userId, {}, ctx.db);

    expect(await store.addParticipants(conversationId, [alice.userId, carol.userId], ctx.db)).toEqual([carol.userId]);

    expect(await store.getMembership(conversationId, alice.userId, {}, ctx.db)).toEqual(before);
  });

  test('a repeated id is added once', async () => {
    expect(await store.addParticipants(conversationId, [carol.userId, carol.userId], ctx.db)).toEqual([carol.userId]);
    expect(await store.countParticipants(conversationId, ctx.db)).toBe(3);
  });

  test('an empty list adds nobody', async () => {
    expect(await store.addParticipants(conversationId, [], ctx.db)).toEqual([]);
  });

  test('being re-added gets a new joined_at', async () => {
    const before = await store.getMembership(conversationId, alice.userId, {}, ctx.db);
    await store.removeParticipant(conversationId, alice.userId, ctx.db);

    await store.addParticipants(conversationId, [alice.userId], ctx.db);

    const after = await store.getMembership(conversationId, alice.userId, {}, ctx.db);
    expect(after.joinedAt.getTime()).toBeGreaterThan(before.joinedAt.getTime());
  });

  test('an unknown user or conversation -> 23503, and nobody is added', async () => {
    const unknownUser = () => store.addParticipants(conversationId, [carol.userId, NO_ID], ctx.db);
    expect(await pgErrorCode(ctx.db, unknownUser)).toBe('23503');
    expect(await store.countParticipants(conversationId, ctx.db)).toBe(2);

    const unknownConversation = () => store.addParticipants(NO_ID, [carol.userId], ctx.db);
    expect(await pgErrorCode(ctx.db, unknownConversation)).toBe('23503');
  });
});

describe('removeParticipant', () => {
  test('removes only that member and keeps their messages', async () => {
    const messageId = await insertMessage(conversationId, alice.userId);

    expect(await store.removeParticipant(conversationId, alice.userId, ctx.db)).toBe(true);

    expect(await store.getMembership(conversationId, alice.userId, {}, ctx.db)).toBeNull();
    expect(await store.getMembership(conversationId, bob.userId, {}, ctx.db)).not.toBeNull();
    expect((await store.getMessageById(messageId, ctx.db)).senderId).toBe(alice.userId);
  });

  test('only removes them from the given conversation', async () => {
    const other = await insertGroup();
    await insertParticipant(other, alice.userId);

    await store.removeParticipant(conversationId, alice.userId, ctx.db);

    expect(await store.getMembership(other, alice.userId, {}, ctx.db)).not.toBeNull();
  });

  test('returns false for a non-member or an unknown conversation', async () => {
    const carol = await createUser(ctx.db);
    expect(await store.removeParticipant(conversationId, carol.userId, ctx.db)).toBe(false);
    expect(await store.removeParticipant(NO_ID, alice.userId, ctx.db)).toBe(false);
  });

  test('leaves the conversation in place when the last member goes', async () => {
    const solo = await insertGroup();
    await insertParticipant(solo, alice.userId);

    await store.removeParticipant(solo, alice.userId, ctx.db);

    expect(await store.countParticipants(solo, ctx.db)).toBe(0);
    expect(await store.renameGroup(solo, 'Still here', ctx.db)).toBe(true);
  });
});

describe('countParticipants', () => {
  test("counts the given conversation's members", async () => {
    const carol = await createUser(ctx.db);
    const other = await insertGroup();
    await insertParticipant(other, carol.userId);

    expect(await store.countParticipants(conversationId, ctx.db)).toBe(2);
    expect(await store.countParticipants(other, ctx.db)).toBe(1);
  });

  test('returns 0 for an empty group or an unknown conversation', async () => {
    expect(await store.countParticipants(await insertGroup(), ctx.db)).toBe(0);
    expect(await store.countParticipants(NO_ID, ctx.db)).toBe(0);
  });
});

describe('getMembership', () => {
  test("returns the conversation's details and the member's own times", async () => {
    expect(await store.getMembership(conversationId, alice.userId, {}, ctx.db)).toEqual({
      conversationId,
      kind: 'group',
      name: null,
      joinedAt: new Date('2026-01-01T00:00:00Z'),
      lastReadAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  test('a non-participant gets null', async () => {
    const carol = await createUser(ctx.db);
    expect(await store.getMembership(conversationId, carol.userId, {}, ctx.db)).toBeNull();
  });

  test('an unknown conversation gets null', async () => {
    expect(await store.getMembership(NO_ID, alice.userId, {}, ctx.db)).toBeNull();
  });

  test('returns the same result with lock', async () => {
    const carol = await createUser(ctx.db);
    expect(await store.getMembership(conversationId, alice.userId, { lock: true }, ctx.db)).toEqual(
      await store.getMembership(conversationId, alice.userId, {}, ctx.db),
    );
    expect(await store.getMembership(conversationId, carol.userId, { lock: true }, ctx.db)).toBeNull();
  });
});

describe('getMessageById', () => {
  test("returns the message's own columns", async () => {
    const messageId = await insertMessage(conversationId, alice.userId, { createdAt: at(1) });
    expect(await store.getMessageById(messageId, ctx.db)).toEqual({
      messageId,
      conversationId,
      senderId: alice.userId,
      createdAt: at(1),
      deletedAt: null,
    });
  });

  test('returns a deleted message with deletedAt set', async () => {
    const messageId = await insertMessage(conversationId, alice.userId);
    await store.softDeleteMessage(messageId, alice.userId, ctx.db);
    expect((await store.getMessageById(messageId, ctx.db)).deletedAt).toEqual(expect.any(Date));
  });

  test('returns null for an unknown message', async () => {
    expect(await store.getMessageById(NO_ID, ctx.db)).toBeNull();
  });
});

describe('softDeleteMessage', () => {
  test("clears content and sets deleted_at on the sender's own message", async () => {
    const messageId = await insertMessage(conversationId, alice.userId);
    expect(await store.softDeleteMessage(messageId, alice.userId, ctx.db)).toBe(true);

    const { rows } = await ctx.db.query('SELECT content, deleted_at FROM messages WHERE message_id = $1', [
      messageId,
    ]);
    expect(rows[0]).toEqual({ content: null, deleted_at: expect.any(Date) });
  });

  test("returns false for someone else's message and leaves it alone", async () => {
    const messageId = await insertMessage(conversationId, alice.userId);
    expect(await store.softDeleteMessage(messageId, bob.userId, ctx.db)).toBe(false);
    expect((await store.getMessageById(messageId, ctx.db)).deletedAt).toBeNull();
  });

  test('returns false when already deleted or unknown', async () => {
    const messageId = await insertMessage(conversationId, alice.userId);
    await store.softDeleteMessage(messageId, alice.userId, ctx.db);
    expect(await store.softDeleteMessage(messageId, alice.userId, ctx.db)).toBe(false);
    expect(await store.softDeleteMessage(NO_ID, alice.userId, ctx.db)).toBe(false);
  });
});

describe('markRead', () => {
  test('moves last_read_at forward to the given time', async () => {
    expect(await store.markRead(conversationId, alice.userId, at(5), ctx.db)).toBe(true);
    expect(await lastReadAt(conversationId, alice.userId)).toEqual(at(5));
  });

  test('never moves last_read_at backwards', async () => {
    await store.markRead(conversationId, alice.userId, at(5), ctx.db);
    expect(await store.markRead(conversationId, alice.userId, at(2), ctx.db)).toBe(true);
    expect(await lastReadAt(conversationId, alice.userId)).toEqual(at(5));
  });

  test("with no time, uses the database's now()", async () => {
    await store.markRead(conversationId, alice.userId, null, ctx.db);
    // Cast like the column, which rounds to milliseconds (date_trunc would truncate and sometimes be 1ms off).
    const { rows } = await ctx.db.query('SELECT now()::timestamptz(3) AS now');
    expect(await lastReadAt(conversationId, alice.userId)).toEqual(rows[0].now);
  });

  test('returns false for a non-member', async () => {
    const carol = await createUser(ctx.db);
    expect(await store.markRead(conversationId, carol.userId, null, ctx.db)).toBe(false);
  });
});

describe('deletes', () => {
  test('deleting a user removes their participant rows and direct chats, and keeps their group messages', async () => {
    const carol = await createUser(ctx.db);
    const direct = await insertDirect(alice.userId, bob.userId);
    const directMessage = await insertMessage(direct, bob.userId);
    const unrelatedDirect = await insertDirect(bob.userId, carol.userId);
    const groupMessage = await insertMessage(conversationId, alice.userId);

    await ctx.db.query('DELETE FROM users WHERE user_id = $1', [alice.userId]);

    // Their membership is gone; the group and the other members stay.
    expect(await store.getMembership(conversationId, alice.userId, {}, ctx.db)).toBeNull();
    expect(await store.getMembership(conversationId, bob.userId, {}, ctx.db)).not.toBeNull();
    expect(await store.countParticipants(conversationId, ctx.db)).toBe(1);

    // Their message in the group stays, with no sender.
    expect(await store.getMessageById(groupMessage, ctx.db)).toMatchObject({ senderId: null, deletedAt: null });

    // Their direct chat goes, with its participants and messages, even for the other person.
    expect(await store.getMembership(direct, bob.userId, {}, ctx.db)).toBeNull();
    expect(await store.countParticipants(direct, ctx.db)).toBe(0);
    expect(await store.getMessageById(directMessage, ctx.db)).toBeNull();

    // Other people's direct chats are untouched.
    expect(await store.getMembership(unrelatedDirect, bob.userId, {}, ctx.db)).not.toBeNull();
  });
});
