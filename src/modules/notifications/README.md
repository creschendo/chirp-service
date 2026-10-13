# notifications module

## Responsibility
- Creating, storing, listing, and delivering notifications

## What it needs to handle
- Which actions create notifications
- Listing notifications with pagination
- Read/unread state
- Real-time delivery to the recipient

## Interacts with
- `follows`, `posts`, `engagement`: sources of notification-worthy actions
- `realtime/`: pushing notifications to connected clients

## Open questions
- Do other modules call this module directly, or emit events it listens to?
- What happens to a notification when the underlying action is undone (e.g. unlike)?
- Will notifications be aggregated?
