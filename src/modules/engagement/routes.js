// HTTP routes and thin handlers for the engagement module (validate input, call the service, send the response).
// To be mounted at / in app.js, like the timeline router, because its routes live under two prefixes: /posts (the
// write routes) and /users (the lists). The paths have more segments than the posts router's /:post_id and the
// users router's /:username, so they don't collide. "me" is too short to be a username, so /users/me/bookmarks
// can't clash with /users/:username/likes.
//
// PLAN (not implemented yet):
//
// Writes follow the follows module's style: POST to do it, DELETE to undo, both idempotent. All need auth.
//
// POST /posts/:post_id/like -> 204. 400 invalid id, 401, 404 post not found or deleted.
// DELETE /posts/:post_id/like -> 204, even if you hadn't liked it. 400 invalid id, 401.
//
// POST /posts/:post_id/repost -> 201 + { repostId, repostedAt } if new, 200 + the same if you'd already reposted it.
//   Your own posts can be reposted. 400 invalid id, 401, 404 post not found or deleted.
// DELETE /posts/:post_id/repost -> 204, even if you hadn't reposted it. 400 invalid id, 401.
//
// POST /posts/:post_id/bookmark -> 204. 400 invalid id, 401, 404 post not found or deleted.
// DELETE /posts/:post_id/bookmark -> 204, even if you hadn't bookmarked it. 400 invalid id, 401.
//
// GET /users/:username/likes (public) ?limit=&cursor= -> 200 + { items, nextCursor }: post views with likedAt,
//   newest like first; deleted posts hidden. 400 invalid username or query, 404 user not found.
//
// GET /users/me/bookmarks (auth) ?limit=&cursor= -> 200 + { items, nextCursor }: post views with bookmarkedAt,
//   newest bookmark first; deleted posts hidden. Only ever your own. 400 invalid query, 401.
//
// Counts and viewer flags aren't routes of their own: every post view (GET /posts/:post_id, replies, timelines and
// the two lists above) gets an engagement object through the service's withEngagement.
//
// No default export until the routes exist (app.js mounts only implemented modules).
