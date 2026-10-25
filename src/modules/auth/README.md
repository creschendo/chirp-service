# auth module

## Responsibility

- Account creation, login, logout, and identifying the current user

## What it needs to handle

- Credential validation and password hashing
- Issuing and clearing tokens/cookies
- Rejecting duplicate accounts
- Providing the identity used by auth middleware and socket auth

## Interacts with

- `users`: creating the profile that goes with a new account
- `middleware/`: auth middleware that verifies tokens
- `realtime/`: socket authentication

## Open questions

- Does this module own the credentials data, or does `users` own it?
- Where does token verification live: here or in middleware?
- What does "log out" do on the server, if anything?
