# timeline module

## Responsibility

- Assembling the home timeline and profile timelines

## What it needs to handle

- Choosing which posts appear and in what order
- Pagination
- Including author info, engagement counts, and viewer flags per item

## Interacts with

- `posts`: source content
- `follows`: who the viewer follows
- `engagement`: reposts in timelines, counts and flags
- `users`: author data

## Open questions

- Fan-out-on-read or fan-out-on-write? (See [docs/timeline.md](../../../docs/timeline.md).)
- Does this module own any tables, or only read from others?
- How will you avoid N+1 queries when building a page?
