# posts module

## Responsibility

- Creating, viewing and deleting posts, and listing a post's replies
- Owns the `posts` table. Originals, replies and quote posts are all rows in it; which ids are set decides the kind

## Status

Implemented and tested: create (original, reply, quote), view one post, soft delete, list replies.

## Routes (mounted at `/posts`)

| Route                         | Auth        | Success                       | Errors                                              |
| ----------------------------- | ----------- | ----------------------------- | --------------------------------------------------- |
| `POST /posts`                 | required    | 201 + post view               | 400 invalid input, 401, 404 parent/quoted post gone |
| `GET /posts/:post_id`         | public      | 200 + post view               | 400 invalid id, 404 never existed                   |
| `DELETE /posts/:post_id`      | author only | 204 (also if already deleted) | 400 invalid id, 401, 403 not yours, 404 not found   |
| `GET /posts/:post_id/replies` | public      | 200 + `{ items, nextCursor }` | 400 invalid id/query, 404 never existed             |

`POST /posts` body: `{ content, parentPostId?, quotedPostId? }`. `parentPostId` makes it a reply, `quotedPostId` a
quote; not both. The author always comes from the access token.

A profile's posts (`GET /users/:username/posts`) belong to the `timeline` module.

## The model

| Kind     | `parent_post_id`  | `root_post_id`                   | `quoted_post_id` |
| -------- | ----------------- | -------------------------------- | ---------------- |
| Original | `null`            | `null`                           | `null`           |
| Reply    | the post answered | the conversation's original post | `null`           |
| Quote    | `null`            | `null`                           | the quoted post  |

- **Replies are posts** (Twitter's model), so they can be replied to, quoted, liked and reposted like any post.
- **Nesting is unlimited.** A reply to a reply gets the parent's root, so a whole conversation shares one
  `root_post_id`: "everything in this thread" is one indexed lookup.
- **Quotes** start their own conversation and can quote anything live, including replies and other quotes.
- **Reposts** will be a separate `reposts` table in the `engagement` module (a relationship, not content).

Decisions are recorded in [docs/database-schema.md](../../../docs/database-schema.md).

## Post view (the API shape)

```json
{
  "postId": "…",
  "author": { "userId": "…", "username": "alice", "displayName": "Alice" },
  "content": "Absolutely not",
  "parentPostId": null,
  "rootPostId": null,
  "quotedPostId": "…",
  "createdAt": "2026-10-25T10:05:00.000Z",
  "deleted": false,
  "quotedPost": { "postId": "…", "author": { … }, "content": "…", "quotedPostId": null, "deleted": false, … }
}
```

- `quotedPost` is embedded **one level deep**. If it's a quote itself, its `quotedPostId` says so, but its quote
  isn't nested.
- Every endpoint returning posts builds them from `POST_VIEW_SELECT` (one query joining the author, the quoted post
  and its author) and `toPostView`, so the shape is identical everywhere. Nesting happens in JavaScript so every
  `createdAt` stays a `Date` until `res.json` serializes it.
- Never includes email or password hash.

## Deletion

- **Soft delete:** `deleted_at` is set and `content` cleared (the `posts_content_iff_live` constraint requires both).
  The row stays, so replies and quotes keep pointing at it.
- A deleted post is still returned, as `{ postId, parentPostId, rootPostId, createdAt, deleted: true }` with
  `author`, `content`, `quotedPostId` and `quotedPost` all `null`. Links and threads keep resolving; 404 only means
  a post never existed.
- Deleted posts can't be replied to or quoted (404, the same as missing).
- Only the author can delete (403 otherwise, checked before "already deleted").

## Replies list

- Direct replies only (not replies to replies), **oldest first**, so a conversation reads top to bottom.
- Cursor pagination like the follows lists: `?limit=` 1–100 (default 20), opaque `nextCursor`. Inside it is the
  last reply's `{ createdAt, postId }`; the next page is everything after it, `(created_at, post_id) > (cursor)`.
- Uses the `(parent_post_id, created_at, post_id)` index, so pages jump straight to the cursor.
- Deleted replies are listed as deleted; a deleted post still lists its replies.

## Rules

- Content: trimmed, 1–280 characters (`posts_content_length`).
- `created_at` is `timestamptz(3)` so pagination cursors round-trip exactly through JavaScript `Date`s.

## Files

- `routes.js`: the four routes
- `service.js`: `createPost` (computes `rootPostId`, checks the parent/quoted post is live), `getPost`,
  `deletePost`, `listReplies`
- `store.js` (`posts` table): `createPost`, `getPostById` (raw columns for the service's checks), `getPostView`,
  `listReplies`, `softDeletePost`, plus `POST_VIEW_SELECT` / `toPostView`
- `schemas.js`: `createPostSchema`, `postIdParamSchema`, `repliesQuerySchema`

## Interacts with

- `users`: post views join `users` read-only for author fields
- `timeline`: profile and home timelines will reuse `POST_VIEW_SELECT` (not built yet)
- `engagement`: counts, "did I like this" flags and reposts (not built yet)
- `notifications`: reply and quote notifications to the other post's author (not built yet)

## Tests

- `tests/store/posts.test.js`: store, including constraints, views and cursor tie-breaks
- `tests/service/posts.test.js`: roots, 403/404 decisions, paging
- `tests/schemas/posts.test.js`: validation
- `tests/api/posts.test.js`: all four routes

## Open questions / not built yet

- Conversation view (everything under a root) and ancestor view ("show this reply in context")
- List of a post's quotes: needs an index on `(quoted_post_id, created_at DESC, post_id DESC)` to paginate well
- Editing posts
- Account deletion must soft-delete a user's posts first: hard-deleting a user whose posts others replied to or
  quoted fails on the foreign keys
