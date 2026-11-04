# messages module

## Responsibility

- Direct messages: one-to-one chats and group chats

## Data

Migration `004_create-conversations-messages.js`:

- `conversations`: one row per chat. `kind` is `direct` or `group`. A direct chat stores its two users sorted
  (`direct_user_low_id < direct_user_high_id`) under a unique constraint, so each pair has exactly one.
  `last_activity_at` drives the inbox order.
- `conversation_participants`: who is in each chat, with `joined_at` (history before it is hidden) and
  `last_read_at` (unread counts).
- `messages`: soft-deleted like posts. `sender_id` becomes NULL if the sender's account is deleted.

## What it handles

- Starting or finding a one-to-one conversation; creating a group (up to 20 members)
- Sending messages and listing history, newest first, with cursor pagination
- The inbox: conversations by recent activity, with last-message preview and unread count
- Marking a conversation read
- Groups: adding members (any member can), leaving, renaming
- Deleting your own messages
- Real-time delivery to the other participants
- Only participants can see a conversation (others get 404)

Routes are mounted at `/conversations`; each route's comment in `routes.js` lists its responses. Real-time
delivery isn't wired up yet: each service function notes the emit it will make once `src/realtime/` exists.

## Files

- `routes.js`: the ten `/conversations` routes
- `service.js`: `createConversation`, `getConversation`, `listConversations`, `listMessages`, `sendMessage`,
  `deleteMessage`, `markRead`, `addMembers`, `leaveConversation`, `renameGroup`
- `store.js`: conversations, participants, messages, the inbox and read state, plus `lockConversation` for
  membership changes
- `schemas.js`: request bodies, path params and page queries, plus `MAX_GROUP_SIZE`

## Tests

- `tests/store/messages.test.js`: store, including constraints, the inbox query and cursor tie-breaks
- `tests/service/messages.test.js`: service rules, including concurrent sends, leaves and adds
- `tests/schemas/messages.test.js`: validation schemas
- `tests/api/messages.test.js`: every route over HTTP

## Interacts with

- `users`: participant info (joined read-only in queries)
- `realtime/`: live delivery (`message:new`, `message:deleted`, `conversation:new`, `conversation:updated`)
- `notifications`: none for now

## Decisions

- Anyone can DM anyone.
- Read state is tracked (`last_read_at`); unread counts are shown in the inbox.
- Members added to a group don't see messages from before they joined.
- Messages are sent over REST; Socket.IO only delivers.
- Editing messages is deferred.
- Built after notifications and the real-time layer (milestone 5).

## Deferred

- Editing messages
- Group roles (owner/admin) and removing other members
- Typing indicators, presence, read receipts visible to others
