// Express app setup: middleware, route mounting, and error handling.
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import config from './config/index.js';
import authRoutes from './modules/auth/routes.js';
import usersRoutes from './modules/users/routes.js';
import followsRoutes from './modules/follows/routes.js';

const app = express();

// credentials: true lets the client send the auth cookies cross-origin.
app.use(cors({ origin: config.clientOrigin, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Mount each module's router here as it's implemented (unimplemented routes.js files have no default export).
app.use('/auth', authRoutes);
app.use('/users', usersRoutes);
app.use('/users', followsRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Express 5 forwards errors thrown in async handlers here.
// Client errors from middleware (e.g. malformed JSON -> 400) keep their status; everything else is a 500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status ?? 500;
  if (status >= 500) {
    console.error(err);
  }
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

export default app;
