// Auth store (sessions table) against the test database. Each test runs in a rolled-back transaction.
import * as store from '../../src/modules/auth/store.js';
import { deleteUser } from '../../src/modules/users/store.js';
import { useTransaction, pgErrorCode } from '../helpers/db.js';
import { createUser, createSession, daysFromNow } from '../helpers/factories.js';

const ctx = useTransaction();
const NO_ID = '00000000-0000-0000-0000-000000000000';

let user;
beforeEach(async () => {
  user = await createUser(ctx.db);
});

describe('createSession', () => {
  test('returns { sessionId }', async () => {
    const session = await createSession(ctx.db, user.userId);
    expect(session).toEqual({ sessionId: expect.any(String) });
  });

  test('duplicate token hash -> 23505', async () => {
    await createSession(ctx.db, user.userId, { refreshTokenHash: 'dup' });
    expect(await pgErrorCode(ctx.db, () => createSession(ctx.db, user.userId, { refreshTokenHash: 'dup' }))).toBe(
      '23505',
    );
  });

  test('expiry in the past -> 23514', async () => {
    expect(await pgErrorCode(ctx.db, () => createSession(ctx.db, user.userId, { expiresAt: daysFromNow(-1) }))).toBe(
      '23514',
    );
  });

  test('unknown user -> 23503', async () => {
    expect(await pgErrorCode(ctx.db, () => createSession(ctx.db, NO_ID))).toBe('23503');
  });
});

describe('getSessionByTokenHash', () => {
  test('returns every state field', async () => {
    const { sessionId } = await createSession(ctx.db, user.userId, { refreshTokenHash: 'h1' });
    expect(await store.getSessionByTokenHash('h1', ctx.db)).toEqual({
      sessionId,
      userId: user.userId,
      expiresAt: expect.any(Date),
      revokedAt: null,
      replacedBySessionId: null,
    });
  });

  test('unknown hash -> null', async () => {
    expect(await store.getSessionByTokenHash('nope', ctx.db)).toBeNull();
  });
});

describe('markSessionReplaced', () => {
  test('first rotation wins and records the replacement', async () => {
    const old = await createSession(ctx.db, user.userId, { refreshTokenHash: 'old' });
    const next = await createSession(ctx.db, user.userId);
    expect(await store.markSessionReplaced(old.sessionId, next.sessionId, ctx.db)).toBe(true);
    expect((await store.getSessionByTokenHash('old', ctx.db)).replacedBySessionId).toBe(next.sessionId);
  });

  test('second rotation of the same session (reuse or race) -> false, link unchanged', async () => {
    const old = await createSession(ctx.db, user.userId, { refreshTokenHash: 'old' });
    const first = await createSession(ctx.db, user.userId);
    const second = await createSession(ctx.db, user.userId);
    await store.markSessionReplaced(old.sessionId, first.sessionId, ctx.db);
    expect(await store.markSessionReplaced(old.sessionId, second.sessionId, ctx.db)).toBe(false);
    expect((await store.getSessionByTokenHash('old', ctx.db)).replacedBySessionId).toBe(first.sessionId);
  });

  test('revoked session -> false', async () => {
    const old = await createSession(ctx.db, user.userId);
    const next = await createSession(ctx.db, user.userId);
    await store.revokeSession(old.sessionId, ctx.db);
    expect(await store.markSessionReplaced(old.sessionId, next.sessionId, ctx.db)).toBe(false);
  });
});

describe('revokeSession', () => {
  test('sets revokedAt; second call -> false', async () => {
    const { sessionId } = await createSession(ctx.db, user.userId, { refreshTokenHash: 'r' });
    expect(await store.revokeSession(sessionId, ctx.db)).toBe(true);
    expect((await store.getSessionByTokenHash('r', ctx.db)).revokedAt).toEqual(expect.any(Date));
    expect(await store.revokeSession(sessionId, ctx.db)).toBe(false);
  });

  test('unknown session -> false', async () => {
    expect(await store.revokeSession(NO_ID, ctx.db)).toBe(false);
  });
});

describe('revokeAllUserSessions', () => {
  test('revokes every active session of the user, and only that user', async () => {
    const other = await createUser(ctx.db);
    await createSession(ctx.db, user.userId);
    await createSession(ctx.db, user.userId);
    await createSession(ctx.db, other.userId, { refreshTokenHash: 'other' });
    expect(await store.revokeAllUserSessions(user.userId, {}, ctx.db)).toBe(2);
    expect((await store.getSessionByTokenHash('other', ctx.db)).revokedAt).toBeNull();
    expect(await store.revokeAllUserSessions(user.userId, {}, ctx.db)).toBe(0);
  });

  test('exceptSessionId keeps the current session', async () => {
    const current = await createSession(ctx.db, user.userId, { refreshTokenHash: 'current' });
    await createSession(ctx.db, user.userId);
    expect(await store.revokeAllUserSessions(user.userId, { exceptSessionId: current.sessionId }, ctx.db)).toBe(1);
    expect((await store.getSessionByTokenHash('current', ctx.db)).revokedAt).toBeNull();
  });
});

describe('deleteExpiredSessions', () => {
  test('deletes only expired sessions and nulls links that pointed at them', async () => {
    const old = await createSession(ctx.db, user.userId, { refreshTokenHash: 'old' });
    const expired = await createSession(ctx.db, user.userId);
    await createSession(ctx.db, user.userId, { refreshTokenHash: 'live' });
    await store.markSessionReplaced(old.sessionId, expired.sessionId, ctx.db);
    // Move both timestamps back so the expires_after_created check still holds.
    await ctx.db.query(
      `UPDATE sessions SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
       WHERE session_id = $1`,
      [expired.sessionId],
    );

    expect(await store.deleteExpiredSessions(ctx.db)).toBe(1);
    expect(await store.getSessionByTokenHash('live', ctx.db)).not.toBeNull();
    expect((await store.getSessionByTokenHash('old', ctx.db)).replacedBySessionId).toBeNull();
    expect(await store.deleteExpiredSessions(ctx.db)).toBe(0);
  });
});

test('deleting a user deletes their sessions', async () => {
  await createSession(ctx.db, user.userId, { refreshTokenHash: 'gone' });
  await deleteUser(user.userId, ctx.db);
  expect(await store.getSessionByTokenHash('gone', ctx.db)).toBeNull();
});
