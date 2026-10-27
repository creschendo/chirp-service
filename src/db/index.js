// PostgreSQL connection pool and query helpers.
import pg from 'pg';
import config from '../config/index.js';

// One pool for the whole process; every store imports this same instance.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
});

// An idle connection can drop (database restart, network blip). pg reports that as an 'error' event on the
// pool, and an 'error' event with no listener crashes the process. The pool discards the broken connection
// and opens a new one on the next query, so logging is enough.
pool.on('error', (err) => {
  console.error('Idle Postgres connection error', err);
});

// Empties every table but keeps the schema and the migration history (pgmigrations). For tests and dev scripts
// (db:clear, db:seed) only, never app code. RESTART IDENTITY resets sequences; CASCADE covers foreign keys.
export async function truncateAllTables(db = pool) {
  const { rows } = await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'pgmigrations'`,
  );
  if (rows.length > 0) {
    const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
    await db.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  }
}

// Single statement on any free pooled connection.
export const query = (text, params) => pool.query(text, params);

// Runs fn(client) inside BEGIN/COMMIT on one dedicated connection; rolls back and rethrows on error.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
      client.release();
    } catch (rollbackErr) {
      // The connection is broken: release(err) makes the pool discard it instead of reusing it,
      // and the original error (not the rollback failure) is what the caller sees.
      client.release(rollbackErr);
    }
    throw err;
  }
}
