// HTTP tests for the engagement routes. Requests go through the real app and pool; tables are emptied between tests.
import request from 'supertest';
import app from '../../src/app.js';
import * as postsStore from '../../src/modules/posts/store.js';
import { pool, resetDatabase } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';
import { authCookie } from '../helpers/auth.js';
import { encodeCursor } from '../../src/pagination.js';

afterEach(() => resetDatabase());
afterAll(() => pool.end());

const NO_ID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';

let alice;
let bob;
let cookie;
let postId;
beforeEach(async () => {
  alice = await createUser(pool);
  bob = await createUser(pool);
  cookie = authCookie(alice.userId);
  ({ postId } = await postsStore.createPost({ authorId: bob.userId, content: 'hello' }));
});

const likers = async (likedPostId) =>
  (await pool.query('SELECT user_id FROM likes WHERE post_id = $1', [likedPostId])).rows.map((row) => row.user_id);

describe('POST /posts/:post_id/like', () => {
  const like = (id, as = cookie) => {
    const req = request(app).post(`/posts/${id}/like`);
    if (as) req.set('Cookie', as);
    return req;
  };

  test('204, and the like is stored for the logged-in user', async () => {
    const res = await like(postId);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(await likers(postId)).toEqual([alice.userId]);
  });

  test('liking again is still 204', async () => {
    await like(postId);
    expect((await like(postId)).status).toBe(204);
    expect(await likers(postId)).toEqual([alice.userId]);
  });

  test('your own post can be liked', async () => {
    expect((await like(postId, authCookie(bob.userId))).status).toBe(204);
  });

  test('404 for a deleted post', async () => {
    await postsStore.softDeletePost(postId, bob.userId);

    const res = await like(postId);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Post not found' });
    expect(await likers(postId)).toEqual([]);
  });

  test('404 for an unknown post', async () => {
    const res = await like(NO_ID);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Post not found' });
  });

  test('400 for a malformed id', async () => {
    const res = await like('nope');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid post id' });
  });

  test('401 when not logged in', async () => {
    expect((await like(postId, null)).status).toBe(401);
    expect(await likers(postId)).toEqual([]);
  });
});

describe('DELETE /posts/:post_id/like', () => {
  const unlike = (id, as = cookie) => {
    const req = request(app).delete(`/posts/${id}/like`);
    if (as) req.set('Cookie', as);
    return req;
  };
  const like = (id, as = cookie) => request(app).post(`/posts/${id}/like`).set('Cookie', as);

  test('204, and only your like is removed', async () => {
    await like(postId);
    await like(postId, authCookie(bob.userId));

    const res = await unlike(postId);

    expect(res.status).toBe(204);
    expect(await likers(postId)).toEqual([bob.userId]);
  });

  test("204 even if you hadn't liked it, or for an unknown post", async () => {
    expect((await unlike(postId)).status).toBe(204);
    expect((await unlike(NO_ID)).status).toBe(204);
  });

  test('204 on a post deleted after you liked it, and the like is gone', async () => {
    await like(postId);
    await postsStore.softDeletePost(postId, bob.userId);

    expect((await unlike(postId)).status).toBe(204);
    expect(await likers(postId)).toEqual([]);
  });

  test('400 for a malformed id', async () => {
    const res = await unlike('nope');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid post id' });
  });

  test('401 when not logged in', async () => {
    await like(postId);
    expect((await unlike(postId, null)).status).toBe(401);
    expect(await likers(postId)).toEqual([alice.userId]);
  });
});

const reposters = async (repostedPostId) =>
  (await pool.query('SELECT user_id FROM reposts WHERE post_id = $1', [repostedPostId])).rows.map((row) => row.user_id);

