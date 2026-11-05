// Engagement service against the test database. Services use the pool (no transaction client), so data is committed
// and tables are emptied between tests, like the API tests.
import * as service from '../../src/modules/engagement/service.js';
import * as postsStore from '../../src/modules/posts/store.js';
import { decodeCursor } from '../../src/pagination.js';
import { pool, resetDatabase } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';

afterEach(() => resetDatabase());
afterAll(() => pool.end());

const NO_ID = '00000000-0000-0000-0000-000000000000';

let alice;
let bob;
let postId;
beforeEach(async () => {
  alice = await createUser(pool);
  bob = await createUser(pool);
  ({ postId } = await postsStore.createPost({ authorId: bob.userId, content: 'hello' }));
});

const likers = async (likedPostId) =>
  (await pool.query('SELECT user_id FROM likes WHERE post_id = $1', [likedPostId])).rows.map((row) => row.user_id);

describe('like', () => {
  test('likes the post', async () => {
    await expect(service.like(alice.userId, postId)).resolves.toBeUndefined();
    expect(await likers(postId)).toEqual([alice.userId]);
  });

  test('liking again is a no-op', async () => {
    await service.like(alice.userId, postId);
    await expect(service.like(alice.userId, postId)).resolves.toBeUndefined();
    expect(await likers(postId)).toEqual([alice.userId]);
  });

  test('you can like your own post', async () => {
    await service.like(bob.userId, postId);
    expect(await likers(postId)).toEqual([bob.userId]);
  });

  test('a deleted post gets 404 and no like', async () => {
    await postsStore.softDeletePost(postId, bob.userId);

    await expect(service.like(alice.userId, postId)).rejects.toMatchObject({
      status: 404,
      message: 'Post not found',
    });
    expect(await likers(postId)).toEqual([]);
  });

  test('an unknown post gets the same 404', async () => {
    await expect(service.like(alice.userId, NO_ID)).rejects.toMatchObject({ status: 404, message: 'Post not found' });
  });
});

describe('unlike', () => {
  test('removes your like, and only yours', async () => {
    await service.like(alice.userId, postId);
    await service.like(bob.userId, postId);

    await expect(service.unlike(alice.userId, postId)).resolves.toBeUndefined();

    expect(await likers(postId)).toEqual([bob.userId]);
  });

  test('unliking something you never liked, or twice, is a no-op', async () => {
    await expect(service.unlike(alice.userId, postId)).resolves.toBeUndefined();
    await service.like(alice.userId, postId);
    await service.unlike(alice.userId, postId);
    await expect(service.unlike(alice.userId, postId)).resolves.toBeUndefined();
    expect(await likers(postId)).toEqual([]);
  });

  test('works on a post deleted after you liked it', async () => {
    await service.like(alice.userId, postId);
    await postsStore.softDeletePost(postId, bob.userId);

    await service.unlike(alice.userId, postId);

    expect(await likers(postId)).toEqual([]);
  });

  test('an unknown post is a no-op, not a 404', async () => {
    await expect(service.unlike(alice.userId, NO_ID)).resolves.toBeUndefined();
  });
});

const reposters = async (repostedPostId) =>
  (await pool.query('SELECT user_id FROM reposts WHERE post_id = $1', [repostedPostId])).rows.map((row) => row.user_id);

describe('repost', () => {
  test('reposts the post: created true, with its id and time', async () => {
    const result = await service.repost(alice.userId, postId);

    expect(result).toEqual({ repostId: expect.any(String), repostedAt: expect.any(Date), created: true });
    expect(await reposters(postId)).toEqual([alice.userId]);
  });

  test('reposting again returns the same repost with created false, at its original time', async () => {
    const first = await service.repost(alice.userId, postId);
    const again = await service.repost(alice.userId, postId);

    expect(again).toEqual({ ...first, created: false });
    expect(await reposters(postId)).toEqual([alice.userId]);
  });

  test('you can repost your own post', async () => {
    expect((await service.repost(bob.userId, postId)).created).toBe(true);
  });

  test('two reposts at once by the same user: one is created, both get it', async () => {
    const results = await Promise.all([service.repost(alice.userId, postId), service.repost(alice.userId, postId)]);

    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
    expect(results[0].repostId).toBe(results[1].repostId);
  });

  test('a deleted post gets 404 and no repost', async () => {
    await postsStore.softDeletePost(postId, bob.userId);

    await expect(service.repost(alice.userId, postId)).rejects.toMatchObject({
      status: 404,
      message: 'Post not found',
    });
    expect(await reposters(postId)).toEqual([]);
  });

  test('an unknown post gets the same 404', async () => {
    await expect(service.repost(alice.userId, NO_ID)).rejects.toMatchObject({
      status: 404,
      message: 'Post not found',
    });
  });
});

