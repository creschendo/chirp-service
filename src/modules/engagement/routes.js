// HTTP routes and thin handlers for the engagement module (validate input, call the service, send the response).
// Mounted at / in app.js, like the timeline router, because its routes live under two prefixes: /posts (the write
// routes) and /users (the lists). The paths have more segments than the posts router's /:post_id and the users
// router's /:username, so they don't collide. "me" is too short to be a username, so /users/me/bookmarks can't clash
// with /users/:username/likes.
// Writes follow the follows module's style: POST to do it, DELETE to undo, both idempotent, both need auth.
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as service from './service.js';
import { bookmarksQuerySchema, likesQuerySchema } from './schemas.js';
import { postIdParamSchema } from '../posts/schemas.js';
import { usernameParamSchema } from '../users/schemas.js';

const router = Router();

// POST /posts/:post_id/like (auth) -> 204. Liking again is still 204. Your own posts can be liked.
// 400 invalid id, 401 not logged in, 404 post not found or deleted.
router.post('/posts/:post_id/like', requireAuth, validate({ params: postIdParamSchema }), async (req, res) => {
  // Not found or deleted (404) is thrown by the service.
  await service.like(req.userId, req.valid.params.post_id);
  res.status(204).end();
});

// DELETE /posts/:post_id/like (auth) -> 204, even if you hadn't liked it or the post has since been deleted.
// 400 invalid id, 401 not logged in.
router.delete('/posts/:post_id/like', requireAuth, validate({ params: postIdParamSchema }), async (req, res) => {
  await service.unlike(req.userId, req.valid.params.post_id);
  res.status(204).end();
});

// POST /posts/:post_id/repost (auth) -> 201 + { repostId, repostedAt } if new, 200 + the same if you'd already
// reposted it (it keeps its original time). The repost is a new item in timelines; the original post doesn't move.
// Your own posts can be reposted. 400 invalid id, 401 not logged in, 404 post not found or deleted.
router.post('/posts/:post_id/repost', requireAuth, validate({ params: postIdParamSchema }), async (req, res) => {
  // Not found or deleted (404) is thrown by the service.
  const { created, ...repost } = await service.repost(req.userId, req.valid.params.post_id);
  res.status(created ? 201 : 200).json(repost);
});

// DELETE /posts/:post_id/repost (auth) -> 204, even if you hadn't reposted it or the post has since been deleted.
// Its timeline item goes with it. 400 invalid id, 401 not logged in.
router.delete('/posts/:post_id/repost', requireAuth, validate({ params: postIdParamSchema }), async (req, res) => {
  await service.unrepost(req.userId, req.valid.params.post_id);
  res.status(204).end();
});

// POST /posts/:post_id/bookmark (auth) -> 204. Private: nobody else sees it and it never notifies. Bookmarking again
// is still 204 and keeps the first bookmark's place in your list. Your own posts can be bookmarked.
// 400 invalid id, 401 not logged in, 404 post not found or deleted.
router.post('/posts/:post_id/bookmark', requireAuth, validate({ params: postIdParamSchema }), async (req, res) => {
  // Not found or deleted (404) is thrown by the service.
  await service.bookmark(req.userId, req.valid.params.post_id);
  res.status(204).end();
});

// DELETE /posts/:post_id/bookmark (auth) -> 204, even if you hadn't bookmarked it or the post has since been deleted.
// 400 invalid id, 401 not logged in.
router.delete('/posts/:post_id/bookmark', requireAuth, validate({ params: postIdParamSchema }), async (req, res) => {
  await service.unbookmark(req.userId, req.valid.params.post_id);
  res.status(204).end();
});

// GET /users/:username/likes (public) ?limit=1–100 (default 20)&cursor= -> 200 + { items, nextCursor }: the posts that
// user liked, as post views with likedAt, newest like first (see src/pagination.js); deleted posts hidden.
// 400 invalid username or query, 404 user not found.
router.get(
  '/users/:username/likes',
  validate({ params: usernameParamSchema, query: likesQuerySchema }),
  async (req, res) => {
    const page = await service.listLikes(req.valid.params.username, req.valid.query);
    if (!page) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(page);
  },
);

// GET /users/me/bookmarks (auth) ?limit=1–100 (default 20)&cursor= -> 200 + { items, nextCursor }: your bookmarked
// posts, as post views with bookmarkedAt, newest bookmark first; deleted posts hidden. Only ever your own: the user
// comes from the token, so there's no way to name anyone else. 400 invalid query, 401 not logged in.
router.get('/users/me/bookmarks', requireAuth, validate({ query: bookmarksQuerySchema }), async (req, res) => {
  res.json(await service.listBookmarks(req.userId, req.valid.query));
});

// Not wired up yet: counts and viewer flags. They aren't routes of their own: every post view (GET /posts/:post_id,
// replies, timelines and the two lists above) will get an engagement object through the service's withEngagement.

export default router;
