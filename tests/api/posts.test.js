// HTTP tests for the posts routes. Requests go through the real app and pool; tables are emptied between tests.
import request from 'supertest';
import app from '../../src/app.js';
import { pool, resetDatabase } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';
import { authCookie } from '../helpers/auth.js';

afterEach(() => resetDatabase());
afterAll(() => pool.end());

const NO_POST = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const countPosts = async () => (await pool.query('SELECT count(*)::int AS n FROM posts')).rows[0].n;

let author;
let cookie;
beforeEach(async () => {
  author = await createUser(pool);
  cookie = authCookie(author.userId);
});

const post = (body, as = cookie) => {
  const req = request(app).post('/posts');
  if (as) req.set('Cookie', as);
  return req.send(body);
};

describe('POST /posts', () => {
  test('201 with the post view; the author comes from the token', async () => {
    const res = await post({ content: '  hello world  ' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      postId: expect.any(String),
      author: { userId: author.userId, username: author.username, displayName: author.displayName },
      content: 'hello world',
      parentPostId: null,
      rootPostId: null,
      quotedPostId: null,
      createdAt: expect.any(String),
      deleted: false,
      quotedPost: null,
    });
  });

  test('a reply, and a reply to that reply, share the original as root', async () => {
    const original = (await post({ content: 'original' })).body;
    const reply = (await post({ content: 'reply', parentPostId: original.postId })).body;
    const nested = await post({ content: 'nested', parentPostId: reply.postId });
    expect(nested.status).toBe(201);
    expect(nested.body).toMatchObject({ parentPostId: reply.postId, rootPostId: original.postId });
  });

  test('a quote embeds the quoted post', async () => {
    const other = await createUser(pool);
    const original = (await post({ content: 'original' }, authCookie(other.userId))).body;
    const res = await post({ content: 'my take', quotedPostId: original.postId });
    expect(res.status).toBe(201);
    expect(res.body.quotedPost).toMatchObject({
      postId: original.postId,
      author: { userId: other.userId },
      content: 'original',
    });
  });

  test.each([
    ['replying to', 'parentPostId'],
    ['quoting', 'quotedPostId'],
  ])('404 when %s an unknown post', async (_, field) => {
    const res = await post({ content: 'x', [field]: NO_POST });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Post not found' });
  });

  test.each([
    ['replying to', 'parentPostId'],
    ['quoting', 'quotedPostId'],
  ])('404 when %s a deleted post', async (_, field) => {
    const original = (await post({ content: 'original' })).body;
    await pool.query('UPDATE posts SET deleted_at = now(), content = NULL WHERE post_id = $1', [original.postId]);
    expect((await post({ content: 'x', [field]: original.postId })).status).toBe(404);
  });

  test.each([
    ['no body', undefined],
    ['empty content', { content: '' }],
    ['whitespace-only content', { content: '   ' }],
    ['content over 280 characters', { content: 'x'.repeat(281) }],
    ['malformed post id', { content: 'x', parentPostId: 'nope' }],
    ['both a reply and a quote', { content: 'x', parentPostId: NO_POST, quotedPostId: NO_POST }],
    ['an authorId in the body', { content: 'x', authorId: NO_POST }],
  ])('400 for %s, and nothing is created', async (_, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await countPosts()).toBe(0);
  });

  test('401 without an access token', async () => {
    const res = await post({ content: 'x' }, null);
    expect(res.status).toBe(401);
    expect(await countPosts()).toBe(0);
  });
});

