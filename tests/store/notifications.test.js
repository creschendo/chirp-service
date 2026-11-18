// Notifications store (milestone 5). Each test runs in a rolled-back transaction (see helpers/db.js).
import * as store from '../../src/modules/notifications/store.js';
import * as postsStore from '../../src/modules/posts/store.js';
import { useTransaction, pgErrorCode } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';

const ctx = useTransaction();
const NO_ID = '00000000-0000-0000-0000-000000000000';

let alice;
let bob;
let postId;
beforeEach(async () => {
  alice = await createUser(ctx.db);
  bob = await createUser(ctx.db);
  ({ postId } = await postsStore.createPost({ authorId: bob.userId, content: 'hello' }, ctx.db));
});

const notificationCount = async () => (await ctx.db.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n;

// Alice acts on Bob's post (or follows Bob).
const like = (overrides = {}) => ({
  type: 'like',
  actorId: alice.userId,
  recipientId: bob.userId,
  postId,
  ...overrides,
});
const follow = (overrides = {}) => ({ type: 'follow', actorId: alice.userId, recipientId: bob.userId, ...overrides });

describe('addNotification', () => {
  test('returns the new notification', async () => {
    expect(await store.addNotification(like(), ctx.db)).toEqual({
      notificationId: expect.any(String),
      recipientId: bob.userId,
      actorId: alice.userId,
      type: 'like',
      postId,
      createdAt: expect.any(Date),
    });
  });

  test('a follow has no post', async () => {
    expect(await store.addNotification(follow(), ctx.db)).toMatchObject({ type: 'follow', postId: null });
  });

  test.each([
    ['like', like],
    ['follow', follow],
  ])('the same %s twice returns null and stores one', async (_, make) => {
    await store.addNotification(make(), ctx.db);
    expect(await store.addNotification(make(), ctx.db)).toBeNull();
    expect(await notificationCount()).toBe(1);
  });

  test('a like and a repost of the same post are separate notifications', async () => {
    await store.addNotification(like(), ctx.db);
    expect(await store.addNotification(like({ type: 'repost' }), ctx.db)).not.toBeNull();
    expect(await notificationCount()).toBe(2);
  });

  test('two replies by the same actor are separate notifications', async () => {
    const reply = async () =>
      (
        await postsStore.createPost(
          { authorId: alice.userId, content: 'r', parentPostId: postId, rootPostId: postId },
          ctx.db,
        )
      ).postId;
    await store.addNotification(like({ type: 'reply', postId: await reply() }), ctx.db);
    await store.addNotification(like({ type: 'reply', postId: await reply() }), ctx.db);
    expect(await notificationCount()).toBe(2);
  });

  test.each([
    ['notifying yourself', () => like({ actorId: bob.userId })],
    ['an unknown type', () => like({ type: 'poke' })],
    ['a like without a post', () => like({ postId: null })],
    ['a follow with a post', () => follow({ postId })],
  ])('%s -> 23514', async (_, make) => {
    expect(await pgErrorCode(ctx.db, () => store.addNotification(make(), ctx.db))).toBe('23514');
  });

  test.each([
    ['post', () => like({ postId: NO_ID })],
    ['actor', () => like({ actorId: NO_ID })],
    ['recipient', () => like({ recipientId: NO_ID })],
  ])('an unknown %s -> 23503', async (_, make) => {
    expect(await pgErrorCode(ctx.db, () => store.addNotification(make(), ctx.db))).toBe('23503');
  });
});

describe('removeNotification', () => {
  test('removes a like notification by actor, type and post, and returns true', async () => {
    await store.addNotification(like(), ctx.db);
    expect(await store.removeNotification({ type: 'like', actorId: alice.userId, postId }, ctx.db)).toBe(true);
    expect(await notificationCount()).toBe(0);
  });

  test('removes a follow notification by actor and recipient', async () => {
    await store.addNotification(follow(), ctx.db);
    expect(
      await store.removeNotification({ type: 'follow', actorId: alice.userId, recipientId: bob.userId }, ctx.db),
    ).toBe(true);
    expect(await notificationCount()).toBe(0);
  });

  test('returns false when there is none', async () => {
    expect(await store.removeNotification({ type: 'like', actorId: alice.userId, postId }, ctx.db)).toBe(false);
    expect(
      await store.removeNotification({ type: 'follow', actorId: alice.userId, recipientId: bob.userId }, ctx.db),
    ).toBe(false);
  });

  test('only removes the matching one', async () => {
    const carol = await createUser(ctx.db);
    await store.addNotification(like(), ctx.db);
    await store.addNotification(like({ type: 'repost' }), ctx.db);
    await store.addNotification(like({ actorId: carol.userId }), ctx.db);
    await store.addNotification(follow(), ctx.db);
    await store.addNotification(follow({ recipientId: carol.userId }), ctx.db);

    await store.removeNotification({ type: 'like', actorId: alice.userId, postId }, ctx.db);
    await store.removeNotification({ type: 'follow', actorId: alice.userId, recipientId: bob.userId }, ctx.db);

    const { rows } = await ctx.db.query(
      'SELECT actor_id, type, recipient_id FROM notifications ORDER BY type, actor_id',
    );
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        { actor_id: alice.userId, type: 'repost', recipient_id: bob.userId },
        { actor_id: carol.userId, type: 'like', recipient_id: bob.userId },
        { actor_id: alice.userId, type: 'follow', recipient_id: carol.userId },
      ]),
    );
  });

  test('after removing, the same action can notify again', async () => {
    await store.addNotification(like(), ctx.db);
    await store.removeNotification({ type: 'like', actorId: alice.userId, postId }, ctx.db);
    expect(await store.addNotification(like(), ctx.db)).not.toBeNull();
  });
});

