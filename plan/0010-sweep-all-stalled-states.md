---
title: Extend the stale sweep to in-review and changes-requested states
priority: medium
blocked_by: [0002-fix-stale-sweep-fresh-claims]
---

Only `state:in-progress` is swept. An issue stuck in `state:in-review` whose PR
was closed or abandoned, or in `state:changes-requested` after its agent
vanished, stays there forever — the forward-only guarantee has holes in half
the state machine.

## Acceptance criteria
- [ ] A `state:in-review` issue with no open PR from its `agent/issue-<N>` branch returns to `state:ready` with a comment explaining why
- [ ] A `state:changes-requested` issue with no activity beyond a configurable window returns to `state:ready` with a comment
- [ ] An in-review issue with an open PR, and a changes-requested issue with recent activity, are never touched by the sweep
