// Messages validation schemas. Pure functions: no database needed.
import {
  MAX_GROUP_SIZE,
  addMembersSchema,
  createConversationSchema,
  conversationIdParamSchema,
  conversationsQuerySchema,
  messageParamsSchema,
  messagesQuerySchema,
  renameGroupSchema,
  sendMessageSchema,
} from '../../src/modules/messages/schemas.js';
import { encodeCursor } from '../../src/pagination.js';

const ID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';

describe('createConversationSchema', () => {
  const ids = (n) => Array.from({ length: n }, () => crypto.randomUUID());

  test.each([
    ['one user (a direct chat)', { userIds: [ID] }],
    ['several users and a name (a group)', { userIds: ids(3), name: 'Trio' }],
    ['the most users a group can start with', { userIds: ids(MAX_GROUP_SIZE - 1) }],
    ['a 50-character name', { userIds: ids(2), name: 'x'.repeat(50) }],
    ['repeated ids (the service removes them)', { userIds: [ID, ID] }],
  ])('accepts %s', (_, body) => {
    expect(createConversationSchema.safeParse(body).success).toBe(true);
  });

  test('trims the name, and leaves it out when not given', () => {
    expect(createConversationSchema.parse({ userIds: ids(2), name: '  Trio  ' }).name).toBe('Trio');
    expect(createConversationSchema.parse({ userIds: [ID] })).toEqual({ userIds: [ID] });
  });

  test.each([
    ['no users', { userIds: [] }, 'Pick at least one user'],
    ['too many users', { userIds: ids(MAX_GROUP_SIZE) }, `A group can have at most ${MAX_GROUP_SIZE} members`],
    ['a malformed user id', { userIds: [ID, 'nope'] }, 'Invalid user id'],
    ['an empty name', { userIds: ids(2), name: '' }, 'Group name cannot be empty'],
    ['a whitespace-only name', { userIds: ids(2), name: '   ' }, 'Group name cannot be empty'],
    [
      'a name over 50 characters',
      { userIds: ids(2), name: 'x'.repeat(51) },
      'Group name must be at most 50 characters',
    ],
  ])('rejects %s', (_, body, message) => {
    const parsed = createConversationSchema.safeParse(body);
    expect(parsed.success).toBe(false);
    expect(parsed.error.issues[0].message).toBe(message);
  });

  test.each([
    ['missing userIds', {}],
    ['userIds not an array', { userIds: ID }],
    ['a null name', { userIds: ids(2), name: null }],
    ['an unknown field', { userIds: [ID], kind: 'group' }],
  ])('rejects %s', (_, body) => {
    expect(createConversationSchema.safeParse(body).success).toBe(false);
  });
});

describe('renameGroupSchema', () => {
  test.each([
    ['a name', { name: 'New name' }],
    ['a 50-character name', { name: 'x'.repeat(50) }],
    ['null, to clear it', { name: null }],
  ])('accepts %s', (_, body) => {
    expect(renameGroupSchema.safeParse(body).success).toBe(true);
  });

  test('trims the name', () => {
    expect(renameGroupSchema.parse({ name: '  New name  ' })).toEqual({ name: 'New name' });
  });

  test.each([
    ['an empty name', { name: '' }, 'Group name cannot be empty'],
    ['a whitespace-only name', { name: '   ' }, 'Group name cannot be empty'],
    ['a name over 50 characters', { name: 'x'.repeat(51) }, 'Group name must be at most 50 characters'],
  ])('rejects %s', (_, body, message) => {
    const parsed = renameGroupSchema.safeParse(body);
    expect(parsed.success).toBe(false);
    expect(parsed.error.issues[0].message).toBe(message);
  });

  test.each([
    ['an empty body', {}],
    ['a non-string name', { name: 42 }],
    ['an unknown field', { name: 'x', kind: 'direct' }],
  ])('rejects %s', (_, body) => {
    expect(renameGroupSchema.safeParse(body).success).toBe(false);
  });
});

describe('addMembersSchema', () => {
  const ids = (n) => Array.from({ length: n }, () => crypto.randomUUID());

  test.each([
    ['one user', { userIds: [ID] }],
    ['the most that could ever fit', { userIds: ids(MAX_GROUP_SIZE - 1) }],
    ['repeated ids (addParticipants skips them)', { userIds: [ID, ID] }],
  ])('accepts %s', (_, body) => {
    expect(addMembersSchema.safeParse(body).success).toBe(true);
  });

  test.each([
    ['no users', { userIds: [] }, 'Pick at least one user'],
    [
      'more than could ever fit',
      { userIds: ids(MAX_GROUP_SIZE) },
      `A group can have at most ${MAX_GROUP_SIZE} members`,
    ],
    ['a malformed user id', { userIds: [ID, 'nope'] }, 'Invalid user id'],
  ])('rejects %s', (_, body, message) => {
    const parsed = addMembersSchema.safeParse(body);
    expect(parsed.success).toBe(false);
    expect(parsed.error.issues[0].message).toBe(message);
  });

  test.each([
    ['missing userIds', {}],
    ['userIds not an array', { userIds: ID }],
    ['a name (that is a rename)', { userIds: [ID], name: 'Trio' }],
  ])('rejects %s', (_, body) => {
    expect(addMembersSchema.safeParse(body).success).toBe(false);
  });
});

