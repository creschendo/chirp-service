// Database helpers for tests.
import { pool, truncateAllTables } from '../../src/db/index.js';

// Store tests: every test runs inside a transaction that is rolled back afterwards, so tests never see
// each other's data and nothing is left behind. Call once per file, at the top level; pass ctx.db to store
// functions (their optional last argument).
export function useTransaction() {
  const ctx = {};
  beforeEach(async () => {
    ctx.db = await pool.connect();
    await ctx.db.query('BEGIN');
  });
  afterEach(async () => {
    await ctx.db.query('ROLLBACK');
    ctx.db.release();
  });
  afterAll(() => pool.end());
  return ctx;
}

// Runs fn and returns the Postgres error code it throws (e.g. '23505'), the message for non-Postgres errors,
// or null if it didn't throw. Uses a savepoint, because a failed statement otherwise aborts the whole
// transaction and every later query in the test would fail too.
export async function pgErrorCode(db, fn) {
  await db.query('SAVEPOINT expect_error');
  try {
    await fn();
    return null;
  } catch (err) {
    return err.code ?? err.message;
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT expect_error');
  }
}

// API tests: requests go through the app's pool, so their data is committed. Empty every table
// (except the migrations table) between tests instead.
export function resetDatabase() {
  return truncateAllTables();
}

export { pool };
