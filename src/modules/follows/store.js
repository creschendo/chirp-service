// Database access for the follows module.
// Owns the follows table; list queries join users read-only for public fields.
// Every function takes an optional `db` (defaults to the pool) so a service can run it inside withTransaction.
// Functions take user ids; the service resolves usernames first (usersStore.getProfileByUsername, null -> 404).
import { pool } from '../../db/index.js';

// PUT /users/me/following/:user_id. Idempotent: INSERT ... ON CONFLICT DO NOTHING.
// Returns true if a new follow was created, false if already following (only notify on true).
// Errors: 23514 follows_no_self_follow (-> 400), 23503 followed user doesn't exist (-> 404).
export async function follow(followerId, followedId, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO follows (follower_id, followed_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING 1`,
    [followerId, followedId],
  );
  return rows.length > 0;
}

// DELETE /users/me/following/:user_id. Idempotent: DELETE WHERE follower_id = $1 AND followed_id = $2.
// Returns true if a follow was removed, false if there was none (the route returns 204 either way).
export async function unfollow(followerId, followedId, db = pool) {
  const { rowCount } = await db.query(
    `DELETE FROM follows
     WHERE follower_id = $1 AND followed_id = $2`,
    [followerId, followedId],
  );
  return rowCount > 0;
}

// GET /users/:username/followers: users who follow userId.
// follows JOIN users ON users.user_id = follows.follower_id WHERE followed_id = $1.
// Most recent first; cursor on (follows.created_at, user_id) so equal timestamps don't skip or repeat rows.
// Returns [{ userId, username, displayName, followedAt }]; [] if none (404 is decided by the service).
// cursor: the last row's { followedAt, userId } from the previous page; null for the first page.
export async function listFollowers(userId, { limit, cursor = null }, db = pool) {
  const { rows } = await db.query(
    `SELECT u.user_id      AS "userId",
            u.username,
            u.display_name AS "displayName",
            f.created_at   AS "followedAt"
     FROM follows f
     JOIN users u ON u.user_id = f.follower_id
     WHERE f.followed_id = $1
       AND ($3::timestamptz IS NULL OR (f.created_at, u.user_id) < ($3, $4::uuid))
     ORDER BY f.created_at DESC, u.user_id DESC
     LIMIT $2`,
    [userId, limit, cursor?.followedAt ?? null, cursor?.userId ?? null],
  );
  return rows;
}

// GET /users/:username/following: users that userId follows.
// Same as listFollowers with the columns swapped: JOIN ON users.user_id = follows.followed_id WHERE follower_id = $1.
export async function listFollowing(userId, { limit, cursor = null }, db = pool) {
  const { rows } = await db.query(
    `SELECT u.user_id      AS "userId",
            u.username,
            u.display_name AS "displayName",
            f.created_at   AS "followedAt"
     FROM follows f
     JOIN users u ON u.user_id = f.followed_id
     WHERE f.follower_id = $1
       AND ($3::timestamptz IS NULL OR (f.created_at, u.user_id) < ($3, $4::uuid))
     ORDER BY f.created_at DESC, u.user_id DESC
     LIMIT $2`,
    [userId, limit, cursor?.followedAt ?? null, cursor?.userId ?? null],
  );
  return rows;
}

// Deferred: "you follow them" viewer flag on profiles and lists.
// SELECT EXISTS (... WHERE follower_id = $1 AND followed_id = $2). Returns a boolean.
export async function isFollowing(followerId, followedId, db = pool) {
  const { rows } = await db.query(
    `SELECT EXISTS (
       SELECT 1
       FROM follows
       WHERE follower_id = $1 AND followed_id = $2
     ) AS "isFollowing"`,
    [followerId, followedId],
  );
  return rows[0].isFollowing;
}

// Deferred: follower/following counts on profiles.
// Two COUNT(*)s (followed_id = $1 uses the reverse index; follower_id = $1 uses the primary key).
// Returns { followers, following } as numbers (pg returns COUNT as a string; cast with ::int).
export async function countFollows(userId, db = pool) {
  const { rows } = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM follows WHERE followed_id = $1) AS followers,
       (SELECT COUNT(*)::int FROM follows WHERE follower_id = $1) AS following`,
    [userId],
  );
  return rows[0];
}
