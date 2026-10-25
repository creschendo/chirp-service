// HTTP tests for the follows routes. Requests go through the real app and pool; tables are emptied between tests.
import request from 'supertest';
import app from '../../src/app.js';
import { follow, isFollowing } from '../../src/modules/follows/store.js';
import { pool, resetDatabase } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';
import { authCookie } from '../helpers/auth.js';

afterEach(() => resetDatabase());
afterAll(() => pool.end());

describe('POST /users/me/following/:user_id', () => {
  const followUrl = (userId) => `/users/me/following/${userId}`;

  test('204 and creates the follow', async () => {
    const me = await createUser(pool);
    const them = await createUser(pool);
    const res = await request(app).post(followUrl(them.userId)).set('Cookie', authCookie(me.userId));
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(await isFollowing(me.userId, them.userId)).toBe(true);
  });

  test('following again is still 204 (idempotent)', async () => {
    const me = await createUser(pool);
    const them = await createUser(pool);
    const cookie = authCookie(me.userId);
    await request(app).post(followUrl(them.userId)).set('Cookie', cookie);
    const res = await request(app).post(followUrl(them.userId)).set('Cookie', cookie);
    expect(res.status).toBe(204);
  });

  test('400 when following yourself', async () => {
    const me = await createUser(pool);
    const res = await request(app).post(followUrl(me.userId)).set('Cookie', authCookie(me.userId));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Cannot follow yourself' });
  });

  test('400 for a malformed user id', async () => {
    const me = await createUser(pool);
    const res = await request(app).post(followUrl('not-a-uuid')).set('Cookie', authCookie(me.userId));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid user id');
  });

  test('404 when the user does not exist', async () => {
    const me = await createUser(pool);
    const res = await request(app)
      .post(followUrl('3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c'))
      .set('Cookie', authCookie(me.userId));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
  });

  test('401 without an access token', async () => {
    const them = await createUser(pool);
    const res = await request(app).post(followUrl(them.userId));
    expect(res.status).toBe(401);
  });
});

describe('DELETE /users/me/following/:user_id', () => {
  const followUrl = (userId) => `/users/me/following/${userId}`;

  test('204 and removes the follow', async () => {
    const me = await createUser(pool);
    const them = await createUser(pool);
    await follow(me.userId, them.userId);
    const res = await request(app).delete(followUrl(them.userId)).set('Cookie', authCookie(me.userId));
    expect(res.status).toBe(204);
    expect(await isFollowing(me.userId, them.userId)).toBe(false);
  });

  test('204 when not following (idempotent), including yourself', async () => {
    const me = await createUser(pool);
    const them = await createUser(pool);
    const cookie = authCookie(me.userId);
    expect((await request(app).delete(followUrl(them.userId)).set('Cookie', cookie)).status).toBe(204);
    expect((await request(app).delete(followUrl(me.userId)).set('Cookie', cookie)).status).toBe(204);
  });

  test('only removes your own follow, not theirs', async () => {
    const me = await createUser(pool);
    const them = await createUser(pool);
    await follow(me.userId, them.userId);
    await follow(them.userId, me.userId);
    await request(app).delete(followUrl(them.userId)).set('Cookie', authCookie(me.userId));
    expect(await isFollowing(them.userId, me.userId)).toBe(true);
  });

  test('400 for a malformed user id', async () => {
    const me = await createUser(pool);
    const res = await request(app).delete(followUrl('nope')).set('Cookie', authCookie(me.userId));
    expect(res.status).toBe(400);
  });

  test('401 without an access token', async () => {
    const them = await createUser(pool);
    const res = await request(app).delete(followUrl(them.userId));
    expect(res.status).toBe(401);
  });
});

describe.each([
  ['followers', (target, other) => follow(other.userId, target.userId)],
  ['following', (target, other) => follow(target.userId, other.userId)],
])('GET /users/:username/%s', (list, link) => {
  const url = (username, query = '') => `/users/${username}/${list}${query}`;

  // Creates `count` users linked to target, oldest link first; returns them newest first (the list's order).
  async function linkUsers(target, count) {
    const users = [];
    for (let i = 0; i < count; i++) {
      const other = await createUser(pool);
      await link(target, other);
      // Spread the timestamps so the expected order is unambiguous.
      await pool.query(
        `UPDATE follows SET created_at = now() - make_interval(mins => $1)
         WHERE follower_id = ANY($2) AND followed_id = ANY($2)`,
        [count - i, [target.userId, other.userId]],
      );
      users.push(other);
    }
    return users.reverse();
  }

  test('200 with { items, nextCursor }, most recent first, public fields only', async () => {
    const target = await createUser(pool);
    const [newer, older] = await linkUsers(target, 2);
    const res = await request(app).get(url(target.username));
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items.map((i) => i.userId)).toEqual([newer.userId, older.userId]);
    expect(res.body.items[0]).toEqual({
      userId: newer.userId,
      username: newer.username,
      displayName: newer.displayName,
      followedAt: expect.any(String),
    });
  });

  test('works with a differently cased username', async () => {
    const target = await createUser(pool, { username: 'Case_Target' });
    await linkUsers(target, 1);
    const res = await request(app).get(url('case_target'));
    expect(res.body.items).toHaveLength(1);
  });

  test('empty list -> 200 with no items', async () => {
    const target = await createUser(pool);
    const res = await request(app).get(url(target.username));
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  test('pages through everything with nextCursor, without skipping or repeating', async () => {
    const target = await createUser(pool);
    const expected = (await linkUsers(target, 5)).map((u) => u.userId);

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const query = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const res = await request(app).get(url(target.username, query));
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((i) => i.userId));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(seen).toEqual(expected);
    expect(pages).toBe(3); // 2 + 2 + 1, and the last page says there is no next one
  });

  test('exactly limit items -> nextCursor is null (no empty extra page)', async () => {
    const target = await createUser(pool);
    await linkUsers(target, 2);
    const res = await request(app).get(url(target.username, '?limit=2'));
    expect(res.body.items).toHaveLength(2);
    expect(res.body.nextCursor).toBeNull();
  });

  test('defaults to 20 items', async () => {
    const target = await createUser(pool);
    await linkUsers(target, 21);
    const res = await request(app).get(url(target.username));
    expect(res.body.items).toHaveLength(20);
    expect(res.body.nextCursor).not.toBeNull();
  });

  test('404 for an unknown username', async () => {
    const res = await request(app).get(url('nobody_here'));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
  });

  test.each([
    ['invalid username', 'a!', ''],
    ['limit 0', 'valid_user', '?limit=0'],
    ['limit over 100', 'valid_user', '?limit=101'],
    ['non-numeric limit', 'valid_user', '?limit=abc'],
    ['garbage cursor', 'valid_user', '?cursor=not-a-cursor'],
    ['cursor with wrong contents', 'valid_user', `?cursor=${Buffer.from('{"x":1}').toString('base64url')}`],
  ])('400 for %s', async (_, username, query) => {
    await createUser(pool, { username: 'valid_user' });
    const res = await request(app).get(url(username, query));
    expect(res.status).toBe(400);
  });
});
