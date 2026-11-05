// Engagement store: likes, reposts, bookmarks (milestone 4). Each test runs in a rolled-back transaction (see
// helpers/db.js). Turn todos into tests as the store is built.
import * as store from '../../src/modules/engagement/store.js';
import * as postsStore from '../../src/modules/posts/store.js';
import { useTransaction, pgErrorCode } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';

const ctx = useTransaction();
const NO_ID = '00000000-0000-0000-0000-000000000000';

let alice;
let bob;
let postId;
beforeEach(async () => {
  alice = await createUser(ctx.db);
  bob = await createUser(ctx.db);
  ({ postId } = await postsStore.createPost({ authorId: bob.userId, content: 'hello' }, ctx.db));
});

const likeRows = async () =>
  (await ctx.db.query('SELECT user_id, post_id, created_at FROM likes ORDER BY user_id')).rows;

describe('addLike', () => {
  test('a new like returns true and is stored', async () => {
    expect(await store.addLike(alice.userId, postId, ctx.db)).toBe(true);
    expect(await likeRows()).toEqual([{ user_id: alice.userId, post_id: postId, created_at: expect.any(Date) }]);
  });

  test('liking again returns false and keeps the first like and its time', async () => {
    await store.addLike(alice.userId, postId, ctx.db);
    const [first] = await likeRows();

    expect(await store.addLike(alice.userId, postId, ctx.db)).toBe(false);
    expect(await likeRows()).toEqual([first]);
  });

  test('different users liking the same post each get their own like', async () => {
    const carol = await createUser(ctx.db);
    expect(await store.addLike(alice.userId, postId, ctx.db)).toBe(true);
    expect(await store.addLike(carol.userId, postId, ctx.db)).toBe(true);
    expect(await likeRows()).toHaveLength(2);
  });

  test('you can like your own post', async () => {
    expect(await store.addLike(bob.userId, postId, ctx.db)).toBe(true);
  });

  test('an unknown post -> 23503', async () => {
    expect(await pgErrorCode(ctx.db, () => store.addLike(alice.userId, NO_ID, ctx.db))).toBe('23503');
  });

  test('an unknown user -> 23503', async () => {
    expect(await pgErrorCode(ctx.db, () => store.addLike(NO_ID, postId, ctx.db))).toBe('23503');
  });
});

describe('removeLike', () => {
  test('removes the like and returns true', async () => {
    await store.addLike(alice.userId, postId, ctx.db);

    expect(await store.removeLike(alice.userId, postId, ctx.db)).toBe(true);
    expect(await likeRows()).toEqual([]);
  });

  test('only removes your own like', async () => {
    await store.addLike(alice.userId, postId, ctx.db);
    await store.addLike(bob.userId, postId, ctx.db);

    await store.removeLike(alice.userId, postId, ctx.db);

    expect((await likeRows()).map((row) => row.user_id)).toEqual([bob.userId]);
  });

  test('unliking again, or a post you never liked, returns false', async () => {
    await store.addLike(alice.userId, postId, ctx.db);
    await store.removeLike(alice.userId, postId, ctx.db);

    expect(await store.removeLike(alice.userId, postId, ctx.db)).toBe(false);
    expect(await store.removeLike(bob.userId, postId, ctx.db)).toBe(false);
  });

  test('an unknown post returns false', async () => {
    expect(await store.removeLike(alice.userId, NO_ID, ctx.db)).toBe(false);
  });

  test('you can like again after unliking', async () => {
    await store.addLike(alice.userId, postId, ctx.db);
    await store.removeLike(alice.userId, postId, ctx.db);

    expect(await store.addLike(alice.userId, postId, ctx.db)).toBe(true);
  });
});

