// Business logic for the notifications module.
//
// PLAN (nothing implemented yet).
//
// Decisions:
// - Notifying actions: like, repost, reply, quote, follow. Not DMs (messages get their own real-time delivery), not
//   bookmarks (private).
// - Never notify yourself: liking, reposting, replying to or quoting your own post creates nothing.
// - Only new actions notify: liking again, reposting again or following again (created/new = false) creates nothing.
// - Undo deletes the notification: unlike, unrepost and unfollow remove it, so like -> unlike -> like leaves one
//   notification, not a pile. A deleted reply or quote isn't removed; it's hidden (below), the same thing to the user.
// - Hidden, not deleted: a notification whose post is deleted (the liked post, or the reply/quote itself) is left out
//   of the list and the unread count. Matches engagement: deleted posts hide their leftovers.
// - Reply notifies the direct parent's author only (not the root's, not everyone in the thread). Quote notifies the
//   quoted post's author.
// - No grouping in v1 ("Alice and 4 others liked your post"): one notification per action, newest first. Grouping can
//   be done later when reading, without changing the table.
// - Read state is one "read up to" time per user, not a flag per notification: everything at or before it is read.
//   The unread count is the visible notifications after it. No marking a single notification read.
// - Persist first, push later: a notification is a row first. Real-time delivery (milestone 5, docs/realtime.md) will
//   push it to the recipient's socket room after the write commits; a missed push is caught up by GET /notifications.
//
// How other modules create them: they call this service directly (no event bus). The like/repost/follow/post write
// and the notification go in one transaction (withTransaction), so there's never a like without its notification or
// the reverse. That means passing the transaction client through:
//
// - engagement.like:     addLike returns true            -> notify({ type: 'like', actorId, recipientId: post.authorId,
//                                                            postId }, client)
// - engagement.unlike:   removeLike returns true         -> removeNotification({ type: 'like', actorId, postId }, client)
// - engagement.repost:   addRepost returns created: true -> notify({ type: 'repost', ... }, client)
// - engagement.unrepost: removeRepost returns true       -> removeNotification({ type: 'repost', ... }, client)
// - follows.follow:      store.follow returns true       -> notify({ type: 'follow', actorId, recipientId,
//                                                            postId: null }, client)
// - follows.unfollow:    store.unfollow returns true     -> removeNotification({ type: 'follow', actorId, recipientId },
//                                                            client)
// - posts.createPost:    reply -> notify({ type: 'reply', recipientId: parent.authorId, postId: the new reply });
//                        quote -> notify({ type: 'quote', recipientId: quoted.authorId, postId: the new quote })
//   liveTarget already loads the parent/quoted post, so the author id costs no extra query.
// - posts.deletePost: nothing (hidden by the deleted check).
//
import * as store from './store.js';
import { toPage } from '../../pagination.js';

// Creates a notification for an action that just happened, and returns it, or null if nothing was created:
// - actorId === recipientId: you never notify yourself (liking or replying to your own post). Checked here so the
//   insert isn't attempted; notifications_no_self_check is the backstop.
// - the action already has one (the store's unique key): only in a race, since callers notify on new actions only.
// type is 'like' | 'repost' | 'reply' | 'quote' | 'follow'; postId is null for a follow (see the store for what it
// points at). Callers pass their transaction client as db, so the notification commits or rolls back with the action;
// without it, the store uses the pool. Later: the caller pushes the returned notification to the recipient after
// commit.
export async function notify({ type, actorId, recipientId, postId = null }, db) {
  if (actorId === recipientId) {
    return null;
  }
  return store.addNotification({ type, actorId, recipientId, postId }, db);
}

// Deletes the notification for an undone action (unlike, unrepost, unfollow). Returns true if one was removed, false
// if there was none, e.g. it was your own post so nothing was created: undo never fails.
// like/repost pass { type, actorId, postId }; follow passes { type: 'follow', actorId, recipientId }.
export async function removeNotification({ type, actorId, recipientId = null, postId = null }, db) {
  return store.removeNotification({ type, actorId, recipientId, postId }, db);
}

// GET /notifications. A page of your notifications, newest first: { items, nextCursor } (see src/pagination.js), each
// item { notificationId, type, actor, post, createdAt, read }. post is a post view, or null for a follow; it has no
// engagement counts in v1. Notifications about deleted posts are left out. Doesn't mark anything read: the client
// calls markRead once it has shown the page.
export async function listNotifications(userId, { limit, cursor = null }) {
  // One extra row only tells toPage whether another page exists.
  const rows = await store.listNotifications(userId, { limit: limit + 1, cursor });
  return toPage(rows, limit, (last) => ({
    createdAt: last.createdAt.toISOString(),
    notificationId: last.notificationId,
  }));
}

// GET /notifications/unread-count. { count } for the badge: notifications after your read-up-to time (all of them if
// you've never marked any read), counting only the ones the list would show.
export async function getUnreadCount(userId) {
  return { count: await store.countUnread(userId) };
}

// PUT /notifications/read. Marks everything at or before upTo as read. upTo is the createdAt of the newest
// notification the client showed, not "now", so one that arrived after the page loaded stays unread. Never moves
// backward and never past now (the store's GREATEST and LEAST), so an older upTo from another tab, or a repeat, is a
// no-op. Returns nothing (the route sends 204).
export async function markRead(userId, { upTo }) {
  await store.markReadUpTo(userId, upTo);
}

// Deferred: grouping, mentions (@username in posts), notification preferences/muting, pruning old notifications,
// engagement counts on the embedded post.
