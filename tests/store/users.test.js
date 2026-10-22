// Users store against the test database. Each test runs in a rolled-back transaction (see helpers/db.js).
import * as store from '../../src/modules/users/store.js';
import { useTransaction, pgErrorCode } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';

const ctx = useTransaction();
const NO_USER = '00000000-0000-0000-0000-000000000000';

describe('createUser', () => {
  test('returns the account shape without the password hash', async () => {
    const user = await store.createUser(
      { username: 'Alice_1', email: 'Alice@Example.com', passwordHash: 'h', displayName: 'Alice' },
      ctx.db,
    );
    expect(user).toEqual({
      userId: expect.any(String),
      username: 'Alice_1',
      email: 'Alice@Example.com',
      displayName: 'Alice',
      bio: null,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  test('stores bio when given', async () => {
    const user = await createUser(ctx.db, { bio: 'hello' });
    expect(user.bio).toBe('hello');
  });

  test('duplicate username, ignoring case -> 23505', async () => {
    await createUser(ctx.db, { username: 'taken_name' });
    expect(await pgErrorCode(ctx.db, () => createUser(ctx.db, { username: 'TAKEN_NAME' }))).toBe('23505');
  });

  test('duplicate email, ignoring case -> 23505', async () => {
    await createUser(ctx.db, { email: 'same@example.com' });
    expect(await pgErrorCode(ctx.db, () => createUser(ctx.db, { email: 'SAME@example.com' }))).toBe('23505');
  });

  test.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(16)],
    ['invalid character', 'bad-name'],
  ])('username %s -> 23514', async (_, username) => {
    expect(await pgErrorCode(ctx.db, () => createUser(ctx.db, { username }))).toBe('23514');
  });

  test('missing displayName -> 23502', async () => {
    expect(await pgErrorCode(ctx.db, () => createUser(ctx.db, { displayName: undefined }))).toBe('23502');
  });

  test.each([
    ['empty displayName', { displayName: '' }],
    ['displayName over 50', { displayName: 'x'.repeat(51) }],
    ['bio over 160', { bio: 'x'.repeat(161) }],
  ])('%s -> 23514', async (_, overrides) => {
    expect(await pgErrorCode(ctx.db, () => createUser(ctx.db, overrides))).toBe('23514');
  });
});

describe('getCredentialsByLogin', () => {
  test('matches username or email, ignoring case, and returns the hash', async () => {
    const user = await createUser(ctx.db, { username: 'cred_user', passwordHash: 'the-hash' });
    const expected = { userId: user.userId, username: 'cred_user', passwordHash: 'the-hash' };
    expect(await store.getCredentialsByLogin('CRED_USER', ctx.db)).toEqual(expected);
    expect(await store.getCredentialsByLogin('Cred_User@Example.com', ctx.db)).toEqual(expected);
  });

  test('unknown login -> null', async () => {
    expect(await store.getCredentialsByLogin('nobody_here', ctx.db)).toBeNull();
  });
});

describe('account lookups', () => {
  test('getUserById returns profile fields plus email, never the hash', async () => {
    const user = await createUser(ctx.db);
    const found = await store.getUserById(user.userId, ctx.db);
    expect(found).toEqual(user);
    expect(found).not.toHaveProperty('passwordHash');
  });

  test('getUserById unknown id -> null', async () => {
    expect(await store.getUserById(NO_USER, ctx.db)).toBeNull();
  });

  test('getUserById malformed uuid -> 22P02 (validate ids before calling)', async () => {
    expect(await pgErrorCode(ctx.db, () => store.getUserById('not-a-uuid', ctx.db))).toBe('22P02');
  });

  test('getUserByUsername and getUserByEmail ignore case', async () => {
    const user = await createUser(ctx.db, { username: 'Mixed_Case' });
    expect((await store.getUserByUsername('mixed_case', ctx.db))?.userId).toBe(user.userId);
    expect((await store.getUserByEmail('MIXED_CASE@EXAMPLE.COM', ctx.db))?.userId).toBe(user.userId);
  });
});

describe('getProfileByUsername', () => {
  test('returns public fields only', async () => {
    const user = await createUser(ctx.db, { username: 'Public_User', bio: 'hi' });
    const profile = await store.getProfileByUsername('public_user', ctx.db);
    expect(profile).toEqual({
      userId: user.userId,
      username: 'Public_User',
      displayName: user.displayName,
      bio: 'hi',
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  test('unknown username -> null', async () => {
    expect(await store.getProfileByUsername('nobody_here', ctx.db)).toBeNull();
  });
});

describe('updateUser', () => {
  test('updates only allowed keys and ignores unknown ones', async () => {
    const user = await createUser(ctx.db);
    const updated = await store.updateUser(
      user.userId,
      { displayName: 'New Name', bogus: 'x', user_id: NO_USER },
      ctx.db,
    );
    expect(updated.userId).toBe(user.userId);
    expect(updated.displayName).toBe('New Name');
    expect(updated.email).toBe(user.email);
  });

  test('passwordHash writes password_hash', async () => {
    const user = await createUser(ctx.db);
    await store.updateUser(user.userId, { passwordHash: 'new-hash' }, ctx.db);
    expect((await store.getCredentialsByLogin(user.username, ctx.db)).passwordHash).toBe('new-hash');
  });

  test('bumps updated_at', async () => {
    const user = await createUser(ctx.db);
    await ctx.db.query(`UPDATE users SET updated_at = now() - interval '1 day' WHERE user_id = $1`, [user.userId]);
    const updated = await store.updateUser(user.userId, { bio: 'changed' }, ctx.db);
    expect(Date.now() - updated.updatedAt.getTime()).toBeLessThan(60_000);
  });

  test('bio: null clears bio and keeps other fields', async () => {
    const user = await createUser(ctx.db, { bio: 'old' });
    const updated = await store.updateUser(user.userId, { bio: null }, ctx.db);
    expect(updated.bio).toBeNull();
    expect(updated.displayName).toBe(user.displayName);
  });

  test('unknown id -> null', async () => {
    expect(await store.updateUser(NO_USER, { bio: 'x' }, ctx.db)).toBeNull();
  });

  test('no updatable fields -> throws', async () => {
    const user = await createUser(ctx.db);
    await expect(store.updateUser(user.userId, { bogus: 1 }, ctx.db)).rejects.toThrow(
      'updateUser called with no updatable fields',
    );
  });

  test('duplicate email -> 23505', async () => {
    const a = await createUser(ctx.db);
    const b = await createUser(ctx.db);
    expect(await pgErrorCode(ctx.db, () => store.updateUser(b.userId, { email: a.email.toUpperCase() }, ctx.db))).toBe(
      '23505',
    );
  });

  test('undefined value -> 23502 (service must strip undefined)', async () => {
    const user = await createUser(ctx.db);
    expect(await pgErrorCode(ctx.db, () => store.updateUser(user.userId, { displayName: undefined }, ctx.db))).toBe(
      '23502',
    );
  });
});

describe('deleteUser', () => {
  test('returns true, then false once gone', async () => {
    const user = await createUser(ctx.db);
    expect(await store.deleteUser(user.userId, ctx.db)).toBe(true);
    expect(await store.getUserById(user.userId, ctx.db)).toBeNull();
    expect(await store.deleteUser(user.userId, ctx.db)).toBe(false);
  });

  test('cascades to follows', async () => {
    const a = await createUser(ctx.db);
    const b = await createUser(ctx.db);
    await ctx.db.query('INSERT INTO follows (follower_id, followed_id) VALUES ($1, $2)', [a.userId, b.userId]);
    await store.deleteUser(a.userId, ctx.db);
    const { rowCount } = await ctx.db.query('SELECT 1 FROM follows WHERE follower_id = $1', [a.userId]);
    expect(rowCount).toBe(0);
  });
});

describe('searchUsers', () => {
  beforeEach(async () => {
    await createUser(ctx.db, { username: 'srch_a_b' });
    await createUser(ctx.db, { username: 'Srch_Alice' });
    await createUser(ctx.db, { username: 'srch_axb' });
  });
  const names = (rows) => rows.map((r) => r.username);

  test('matches substrings, ignoring case, ordered by username, public fields only', async () => {
    const rows = await store.searchUsers('SRCH_', 10, null, ctx.db);
    expect(names(rows)).toEqual(['srch_a_b', 'Srch_Alice', 'srch_axb']);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['displayName', 'userId', 'username']);
    }
  });

  test('"_" and "%" match literally', async () => {
    expect(names(await store.searchUsers('a_b', 10, null, ctx.db))).toEqual(['srch_a_b']);
    expect(await store.searchUsers('%', 10, null, ctx.db)).toEqual([]);
  });

  test('cursor returns the next page', async () => {
    const page1 = await store.searchUsers('srch_', 2, null, ctx.db);
    const page2 = await store.searchUsers('srch_', 2, page1.at(-1).username, ctx.db);
    expect(names(page1)).toEqual(['srch_a_b', 'Srch_Alice']);
    expect(names(page2)).toEqual(['srch_axb']);
  });
});
