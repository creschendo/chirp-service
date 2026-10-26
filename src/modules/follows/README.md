# follows module

## Responsibility

- Following and unfollowing users, and listing a user's followers and following
- Owns the `follows` table: one row per `(follower_id, followed_id)`, with `created_at`

## Status

Implemented and tested: follow, unfollow, followers list, following list.

## Routes (mounted at `/users`, alongside the users router)

| Route                                 | Auth     | Success             | Errors                                              |
| ------------------------------------- | -------- | ------------------- | --------------------------------------------------- |
| `POST /users/me/following/:user_id`   | required | 204 (idempotent)    | 400 invalid id or yourself, 401, 404 no such user   |
| `DELETE /users/me/following/:user_id` | required | 204 (idempotent)    | 400 invalid id, 401                                 |
| `GET /users/:username/followers`      | public   | 200 + page of users | 400 invalid username/limit/cursor, 404 no such user |
| `GET /users/:username/following`      | public   | 200 + page of users | 400 invalid username/limit/cursor, 404 no such user |

- Write routes take a `user_id` (from a profile response); read routes take a `username` (what the client's URL has).
- These paths have more segments than the users router's `/:username`, so the two routers don't collide.

## Lists and pagination

```json
{
  "items": [{ "userId": "…", "username": "dave", "displayName": "Dave", "followedAt": "2026-10-24T10:09:00.000Z" }],
  "nextCursor": "eyJmb2xsb3dlZEF0Ijoi…"
}
```

- Most recent follow first. `?limit=` is 1–100 (default 20).
- `nextCursor` is an opaque string: send it back as `?cursor=` for the next page; `null` means there are no more.
- Inside, the cursor is the last row's `{ followedAt, userId }`. The query continues after it with
  `(created_at, user_id) < (cursor)`, so rows with equal timestamps are never skipped or repeated.
- The service fetches `limit + 1` rows to know whether another page exists. Shared helpers live in
  `src/pagination.js`.

## Rules

- **Idempotent:** following someone you already follow, or unfollowing someone you don't, is a no-op (still 204).
  The store still returns `true`/`false`, so notifications can fire only on a new follow.
- **Self-follow:** rejected by the service (400) and by the `follows_no_self_follow` constraint.
- **Unknown user:** the foreign key fails (`23503`), which the service maps to 404.
- **Deleting a user** deletes their follows in both directions (`ON DELETE CASCADE`).

## Files

- `routes.js`: the four routes; the two list routes share `listHandler`
- `service.js`: `follow`, `unfollow`, `getFollowers`, `getFollowing` (resolve the username, then page)
- `store.js` (`follows` table): `follow`, `unfollow`, `listFollowers`, `listFollowing`, `isFollowing`,
  `countFollows`
- `schemas.js`: `userIdParamSchema`, `followListQuerySchema`

## Interacts with

- `users`: `getProfileByUsername` to resolve usernames; lists join `users` read-only for public fields
- `timeline`: who appears in the home timeline (not built yet)
- `notifications`: "new follower" notifications (not built yet)

## Tests

- `tests/store/follows.test.js`: follows store, including cursor tie-breaks
- `tests/api/follows.test.js`: all four routes, including paging through lists with `nextCursor`

## Open questions / not built yet

- `isFollowing` and `countFollows` exist but aren't used yet (profile counts and viewer flags)
- Pagination index: the lists sort by `created_at`, but the indexes are `(followed_id, follower_id)` and the primary
  key, so Postgres sorts each user's follows. Fine at this scale; an index on
  `(followed_id, created_at DESC, follower_id DESC)` (and the mirror for following) would let pages jump straight
  to the cursor
- Private accounts and follow requests: out of scope for now
