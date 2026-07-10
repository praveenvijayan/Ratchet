---
title: Herd scripts resolve .ratchet paths from the repo root, not the cwd
priority: medium
labels: [herd]
blocked_by: []
---

`STATE_FILE`, `ESCALATIONS_FILE`, `EVENTS_FILE`, and `ROUTING_FILE` are
cwd-relative. Running any herd script from a subdirectory (e.g. `scripts/`)
silently reads and writes a fresh empty `.ratchet/` there: the dashboard
renders empty, the supervisor forgets all state, and nothing hints why. This
already burned one debugging session.

## Acceptance criteria
- [ ] Every herd script reads and writes the same `.ratchet/` files regardless of the directory it is invoked from within the repo
- [ ] Invoked from outside any checkout of the repo, a herd script exits non-zero with a one-line error naming the path it could not resolve, never silently creating a new `.ratchet/` directory
- [ ] Every criterion above has exactly one test named after it
