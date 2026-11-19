// Follows service against the test database: the follow/unfollow rules and the notifications they create. Services use
// the pool (no transaction client), so data is committed and tables are emptied between tests, like the API tests.
import * as service from '../../src/modules/follows/service.js';
import { isFollowing } from '../../src/modules/follows/store.js';
import { pool, resetDatabase } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';

afterEach(() => resetDatabase());
afterAll(() => pool.end());

const NO_ID = '00000000-0000-0000-0000-000000000000';

let alice;
let bob;
beforeEach(async () => {
  alice = await createUser(pool);
  bob = await createUser(pool);
});

// All notifications as [type, actorId, recipientId, postId].
const allNotifications = async () =>
  (await pool.query('SELECT type, actor_id, recipient_id, post_id FROM notifications ORDER BY created_at')).rows.map(
    (row) => [row.type, row.actor_id, row.recipient_id, row.post_id],
  );

describe('follow', () => {
  test('returns true, creates the follow and notifies the followed user', async () => {
    expect(await service.follow(alice.userId, bob.userId)).toBe(true);
    expect(await isFollowing(alice.userId, bob.userId)).toBe(true);
    expect(await allNotifications()).toEqual([['follow', alice.userId, bob.userId, null]]);
  });

  test('following again returns false and notifies once', async () => {
    await service.follow(alice.userId, bob.userId);
    expect(await service.follow(alice.userId, bob.userId)).toBe(false);
    expect(await allNotifications()).toHaveLength(1);
  });

  test('yourself -> 400, nothing created', async () => {
    await expect(service.follow(alice.userId, alice.userId)).rejects.toMatchObject({ status: 400 });
    expect(await allNotifications()).toEqual([]);
  });

  test('an unknown user -> 404, nothing created', async () => {
    await expect(service.follow(alice.userId, NO_ID)).rejects.toMatchObject({ status: 404, message: 'User not found' });
    expect(await allNotifications()).toEqual([]);
  });

  test('concurrent follows notify once', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => service.follow(alice.userId, bob.userId)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await allNotifications()).toHaveLength(1);
  });

  test('following each other notifies each of you', async () => {
    await service.follow(alice.userId, bob.userId);
    await service.follow(bob.userId, alice.userId);
    expect(await allNotifications()).toEqual(
      expect.arrayContaining([
        ['follow', alice.userId, bob.userId, null],
        ['follow', bob.userId, alice.userId, null],
      ]),
    );
  });
});

describe('unfollow', () => {
  test('returns true, removes the follow and its notification', async () => {
    await service.follow(alice.userId, bob.userId);
    expect(await service.unfollow(alice.userId, bob.userId)).toBe(true);
    expect(await isFollowing(alice.userId, bob.userId)).toBe(false);
    expect(await allNotifications()).toEqual([]);
  });

  test("only removes that follow's notification", async () => {
    const carol = await createUser(pool);
    await service.follow(alice.userId, bob.userId);
    await service.follow(carol.userId, bob.userId);
    await service.follow(alice.userId, carol.userId);
    await service.unfollow(alice.userId, bob.userId);
    expect(await allNotifications()).toEqual(
      expect.arrayContaining([
        ['follow', carol.userId, bob.userId, null],
        ['follow', alice.userId, carol.userId, null],
      ]),
    );
    expect(await allNotifications()).toHaveLength(2);
  });

  test('following again after unfollowing notifies again', async () => {
    await service.follow(alice.userId, bob.userId);
    await service.unfollow(alice.userId, bob.userId);
    await service.follow(alice.userId, bob.userId);
    expect(await allNotifications()).toEqual([['follow', alice.userId, bob.userId, null]]);
  });

  test("returns false when you weren't following, including yourself", async () => {
    expect(await service.unfollow(alice.userId, bob.userId)).toBe(false);
    expect(await service.unfollow(alice.userId, alice.userId)).toBe(false);
  });
});
