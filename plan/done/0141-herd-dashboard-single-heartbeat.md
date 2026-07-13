---
title: Herd dashboard shows one supervisor heartbeat, not two
priority: low
labels: [herd, dashboard]
blocked_by: []
---

The dashboard header renders the supervisor heartbeat twice: the dot-based
"supervisor live · heartbeat Xs ago" element and, next to it, a text block
"SUPERVISOR LIVE heartbeat Xs ago · polls every 1m". Remove the text-based
"SUPERVISOR LIVE" block and keep the dot-based indicator.

## Acceptance criteria
- [ ] The header renders exactly one supervisor heartbeat indicator — the dot-based one; the text-based "SUPERVISOR LIVE" block no longer appears
- [ ] The poll cadence ("polls every …") remains visible in the header exactly once
- [ ] The retained indicator still distinguishes the not-seen and silent states (dot not green, status text says so) as before
- [ ] Every criterion above has exactly one test named after it

## Notes
The duplicate came from the supervisor details area added by
`0131-herd-dashboard-supervisor-status` landing alongside the pre-existing
dot indicator. The poll-cadence criterion preserves the one piece of
information only the removed block shows; strike it here if losing that info
is acceptable.
