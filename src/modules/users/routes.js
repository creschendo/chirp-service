// HTTP routes and thin handlers for the users module (validate input, call the service, send the response).
// TODO

/*
Mounted at /users (API prefix such as /api or /api/v1 still to decide in app.js).
Registration lives in auth; follow/unfollow and follower lists live in follows.
"me" can't collide with a username: usernames are 3–15 characters.

GET /users/:username
  auth:     optional (if logged in, include viewer flags such as whether you follow them)
  params:   username (usernameParamSchema)
  success:  200 + public profile
  errors:   400 invalid username format
            404 user not found

PATCH /users/me
  auth:     required (editing someone else's profile can't be expressed)
  body:     editable profile fields, e.g. display_name, bio (updateProfileSchema)
  success:  200 + updated profile; sets updated_at = now()
  errors:   400 validation failed (incl. profiles_display_name_length / profiles_bio_length)
            401 not logged in

DELETE /users/me   (optional: decide whether account deletion is in scope)
  auth:     required
  success:  204; cascades to profile and follows; clears auth cookie
  errors:   401 not logged in
*/
