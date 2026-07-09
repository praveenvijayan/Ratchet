---
title: Survive a herd worker spawn failure instead of crashing the supervisor
priority: medium
labels: [herd]
blocked_by: []
---

`spawnWorker` attaches an `exit` listener but no `error` listener. When an
adapter's binary is missing or not executable, the child emits `error`
asynchronously; with no listener the supervisor dies on an uncaught exception,
leaving a zero-byte log, a live-looking state entry, and no escalation — the
operator sees nothing.

## Acceptance criteria
- [ ] A launch command whose binary does not exist leaves the supervisor alive and polling; the issue is marked `dispatch-failed` with its pid cleared
- [ ] The spawn failure appends an escalation naming the adapter, the command, and the log file, so the operator sees why nothing ran
- [ ] A successful spawn behaves exactly as today (claim window, state entry, exit recording unchanged)