describe('listLikedPosts', () => {
  // now() is fixed inside a transaction, so every like would share one created_at. Likes are made `minutesAgo` in the
  // past so the expected order is explicit.
  async function likeAt(user, likedPostId, minutesAgo) {
    await store.addLike(user.userId, likedPostId, ctx.db);
    await ctx.db.query(
      `UPDATE likes SET created_at = now() - make_interval(mins => $3) WHERE user_id = $1 AND post_id = $2`,
      [user.userId, likedPostId, minutesAgo],
    );
  }
  const newPost = async (content = 'post', fields = {}) =>
    (await postsStore.createPost({ authorId: bob.userId, content, ...fields }, ctx.db)).postId;
  const ids = (rows) => rows.map((row) => row.postId);

  test('post views with likedAt, newest like first (not newest post)', async () => {
    const older = await newPost('older');
    const newer = await newPost('newer');
    await likeAt(alice, newer, 10);
    await likeAt(alice, older, 5);

    const rows = await store.listLikedPosts(alice.userId, { limit: 10 }, ctx.db);

    expect(ids(rows)).toEqual([older, newer]);
    expect(rows[0]).toEqual({
      ...(await postsStore.getPostView(older, ctx.db)),
      likedAt: expect.any(Date),
    });
    expect(rows[0].likedAt.getTime()).toBeGreaterThan(rows[1].likedAt.getTime());
  });

  test('a liked quote embeds the quoted post, the same as everywhere else', async () => {
    const quote = await newPost('my take', { quotedPostId: postId });
    await likeAt(alice, quote, 1);

    const [row] = await store.listLikedPosts(alice.userId, { limit: 10 }, ctx.db);
    expect(row.quotedPost).toMatchObject({ postId, content: 'hello' });
  });

  test("only that user's likes", async () => {
    const other = await newPost();
    await likeAt(alice, postId, 1);
    await likeAt(bob, other, 1);

    expect(ids(await store.listLikedPosts(alice.userId, { limit: 10 }, ctx.db))).toEqual([postId]);
  });

  test('deleted posts are hidden', async () => {
    const doomed = await newPost();
    await likeAt(alice, postId, 2);
    await likeAt(alice, doomed, 1);
    await postsStore.softDeletePost(doomed, bob.userId, ctx.db);

    expect(ids(await store.listLikedPosts(alice.userId, { limit: 10 }, ctx.db))).toEqual([postId]);
  });

  test('[] when the user has liked nothing', async () => {
    expect(await store.listLikedPosts(alice.userId, { limit: 10 }, ctx.db)).toEqual([]);
  });

  test('pages through every like with the cursor, ties broken by post id', async () => {
    const posts = [];
    for (let i = 0; i < 5; i++) {
      posts.push(await newPost());
    }
    // Two pairs liked in the same minute, so the cursor has to break ties.
    await likeAt(alice, posts[0], 3);
    await likeAt(alice, posts[1], 3);
    await likeAt(alice, posts[2], 2);
    await likeAt(alice, posts[3], 1);
    await likeAt(alice, posts[4], 1);
    const all = ids(await store.listLikedPosts(alice.userId, { limit: 10 }, ctx.db));

    const seen = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const rows = await store.listLikedPosts(alice.userId, { limit: 2, cursor }, ctx.db);
      if (rows.length === 0) break;
      seen.push(...ids(rows));
      const last = rows.at(-1);
      cursor = { likedAt: last.likedAt.toISOString(), postId: last.postId };
    }

    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(5);
  });
});

describe('addRepost', () => {
  test('a new repost returns created: true with its id and time', async () => {
    const repost = await store.addRepost(alice.userId, postId, ctx.db);

    expect(repost).toEqual({ repostId: expect.any(String), createdAt: expect.any(Date), created: true });
    const { rows } = await ctx.db.query('SELECT repost_id, user_id, post_id FROM reposts');
    expect(rows).toEqual([{ repost_id: repost.repostId, user_id: alice.userId, post_id: postId }]);
  });

  test('reposting again returns the same repost with created: false, and stores nothing new', async () => {
    const first = await store.addRepost(alice.userId, postId, ctx.db);

    const again = await store.addRepost(alice.userId, postId, ctx.db);

    expect(again).toEqual({ repostId: first.repostId, createdAt: first.createdAt, created: false });
    const { rows } = await ctx.db.query('SELECT count(*)::int AS n FROM reposts');
    expect(rows[0].n).toBe(1);
  });

  test('different users reposting the same post each get their own repost', async () => {
    const carol = await createUser(ctx.db);
    const fromAlice = await store.addRepost(alice.userId, postId, ctx.db);
    const fromCarol = await store.addRepost(carol.userId, postId, ctx.db);

    expect(fromCarol.created).toBe(true);
    expect(fromCarol.repostId).not.toBe(fromAlice.repostId);
  });

  test('you can repost your own post', async () => {
    expect((await store.addRepost(bob.userId, postId, ctx.db)).created).toBe(true);
  });

  test('an unknown post -> 23503', async () => {
    expect(await pgErrorCode(ctx.db, () => store.addRepost(alice.userId, NO_ID, ctx.db))).toBe('23503');
  });

  test('an unknown user -> 23503', async () => {
    expect(await pgErrorCode(ctx.db, () => store.addRepost(NO_ID, postId, ctx.db))).toBe('23503');
  });
});

