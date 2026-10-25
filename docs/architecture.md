# Architecture

## Overview

- One-paragraph description of the system: Express API + Socket.IO server backed by PostgreSQL
- How chirp-service relates to chirp-client (separate origins, separate repos)

## Layers

Request flow: **routes → services → stores → db**

- **Routes:** path + middleware + thin inline handlers (no separate controller layer)
  - A handler only translates HTTP ↔ service: read validated input, call one service function, map the result to a status code and response
  - No SQL and no business rules in handlers
  - Where validation happens (validation middleware vs. inside the handler)
  - When a module's route file is big enough to justify splitting handlers out
- **Services:** business rules, cross-module orchestration, transactions; no knowledge of `req`/`res`
- **Stores:** SQL access only; how results are shaped before returning
- **db:** connection pool, transaction helpers
- Rules for which layers may call which (e.g. can a service call another module's store?)

## Module structure

- What a feature module owns (`src/modules/*`)
- How modules share logic without circular dependencies
- Where cross-cutting concerns live (`middleware/`, `realtime/`, `config/`)

## Error handling

- Error categories to distinguish (validation, auth, not found, conflict, unexpected)
- Where errors are thrown vs. caught
- Responsibilities of the central error-handling middleware
- What gets logged vs. what gets returned to the client
- Async error propagation in Express 5

## Configuration via environment variables

- All config comes from environment variables (`.env` locally via dotenv; ConfigMap/Secret in Kubernetes)
- How env vars are loaded and validated at startup
- Fail-fast behavior for missing/invalid config
- Per-environment differences (development, test, production) expressed only through env vars, not code branches
- No config files baked into the image

## Logging to stdout

- Write logs to stdout/stderr only; let the platform (terminal, kubectl, a log collector) handle storage
- What to log, at what level
- Structured (JSON) vs. human-readable output, and whether it differs by environment
- Request logging and correlation/request IDs
- Never logging secrets, passwords, or tokens

## Graceful shutdown

- Handling SIGTERM and SIGINT
- Shutdown order: mark not-ready, stop accepting new connections, finish in-flight requests, close Socket.IO connections, close the DB pool, exit
- A timeout that forces exit if shutdown hangs
- How this fits the Kubernetes termination grace period (see [deployment.md](deployment.md))

## Real-time integration

- How HTTP-side services trigger socket emissions without tight coupling

## Open questions

- Will you use custom error classes, or plain errors with status codes attached?
- Should services know about HTTP at all (status codes), or only domain errors?
- Will stores use raw SQL strings, a query builder, or small helpers on top of `pg`?
- How will transactions be passed across store calls?
- How will services emit real-time events: direct Socket.IO calls, an event emitter, or something else?
- Do you want dependency injection (passing the db/pool in) to make testing easier?
- Will you use a logging library or `console`? Which log format?
- How long should graceful shutdown wait before forcing exit?
