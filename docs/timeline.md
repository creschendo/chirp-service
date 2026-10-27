# Timeline

## Decisions

- **Fan-out on read.** Each request builds the timeline with one query over `posts` and `follows`; the timeline
  module owns no tables. Follows, unfollows and deletes take effect immediately. Revisit (fan-out on write or a
  cache) only if the home query gets slow, e.g. for viewers following thousands of accounts.
- **What appears:** original posts and quote posts. Replies stay inside their conversations, out of both timelines
  (a profile "Replies" tab can come later).
- **Home timeline:** posts by the viewer and everyone they follow.
- **Profile timeline:** that user's posts.
- **Deleted posts are hidden** from timelines; they still resolve by id and inside threads and quotes.
- **Order:** newest first by `created_at`, `post_id` breaking ties.
- **Pagination:** cursor (keyset), `{ items, nextCursor }` like every list (see `src/pagination.js`). The cursor is
  the last item's `{ createdAt, postId }`, so posts arriving while you scroll don't shift later pages.
- **Items** are post views (the `GET /posts/:post_id` shape), built by one query with author and quoted post joined
  in: no N+1.
- **Later (engagement):** reposts merged in at repost time, each post shown once even if several followed users
  reposted it; counts and viewer flags per item. "New posts since" for refresh is deferred.

## Timelines to support

- Home timeline: posts from people the user follows (and the user's own?)
- Profile timeline: a single user's posts (do reposts and replies show here?)

## What appears in a timeline

- Original posts, reposts, quote posts, replies: decide the rules for each
- Ordering (by post time vs. repost time)
- Deduplication (same post reposted by several followed users)

## Fan-out strategies to research

- **Fan-out-on-read (pull):** build the timeline at query time from follows
  - Research: query cost as follow counts grow, indexing needs
- **Fan-out-on-write (push):** write post references into followers' timelines when posting
  - Research: write amplification, users with many followers, handling unfollows and deletes
- **Hybrid approaches** and when they're worth it
- Which one fits this project's scale and learning goals

## Pagination approach

- Offset vs. cursor (keyset) pagination tradeoffs
- Stability when new posts arrive while paging
- What the cursor is made of and how ties are broken
- Fetching "new posts since" for refresh

## Data needed per timeline item

- Author info, engagement counts, viewer-specific flags
- Avoiding N+1 queries

## Open questions

- Which fan-out strategy will you start with, and what would make you switch?
- How will you paginate the timeline?
- Does a repost move a post to the top of the timeline?
- Should deleted posts disappear immediately from all timelines?
- Do replies to people you don't follow show in your home timeline?
- How will you test timeline correctness and performance?
