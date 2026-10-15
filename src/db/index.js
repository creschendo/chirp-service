// PostgreSQL connection pool and query helpers.
import pg from 'pg';

// One pool for the whole process; every repository imports this same instance.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
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
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
