// HTTP routes and thin handlers for the auth module (validate input, call the service, send the response).
// TODO

/*
Mounted at /auth (API prefix such as /api or /api/v1 still to decide in app.js).
Auth option B: two httpOnly cookies.
  - access token:  short-lived JWT (~15 min), verified by auth middleware with no DB lookup
  - refresh token: long-lived random value, path-restricted to /auth/refresh; its SHA-256 hash is stored in sessions

POST /auth/register
  auth:     none
  body:     username, email, password, optional displayName (registerSchema); displayName defaults to the username
  success:  201 + created user (never the password hash); sets auth cookie if sign-up logs you in
  errors:   400 validation failed
            409 username taken (users_username_key) or email taken (users_email_key)
  note:     one INSERT into users (account and profile live in the same row)

POST /auth/login
  auth:     none
  body:     login identifier + password (loginSchema)
  success:  200 + current user; creates a session row; sets access + refresh cookies
  errors:   400 validation failed
            401 invalid credentials (same message whether username or password is wrong)

POST /auth/refresh
  auth:     refresh cookie (access token may be expired)
  success:  204; rotates: new session row, old row's replaced_by_session_id points to it; sets new access + refresh cookies
  errors:   401 missing, unknown, expired or revoked refresh token
            401 reused refresh token (already replaced): revoke the user's sessions, likely theft

POST /auth/logout
  auth:     refresh cookie
  success:  204; sets revoked_at on the current session; clears both cookies
  errors:   none needed; logging out without a valid session can still return 204

The current user ("who am I") is GET /users/me in the users module, not GET /auth/me:
auth owns sessions and tokens; users owns the users table.
*/
