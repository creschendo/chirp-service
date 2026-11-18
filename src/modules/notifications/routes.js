// HTTP routes and thin handlers for the notifications module (validate input, call the service, send the response).
// Mounted at /notifications in app.js. Every route requires auth: you only ever see your own notifications. There are
// no routes to create or delete them; those happen as a side effect of liking, reposting, replying, quoting and
// following (and undoing those). /unread-count and /read are fixed paths and there's no /:notification_id route, so
// nothing collides.
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as service from './service.js';
import { markReadSchema, notificationsQuerySchema } from './schemas.js';

const router = Router();

// GET /notifications (auth) ?limit=1–100 (default 20)&cursor= -> 200 + { items, nextCursor }, newest first (see
// src/pagination.js). Each item: { notificationId, type, actor: { userId, username, displayName }, post (a post view,
// or null for a follow), createdAt, read }. Notifications about deleted posts are left out. Doesn't mark anything
// read: the client calls PUT /notifications/read once it has shown the page.
// 400 invalid limit/cursor, 401 not logged in.
router.get('/', requireAuth, validate({ query: notificationsQuerySchema }), async (req, res) => {
  res.json(await service.listNotifications(req.userId, req.valid.query));
});

// GET /notifications/unread-count (auth) -> 200 + { count }, for the badge: notifications after your read-up-to time.
// Polled for now; real-time pushes will update it later. 401 not logged in.
router.get('/unread-count', requireAuth, async (req, res) => {
  res.json(await service.getUnreadCount(req.userId));
});

// PUT /notifications/read (auth) { upTo } -> 204. Marks everything at or before upTo (the createdAt of the newest
// notification the client showed) as read. Idempotent, and never moves backward, so an older upTo (say from another
// tab) changes nothing; a future upTo only marks up to now. PUT because repeating it has the same result.
// 400 invalid body, 401 not logged in.
router.put('/read', requireAuth, validate({ body: markReadSchema }), async (req, res) => {
  await service.markRead(req.userId, req.valid.body);
  res.status(204).end();
});

export default router;
