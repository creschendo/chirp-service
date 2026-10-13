# Architecture

## Overview
- One-paragraph description of the system: Express API + Socket.IO server backed by PostgreSQL
- How chirp-service relates to chirp-client (separate origins, separate repos)

## Layers
Request flow: **routes → controllers → services → repositories → db**
- **Routes:** what belongs here (path + middleware + controller binding) and what doesn't
- **Controllers:** translating HTTP to service calls; where validation happens
- **Services:** business rules, cross-module orchestration, transactions
- **Repositories:** SQL access only; how results are shaped before returning
- **db:** connection pool, transaction helpers
- Rules for which layers may call which (e.g. can a service call another module's repository?)

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

## Configuration
- How env vars are loaded and validated at startup
- Fail-fast behavior for missing/invalid config
- Per-environment differences (development, test, production)

## Logging
- What to log, at what level, and where

## Real-time integration
- How HTTP-side services trigger socket emissions without tight coupling

## Open questions
- Will you use custom error classes, or plain errors with status codes attached?
- Should services know about HTTP at all (status codes), or only domain errors?
- Will repositories use raw SQL strings, a query builder, or small helpers on top of `pg`?
- How will transactions be passed across repository calls?
- How will services emit real-time events: direct Socket.IO calls, an event emitter, or something else?
- Do you want dependency injection (passing the db/pool in) to make testing easier?
