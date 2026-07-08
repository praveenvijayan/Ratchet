---
title: Add email/password login
priority: high
labels: [auth]
blocked_by: []
---

Let users sign in with an email address and password and receive a session
token. This is the first auth flow; password reset and OAuth come later as
separate plan files.

## Acceptance criteria
- [ ] `POST /login` accepts `{ email, password }` and returns a session token on success
- [ ] Invalid credentials return `401` with a generic message (no user enumeration)
- [ ] Passwords are verified against the stored hash, never compared in plain text
- [ ] Every criterion above has exactly one test named after it
