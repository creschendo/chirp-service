// HTTP routes and thin handlers for the users module (validate input, call the service, send the response).
// Mounted at /users. Registration is in auth; follow routes are in follows (also mounted at /users).
// Deferred: DELETE /users/me, user search (GET /users?q=), changing username/email/password.
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
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
router.patch('/me', requireAuth, async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
  }

  const updated = await service.updateProfile(req.userId, parsed.data);
  if (!updated) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(updated);
});

// GET /users/:username (public) -> 200 + public profile. 400 invalid username, 404 not found.
router.get('/:username', async (req, res) => {
  const parsed = usernameParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid username', issues: parsed.error.issues });
  }

  const profile = await service.getProfile(parsed.data.username);
  if (!profile) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(profile);
});

export default router;
