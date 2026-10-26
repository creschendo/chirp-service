# Database Schema

> Outline only. You'll define tables and columns yourself as you design each milestone.
> Work through [data-modeling-guide.md](data-modeling-guide.md) first and record your decisions here.

## Decisions

### Posts (migration 003)

- **Replies are posts.** One `posts` table for originals, replies and quote posts. A reply has `parent_post_id`
  (the post it answers) and `root_post_id` (the conversation's original). Replies can be liked, reposted and
  quoted like any post.
- **Nesting is unlimited.** `root_post_id` makes "everything in this conversation" one indexed lookup; the
  service sets it on insert (the parent's root, or the parent itself if it's an original).
- **Quote posts** are posts with `quoted_post_id`, and need their own content.
- **Reposts get their own table** (engagement milestone): a user → post relationship with a time, primary key
  `(user_id, post_id)`. The home timeline merges posts and reposts.
- **Deleting a post is a soft delete:** `deleted_at` is set and `content` cleared, so replies and quotes still
  point at a row and can show "This post was deleted". Replying to or quoting a deleted post is refused.
- **Content:** 1–280 characters for every live post.
- **Account deletion** (deferred) will need to soft-delete the user's posts; hard-deleting a user whose posts
  others replied to or quoted fails on the foreign keys.

## Current modeling scope

- Users / accounts (credentials vs. public profile data)
- Posts (original posts and quote posts)
- Comments
- Reposts
- Follows
- Likes
- Session / refresh token storage (if your auth design needs it)

## Deferred (not modeled yet)

- Bookmarks
- Notifications
- Direct messages

These stay in the product roadmap but are left out of the schema until their milestones. Design the current scope so they can be added later without reworking it.

## Relationships to think about

- User ↔ user (following is directional)
- Post ↔ author
- Comment ↔ post it belongs to, and ↔ author
- Comment ↔ parent comment (if comments can nest)
- Post ↔ quoted post
- User ↔ post engagement (likes, reposts)
- Likes on comments (if allowed)

## Constraints and integrity

- Uniqueness rules (e.g. one like per user per post)
- What happens on delete (cascade, soft delete, orphan handling)
- Preventing invalid states (self-follow, empty posts or comments, etc.)
- Where to enforce rules: database constraints vs. application code

## Indexing considerations

- Queries that must be fast: home timeline, profile timeline, a post's comments, followers/following lists
- Index needs for foreign keys and lookups by user
- Indexes that support your pagination approach
- Tradeoff of indexes vs. write cost

## Counts and denormalization

- Like/repost/comment/follower counts: computed on read vs. stored

## Migrations

- Migration naming and ordering with node-pg-migrate
- Up/down expectations; seeding dev data

## Open questions

- Are comments their own entity, or posts with a parent reference?
- Can comments be nested (comments on comments), and how deep?
- Can comments be liked, reposted, or quoted?
- How will you store reposts vs quote posts: same table or separate?
- Will deleting a post hard-delete it or soft-delete it? What happens to its comments and quotes?
- Will you store counts on rows, or compute them? How will you keep stored counts correct?
- What ID type will you use (serial integers, UUIDs, something sortable)?
- Will usernames be case-insensitive? How will you enforce that?
