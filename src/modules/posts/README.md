# posts module

## Responsibility
- Creating, reading, and deleting posts, including replies and quote posts

## What it needs to handle
- Post content validation (length, empty content)
- Creating original posts, replies, and quote posts
- Deleting own posts and what that does to related data
- Viewing a single post and its thread

## Interacts with
- `users`: author info
- `engagement`: counts and viewer flags
- `timeline`: posts feed into timelines
- `notifications`: reply/quote notifications

## Open questions
- Do replies and quote posts belong here or in `engagement`?
- How will a thread be fetched: ancestors, descendants, both?
- What does a deleted post look like inside a thread or a quote?
