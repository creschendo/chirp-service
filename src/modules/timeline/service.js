// Business logic for the timeline module.
// Strategy (decided, see docs/timeline.md): fan-out on read. Each request builds the timeline from follows + posts
// with one query; nothing is copied into per-user timeline tables, so follows, unfollows and deletes take effect
// immediately. Revisit (fan-out on write or a cache) only if the home query gets slow.
//
// Rules for v1 (decided): originals and quote posts only (replies stay in their conversations), your own posts in
// your home timeline, deleted posts hidden, newest first. Later (engagement): reposts merged in at repost time,
// each post shown once even if several followed users reposted it.
import * as store from './store.js';
import * as usersStore from '../users/store.js';
import { toPage } from '../../pagination.js';

// GET /timeline. A page of the viewer's home timeline: { items, nextCursor } (see src/pagination.js).
export async function getHomeTimeline(viewerId, { limit, cursor = null }) {
  const rows = await store.listHomePosts(viewerId, { limit: limit + 1, cursor });
  return toPage(rows, limit, nextCursor);
}

// GET /users/:username/posts. A page of that user's posts, or null if the user doesn't exist (the route 404s).
// Without the lookup, an unknown user and a user with no posts would both be an empty page.
export async function getProfileTimeline(username, { limit, cursor = null }) {
  const user = await usersStore.getProfileByUsername(username);
  if (!user) {
    return null;
  }
  const rows = await store.listProfilePosts(user.userId, { limit: limit + 1, cursor });
  return toPage(rows, limit, nextCursor);
}

// The next page continues after the last item's sort keys. One extra row was fetched only so toPage knows whether
// there is a next page.
const nextCursor = (last) => ({ createdAt: last.createdAt.toISOString(), postId: last.postId });
