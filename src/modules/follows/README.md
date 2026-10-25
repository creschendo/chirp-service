# follows module

## Responsibility

- Following and unfollowing users, and listing followers/following

## What it needs to handle

- Follow / unfollow (idempotency, self-follow prevention)
- Followers and following lists with pagination
- Relationship checks used by other modules (e.g. the "do I follow them" flag on profiles)
- Routes are mounted under `/users` alongside the users router

## Interacts with

- `users`: profile data in lists
- `timeline`: who appears in the home timeline
- `notifications`: new follower notifications

## Open questions

- What should happen if you follow someone you already follow?
- If you choose fan-out-on-write, what happens to the timeline on follow/unfollow?
- Will there be private accounts or follow requests? (Probably out of scope; decide explicitly.)
