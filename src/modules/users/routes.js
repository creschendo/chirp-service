// HTTP routes and thin handlers for the users module (validate input, call the service, send the response).
// Mounted at /users. Registration is in auth; follow routes are in follows (also mounted at /users).
// Deferred: DELETE /users/me, user search (GET /users?q=), changing username/email/password.
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as service from './service.js';
import { usernameParamSchema, updateProfileSchema } from './schemas.js';

const router = Router();

// /me routes must come before /:username, or "me" is matched as a username.

// GET /users/me (auth) -> 200 + own account: public profile plus email. 401 not logged in.
router.get('/me', requireAuth, async (req, res) => {
  const me = await service.getMe(req.userId);
  if (!me) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(me);
});

// PATCH /users/me (auth) { displayName?, bio? } -> 200 + updated account. Partial; bio: null clears it.
// 400 invalid, empty or unknown fields; 401 not logged in.
router.patch('/me', requireAuth, validate({ body: updateProfileSchema }), async (req, res) => {
  const updated = await service.updateProfile(req.userId, req.valid.body);
  if (!updated) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(updated);
});

// GET /users/:username (public) -> 200 + public profile. 400 invalid username, 404 not found.
router.get('/:username', validate({ params: usernameParamSchema }), async (req, res) => {
  const profile = await service.getProfile(req.valid.params.username);
  if (!profile) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(profile);
});

export default router;