describe('POST /posts/:post_id/repost', () => {
  const repost = (id, as = cookie) => {
    const req = request(app).post(`/posts/${id}/repost`);
    if (as) req.set('Cookie', as);
    return req;
  };

  test('201 with the repost id and time', async () => {
    const res = await repost(postId);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ repostId: expect.any(String), repostedAt: expect.any(String) });
    expect(await reposters(postId)).toEqual([alice.userId]);
  });

  test('200 with the same repost and time when you had already reposted it', async () => {
    const first = await repost(postId);
    const again = await repost(postId);

    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
  });

  test('your own post can be reposted', async () => {
    expect((await repost(postId, authCookie(bob.userId))).status).toBe(201);
  });

  test('the repost shows in the timelines of people who follow you', async () => {
    const carol = await createUser(pool);
    await request(app).post(`/users/me/following/${alice.userId}`).set('Cookie', authCookie(carol.userId));
    const { body } = await repost(postId);

    const res = await request(app).get('/timeline').set('Cookie', authCookie(carol.userId));

    expect(res.body.items).toEqual([
      expect.objectContaining({ postId, repost: expect.objectContaining({ repostId: body.repostId }) }),
    ]);
  });

  test('404 for a deleted post', async () => {
    await postsStore.softDeletePost(postId, bob.userId);

    const res = await repost(postId);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Post not found' });
    expect(await reposters(postId)).toEqual([]);
  });

  test('404 for an unknown post', async () => {
    const res = await repost(NO_ID);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Post not found' });
  });

  test('400 for a malformed id', async () => {
    const res = await repost('nope');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid post id' });
  });

  test('401 when not logged in', async () => {
    expect((await repost(postId, null)).status).toBe(401);
    expect(await reposters(postId)).toEqual([]);
  });
});

describe('DELETE /posts/:post_id/repost', () => {
  const unrepost = (id, as = cookie) => {
    const req = request(app).delete(`/posts/${id}/repost`);
    if (as) req.set('Cookie', as);
    return req;
  };
  const repost = (id, as = cookie) => request(app).post(`/posts/${id}/repost`).set('Cookie', as);

  test('204, and only your repost is removed', async () => {
    await repost(postId);
    await repost(postId, authCookie(bob.userId));

    const res = await unrepost(postId);

    expect(res.status).toBe(204);
    expect(await reposters(postId)).toEqual([bob.userId]);
  });

  test("204 even if you hadn't reposted it, or for an unknown post", async () => {
    expect((await unrepost(postId)).status).toBe(204);
    expect((await unrepost(NO_ID)).status).toBe(204);
  });

  test('204 on a post deleted after you reposted it, and the repost is gone', async () => {
    await repost(postId);
    await postsStore.softDeletePost(postId, bob.userId);

    expect((await unrepost(postId)).status).toBe(204);
    expect(await reposters(postId)).toEqual([]);
  });

  test('reposting again afterwards is 201 with a new repost', async () => {
    const first = await repost(postId);
    await unrepost(postId);

    const second = await repost(postId);

    expect(second.status).toBe(201);
    expect(second.body.repostId).not.toBe(first.body.repostId);
  });

  test('400 for a malformed id', async () => {
    const res = await unrepost('nope');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid post id' });
  });

  test('401 when not logged in', async () => {
    await repost(postId);
    expect((await unrepost(postId, null)).status).toBe(401);
    expect(await reposters(postId)).toEqual([alice.userId]);
  });
});

const bookmarkers = async (bookmarkedPostId) =>
  (await pool.query('SELECT user_id FROM bookmarks WHERE post_id = $1', [bookmarkedPostId])).rows.map(
    (row) => row.user_id,
  );

