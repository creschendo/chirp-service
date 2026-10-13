# API Contract

> **Placeholder.** This file is where the final API and socket contract will be defined.

## Purpose
- This is the single source of truth that the future **chirp-client** (React, running on port 5173) will consume
- It will be filled in after the designs in [api-design.md](api-design.md) and [realtime.md](realtime.md) are settled

## What will go here
- REST endpoints per resource group, with request and response shapes
- Error response format and status codes
- Pagination format
- Authentication requirements per endpoint (and how the client sends credentials)
- Socket.IO connection/auth handshake, events in both directions, and their payloads
- Changelog of contract changes

## Open questions
- Will you write this contract by hand in Markdown, or generate it (e.g. OpenAPI)?
- Will the Zod schemas be the source of truth for request/response shapes?
- How will you share types or schemas with chirp-client, if at all?
