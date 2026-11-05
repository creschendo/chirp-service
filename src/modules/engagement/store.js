// Database access for the engagement module.
// Owns likes, reposts and bookmarks; queries join posts and users read-only. Every function takes an optional `db`
// (defaults to the pool) so a service can run it inside withTransaction. Functions take user and post ids.
import { pool } from '../../db/index.js';
import { POST_VIEW_SELECT, toPostView } from '../posts/views.js';

// The tables, their keys and indexes, and why, are in migrations/005_create-engagement.js. One like, repost and
// bookmark per user per post; a repost has its own repost_id because it's an item in timelines. The timeline store
// reads the reposts table directly to merge reposts into both timelines.

// --- Counts and viewer flags ---

// Every post view the API returns gets these, through the service's withEngagement. One query for a whole page of
// posts, so a list of 20 costs one extra query, not 20. Returns
//   { [postId]: { likeCount, repostCount, replyCount, quoteCount, liked, reposted, bookmarked } }
// with an entry for every id asked for: an unknown id just gets zeros and false. viewerId null (logged out) makes
// every flag false, since user_id = NULL never matches.
// Counts are computed on read, never stored, so there are no counters to keep in sync (revisit if it gets slow).
// replyCount (direct replies only) and quoteCount count live posts, so they match what a client can actually open.
// Each subquery is an index lookup for one post: likes_post_id_idx, reposts_post_id_idx and the posts parent and
// quoted indexes for the counts; the likes and bookmarks primary keys and reposts_user_id_post_id_key for the flags.
// This is a separate query rather than more columns in posts/views.js's POST_VIEW_SELECT: every caller of the post
// view would need the viewer as a positional parameter, and the posts module would have to know engagement's tables.
export async function getEngagement(postIds, viewerId, db = pool) {
  if (postIds.length === 0) {
    return {};
  }
  const { rows } = await db.query(
    `SELECT ids.post_id,
            (SELECT count(*)::int FROM likes l WHERE l.post_id = ids.post_id) AS like_count,
            (SELECT count(*)::int FROM reposts r WHERE r.post_id = ids.post_id) AS repost_count,
            (SELECT count(*)::int FROM posts rp
             WHERE rp.parent_post_id = ids.post_id AND rp.deleted_at IS NULL) AS reply_count,
            (SELECT count(*)::int FROM posts qp
             WHERE qp.quoted_post_id = ids.post_id AND qp.deleted_at IS NULL) AS quote_count,
            EXISTS (SELECT 1 FROM likes l WHERE l.user_id = $2 AND l.post_id = ids.post_id) AS liked,
            EXISTS (SELECT 1 FROM reposts r WHERE r.user_id = $2 AND r.post_id = ids.post_id) AS reposted,
            EXISTS (SELECT 1 FROM bookmarks b WHERE b.user_id = $2 AND b.post_id = ids.post_id) AS bookmarked
     FROM (SELECT DISTINCT unnest($1::uuid[]) AS post_id) ids`,
    [postIds, viewerId],
  );
  return Object.fromEntries(
    rows.map((row) => [
      row.post_id,
      {
        likeCount: row.like_count,
        repostCount: row.repost_count,
        replyCount: row.reply_count,
        quoteCount: row.quote_count,
        liked: row.liked,
        reposted: row.reposted,
        bookmarked: row.bookmarked,
      },
    ]),
  );
}

// --- Likes ---

