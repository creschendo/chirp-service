// Timeline validation schemas. Pure functions: no database needed.
import { timelineQuerySchema } from '../../src/modules/timeline/schemas.js';
import { encodeCursor } from '../../src/pagination.js';

const ID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';

describe('timelineQuerySchema', () => {
  test('defaults: limit 20, no cursor', () => {
    expect(timelineQuerySchema.parse({})).toEqual({ limit: 20, cursor: null });
  });

  test('decodes a cursor made from the last item', () => {
    const cursor = { createdAt: '2026-10-26T10:05:00.000Z', postId: ID };
    expect(timelineQuerySchema.parse({ limit: '5', cursor: encodeCursor(cursor) })).toEqual({ limit: 5, cursor });
  });

  test.each([
    ['limit 0', { limit: '0' }],
    ['limit over 100', { limit: '101' }],
    ['non-numeric limit', { limit: 'abc' }],
    ['garbage cursor', { cursor: 'not-a-cursor' }],
    [
      'cursor with a malformed post id',
      { cursor: encodeCursor({ createdAt: '2026-10-26T10:05:00.000Z', postId: 'x' }) },
    ],
    ['cursor with a malformed time', { cursor: encodeCursor({ createdAt: 'yesterday', postId: ID }) }],
    ['a followers cursor', { cursor: encodeCursor({ followedAt: '2026-10-26T10:05:00.000Z', userId: ID }) }],
  ])('rejects %s', (_, query) => {
    expect(timelineQuerySchema.safeParse(query).success).toBe(false);
  });
});