describe('GET /posts/:post_id', () => {
  test('200 with the same view POST returned; no login needed', async () => {
    const created = (await post({ content: 'hello' })).body;
    const res = await request(app).get(`/posts/${created.postId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created);
  });

  test('a quote includes the quoted post', async () => {
    const original = (await post({ content: 'original' })).body;
    const quote = (await post({ content: 'quote', quotedPostId: original.postId })).body;
    const res = await request(app).get(`/posts/${quote.postId}`);
    expect(res.body.quotedPost).toMatchObject({ postId: original.postId, content: 'original' });
  });

  test('a deleted post is 200 with deleted: true and no author or content', async () => {
    const created = (await post({ content: 'gone' })).body;
    await pool.query('UPDATE posts SET deleted_at = now(), content = NULL WHERE post_id = $1', [created.postId]);
    const res = await request(app).get(`/posts/${created.postId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ postId: created.postId, deleted: true, author: null, content: null });
  });

  test('never includes email or password hash', async () => {
    const created = (await post({ content: 'hello' })).body;
    const res = await request(app).get(`/posts/${created.postId}`);
    expect(res.text).not.toContain(author.email);
    expect(res.text).not.toMatch(/password/i);
  });

  test('404 for a post that never existed', async () => {
    const res = await request(app).get(`/posts/${NO_POST}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Post not found' });
  });

  test('400 for a malformed id', async () => {
    const res = await request(app).get('/posts/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid post id');
  });
});

describe('DELETE /posts/:post_id', () => {
  const del = (postId, as = cookie) => {
    const req = request(app).delete(`/posts/${postId}`);
    return as ? req.set('Cookie', as) : req;
  };

  test('204, and the post now reads as deleted', async () => {
    const created = (await post({ content: 'regret' })).body;
    const res = await del(created.postId);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    const after = await request(app).get(`/posts/${created.postId}`);
    expect(after.body).toMatchObject({ deleted: true, content: null, author: null });
  });

  test('deleting it again is still 204', async () => {
    const created = (await post({ content: 'x' })).body;
    await del(created.postId);
    expect((await del(created.postId)).status).toBe(204);
  });

  test("403 for someone else's post, and it stays live", async () => {
    const created = (await post({ content: 'mine' })).body;
    const other = await createUser(pool);
    const res = await del(created.postId, authCookie(other.userId));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'You can only delete your own posts' });
    expect((await request(app).get(`/posts/${created.postId}`)).body.deleted).toBe(false);
  });

  test('replies and quotes survive and still point at it', async () => {
    const original = (await post({ content: 'original' })).body;
    const reply = (await post({ content: 'reply', parentPostId: original.postId })).body;
    const quote = (await post({ content: 'quote', quotedPostId: original.postId })).body;
    await del(original.postId);

    expect((await request(app).get(`/posts/${reply.postId}`)).body).toMatchObject({
      content: 'reply',
      parentPostId: original.postId,
    });
    expect((await request(app).get(`/posts/${quote.postId}`)).body.quotedPost).toMatchObject({
      postId: original.postId,
      deleted: true,
    });
  });

  test('a deleted post can no longer be replied to', async () => {
    const original = (await post({ content: 'original' })).body;
    await del(original.postId);
    expect((await post({ content: 'too late', parentPostId: original.postId })).status).toBe(404);
  });

  test('404 for a post that never existed', async () => {
    expect((await del(NO_POST)).status).toBe(404);
  });

  test('400 for a malformed id', async () => {
    expect((await del('not-a-uuid')).status).toBe(400);
  });

  test('401 without an access token, and nothing changes', async () => {
    const created = (await post({ content: 'x' })).body;
    expect((await del(created.postId, null)).status).toBe(401);
    expect((await request(app).get(`/posts/${created.postId}`)).body.deleted).toBe(false);
  });
});

describe('GET /posts/:post_id/replies', () => {
  let original;
  beforeEach(async () => {
    original = (await post({ content: 'original' })).body;
  });
  const repliesUrl = (postId, query = '') => `/posts/${postId}/replies${query}`;

  // Replies spaced a minute apart, oldest first, so the expected order is unambiguous.
  async function replies(count) {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const reply = (await post({ content: `reply ${i}`, parentPostId: original.postId })).body;
      await pool.query(`UPDATE posts SET created_at = now() - make_interval(mins => $2) WHERE post_id = $1`, [
        reply.postId,
        count - i,
      ]);
      ids.push(reply.postId);
    }
    return ids;
  }

  test('200 with { items, nextCursor }: direct replies, oldest first; no login needed', async () => {
    const expected = await replies(2);
    const res = await request(app).get(repliesUrl(original.postId));
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items.map((item) => item.postId)).toEqual(expected);
    expect(res.body.items[0]).toMatchObject({
      content: 'reply 0',
      parentPostId: original.postId,
      rootPostId: original.postId,
      author: { userId: author.userId },
      createdAt: expect.any(String),
    });
  });

  test('pages through everything with nextCursor, without skipping or repeating', async () => {
    const expected = await replies(5);
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const query = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const res = await request(app).get(repliesUrl(original.postId, query));
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((item) => item.postId));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });

  test('a deleted reply is listed as deleted', async () => {
    const [replyId] = await replies(1);
    await request(app).delete(`/posts/${replyId}`).set('Cookie', cookie);
    const res = await request(app).get(repliesUrl(original.postId));
    expect(res.body.items).toEqual([expect.objectContaining({ postId: replyId, deleted: true, content: null })]);
  });

  test('a deleted post still lists its replies', async () => {
    await replies(1);
    await request(app).delete(`/posts/${original.postId}`).set('Cookie', cookie);
    expect((await request(app).get(repliesUrl(original.postId))).body.items).toHaveLength(1);
  });

  test('no replies -> 200 with an empty page', async () => {
    const res = await request(app).get(repliesUrl(original.postId));
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  test('404 for a post that never existed', async () => {
    const res = await request(app).get(repliesUrl(NO_POST));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Post not found' });
  });

  test.each([
    ['malformed post id', 'not-a-uuid', ''],
    ['limit 0', null, '?limit=0'],
    ['limit over 100', null, '?limit=101'],
    ['garbage cursor', null, '?cursor=not-a-cursor'],
  ])('400 for %s', async (_, postId, query) => {
    const res = await request(app).get(repliesUrl(postId ?? original.postId, query));
    expect(res.status).toBe(400);
  });
});
