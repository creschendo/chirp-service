// Business logic for the posts module.
import * as store from './store.js';
import { badRequest, forbidden, notFound } from '../../errors.js';
import { toPage } from '../../pagination.js';
import { withEngagement } from '../engagement/service.js';

// POST /posts. Creates an original, a reply (parentPostId) or a quote (quotedPostId) and returns its post view, with
// engagement for the author (always zeros on a new post, but the same shape as every other post response).
// Throws 400 if both ids are given (the schema rejects that too), 404 if the parent or quoted post doesn't exist
// or is deleted. Later: reply/quote notifications to the other post's author (not to yourself).
export async function createPost(authorId, { content, parentPostId = null, quotedPostId = null }) {
  if (parentPostId && quotedPostId) {
    throw badRequest('A post can be a reply or a quote, not both');
  }

  let rootPostId = null;
  if (parentPostId) {
    const parent = await liveTarget(parentPostId);
    // Replying to a reply joins its conversation; replying to an original starts one rooted at it.
    rootPostId = parent.rootPostId ?? parent.postId;
  }
  if (quotedPostId) {
    await liveTarget(quotedPostId);
  }

  const { postId } = await store.createPost({ authorId, content, parentPostId, rootPostId, quotedPostId });
  const [post] = await withEngagement(authorId, [await store.getPostView(postId)]);
  return post;
}

// The post being replied to or quoted: must exist and not be deleted. Same 404 either way, so a deleted post
// looks gone to anyone trying to interact with it.
async function liveTarget(postId) {
  const post = await store.getPostById(postId);
  if (!post || post.deletedAt) {
    throw notFound('Post not found');
  }
  return post;
}

// GET /posts/:post_id. The post view with engagement (counts, and the viewer's own flags: viewerId is null when
// logged out), or null if it never existed (the route 404s). A deleted post is still returned, with deleted: true,
// no author or content and engagement: null, so links and threads to it keep working.
export async function getPost(viewerId, postId) {
  const post = await store.getPostView(postId);
  if (!post) {
    return null;
  }
  const [withCounts] = await withEngagement(viewerId, [post]);
  return withCounts;
}

// DELETE /posts/:post_id. Soft-deletes the caller's own post; replies and quotes keep pointing at it and show it
// as deleted. Throws 404 if it never existed, 403 if it's someone else's (checked before "already deleted", so
// another user's deleted post is still 403). Deleting your own already-deleted post is a no-op.
export async function deletePost(userId, postId) {
  const post = await store.getPostById(postId);
  if (!post) {
    throw notFound('Post not found');
  }
  if (post.authorId !== userId) {
    throw forbidden('You can only delete your own posts');
  }
  // false if it was already deleted, including by a concurrent request after the check above: still a no-op.
  await store.softDeletePost(postId, userId);
}

// GET /posts/:post_id/replies. A page of direct replies, oldest first: { items, nextCursor } (see src/pagination.js),
// each with engagement for viewerId (null when logged out), or null if the post never existed (the route 404s).
// A deleted post still lists its replies, so the conversation under it stays readable; deleted replies get
// engagement: null.
export async function listReplies(viewerId, postId, { limit, cursor = null }) {
  const post = await store.getPostById(postId);
  if (!post) {
    return null;
  }
  // One extra row only tells toPage whether another page exists.
  const rows = await store.listReplies(postId, { limit: limit + 1, cursor });
  const page = toPage(rows, limit, (last) => ({ createdAt: last.createdAt.toISOString(), postId: last.postId }));
  return { ...page, items: await withEngagement(viewerId, page.items) };
}
