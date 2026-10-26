// Posts store against the test database. Each test runs in a rolled-back transaction (see helpers/db.js).
// Turn the remaining todos into tests as the store is built.
import * as store from '../../src/modules/posts/store.js';
import { useTransaction, pgErrorCode } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';

const ctx = useTransaction();
const NO_POST = '00000000-0000-0000-0000-000000000000';

// The stored row, read directly until getPostById exists.
async function row(postId) {
  const { rows } = await ctx.db.query(
    `SELECT author_id, content, parent_post_id, root_post_id, quoted_post_id, created_at, deleted_at
     FROM posts WHERE post_id = $1`,
    [postId],
  );
  return rows[0];
}

let author;
beforeEach(async () => {
  author = await createUser(ctx.db);
});

describe('createPost', () => {
  test('creates an original post and returns { postId }', async () => {
    const created = await store.createPost({ authorId: author.userId, content: 'hello' }, ctx.db);
    expect(created).toEqual({ postId: expect.any(String) });
    expect(await row(created.postId)).toEqual({
      author_id: author.userId,
      content: 'hello',
      parent_post_id: null,
      root_post_id: null,
      quoted_post_id: null,
      created_at: expect.any(Date),
      deleted_at: null,
    });
  });

  test('creates a reply linked to its parent and root', async () => {
    const original = await store.createPost({ authorId: author.userId, content: 'original' }, ctx.db);
    const reply = await store.createPost(
      { authorId: author.userId, content: 'reply', parentPostId: original.postId, rootPostId: original.postId },
      ctx.db,
    );
    const nested = await store.createPost(
      { authorId: author.userId, content: 'nested', parentPostId: reply.postId, rootPostId: original.postId },
      ctx.db,
    );
    expect(await row(reply.postId)).toMatchObject({ parent_post_id: original.postId, root_post_id: original.postId });
    expect(await row(nested.postId)).toMatchObject({ parent_post_id: reply.postId, root_post_id: original.postId });
  });

  test('creates a quote post, including a quote of a quote', async () => {
    const original = await store.createPost({ authorId: author.userId, content: 'original' }, ctx.db);
    const quote = await store.createPost(
      { authorId: author.userId, content: 'quote', quotedPostId: original.postId },
      ctx.db,
    );
    const quoteOfQuote = await store.createPost(
      { authorId: author.userId, content: 'quote of quote', quotedPostId: quote.postId },
      ctx.db,
    );
    expect(await row(quote.postId)).toMatchObject({ quoted_post_id: original.postId, parent_post_id: null });
    expect(await row(quoteOfQuote.postId)).toMatchObject({ quoted_post_id: quote.postId });
  });

  test.each([
    ['empty content', { content: '' }],
    ['content over 280 characters', { content: 'x'.repeat(281) }],
  ])('%s -> 23514', async (_, overrides) => {
    expect(
      await pgErrorCode(ctx.db, () =>
        store.createPost({ authorId: author.userId, content: 'x', ...overrides }, ctx.db),
      ),
    ).toBe('23514');
  });

  test('280 characters is allowed', async () => {
    const created = await store.createPost({ authorId: author.userId, content: 'x'.repeat(280) }, ctx.db);
    expect((await row(created.postId)).content).toHaveLength(280);
  });

  test('missing content -> 23514 (a live post needs content)', async () => {
    expect(await pgErrorCode(ctx.db, () => store.createPost({ authorId: author.userId }, ctx.db))).toBe('23514');
  });

  test('reply without a root, or root without a parent -> 23514 (posts_reply_has_root)', async () => {
    const original = await store.createPost({ authorId: author.userId, content: 'original' }, ctx.db);
    const base = { authorId: author.userId, content: 'x' };
    expect(await pgErrorCode(ctx.db, () => store.createPost({ ...base, parentPostId: original.postId }, ctx.db))).toBe(
      '23514',
    );
    expect(await pgErrorCode(ctx.db, () => store.createPost({ ...base, rootPostId: original.postId }, ctx.db))).toBe(
      '23514',
    );
  });

  test.each([
    ['parent', { parentPostId: NO_POST, rootPostId: NO_POST }],
    ['quoted post', { quotedPostId: NO_POST }],
  ])('unknown %s -> 23503', async (_, ids) => {
    expect(
      await pgErrorCode(ctx.db, () => store.createPost({ authorId: author.userId, content: 'x', ...ids }, ctx.db)),
    ).toBe('23503');
  });

  test('unknown author -> 23503', async () => {
    expect(await pgErrorCode(ctx.db, () => store.createPost({ authorId: NO_POST, content: 'x' }, ctx.db))).toBe(
      '23503',
    );
  });
});