describe('unrepost', () => {
  test('removes your repost, and only yours', async () => {
    await service.repost(alice.userId, postId);
    await service.repost(bob.userId, postId);

    await expect(service.unrepost(alice.userId, postId)).resolves.toBeUndefined();

    expect(await reposters(postId)).toEqual([bob.userId]);
  });

  test("un-reposting something you didn't repost, or twice, is a no-op", async () => {
    await expect(service.unrepost(alice.userId, postId)).resolves.toBeUndefined();
    await service.repost(alice.userId, postId);
    await service.unrepost(alice.userId, postId);
    await expect(service.unrepost(alice.userId, postId)).resolves.toBeUndefined();
    expect(await reposters(postId)).toEqual([]);
  });

  test('works on a post deleted after you reposted it', async () => {
    await service.repost(alice.userId, postId);
    await postsStore.softDeletePost(postId, bob.userId);

    await service.unrepost(alice.userId, postId);

    expect(await reposters(postId)).toEqual([]);
  });

  test('reposting again afterwards is a new repost', async () => {
    const first = await service.repost(alice.userId, postId);
    await service.unrepost(alice.userId, postId);

    const second = await service.repost(alice.userId, postId);

    expect(second.created).toBe(true);
    expect(second.repostId).not.toBe(first.repostId);
  });

  test('an unknown post is a no-op, not a 404', async () => {
    await expect(service.unrepost(alice.userId, NO_ID)).resolves.toBeUndefined();
  });
});

const bookmarkers = async (bookmarkedPostId) =>
  (await pool.query('SELECT user_id FROM bookmarks WHERE post_id = $1', [bookmarkedPostId])).rows.map(
    (row) => row.user_id,
  );

describe('bookmark', () => {
  test('bookmarks the post', async () => {
    await expect(service.bookmark(alice.userId, postId)).resolves.toBeUndefined();
    expect(await bookmarkers(postId)).toEqual([alice.userId]);
  });

  test('bookmarking again is a no-op', async () => {
    await service.bookmark(alice.userId, postId);
    await expect(service.bookmark(alice.userId, postId)).resolves.toBeUndefined();
    expect(await bookmarkers(postId)).toEqual([alice.userId]);
  });

  test('you can bookmark your own post', async () => {
    await service.bookmark(bob.userId, postId);
    expect(await bookmarkers(postId)).toEqual([bob.userId]);
  });

  test('a deleted post gets 404 and no bookmark', async () => {
    await postsStore.softDeletePost(postId, bob.userId);

    await expect(service.bookmark(alice.userId, postId)).rejects.toMatchObject({
      status: 404,
      message: 'Post not found',
    });
    expect(await bookmarkers(postId)).toEqual([]);
  });

  test('an unknown post gets the same 404', async () => {
    await expect(service.bookmark(alice.userId, NO_ID)).rejects.toMatchObject({
      status: 404,
      message: 'Post not found',
    });
  });
});

describe('unbookmark', () => {
  test('removes your bookmark, and only yours', async () => {
    await service.bookmark(alice.userId, postId);
    await service.bookmark(bob.userId, postId);

    await expect(service.unbookmark(alice.userId, postId)).resolves.toBeUndefined();

    expect(await bookmarkers(postId)).toEqual([bob.userId]);
  });

  test("removing a bookmark you don't have, or twice, is a no-op", async () => {
    await expect(service.unbookmark(alice.userId, postId)).resolves.toBeUndefined();
    await service.bookmark(alice.userId, postId);
    await service.unbookmark(alice.userId, postId);
    await expect(service.unbookmark(alice.userId, postId)).resolves.toBeUndefined();
    expect(await bookmarkers(postId)).toEqual([]);
  });

  test('works on a post deleted after you bookmarked it', async () => {
    await service.bookmark(alice.userId, postId);
    await postsStore.softDeletePost(postId, bob.userId);

    await service.unbookmark(alice.userId, postId);

    expect(await bookmarkers(postId)).toEqual([]);
  });

  test('an unknown post is a no-op, not a 404', async () => {
    await expect(service.unbookmark(alice.userId, NO_ID)).resolves.toBeUndefined();
  });
});

// Pages through a list like a client: nextCursor out, decoded (as the query schema will) back in.
async function pageThrough(getPage, key, limit) {
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await getPage(key, { limit, cursor });
    seen.push(...page.items.map((item) => item.postId));
    cursor = page.nextCursor && decodeCursor(page.nextCursor);
    pages += 1;
  } while (cursor && pages < 20);
  return { seen, pages };
}

// Posts by bob, each engaged with by `user` `minutesAgo` in the past, newest engagement first in the result.
async function engagedPosts(engage, table, user, count) {
  const postIds = [];
  for (let i = 1; i <= count; i++) {
    const { postId: id } = await postsStore.createPost({ authorId: bob.userId, content: `post ${i}` });
    await engage(user.userId, id);
    await pool.query(
      `UPDATE ${table} SET created_at = now() - make_interval(mins => $3) WHERE user_id = $1 AND post_id = $2`,
      [user.userId, id, i],
    );
    postIds.push(id);
  }
  return postIds;
}

