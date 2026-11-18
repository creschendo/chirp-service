// HTTP tests for the notifications routes. Requests go through the real app and pool; tables are emptied between tests.
// Liking, following etc. don't create notifications yet (not wired), so tests create them with the service directly.
import request from 'supertest';
import app from '../../src/app.js';
import * as notificationsService from '../../src/modules/notifications/service.js';
import * as postsStore from '../../src/modules/posts/store.js';
import { pool, resetDatabase } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';
import { authCookie } from '../helpers/auth.js';

afterEach(() => resetDatabase());
afterAll(() => pool.end());

let alice;
let bob;
let carol;
let cookie;
let postId;
beforeEach(async () => {
  alice = await createUser(pool);
  bob = await createUser(pool);
  carol = await createUser(pool);
  cookie = authCookie(bob.userId);
  ({ postId } = await postsStore.createPost({ authorId: bob.userId, content: 'hello' }));
});

// A notification for Bob, backdated `minutesAgo` minutes so the order is unambiguous. Returns it as the API would
// send it (createdAt as an ISO string).
async function notifyBob(minutesAgo, fields) {
  const n = await notificationsService.notify({ recipientId: bob.userId, ...fields });
  const { rows } = await pool.query(
    `UPDATE notifications SET created_at = now() - make_interval(mins => $2) WHERE notification_id = $1
     RETURNING created_at`,
    [n.notificationId, minutesAgo],
  );
  return { ...n, createdAt: rows[0].created_at.toISOString() };
}
const followedBy = (actor, minutesAgo) => notifyBob(minutesAgo, { type: 'follow', actorId: actor.userId });
const likedBy = (actor, minutesAgo) => notifyBob(minutesAgo, { type: 'like', actorId: actor.userId, postId });

const get = (path, as = cookie) => {
  const req = request(app).get(path);
  return as ? req.set('Cookie', as) : req;
};
const markRead = (body, as = cookie) => {
  const req = request(app).put('/notifications/read');
  if (as) req.set('Cookie', as);
  return req.send(body);
};

describe('GET /notifications', () => {
  test('200 with { items, nextCursor }, newest first', async () => {
    const liked = await likedBy(alice, 2);
    const followed = await followedBy(carol, 1);

    const res = await get('/notifications');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [
        {
          notificationId: followed.notificationId,
          type: 'follow',
          actor: { userId: carol.userId, username: carol.username, displayName: carol.displayName },
          post: null,
          createdAt: followed.createdAt,
          read: false,
        },
        {
          notificationId: liked.notificationId,
          type: 'like',
          actor: { userId: alice.userId, username: alice.username, displayName: alice.displayName },
          post: expect.objectContaining({
            postId,
            content: 'hello',
            author: expect.objectContaining({ userId: bob.userId }),
          }),
          createdAt: liked.createdAt,
          read: false,
        },
      ],
      nextCursor: null,
    });
  });

  test('pages through everything with nextCursor, without skipping or repeating', async () => {
    const dave = await createUser(pool);
    const expected = [];
    for (const [i, actor] of [alice, carol, dave].entries()) {
      expected.push((await followedBy(actor, i + 1)).notificationId);
    }

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const res = await get(cursor ? `/notifications?limit=2&cursor=${cursor}` : '/notifications?limit=2');
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((n) => n.notificationId));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual(expected);
    expect(pages).toBe(2);
  });

  test("only the logged-in user's notifications", async () => {
    await likedBy(alice, 1);
    expect((await get('/notifications', authCookie(alice.userId))).body).toEqual({ items: [], nextCursor: null });
  });

  test('a notification about a deleted post is left out', async () => {
    await likedBy(alice, 1);
    await request(app).delete(`/posts/${postId}`).set('Cookie', cookie);
    expect((await get('/notifications')).body.items).toEqual([]);
  });

  test.each([
    ['limit 0', '?limit=0'],
    ['limit over 100', '?limit=101'],
    ['garbage cursor', '?cursor=not-a-cursor'],
  ])('400 for %s', async (_, query) => {
    expect((await get(`/notifications${query}`)).status).toBe(400);
  });

  test('401 without an access token', async () => {
    expect((await get('/notifications', null)).status).toBe(401);
  });
});

describe('GET /notifications/unread-count', () => {
  test('200 with { count }', async () => {
    expect((await get('/notifications/unread-count')).body).toEqual({ count: 0 });
    await likedBy(alice, 2);
    await followedBy(carol, 1);
    const res = await get('/notifications/unread-count');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 2 });
  });

  test('401 without an access token', async () => {
    expect((await get('/notifications/unread-count', null)).status).toBe(401);
  });
});

describe('PUT /notifications/read', () => {
  test('204; everything up to upTo is read, newer ones stay unread', async () => {
    const older = await likedBy(alice, 2);
    await followedBy(carol, 1);

    const res = await markRead({ upTo: older.createdAt });
    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    expect((await get('/notifications/unread-count')).body).toEqual({ count: 1 });
    expect((await get('/notifications')).body.items.map((n) => n.read)).toEqual([false, true]);
  });

  test('marking with the newest item clears the badge; an older upTo afterwards changes nothing', async () => {
    const older = await likedBy(alice, 2);
    const newer = await followedBy(carol, 1);
    expect((await markRead({ upTo: newer.createdAt })).status).toBe(204);
    expect((await markRead({ upTo: older.createdAt })).status).toBe(204);
    expect((await get('/notifications/unread-count')).body).toEqual({ count: 0 });
  });

  test("only changes the logged-in user's read state", async () => {
    await notificationsService.notify({ type: 'follow', actorId: bob.userId, recipientId: alice.userId });
    await markRead({ upTo: new Date().toISOString() });
    expect((await get('/notifications/unread-count', authCookie(alice.userId))).body).toEqual({ count: 1 });
  });

  test.each([
    ['no body', undefined],
    ['an empty body', {}],
    ['a non-ISO time', { upTo: 'yesterday' }],
    ['an unknown key', { upTo: new Date().toISOString(), all: true }],
  ])('400 for %s', async (_, body) => {
    expect((await markRead(body)).status).toBe(400);
  });

  test('401 without an access token', async () => {
    expect((await markRead({ upTo: new Date().toISOString() }, null)).status).toBe(401);
  });
});
