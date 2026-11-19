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

Implemented and tested: store, service, schemas, all eight routes, and counts and viewer flags in every response
that returns posts.

## Routes (mounted at `/` in app.js)

| Route                             | Auth     | Success                                                  | Errors                        |
| --------------------------------- | -------- | -------------------------------------------------------- | ----------------------------- |
| `POST /posts/:post_id/like`       | required | 204                                                      | 400, 401, 404 missing/deleted |
| `DELETE /posts/:post_id/like`     | required | 204                                                      | 400, 401                      |
| `POST /posts/:post_id/repost`     | required | 201 new / 200 existing + `{ repostId, repostedAt }`      | 400, 401, 404 missing/deleted |
| `DELETE /posts/:post_id/repost`   | required | 204                                                      | 400, 401                      |
| `POST /posts/:post_id/bookmark`   | required | 204                                                      | 400, 401, 404 missing/deleted |
| `DELETE /posts/:post_id/bookmark` | required | 204                                                      | 400, 401                      |
| `GET /users/:username/likes`      | optional | 200 + `{ items, nextCursor }`, items with `likedAt`      | 400, 404 no such user         |
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
- A new like or repost notifies the post's author (not yourself, not on a repeat); undoing it deletes the
  notification.
- A missing or deleted post can't be liked, reposted or bookmarked (404, the same for both), but undoing always works.
- Counts are computed on read, never stored. `replyCount` is direct replies only, matching what
  `GET /posts/:post_id/replies` lists; `replyCount` and `quoteCount` count live posts only.
- Counts and flags come from one extra query per page (`getEngagement`), not from columns in `POST_VIEW_SELECT`, so
  posts doesn't need to know engagement's tables and queries don't need the viewer as a parameter.

## Counts and viewer flags in responses

Every post view a response returns carries `engagement: { likeCount, repostCount, replyCount, quoteCount, liked,
reposted, bookmarked }`, added by `withEngagement(viewerId, posts)` in the service after `toPage`, so only returned
items are counted. One extra query per page, however many items.

| Endpoint                      | Auth     | Viewer                                              |
| ----------------------------- | -------- | --------------------------------------------------- |
| `GET /posts/:post_id`         | optional | the logged-in user, or null                         |
| `GET /posts/:post_id/replies` | optional | the logged-in user, or null                         |
| `POST /posts`                 | required | the author (a new post is always all zeros)         |
| `GET /timeline`               | required | the logged-in user                                  |
| `GET /users/:username/posts`  | optional | the logged-in user, or null                         |
| `GET /users/:username/likes`  | optional | whoever is looking, not the user whose likes        |
| `GET /users/me/bookmarks`     | required | the logged-in user (so `bookmarked` is always true) |

- **Optional auth** (`optionalAuth` in `middleware/auth.js`): a valid token sets `req.userId`; no token, or an
  expired, malformed or forged one, sets it to null and the request continues. A public page still loads with a stale
  cookie (decided); the client's refresh flow deals with expiry. Logged out, counts are real and every flag is false.
- **Deleted posts** (a single deleted post, deleted replies) get `engagement: null`.
- **Repost items** carry the original post's numbers, since their `postId` is the original's.
- **Not included:** `DELETE` routes (no body), the embedded `quotedPost`, messages.
- The posts and timeline services import `withEngagement` from this service. That's not an import cycle (this service
  imports the posts _store_, not the posts service); it breaks the "services don't import services" habit, accepted
  because services are where responses are assembled.

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
- `notifications`: `like` and `repost` call `notify` when the like or repost is new (it skips your own post);
  `unlike` and `unrepost` call `removeNotification` when something was removed. Each write and its notification
  share one `withTransaction`. Bookmarks never notify.

## Tests

- `tests/store/engagement.test.js`: writes, idempotency, `getEngagement`, both lists with cursor tie-breaks; todos for
  the cascades
- `tests/service/engagement.test.js`: 404s, undo always working, concurrent reposts, lists, `withEngagement`,
  notifications (created once, not for yourself, removed on undo, concurrent attempts)
- `tests/schemas/engagement.test.js`: both query schemas
- `tests/api/engagement.test.js`: every route over HTTP, and engagement in every response that returns posts

## Deferred

- Lists of who liked or reposted a post; quotes of a post as a list
- Notification batching ("5 people liked your post")
