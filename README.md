# chirp-service

Backend API for **Chirp**, a Twitter clone. Built with Node.js (ES modules), Express, PostgreSQL, and Socket.IO for real-time features. The frontend lives in a separate repo (`chirp-client`, React, port 5173).

> Status: planning skeleton. Code files are stubs; design lives in [`docs/`](docs/).

## Requirements

- Node.js (LTS)
- A **local PostgreSQL** instance (required — the API will not run without one). The easiest way is Docker: `compose.yaml` runs Postgres 17 for you.

## Setup

1. Clone the repo and `cd chirp-service`
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env` and fill in the values (`DATABASE_URL` must match the `POSTGRES_*` values, e.g. `postgres://USER:PASSWORD@localhost:5432/DB`)
4. Start Postgres in Docker: `npm run db:up`
   - If a native Postgres is already installed, it may own port 5432 and you'll get `password authentication failed`. Set `POSTGRES_PORT` (and the port in `DATABASE_URL`) to a free port, then run `npm run db:up` again.
5. Run migrations: `npm run migrate up`
6. Start the dev server: `npm run dev`

The API runs on **port 4000** by default.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm start` | Run the server |
| `npm run dev` | Run the server with nodemon (auto-restart) |
| `npm run dev:all` | Start Postgres, run pending migrations, then `npm run dev` |
| `npm test` | Run tests with Jest + Supertest |
| `npm run lint` | Lint with ESLint |
| `npm run format` | Format with Prettier |
| `npm run migrate` | Run node-pg-migrate (e.g. `npm run migrate up`) |
| `npm run db:up` | Start Postgres in Docker and wait until it's healthy |
| `npm run db:down` | Stop Postgres (data is kept in a Docker volume) |
| `npm run db:reset` | Stop Postgres and **delete all data**, then start fresh |
| `npm run db:psql` | Open a `psql` shell inside the container |

## Environment variables

See `.env.example`.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Runtime environment (development / test / production) |
| `PORT` | Port the API listens on (4000) |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret used to sign auth tokens |
| `CLIENT_ORIGIN` | Allowed CORS origin for chirp-client |
| `POSTGRES_USER` | Postgres user created by the Docker container |
| `POSTGRES_PASSWORD` | Password for that user |
| `POSTGRES_DB` | Database created by the Docker container |
| `POSTGRES_PORT` | Host port for Docker Postgres (defaults to 5432) |

## Project layout

```
docs/         planning docs (architecture, schema, API, realtime, auth, timeline, testing, roadmap)
migrations/   node-pg-migrate migration files
src/
  app.js      Express app
  server.js   HTTP + Socket.IO entry point
  config/     environment config
  db/         Postgres connection
  middleware/ shared Express middleware
  realtime/   Socket.IO setup
  health/     liveness and readiness checks
  modules/    feature modules (routes → service → store → db)
tests/        test suites
k8s/
  base/       shared Kubernetes manifests (Kustomize base)
  overlays/
    local/    local cluster overlay (kind or k3d)
Dockerfile    container image build
```

## Deployment

Practice deployment targets a local Kubernetes cluster. See [`docs/deployment.md`](docs/deployment.md).

## Feature scope

1. **Core:** auth (sign up, log in, log out), profiles, creating/deleting posts, following, home timeline, profile timeline
2. **Engagement:** likes, reposts, quote posts, replies/threads, bookmarks
3. **Notifications & DMs:** real-time notifications, one-to-one direct messages

## Out of scope

- Search
- Hashtags / trending
- Media uploads
- Group DMs
- Admin / moderation
