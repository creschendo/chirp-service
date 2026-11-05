# engagement module

## Responsibility

- Likes, reposts and bookmarks: user → post relationships with a time
- Counts and viewer flags ("did I like this") for post views
- Quote posts and replies are posts, so they live in the `posts` module

## Data

Migration `005_create-engagement.js`:

- `likes`, `bookmarks`: primary key `(user_id, post_id)`, so one per user per post.
- `reposts`: its own `repost_id`, plus `UNIQUE (user_id, post_id)`. A repost is an item in timelines, and timeline
  items are keyed by `(activity time, item id)`, where the item id is a `post_id` or a `repost_id`.
- Each has an index on `post_id` (counts and the cascade) and on `(user_id, created_at DESC, …)` (lists, timelines).
- Cascades: deleting a user removes their engagement; hard-deleting a post removes its engagement. Posts are normally
  soft-deleted, so engagement on a deleted post stays in the tables, hidden by every query.

## Status

Implemented and tested: store, service, schemas and all eight routes. Not built yet: counts and viewer flags in
responses (see the plan below).

## Routes (mounted at `/` in app.js)

| Route                             | Auth     | Success                                                  | Errors                        |
| --------------------------------- | -------- | -------------------------------------------------------- | ----------------------------- |
| `POST /posts/:post_id/like`       | required | 204                                                      | 400, 401, 404 missing/deleted |
| `DELETE /posts/:post_id/like`     | required | 204                                                      | 400, 401                      |
| `POST /posts/:post_id/repost`     | required | 201 new / 200 existing + `{ repostId, repostedAt }`      | 400, 401, 404 missing/deleted |
| `DELETE /posts/:post_id/repost`   | required | 204                                                      | 400, 401                      |
| `POST /posts/:post_id/bookmark`   | required | 204                                                      | 400, 401, 404 missing/deleted |
| `DELETE /posts/:post_id/bookmark` | required | 204                                                      | 400, 401                      |
| `GET /users/:username/likes`      | public   | 200 + `{ items, nextCursor }`, items with `likedAt`      | 400, 404 no such user         |
| `GET /users/me/bookmarks`         | required | 200 + `{ items, nextCursor }`, items with `bookmarkedAt` | 400, 401                      |

- Mounted at `/` because the routes live under two prefixes. They have more path segments than the posts router's
  `/:post_id` and the users router's `/:username`, so they don't collide; `me` is too short to be a username.
- Lists are newest first by like or bookmark time; `?limit=` is 1–100 (default 20), `?cursor=` is the previous page's
  `nextCursor`. Deleted posts are left out.

## Decisions

- Doing anything twice, or undoing something you never did, succeeds with no change.
- You can like, repost and bookmark your own posts.
- A repost is new activity: a separate item in timelines at the time of the repost, by the reposter. The original post
  isn't changed and stays at its own time. Reposting again doesn't move it.
- Likes are public; bookmarks are private and never notify.
- A missing or deleted post can't be liked, reposted or bookmarked (404, the same for both), but undoing always works.
- Counts are computed on read, never stored. `replyCount` is direct replies only, matching what
  `GET /posts/:post_id/replies` lists; `replyCount` and `quoteCount` count live posts only.
- Counts and flags come from one extra query per page (`getEngagement`), not from columns in `POST_VIEW_SELECT`, so
  posts doesn't need to know engagement's tables and queries don't need the viewer as a parameter.

## Plan: counts and viewer flags in responses

`withEngagement(viewerId, posts)` is built and tested but nothing calls it yet. Wiring it in:

**1. Optional-auth middleware** (`middleware/auth.js`, next to `requireAuth`)

- A valid token sets `req.userId`; no token sets `req.userId = null` and continues (no 401).
- An expired or forged token is treated as logged out, not a 401: a public page shouldn't break over a stale cookie,
  and the client's refresh flow deals with expiry. (Open: confirm this, since it changes what the client sees when a
  cookie expires.)
- Tests for all three cases.

**2. Call `withEngagement` in the service, after `toPage`**, so only returned items get counts:

| Endpoint                      | Route change      | Service change                     | Viewer                    |
| ----------------------------- | ----------------- | ---------------------------------- | ------------------------- |
| `GET /posts/:post_id`         | add optional auth | `getPost(viewerId, postId)`        | optional                  |
| `GET /posts/:post_id/replies` | add optional auth | `listReplies(viewerId, …)`         | optional                  |
| `POST /posts`                 | none              | wrap the returned post             | the author (always zeros) |
| `GET /timeline`               | none              | `getHomeTimeline`                  | `req.userId`              |
| `GET /users/:username/posts`  | add optional auth | `getProfileTimeline(viewerId, …)`  | optional                  |
| `GET /users/:username/likes`  | add optional auth | `listLikes(viewerId, username, …)` | optional                  |
| `GET /users/me/bookmarks`     | none              | `listBookmarks`                    | `req.userId`              |

- Not included: `DELETE` routes (no body), the embedded `quotedPost` (no counts), messages.
- The posts and timeline services import `withEngagement` from this service. That's not an import cycle (this service
  imports the posts _store_, not the posts service); it does break the "services don't import services" habit, which
  is accepted here because services are where responses are assembled.

**3. Tests**

- Update exact-shape assertions (`toEqual({...})`) on post views in the posts, timeline and engagement API tests and
  the service tests to include `engagement`.
- New, per endpoint: flags are the viewer's own (Alice `liked: true`, Bob `false`); logged out gets real counts and
  false flags; a stale or forged token on a public route acts as logged out; a deleted post gets `engagement: null`
  (single post, replies); a repost item shows the original's counts.

**4. Docs**

- Add `engagement` to the response shapes in the posts, timeline and engagement READMEs and route comments.
- Tick "Engagement counts and viewer flags in timelines" in `docs/roadmap.md`.

**Order:** the middleware; then `GET /timeline` and `GET /users/me/bookmarks` (they already have a viewer, no route
change); then the public routes; then `POST /posts`. Each step is testable on its own.

## Files

- `routes.js`: the eight routes
- `service.js`: `like`, `unlike`, `repost`, `unrepost`, `bookmark`, `unbookmark`, `listLikes`, `listBookmarks`,
  `withEngagement`
- `store.js`: `addLike`, `removeLike`, `addRepost` (find-or-insert), `removeRepost`, `addBookmark`, `removeBookmark`,
  `getEngagement`, `listLikedPosts`, `listBookmarkedPosts`
- `schemas.js`: `likesQuerySchema`, `bookmarksQuerySchema`; the routes reuse `postIdParamSchema` (posts) and
  `usernameParamSchema` (users)

## Interacts with

- `posts`: the target of engagement; `getPostById` for the live check, `POST_VIEW_SELECT` / `toPostView` for lists
- `users`: `getProfileByUsername` for the likes list
- `timeline`: its store reads `reposts` to merge reposts into both timelines
- `notifications` (later): a like or repost notifies the author only when it's new and not their own post

## Tests

- `tests/store/engagement.test.js`: writes, idempotency, `getEngagement`, both lists with cursor tie-breaks; todos for
  the cascades
- `tests/service/engagement.test.js`: 404s, undo always working, concurrent reposts, lists, `withEngagement`
- `tests/schemas/engagement.test.js`: both query schemas
- `tests/api/engagement.test.js`: every route over HTTP

## Deferred

- Lists of who liked or reposted a post; quotes of a post as a list
- Notification batching ("5 people liked your post")
