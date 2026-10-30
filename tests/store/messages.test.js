// Messages store: direct and group messages (milestone 6). Each test runs in a rolled-back transaction (see
// helpers/db.js). Turn the remaining todos into tests as the store is built.
import * as store from '../../src/modules/messages/store.js';
import { useTransaction, pgErrorCode } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';

const ctx = useTransaction();
const NO_MESSAGE = '00000000-0000-0000-0000-000000000000';

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

describe('direct conversations', () => {
  test.todo('find-or-create a one-to-one conversation; same pair returns the same conversation in either order');
  test.todo('concurrent find-or-create for the same pair yields one conversation');
  test.todo('cannot start a conversation with yourself (conversations_direct_pair_order)');
  test.todo('unknown user -> 23503');
});

describe('group conversations', () => {
  test.todo('create a group; the same members twice makes two groups');
  test.todo('add participants skips existing members and returns only the new ones');
  test.todo('remove participant; the last one out deletes the conversation');
  test.todo('name is rejected on a direct conversation and over 50 characters');
});

describe('inbox', () => {
  test.todo("list a user's conversations, most recent activity first, paginated, with the other participants");
  test.todo('a direct conversation with no messages is left out; an empty group is listed');
  test.todo('last message preview and unread count only count messages visible to the viewer');
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

describe('messages', () => {
  test.todo('send a message to a conversation you are part of');
  test.todo('a non-participant gets nothing (getMembership returns null)');

  test('empty or over-length message is rejected by a constraint', async () => {
    expect(await pgErrorCode(ctx.db, () => insertMessage(conversationId, alice.userId, { content: '' }))).toBe(
      '23514',
    );
    expect(
      await pgErrorCode(ctx.db, () => insertMessage(conversationId, alice.userId, { content: 'x'.repeat(1001) })),
    ).toBe('23514');
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
    expect(await store.getMessageById(NO_MESSAGE, ctx.db)).toBeNull();
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
    expect(await store.softDeleteMessage(NO_MESSAGE, alice.userId, ctx.db)).toBe(false);
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

  test.todo("your own messages don't count as unread (with listConversations)");
});

describe('deletes', () => {
  test.todo(
    'deleting a user removes their participant rows and direct chats, and keeps their group messages with sender null',
  );
});
