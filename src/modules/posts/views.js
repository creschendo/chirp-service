// Post views: a post as the API returns it, with its author and, for quotes, the quoted post embedded one level
// deep. Every query that returns posts to clients is POST_VIEW_SELECT + its own WHERE / ORDER BY / LIMIT, with
// rows mapped by toPostView, so the shape is identical everywhere (posts store, timeline store).
// Lives outside store.js because stores don't import other stores.
//
// Selected as flat, prefixed columns and nested in toPostView, so every createdAt stays a Date (Postgres JSON
// functions would turn nested timestamps into strings).
//   p = the post, a = its author, q = the quoted post, qa = the quoted post's author
export const POST_VIEW_SELECT = `
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
export function toPostView(row) {
  const post = postFields(row, '', 'a_');
  const quotedPost = !post.deleted && row.q_post_id ? postFields(row, 'q_', 'qa_') : null;
  return { ...post, quotedPost };
}
