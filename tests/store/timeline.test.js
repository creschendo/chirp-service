// Timeline store against the test database. Each test runs in a rolled-back transaction (see helpers/db.js).
import * as store from '../../src/modules/timeline/store.js';
import * as postsStore from '../../src/modules/posts/store.js';
import { follow } from '../../src/modules/follows/store.js';
import { addRepost, removeRepost } from '../../src/modules/engagement/store.js';
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
// The same keys the service puts in nextCursor.
const cursorOf = (row) =>
  row.repost
    ? { activityAt: row.repost.repostedAt.toISOString(), itemId: row.repost.repostId }
    : { activityAt: row.createdAt.toISOString(), itemId: row.postId };

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

// --- Reposts ---

// A repost `minutesAgo` in the past. Returns its repostId.
async function repostAt(user, postId, minutesAgo) {
  const { repostId } = await addRepost(user.userId, postId, ctx.db);
  await ctx.db.query(`UPDATE reposts SET created_at = now() - make_interval(mins => $2) WHERE repost_id = $1`, [
    repostId,
    minutesAgo,
  ]);
  return repostId;
}
// Each item's own id: a post's postId, a repost's repostId. Post ids alone can repeat once reposts are in.
const itemIds = (rows) => rows.map((row) => row.repost?.repostId ?? row.postId);
async function pageThroughItems(list, id, limit) {
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const rows = await list(id, { limit, cursor }, ctx.db);
    if (rows.length === 0) break;
    seen.push(...itemIds(rows));
    cursor = cursorOf(rows.at(-1));
  }
  return seen;
}

describe('listProfilePosts with reposts', () => {
  test("the user's reposts are items at the time of the repost, with who reposted it", async () => {
    const bobsPost = await postAt(bob, 30);
    const own = await postAt(alice, 20);
    const repostId = await repostAt(alice, bobsPost, 10);

    const rows = await store.listProfilePosts(alice.userId, { limit: 10 }, ctx.db);

    expect(itemIds(rows)).toEqual([repostId, own]);
    expect(rows[0]).toMatchObject({
      postId: bobsPost,
      author: { userId: bob.userId, username: 'bob' },
      repost: {
        repostId,
        user: { userId: alice.userId, username: 'alice', displayName: alice.displayName },
        repostedAt: expect.any(Date),
      },
    });
    expect(rows[1].repost).toBeNull();
  });

  test('the original keeps its place: reposting your own post shows it twice', async () => {
    const own = await postAt(alice, 30);
    const repostId = await repostAt(alice, own, 5);

    const rows = await store.listProfilePosts(alice.userId, { limit: 10 }, ctx.db);

    expect(itemIds(rows)).toEqual([repostId, own]);
    expect(ids(rows)).toEqual([own, own]);
  });

  test("other users' reposts aren't on this profile", async () => {
    const own = await postAt(alice, 30);
    await repostAt(bob, own, 5);
    expect(itemIds(await store.listProfilePosts(alice.userId, { limit: 10 }, ctx.db))).toEqual([own]);
  });

  test('reposts of deleted posts are hidden; reposts of replies are shown', async () => {
    const original = await postAt(bob, 30);
    const bobsReply = await reply(bob, 20, original);
    const gone = await postAt(bob, 25);
    const ofReply = await repostAt(alice, bobsReply, 10);
    await repostAt(alice, gone, 5);
    await softDelete(gone, bob);

    expect(itemIds(await store.listProfilePosts(alice.userId, { limit: 10 }, ctx.db))).toEqual([ofReply]);
  });

  test('un-reposting removes the item', async () => {
    const bobsPost = await postAt(bob, 30);
    await repostAt(alice, bobsPost, 5);
    await removeRepost(alice.userId, bobsPost, ctx.db);
    expect(await store.listProfilePosts(alice.userId, { limit: 10 }, ctx.db)).toEqual([]);
  });

  test('cursor pages through posts and reposts, ties included, without skipping or repeating', async () => {
    const expected = [];
    for (let i = 1; i <= 3; i++) expected.push(await postAt(alice, i * 2)); // 2, 4, 6 minutes ago
    const bobsPosts = [];
    for (let i = 0; i < 3; i++) bobsPosts.push(await postAt(bob, 60));
    // Reposts at 1, 4 (tying with a post) and 5 minutes ago.
    const reposts = [
      await repostAt(alice, bobsPosts[0], 1),
      await repostAt(alice, bobsPosts[1], 4),
      await repostAt(alice, bobsPosts[2], 5),
    ];
    const all = itemIds(await store.listProfilePosts(alice.userId, { limit: 20 }, ctx.db));
    expect(all).toHaveLength(6);
    expect(new Set(all)).toEqual(new Set([...expected, ...reposts]));

    for (const limit of [1, 2, 4]) {
      expect(await pageThroughItems(store.listProfilePosts, alice.userId, limit)).toEqual(all);
    }
  });
});

