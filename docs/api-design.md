# API Design

> Outline only. You'll define endpoints and payloads yourself; the final contract goes in [api-contract.md](api-contract.md).

## Resource groups to design

- Auth
- Users / profiles
- Follows
- Posts (including replies and quote posts)
- Timelines (home, profile)
- Engagement (likes, reposts, bookmarks)
- Notifications
- Direct messages

## Conventions to decide

### Naming

- URL style (plural nouns, nesting depth, casing)
- Field naming in JSON (camelCase vs snake_case) and where conversion happens
- Versioning (prefix or none)

### Status codes

- Which codes to use for create, delete, validation errors, auth failures, forbidden, not found, conflicts

### Pagination

- Style (offset vs. cursor) and how it's expressed in requests and responses
- Default and max page sizes

### Errors

- A consistent error response shape
- How validation errors from Zod are surfaced

### Validation

- Where Zod schemas are applied (body, params, query)

### Response shape

- Envelope vs. bare resources
- How embedded data is included (e.g. author info on a post, "did I like this" flags)

## Authorization rules

- Who can do what to each resource (e.g. only the author deletes a post)

## Idempotency

- What happens when a user likes/follows/bookmarks something twice, or undoes something they never did

## Open questions

- Will engagement actions be modeled as sub-resources of posts or as their own resources?
- How will the client know whether the current user has liked/reposted/bookmarked each post in a list?
- Will you return the full created resource after a POST, or just an ID?
- How will you represent deleted posts that still appear in threads or as quoted posts?
- Will you rate-limit any endpoints? Which ones?
