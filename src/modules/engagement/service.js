// Business logic for the engagement module.
//
// PLAN (not implemented yet):
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
//
// like(userId, postId)
//   POST /posts/:post_id/like. liveTarget(postId) (missing or deleted -> 404 'Post not found'), then store.addLike.
//   Already liked -> no-op. Later, only when the like is new and not your own post: a like notification.
//
// unlike(userId, postId)
//   DELETE /posts/:post_id/like. store.removeLike. No existence check: unliking is allowed on a deleted or missing
//   post, so you can always undo, and it's a no-op if there was nothing to remove.
//
// repost(userId, postId)
//   POST /posts/:post_id/repost. liveTarget, then store.addRepost. Returns { repostId, repostedAt, created } (the
//   route sends 201 or 200). Later, only when new and not your own post: a repost notification.
//
// unrepost(userId, postId)
//   DELETE /posts/:post_id/repost. store.removeRepost; like unlike, no existence check.
//
// bookmark / unbookmark(userId, postId)
//   POST / DELETE /posts/:post_id/bookmark. Same as like / unlike, never notifies.
//
// listLikes(username, { limit, cursor })
//   GET /users/:username/likes. usersStore.getProfileByUsername (null -> null, the route 404s), then
//   store.listLikedPosts with limit + 1, withEngagement(viewer, items), toPage with
//   { likedAt: last.likedAt.toISOString(), postId }.
//
// listBookmarks(userId, { limit, cursor })
//   GET /users/me/bookmarks. store.listBookmarkedPosts for the caller only, then withEngagement and toPage with
//   { bookmarkedAt, postId }.
//
// withEngagement(viewerId, posts)
//   Exported for the posts and timeline services. Adds engagement: { likeCount, repostCount, replyCount, quoteCount,
//   liked, reposted, bookmarked } to each post view, from one store.getEngagement call for the whole list. A deleted
//   post gets null (nothing to show). The embedded quotedPost doesn't get counts (the client doesn't show them).
//   viewerId is null for logged-out viewers, which needs an optional-auth middleware (sets req.userId when a valid
//   token is present, and doesn't 401 otherwise) for the public routes: GET /posts/:post_id, its replies, profile
//   timelines and likes lists. It doesn't exist yet.
//
// Deferred: lists of who liked or reposted a post, quotes of a post as a list, notification batching
// ("5 people liked your post").

// TODO
