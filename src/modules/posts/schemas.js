// Zod validation schemas for the posts module.
import { z } from 'zod';
import { pageQuerySchema } from '../../pagination.js';

// POST /posts. parentPostId makes it a reply, quotedPostId a quote; not both. Unknown keys are rejected.
// Content limits match posts_content_length; trimmed first, so whitespace-only content is rejected as empty.
export const createPostSchema = z
  .strictObject({
    content: z.string().trim().min(1, 'Post cannot be empty').max(280, 'Post must be at most 280 characters'),
    parentPostId: z.uuid('Invalid post id').optional(),
    quotedPostId: z.uuid('Invalid post id').optional(),
  })
  .refine((post) => !(post.parentPostId && post.quotedPostId), {
    message: 'A post can be a reply or a quote, not both',
  });

// /posts/:post_id routes.
// .describe() sets the 400 message validate() sends when this fails.
export const postIdParamSchema = z
  .object({
    post_id: z.uuid('Invalid post id'),
  })
  .describe('Invalid post id');

// GET /posts/:post_id/replies: ?limit=&cursor=. The cursor holds the last reply's sort keys (oldest first).
export const repliesQuerySchema = pageQuerySchema(
  z.object({
    createdAt: z.iso.datetime(),
    postId: z.uuid(),
  }),
);