describe('getPostById', () => {
  test("returns the post's own columns only (no content, no author details)", async () => {
    const { postId } = await store.createPost({ authorId: author.userId, content: 'hello' }, ctx.db);
    expect(await store.getPostById(postId, ctx.db)).toEqual({
      postId,
      authorId: author.userId,
      parentPostId: null,
      rootPostId: null,
      quotedPostId: null,
      deletedAt: null,
    });
  });

  test('includes reply and quote links', async () => {
    const original = await store.createPost({ authorId: author.userId, content: 'original' }, ctx.db);
    const reply = await store.createPost(
      { authorId: author.userId, content: 'reply', parentPostId: original.postId, rootPostId: original.postId },
      ctx.db,
    );
    const quote = await store.createPost(
      { authorId: author.userId, content: 'quote', quotedPostId: reply.postId },
      ctx.db,
    );
    expect(await store.getPostById(reply.postId, ctx.db)).toMatchObject({
      parentPostId: original.postId,
      rootPostId: original.postId,
    });
    expect(await store.getPostById(quote.postId, ctx.db)).toMatchObject({ quotedPostId: reply.postId });
  });

  test('a deleted post is still returned, with deletedAt set', async () => {
    const { postId } = await store.createPost({ authorId: author.userId, content: 'gone soon' }, ctx.db);
    await ctx.db.query('UPDATE posts SET deleted_at = now(), content = NULL WHERE post_id = $1', [postId]);
    expect((await store.getPostById(postId, ctx.db)).deletedAt).toEqual(expect.any(Date));
  });

  test('unknown id -> null', async () => {
    expect(await store.getPostById(NO_POST, ctx.db)).toBeNull();
  });

  test('malformed id -> 22P02 (validate ids before calling)', async () => {
    expect(await pgErrorCode(ctx.db, () => store.getPostById('not-a-uuid', ctx.db))).toBe('22P02');
  });
});

describe('getPostView', () => {
  const softDelete = (postId) =>
    ctx.db.query('UPDATE posts SET deleted_at = now(), content = NULL WHERE post_id = $1', [postId]);
  const authorOf = (user) => ({ userId: user.userId, username: user.username, displayName: user.displayName });

  test('an original post with its author', async () => {
    const { postId } = await store.createPost({ authorId: author.userId, content: 'hello' }, ctx.db);
    expect(await store.getPostView(postId, ctx.db)).toEqual({
      postId,
      author: authorOf(author),
      content: 'hello',
      parentPostId: null,
      rootPostId: null,
      quotedPostId: null,
      createdAt: expect.any(Date),
      deleted: false,
      quotedPost: null,
    });
  });

  test('a reply carries its parent and root', async () => {
    const original = await store.createPost({ authorId: author.userId, content: 'original' }, ctx.db);
    const reply = await store.createPost(
      { authorId: author.userId, content: 'reply', parentPostId: original.postId, rootPostId: original.postId },
      ctx.db,
    );
    expect(await store.getPostView(reply.postId, ctx.db)).toMatchObject({
      parentPostId: original.postId,
      rootPostId: original.postId,
      quotedPost: null,
    });
  });

  test('a quote embeds the quoted post with its own author, and createdAt stays a Date', async () => {
    const other = await createUser(ctx.db);
    const original = await store.createPost({ authorId: other.userId, content: 'original' }, ctx.db);
    const quote = await store.createPost(
      { authorId: author.userId, content: 'my take', quotedPostId: original.postId },
      ctx.db,
    );
    const view = await store.getPostView(quote.postId, ctx.db);
    expect(view.author).toEqual(authorOf(author));
    expect(view.quotedPostId).toBe(original.postId);
    expect(view.quotedPost).toEqual({
      postId: original.postId,
      author: authorOf(other),
      content: 'original',
      parentPostId: null,
      rootPostId: null,
      quotedPostId: null,
      createdAt: expect.any(Date),
      deleted: false,
    });
  });

  test('a quote of a quote embeds one level; the inner quote is a hint (quotedPostId), not nested', async () => {
    const a = await store.createPost({ authorId: author.userId, content: 'A' }, ctx.db);
    const b = await store.createPost({ authorId: author.userId, content: 'B', quotedPostId: a.postId }, ctx.db);
    const c = await store.createPost({ authorId: author.userId, content: 'C', quotedPostId: b.postId }, ctx.db);
    const view = await store.getPostView(c.postId, ctx.db);
    expect(view.quotedPost.postId).toBe(b.postId);
    expect(view.quotedPost.quotedPostId).toBe(a.postId);
    expect(view.quotedPost).not.toHaveProperty('quotedPost');
  });

  test('a deleted post keeps id, thread links and time, but no author, content or quote', async () => {
    const original = await store.createPost({ authorId: author.userId, content: 'original' }, ctx.db);
    const reply = await store.createPost(
      { authorId: author.userId, content: 'reply', parentPostId: original.postId, rootPostId: original.postId },
      ctx.db,
    );
    await softDelete(reply.postId);
    expect(await store.getPostView(reply.postId, ctx.db)).toEqual({
      postId: reply.postId,
      author: null,
      content: null,
      parentPostId: original.postId,
      rootPostId: original.postId,
      quotedPostId: null,
      createdAt: expect.any(Date),
      deleted: true,
      quotedPost: null,
    });
  });

  test("a deleted quoted post is embedded as deleted; the quote's own text is unaffected", async () => {
    const original = await store.createPost({ authorId: author.userId, content: 'original' }, ctx.db);
    const quote = await store.createPost(
      { authorId: author.userId, content: 'my take', quotedPostId: original.postId },
      ctx.db,
    );
    await softDelete(original.postId);
    const view = await store.getPostView(quote.postId, ctx.db);
    expect(view.content).toBe('my take');
    expect(view.quotedPost).toMatchObject({ postId: original.postId, deleted: true, author: null, content: null });
  });

  test('never includes email or password hash', async () => {
    const original = await store.createPost({ authorId: author.userId, content: 'original' }, ctx.db);
    const quote = await store.createPost(
      { authorId: author.userId, content: 'q', quotedPostId: original.postId },
      ctx.db,
    );
    const json = JSON.stringify(await store.getPostView(quote.postId, ctx.db));
    expect(json).not.toContain(author.email);
    expect(json).not.toMatch(/password/i);
  });

  test('unknown id -> null', async () => {
    expect(await store.getPostView(NO_POST, ctx.db)).toBeNull();
  });
});

