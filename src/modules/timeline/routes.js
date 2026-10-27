// HTTP routes and thin handlers for the timeline module (validate input, call the service, send the response).
// Mounted at / in app.js: its two routes live under different prefixes (/timeline and /users).
// /users/:username/posts has more segments than the users router's /:username, so they don't collide.
// Both return { items, nextCursor } of post views (the GET /posts/:post_id shape), newest first: originals and
// quotes, no replies, deleted posts hidden (see docs/timeline.md and src/pagination.js).
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as service from './service.js';
import { timelineQuerySchema } from './schemas.js';
import { usernameParamSchema } from '../users/schemas.js';

const router = Router();

// GET /timeline (auth) ?limit=1–100 (default 20)&cursor= -> 200 + { items, nextCursor }: posts by the viewer and
// everyone they follow. 400 invalid query, 401 not logged in.
router.get('/timeline', requireAuth, validate({ query: timelineQuerySchema }), async (req, res) => {
  res.json(await service.getHomeTimeline(req.userId, req.valid.query));
});

// GET /users/:username/posts (public) ?limit=&cursor= -> 200 + { items, nextCursor }: that user's posts.
// 400 invalid username or query, 404 user not found.
router.get(
  '/users/:username/posts',
  validate({ params: usernameParamSchema, query: timelineQuerySchema }),
  async (req, res) => {
    const page = await service.getProfileTimeline(req.valid.params.username, req.valid.query);
    if (!page) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(page);
  },
);

// Deferred: reposts in both timelines (engagement), a "Replies" tab on profiles, "new posts since" for refresh,
// counts and viewer flags per item.

export default router;
