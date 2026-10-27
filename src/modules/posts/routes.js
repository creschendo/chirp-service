// HTTP routes and thin handlers for the posts module (validate input, call the service, send the response).
// Mounted at /posts. Originals, replies and quote posts are all posts (see docs/database-schema.md).
// A profile's posts (GET /users/:username/posts) belong to the timeline module.
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as service from './service.js';
import { createPostSchema, postIdParamSchema, repliesQuerySchema } from './schemas.js';

const router = Router();

// POST /posts (auth) { content, parentPostId?, quotedPostId? } -> 201 + post.
// parentPostId makes it a reply, quotedPostId a quote; not both. 400 invalid input or both set,
// 401 not logged in, 404 parent or quoted post not found or deleted.
router.post('/', requireAuth, validate({ body: createPostSchema }), async (req, res) => {
  // A missing or deleted parent/quoted post throws a 404 from the service.
  const post = await service.createPost(req.userId, req.valid.body);
  res.status(201).json(post);
});

// GET /posts/:post_id (public) -> 200 + post view: author, content, quoted post embedded, reply links.
// A deleted post returns 200 with deleted: true and no content or author, so links and threads still resolve.
// 400 invalid id, 404 never existed.
router.get('/:post_id', validate({ params: postIdParamSchema }), async (req, res) => {
  const post = await service.getPost(req.valid.params.post_id);
  if (!post) {
    return res.status(404).json({ error: 'Post not found' });
  }

  res.json(post);
});

// DELETE /posts/:post_id (auth, author only) -> 204; soft delete. Deleting an already-deleted post is still 204.
// 400 invalid id, 401 not logged in, 403 not your post, 404 not found.
router.delete('/:post_id', requireAuth, validate({ params: postIdParamSchema }), async (req, res) => {
  // Not found (404) and not yours (403) are thrown by the service.
  await service.deletePost(req.userId, req.valid.params.post_id);
  res.status(204).end();
});

// GET /posts/:post_id/replies (public) ?limit=&cursor= -> 200 + { items, nextCursor }: direct replies,
// oldest first (see src/pagination.js). Deleted replies appear as deleted: true. 400 invalid id/query, 404 not found.
router.get(
  '/:post_id/replies',
  validate({ params: postIdParamSchema, query: repliesQuerySchema }),
  async (req, res) => {
    const page = await service.listReplies(req.valid.params.post_id, req.valid.query);
    if (!page) {
      return res.status(404).json({ error: 'Post not found' });
    }

    res.json(page);
  },
);

// Deferred: viewer flags and counts (likes, reposts, replies) come with engagement; whole-conversation and
// ancestor views ("show this reply in context") come later.

export default router;
