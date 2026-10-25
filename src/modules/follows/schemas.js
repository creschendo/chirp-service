// Zod validation schemas for the follows module.
import { z } from 'zod';
import { pageQuerySchema } from '../../pagination.js';

// Write routes take the target's user id (from the profile response).
export const userIdParamSchema = z.object({
  user_id: z.uuid('Invalid user id'),
});

// Followers/following lists: ?limit=&cursor=. The cursor holds the last row's sort keys.
export const followListQuerySchema = pageQuerySchema(
  z.object({
    followedAt: z.iso.datetime(),
    userId: z.uuid(),
  }),
);