describe('removeRepost', () => {
  const repostUsers = async () =>
    (await ctx.db.query('SELECT user_id FROM reposts ORDER BY user_id')).rows.map((row) => row.user_id);

  test('removes the repost and returns true', async () => {
    await store.addRepost(alice.userId, postId, ctx.db);

    expect(await store.removeRepost(alice.userId, postId, ctx.db)).toBe(true);
    expect(await repostUsers()).toEqual([]);
  });

  test('only removes your own repost', async () => {
    await store.addRepost(alice.userId, postId, ctx.db);
    await store.addRepost(bob.userId, postId, ctx.db);

    await store.removeRepost(alice.userId, postId, ctx.db);

    expect(await repostUsers()).toEqual([bob.userId]);
  });

  test('un-reposting again, or a post you never reposted, returns false', async () => {
    await store.addRepost(alice.userId, postId, ctx.db);
    await store.removeRepost(alice.userId, postId, ctx.db);

    expect(await store.removeRepost(alice.userId, postId, ctx.db)).toBe(false);
    expect(await store.removeRepost(bob.userId, postId, ctx.db)).toBe(false);
  });

  test('an unknown post returns false', async () => {
    expect(await store.removeRepost(alice.userId, NO_ID, ctx.db)).toBe(false);
  });

  test('reposting again afterwards is a new repost with a new id', async () => {
    const first = await store.addRepost(alice.userId, postId, ctx.db);
    await store.removeRepost(alice.userId, postId, ctx.db);

    const second = await store.addRepost(alice.userId, postId, ctx.db);

    expect(second.created).toBe(true);
    expect(second.repostId).not.toBe(first.repostId);
  });
});

const bookmarkRows = async () =>
  (await ctx.db.query('SELECT user_id, post_id, created_at FROM bookmarks ORDER BY user_id')).rows;

describe('addBookmark', () => {
  test('a new bookmark returns true and is stored', async () => {
    expect(await store.addBookmark(alice.userId, postId, ctx.db)).toBe(true);
    expect(await bookmarkRows()).toEqual([{ user_id: alice.userId, post_id: postId, created_at: expect.any(Date) }]);
  });

  test('bookmarking again returns false and keeps the first bookmark', async () => {
    await store.addBookmark(alice.userId, postId, ctx.db);
    const [first] = await bookmarkRows();

    expect(await store.addBookmark(alice.userId, postId, ctx.db)).toBe(false);
    expect(await bookmarkRows()).toEqual([first]);
  });

  test('you can bookmark your own post', async () => {
    expect(await store.addBookmark(bob.userId, postId, ctx.db)).toBe(true);
  });

  test('an unknown post -> 23503', async () => {
    expect(await pgErrorCode(ctx.db, () => store.addBookmark(alice.userId, NO_ID, ctx.db))).toBe('23503');
  });

  test('an unknown user -> 23503', async () => {
    expect(await pgErrorCode(ctx.db, () => store.addBookmark(NO_ID, postId, ctx.db))).toBe('23503');
  });
});