describe('listHomePosts with reposts', () => {
  beforeEach(async () => {
    await follow(alice.userId, bob.userId, ctx.db);
  });

  test('reposts by people you follow and by you are shown; others are not', async () => {
    const carolsPost = await postAt(carol, 60);
    const dave = await createUser(ctx.db, { username: 'dave' });
    const byBob = await repostAt(bob, carolsPost, 10);
    const byAlice = await repostAt(alice, await postAt(carol, 50), 5);
    await repostAt(dave, await postAt(carol, 40), 1); // alice doesn't follow dave

    const rows = await store.listHomePosts(alice.userId, { limit: 10 }, ctx.db);

    expect(itemIds(rows)).toEqual([byAlice, byBob]);
    expect(rows[1]).toMatchObject({ postId: carolsPost, repost: { user: { userId: bob.userId } } });
  });

  test('a repost is new activity: the original stays at its own time too', async () => {
    const bobsPost = await postAt(bob, 60);
    await follow(alice.userId, carol.userId, ctx.db);
    const byCarol = await repostAt(carol, bobsPost, 5);

    expect(itemIds(await store.listHomePosts(alice.userId, { limit: 10 }, ctx.db))).toEqual([byCarol, bobsPost]);
  });

  test('a post reposted by several people you follow shows once, as the newest repost', async () => {
    const carolsPost = await postAt(carol, 60);
    await follow(alice.userId, carol.userId, ctx.db);
    await repostAt(bob, carolsPost, 20);
    const newest = await repostAt(alice, carolsPost, 10);

    // Carol's original (followed) plus one repost item, not two.
    expect(itemIds(await store.listHomePosts(alice.userId, { limit: 10 }, ctx.db))).toEqual([newest, carolsPost]);
  });

  test("a post doesn't come back on a later page through an older repost of it", async () => {
    const carolsPost = await postAt(carol, 60);
    await repostAt(bob, carolsPost, 30);
    const newest = await repostAt(alice, carolsPost, 1);
    await postAt(bob, 10);
    await postAt(bob, 20);

    const seen = await pageThroughItems(store.listHomePosts, alice.userId, 1);

    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe(newest);
  });

  test('reposts of deleted posts are hidden', async () => {
    const carolsPost = await postAt(carol, 60);
    await repostAt(bob, carolsPost, 5);
    await softDelete(carolsPost, carol);
    expect(await store.listHomePosts(alice.userId, { limit: 10 }, ctx.db)).toEqual([]);
  });

  test('cursor pages through posts and reposts from several people without skipping or repeating', async () => {
    await follow(alice.userId, carol.userId, ctx.db);
    const people = [alice, bob, carol];
    for (let i = 1; i <= 6; i++) await postAt(people[i % 3], i * 3);
    const targets = [];
    for (let i = 0; i < 4; i++) targets.push(await postAt(bob, 90));
    for (let i = 0; i < 4; i++) await repostAt(people[i % 3], targets[i], i * 3 + 1);
    const all = itemIds(await store.listHomePosts(alice.userId, { limit: 50 }, ctx.db));
    expect(all).toHaveLength(14); // 6 posts + 4 targets + 4 reposts

    for (const limit of [1, 3, 5]) {
      expect(await pageThroughItems(store.listHomePosts, alice.userId, limit)).toEqual(all);
    }
  });
});