describe('listReplies', () => {
  let parent;
  beforeEach(async () => {
    parent = await store.createPost({ authorId: author.userId, content: 'parent' }, ctx.db);
  });

  // Creates a direct reply to `to`, `minutesAgo` minutes in the past (now() is fixed inside the test's
  // transaction, so timestamps are set explicitly when order matters).
  async function replyAt(to, minutesAgo, content = 'reply') {
    const { postId } = await store.createPost(
      { authorId: author.userId, content, parentPostId: to.postId, rootPostId: to.rootPostId ?? to.postId },
      ctx.db,
    );
    await ctx.db.query(`UPDATE posts SET created_at = now() - make_interval(mins => $2) WHERE post_id = $1`, [
      postId,
      minutesAgo,
    ]);
    return postId;
  }
  const ids = (rows) => rows.map((r) => r.postId);
  const cursorOf = (row) => ({ createdAt: row.createdAt.toISOString(), postId: row.postId });

  test('direct replies only, oldest first, as post views', async () => {
    const newer = await replyAt(parent, 1, 'newer');
    const older = await replyAt(parent, 5, 'older');
    await replyAt({ postId: newer, rootPostId: parent.postId }, 0, 'reply to a reply');

    const rows = await store.listReplies(parent.postId, { limit: 10 }, ctx.db);
    expect(ids(rows)).toEqual([older, newer]);
    expect(rows[0]).toMatchObject({
      content: 'older',
      parentPostId: parent.postId,
      rootPostId: parent.postId,
      author: { userId: author.userId },
      deleted: false,
    });
  });

  test('replies to a reply are listed under that reply', async () => {
    const reply = await replyAt(parent, 5);
    const nested = await replyAt({ postId: reply, rootPostId: parent.postId }, 1);
    expect(ids(await store.listReplies(reply, { limit: 10 }, ctx.db))).toEqual([nested]);
  });

  test('deleted replies are included, shown as deleted', async () => {
    const reply = await replyAt(parent, 1);
    await ctx.db.query('UPDATE posts SET deleted_at = now(), content = NULL WHERE post_id = $1', [reply]);
    const [row] = await store.listReplies(parent.postId, { limit: 10 }, ctx.db);
    expect(row).toMatchObject({ postId: reply, deleted: true, content: null, author: null });
  });

  test('a reply that quotes a post embeds it', async () => {
    const quoted = await store.createPost({ authorId: author.userId, content: 'quoted' }, ctx.db);
    await store.createPost(
      {
        authorId: author.userId,
        content: 'reply with a quote',
        parentPostId: parent.postId,
        rootPostId: parent.postId,
        quotedPostId: quoted.postId,
      },
      ctx.db,
    );
    const [row] = await store.listReplies(parent.postId, { limit: 10 }, ctx.db);
    expect(row.quotedPost).toMatchObject({ postId: quoted.postId, content: 'quoted' });
  });

  test('cursor returns the next page without skipping or repeating', async () => {
    const expected = [];
    for (let i = 5; i >= 1; i--) expected.push(await replyAt(parent, i)); // oldest first

    const seen = [];
    let cursor = null;
    for (let page = 0; page < 4; page++) {
      const rows = await store.listReplies(parent.postId, { limit: 2, cursor }, ctx.db);
      if (rows.length === 0) break;
      seen.push(...ids(rows));
      cursor = cursorOf(rows.at(-1));
    }
    expect(seen).toEqual(expected);
  });

  test('replies with identical timestamps are split across pages correctly (post_id tie-break)', async () => {
    const all = [];
    for (let i = 0; i < 4; i++) all.push(await replyAt(parent, 3)); // all at the same instant

    const page1 = await store.listReplies(parent.postId, { limit: 2 }, ctx.db);
    const page2 = await store.listReplies(parent.postId, { limit: 2, cursor: cursorOf(page1.at(-1)) }, ctx.db);
    const seen = [...ids(page1), ...ids(page2)];
    expect(new Set(seen).size).toBe(4);
    expect([...seen].sort()).toEqual([...all].sort());
  });

  test('no replies, or an unknown parent -> []', async () => {
    expect(await store.listReplies(parent.postId, { limit: 10 }, ctx.db)).toEqual([]);
    expect(await store.listReplies(NO_POST, { limit: 10 }, ctx.db)).toEqual([]);
  });
});

