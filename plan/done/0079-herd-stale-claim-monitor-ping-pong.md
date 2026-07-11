---
title: Stop the survey/monitor ping-pong that re-escalates stale claims every poll
priority: high
labels: [herd]
blocked_by: []
---

The survey writes a `stale-claim` sentinel entry (`pid: null`, `adapter: null`)
into the state file. The monitor does not treat `stale-claim` as terminal, so it
classifies the sentinel as a dead worker, fails to build a resume command
(adapter is null), escalates, and flips the status to `escalated`. On the next
poll the survey's already-escalated check (which only matches status
`stale-claim`) no longer fires, so it re-escalates and rewrites the sentinel.
The loop produces a duplicate escalation pair every poll — the wall of
identical `stale claim ref agent/issue-175` blocks in `herd-escalations.md`.

## Acceptance criteria
- [ ] A state entry with status `stale-claim` is never classified by the monitor as a dead or failed worker and never produces a monitor escalation
- [ ] A stale claim ref produces exactly one escalation across any number of subsequent polls while the ref, the sentinel, and the herd state are otherwise unchanged
- [ ] When the stale ref disappears from origin, the sentinel entry is removed from the state file on the next poll
- [ ] A supervisor restart mid-loop does not re-escalate a stale ref whose sentinel entry already exists in the state file
- [ ] Every criterion above has exactly one test named after it

## Notes
Root cause is the interaction, not either script alone: the monitor's
non-terminal classification of `stale-claim` and the survey's status-equality
check defeat each other. Fix must hold from both directions.
