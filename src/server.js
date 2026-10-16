// Entry point: creates the HTTP server, attaches Socket.IO, and listens on the configured port.
import http from 'node:http';
import config from './config/index.js';
import app from './app.js';
import { pool } from './db/index.js';

const server = http.createServer(app);
// TODO: attach Socket.IO to `server` once realtime/ is implemented.

server.listen(config.port, () => {
  console.log(`chirp-service listening on port ${config.port} (${config.env})`);
});

// Graceful shutdown: stop accepting connections, let in-flight requests finish, close the pool.
// Forces exit if that takes longer than 10s.
async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
