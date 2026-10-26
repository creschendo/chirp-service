// Posts validation schemas. Pure functions: no database needed.
import { createPostSchema, postIdParamSchema, repliesQuerySchema } from '../../src/modules/posts/schemas.js';
import { encodeCursor } from '../../src/pagination.js';

const ID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';

describe('createPostSchema', () => {
  test.each([
    ['an original', { content: 'hello' }],
    ['a reply', { content: 'hi', parentPostId: ID }],
    ['a quote', { content: 'hi', quotedPostId: ID }],
    ['280 characters', { content: 'x'.repeat(280) }],
  ])('accepts %s', (_, body) => {
    expect(createPostSchema.safeParse(body).success).toBe(true);
  });

  test('trims content', () => {
    expect(createPostSchema.parse({ content: '  hello  ' }).content).toBe('hello');
  });

  test('280 counts after trimming', () => {
    expect(createPostSchema.safeParse({ content: ` ${'x'.repeat(280)} ` }).success).toBe(true);
  });

  test.each([
    ['missing content', {}],
    ['empty content', { content: '' }],
    ['whitespace-only content', { content: '   ' }],
    ['content over 280 characters', { content: 'x'.repeat(281) }],
    ['non-string content', { content: 42 }],
    ['malformed parentPostId', { content: 'x', parentPostId: 'nope' }],
    ['malformed quotedPostId', { content: 'x', quotedPostId: 'nope' }],
    ['both parentPostId and quotedPostId', { content: 'x', parentPostId: ID, quotedPostId: ID }],
    ['unknown field', { content: 'x', authorId: ID }],
    ['snake_case id field', { content: 'x', parent_post_id: ID }],
  ])('rejects %s', (_, body) => {
    expect(createPostSchema.safeParse(body).success).toBe(false);
  });
});

describe('postIdParamSchema', () => {
  test('accepts a uuid, rejects anything else', () => {
    expect(postIdParamSchema.safeParse({ post_id: ID }).success).toBe(true);
    expect(postIdParamSchema.safeParse({ post_id: 'nope' }).success).toBe(false);
  });
});

describe('repliesQuerySchema', () => {
  test('defaults: limit 20, no cursor', () => {
    expect(repliesQuerySchema.parse({})).toEqual({ limit: 20, cursor: null });
  });

  test('decodes a cursor made from the last reply', () => {
    const cursor = { createdAt: '2026-10-25T10:05:00.000Z', postId: ID };
    expect(repliesQuerySchema.parse({ limit: '5', cursor: encodeCursor(cursor) })).toEqual({ limit: 5, cursor });
  });

  test.each([
    ['limit 0', { limit: '0' }],
    ['limit over 100', { limit: '101' }],
    ['garbage cursor', { cursor: 'not-a-cursor' }],
    ['a followers cursor', { cursor: encodeCursor({ followedAt: '2026-10-25T10:05:00.000Z', userId: ID }) }],
  ])('rejects %s', (_, query) => {
    expect(repliesQuerySchema.safeParse(query).success).toBe(false);
  });
});
