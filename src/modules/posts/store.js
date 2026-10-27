// Database access for the posts module.
// Owns the posts table; views join users read-only for author fields (see views.js). Every function takes an
// optional `db` (defaults to the pool) so a service can run it inside withTransaction.
import { pool } from '../../db/index.js';
import { POST_VIEW_SELECT, toPostView } from './views.js';

// Originals, replies and quotes all go through here; which IDs are set decides the kind. Returns { postId }.
// The service computes rootPostId and checks the parent/quoted post is live. Constraints are the backstop:
// 23514 posts_reply_has_root / posts_content_length, 23503 unknown author, parent or quoted post.
export async function createPost(fields, db = pool) {
  const { authorId, content, parentPostId = null, rootPostId = null, quotedPostId = null } = fields;
  const { rows } = await db.query(
    `INSERT INTO posts (author_id, content, parent_post_id, root_post_id, quoted_post_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING post_id AS "postId"`,
    [authorId, content, parentPostId, rootPostId, quotedPostId],
  );
  return rows[0];
}

// The post's own columns, for the service's checks (exists? deleted? whose? which thread?), not for responses:
// no content and no author details. Returns null if the post doesn't exist; a deleted post is still returned,
// with deletedAt set. A malformed id throws 22P02, so routes validate ids first.
export async function getPostById(postId, db = pool) {
  const { rows } = await db.query(
    `SELECT post_id        AS "postId",
            author_id      AS "authorId",
            parent_post_id AS "parentPostId",
            root_post_id   AS "rootPostId",
            quoted_post_id AS "quotedPostId",
            deleted_at     AS "deletedAt"
     FROM posts
     WHERE post_id = $1`,
    [postId],
  );
  return rows[0] ?? null;
}

// GET /posts/:post_id. Returns the post view, or null if the post never existed (deleted posts are returned,
// with deleted: true). Never includes email or password hash.
export async function getPostView(postId, db = pool) {
  const { rows } = await db.query(`${POST_VIEW_SELECT} WHERE p.post_id = $1`, [postId]);
  return rows[0] ? toPostView(rows[0]) : null;
}

// GET /posts/:post_id/replies. Direct replies only (not replies to replies), as post views, oldest first so a
// conversation reads top to bottom. Deleted replies are included, shown as deleted. [] if there are none or the
// parent doesn't exist (404 is decided by the service).
// cursor: the last row's { createdAt, postId } from the previous page; null for the first page. Ascending order,
// so the next page is the rows *after* the cursor (>), with post_id breaking ties between equal timestamps.
// Uses posts_parent_post_id_created_at_idx.
export async function listReplies(parentPostId, { limit, cursor = null }, db = pool) {
  const { rows } = await db.query(
    `${POST_VIEW_SELECT}
     WHERE p.parent_post_id = $1
       AND ($3::timestamptz IS NULL OR (p.created_at, p.post_id) > ($3, $4::uuid))
     ORDER BY p.created_at, p.post_id
     LIMIT $2`,
    [parentPostId, limit, cursor?.createdAt ?? null, cursor?.postId ?? null],
  );
  return rows.map(toPostView);
}

// DELETE /posts/:post_id. Soft delete: the row stays so replies and quotes still point at something, but content
// is cleared (posts_content_iff_live requires both changes together). Only the author's own, live post changes:
// returns true if it was deleted now, false if it's missing, someone else's, or already deleted. The service uses
// getPostById first to tell those apart (404 / 403 / no-op).
export async function softDeletePost(postId, authorId, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE posts
     SET deleted_at = now(), content = NULL
     WHERE post_id = $1 AND author_id = $2 AND deleted_at IS NULL`,
    [postId, authorId],
  );
  return rowCount > 0;
}
