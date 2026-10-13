# chirp-service

Backend API for **Chirp**, a Twitter clone. Built with Node.js (ES modules), Express, PostgreSQL, and Socket.IO for real-time features. The frontend lives in a separate repo (`chirp-client`, React, port 5173).

> Status: planning skeleton. Code files are stubs; design lives in [`docs/`](docs/).

## Requirements

- Node.js (LTS)
- A **local PostgreSQL** instance (required — the API will not run without one)

## Setup

1. Clone the repo and `cd chirp-service`
2. Install dependencies: `npm install`
3. Create a local Postgres database for Chirp
4. Copy `.env.example` to `.env` and fill in the values
5. Run migrations: `npm run migrate up`
6. Start the dev server: `npm run dev`

The API runs on **port 4000** by default.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm start` | Run the server |
| `npm run dev` | Run the server with nodemon (auto-restart) |
| `npm test` | Run tests with Jest + Supertest |
| `npm run lint` | Lint with ESLint |
| `npm run format` | Format with Prettier |
| `npm run migrate` | Run node-pg-migrate (e.g. `npm run migrate up`) |

## Environment variables

See `.env.example`.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Runtime environment (development / test / production) |
| `PORT` | Port the API listens on (4000) |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret used to sign auth tokens |
| `CLIENT_ORIGIN` | Allowed CORS origin for chirp-client |

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
  modules/    feature modules (routes → controller → service → repository → db)
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
