// Loads and validates environment configuration.
// Reads .env locally (no-op when the file is absent, e.g. in Kubernetes) and fails fast on missing values.
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  clientOrigin: required('CLIENT_ORIGIN'),
};

export default config;
