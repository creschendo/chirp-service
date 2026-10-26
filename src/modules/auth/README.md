# auth module

## Responsibility

- Proving who a user is and keeping them logged in: sign up, log in, token refresh, log out
- Owns the `sessions` table. User data (including the password hash) lives in the `users` table, owned by the
  `users` module; auth reads and writes it through `users/store.js`

## Status

Implemented and tested: register, login, refresh, logout, and the `requireAuth` middleware.

## Routes (mounted at `/auth`)

| Route                 | Auth           | Success                                        | Errors                                              |
| --------------------- | -------------- | ---------------------------------------------- | --------------------------------------------------- |
| `POST /auth/register` | none           | 201 + account, logged in (sets both cookies)   | 400 invalid input, 409 username/email taken         |
| `POST /auth/login`    | none           | 200 + account, new session (sets both cookies) | 400 invalid input, 401 invalid credentials          |
| `POST /auth/refresh`  | refresh cookie | 204, rotated session (sets both cookies)       | 401 missing/expired/revoked/reused (clears cookies) |
| `POST /auth/logout`   | refresh cookie | always 204, clears both cookies                | none                                                |

"Who am I" is `GET /users/me` in the `users` module.

## How tokens work

|            | Access token                                           | Refresh token                                      |
| ---------- | ------------------------------------------------------ | -------------------------------------------------- |
| What       | JWT `{ sub: userId }`, HS256, signed with `JWT_SECRET` | 32 random bytes (base64url)                        |
| Lifetime   | 15 minutes                                             | 30 days, renewed on every refresh (sliding)        |
| Cookie     | `access_token`, `HttpOnly`, `Path=/`                   | `refresh_token`, `HttpOnly`, `Path=/auth`          |
| Checked by | `requireAuth`: signature and expiry only, no DB lookup | auth service: SHA-256 hash looked up in `sessions` |
| Revocable  | No, valid until it expires                             | Yes, via `sessions.revoked_at`                     |

Both cookies are `SameSite=Lax`, and `Secure` in production. Only the SHA-256 hash of a refresh token is stored,
so a database leak doesn't expose usable tokens.

- **Login/register** create a session (`startSession`) and set both cookies.
- **Every request** to a protected route sends the access cookie; `requireAuth` (`src/middleware/auth.js`) verifies
  it and sets `req.userId`.
- **Refresh** rotates: a new session is created and the old one's `replaced_by_session_id` points at it, in one
  transaction. Each refresh token works once.
- **Reuse detection:** presenting an already-replaced token means two parties hold a copy (likely theft), so every
  session of that user is revoked. Two concurrent refreshes with the same token count as reuse too.
- **Logout** revokes this device's session only and clears the cookies. An already-issued access token keeps
  working until it expires (at most 15 minutes); no new one can be obtained.

## Rules

- **Passwords:** bcrypt, cost 12 (`BCRYPT_COST`). 8+ characters, at most 72 bytes (bcrypt ignores anything after
  that, so longer passwords are rejected rather than half-checked).
- **Login** accepts a username or an email, either case. An unknown login is compared against a dummy hash so it
  takes as long as a wrong password, and both get the same 401 message.
- **Register** has no "is it taken?" query: the unique constraints decide (`users_username_key`,
  `users_email_key` → 409), so two sign-ups can't race past a check. The user and session are inserted in one
  transaction. `displayName` defaults to the username.

## Files

- `routes.js`: the four routes, plus `setAuthCookies` / `clearAuthCookies` (clearing must use the same path)
- `service.js`: `register`, `login`, `refresh`, `logout`, and the shared `startSession`
- `store.js` (`sessions` table): `createSession`, `getSessionByTokenHash`, `markSessionReplaced` (conditional, so
  only one concurrent rotation wins), `revokeSession`, `revokeAllUserSessions`, `deleteExpiredSessions`
- `tokens.js`: `signAccessToken`, `generateRefreshToken`, `hashRefreshToken`, token lifetimes
- `schemas.js`: `registerSchema`, `loginSchema`, `passwordSchema`

## Interacts with

- `users`: `createUser`, `getCredentialsByLogin` (the only function that returns a password hash), `getUserById`
- `middleware/auth.js`: `requireAuth`, used by every module's protected routes
- `realtime/`: socket authentication (not built yet)

## Tests

- `tests/store/auth.test.js`: sessions store
- `tests/api/auth.test.js`: all four routes, including cookie flags, rotation, theft detection and concurrent refresh

## Open questions / not built yet

- Rate limiting on login and register
- Scheduling `deleteExpiredSessions` (nothing runs it yet)
- `SameSite` and CSRF settings once the client and API are on different sites in production
- Password change and "log out everywhere" (`revokeAllUserSessions` already supports both)
- Email verification, password reset, MFA
- Two tabs refreshing at the same moment look like token reuse and log the user out; the client should keep only
  one refresh in flight (or add a short server-side grace period if it becomes a problem)