describe('POST /posts/:post_id/bookmark', () => {
  const bookmark = (id, as = cookie) => {
    const req = request(app).post(`/posts/${id}/bookmark`);
    if (as) req.set('Cookie', as);
    return req;
  };

  test('204, and the bookmark is stored for the logged-in user', async () => {
    const res = await bookmark(postId);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(await bookmarkers(postId)).toEqual([alice.userId]);
  });

  test('bookmarking again is still 204', async () => {
    await bookmark(postId);
    expect((await bookmark(postId)).status).toBe(204);
    expect(await bookmarkers(postId)).toEqual([alice.userId]);
  });

  test('your own post can be bookmarked', async () => {
    expect((await bookmark(postId, authCookie(bob.userId))).status).toBe(204);
  });

  test('404 for a deleted post', async () => {
    await postsStore.softDeletePost(postId, bob.userId);

    const res = await bookmark(postId);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Post not found' });
    expect(await bookmarkers(postId)).toEqual([]);
  });

  test('404 for an unknown post', async () => {
    const res = await bookmark(NO_ID);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Post not found' });
  });

  test('400 for a malformed id', async () => {
    const res = await bookmark('nope');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid post id' });
  });

  test('401 when not logged in', async () => {
    expect((await bookmark(postId, null)).status).toBe(401);
    expect(await bookmarkers(postId)).toEqual([]);
  });
});

describe('DELETE /posts/:post_id/bookmark', () => {
  const unbookmark = (id, as = cookie) => {
    const req = request(app).delete(`/posts/${id}/bookmark`);
    if (as) req.set('Cookie', as);
    return req;
  };
  const bookmark = (id, as = cookie) => request(app).post(`/posts/${id}/bookmark`).set('Cookie', as);

  test('204, and only your bookmark is removed', async () => {
    await bookmark(postId);
    await bookmark(postId, authCookie(bob.userId));

    const res = await unbookmark(postId);

    expect(res.status).toBe(204);
    expect(await bookmarkers(postId)).toEqual([bob.userId]);
  });

  test("204 even if you hadn't bookmarked it, or for an unknown post", async () => {
    expect((await unbookmark(postId)).status).toBe(204);
    expect((await unbookmark(NO_ID)).status).toBe(204);
  });

  test('204 on a post deleted after you bookmarked it, and the bookmark is gone', async () => {
    await bookmark(postId);
    await postsStore.softDeletePost(postId, bob.userId);

    expect((await unbookmark(postId)).status).toBe(204);
    expect(await bookmarkers(postId)).toEqual([]);
  });

  test('400 for a malformed id', async () => {
    const res = await unbookmark('nope');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid post id' });
  });

  test('401 when not logged in', async () => {
    await bookmark(postId);
    expect((await unbookmark(postId, null)).status).toBe(401);
    expect(await bookmarkers(postId)).toEqual([alice.userId]);
  });
});

