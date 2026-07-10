---
title: Bound events.jsonl and herd-escalations.md growth with retention
priority: low
labels: [herd]
blocked_by: [0082-herd-escalation-resolution]
---

Worker logs already have a retention pass (`logRetentionDays`), but
`.ratchet/events.jsonl` and `.ratchet/herd-escalations.md` grow without bound
— every poll appends, nothing ever prunes. A long-running herd accumulates
megabytes the dashboard must re-parse on every request.

## Acceptance criteria
- [ ] Event lines older than the retention window are pruned during the poll, using the same retention knob semantics as worker logs (invalid values exit non-zero with a one-line error naming the file and field)
- [ ] Escalation blocks older than the window that are resolved (per the resolution model of 0082) are pruned; unresolved escalations are never pruned regardless of age
- [ ] Events referenced by a live worker's state entry survive pruning regardless of age
- [ ] The poll summary line reports how many event lines and escalation blocks were pruned this pass
- [ ] Every criterion above has exactly one test named after it
