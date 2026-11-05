// Zod validation schemas for the timeline module.
// The profile route's username param reuses usernameParamSchema from users/schemas.js.
import { z } from 'zod';
import { pageQuerySchema } from '../../pagination.js';

// GET /timeline and GET /users/:username/posts: ?limit=&cursor=. The cursor holds the last item's sort keys
// (newest first), the same keys the timeline service puts in nextCursor: the post's or the repost's time, and the
// post_id or repost_id.
export const timelineQuerySchema = pageQuerySchema(
  z.object({
    activityAt: z.iso.datetime(),
    itemId: z.uuid(),
  }),
);
