// HTTP routes and thin handlers for the users module (validate input, call the service, send the response).
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import * as service from './service.js';
import { usernameParamSchema, updateProfileSchema } from './schemas.js';

const router = Router();

// /me routes come before /:username so "me" isn't treated as a username.

// GET /users/me
router.get('/me', requireAuth, async (req, res) => {
  const me = await service.getMe(req.userId);
  if (!me) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(me);
});

// PATCH /users/me
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

// GET /users/:username
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

/*
Mounted at /users (API prefix such as /api or /api/v1 still to decide in app.js).
Registration and sessions live in auth; follow/unfollow and follower lists live in follows (also mounted at /users).
Route order: define /me routes before /:username, or "me" is matched as a username
("me" can't be a real username, usernames are 3–15 characters, so it would fail usernameParamSchema with 400).

v1 routes:
  GET   /users/me                     this module
  PATCH /users/me                     this module
  GET   /users/:username              this module
  GET   /users/:username/followers    follows module
  GET   /users/:username/following    follows module

GET /users/me
  auth:     required
  success:  200 + current user's account and profile: public profile fields plus email (never the password hash)
            what the client loads on startup; replaces the previously planned GET /auth/me
  errors:   401 not logged in

PATCH /users/me
  auth:     required (editing someone else's profile can't be expressed)
  body:     editable profile fields: displayName, bio (updateProfileSchema); partial, bio: null clears it
  success:  200 + updated profile; sets updated_at = now()
  errors:   400 validation failed (incl. users_display_name_length / users_bio_length)
            401 not logged in

GET /users/:username
  auth:     none in v1 (viewer flags such as "you follow them" deferred; would need an optionalAuth middleware)
  params:   username (usernameParamSchema)
  success:  200 + public profile
  errors:   400 invalid username format
            404 user not found

Deferred (not in v1):
  DELETE /users/me                    account deletion; also needs session revocation, cookie clearing, and a decision on posts
  GET /users?q=                       user search (store.searchUsers already exists)
  changing username, email, password  username changes: see README open questions; password change belongs with auth
*/
