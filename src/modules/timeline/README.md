# timeline module

## Responsibility

- Assembling the home timeline (you + everyone you follow) and profile timelines (one user's posts)
- Owns no tables: read-only queries over `posts`, `follows` and `users` (fan-out on read)

## Status

Implemented and tested: home timeline, profile timeline.

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
- **Home:** posts by the viewer and everyone they follow. Following is one-way: being followed doesn't add someone's
  posts.
- **Profile:** that user's posts.
- **Deleted posts are hidden.** A quote of a deleted post still appears, embedding it as deleted.
- **Newest first** by `created_at`, `post_id` breaking ties.
- **Items are post views**, exactly the `GET /posts/:post_id` shape, so the client renders them with the same
  component everywhere.

## How it works

**Fan-out on read:** each request builds the timeline with one query; nothing is copied into per-user timeline
tables. Following, unfollowing and deleting take effect on the next request. The cost grows with how many accounts
the viewer follows, which is fine at this scale; fan-out on write (or a cache) is the fallback if the home query gets
slow.

Both queries are the posts module's `POST_VIEW_SELECT` (from `posts/views.js`, so author and quoted post are joined
in: no N+1) plus a shared filter, differing only in whose posts:

```sql
-- shared
p.parent_post_id IS NULL AND p.deleted_at IS NULL
AND ($cursor IS NULL OR (p.created_at, p.post_id) < (cursor.createdAt, cursor.postId))
ORDER BY p.created_at DESC, p.post_id DESC LIMIT $limit

-- profile
WHERE p.author_id = $user

-- home
WHERE p.author_id = $viewer OR p.author_id IN (SELECT followed_id FROM follows WHERE follower_id = $viewer)
```

- **Pagination:** newest first, so the next page is the rows _before_ the cursor (`<`). The cursor is the last item's
  `{ createdAt, postId }`; posts arriving while you scroll don't shift later pages. The service fetches `limit + 1`
  and builds the page with `toPage` from `src/pagination.js`.
- **Indexes:** the profile query uses `posts_author_id_created_at_idx` (`author_id, created_at DESC, post_id DESC`),
  so pages jump straight to the cursor. The home query finds who the viewer follows through the follows primary key,
  then each author's recent posts through the same author index, and Postgres merges and sorts them.

## Files

- `routes.js`: the two routes
- `service.js`: `getHomeTimeline`, `getProfileTimeline` (resolves the username first, `null` -> 404)
- `store.js`: `listHomePosts`, `listProfilePosts`
- `schemas.js`: `timelineQuerySchema` (cursor `{ createdAt, postId }`); the username param reuses
  `usernameParamSchema` from users

## Interacts with

- `posts`: `POST_VIEW_SELECT` and `toPostView` from `posts/views.js` (a shared helper, since stores don't import
  other stores)
- `follows`: the home query reads the `follows` table
- `users`: `getProfileByUsername` to resolve profile usernames; author fields come through the post view joins
- `engagement`: reposts, counts and viewer flags (not built yet)

## Tests

- `tests/store/timeline.test.js`: who appears, order, replies/deleted excluded, cursor tie-breaks
- `tests/service/timeline.test.js`: paging with `nextCursor`, username lookup, response shape
- `tests/schemas/timeline.test.js`: query validation
- `tests/api/timeline.test.js`: both routes end to end (posting, following and deleting through the API)

## Open questions / not built yet

- **Reposts** (engagement): merge them into both timelines at repost time, showing each post once even if several
  followed users reposted it. The hardest query in the project: a `UNION` of posts and reposts with a shared sort key.
- **Counts and viewer flags** per item (likes, reposts, "you liked this"): added in `POST_VIEW_SELECT` / `toPostView`,
  so every endpoint gets them
- **A profile "Replies" tab**, and replies between people you follow in the home timeline
- **"New posts since"** for pull-to-refresh
- **Performance:** check the home query with `EXPLAIN ANALYZE` for viewers following thousands of accounts
