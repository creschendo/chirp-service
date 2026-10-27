// Timeline store against the test database. Each test runs in a rolled-back transaction (see helpers/db.js).
import * as store from '../../src/modules/timeline/store.js';
import * as postsStore from '../../src/modules/posts/store.js';
import { follow } from '../../src/modules/follows/store.js';
import { useTransaction } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';

const ctx = useTransaction();

// now() is fixed inside a transaction, so every post would share one created_at. Posts are created
// `minutesAgo` in the past so the expected order is explicit.
async function postAt(author, minutesAgo, fields = {}) {
  const { postId } = await postsStore.createPost({ authorId: author.userId, content: 'post', ...fields }, ctx.db);
  await ctx.db.query(`UPDATE posts SET created_at = now() - make_interval(mins => $2) WHERE post_id = $1`, [
    postId,
    minutesAgo,
  ]);
  return postId;
}
const reply = (author, minutesAgo, parentPostId) =>
  postAt(author, minutesAgo, { parentPostId, rootPostId: parentPostId });
const softDelete = (postId, author) => postsStore.softDeletePost(postId, author.userId, ctx.db);
const ids = (rows) => rows.map((row) => row.postId);
const cursorOf = (row) => ({ createdAt: row.createdAt.toISOString(), postId: row.postId });

let alice;
let bob;
let carol;
beforeEach(async () => {
  alice = await createUser(ctx.db, { username: 'alice' });
  bob = await createUser(ctx.db, { username: 'bob' });
  carol = await createUser(ctx.db, { username: 'carol' });
});

// Pages through a list with a small limit, following the cursor like a client would.
async function pageThrough(list, id, limit) {
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const rows = await list(id, { limit, cursor }, ctx.db);
    if (rows.length === 0) break;
    seen.push(...ids(rows));
    cursor = cursorOf(rows.at(-1));
  }
  return seen;
}

describe('listProfilePosts', () => {
  test("only that author's posts, newest first, as post views", async () => {
    const older = await postAt(alice, 10);
    const newer = await postAt(alice, 1);
    await postAt(bob, 5);

    const rows = await store.listProfilePosts(alice.userId, { limit: 10 }, ctx.db);
    expect(ids(rows)).toEqual([newer, older]);
    expect(rows[0]).toMatchObject({ author: { userId: alice.userId, username: 'alice' }, deleted: false });
  });

  test('includes quotes (with the quoted post embedded) but not replies', async () => {
    const bobsPost = await postAt(bob, 10);
    const quote = await postAt(alice, 5, { quotedPostId: bobsPost });
    await reply(alice, 1, bobsPost);

    const rows = await store.listProfilePosts(alice.userId, { limit: 10 }, ctx.db);
    expect(ids(rows)).toEqual([quote]);
    expect(rows[0].quotedPost).toMatchObject({ postId: bobsPost, author: { userId: bob.userId } });
  });

  test('hides deleted posts', async () => {
    const kept = await postAt(alice, 5);
    const gone = await postAt(alice, 1);
    await softDelete(gone, alice);
    expect(ids(await store.listProfilePosts(alice.userId, { limit: 10 }, ctx.db))).toEqual([kept]);
  });

  test('a quote of a deleted post stays, embedding it as deleted', async () => {
    const bobsPost = await postAt(bob, 10);
    const quote = await postAt(alice, 5, { quotedPostId: bobsPost });
    await softDelete(bobsPost, bob);
    const [row] = await store.listProfilePosts(alice.userId, { limit: 10 }, ctx.db);
    expect(row.postId).toBe(quote);
    expect(row.quotedPost).toMatchObject({ postId: bobsPost, deleted: true });
  });

  test('cursor pages through everything without skipping or repeating', async () => {
    const expected = [];
    for (let i = 1; i <= 5; i++) expected.push(await postAt(alice, i)); // i minutes ago: newest first
    expect(await pageThrough(store.listProfilePosts, alice.userId, 2)).toEqual(expected);
  });

  test('posts with identical timestamps are split across pages correctly (post_id tie-break)', async () => {
    const all = [];
    for (let i = 0; i < 4; i++) all.push(await postAt(alice, 3));
    const seen = await pageThrough(store.listProfilePosts, alice.userId, 3);
    expect(seen).toHaveLength(4);
    expect([...seen].sort()).toEqual([...all].sort());
  });

  test('no posts -> []', async () => {
    expect(await store.listProfilePosts(alice.userId, { limit: 10 }, ctx.db)).toEqual([]);
  });
});

describe('listHomePosts', () => {
  test('posts by the viewer and everyone they follow, newest first; not from others', async () => {
    await follow(alice.userId, bob.userId, ctx.db);
    const own = await postAt(alice, 3);
    const followed = await postAt(bob, 1);
    await postAt(carol, 2); // alice doesn't follow carol

    expect(ids(await store.listHomePosts(alice.userId, { limit: 10 }, ctx.db))).toEqual([followed, own]);
  });

  test('following is one-way: being followed does not add their posts', async () => {
    await follow(bob.userId, alice.userId, ctx.db); // bob follows alice, not the other way round
    await postAt(bob, 1);
    expect(await store.listHomePosts(alice.userId, { limit: 10 }, ctx.db)).toEqual([]);
  });

  test('follows and unfollows take effect immediately (fan-out on read)', async () => {
    const bobsPost = await postAt(bob, 1);
    expect(await store.listHomePosts(alice.userId, { limit: 10 }, ctx.db)).toEqual([]);

    await follow(alice.userId, bob.userId, ctx.db);
    expect(ids(await store.listHomePosts(alice.userId, { limit: 10 }, ctx.db))).toEqual([bobsPost]);

    await ctx.db.query('DELETE FROM follows WHERE follower_id = $1 AND followed_id = $2', [alice.userId, bob.userId]);
    expect(await store.listHomePosts(alice.userId, { limit: 10 }, ctx.db)).toEqual([]);
  });

  test('excludes replies and deleted posts, includes quotes', async () => {
    await follow(alice.userId, bob.userId, ctx.db);
    const original = await postAt(bob, 10);
    await reply(bob, 5, original);
    const quote = await postAt(bob, 3, { quotedPostId: original });
    const gone = await postAt(bob, 1);
    await softDelete(gone, bob);

    expect(ids(await store.listHomePosts(alice.userId, { limit: 10 }, ctx.db))).toEqual([quote, original]);
  });

  test('cursor pages through posts from several authors without skipping or repeating', async () => {
    await follow(alice.userId, bob.userId, ctx.db);
    await follow(alice.userId, carol.userId, ctx.db);
    const authors = [alice, bob, carol];
    const expected = [];
    for (let i = 1; i <= 7; i++) expected.push(await postAt(authors[i % 3], i)); // interleaved authors
    expect(await pageThrough(store.listHomePosts, alice.userId, 3)).toEqual(expected);
  });

  test('no posts -> []', async () => {
    expect(await store.listHomePosts(alice.userId, { limit: 10 }, ctx.db)).toEqual([]);
  });
});
