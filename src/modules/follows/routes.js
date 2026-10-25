// HTTP routes and thin handlers for the follows module (validate input, call the service, send the response).
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import * as service from './service.js';
import { userIdParamSchema, followListQuerySchema } from './schemas.js';
import { usernameParamSchema } from '../users/schemas.js';

const router = Router();

// POST /users/me/following/:user_id
router.post('/me/following/:user_id', requireAuth, async (req, res) => {
  const parsed = userIdParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid user id', issues: parsed.error.issues });
  }

  // Self-follow (400) and unknown user (404) are thrown by the service and handled by the error handler.
  await service.follow(req.userId, parsed.data.user_id);
  res.status(204).end();
});

// DELETE /users/me/following/:user_id
router.delete('/me/following/:user_id', requireAuth, async (req, res) => {
  const parsed = userIdParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid user id', issues: parsed.error.issues });
  }

  await service.unfollow(req.userId, parsed.data.user_id);
  res.status(204).end();
});

// GET /users/:username/followers and GET /users/:username/following share everything but the service call.
function listHandler(getPage) {
  return async (req, res) => {
    const params = usernameParamSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json({ error: 'Invalid username', issues: params.error.issues });
    }
    const query = followListQuerySchema.safeParse(req.query);
    if (!query.success) {
      return res.status(400).json({ error: 'Invalid query', issues: query.error.issues });
    }

    const page = await getPage(params.data.username, query.data);
    if (!page) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(page);
  };
}

router.get('/:username/followers', listHandler(service.getFollowers));
router.get('/:username/following', listHandler(service.getFollowing));

export default router;

/*
Mounted at /users alongside the users router (API prefix still to decide in app.js).
Write routes take a user_id (from the profile response); read routes take a username (what the client URL has).
Paths have more segments than the users router's /:username, so the two routers don't collide.

POST /users/me/following/:user_id
  auth:     required
  params:   user_id (userIdParamSchema, must be a UUID)
  success:  204; idempotent, following someone you already follow is a no-op
  errors:   400 invalid user_id, or following yourself (follows_no_self_follow)
            401 not logged in
            404 user not found (FK violation, Postgres code 23503)

DELETE /users/me/following/:user_id
  auth:     required
  params:   user_id (userIdParamSchema)
  success:  204; idempotent, unfollowing someone you don't follow is a no-op
  errors:   400 invalid user_id
            401 not logged in

GET /users/:username/followers
  auth:     none in v1 (viewer flags such as "you follow them" deferred; would need an optionalAuth middleware)
  params:   username (usernameParamSchema)
  query:    limit (1–100, default 20), cursor (opaque, from the previous page's nextCursor) (followListQuerySchema)
  success:  200 + { items: [{ userId, username, displayName, followedAt }], nextCursor }, most recent follow first;
            nextCursor is null on the last page (see src/pagination.js)
  errors:   400 invalid username, limit or cursor
            404 user not found

GET /users/:username/following
  auth:     none in v1 (same as followers)
  params:   username (usernameParamSchema)
  query:    limit, cursor (same as followers)
  success:  200 + { items, nextCursor } of users they follow
  errors:   400 invalid username, limit or cursor
            404 user not found
*/
