// Zod validation schemas for the engagement module.
//
// PLAN (not implemented yet):
//
// The write routes reuse postIdParamSchema from posts/schemas.js (/posts/:post_id/...), and have no body. The likes
// list reuses usernameParamSchema from users/schemas.js.
//
// likesQuerySchema: GET /users/:username/likes. pageQuerySchema(z.object({ likedAt: z.iso.datetime(),
//   postId: z.uuid() })).
//
// bookmarksQuerySchema: GET /users/me/bookmarks. pageQuerySchema(z.object({ bookmarkedAt: z.iso.datetime(),
//   postId: z.uuid() })).
//
// Cursor keys differ per list (likedAt, bookmarkedAt), so a cursor from one list is rejected by the other.

// TODO
