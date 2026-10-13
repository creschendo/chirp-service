# Auth

## Flows to design
- Sign up (what's required, uniqueness checks, password rules)
- Log in
- Log out
- Getting the current user ("who am I")
- Protecting routes (auth middleware responsibilities)

## Password handling
- Hashing with bcrypt (cost factor choice)
- Never returning hashes; where credentials vs. profile data live

## Tokens and cookies
- JWT contents (keep minimal) and expiry
- Access token only vs. access + refresh tokens
- Where the client keeps the token: httpOnly cookie vs. Authorization header
- Cookie flags: httpOnly, secure, sameSite, path, maxAge
- How logout ends a session when JWTs are stateless

## CORS for a separate client origin
- chirp-client runs on a different origin (port 5173)
- Allowed origin(s) from config
- Sending credentials (cookies) across origins and what that requires on both sides
- Differences between local dev and production

## CSRF
- Whether cookie-based auth needs CSRF protection given your sameSite choice

## Socket auth
- How the same identity is used for Socket.IO connections (see [realtime.md](realtime.md))

## Open questions
- Will you use refresh tokens? If so, where are they stored and how are they rotated?
- How will you revoke tokens on logout or password change?
- Will users log in with username, email, or both?
- What will the error messages for failed login reveal (avoid user enumeration)?
- Will you rate-limit login and sign-up attempts?
- What sameSite setting works for localhost:5173 → localhost:4000, and what changes in production?
