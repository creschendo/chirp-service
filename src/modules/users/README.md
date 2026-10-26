# users module

## Responsibility

- User accounts and public profiles: viewing a profile, the current user's account, editing your own profile
- Owns the `users` table: account (username, email), credentials (password hash) and public profile (display name,
  bio) in one row. Other modules read and write it only through `users/store.js`

## Status

Implemented and tested: `GET /users/me`, `PATCH /users/me`, `GET /users/:username`.

## Routes (mounted at `/users`)

| Route                  | Auth     | Success                                      | Errors                                |
| ---------------------- | -------- | -------------------------------------------- | ------------------------------------- |
| `GET /users/me`        | required | 200 + own account (public fields plus email) | 401 not logged in                     |
| `PATCH /users/me`      | required | 200 + updated account                        | 400 invalid/empty/unknown fields, 401 |
| `GET /users/:username` | public   | 200 + public profile                         | 400 invalid username, 404 not found   |

- `/me` routes are defined before `/:username`, or "me" would be matched as a username.
- `/me` uses the user id from the access token, never a username, so it can only ever read or edit your own account.
- Follow routes (`/users/me/following/...`, `/users/:username/followers`, `/following`) live in the `follows`
  module, mounted at `/users` too. Registration lives in `auth`.

## Data shapes

- **Public profile:** `{ userId, username, displayName, bio, createdAt, updatedAt }`
- **Account** (owner only): the public profile plus `email`
- The password hash is never returned, except by `getCredentialsByLogin` for login

## Rules

- **Usernames:** 3–15 letters, digits or underscores; unique ignoring case (`citext`), stored as typed.
- **Emails:** unique ignoring case, at most 254 characters.
- **Editable fields:** `displayName` (trimmed, 1–50) and `bio` (at most 160, `null` clears it). Partial updates;
  `updated_at` is set on every change. Username, email and password changes aren't exposed.
- The service passes only `displayName` and `bio` to the store, even though `updateUser` can change more columns.

## Files

- `routes.js`: the three routes
- `service.js`: `getProfile`, `getMe`, `updateProfile`
- `store.js` (`users` table): `createUser`, `getCredentialsByLogin`, `getUserById`, `getUserByUsername`,
  `getUserByEmail`, `getProfileByUsername`, `updateUser` (allowlisted columns), `deleteUser`, `searchUsers`
- `schemas.js`: `usernameSchema` and `displayNameSchema` (shared with `auth` and `follows`), `usernameParamSchema`,
  `updateProfileSchema`

## Interacts with

- `auth`: calls `createUser` (register), `getCredentialsByLogin` (login) and `getUserById`
- `follows`: resolves usernames with `getProfileByUsername`; counts and "do I follow them" flags will come from
  the follows store
- `posts`: post views join `users` read-only for author fields
- `timeline`: profile timeline (not built yet)

## Tests

- `tests/store/users.test.js`: users store, including case-insensitive lookups and constraint errors
- `tests/api/users.test.js`: all three routes, including token handling for `/me`

## Open questions / not built yet

- Follower/following counts and "you follow them" on profiles (needs an optional-auth middleware for viewer flags)
- Account deletion (`DELETE /users/me`): must revoke sessions, clear cookies, and soft-delete posts first, since
  other users' replies and quotes block deleting them (see `docs/database-schema.md`)
- User search (`GET /users?q=`): `searchUsers` exists with cursor pagination, but no route
- Changing username (what links break?), email (verification?) or password (belongs with `auth`)
- `getUserByUsername`, `getUserByEmail` and `deleteUser` have no callers yet
