// Engagement validation schemas. Pure functions: no database needed.
import { bookmarksQuerySchema, likesQuerySchema } from '../../src/modules/engagement/schemas.js';
import { encodeCursor } from '../../src/pagination.js';

const ID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const TIME = '2026-11-04T10:05:00.000Z';

describe.each([
  ['likesQuerySchema', likesQuerySchema, 'likedAt', 'bookmarkedAt'],
  ['bookmarksQuerySchema', bookmarksQuerySchema, 'bookmarkedAt', 'likedAt'],
])('%s', (_, schema, timeKey, otherTimeKey) => {
  test('defaults: limit 20, no cursor', () => {
    expect(schema.parse({})).toEqual({ limit: 20, cursor: null });
  });

  test('decodes a cursor made from the last item', () => {
    const cursor = { [timeKey]: TIME, postId: ID };
    expect(schema.parse({ limit: '5', cursor: encodeCursor(cursor) })).toEqual({ limit: 5, cursor });
  });

  test.each([
    ['limit 0', { limit: '0' }],
    ['limit over 100', { limit: '101' }],
    ['garbage cursor', { cursor: 'not-a-cursor' }],
    ['a cursor with a bad time', { cursor: encodeCursor({ [timeKey]: 'yesterday', postId: ID }) }],
    ['a cursor with a bad id', { cursor: encodeCursor({ [timeKey]: TIME, postId: 'x' }) }],
    ["the other list's cursor", { cursor: encodeCursor({ [otherTimeKey]: TIME, postId: ID }) }],
    ['a timeline cursor', { cursor: encodeCursor({ activityAt: TIME, itemId: ID }) }],
  ])('rejects %s', (__, query) => {
    expect(schema.safeParse(query).success).toBe(false);
  });
});
