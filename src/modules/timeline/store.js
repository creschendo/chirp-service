// Database access for the timeline module.
// Owns no tables (fan-out on read, see docs/timeline.md): read-only queries over posts, follows and users.
// Items are post views built with the posts module's POST_VIEW_SELECT and toPostView, so they have exactly the shape
// of GET /posts/:post_id, and one query returns whole items (author and quoted post joined in): no N+1.
// Every function takes an optional `db` (defaults to the pool).
import { pool } from '../../db/index.js';
import { POST_VIEW_SELECT, toPostView } from '../posts/views.js';

// What a timeline shows: live originals and quotes, newest first. Replies stay in their conversations and deleted
// posts are hidden. The cursor is the last item's { createdAt, postId }; newest first, so the next page is the rows
// *before* it (<), post_id breaking ties. $2 = limit, $3/$4 = cursor (null on the first page).
const TIMELINE_FILTER = `
  p.parent_post_id IS NULL
  AND p.deleted_at IS NULL
  AND ($3::timestamptz IS NULL OR (p.created_at, p.post_id) < ($3, $4::uuid))
`;
const TIMELINE_ORDER = `ORDER BY p.created_at DESC, p.post_id DESC LIMIT $2`;

// GET /users/:username/posts: one author's posts. [] if none (404 for an unknown user is decided by the service).
// Uses posts_author_id_created_at_idx (author_id, created_at DESC, post_id DESC): pages jump to the cursor.
export async function listProfilePosts(authorId, { limit, cursor = null }, db = pool) {
  const { rows } = await db.query(
    `${POST_VIEW_SELECT}
     WHERE p.author_id = $1 AND ${TIMELINE_FILTER}
     ${TIMELINE_ORDER}`,
    [authorId, limit, cursor?.createdAt ?? null, cursor?.postId ?? null],
  );
  return rows.map(toPostView);
}

// GET /timeline: posts by the viewer and everyone they follow.
// The follows primary key (follower_id, followed_id) finds who the viewer follows; the author index finds each
// author's recent posts, which Postgres merges and sorts. Fine at this scale; check with EXPLAIN ANALYZE if a viewer
// follows thousands of accounts.
export async function listHomePosts(viewerId, { limit, cursor = null }, db = pool) {
  const { rows } = await db.query(
    `${POST_VIEW_SELECT}
     WHERE (p.author_id = $1 OR p.author_id IN (SELECT followed_id FROM follows WHERE follower_id = $1))
       AND ${TIMELINE_FILTER}
     ${TIMELINE_ORDER}`,
    [viewerId, limit, cursor?.createdAt ?? null, cursor?.postId ?? null],
  );
  return rows.map(toPostView);
}
