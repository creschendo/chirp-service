// HTTP routes and thin handlers for the follows module (validate input, call the service, send the response).
// TODO

/*
Mounted at /users alongside the users router (API prefix still to decide in app.js).
Write routes take a user_id (from the profile response); read routes take a username (what the client URL has).

PUT /users/me/following/:user_id
  auth:     required
  params:   user_id (userIdParamSchema, must be a UUID)
  success:  204; idempotent, following someone you already follow is a no-op
  errors:   400 invalid user_id, or following yourself (follows_no_self_follow)
            401 not logged in
            404 user not found (FK violation, Postgres code 23503)

DELETE /users/me/following/:user_id
  auth:     required
  params:   user_id (userIdParamSchema)
  success:  204; idempotent, unfollowing someone you don't follow is a no-op
  errors:   400 invalid user_id
            401 not logged in

GET /users/:username/followers
  auth:     optional
  params:   username (usernameParamSchema)
  query:    pagination (style still to decide: see docs/timeline.md)
  success:  200 + page of users who follow them
  errors:   404 user not found

GET /users/:username/following
  auth:     optional
  params:   username (usernameParamSchema)
  query:    pagination
  success:  200 + page of users they follow
  errors:   404 user not found
*/
