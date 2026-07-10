---
title: Deduplicate and auto-resolve escalations instead of rendering the full append-only log
priority: medium
labels: [herd]
blocked_by: []
---

`herd-escalations.md` is append-only and the dashboard renders every block
forever — 45 red blocks today, most long since handled. Duplicates of the same
issue+reason stack up (see 0079-herd-stale-claim-monitor-ping-pong for the
worst producer), and an escalation stays screaming red even after its cause is
gone. The operator can no longer tell live problems from history.

## Acceptance criteria
- [ ] Escalations with the same issue and same reason render as one block showing an occurrence count and the latest timestamp
- [ ] A stale-claim escalation whose ref no longer exists on origin, and a PR-concluded escalation whose issue has since closed, render as resolved (visually de-emphasised), not as open alerts
- [ ] The open-escalation count shown to the operator counts only unresolved escalations
- [ ] The dashboard renders all unresolved escalations plus at most a fixed number of the most recent resolved ones, never the unbounded full history
- [ ] Every criterion above has exactly one test named after it

## Notes
The append-only file stays the source of record; resolution is derived state
(cross-checked against refs/issues/state), never a rewrite of the log.