// POST /posts/:post_id/like. Idempotent: INSERT ... ON CONFLICT DO NOTHING, so liking twice keeps the first like and
// its time. Returns true if the like is new, false if already liked (later, only a new like notifies). No checks: the
// service checks the post exists and isn't deleted first. Errors: 23503 unknown user or post.
export async function addLike(userId, postId, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO likes (user_id, post_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING 1`,
    [userId, postId],
  );
  return rows.length > 0;
}

// DELETE /posts/:post_id/like. Idempotent: unliking a post you never liked, or one that doesn't exist, deletes
// nothing. Returns true if a like was removed, false if there was none. Uses the primary key. A malformed id throws
// 22P02, so routes validate ids first.
export async function removeLike(userId, postId, db = pool) {
  const { rowCount } = await db.query(
    `DELETE FROM likes
     WHERE user_id = $1 AND post_id = $2`,
    [userId, postId],
  );
  return rowCount > 0;
}

// GET /users/:username/likes. The posts a user liked, as post views (the GET /posts/:post_id shape) each with likedAt,
// newest like first. Deleted posts are hidden. [] if none (404 for an unknown user is decided by the service).
// The post view is joined in as a subquery, so its columns come through unchanged next to likedAt; Postgres flattens
// it into a plain join, so this is still one query with no N+1.
// cursor: the last row's { likedAt, postId } from the previous page; null for the first page. Newest first, so the
// next page is the rows *before* the cursor (<), post_id breaking ties between likes made in the same millisecond.
// Uses likes_user_id_created_at_idx (user_id, created_at DESC, post_id DESC): pages jump straight to the cursor.
export async function listLikedPosts(userId, { limit, cursor = null }, db = pool) {
  const { rows } = await db.query(
    `SELECT pv.*, l.created_at AS liked_at
     FROM likes l
     JOIN (${POST_VIEW_SELECT}) pv ON pv.post_id = l.post_id
     WHERE l.user_id = $1
       AND pv.deleted_at IS NULL
       AND ($3::timestamptz IS NULL OR (l.created_at, l.post_id) < ($3, $4::uuid))
     ORDER BY l.created_at DESC, l.post_id DESC
     LIMIT $2`,
    [userId, limit, cursor?.likedAt ?? null, cursor?.postId ?? null],
  );
  return rows.map((row) => ({ ...toPostView(row), likedAt: row.liked_at }));
}

// --- Reposts ---

// POST /posts/:post_id/repost. Returns the user's repost of the post, creating it if needed, as
// { repostId, createdAt, created }, so the response is the same whether or not it was new (created tells the route
// 201 or 200, and later, whether to notify). Reposting again doesn't bump the time: the repost happened once, at
// createdAt, and that's where it sits in timelines. No checks: the service checks the post exists and isn't deleted.
// Find-or-insert in two statements, like messages' findOrCreateDirect: if a concurrent request is reposting the same
// post, the insert waits for it, and the SELECT (a new statement, so it sees the newly committed row) finds it.
// A single statement with a CTE couldn't, since its SELECT would use a snapshot from before the other insert.
// If the existing repost is removed between the two statements (an unrepost from another tab), the SELECT finds
// nothing and the loop tries the insert again.
// Errors: 23503 unknown user or post.
export async function addRepost(userId, postId, db = pool) {
  for (;;) {
    const { rows: inserted } = await db.query(
      `INSERT INTO reposts (user_id, post_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, post_id) DO NOTHING
       RETURNING repost_id AS "repostId", created_at AS "createdAt"`,
      [userId, postId],
    );
    if (inserted[0]) {
      return { ...inserted[0], created: true };
    }

    const { rows } = await db.query(
      `SELECT repost_id AS "repostId", created_at AS "createdAt"
       FROM reposts
       WHERE user_id = $1 AND post_id = $2`,
      [userId, postId],
    );
    if (rows[0]) {
      return { ...rows[0], created: false };
    }
  }
}

// DELETE /posts/:post_id/repost. Idempotent: un-reposting a post you never reposted, or one that doesn't exist, deletes
// nothing. Its timeline item goes with it; reposting again later is a new repost with a new id and time. Returns true
// if a repost was removed, false if there was none. Uses reposts_user_id_post_id_key. A malformed id throws 22P02,
// so routes validate ids first.
export async function removeRepost(userId, postId, db = pool) {
  const { rowCount } = await db.query(
    `DELETE FROM reposts
     WHERE user_id = $1 AND post_id = $2`,
    [userId, postId],
  );
  return rowCount > 0;
}

// --- Bookmarks ---

// POST /posts/:post_id/bookmark. Idempotent, like addLike: bookmarking twice keeps the first bookmark and its time,
// so the post doesn't jump to the top of your bookmarks. Returns true if the bookmark is new, false if it was already
// there. No checks: the service checks the post exists and isn't deleted first. Errors: 23503 unknown user or post.
export async function addBookmark(userId, postId, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO bookmarks (user_id, post_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING 1`,
    [userId, postId],
  );
  return rows.length > 0;
}

// DELETE /posts/:post_id/bookmark. Idempotent: removing a bookmark you don't have, or one for a post that doesn't
// exist, deletes nothing. Returns true if a bookmark was removed, false if there was none. Uses the primary key.
// A malformed id throws 22P02, so routes validate ids first.
export async function removeBookmark(userId, postId, db = pool) {
  const { rowCount } = await db.query(
    `DELETE FROM bookmarks
     WHERE user_id = $1 AND post_id = $2`,
    [userId, postId],
  );
  return rowCount > 0;
}

// GET /users/me/bookmarks. The posts a user bookmarked, as post views each with bookmarkedAt, newest bookmark first.
// Built like listLikedPosts. Deleted posts are hidden. [] if none. Private: the service only ever passes the caller's
// own id.
// cursor: the last row's { bookmarkedAt, postId } from the previous page; null for the first page. Newest first, so
// the next page is the rows *before* the cursor (<), post_id breaking ties.
// Uses bookmarks_user_id_created_at_idx (user_id, created_at DESC, post_id DESC).
export async function listBookmarkedPosts(userId, { limit, cursor = null }, db = pool) {
  const { rows } = await db.query(
    `SELECT pv.*, b.created_at AS bookmarked_at
     FROM bookmarks b
     JOIN (${POST_VIEW_SELECT}) pv ON pv.post_id = b.post_id
     WHERE b.user_id = $1
       AND pv.deleted_at IS NULL
       AND ($3::timestamptz IS NULL OR (b.created_at, b.post_id) < ($3, $4::uuid))
     ORDER BY b.created_at DESC, b.post_id DESC
     LIMIT $2`,
    [userId, limit, cursor?.bookmarkedAt ?? null, cursor?.postId ?? null],
  );
  return rows.map((row) => ({ ...toPostView(row), bookmarkedAt: row.bookmarked_at }));
}
