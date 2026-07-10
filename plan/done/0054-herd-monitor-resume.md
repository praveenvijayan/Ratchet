---
title: Monitor herd workers, resume crashes, escalate blocked exits
priority: medium
labels: [herd]
blocked_by: [0053-herd-dispatch]
---

The monitor: a worker is done when its process exits, and the exit shape
decides what happens next — hand off to PR verification, resume a drop, or
escalate with evidence.

## Acceptance criteria
- [ ] Exit 0 with an open PR whose head is `agent/issue-<N>` marks the worker for PR verification
- [ ] Exit 0 with no PR escalates with the log tail quoted, so the agent's own report (drained queue, blocked on question) reaches the human
- [ ] Nonzero exit or crash increments `attempts` and relaunches via the adapter's `resume` command (or `launch` when no `resume` is configured)
- [ ] Once `attempts` reaches `reworkCap`, the issue is escalated and never retried again
- [ ] Every worker state change prints one compact status line to the supervisor's stdout

## Notes
Resume via fresh `launch` is safe because ratchet-next's ownership/handoff
rules make a re-dispatch idempotent. Operators get visibility by tailing the
log files and the supervisor's stdout — zero multiplexer integration.