describe('cascades', () => {
  test('deleting the actor removes the notification', async () => {
    await store.addNotification(follow(), ctx.db);
    await ctx.db.query('DELETE FROM users WHERE user_id = $1', [alice.userId]);
    expect(await notificationCount()).toBe(0);
  });
});

// --- Reads ---

// Stores a notification `minutesAgo` minutes in the past, so order and read state are unambiguous.
async function notifyAt(minutesAgo, fields) {
  const n = await store.addNotification(fields, ctx.db);
  const { rows } = await ctx.db.query(
    `UPDATE notifications SET created_at = now() - make_interval(mins => $2) WHERE notification_id = $1
     RETURNING created_at`,
    [n.notificationId, minutesAgo],
  );
  return { ...n, createdAt: rows[0].created_at };
}
const minutesAgo = (mins) => new Date(Date.now() - mins * 60 * 1000);
const list = (q = {}) => store.listNotifications(bob.userId, { limit: 20, ...q }, ctx.db);
const softDelete = (id) => ctx.db.query('UPDATE posts SET deleted_at = now(), content = NULL WHERE post_id = $1', [id]);

describe('listNotifications', () => {
  test('newest first, with the actor and the post view; follows have post null', async () => {
    const liked = await notifyAt(2, like());
    const followed = await notifyAt(1, follow());

    expect(await list()).toEqual([
      {
        notificationId: followed.notificationId,
        type: 'follow',
        actor: { userId: alice.userId, username: alice.username, displayName: alice.displayName },
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
    ]);
  });

  test('pages with a cursor, ties broken by notification_id', async () => {
    const carol = await createUser(ctx.db);
    const dave = await createUser(ctx.db);
    await notifyAt(5, follow());
    await notifyAt(1, follow({ actorId: carol.userId }));
    await notifyAt(1, follow({ actorId: dave.userId }));
    await notifyAt(3, like());

    const all = (await list()).map((n) => n.notificationId);
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const items = await list({ limit: 2, cursor });
      seen.push(...items.map((n) => n.notificationId));
      if (items.length < 2) break;
      const last = items.at(-1);
      cursor = { createdAt: last.createdAt.toISOString(), notificationId: last.notificationId };
    }
    expect(seen).toEqual(all);
    expect(all).toHaveLength(4);
    // The two at the same time come out in notification_id order, newest (largest) first.
    expect(all.slice(0, 2)).toEqual([...all.slice(0, 2)].sort().reverse());
  });

  test('skips notifications whose post is deleted, including a deleted reply', async () => {
    const { postId: replyId } = await postsStore.createPost(
      { authorId: alice.userId, content: 'reply', parentPostId: postId, rootPostId: postId },
      ctx.db,
    );
    const { postId: otherId } = await postsStore.createPost({ authorId: bob.userId, content: 'other' }, ctx.db);
    await notifyAt(3, like());
    await notifyAt(2, like({ type: 'reply', postId: replyId }));
    const kept = await notifyAt(1, like({ postId: otherId }));
    await notifyAt(0, follow());

    await softDelete(postId);
    await softDelete(replyId);
    expect((await list()).map((n) => n.notificationId)).toEqual([
      expect.any(String), // the follow
      kept.notificationId,
    ]);
  });

  test('read is true up to read_up_to, false after it and when there is no row', async () => {
    await notifyAt(10, follow());
    await notifyAt(5, like());
    expect((await list()).map((n) => n.read)).toEqual([false, false]);

    await store.markReadUpTo(bob.userId, minutesAgo(7), ctx.db);
    expect((await list()).map((n) => n.read)).toEqual([false, true]);
  });

  test("only the recipient's notifications", async () => {
    await notifyAt(1, like());
    await notifyAt(1, follow({ actorId: bob.userId, recipientId: alice.userId }));
    expect(await list()).toHaveLength(1);
    expect(await store.listNotifications(alice.userId, { limit: 20 }, ctx.db)).toEqual([
      expect.objectContaining({ type: 'follow', actor: expect.objectContaining({ userId: bob.userId }) }),
    ]);
  });

  test('none -> []', async () => {
    expect(await list()).toEqual([]);
  });
});

