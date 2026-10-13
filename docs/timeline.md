# Timeline

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
