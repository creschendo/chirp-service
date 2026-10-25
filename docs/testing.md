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

- Locally and (optionally) in CI

## Open questions

- Will integration tests hit a real Postgres, or will you mock stores?
- How will you isolate tests from each other if they run in parallel?
- Will you aim for a coverage target, or focus on critical paths?
- How will you test timeline ordering and pagination edge cases?
- Will you set up GitHub Actions to run tests on push?
