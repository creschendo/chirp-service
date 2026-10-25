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