describe('conversationIdParamSchema', () => {
  test('accepts a uuid, rejects anything else', () => {
    expect(conversationIdParamSchema.safeParse({ conversation_id: ID }).success).toBe(true);
    expect(conversationIdParamSchema.safeParse({ conversation_id: 'nope' }).success).toBe(false);
  });

  test("its description is validate()'s 400 message", () => {
    expect(conversationIdParamSchema.description).toBe('Invalid conversation id');
  });
});

describe('messageParamsSchema', () => {
  test('accepts two uuids', () => {
    expect(messageParamsSchema.safeParse({ conversation_id: ID, message_id: ID }).success).toBe(true);
  });

  test.each([
    ['a bad conversation id', { conversation_id: 'nope', message_id: ID }, 'Invalid conversation id'],
    ['a bad message id', { conversation_id: ID, message_id: 'nope' }, 'Invalid message id'],
  ])('rejects %s, and the issue says which', (_, params, message) => {
    const parsed = messageParamsSchema.safeParse(params);
    expect(parsed.success).toBe(false);
    expect(parsed.error.issues.map((issue) => issue.message)).toEqual([message]);
  });

  test("its description is validate()'s 400 message", () => {
    expect(messageParamsSchema.description).toBe('Invalid id');
  });
});

describe('sendMessageSchema', () => {
  test.each([
    ['a message', { content: 'hello' }],
    ['1000 characters', { content: 'x'.repeat(1000) }],
  ])('accepts %s', (_, body) => {
    expect(sendMessageSchema.safeParse(body).success).toBe(true);
  });

  test('trims content', () => {
    expect(sendMessageSchema.parse({ content: '  hello  ' }).content).toBe('hello');
  });

  test('1000 counts after trimming', () => {
    expect(sendMessageSchema.safeParse({ content: ` ${'x'.repeat(1000)} ` }).success).toBe(true);
  });

  test.each([
    ['empty content', { content: '' }, 'Message cannot be empty'],
    ['whitespace-only content', { content: '  \n ' }, 'Message cannot be empty'],
    ['content over 1000 characters', { content: 'x'.repeat(1001) }, 'Message must be at most 1000 characters'],
  ])('rejects %s', (_, body, message) => {
    const parsed = sendMessageSchema.safeParse(body);
    expect(parsed.success).toBe(false);
    expect(parsed.error.issues[0].message).toBe(message);
  });

  test.each([
    ['missing content', {}],
    ['non-string content', { content: 42 }],
    ['null content', { content: null }],
    ['unknown field', { content: 'hi', senderId: ID }],
  ])('rejects %s', (_, body) => {
    expect(sendMessageSchema.safeParse(body).success).toBe(false);
  });
});

describe('conversationsQuerySchema', () => {
  test('defaults: limit 20, no cursor', () => {
    expect(conversationsQuerySchema.parse({})).toEqual({ limit: 20, cursor: null });
  });

  test('decodes a cursor made from the last conversation', () => {
    const cursor = { lastActivityAt: '2026-10-25T10:05:00.000Z', conversationId: ID };
    expect(conversationsQuerySchema.parse({ limit: '5', cursor: encodeCursor(cursor) })).toEqual({ limit: 5, cursor });
  });

  test.each([
    ['limit 0', { limit: '0' }],
    ['limit over 100', { limit: '101' }],
    ['garbage cursor', { cursor: 'not-a-cursor' }],
    ['a cursor with a bad date', { cursor: encodeCursor({ lastActivityAt: 'yesterday', conversationId: ID }) }],
    [
      'a cursor with a bad id',
      { cursor: encodeCursor({ lastActivityAt: '2026-10-25T10:05:00.000Z', conversationId: 'x' }) },
    ],
    ['a messages cursor', { cursor: encodeCursor({ createdAt: '2026-10-25T10:05:00.000Z', messageId: ID }) }],
  ])('rejects %s', (_, query) => {
    expect(conversationsQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('messagesQuerySchema', () => {
  test('defaults: limit 20, no cursor', () => {
    expect(messagesQuerySchema.parse({})).toEqual({ limit: 20, cursor: null });
  });

  test('decodes a cursor made from the last message', () => {
    const cursor = { createdAt: '2026-10-25T10:05:00.000Z', messageId: ID };
    expect(messagesQuerySchema.parse({ limit: '5', cursor: encodeCursor(cursor) })).toEqual({ limit: 5, cursor });
  });

  test.each([
    ['limit 0', { limit: '0' }],
    ['limit over 100', { limit: '101' }],
    ['garbage cursor', { cursor: 'not-a-cursor' }],
    ['a cursor with a bad date', { cursor: encodeCursor({ createdAt: 'yesterday', messageId: ID }) }],
    ['a cursor with a bad id', { cursor: encodeCursor({ createdAt: '2026-10-25T10:05:00.000Z', messageId: 'x' }) }],
    ['an inbox cursor', { cursor: encodeCursor({ lastActivityAt: '2026-10-25T10:05:00.000Z', conversationId: ID }) }],
  ])('rejects %s', (_, query) => {
    expect(messagesQuerySchema.safeParse(query).success).toBe(false);
  });
});
