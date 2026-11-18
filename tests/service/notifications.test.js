// Notifications service against the test database. Services use the pool unless given a transaction client, so data
// is committed and tables are emptied between tests, like the API tests.
import * as service from '../../src/modules/notifications/service.js';
import * as postsStore from '../../src/modules/posts/store.js';
import { withTransaction } from '../../src/db/index.js';
import { decodeCursor } from '../../src/pagination.js';
import { pool, resetDatabase } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';

afterEach(() => resetDatabase());
afterAll(() => pool.end());

let alice;
let bob;
let postId;
beforeEach(async () => {
  alice = await createUser(pool);
  bob = await createUser(pool);
  ({ postId } = await postsStore.createPost({ authorId: bob.userId, content: 'hello' }));
});

const notificationCount = async () => (await pool.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n;

describe('notify', () => {
  test('creates and returns the notification', async () => {
    const n = await service.notify({ type: 'like', actorId: alice.userId, recipientId: bob.userId, postId });
    expect(n).toMatchObject({ type: 'like', actorId: alice.userId, recipientId: bob.userId, postId });
    expect(await notificationCount()).toBe(1);
  });

  test('a follow needs no postId', async () => {
    const n = await service.notify({ type: 'follow', actorId: alice.userId, recipientId: bob.userId });
    expect(n).toMatchObject({ type: 'follow', postId: null });
  });

  test('never notifies yourself: returns null and stores nothing', async () => {
    expect(await service.notify({ type: 'like', actorId: bob.userId, recipientId: bob.userId, postId })).toBeNull();
    expect(await notificationCount()).toBe(0);
  });

  test('the same action twice returns null the second time', async () => {
    const fields = { type: 'like', actorId: alice.userId, recipientId: bob.userId, postId };
    await service.notify(fields);
    expect(await service.notify(fields)).toBeNull();
    expect(await notificationCount()).toBe(1);
  });

  test("inside a transaction, it rolls back with the caller's work", async () => {
    await expect(
      withTransaction(async (client) => {
        await service.notify({ type: 'follow', actorId: alice.userId, recipientId: bob.userId }, client);
        throw new Error('the action failed');
      }),
    ).rejects.toThrow('the action failed');
    expect(await notificationCount()).toBe(0);
  });
});

describe('removeNotification', () => {
  test('removes a like notification and returns true', async () => {
    await service.notify({ type: 'like', actorId: alice.userId, recipientId: bob.userId, postId });
    expect(await service.removeNotification({ type: 'like', actorId: alice.userId, postId })).toBe(true);
    expect(await notificationCount()).toBe(0);
  });

  test('removes a follow notification and returns true', async () => {
    await service.notify({ type: 'follow', actorId: alice.userId, recipientId: bob.userId });
    expect(await service.removeNotification({ type: 'follow', actorId: alice.userId, recipientId: bob.userId })).toBe(
      true,
    );
    expect(await notificationCount()).toBe(0);
  });

  test('undoing on your own post is a no-op: nothing was created', async () => {
    await service.notify({ type: 'like', actorId: bob.userId, recipientId: bob.userId, postId });
    expect(await service.removeNotification({ type: 'like', actorId: bob.userId, postId })).toBe(false);
  });
});

// --- Reads ---

// Carol and Dave are extra actors, so Bob can get several notifications. Each is backdated `minutesAgo` minutes, so
// the order is unambiguous; returns the stored createdAt.
let carol;
let dave;
beforeEach(async () => {
  carol = await createUser(pool);
  dave = await createUser(pool);
});
async function followBobAt(actor, minutesAgo) {
  const n = await service.notify({ type: 'follow', actorId: actor.userId, recipientId: bob.userId });
  const { rows } = await pool.query(
    `UPDATE notifications SET created_at = now() - make_interval(mins => $2) WHERE notification_id = $1
     RETURNING created_at`,
    [n.notificationId, minutesAgo],
  );
  return { ...n, createdAt: rows[0].created_at };
}

describe('listNotifications', () => {
  test('{ items, nextCursor }, newest first', async () => {
    const older = await followBobAt(alice, 2);
    const newer = await followBobAt(carol, 1);
    const page = await service.listNotifications(bob.userId, { limit: 20 });
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((n) => n.notificationId)).toEqual([newer.notificationId, older.notificationId]);
    expect(page.items[0]).toEqual({
      notificationId: newer.notificationId,
      type: 'follow',
      actor: { userId: carol.userId, username: carol.username, displayName: carol.displayName },
      post: null,
      createdAt: newer.createdAt,
      read: false,
    });
  });

  test('pages through everything with nextCursor, without skipping or repeating', async () => {
    // 1, 2 and 3 minutes ago, so newest first is alice, carol, dave.
    const expected = [];
    for (const [i, actor] of [alice, carol, dave].entries()) {
      expected.push((await followBobAt(actor, i + 1)).notificationId);
    }

    const first = await service.listNotifications(bob.userId, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(decodeCursor(first.nextCursor)).toEqual({
      createdAt: first.items[1].createdAt.toISOString(),
      notificationId: first.items[1].notificationId,
    });
    const second = await service.listNotifications(bob.userId, { limit: 2, cursor: decodeCursor(first.nextCursor) });
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((n) => n.notificationId)).toEqual(expected);
  });

  test('none -> an empty page', async () => {
    expect(await service.listNotifications(bob.userId, { limit: 20 })).toEqual({ items: [], nextCursor: null });
  });

  test("doesn't mark anything read", async () => {
    await followBobAt(alice, 1);
    await service.listNotifications(bob.userId, { limit: 20 });
    expect(await service.getUnreadCount(bob.userId)).toEqual({ count: 1 });
  });
});

describe('getUnreadCount', () => {
  test('{ count } of everything when nothing has been read', async () => {
    expect(await service.getUnreadCount(bob.userId)).toEqual({ count: 0 });
    await followBobAt(alice, 2);
    await followBobAt(carol, 1);
    expect(await service.getUnreadCount(bob.userId)).toEqual({ count: 2 });
  });
});

describe('markRead', () => {
  test('marks up to upTo: older ones read, newer ones still unread', async () => {
    const older = await followBobAt(alice, 2);
    await followBobAt(carol, 1);
    await expect(service.markRead(bob.userId, { upTo: older.createdAt.toISOString() })).resolves.toBeUndefined();

    expect(await service.getUnreadCount(bob.userId)).toEqual({ count: 1 });
    const { items } = await service.listNotifications(bob.userId, { limit: 20 });
    expect(items.map((n) => n.read)).toEqual([false, true]);
  });

  test('an older upTo afterwards changes nothing', async () => {
    const older = await followBobAt(alice, 2);
    const newer = await followBobAt(carol, 1);
    await service.markRead(bob.userId, { upTo: newer.createdAt.toISOString() });
    await service.markRead(bob.userId, { upTo: older.createdAt.toISOString() });
    expect(await service.getUnreadCount(bob.userId)).toEqual({ count: 0 });
  });

  test('a future upTo only marks up to now', async () => {
    await followBobAt(alice, 1);
    await service.markRead(bob.userId, { upTo: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    await service.notify({ type: 'follow', actorId: carol.userId, recipientId: bob.userId });
    expect(await service.getUnreadCount(bob.userId)).toEqual({ count: 1 });
  });
});
