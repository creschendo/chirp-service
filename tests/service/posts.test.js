// Posts service against the test database. Services use the pool (no transaction client), so data is committed
// and tables are emptied between tests, like the API tests.
import * as service from '../../src/modules/posts/service.js';
import * as store from '../../src/modules/posts/store.js';
import { pool, resetDatabase } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';
import { decodeCursor } from '../../src/pagination.js';

afterEach(() => resetDatabase());
afterAll(() => pool.end());

const NO_POST = '00000000-0000-0000-0000-000000000000';

let author;
beforeEach(async () => {
  author = await createUser(pool);
});

const softDelete = (postId, userId = author.userId) => store.softDeletePost(postId, userId);

describe('createPost', () => {
  test('an original post: returns its post view', async () => {
    const view = await service.createPost(author.userId, { content: 'hello' });
    expect(view).toMatchObject({
      postId: expect.any(String),
      author: { userId: author.userId, username: author.username },
      content: 'hello',
      parentPostId: null,
      rootPostId: null,
      quotedPost: null,
      deleted: false,
    });
  });

  test('a reply to an original is rooted at that original', async () => {
    const original = await service.createPost(author.userId, { content: 'original' });
    const reply = await service.createPost(author.userId, { content: 'reply', parentPostId: original.postId });
    expect(reply).toMatchObject({ parentPostId: original.postId, rootPostId: original.postId });
  });

  test("a reply to a reply joins the original's conversation", async () => {
    const original = await service.createPost(author.userId, { content: 'original' });
    const reply = await service.createPost(author.userId, { content: 'reply', parentPostId: original.postId });
    const nested = await service.createPost(author.userId, { content: 'nested', parentPostId: reply.postId });
    expect(nested).toMatchObject({ parentPostId: reply.postId, rootPostId: original.postId });
  });

  test('a quote embeds the quoted post and starts no conversation', async () => {
    const other = await createUser(pool);
    const original = await service.createPost(other.userId, { content: 'original' });
    const quote = await service.createPost(author.userId, { content: 'my take', quotedPostId: original.postId });
    expect(quote).toMatchObject({
      quotedPostId: original.postId,
      parentPostId: null,
      rootPostId: null,
      quotedPost: { postId: original.postId, author: { userId: other.userId }, content: 'original' },
    });
  });

  test('a quote of a reply is allowed', async () => {
    const original = await service.createPost(author.userId, { content: 'original' });
    const reply = await service.createPost(author.userId, { content: 'reply', parentPostId: original.postId });
    const quote = await service.createPost(author.userId, { content: 'quote', quotedPostId: reply.postId });
    expect(quote.quotedPost.postId).toBe(reply.postId);
  });

  test('both parentPostId and quotedPostId -> 400, nothing created', async () => {
    const original = await service.createPost(author.userId, { content: 'original' });
    await expect(
      service.createPost(author.userId, {
        content: 'x',
        parentPostId: original.postId,
        quotedPostId: original.postId,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM posts');
    expect(rows[0].n).toBe(1);
  });

  test.each([
    ['replying to', 'parentPostId'],
    ['quoting', 'quotedPostId'],
  ])('%s an unknown post -> 404', async (_, field) => {
    await expect(service.createPost(author.userId, { content: 'x', [field]: NO_POST })).rejects.toMatchObject({
      status: 404,
      message: 'Post not found',
    });
  });

  test.each([
    ['replying to', 'parentPostId'],
    ['quoting', 'quotedPostId'],
  ])('%s a deleted post -> 404, nothing created', async (_, field) => {
    const original = await service.createPost(author.userId, { content: 'original' });
    await softDelete(original.postId);
    await expect(service.createPost(author.userId, { content: 'x', [field]: original.postId })).rejects.toMatchObject({
      status: 404,
    });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM posts');
    expect(rows[0].n).toBe(1);
  });
});

describe('getPost', () => {
  test('returns the same view createPost returned', async () => {
    const created = await service.createPost(author.userId, { content: 'hello' });
    expect(await service.getPost(created.postId)).toEqual(created);
  });

  test('a deleted post is returned as deleted, not null', async () => {
    const created = await service.createPost(author.userId, { content: 'hello' });
    await softDelete(created.postId);
    expect(await service.getPost(created.postId)).toMatchObject({
      postId: created.postId,
      deleted: true,
      author: null,
      content: null,
    });
  });

  test('never existed -> null', async () => {
    expect(await service.getPost(NO_POST)).toBeNull();
  });
});

describe('deletePost', () => {
  test('soft-deletes your own post', async () => {
    const created = await service.createPost(author.userId, { content: 'regret' });
    await service.deletePost(author.userId, created.postId);
    expect(await service.getPost(created.postId)).toMatchObject({ deleted: true, content: null });
  });

  test('deleting your own already-deleted post is a no-op', async () => {
    const created = await service.createPost(author.userId, { content: 'x' });
    await service.deletePost(author.userId, created.postId);
    await expect(service.deletePost(author.userId, created.postId)).resolves.toBeUndefined();
  });

  test("someone else's post -> 403 and it stays live", async () => {
    const other = await createUser(pool);
    const created = await service.createPost(author.userId, { content: 'mine' });
    await expect(service.deletePost(other.userId, created.postId)).rejects.toMatchObject({ status: 403 });
    expect(await service.getPost(created.postId)).toMatchObject({ deleted: false, content: 'mine' });
  });

  test("someone else's already-deleted post is still 403", async () => {
    const other = await createUser(pool);
    const created = await service.createPost(author.userId, { content: 'mine' });
    await service.deletePost(author.userId, created.postId);
    await expect(service.deletePost(other.userId, created.postId)).rejects.toMatchObject({ status: 403 });
  });

  test('never existed -> 404', async () => {
    await expect(service.deletePost(author.userId, NO_POST)).rejects.toMatchObject({
      status: 404,
      message: 'Post not found',
    });
  });

  test('replies to a deleted post survive and still point at it', async () => {
    const original = await service.createPost(author.userId, { content: 'original' });
    const reply = await service.createPost(author.userId, { content: 'reply', parentPostId: original.postId });
    await service.deletePost(author.userId, original.postId);
    expect(await service.getPost(reply.postId)).toMatchObject({ content: 'reply', parentPostId: original.postId });
  });
});

describe('listReplies', () => {
  let original;
  beforeEach(async () => {
    original = await service.createPost(author.userId, { content: 'original' });
  });

  // Replies spaced a minute apart, oldest first, so the expected order is unambiguous.
  async function replies(count) {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const reply = await service.createPost(author.userId, { content: `reply ${i}`, parentPostId: original.postId });
      await pool.query(`UPDATE posts SET created_at = now() - make_interval(mins => $2) WHERE post_id = $1`, [
        reply.postId,
        count - i,
      ]);
      ids.push(reply.postId);
    }
    return ids;
  }
  const ids = (page) => page.items.map((item) => item.postId);

  test('{ items, nextCursor }: direct replies as post views, oldest first', async () => {
    const expected = await replies(2);
    const page = await service.listReplies(original.postId, { limit: 10 });
    expect(ids(page)).toEqual(expected);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toMatchObject({ content: 'reply 0', parentPostId: original.postId });
  });

  test('pages through everything with nextCursor, without skipping or repeating', async () => {
    const expected = await replies(5);
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await service.listReplies(original.postId, { limit: 2, cursor });
      seen.push(...ids(page));
      // The service hands out an encoded string; decode it the way the query schema will.
      cursor = page.nextCursor && decodeCursor(page.nextCursor);
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });

  test('exactly limit replies -> nextCursor is null', async () => {
    await replies(2);
    const page = await service.listReplies(original.postId, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  test('a deleted post still lists its replies', async () => {
    await replies(1);
    await service.deletePost(author.userId, original.postId);
    expect((await service.listReplies(original.postId, { limit: 10 })).items).toHaveLength(1);
  });

  test('no replies -> empty page', async () => {
    expect(await service.listReplies(original.postId, { limit: 10 })).toEqual({ items: [], nextCursor: null });
  });

  test('never existed -> null', async () => {
    expect(await service.listReplies(NO_POST, { limit: 10 })).toBeNull();
  });
});
