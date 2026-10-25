# messages module

## Responsibility

- One-to-one direct messages between users

## What it needs to handle

- Starting or finding a conversation between two users
- Sending messages and listing conversation history with pagination
- Listing a user's conversations
- Real-time delivery to the other participant
- Ensuring only participants can read a conversation

## Interacts with

- `users`: participant info
- `realtime/`: live message delivery
- `notifications`: whether DMs also produce notifications

## Open questions

- Can anyone DM anyone, or only mutual follows?
- Will you track read state or unread counts?
- Are messages sent over REST, sockets, or both?
- Can messages be edited or deleted?
