// Database access for the timeline module.
// Owns no tables (fan-out on read, see docs/timeline.md): read-only queries over posts, reposts, follows and users.
// Items are post views built with the posts module's POST_VIEW_SELECT and toPostView, so they have the shape of
// GET /posts/:post_id plus `repost`, and one query returns whole items (author, quoted post and reposter joined in):
// no N+1. Every function takes an optional `db` (defaults to the pool).
import { pool } from '../../db/index.js';
import { POST_VIEW_SELECT, toPostView } from '../posts/views.js';

// A timeline merges two kinds of item, newest first:
// - posts: live originals and quotes (replies stay in their conversations), at the post's created_at.
// - reposts: new activity at the time of the repost, shown as reposted by that user. The original post isn't changed
//   and stays where it was, so a post can appear twice: once as itself, once as a repost. Reposts of deleted posts
//   are hidden; reposts of replies are shown (reposting is a deliberate choice).
// Every item has a sort key (activity_at, item_id): a post's (created_at, post_id) or a repost's (created_at,
// repost_id). Both ids are uuids, so one cursor { activityAt, itemId } pages through both kinds; newest first, so the
// next page is the items *before* it (<), the id breaking ties. $2 = limit, $3/$4 = cursor (null on the first page).
//
// Each branch filters by the cursor and takes its own newest $2 rows using its index before the UNION, so Postgres
// never sorts more than 2 x limit rows; the outer query sorts those and keeps $2.
const BEFORE_CURSOR = (time, id) => `($3::timestamptz IS NULL OR (${time}, ${id}) < ($3, $4::uuid))`;

// Item columns: the post to show, the sort key, and the repost (NULL for a plain post).
const POST_ITEMS = (authorFilter) => `
  SELECT p.post_id, p.created_at AS activity_at, p.post_id AS item_id,
         NULL::uuid AS repost_id, NULL::uuid AS reposter_id
  FROM posts p
  WHERE ${authorFilter}
    AND p.parent_post_id IS NULL
    AND p.deleted_at IS NULL
    AND ${BEFORE_CURSOR('p.created_at', 'p.post_id')}
  ORDER BY p.created_at DESC, p.post_id DESC
  LIMIT $2
`;

// The merged page, as post views plus the reposter (ru). The item columns have their own names, so they sit next to
// the post view's without clashing.
const TIMELINE_PAGE = (postItems, repostItems) => `
  WITH items AS ((${postItems}) UNION ALL (${repostItems}))
  SELECT pv.*, i.activity_at, i.item_id, i.repost_id,
         ru.user_id AS r_user_id, ru.username AS r_username, ru.display_name AS r_display_name
  FROM items i
  JOIN (${POST_VIEW_SELECT}) pv ON pv.post_id = i.post_id
  LEFT JOIN users ru ON ru.user_id = i.reposter_id
  ORDER BY i.activity_at DESC, i.item_id DESC
  LIMIT $2
`;

// A post view plus repost: { repostId, user, repostedAt }, or null for a plain post.
function toTimelineItem(row) {
  return {
    ...toPostView(row),
    repost: row.repost_id
      ? {
          repostId: row.repost_id,
          user: { userId: row.r_user_id, username: row.r_username, displayName: row.r_display_name },
          repostedAt: row.activity_at,
        }
      : null,
  };
}

// GET /users/:username/posts: one user's posts and reposts. [] if none (404 for an unknown user is decided by the
// service). Uses posts_author_id_created_at_idx and reposts_user_id_created_at_idx, both in (time DESC, id DESC)
// order, so each branch jumps straight to the cursor.
export async function listProfilePosts(userId, { limit, cursor = null }, db = pool) {
  const reposts = `
    SELECT r.post_id, r.created_at AS activity_at, r.repost_id AS item_id, r.repost_id, r.user_id AS reposter_id
    FROM reposts r
    JOIN posts p ON p.post_id = r.post_id AND p.deleted_at IS NULL
    WHERE r.user_id = $1
      AND ${BEFORE_CURSOR('r.created_at', 'r.repost_id')}
    ORDER BY r.created_at DESC, r.repost_id DESC
    LIMIT $2
  `;
  const { rows } = await db.query(TIMELINE_PAGE(POST_ITEMS('p.author_id = $1'), reposts), [
    userId,
    limit,
    cursor?.activityAt ?? null,
    cursor?.itemId ?? null,
  ]);
  return rows.map(toTimelineItem);
}

// GET /timeline: posts and reposts by the viewer and everyone they follow.
// If several of them reposted the same post, only the newest of those reposts is shown (DISTINCT ON post_id). That
// pick happens before the cursor filter, so a post can't come back on a later page through an older repost of it.
// The follows primary key (follower_id, followed_id) finds who the viewer follows; the author and reposter indexes
// find their recent activity, which Postgres merges and sorts. The DISTINCT ON reads all of those users' reposts on
// every page: fine at this scale; check with EXPLAIN ANALYZE if a viewer follows thousands of accounts.
export async function listHomePosts(viewerId, { limit, cursor = null }, db = pool) {
  const visible = (column) =>
    `(${column} = $1 OR ${column} IN (SELECT followed_id FROM follows WHERE follower_id = $1))`;
  const reposts = `
    SELECT * FROM (
      SELECT DISTINCT ON (r.post_id)
             r.post_id, r.created_at AS activity_at, r.repost_id AS item_id, r.repost_id, r.user_id AS reposter_id
      FROM reposts r
      JOIN posts p ON p.post_id = r.post_id AND p.deleted_at IS NULL
      WHERE ${visible('r.user_id')}
      ORDER BY r.post_id, r.created_at DESC, r.repost_id DESC
    ) newest
    WHERE ${BEFORE_CURSOR('activity_at', 'item_id')}
    ORDER BY activity_at DESC, item_id DESC
    LIMIT $2
  `;
  const { rows } = await db.query(TIMELINE_PAGE(POST_ITEMS(visible('p.author_id')), reposts), [
    viewerId,
    limit,
    cursor?.activityAt ?? null,
    cursor?.itemId ?? null,
  ]);
  return rows.map(toTimelineItem);
}