describe('removeBookmark', () => {
  test('removes the bookmark and returns true', async () => {
    await store.addBookmark(alice.userId, postId, ctx.db);

    expect(await store.removeBookmark(alice.userId, postId, ctx.db)).toBe(true);
    expect(await bookmarkRows()).toEqual([]);
  });

  test('only removes your own bookmark', async () => {
    await store.addBookmark(alice.userId, postId, ctx.db);
    await store.addBookmark(bob.userId, postId, ctx.db);

    await store.removeBookmark(alice.userId, postId, ctx.db);

    expect((await bookmarkRows()).map((row) => row.user_id)).toEqual([bob.userId]);
  });

  test('removing again, or a bookmark you never had, returns false', async () => {
    await store.addBookmark(alice.userId, postId, ctx.db);
    await store.removeBookmark(alice.userId, postId, ctx.db);

    expect(await store.removeBookmark(alice.userId, postId, ctx.db)).toBe(false);
    expect(await store.removeBookmark(bob.userId, postId, ctx.db)).toBe(false);
  });

  test('an unknown post returns false', async () => {
    expect(await store.removeBookmark(alice.userId, NO_ID, ctx.db)).toBe(false);
  });
});

describe('likes, reposts and bookmarks are independent', () => {
  test('removing one leaves the others', async () => {
    await store.addLike(alice.userId, postId, ctx.db);
    await store.addRepost(alice.userId, postId, ctx.db);
    await store.addBookmark(alice.userId, postId, ctx.db);

    await store.removeBookmark(alice.userId, postId, ctx.db);

    expect(await likeRows()).toHaveLength(1);
    const { rows } = await ctx.db.query('SELECT count(*)::int AS n FROM reposts');
    expect(rows[0].n).toBe(1);
    expect(await bookmarkRows()).toEqual([]);
  });
});

describe('getEngagement', () => {
  const NONE = {
    likeCount: 0,
    repostCount: 0,
    replyCount: 0,
    quoteCount: 0,
    liked: false,
    reposted: false,
    bookmarked: false,
  };
  const newPost = async (author, fields = {}) =>
    (await postsStore.createPost({ authorId: author.userId, content: 'post', ...fields }, ctx.db)).postId;

  let carol;
  beforeEach(async () => {
    carol = await createUser(ctx.db);
  });

  test('counts every kind of engagement on a post', async () => {
    await store.addLike(alice.userId, postId, ctx.db);
    await store.addLike(carol.userId, postId, ctx.db);
    await store.addRepost(alice.userId, postId, ctx.db);
    await newPost(carol, { parentPostId: postId, rootPostId: postId });
    await newPost(carol, { quotedPostId: postId });
    await newPost(alice, { quotedPostId: postId });

    const engagement = await store.getEngagement([postId], null, ctx.db);

    expect(engagement).toEqual({
      [postId]: { ...NONE, likeCount: 2, repostCount: 1, replyCount: 1, quoteCount: 2 },
    });
  });

  test("flags are the viewer's own", async () => {
    await store.addLike(alice.userId, postId, ctx.db);
    await store.addRepost(alice.userId, postId, ctx.db);
    await store.addBookmark(carol.userId, postId, ctx.db);

    const forAlice = await store.getEngagement([postId], alice.userId, ctx.db);
    const forCarol = await store.getEngagement([postId], carol.userId, ctx.db);

    expect(forAlice[postId]).toMatchObject({ liked: true, reposted: true, bookmarked: false });
    expect(forCarol[postId]).toMatchObject({ liked: false, reposted: false, bookmarked: true });
  });

  test('logged out (viewer null): counts, but every flag false', async () => {
    await store.addLike(alice.userId, postId, ctx.db);
    await store.addBookmark(alice.userId, postId, ctx.db);

    expect((await store.getEngagement([postId], null, ctx.db))[postId]).toEqual({ ...NONE, likeCount: 1 });
  });

  test('a page of posts: each gets its own numbers', async () => {
    const other = await newPost(carol);
    const untouched = await newPost(carol);
    await store.addLike(alice.userId, postId, ctx.db);
    await store.addRepost(bob.userId, other, ctx.db);

    const engagement = await store.getEngagement([postId, other, untouched], alice.userId, ctx.db);

    expect(engagement).toEqual({
      [postId]: { ...NONE, likeCount: 1, liked: true },
      [other]: { ...NONE, repostCount: 1 },
      [untouched]: NONE,
    });
  });

  test('deleted replies and quotes are not counted', async () => {
    const reply = await newPost(carol, { parentPostId: postId, rootPostId: postId });
    const quote = await newPost(carol, { quotedPostId: postId });
    await postsStore.softDeletePost(reply, carol.userId, ctx.db);
    await postsStore.softDeletePost(quote, carol.userId, ctx.db);

    expect((await store.getEngagement([postId], null, ctx.db))[postId]).toEqual(NONE);
  });

  test('replies to replies are not counted on the original', async () => {
    const reply = await newPost(carol, { parentPostId: postId, rootPostId: postId });
    await newPost(alice, { parentPostId: reply, rootPostId: postId });

    const engagement = await store.getEngagement([postId, reply], null, ctx.db);

    expect(engagement[postId].replyCount).toBe(1);
    expect(engagement[reply].replyCount).toBe(1);
  });

  test('a repeated id gives one entry; an unknown id gets zeros', async () => {
    const engagement = await store.getEngagement([postId, postId, NO_ID], null, ctx.db);
    expect(engagement).toEqual({ [postId]: NONE, [NO_ID]: NONE });
  });

  test('no ids: {}', async () => {
    expect(await store.getEngagement([], alice.userId, ctx.db)).toEqual({});
  });
});

