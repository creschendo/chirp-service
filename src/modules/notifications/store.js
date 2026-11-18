// Database access for the notifications module.
// Owns notifications and notification_reads; queries join posts and users read-only. Every function takes an optional
// `db` (defaults to the pool) so other services can write a notification inside the same transaction as the like,
// repost, follow or post that caused it.
import { pool } from '../../db/index.js';
import { POST_VIEW_SELECT, toPostView } from '../posts/views.js';

// The tables, their keys and indexes, and why, are in migrations/006_create-notifications.js:
//
// notifications (notification_id, recipient_id, actor_id, type, post_id, created_at)
//   type: 'like' | 'repost' | 'reply' | 'quote' | 'follow'
//   post_id: like/repost: the recipient's post that was liked or reposted; reply/quote: the new reply or quote;
//            follow: NULL
//   UNIQUE NULLS NOT DISTINCT (actor_id, type, post_id, recipient_id): one per action; also the index for undo
//   INDEX (recipient_id, created_at DESC, notification_id DESC): the list and the unread count
// notification_reads (user_id PK, read_up_to): everything at or before read_up_to is read; no row = nothing read

const NOTIFICATION_COLUMNS = `
  notification_id AS "notificationId", recipient_id AS "recipientId", actor_id AS "actorId", type,
  post_id AS "postId", created_at AS "createdAt"
`;

// --- Writes ---

// Stores a notification and returns it as { notificationId, recipientId, actorId, type, postId, createdAt }, or null
// if this action already has one (ON CONFLICT DO NOTHING on notifications_action_key). Callers only notify on new
// actions and undo deletes, so the conflict is a backstop for races, not the normal path.
// postId is null for a follow and required for every other type. No checks here: the service skips notifying
// yourself, and the migration's constraints back that up.
// Errors: 23503 unknown user or post, 23514 a check failed (bad type, missing or extra post, actor = recipient).
export async function addNotification({ type, actorId, recipientId, postId = null }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO notifications (type, actor_id, recipient_id, post_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [type, actorId, recipientId, postId],
  );
  return rows[0] ?? null;
}

// Deletes the notification for an undone action (unlike, unrepost, unfollow). Returns true if one was removed, false
// if there was none (e.g. it was your own post, so nothing was ever created).
// - like/repost: pass { type, actorId, postId }. The recipient is the post's author, so it isn't needed.
// - follow: pass { type: 'follow', actorId, recipientId }; there's no post.
// Both forms are a lookup on notifications_action_key (actor_id, type, then post_id, then recipient_id).
// postId = NULL in SQL matches nothing, which is why a follow uses IS NULL and the recipient instead.
export async function removeNotification({ type, actorId, recipientId = null, postId = null }, db = pool) {
  const { rowCount } = postId
    ? await db.query(
        `DELETE FROM notifications
         WHERE actor_id = $1 AND type = $2 AND post_id = $3`,
        [actorId, type, postId],
      )
    : await db.query(
        `DELETE FROM notifications
         WHERE actor_id = $1 AND type = $2 AND post_id IS NULL AND recipient_id = $3`,
        [actorId, type, recipientId],
      );
  return rowCount > 0;
}

// --- Reads ---

// The user's read-up-to time, or -infinity if they've never marked anything read (no row), so "created_at > it" is
// true for every notification. A scalar subquery rather than a join: it's one primary-key lookup, and comparing
// created_at to a single value lets the unread count use the recipient index as a range.
const READ_UP_TO = `COALESCE((SELECT read_up_to FROM notification_reads WHERE user_id = $1), '-infinity')`;

// GET /notifications. The recipient's notifications, newest first, as
//   { notificationId, type, actor: { userId, username, displayName }, post, createdAt, read }
// post is a post view (the GET /posts/:post_id shape) or null for a follow. [] if none.
// - Hidden when the post is deleted: the liked/reposted post, or the reply/quote itself (deleting a reply is how it's
//   undone). A follow has no post, so the LEFT JOIN leaves pv's columns NULL and pv.deleted_at IS NULL keeps it.
// - read: created_at at or before the read-up-to time.
// The notification's own columns are aliased (n_...) so they don't clash with the post view's post_id/created_at.
// cursor: the last row's { createdAt, notificationId }; null for the first page. Newest first, so the next page is the
// rows *before* it (<), notification_id breaking ties. Uses notifications_recipient_id_created_at_idx.
export async function listNotifications(recipientId, { limit, cursor = null }, db = pool) {
  const { rows } = await db.query(
    `SELECT n.notification_id AS n_notification_id, n.type AS n_type, n.post_id AS n_post_id,
            n.created_at AS n_created_at, n.created_at <= ${READ_UP_TO} AS n_read,
            au.user_id AS au_user_id, au.username AS au_username, au.display_name AS au_display_name,
            pv.*
     FROM notifications n
     JOIN users au ON au.user_id = n.actor_id
     LEFT JOIN (${POST_VIEW_SELECT}) pv ON pv.post_id = n.post_id
     WHERE n.recipient_id = $1
       AND pv.deleted_at IS NULL
       AND ($3::timestamptz IS NULL OR (n.created_at, n.notification_id) < ($3, $4::uuid))
     ORDER BY n.created_at DESC, n.notification_id DESC
     LIMIT $2`,
    [recipientId, limit, cursor?.createdAt ?? null, cursor?.notificationId ?? null],
  );
  return rows.map((row) => ({
    notificationId: row.n_notification_id,
    type: row.n_type,
    actor: { userId: row.au_user_id, username: row.au_username, displayName: row.au_display_name },
    post: row.n_post_id ? toPostView(row) : null,
    createdAt: row.n_created_at,
    read: row.n_read,
  }));
}

// GET /notifications/unread-count. How many of the recipient's notifications are after their read-up-to time (all of
// them if they've never read any), hidden ones left out the same way as the list, so the badge matches what the list
// shows. A plain join to posts is enough here: only deleted_at is needed, not the whole post view.
export async function countUnread(recipientId, db = pool) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS count
     FROM notifications n
     LEFT JOIN posts p ON p.post_id = n.post_id
     WHERE n.recipient_id = $1
       AND p.deleted_at IS NULL
       AND n.created_at > ${READ_UP_TO}`,
    [recipientId],
  );
  return rows[0].count;
}

// PUT /notifications/read. Marks everything at or before upTo as read and returns the new read-up-to time (a Date).
// - Never moves backward (GREATEST), so an older upTo from another tab changes nothing and repeating it is a no-op.
// - Never past now (LEAST): a future upTo would otherwise mark notifications that haven't happened yet as read.
// One upsert on the primary key, so concurrent calls can't lose an update.
export async function markReadUpTo(userId, upTo, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO notification_reads (user_id, read_up_to)
     VALUES ($1, LEAST($2::timestamptz, now()))
     ON CONFLICT (user_id) DO UPDATE
     SET read_up_to = GREATEST(notification_reads.read_up_to, EXCLUDED.read_up_to)
     RETURNING read_up_to AS "readUpTo"`,
    [userId, upTo],
  );
  return rows[0].readUpTo;
}
