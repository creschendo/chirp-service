// Database access for the users module.
// Owns the users table (account, credentials, and public profile). Every function takes an optional `db`
// (defaults to the pool) so a service can run it inside withTransaction.
import { pool } from '../../db/index.js';

// Public profile columns: safe to show anyone.
const PUBLIC_COLUMNS = `
  user_id      AS "userId",
  username,
  display_name AS "displayName",
  bio,
  created_at   AS "createdAt",
  updated_at   AS "updatedAt"
`;

// Public profile plus email, so only return these to the account owner (e.g. GET /users/me).
// password_hash is deliberately excluded everywhere; only getCredentialsByLogin selects it.
const ACCOUNT_COLUMNS = `${PUBLIC_COLUMNS}, email`;

// Register. Duplicate username/email throws 23505 (users_username_key / users_email_key);
// the service maps that to 409 instead of checking first (a check-then-insert races).
// bio may be omitted (stored as null).
export async function createUser(fields, db = pool) {
  const { username, email, passwordHash, displayName, bio } = fields;
  const { rows } = await db.query(
    `INSERT INTO users (username, email, password_hash, display_name, bio)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${ACCOUNT_COLUMNS}`,
    [username, email, passwordHash, displayName, bio ?? null],
  );
  return rows[0];
}

// Login: the only function that returns passwordHash. Matches username or email;
// citext makes both case-insensitive. Returns null if no account matches.
export async function getCredentialsByLogin(login, db = pool) {
  const { rows } = await db.query(
    `SELECT user_id AS "userId", username, password_hash AS "passwordHash"
     FROM users
     WHERE username = $1 OR email = $1`,
    [login],
  );
  return rows[0] ?? null;
}

// Own account by id (GET /users/me, with the id from the access token), or null.
export async function getUserById(userId, db = pool) {
  const { rows } = await db.query(
    `SELECT ${ACCOUNT_COLUMNS}
     FROM users
     WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

// Own account by username (case-insensitive), or null.
export async function getUserByUsername(username, db = pool) {
  const { rows } = await db.query(
    `SELECT ${ACCOUNT_COLUMNS}
     FROM users
     WHERE username = $1`,
    [username],
  );
  return rows[0] ?? null;
}

// Own account by email (case-insensitive), or null.
export async function getUserByEmail(email, db = pool) {
  const { rows } = await db.query(
    `SELECT ${ACCOUNT_COLUMNS}
     FROM users
     WHERE email = $1`,
    [email],
  );
  return rows[0] ?? null;
}

// Public profile for GET /users/:username, or null if no such user.
// citext makes the username match case-insensitive. Never selects email or password_hash.
export async function getProfileByUsername(username, db = pool) {
  const { rows } = await db.query(
    `SELECT ${PUBLIC_COLUMNS}
     FROM users
     WHERE username = $1`,
    [username],
  );
  return rows[0] ?? null;
}

// Updatable fields -> column names. Keys outside this map are ignored, so
// callers can't inject column names or touch user_id.
const USER_UPDATABLE = {
  username: 'username',
  email: 'email',
  passwordHash: 'password_hash',
  displayName: 'display_name',
  bio: 'bio',
};

// Partial update (e.g. PATCH /users/me): only keys present in `fields` are changed; bio: null clears it.
// Sets updated_at. Returns the updated account, or null if the user doesn't exist.
// Same 23505 behavior as createUser.
export async function updateUser(userId, fields, db = pool) {
  const setClauses = [];
  const values = [userId];
  for (const [key, column] of Object.entries(USER_UPDATABLE)) {
    if (key in fields) {
      values.push(fields[key]);
      setClauses.push(`${column} = $${values.length}`);
    }
  }
  if (setClauses.length === 0) {
    throw new Error('updateUser called with no updatable fields');
  }
  setClauses.push('updated_at = now()');

  const { rows } = await db.query(
    `UPDATE users
     SET ${setClauses.join(', ')}
     WHERE user_id = $1
     RETURNING ${ACCOUNT_COLUMNS}`,
    values,
  );
  return rows[0] ?? null;
}

// Cascades to follows and sessions. Returns false if the user didn't exist.
export async function deleteUser(userId, db = pool) {
  const { rowCount } = await db.query(
    `DELETE FROM users
     WHERE user_id = $1`,
    [userId],
  );
  return rowCount > 0;
}

// Username substring search, ordered by username, paginated by cursor
// (pass the last username of the previous page; null for the first page).
// Public data only. The service should cap `limit`.
// The leading % can't use the username index; fine at this scale, revisit with pg_trgm.
export async function searchUsers(query, limit, cursor = null, db = pool) {
  // Escape LIKE wildcards so "_" (valid in usernames) matches literally.
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const { rows } = await db.query(
    `SELECT user_id      AS "userId",
            username,
            display_name AS "displayName"
     FROM users
     WHERE username ILIKE $1
       AND ($3::citext IS NULL OR username > $3)
     ORDER BY username
     LIMIT $2`,
    [pattern, limit, cursor],
  );
  return rows;
}
