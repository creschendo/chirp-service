# Real-time

## What needs to be real-time

- Notifications (likes, reposts, quotes, replies, follows, etc.: decide which)
- Direct messages (delivery, possibly read state)
- Things that probably don't need it (decide explicitly, e.g. live timeline updates, live counts)

## Socket authentication

- How a socket connection proves who the user is
- What happens when the token expires during a connection
- Rejecting unauthenticated connections

## Rooms

- Which rooms exist and who joins them
- Handling one user with multiple tabs or devices

## Event design

- Naming conventions for events
- Server → client vs. client → server events
- Acknowledgements and error handling for client-sent events

## Integration with HTTP

- How REST actions trigger socket emissions
- Whether DMs are sent over REST, sockets, or both

## Reliability

- What happens to events when the user is offline
- How the client catches up after reconnecting

## Scaling (awareness only)

- What changes with multiple server instances (adapters), and whether that's in scope

## Open questions

- Will the socket reuse the same auth cookie/token as HTTP, or a separate handshake token?
- Is a notification persisted first and then emitted, or emitted first?
- Will you track online presence? Read receipts? Typing indicators?
- How will you avoid notifying users about their own actions?
- Will you batch/aggregate notifications (e.g. "5 people liked your post")?
