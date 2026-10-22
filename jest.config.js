// Jest config. Run via `npm test` (ES modules need --experimental-vm-modules; see package.json).
export default {
  testEnvironment: 'node',
  transform: {},
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // Creates the test database (if missing) and runs migrations once per run.
  globalSetup: '<rootDir>/tests/setup/globalSetup.js',
  // Points DATABASE_URL at the test database before any src module loads config.
  setupFiles: ['<rootDir>/tests/setup/env.js'],
  // One file at a time: API tests commit data and truncate tables, which would disturb parallel files.
  maxWorkers: 1,
};