// Pages through a list URL two at a time, sending nextCursor back exactly like a client.
async function pageThrough(url, as) {
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const req = request(app).get(`${url}?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
    const res = await (as ? req.set('Cookie', as) : req);
    expect(res.status).toBe(200);
    seen.push(...res.body.items.map((item) => item.postId));
    cursor = res.body.nextCursor;
    pages += 1;
  } while (cursor && pages < 20);
  return { seen, pages };
}

// Posts by bob, each liked or bookmarked by alice through the API `i` minutes ago; returned newest first.
async function engagedPosts(path, table, count) {
  const postIds = [];
  for (let i = 1; i <= count; i++) {
    const { postId: id } = await postsStore.createPost({ authorId: bob.userId, content: `post ${i}` });
    await request(app).post(`/posts/${id}/${path}`).set('Cookie', cookie);
    await pool.query(
      `UPDATE ${table} SET created_at = now() - make_interval(mins => $3) WHERE user_id = $1 AND post_id = $2`,
      [alice.userId, id, i],
    );
    postIds.push(id);
  }
  return postIds;
}

describe('GET /users/:username/likes', () => {
  const likes = (username, query = '') => request(app).get(`/users/${username}/likes${query}`);

  test('200 with the liked posts as post views with likedAt, newest like first; no login needed', async () => {
    const expected = await engagedPosts('like', 'likes', 2);

    const res = await likes(alice.username);

    expect(res.status).toBe(200);
    expect(res.body.items.map((item) => item.postId)).toEqual(expected);
    expect(res.body.items[0]).toEqual({
      postId: expected[0],
      author: { userId: bob.userId, username: bob.username, displayName: bob.displayName },
      content: 'post 1',
      parentPostId: null,
      rootPostId: null,
      quotedPostId: null,
      createdAt: expect.any(String),
      deleted: false,
      quotedPost: null,
      likedAt: expect.any(String),
    });
    expect(res.body.nextCursor).toBeNull();
  });

  test('pages with the cursor', async () => {
    const expected = await engagedPosts('like', 'likes', 5);
    const { seen, pages } = await pageThrough(`/users/${alice.username}/likes`);
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });

  test('deleted posts are left out', async () => {
    const [kept, gone] = await engagedPosts('like', 'likes', 2);
    await request(app).delete(`/posts/${gone}`).set('Cookie', authCookie(bob.userId));

    const res = await likes(alice.username);
    expect(res.body.items.map((item) => item.postId)).toEqual([kept]);
  });

  test('a user with no likes -> 200 with an empty page', async () => {
    const res = await likes(bob.username);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  test('404 for an unknown user', async () => {
    const res = await likes('nobody_here');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
  });

  test('400 for an invalid username or query', async () => {
    expect((await likes('no!')).status).toBe(400);
    expect((await likes(alice.username, '?limit=0')).status).toBe(400);
    const bookmarksCursor = encodeCursor({ bookmarkedAt: new Date().toISOString(), postId: NO_ID });
    expect((await likes(alice.username, `?cursor=${bookmarksCursor}`)).status).toBe(400);
  });
});

describe('GET /users/me/bookmarks', () => {
  const bookmarks = (as = cookie, query = '') => {
    const req = request(app).get(`/users/me/bookmarks${query}`);
    if (as) req.set('Cookie', as);
    return req;
  };

  test('200 with your bookmarked posts as post views with bookmarkedAt, newest bookmark first', async () => {
    const expected = await engagedPosts('bookmark', 'bookmarks', 2);

    const res = await bookmarks();

    expect(res.status).toBe(200);
    expect(res.body.items.map((item) => item.postId)).toEqual(expected);
    expect(res.body.items[0]).toMatchObject({ author: { userId: bob.userId }, bookmarkedAt: expect.any(String) });
    expect(res.body.nextCursor).toBeNull();
  });

  test('only ever your own bookmarks', async () => {
    await engagedPosts('bookmark', 'bookmarks', 2);
    expect((await bookmarks(authCookie(bob.userId))).body).toEqual({ items: [], nextCursor: null });
  });

  test('pages with the cursor', async () => {
    const expected = await engagedPosts('bookmark', 'bookmarks', 5);
    const { seen, pages } = await pageThrough('/users/me/bookmarks', cookie);
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });

  test('deleted posts are left out', async () => {
    const [kept, gone] = await engagedPosts('bookmark', 'bookmarks', 2);
    await request(app).delete(`/posts/${gone}`).set('Cookie', authCookie(bob.userId));

    const res = await bookmarks();
    expect(res.body.items.map((item) => item.postId)).toEqual([kept]);
  });

  test('400 for an invalid query', async () => {
    expect((await bookmarks(cookie, '?limit=101')).status).toBe(400);
    const likesCursor = encodeCursor({ likedAt: new Date().toISOString(), postId: NO_ID });
    expect((await bookmarks(cookie, `?cursor=${likesCursor}`)).status).toBe(400);
  });

  test('401 when not logged in', async () => {
    expect((await bookmarks(null)).status).toBe(401);
  });

  test("/users/me/likes is a 400, not someone's likes: 'me' is too short to be a username", async () => {
    const res = await request(app).get('/users/me/likes');
    expect(res.status).toBe(400);
  });
});
