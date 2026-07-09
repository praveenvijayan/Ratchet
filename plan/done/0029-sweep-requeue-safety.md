---
title: Requeue swept issues safely — criteria re-check and label race
priority: medium
blocked_by: []
---

Two requeue hazards in the sweep. It sets `state:ready` unconditionally, so an
issue whose body lost its criteria (hand-edited after promotion) re-enters the
pickable queue — the same class of bug `unblock-dependents` already guards with
the shared criteria check. And label writes are computed from the issue
snapshot taken when the sweep listed issues, possibly minutes and many API
calls earlier, so an agent transitioning the issue in that window has its state
label silently overwritten.

## Acceptance criteria
- [ ] A swept issue whose body lacks acceptance criteria is requeued to `state:draft` (with the explanatory comment), never `state:ready`
- [ ] Label updates are computed from the issue's labels re-read at write time — a state change made after the initial listing is not overwritten
