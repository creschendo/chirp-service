// Notifications validation schemas. Pure functions: no database needed.
import { markReadSchema, notificationsQuerySchema } from '../../src/modules/notifications/schemas.js';
import { encodeCursor } from '../../src/pagination.js';

const ID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const TIME = '2026-11-04T10:05:00.000Z';

describe('notificationsQuerySchema', () => {
  test('defaults: limit 20, no cursor', () => {
    expect(notificationsQuerySchema.parse({})).toEqual({ limit: 20, cursor: null });
  });

  test('decodes a cursor made from the last notification', () => {
    const cursor = { createdAt: TIME, notificationId: ID };
    expect(notificationsQuerySchema.parse({ limit: '5', cursor: encodeCursor(cursor) })).toEqual({ limit: 5, cursor });
  });

  test.each([
    ['limit 0', { limit: '0' }],
    ['limit over 100', { limit: '101' }],
    ['a non-numeric limit', { limit: 'ten' }],
    ['garbage cursor', { cursor: 'not-a-cursor' }],
    ['a cursor with a bad time', { cursor: encodeCursor({ createdAt: 'yesterday', notificationId: ID }) }],
    ['a cursor with a bad id', { cursor: encodeCursor({ createdAt: TIME, notificationId: 'x' }) }],
    ['a timeline cursor', { cursor: encodeCursor({ activityAt: TIME, itemId: ID }) }],
  ])('rejects %s', (_, query) => {
    expect(notificationsQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('markReadSchema', () => {
  test('accepts an ISO time and keeps it as a string', () => {
    expect(markReadSchema.parse({ upTo: TIME })).toEqual({ upTo: TIME });
  });

  test('accepts a future time (the store clamps it)', () => {
    expect(markReadSchema.safeParse({ upTo: '2999-01-01T00:00:00.000Z' }).success).toBe(true);
  });

  test.each([
    ['no body', undefined],
    ['an empty body', {}],
    ['a missing upTo', { other: TIME }],
    ['a non-ISO time', { upTo: 'yesterday' }],
    ['a date without a time', { upTo: '2026-11-04' }],
    ['a number', { upTo: 1762250700000 }],
    ['null', { upTo: null }],
    ['an unknown key', { upTo: TIME, all: true }],
  ])('rejects %s', (_, body) => {
    expect(markReadSchema.safeParse(body).success).toBe(false);
  });

  test('the error says what was wrong', () => {
    expect(markReadSchema.safeParse({ upTo: 'yesterday' }).error.issues[0].message).toBe('Invalid upTo time');
  });
});
