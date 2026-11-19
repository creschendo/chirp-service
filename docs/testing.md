# Testing

## Goals

- What confidence you want from tests at this stage of the project

## Test types

- Unit tests (services, validation schemas, helpers)
- Integration tests (HTTP endpoints via Supertest against a real database)
- Real-time tests (Socket.IO client connecting to a test server)

## Tooling

- Jest + Supertest
- Jest with ES modules (what setup is needed)

## Test database

- Separate database for tests
- Running migrations before tests
- Resetting state between tests (truncate, transactions, recreate)

## Fixtures and helpers

- Creating users, posts, follows quickly
- Getting an authenticated agent/cookie for requests

## What to cover per milestone

- Happy paths, validation failures, auth/authorization failures, edge cases

## Running tests

- Locally: `npm run db:up`, then `npm test`. The tests create `<db>_test` and run migrations themselves.
- In CI: `.github/workflows/ci.yml` runs on every pull request and on pushes to `main`, as three parallel jobs:
  - **Format and lint:** `npm run format:check`, `npm run lint`
  - **Tests:** `npm test -- --ci` against a Postgres 17 service container (same image as `compose.yaml`), with dummy
    `DATABASE_URL`, `JWT_SECRET` and `CLIENT_ORIGIN`
  - **Migrations up, down, up:** every migration up, all the way down (failing if any table is left), then up again,
    since the tests only ever run `up`
- Node version: `.nvmrc` (22), used by CI's `setup-node`; use the same locally (`nvm use`).

## Open questions

- Will integration tests hit a real Postgres, or will you mock stores?
- How will you isolate tests from each other if they run in parallel?
- Will you aim for a coverage target, or focus on critical paths?
- How will you test timeline ordering and pagination edge cases?
