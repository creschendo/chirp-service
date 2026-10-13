# Roadmap

## Milestone 1: Auth
- [ ] Install dependencies; configure ESLint and Prettier
- [ ] Config loading, database connection, first migration runs
- [ ] Server boots on port 4000 with central error handling
- [ ] Design auth flow and token/cookie strategy ([auth.md](auth.md))
- [ ] Sign up
- [ ] Log in
- [ ] Log out
- [ ] Auth middleware protecting routes
- [ ] CORS configured for chirp-client
- [ ] Tests for auth flows

## Milestone 2: Posts + profiles
- [ ] Design user/profile and post data
- [ ] View a profile
- [ ] Edit own profile
- [ ] Create a post
- [ ] Delete own post
- [ ] View a single post
- [ ] Tests

## Milestone 3: Follows + timeline
- [ ] Decide fan-out strategy and pagination ([timeline.md](timeline.md))
- [ ] Follow / unfollow
- [ ] Followers / following lists
- [ ] Profile timeline
- [ ] Home timeline
- [ ] Pagination
- [ ] Tests

## Milestone 4: Engagement
- [ ] Decide repost vs quote post modeling
- [ ] Likes
- [ ] Reposts
- [ ] Quote posts
- [ ] Replies and thread view
- [ ] Bookmarks
- [ ] Engagement counts and viewer flags in timelines
- [ ] Tests

## Milestone 5: Notifications
- [ ] Design real-time layer and socket auth ([realtime.md](realtime.md))
- [ ] Persist notifications
- [ ] List notifications and mark them read
- [ ] Real-time delivery
- [ ] Tests

## Milestone 6: DMs
- [ ] Design conversations and messages
- [ ] Start or open a one-to-one conversation
- [ ] Send and list messages
- [ ] Real-time message delivery
- [ ] Tests

## Open questions
- What is "done" for each milestone: tests passing, contract documented, client integrated?
- When will you start building chirp-client alongside the API?