describe('countUnread', () => {
  const unread = () => store.countUnread(bob.userId, ctx.db);

  test('counts everything when nothing has been read', async () => {
    expect(await unread()).toBe(0);
    await notifyAt(10, follow());
    await notifyAt(5, like());
    expect(await unread()).toBe(2);
  });

  test('counts only notifications after read_up_to', async () => {
    await notifyAt(10, follow());
    await notifyAt(5, like());
    await store.markReadUpTo(bob.userId, minutesAgo(7), ctx.db);
    expect(await unread()).toBe(1);
    await store.markReadUpTo(bob.userId, new Date(), ctx.db);
    expect(await unread()).toBe(0);
  });

  test('skips notifications whose post is deleted', async () => {
    await notifyAt(10, follow());
    await notifyAt(5, like());
    await softDelete(postId);
    expect(await unread()).toBe(1);
  });

  test("only the recipient's", async () => {
    await notifyAt(1, follow({ actorId: bob.userId, recipientId: alice.userId }));
    expect(await unread()).toBe(0);
  });
});

describe('markReadUpTo', () => {
  const readRow = async () =>
    (await ctx.db.query('SELECT read_up_to FROM notification_reads WHERE user_id = $1', [bob.userId])).rows[0];

  test('creates the row the first time and returns the time', async () => {
    const upTo = minutesAgo(5);
    expect(await readRow()).toBeUndefined();
    expect(await store.markReadUpTo(bob.userId, upTo, ctx.db)).toEqual(upTo);
    expect(await readRow()).toEqual({ read_up_to: upTo });
  });

  test('moves forward, never back', async () => {
    const earlier = minutesAgo(10);
    const later = minutesAgo(5);
    await store.markReadUpTo(bob.userId, earlier, ctx.db);
    expect(await store.markReadUpTo(bob.userId, later, ctx.db)).toEqual(later);
    expect(await store.markReadUpTo(bob.userId, earlier, ctx.db)).toEqual(later);
    expect(await readRow()).toEqual({ read_up_to: later });
  });

  test('clamps a future time to now', async () => {
    const { rows } = await ctx.db.query('SELECT now() AS now');
    const readUpTo = await store.markReadUpTo(bob.userId, new Date(Date.now() + 60 * 60 * 1000), ctx.db);
    // now() is the transaction's start time; read_up_to rounds to milliseconds, the Date truncates: up to 1ms apart.
    expect(Math.abs(readUpTo - rows[0].now)).toBeLessThanOrEqual(1);
  });

  test('a user with no notifications can still mark read', async () => {
    await store.markReadUpTo(alice.userId, new Date(), ctx.db);
    expect(await store.countUnread(alice.userId, ctx.db)).toBe(0);
  });
});
