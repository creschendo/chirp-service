# engagement module

## Responsibility

- Likes, reposts, and bookmarks (and possibly quote posts/replies, depending on your design)

## What it needs to handle

- Adding and removing likes, reposts, and bookmarks (idempotently)
- Counts per post
- Viewer-specific flags ("I liked this")
- Listing a user's bookmarks (private) and likes

## Interacts with

- `posts`: the target of engagement
- `timeline`: reposts appear in timelines
- `notifications`: like/repost notifications

## Open questions

- Should quote posts live here or in `posts`?
- Are bookmarks visible to anyone other than their owner?
- Can you repost your own post? Like your own post?
