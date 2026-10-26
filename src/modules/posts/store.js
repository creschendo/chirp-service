// Database access for the posts module.
// Owns the posts table; views join users read-only for author fields. Every function takes an optional
// `db` (defaults to the pool) so a service can run it inside withTransaction.
import { pool } from '../../db/index.js';

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

// Post views: a post as the API returns it, with its author and, for quotes, the quoted post embedded one level
// deep. Selected as flat, prefixed columns and nested in toPostView, so every createdAt stays a Date (Postgres
// JSON functions would turn nested timestamps into strings). Shared by getPostView and, later, listReplies.
//   p = the post, a = its author, q = the quoted post, qa = the quoted post's author
const POST_VIEW_SELECT = `
  SELECT p.post_id, p.content, p.parent_post_id, p.root_post_id, p.quoted_post_id, p.created_at, p.deleted_at,
         a.user_id  AS a_user_id,  a.username  AS a_username,  a.display_name  AS a_display_name,
         q.post_id  AS q_post_id,  q.content   AS q_content,   q.parent_post_id AS q_parent_post_id,
         q.root_post_id AS q_root_post_id, q.quoted_post_id AS q_quoted_post_id,
         q.created_at AS q_created_at, q.deleted_at AS q_deleted_at,
         qa.user_id AS qa_user_id, qa.username AS qa_username, qa.display_name AS qa_display_name
  FROM posts p
  JOIN users a ON a.user_id = p.author_id
  LEFT JOIN posts q ON q.post_id = p.quoted_post_id
  LEFT JOIN users qa ON qa.user_id = q.author_id
`;

// One post's fields from a row. post = column prefix for the post ('' or 'q_'), author = prefix for its author.
// A deleted post keeps its id, thread links and time (so threads still resolve) but loses author and content.
function postFields(row, post, author) {
  const deleted = row[`${post}deleted_at`] !== null;
  return {
    postId: row[`${post}post_id`],
    author: deleted
      ? null
      : {
          userId: row[`${author}user_id`],
          username: row[`${author}username`],
          displayName: row[`${author}display_name`],
        },
    content: row[`${post}content`],
    parentPostId: row[`${post}parent_post_id`],
    rootPostId: row[`${post}root_post_id`],
    quotedPostId: deleted ? null : row[`${post}quoted_post_id`],
    createdAt: row[`${post}created_at`],
    deleted,
  };
}

// { ...post, quotedPost }. The embedded quoted post doesn't embed its own quote; its quotedPostId tells the
// client it's a quote too. A deleted post shows no quote.
function toPostView(row) {
  const post = postFields(row, '', 'a_');
  const quotedPost = !post.deleted && row.q_post_id ? postFields(row, 'q_', 'qa_') : null;
  return { ...post, quotedPost };
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
