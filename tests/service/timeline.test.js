// Timeline service against the test database. Services use the pool (no transaction client), so data is committed
// and tables are emptied between tests, like the API tests. Which posts appear is covered by the store tests; these
// cover paging, the username lookup and the response shape.
import * as service from '../../src/modules/timeline/service.js';
import * as postsStore from '../../src/modules/posts/store.js';
import { follow } from '../../src/modules/follows/store.js';
import { decodeCursor } from '../../src/pagination.js';
import { pool, resetDatabase } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';

afterEach(() => resetDatabase());
afterAll(() => pool.end());

// Posts `minutesAgo` in the past, so the expected order is explicit.
async function postAt(author, minutesAgo) {
  const { postId } = await postsStore.createPost({ authorId: author.userId, content: 'post' });
  await pool.query(`UPDATE posts SET created_at = now() - make_interval(mins => $2) WHERE post_id = $1`, [
    postId,
    minutesAgo,
  ]);
  return postId;
}
const ids = (page) => page.items.map((item) => item.postId);

// Follows nextCursor like a client: encoded string out, decoded (as the query schema will) back in.
async function pageThrough(getPage, key, limit) {
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await getPage(key, { limit, cursor });
    seen.push(...ids(page));
    cursor = page.nextCursor && decodeCursor(page.nextCursor);
    pages += 1;
  } while (cursor && pages < 20);
  return { seen, pages };
}

let alice;
let bob;
beforeEach(async () => {
  alice = await createUser(pool, { username: 'alice' });
  bob = await createUser(pool, { username: 'bob' });
});

describe('getHomeTimeline', () => {
  test('{ items, nextCursor } with own and followed posts, newest first', async () => {
    await follow(alice.userId, bob.userId);
    const own = await postAt(alice, 2);
    const followed = await postAt(bob, 1);

    const page = await service.getHomeTimeline(alice.userId, { limit: 10 });
    expect(ids(page)).toEqual([followed, own]);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toMatchObject({ author: { userId: bob.userId }, deleted: false, quotedPost: null });
  });

  test('pages through everything with nextCursor, without skipping or repeating', async () => {
    await follow(alice.userId, bob.userId);
    const expected = [];
    for (let i = 1; i <= 5; i++) expected.push(await postAt(i % 2 ? bob : alice, i));
    const { seen, pages } = await pageThrough(service.getHomeTimeline, alice.userId, 2);
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });

  test('exactly limit items -> nextCursor is null', async () => {
    await postAt(alice, 2);
    await postAt(alice, 1);
    const page = await service.getHomeTimeline(alice.userId, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  test('nothing to show -> empty page', async () => {
    expect(await service.getHomeTimeline(alice.userId, { limit: 10 })).toEqual({ items: [], nextCursor: null });
  });
});

describe('getProfileTimeline', () => {
  test("{ items, nextCursor } with that user's posts, newest first", async () => {
    const older = await postAt(alice, 2);
    const newer = await postAt(alice, 1);
    await postAt(bob, 0);

    const page = await service.getProfileTimeline('alice', { limit: 10 });
    expect(ids(page)).toEqual([newer, older]);
    expect(page.nextCursor).toBeNull();
  });

  test('finds the user ignoring case', async () => {
    await postAt(alice, 1);
    expect((await service.getProfileTimeline('ALICE', { limit: 10 })).items).toHaveLength(1);
  });

  test('pages through everything with nextCursor', async () => {
    const expected = [];
    for (let i = 1; i <= 5; i++) expected.push(await postAt(alice, i));
    const { seen, pages } = await pageThrough(service.getProfileTimeline, 'alice', 2);
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });

  test('a user with no posts -> empty page; an unknown user -> null', async () => {
    expect(await service.getProfileTimeline('bob', { limit: 10 })).toEqual({ items: [], nextCursor: null });
    expect(await service.getProfileTimeline('nobody_here', { limit: 10 })).toBeNull();
  });
});
