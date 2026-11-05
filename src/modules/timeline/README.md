# timeline module

## Responsibility

- Assembling the home timeline (you + everyone you follow) and profile timelines (one user's posts and reposts)
- Owns no tables: read-only queries over `posts`, `reposts`, `follows` and `users` (fan-out on read)

## Status

Implemented and tested: home timeline, profile timeline, reposts in both.

## Routes (mounted at `/` in app.js)

| Route                        | Auth     | Success                       | Errors                                              |
| ---------------------------- | -------- | ----------------------------- | --------------------------------------------------- |
| `GET /timeline`              | required | 200 + `{ items, nextCursor }` | 400 invalid limit/cursor, 401                       |
| `GET /users/:username/posts` | public   | 200 + `{ items, nextCursor }` | 400 invalid username/limit/cursor, 404 no such user |

- Mounted at `/` because the two routes live under different prefixes. `/users/:username/posts` has more segments
  than the users router's `/:username` and differs from the follows router's `/followers` and `/following`, so the
  three routers sharing `/users` don't collide.
- `?limit=` is 1–100 (default 20); `?cursor=` is the previous page's `nextCursor`.

## What a timeline shows

Decided in [docs/timeline.md](../../../docs/timeline.md):

- **Originals and quote posts.** Replies stay inside their conversations (`GET /posts/:post_id/replies`).
- **Reposts are new activity:** a separate item at the time of the repost, shown as reposted by that user. The
  original post isn't changed and stays at its own time, so a post can appear twice. Reposts of replies are shown.
- **Home:** posts and reposts by the viewer and everyone they follow. Following is one-way: being followed doesn't
  add someone's posts. A post reposted by several people you follow shows once, as the newest of those reposts.
- **Profile:** that user's posts and reposts.
- **Deleted posts are hidden**, and so are reposts of them. A quote of a deleted post still appears, embedding it as
  deleted.
- **Newest first** by activity time (a post's `created_at`, or the repost's), the item's id breaking ties.
- **Items are post views** (the `GET /posts/:post_id` shape) plus `repost`: `{ repostId, user, repostedAt }` for a
  repost, `null` for a plain post. The client renders the post the same way everywhere and adds a "reposted by" line.

## How it works

**Fan-out on read:** each request builds the timeline with one query; nothing is copied into per-user timeline
tables. Following, unfollowing, reposting and deleting take effect on the next request. The cost grows with how many
accounts the viewer follows, which is fine at this scale; fan-out on write (or a cache) is the fallback if the home
query gets slow.

Each query is a `UNION ALL` of two branches, joined to the posts module's `POST_VIEW_SELECT` (from `posts/views.js`,
so author, quoted post and reposter come in the same query: no N+1):

- **Posts:** live originals and quotes by the profile's user, or by the viewer and everyone they follow.
- **Reposts:** that user's reposts, or for home, the newest repost of each post by the viewer or anyone they follow
  (`DISTINCT ON (post_id)`, taken before the cursor filter so a post can't return on a later page through an older
  repost).

Every item has a sort key `(activity_at, item_id)`: a post's `(created_at, post_id)` or a repost's
`(created_at, repost_id)`. Each branch filters by the cursor and takes its newest `limit` rows before the union, so
only `2 x limit` rows are sorted.

- **Pagination:** newest first, so the next page is the items _before_ the cursor (`<`). The cursor is the last
  item's `{ activityAt, itemId }`, from the repost if it's a repost; items arriving while you scroll don't shift later
  pages. The service fetches `limit + 1` and builds the page with `toPage` from `src/pagination.js`.
- **Indexes:** posts come through `posts_author_id_created_at_idx` and the profile's reposts through
  `reposts_user_id_created_at_idx`, both in `(time DESC, id DESC)` order, so pages jump straight to the cursor. The
  home query finds who the viewer follows through the follows primary key. Its repost branch reads all of those
  users' reposts on every page to pick the newest per post: fine at this scale.

## Files

- `routes.js`: the two routes
- `service.js`: `getHomeTimeline`, `getProfileTimeline` (resolves the username first, `null` -> 404)
- `store.js`: `listHomePosts`, `listProfilePosts`
- `schemas.js`: `timelineQuerySchema` (cursor `{ activityAt, itemId }`); the username param reuses
  `usernameParamSchema` from users

## Interacts with

- `posts`: `POST_VIEW_SELECT` and `toPostView` from `posts/views.js` (a shared helper, since stores don't import
  other stores)
- `follows`: the home query reads the `follows` table
- `users`: `getProfileByUsername` to resolve profile usernames; author fields come through the post view joins
- `engagement`: the store reads its `reposts` table; counts and viewer flags (`withEngagement`) aren't built yet

## Tests

- `tests/store/timeline.test.js`: who appears, order, replies/deleted excluded, reposts (placement, dedupe, deleted
  targets), cursor tie-breaks across posts and reposts
- `tests/service/timeline.test.js`: paging with `nextCursor`, username lookup, response shape
- `tests/schemas/timeline.test.js`: query validation
- `tests/api/timeline.test.js`: both routes end to end (posting, following and deleting through the API)

## Open questions / not built yet

- **Counts and viewer flags** per item (likes, reposts, "you liked this"): added in `POST_VIEW_SELECT` / `toPostView`,
  so every endpoint gets them
- **A profile "Replies" tab**, and replies between people you follow in the home timeline
- **"New posts since"** for pull-to-refresh
- **Performance:** check the home query with `EXPLAIN ANALYZE` for viewers following thousands of accounts
