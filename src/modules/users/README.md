# users module

## Responsibility
- User profiles: viewing and editing public profile information

## What it needs to handle
- Looking up a user by username or ID
- Editing one's own profile
- Profile-level data shown to others (and what stays private)

## Interacts with
- `auth`: account creation
- `follows`: follower/following counts and "do I follow them" flags
- `timeline`: profile timeline

## Open questions
- Which profile fields are editable, and which are fixed?
- Will profiles include counts (posts, followers, following)? Computed or stored?
- Can usernames change? What breaks if they do?
