// Resolves the test database URL: TEST_DATABASE_URL if set, otherwise DATABASE_URL with "_test"
// appended to the database name (chirp -> chirp_test). Never returns the dev database URL.
import dotenv from 'dotenv';

export function testDatabaseUrl() {
  dotenv.config({ quiet: true });
  if (process.env.TEST_DATABASE_URL) {
    return process.env.TEST_DATABASE_URL;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('Set DATABASE_URL (or TEST_DATABASE_URL) to run tests');
  }
  const url = new URL(process.env.DATABASE_URL);
  const name = url.pathname.slice(1);
  if (name.endsWith('_test')) {
    return url.toString();
  }
  url.pathname = `/${name}_test`;
  return url.toString();
}
