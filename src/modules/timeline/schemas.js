// Zod validation schemas for the timeline module.
// The profile route's username param reuses usernameParamSchema from users/schemas.js.
import { z } from 'zod';
import { pageQuerySchema } from '../../pagination.js';

// GET /timeline and GET /users/:username/posts: ?limit=&cursor=. The cursor holds the last item's sort keys
// (newest first), the same keys the timeline service puts in nextCursor.
export const timelineQuerySchema = pageQuerySchema(
  z.object({
    createdAt: z.iso.datetime(),
    postId: z.uuid(),
  }),
);