describe('listLikes', () => {
  test("{ items, nextCursor } with that user's liked posts, newest like first", async () => {
    const expected = await engagedPosts(service.like, 'likes', alice, 2);

    const page = await service.listLikes(alice.username, { limit: 10 });

    expect(page.items.map((item) => item.postId)).toEqual(expected);
    expect(page.items[0]).toMatchObject({ author: { userId: bob.userId }, likedAt: expect.any(Date) });
    expect(page.nextCursor).toBeNull();
  });

  test('finds the user ignoring case', async () => {
    await service.like(alice.userId, postId);
    expect((await service.listLikes(alice.username.toUpperCase(), { limit: 10 })).items).toHaveLength(1);
  });

  test('pages through everything with nextCursor', async () => {
    const expected = await engagedPosts(service.like, 'likes', alice, 5);
    const { seen, pages } = await pageThrough(service.listLikes, alice.username, 2);
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });

  test('a user with no likes -> empty page; an unknown user -> null', async () => {
    expect(await service.listLikes(bob.username, { limit: 10 })).toEqual({ items: [], nextCursor: null });
    expect(await service.listLikes('nobody_here', { limit: 10 })).toBeNull();
  });
});

describe('listBookmarks', () => {
  test("{ items, nextCursor } with the caller's bookmarks, newest bookmark first", async () => {
    const expected = await engagedPosts(service.bookmark, 'bookmarks', alice, 2);

    const page = await service.listBookmarks(alice.userId, { limit: 10 });

    expect(page.items.map((item) => item.postId)).toEqual(expected);
    expect(page.items[0]).toMatchObject({ author: { userId: bob.userId }, bookmarkedAt: expect.any(Date) });
    expect(page.nextCursor).toBeNull();
  });

  test("only the caller's own bookmarks", async () => {
    await service.bookmark(bob.userId, postId);
    expect(await service.listBookmarks(alice.userId, { limit: 10 })).toEqual({ items: [], nextCursor: null });
  });

  test('pages through everything with nextCursor', async () => {
    const expected = await engagedPosts(service.bookmark, 'bookmarks', alice, 5);
    const { seen, pages } = await pageThrough(service.listBookmarks, alice.userId, 2);
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });
});

describe('withEngagement', () => {
  const view = (id) => postsStore.getPostView(id);

  test("adds counts and the viewer's flags to each post, in the same order", async () => {
    const { postId: other } = await postsStore.createPost({ authorId: alice.userId, content: 'other' });
    await service.like(alice.userId, postId);
    await service.repost(bob.userId, postId);
    await service.bookmark(alice.userId, other);

    const posts = [await view(other), await view(postId)];
    const result = await service.withEngagement(alice.userId, posts);

    expect(result.map((post) => post.postId)).toEqual([other, postId]);
    expect(result[0]).toEqual({
      ...posts[0],
      engagement: {
        likeCount: 0,
        repostCount: 0,
        replyCount: 0,
        quoteCount: 0,
        liked: false,
        reposted: false,
        bookmarked: true,
      },
    });
    expect(result[1].engagement).toEqual({
      likeCount: 1,
      repostCount: 1,
      replyCount: 0,
      quoteCount: 0,
      liked: true,
      reposted: false,
      bookmarked: false,
    });
  });

  test('logged out: real counts, every flag false', async () => {
    await service.like(alice.userId, postId);
    const [post] = await service.withEngagement(null, [await view(postId)]);
    expect(post.engagement).toMatchObject({ likeCount: 1, liked: false, reposted: false, bookmarked: false });
  });

  test('a deleted post gets engagement: null', async () => {
    await service.like(alice.userId, postId);
    await postsStore.softDeletePost(postId, bob.userId);

    const [post] = await service.withEngagement(alice.userId, [await view(postId)]);

    expect(post.deleted).toBe(true);
    expect(post.engagement).toBeNull();
  });

  test('a post that appears twice (itself and a repost) gets the same numbers both times', async () => {
    const { repostId, repostedAt } = await service.repost(alice.userId, postId);
    const plain = { ...(await view(postId)), repost: null };
    const asRepost = { ...plain, repost: { repostId, user: { userId: alice.userId }, repostedAt } };

    const [first, second] = await service.withEngagement(alice.userId, [asRepost, plain]);

    expect(first.repost.repostId).toBe(repostId);
    expect(first.engagement).toEqual(second.engagement);
    expect(first.engagement).toMatchObject({ repostCount: 1, reposted: true });
  });

  test("the embedded quoted post doesn't get counts", async () => {
    const { postId: quote } = await postsStore.createPost({
      authorId: alice.userId,
      content: 'my take',
      quotedPostId: postId,
    });

    const [post] = await service.withEngagement(alice.userId, [await view(quote)]);

    expect(post.engagement).toBeDefined();
    expect(post.quotedPost).not.toHaveProperty('engagement');
  });

  test('an empty list stays empty', async () => {
    expect(await service.withEngagement(alice.userId, [])).toEqual([]);
  });
});
