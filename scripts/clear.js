// npm run db:clear: empties every table in the database DATABASE_URL points at, keeping the schema and migration
// history. Faster than db:reset (which recreates the whole Docker volume). Refuses to run in production.
import config from '../src/config/index.js';
import { pool, truncateAllTables } from '../src/db/index.js';

if (config.env === 'production') {
  console.error('db:clear refuses to run with NODE_ENV=production.');
  process.exit(1);
}

const dbName = new URL(config.databaseUrl).pathname.slice(1);
try {
  await truncateAllTables();
  console.log(`Cleared all tables in "${dbName}".`);
} finally {
  await pool.end();
}
