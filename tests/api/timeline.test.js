// HTTP tests for the timeline routes. Requests go through the real app and pool; tables are emptied between tests.
import request from 'supertest';
import app from '../../src/app.js';
import { pool, resetDatabase } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';
import { authCookie } from '../helpers/auth.js';

afterEach(() => resetDatabase());
afterAll(() => pool.end());

let alice;
let bob;
let carol;
beforeEach(async () => {
  alice = await createUser(pool, { username: 'alice' });
  bob = await createUser(pool, { username: 'bob' });
  carol = await createUser(pool, { username: 'carol' });
});

// Creates a post through the API as `user`, then moves it `minutesAgo` into the past so order is explicit.
async function postAs(user, minutesAgo, body = {}) {
  const res = await request(app)
    .post('/posts')
    .set('Cookie', authCookie(user.userId))
    .send({ content: `post by ${user.username}`, ...body });
  await pool.query(`UPDATE posts SET created_at = now() - make_interval(mins => $2) WHERE post_id = $1`, [
    res.body.postId,
    minutesAgo,
  ]);
  return res.body.postId;
}
const followAs = (user, target) =>
  request(app).post(`/users/me/following/${target.userId}`).set('Cookie', authCookie(user.userId));
const deleteAs = (user, postId) => request(app).delete(`/posts/${postId}`).set('Cookie', authCookie(user.userId));
const ids = (res) => res.body.items.map((item) => item.postId);

// Pages through a timeline URL two at a time, sending nextCursor back exactly like a client.
async function pageThrough(url, cookie) {
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const req = request(app).get(`${url}?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
    const res = await (cookie ? req.set('Cookie', cookie) : req);
    expect(res.status).toBe(200);
    seen.push(...ids(res));
    cursor = res.body.nextCursor;
    pages += 1;
  } while (cursor && pages < 20);
  return { seen, pages };
}

describe('GET /timeline', () => {
  const home = (user, query = '') => request(app).get(`/timeline${query}`).set('Cookie', authCookie(user.userId));

  test('200 with own and followed posts, newest first, as post views', async () => {
    await followAs(alice, bob);
    const own = await postAs(alice, 3);
    const followed = await postAs(bob, 1);
    await postAs(carol, 2); // not followed

    const res = await home(alice);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([followed, own]);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items[0]).toEqual({
      postId: followed,
      author: { userId: bob.userId, username: 'bob', displayName: bob.displayName },
      content: 'post by bob',
      parentPostId: null,
      rootPostId: null,
      quotedPostId: null,
      createdAt: expect.any(String),
      deleted: false,
      quotedPost: null,
    });
  });

  test('following and unfollowing through the API take effect on the next request', async () => {
    const bobsPost = await postAs(bob, 1);
    expect(ids(await home(alice))).toEqual([]);

    await followAs(alice, bob);
    expect(ids(await home(alice))).toEqual([bobsPost]);

    await request(app).delete(`/users/me/following/${bob.userId}`).set('Cookie', authCookie(alice.userId));
    expect(ids(await home(alice))).toEqual([]);
  });

  test('quotes appear with the quoted post embedded; replies and deleted posts do not', async () => {
    await followAs(alice, bob);
    const original = await postAs(carol, 10); // carol isn't followed, but bob quotes and replies to her
    const quote = await postAs(bob, 5, { quotedPostId: original });
    await postAs(bob, 3, { parentPostId: original });
    const gone = await postAs(bob, 1);
    await deleteAs(bob, gone);

    const res = await home(alice);
    expect(ids(res)).toEqual([quote]);
    expect(res.body.items[0].quotedPost).toMatchObject({ postId: original, author: { username: 'carol' } });
  });

  test('pages through everything with nextCursor, without skipping or repeating', async () => {
    await followAs(alice, bob);
    const expected = [];
    for (let i = 1; i <= 5; i++) expected.push(await postAs(i % 2 ? bob : alice, i));
    const { seen, pages } = await pageThrough('/timeline', authCookie(alice.userId));
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });

  test('nothing to show -> 200 with an empty page', async () => {
    expect((await home(alice)).body).toEqual({ items: [], nextCursor: null });
  });

  test('401 without an access token', async () => {
    const res = await request(app).get('/timeline');
    expect(res.status).toBe(401);
  });

  test.each([
    ['limit 0', '?limit=0'],
    ['limit over 100', '?limit=101'],
    ['garbage cursor', '?cursor=not-a-cursor'],
  ])('400 for %s', async (_, query) => {
    expect((await home(alice, query)).status).toBe(400);
  });
});

describe('GET /users/:username/posts', () => {
  test("200 with that user's posts, newest first; no login needed", async () => {
    const older = await postAs(alice, 2);
    const newer = await postAs(alice, 1);
    await postAs(bob, 0);

    const res = await request(app).get('/users/alice/posts');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([newer, older]);
    expect(res.body.items[0].author).toMatchObject({ username: 'alice' });
  });

  test('works with a differently cased username', async () => {
    await postAs(alice, 1);
    expect(ids(await request(app).get('/users/ALICE/posts'))).toHaveLength(1);
  });

  test('excludes replies and deleted posts', async () => {
    const kept = await postAs(alice, 5);
    await postAs(alice, 3, { parentPostId: kept });
    const gone = await postAs(alice, 1);
    await deleteAs(alice, gone);
    expect(ids(await request(app).get('/users/alice/posts'))).toEqual([kept]);
  });

  test('pages through everything with nextCursor', async () => {
    const expected = [];
    for (let i = 1; i <= 5; i++) expected.push(await postAs(alice, i));
    const { seen, pages } = await pageThrough('/users/alice/posts');
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });

  test('a user with no posts -> 200 with an empty page', async () => {
    expect((await request(app).get('/users/bob/posts')).body).toEqual({ items: [], nextCursor: null });
  });

  test('404 for an unknown user', async () => {
    const res = await request(app).get('/users/nobody_here/posts');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
  });

  test.each([
    ['invalid username', '/users/a!/posts'],
    ['limit 0', '/users/alice/posts?limit=0'],
    ['garbage cursor', '/users/alice/posts?cursor=not-a-cursor'],
  ])('400 for %s', async (_, url) => {
    expect((await request(app).get(url)).status).toBe(400);
  });

  test("doesn't disturb the neighbouring /users routes", async () => {
    expect((await request(app).get('/users/alice')).body.username).toBe('alice');
    expect((await request(app).get('/users/alice/followers')).status).toBe(200);
  });
});
