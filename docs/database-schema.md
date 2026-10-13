# Database Schema

> Outline only. You'll define tables and columns yourself as you design each milestone.

## Entities to model
- Users / accounts (credentials vs. public profile data)
- Posts (original posts, replies, quote posts)
- Reposts
- Follows
- Likes
- Bookmarks
- Notifications
- Conversations and direct messages
- Session / refresh token storage (if your auth design needs it)

## Relationships to think about
- User ↔ user (following is directional)
- Post ↔ author
- Post ↔ parent post (replies, threads)
- Post ↔ quoted post
- User ↔ post engagement (likes, reposts, bookmarks)
- Notification ↔ actor, recipient, and the thing acted on
- Conversation ↔ its two participants; message ↔ conversation and sender

## Constraints and integrity
- Uniqueness rules (e.g. one like per user per post)
- What happens on delete (cascade, soft delete, orphan handling)
- Preventing invalid states (self-follow, empty posts, etc.)
- Where to enforce rules: database constraints vs. application code

## Indexing considerations
- Queries that must be fast: home timeline, profile timeline, thread view, notifications list, conversation history
- Index needs for foreign keys and lookups by user
- Indexes that support your pagination approach
- Tradeoff of indexes vs. write cost

## Counts and denormalization
- Like/repost/reply/follower counts: computed on read vs. stored

## Migrations
- Migration naming and ordering with node-pg-migrate
- Up/down expectations; seeding dev data

## Open questions
- How will you store reposts vs quote posts: same table or separate?
- Are replies just posts with a parent reference, or a separate entity?
- Will deleting a post hard-delete it or soft-delete it? What happens to its replies and quotes?
- Will you store counts on rows, or compute them? How will you keep stored counts correct?
- What ID type will you use (serial integers, UUIDs, something sortable)?
- How will a DM conversation between two users be uniquely identified?
- How will you represent a notification's target when it can point at different kinds of things?
- Will usernames be case-insensitive? How will you enforce that?
