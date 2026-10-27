// HTTP routes and thin handlers for the follows module (validate input, call the service, send the response).
// Mounted at /users alongside the users router; these paths have more segments than /:username, so they don't collide.
// Write routes take a user_id (from the profile response); read routes take a username (what the client URL has).
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as service from './service.js';
import { userIdParamSchema, followListQuerySchema } from './schemas.js';
import { usernameParamSchema } from '../users/schemas.js';

const router = Router();

// POST /users/me/following/:user_id (auth) -> 204, idempotent.
// 400 invalid id or following yourself, 401 not logged in, 404 user not found.
router.post('/me/following/:user_id', requireAuth, validate({ params: userIdParamSchema }), async (req, res) => {
  await service.follow(req.userId, req.valid.params.user_id);
  res.status(204).end();
});

// DELETE /users/me/following/:user_id (auth) -> 204, idempotent. 400 invalid id, 401 not logged in.
router.delete('/me/following/:user_id', requireAuth, validate({ params: userIdParamSchema }), async (req, res) => {
  await service.unfollow(req.userId, req.valid.params.user_id);
  res.status(204).end();
});

// Shared by the two list routes below; they differ only in the service call.
function listHandler(getPage) {
  return async (req, res) => {
    const page = await getPage(req.valid.params.username, req.valid.query);
    if (!page) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(page);
  };
}

// GET /users/:username/followers and /following (public) ?limit=1–100 (default 20)&cursor=
// -> 200 + { items: [{ userId, username, displayName, followedAt }], nextCursor }, newest follow first
// (see src/pagination.js). 400 invalid username/limit/cursor, 404 user not found.
router.get(
  '/:username/followers',
  validate({ params: usernameParamSchema, query: followListQuerySchema }),
  listHandler(service.getFollowers),
);
router.get(
  '/:username/following',
  validate({ params: usernameParamSchema, query: followListQuerySchema }),
  listHandler(service.getFollowing),
);

export default router;
