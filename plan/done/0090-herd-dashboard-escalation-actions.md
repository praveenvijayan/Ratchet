---
title: Escalation blocks get copy-command and acknowledge actions
priority: medium
labels: [herd]
blocked_by: [0082-herd-escalation-resolution]
---

Escalations tell the operator to run a command (e.g. the exact `gh api -X
DELETE ...` for a stale ref) but offer no way to grab it, and no way to mark an
escalation as handled. Add a copy button for the command and an acknowledge
button that records the resolution — the human still executes every command,
preserving the supervisor's never-merge/never-delete invariant.

## Acceptance criteria
- [ ] An escalation whose action contains a command shows a copy control that puts the exact command on the clipboard
- [ ] Acknowledging an escalation records it (issue, reason, timestamp) in a resolutions file and the block renders as resolved from then on, surviving dashboard restarts
- [ ] Acknowledging never executes any command and never mutates the escalations log, git refs, issues, or PRs
- [ ] A failed write of the resolution shows the operator a visible error on the block; the escalation stays unresolved
- [ ] Every criterion above has exactly one test named after it