describe('softDeletePost', () => {
  test('author deletes own post -> true; row kept, content cleared, deleted_at set', async () => {
    const { postId } = await store.createPost({ authorId: author.userId, content: 'regret' }, ctx.db);
    expect(await store.softDeletePost(postId, author.userId, ctx.db)).toBe(true);
    expect(await row(postId)).toMatchObject({ author_id: author.userId, content: null, deleted_at: expect.any(Date) });
  });

  test("someone else's post -> false and nothing changes", async () => {
    const other = await createUser(ctx.db);
    const { postId } = await store.createPost({ authorId: author.userId, content: 'mine' }, ctx.db);
    expect(await store.softDeletePost(postId, other.userId, ctx.db)).toBe(false);
    expect(await row(postId)).toMatchObject({ content: 'mine', deleted_at: null });
  });

  test('already deleted -> false, and deleted_at keeps the original time', async () => {
    const { postId } = await store.createPost({ authorId: author.userId, content: 'x' }, ctx.db);
    await store.softDeletePost(postId, author.userId, ctx.db);
    const first = (await row(postId)).deleted_at;
    expect(await store.softDeletePost(postId, author.userId, ctx.db)).toBe(false);
    expect((await row(postId)).deleted_at).toEqual(first);
  });

  test('unknown post -> false', async () => {
    expect(await store.softDeletePost(NO_POST, author.userId, ctx.db)).toBe(false);
  });

  test('replies and quotes keep pointing at it and show it as deleted', async () => {
    const original = await store.createPost({ authorId: author.userId, content: 'original' }, ctx.db);
    const reply = await store.createPost(
      { authorId: author.userId, content: 'reply', parentPostId: original.postId, rootPostId: original.postId },
      ctx.db,
    );
    const quote = await store.createPost(
      { authorId: author.userId, content: 'quote', quotedPostId: original.postId },
      ctx.db,
    );
    await store.softDeletePost(original.postId, author.userId, ctx.db);

    expect(await store.getPostView(reply.postId, ctx.db)).toMatchObject({
      content: 'reply',
      parentPostId: original.postId,
    });
    expect(await store.listReplies(original.postId, { limit: 10 }, ctx.db)).toHaveLength(1);
    expect((await store.getPostView(quote.postId, ctx.db)).quotedPost).toMatchObject({
      postId: original.postId,
      deleted: true,
    });
  });
});

describe('deleting a user', () => {
  test('deletes their posts when nothing else points at them', async () => {
    const { postId } = await store.createPost({ authorId: author.userId, content: 'x' }, ctx.db);
    await ctx.db.query('DELETE FROM users WHERE user_id = $1', [author.userId]);
    expect(await store.getPostById(postId, ctx.db)).toBeNull();
  });

  test("fails (23503) while other users' replies or quotes point at their posts (account deletion is deferred)", async () => {
    const other = await createUser(ctx.db);
    const original = await store.createPost({ authorId: author.userId, content: 'original' }, ctx.db);
    await store.createPost({ authorId: other.userId, content: 'quote', quotedPostId: original.postId }, ctx.db);
    expect(await pgErrorCode(ctx.db, () => ctx.db.query('DELETE FROM users WHERE user_id = $1', [author.userId]))).toBe(
      '23503',
    );
  });
});