describe('listBookmarkedPosts', () => {
  // now() is fixed inside a transaction, so bookmarks are made `minutesAgo` in the past to make the order explicit.
  async function bookmarkAt(user, bookmarkedPostId, minutesAgo) {
    await store.addBookmark(user.userId, bookmarkedPostId, ctx.db);
    await ctx.db.query(
      `UPDATE bookmarks SET created_at = now() - make_interval(mins => $3) WHERE user_id = $1 AND post_id = $2`,
      [user.userId, bookmarkedPostId, minutesAgo],
    );
  }
  const newPost = async () => (await postsStore.createPost({ authorId: bob.userId, content: 'post' }, ctx.db)).postId;
  const ids = (rows) => rows.map((row) => row.postId);

  test('post views with bookmarkedAt, newest bookmark first (not newest post)', async () => {
    const older = await newPost();
    const newer = await newPost();
    await bookmarkAt(alice, newer, 10);
    await bookmarkAt(alice, older, 5);

    const rows = await store.listBookmarkedPosts(alice.userId, { limit: 10 }, ctx.db);

    expect(ids(rows)).toEqual([older, newer]);
    expect(rows[0]).toEqual({
      ...(await postsStore.getPostView(older, ctx.db)),
      bookmarkedAt: expect.any(Date),
    });
  });

  test("only that user's bookmarks", async () => {
    const other = await newPost();
    await bookmarkAt(alice, postId, 1);
    await bookmarkAt(bob, other, 1);

    expect(ids(await store.listBookmarkedPosts(alice.userId, { limit: 10 }, ctx.db))).toEqual([postId]);
  });

  test('likes are not bookmarks', async () => {
    await store.addLike(alice.userId, postId, ctx.db);
    expect(await store.listBookmarkedPosts(alice.userId, { limit: 10 }, ctx.db)).toEqual([]);
  });

  test('deleted posts are hidden', async () => {
    const doomed = await newPost();
    await bookmarkAt(alice, postId, 2);
    await bookmarkAt(alice, doomed, 1);
    await postsStore.softDeletePost(doomed, bob.userId, ctx.db);

    expect(ids(await store.listBookmarkedPosts(alice.userId, { limit: 10 }, ctx.db))).toEqual([postId]);
  });

  test('pages through every bookmark with the cursor, ties broken by post id', async () => {
    const posts = [];
    for (let i = 0; i < 5; i++) {
      posts.push(await newPost());
    }
    // Two pairs bookmarked in the same minute, so the cursor has to break ties.
    for (const [i, minutesAgo] of [3, 3, 2, 1, 1].entries()) {
      await bookmarkAt(alice, posts[i], minutesAgo);
    }
    const all = ids(await store.listBookmarkedPosts(alice.userId, { limit: 10 }, ctx.db));

    const seen = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const rows = await store.listBookmarkedPosts(alice.userId, { limit: 2, cursor }, ctx.db);
      if (rows.length === 0) break;
      seen.push(...ids(rows));
      const last = rows.at(-1);
      cursor = { bookmarkedAt: last.bookmarkedAt.toISOString(), postId: last.postId };
    }

    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(5);
  });
});

describe('deletes', () => {
  test.todo('deleting a post removes its likes, reposts and bookmarks');
  test.todo('deleting a user removes their engagement');
});
