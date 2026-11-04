// Database access for the engagement module.
// Owns likes, reposts and bookmarks; queries join posts and users read-only. Every function takes an optional `db`
// (defaults to the pool) so a service can run it inside withTransaction. Functions take user and post ids.
//
// PLAN (not implemented yet):
//
// Tables, from migrations/005_create-engagement.js (written). All three are user -> post relationships with a time:
//
//   likes (user_id, post_id, created_at)
//     PRIMARY KEY (user_id, post_id): one like per user per post, and "did I like these posts" lookups.
//     user_id -> users ON DELETE CASCADE, post_id -> posts ON DELETE CASCADE. Posts are soft-deleted, so the cascade
//     only fires when a post's author is deleted; a soft-deleted post keeps its likes but is hidden everywhere.
//     INDEX (post_id): like counts, and the post_id cascade.
//     INDEX (user_id, created_at DESC, post_id DESC): a user's likes, newest first, with the keyset cursor.
//
//   reposts (repost_id, user_id, post_id, created_at)
//     repost_id uuid PRIMARY KEY DEFAULT gen_random_uuid(). Unlike likes, a repost is an item in timelines, so it
//     gets its own id: timeline items are keyed by (activity time, item id), where the item id is a post_id for a
//     post and a repost_id for a repost. Both are uuids, so one cursor shape covers both.
//     UNIQUE (user_id, post_id): one repost per user per post (also covers the user_id cascade).
//     Same cascades as likes. Reposting your own post is allowed.
//     INDEX (user_id, created_at DESC, repost_id DESC): a user's reposts for their profile timeline, and the home
//     timeline's "reposts by people I follow".
//     INDEX (post_id): repost counts, and the post_id cascade.
//
//   bookmarks (user_id, post_id, created_at)
//     PRIMARY KEY (user_id, post_id). Same cascades. Private: only the owner ever reads them.
//     INDEX (user_id, created_at DESC, post_id DESC): your bookmarks, newest first.
//     INDEX (post_id): the post_id cascade (bookmarks have no public count).
//
//   created_at is timestamptz(3) DEFAULT now() everywhere, so cursors round-trip exactly through JavaScript Dates.
//
// Writes. No access checks here: the service checks the post exists and is live first. Each is one statement and
// idempotent, so there's no read-then-write race:
//
// addLike(userId, postId, db)
//   INSERT ... ON CONFLICT DO NOTHING. Returns true if it was new, false if already liked (the service ignores it;
//   later, only a new like notifies). Errors: 23503 unknown user or post.
//
// removeLike(userId, postId, db)
//   DELETE. Returns true if there was one. Unliking something you never liked is a no-op.
//
// addRepost(userId, postId, db)
//   INSERT ... ON CONFLICT DO NOTHING RETURNING repost_id, created_at. Returns { repostId, createdAt, created }:
//   on a repeat, created is false and the existing repost is selected instead (the same find-or-insert shape as
//   messages' findOrCreateDirect), so the response is the same either way. Reposting again does NOT bump the time:
//   the repost happened once, at created_at. Errors: 23503.
//
// removeRepost(userId, postId, db)
//   DELETE. Returns true if there was one. Its timeline item disappears with it.
//
// addBookmark / removeBookmark(userId, postId, db)
//   Same as likes.
//
// Reads:
//
// getEngagement(postIds, viewerId, db)
//   Counts and viewer flags for a page of posts, in one query, so a list of 20 posts costs one extra query, not 20:
//   { [postId]: { likeCount, repostCount, replyCount, quoteCount, liked, reposted, bookmarked } }.
//   Counts are computed on read with grouped subqueries over the post_id indexes (no stored counters to keep in
//   sync; revisit if it gets slow). replyCount and quoteCount come from posts (parent_post_id, quoted_post_id),
//   counting live posts only. viewerId null (logged out) makes every flag false.
//   Why a separate query rather than more columns in posts/views.js's POST_VIEW_SELECT: every caller of the post
//   view would need the viewer as a positional parameter, and posts would have to know about engagement's tables.
//
// listLikedPosts(userId, { limit, cursor }, db)
//   GET /users/:username/likes. Post views (POST_VIEW_SELECT from posts/views.js) joined to likes, newest like
//   first, each with likedAt. Deleted posts are hidden. Cursor { likedAt, postId }, < for the next page. Uses the
//   (user_id, created_at DESC, post_id DESC) index.
//
// listBookmarkedPosts(userId, { limit, cursor }, db)
//   GET /users/me/bookmarks. The same shape as listLikedPosts, with bookmarkedAt. Deleted posts are hidden.
//
// Timeline support. These queries live in the timeline store, because the timeline owns how items merge, but they
// read the reposts table:
// - Profile timeline: the user's posts UNION the user's reposts, each item with activity_at (the post's created_at,
//   or the repost's) and item_id (post_id or repost_id), ordered by (activity_at DESC, item_id DESC).
// - Home timeline: the same UNION over the viewer and everyone they follow. A repost is new activity: it's a new
//   item at the time of the repost, and the original post stays where it was, at its own time. If several people
//   you follow repost the same post, only the newest of those reposts is shown (DISTINCT ON post_id). Reposts of
//   deleted posts are hidden, like deleted posts. Reposts of replies are shown (reposting is a deliberate choice).
// - Item shape: the post view plus repost: { repostId, user: { userId, username, displayName }, repostedAt } or
//   null for a plain post. The timeline cursor becomes { activityAt, itemId }.

// TODO
