# Roadmap

## Milestone 1: Auth

- [x] Install dependencies; configure ESLint and Prettier
- [x] Config loading, database connection, first migration runs
- [x] Server boots on port 4000 with central error handling
- [x] Design auth flow and token/cookie strategy ([auth.md](auth.md))
- [x] Sign up
- [x] Log in
- [x] Log out
- [x] Auth middleware protecting routes
- [x] CORS configured for chirp-client
- [x] Tests for auth flows

## Milestone 2: Posts + profiles

- [x] Design user/profile and post data
- [x] View a profile
- [x] Edit own profile
- [x] Create a post
- [x] Delete own post
- [x] View a single post
- [x] Tests

## Milestone 3: Follows + timeline

- [x] Decide fan-out strategy and pagination ([timeline.md](timeline.md))
- [x] Follow / unfollow
- [x] Followers / following lists
- [ ] Profile timeline
- [ ] Home timeline
- [x] Pagination
- [ ] Tests

## Milestone 4: Engagement

- [x] Decide repost vs quote post modeling
- [ ] Likes
- [ ] Reposts
- [x] Quote posts
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

## Milestone 7: Deploy to a local Kubernetes cluster

- [ ] Choose kind or k3d and create a cluster ([deployment.md](deployment.md))
- [ ] Health module with liveness and readiness checks
- [x] Graceful shutdown on SIGTERM
- [ ] Dockerfile and .dockerignore; build the image and load it into the cluster
- [ ] Postgres StatefulSet with persistent storage
- [ ] ConfigMap and Secret for configuration
- [ ] Migrations run as a Job
- [ ] API Deployment with probes, plus Service and Ingress
- [ ] Kustomize base and local overlay apply cleanly
- [ ] chirp-client can reach the API through the ingress (HTTP and WebSockets)

## Milestone 8: Scale to multiple replicas with Redis for Socket.IO

- [ ] Run Redis in the cluster
- [ ] Socket.IO Redis adapter so events reach users on any pod
- [ ] Decide on sticky sessions vs. WebSocket-only transport
- [ ] Scale the API to multiple replicas
- [ ] Readiness checks Redis as well
- [ ] Verify notifications and DMs work across pods
- [ ] Verify rolling updates don't drop requests

## Open questions

- What is "done" for each milestone: tests passing, contract documented, client integrated?
- When will you start building chirp-client alongside the API?
