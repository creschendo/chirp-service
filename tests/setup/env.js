// Runs before each test file, before src/config loads: dotenv never overrides variables that are already set,
// so every src module (and the pool) uses the test database.
import { testDatabaseUrl } from './testDatabaseUrl.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testDatabaseUrl();
