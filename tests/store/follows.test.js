// Follows store against the test database. Each test runs in a rolled-back transaction (see helpers/db.js).
import * as store from '../../src/modules/follows/store.js';
import { useTransaction, pgErrorCode } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';

const ctx = useTransaction();
const NO_USER = '00000000-0000-0000-0000-000000000000';

// now() is fixed for the whole transaction, so every follow in a test gets the same created_at.
// Tests that care about order set the timestamp explicitly.
async function followAt(followerId, followedId, minutesAgo) {
  await ctx.db.query(
    `INSERT INTO follows (follower_id, followed_id, created_at)
     VALUES ($1, $2, now() - make_interval(mins => $3))`,
    [followerId, followedId, minutesAgo],
  );
}

let alice;
let bob;
beforeEach(async () => {
  alice = await createUser(ctx.db, { username: 'alice' });
  bob = await createUser(ctx.db, { username: 'bob' });
});

describe('follow', () => {
  test('creates a follow and returns true', async () => {
    expect(await store.follow(alice.userId, bob.userId, ctx.db)).toBe(true);
    expect(await store.isFollowing(alice.userId, bob.userId, ctx.db)).toBe(true);
  });

  test('following again is a no-op and returns false', async () => {
    await store.follow(alice.userId, bob.userId, ctx.db);
    expect(await store.follow(alice.userId, bob.userId, ctx.db)).toBe(false);
    expect(await store.countFollows(bob.userId, ctx.db)).toEqual({ followers: 1, following: 0 });
  });

  test('following yourself -> 23514 (follows_no_self_follow)', async () => {
    expect(await pgErrorCode(ctx.db, () => store.follow(alice.userId, alice.userId, ctx.db))).toBe('23514');
  });

  test('following an unknown user -> 23503', async () => {
    expect(await pgErrorCode(ctx.db, () => store.follow(alice.userId, NO_USER, ctx.db))).toBe('23503');
  });
});

describe('unfollow', () => {
  test('removes the follow and returns true', async () => {
    await store.follow(alice.userId, bob.userId, ctx.db);
    expect(await store.unfollow(alice.userId, bob.userId, ctx.db)).toBe(true);
    expect(await store.isFollowing(alice.userId, bob.userId, ctx.db)).toBe(false);
  });

  test('unfollowing when not following returns false', async () => {
    expect(await store.unfollow(alice.userId, bob.userId, ctx.db)).toBe(false);
  });

  test('only removes that direction (A unfollows B leaves B -> A intact)', async () => {
    await store.follow(alice.userId, bob.userId, ctx.db);
    await store.follow(bob.userId, alice.userId, ctx.db);
    await store.unfollow(alice.userId, bob.userId, ctx.db);
    expect(await store.isFollowing(bob.userId, alice.userId, ctx.db)).toBe(true);
  });
});

describe('listFollowers / listFollowing', () => {
  test('listFollowers returns users who follow userId, with { userId, username, displayName, followedAt }', async () => {
    await store.follow(alice.userId, bob.userId, ctx.db);
    expect(await store.listFollowers(bob.userId, { limit: 10 }, ctx.db)).toEqual([
      {
        userId: alice.userId,
        username: 'alice',
        displayName: alice.displayName,
        followedAt: expect.any(Date),
      },
    ]);
  });

  test('listFollowing returns users that userId follows', async () => {
    await store.follow(alice.userId, bob.userId, ctx.db);
    const rows = await store.listFollowing(alice.userId, { limit: 10 }, ctx.db);
    expect(rows.map((r) => r.userId)).toEqual([bob.userId]);
    expect(await store.listFollowing(bob.userId, { limit: 10 }, ctx.db)).toEqual([]);
  });

  test('most recent follow first', async () => {
    const carol = await createUser(ctx.db, { username: 'carol' });
    await followAt(alice.userId, carol.userId, 30);
    await followAt(bob.userId, carol.userId, 10);
    const rows = await store.listFollowers(carol.userId, { limit: 10 }, ctx.db);
    expect(rows.map((r) => r.userId)).toEqual([bob.userId, alice.userId]);
  });

  test('cursor returns the next page without skipping or repeating rows', async () => {
    const target = await createUser(ctx.db);
    const followers = [];
    for (let i = 0; i < 5; i++) {
      const f = await createUser(ctx.db);
      await followAt(f.userId, target.userId, i); // followers[0] is the most recent
      followers.push(f.userId);
    }

    const seen = [];
    let cursor = null;
    for (let page = 0; page < 3; page++) {
      const rows = await store.listFollowers(target.userId, { limit: 2, cursor }, ctx.db);
      seen.push(...rows.map((r) => r.userId));
      if (rows.length === 0) break;
      const last = rows.at(-1);
      cursor = { followedAt: last.followedAt, userId: last.userId };
    }
    expect(seen).toEqual(followers);
  });

  test('follows with identical created_at are split across pages correctly (user_id tie-break)', async () => {
    const target = await createUser(ctx.db);
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const f = await createUser(ctx.db);
      await followAt(f.userId, target.userId, 5); // all at the same instant
      ids.push(f.userId);
    }

    const page1 = await store.listFollowers(target.userId, { limit: 2 }, ctx.db);
    const last = page1.at(-1);
    const page2 = await store.listFollowers(
      target.userId,
      { limit: 2, cursor: { followedAt: last.followedAt, userId: last.userId } },
      ctx.db,
    );
    const seen = [...page1, ...page2].map((r) => r.userId);
    expect(new Set(seen).size).toBe(4);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  test('user with no follows -> []', async () => {
    expect(await store.listFollowers(alice.userId, { limit: 10 }, ctx.db)).toEqual([]);
    expect(await store.listFollowing(alice.userId, { limit: 10 }, ctx.db)).toEqual([]);
  });

  test('never includes email or password hash', async () => {
    await store.follow(alice.userId, bob.userId, ctx.db);
    const rows = [
      ...(await store.listFollowers(bob.userId, { limit: 10 }, ctx.db)),
      ...(await store.listFollowing(alice.userId, { limit: 10 }, ctx.db)),
    ];
    for (const row of rows) {
      expect(row).not.toHaveProperty('email');
      expect(row).not.toHaveProperty('passwordHash');
      expect(row).not.toHaveProperty('password_hash');
    }
  });
});

describe('isFollowing', () => {
  test('true when following, false otherwise; direction matters', async () => {
    await store.follow(alice.userId, bob.userId, ctx.db);
    expect(await store.isFollowing(alice.userId, bob.userId, ctx.db)).toBe(true);
    expect(await store.isFollowing(bob.userId, alice.userId, ctx.db)).toBe(false);
  });
});

describe('countFollows', () => {
  test('returns { followers, following } as numbers, not strings', async () => {
    const carol = await createUser(ctx.db);
    await store.follow(alice.userId, bob.userId, ctx.db);
    await store.follow(carol.userId, bob.userId, ctx.db);
    await store.follow(bob.userId, alice.userId, ctx.db);
    expect(await store.countFollows(bob.userId, ctx.db)).toEqual({ followers: 2, following: 1 });
  });

  test('0 / 0 for a user with no follows', async () => {
    expect(await store.countFollows(alice.userId, ctx.db)).toEqual({ followers: 0, following: 0 });
  });
});

test('deleting a user removes their follows in both directions', async () => {
  await store.follow(alice.userId, bob.userId, ctx.db);
  await store.follow(bob.userId, alice.userId, ctx.db);
  await ctx.db.query('DELETE FROM users WHERE user_id = $1', [alice.userId]);
  expect(await store.countFollows(bob.userId, ctx.db)).toEqual({ followers: 0, following: 0 });
});
