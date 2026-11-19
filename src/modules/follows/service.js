// Business logic for the follows module.
import * as store from './store.js';
import * as usersStore from '../users/store.js';
import * as notifications from '../notifications/service.js';
import { withTransaction } from '../../db/index.js';
import { badRequest, notFound } from '../../errors.js';
import { toPage } from '../../pagination.js';

// Follow someone. Idempotent: returns true if a new follow was created, false if already following.
// A new follow notifies the followed user, in the same transaction, so neither exists without the other; following
// again doesn't.
export async function follow(followerId, followedId) {
  // Checked here for a clear message; the follows_no_self_follow constraint is the backstop.
  if (followerId === followedId) {
    throw badRequest('Cannot follow yourself');
  }
  try {
    return await withTransaction(async (client) => {
      const created = await store.follow(followerId, followedId, client);
      if (created) {
        await notifications.notify({ type: 'follow', actorId: followerId, recipientId: followedId }, client);
      }
      return created;
    });
  } catch (err) {
    // Foreign key violation: the user being followed doesn't exist. Caught outside the transaction, which has
    // already rolled back.
    if (err.code === '23503') {
      throw notFound('User not found');
    }
    throw err;
  }
}

// Unfollow someone. Idempotent: returns false if there was nothing to remove (including yourself). Removing a follow
// also removes its notification, in the same transaction.
export async function unfollow(followerId, followedId) {
  return withTransaction(async (client) => {
    const removed = await store.unfollow(followerId, followedId, client);
    if (removed) {
      await notifications.removeNotification({ type: 'follow', actorId: followerId, recipientId: followedId }, client);
    }
    return removed;
  });
}

// Followers of a username as { items, nextCursor }, or null if the user doesn't exist (so the route can 404).
export async function getFollowers(username, { limit, cursor = null }) {
  return listPage(store.listFollowers, username, { limit, cursor });
}

// Users a username follows as { items, nextCursor }, or null if the user doesn't exist.
export async function getFollowing(username, { limit, cursor = null }) {
  return listPage(store.listFollowing, username, { limit, cursor });
}

// Resolves the username to an id, fetches one extra row to know whether another page exists,
// and builds the next cursor from the last row's sort keys.
async function listPage(listFn, username, { limit, cursor }) {
  const user = await usersStore.getProfileByUsername(username);
  if (!user) {
    return null;
  }
  const rows = await listFn(user.userId, { limit: limit + 1, cursor });
  return toPage(rows, limit, (last) => ({ followedAt: last.followedAt.toISOString(), userId: last.userId }));
}
