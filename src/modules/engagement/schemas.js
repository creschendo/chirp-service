// Zod validation schemas for the engagement module.
// The write routes (/posts/:post_id/like, /repost, /bookmark) reuse postIdParamSchema from posts/schemas.js and have no
// body. The likes list reuses usernameParamSchema from users/schemas.js.
import { z } from 'zod';
import { pageQuerySchema } from '../../pagination.js';

// GET /users/:username/likes: ?limit=&cursor=. The cursor holds the last post's like time and id (newest like first),
// the keys the service puts in nextCursor.
export const likesQuerySchema = pageQuerySchema(
  z.object({
    likedAt: z.iso.datetime(),
    postId: z.uuid(),
  }),
);

// GET /users/me/bookmarks: ?limit=&cursor=. The same, keyed by bookmark time. The keys differ from the likes cursor's,
// so a cursor from one list is rejected by the other.
export const bookmarksQuerySchema = pageQuerySchema(
  z.object({
    bookmarkedAt: z.iso.datetime(),
    postId: z.uuid(),
  }),
);
