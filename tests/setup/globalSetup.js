// Runs once before all tests: creates the test database if it doesn't exist, then applies pending migrations.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { testDatabaseUrl } from './testDatabaseUrl.js';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

export default async function globalSetup() {
  const url = testDatabaseUrl();
  const dbName = new URL(url).pathname.slice(1);

  // CREATE DATABASE has to run while connected to a different database.
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rowCount === 0) {
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(dbName)}`);
    }
  } finally {
    await admin.end();
  }

  await runner({
    databaseUrl: url,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  });
}
