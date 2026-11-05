// Business logic for the engagement module.
//
// Decisions:
// - Likes, reposts and bookmarks are all idempotent: doing one twice, or undoing one you never did, succeeds with no
//   change.
// - You can like, repost and bookmark your own posts.
// - A repost is new activity: a new timeline item at the time of the repost, by the reposter. The original post isn't
//   changed and doesn't move.
// - Likes are public (anyone can list a user's likes); bookmarks are private (only the owner can list theirs).
// - Deleted posts can't be liked, reposted or bookmarked (404, the same as a post that never existed, like replying
//   to or quoting one). Existing engagement on a post that gets deleted stays in the tables but is hidden, because
//   lists and timelines skip deleted posts.
// - Counts are computed on read, never stored.
import * as store from './store.js';
import * as postsStore from '../posts/store.js';
import * as usersStore from '../users/store.js';
import { notFound } from '../../errors.js';
import { toPage } from '../../pagination.js';

// Deferred: lists of who liked or reposted a post, quotes of a post as a list, notification batching
// ("5 people liked your post").

// Adds engagement: { likeCount, repostCount, replyCount, quoteCount, liked, reposted, bookmarked } to each post view
// (or timeline item) in the list, for viewerId, and returns the new list in the same order. One store query for the
// whole list, however long. Exported for the posts and timeline services; the lists below will use it too.
// - A deleted post gets engagement: null: there's nothing to show, and its leftover likes and reposts stay hidden.
// - A repost item shows the original post's numbers (its postId is the original's), so a post looks the same
//   wherever it appears, and a post on the page twice is fetched once.
// - The embedded quotedPost gets no counts; the client only shows them on the main post.
// - viewerId null (logged out) gives real counts with every flag false. Public routes will need an optional-auth
//   middleware (sets req.userId when a valid token is present, and doesn't 401 otherwise) to pass a viewer; it
//   doesn't exist yet.
export async function withEngagement(viewerId, posts) {
  const liveIds = posts.filter((post) => !post.deleted).map((post) => post.postId);
  const engagement = await store.getEngagement(liveIds, viewerId);
  return posts.map((post) => ({ ...post, engagement: post.deleted ? null : engagement[post.postId] }));
}

// The post being liked, reposted or bookmarked: must exist and not be deleted. Same 404 either way, so a deleted post
// looks gone to anyone trying to interact with it (the posts service does the same for replies and quotes).
async function liveTarget(postId) {
  const post = await postsStore.getPostById(postId);
  if (!post || post.deletedAt) {
    throw notFound('Post not found');
  }
  return post;
}

// POST /posts/:post_id/like. Likes the post; liking it again is a no-op, and the first like keeps its time. Your own
// posts can be liked. Throws 404 if the post doesn't exist or is deleted.
// If the post is deleted between the check and the insert, the like is still stored, but nothing shows it: lists
// and timelines skip deleted posts.
// Later, only when the like is new and the post isn't your own: a like notification to the author.
export async function like(userId, postId) {
  await liveTarget(postId);
  await store.addLike(userId, postId);
}

// DELETE /posts/:post_id/like. Removes your like. Never fails for a valid id: no existence check, so you can always
// undo, even on a post that has since been deleted, and unliking something you never liked (or an unknown post) is a
// no-op.
export async function unlike(userId, postId) {
  await store.removeLike(userId, postId);
}

// POST /posts/:post_id/repost. Reposts the post: a new item in timelines at the time of the repost, with the original
// left where it is. Your own posts can be reposted. Returns { repostId, repostedAt, created }: reposting again returns
// the existing repost with created false (the route sends 201 or 200), and doesn't move it to the top.
// Throws 404 if the post doesn't exist or is deleted.
// Later, only when created and the post isn't your own: a repost notification to the author.
export async function repost(userId, postId) {
  await liveTarget(postId);
  const { repostId, createdAt, created } = await store.addRepost(userId, postId);
  return { repostId, repostedAt: createdAt, created };
}

// DELETE /posts/:post_id/repost. Removes your repost and its timeline item. Like unlike, no existence check: you can
// always undo, and un-reposting something you never reposted (or an unknown post) is a no-op.
export async function unrepost(userId, postId) {
  await store.removeRepost(userId, postId);
}

// POST /posts/:post_id/bookmark. Bookmarks the post, privately: nobody else can see it, and it never notifies.
// Bookmarking again is a no-op and keeps the first bookmark's place in your list. Your own posts can be bookmarked.
// Throws 404 if the post doesn't exist or is deleted.
export async function bookmark(userId, postId) {
  await liveTarget(postId);
  await store.addBookmark(userId, postId);
}

// DELETE /posts/:post_id/bookmark. Removes your bookmark. Like unlike, no existence check: you can always undo, and
// removing a bookmark you don't have (or for an unknown post) is a no-op.
export async function unbookmark(userId, postId) {
  await store.removeBookmark(userId, postId);
}

// GET /users/:username/likes. A page of the posts that user liked, newest like first: { items, nextCursor } (see
// src/pagination.js), each item a post view with likedAt. Deleted posts are left out. Returns null if the user
// doesn't exist (the route 404s); without the lookup, an unknown user and one with no likes would both be an empty
// page. Public: anyone can see anyone's likes.
// Not wired up yet: withEngagement on the items, which needs the viewer's id as a new argument (whoever is looking,
// not the user whose likes these are).
export async function listLikes(username, { limit, cursor = null }) {
  const user = await usersStore.getProfileByUsername(username);
  if (!user) {
    return null;
  }
  // One extra row only tells toPage whether another page exists.
  const rows = await store.listLikedPosts(user.userId, { limit: limit + 1, cursor });
  return toPage(rows, limit, (last) => ({ likedAt: last.likedAt.toISOString(), postId: last.postId }));
}

// GET /users/me/bookmarks. A page of the caller's own bookmarks, newest bookmark first: { items, nextCursor }, each
// item a post view with bookmarkedAt. Deleted posts are left out. Private: it takes the caller's id from the token, so
// there's no way to ask for anyone else's.
// Not wired up yet: withEngagement(userId, items), the caller being the viewer.
export async function listBookmarks(userId, { limit, cursor = null }) {
  const rows = await store.listBookmarkedPosts(userId, { limit: limit + 1, cursor });
  return toPage(rows, limit, (last) => ({ bookmarkedAt: last.bookmarkedAt.toISOString(), postId: last.postId }));
}
