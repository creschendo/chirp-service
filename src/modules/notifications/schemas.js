// Zod validation schemas for the notifications module.
// GET /notifications/unread-count takes no input, so it has no schema.
import { z } from 'zod';
import { pageQuerySchema } from '../../pagination.js';

// GET /notifications: ?limit=&cursor=. The cursor holds the last notification's sort keys (newest first), the same
// keys the service puts in nextCursor.
export const notificationsQuerySchema = pageQuerySchema(
  z.object({
    createdAt: z.iso.datetime(),
    notificationId: z.uuid(),
  }),
);

// PUT /notifications/read. upTo is the createdAt of the newest notification the client showed (an ISO time in UTC, as
// the API returns it). Required, so an empty body is a 400 rather than "mark everything". Unknown keys are rejected.
// A future time isn't rejected here: the store clamps it to now.
export const markReadSchema = z.strictObject({
  upTo: z.iso.datetime('Invalid upTo time'),
});
