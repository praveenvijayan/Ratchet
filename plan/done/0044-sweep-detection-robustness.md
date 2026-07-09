---
title: Harden sweep PR-disposition detection and config parsing
priority: medium
blocked_by: []
---

Four detection gaps in the stale sweep. Feedback detection counts conversation
and inline comments only, so a Request-Changes review whose feedback lives in
the review *body* gets zero grace — an immediate requeue, exactly the race the
grace window prevents. A branch with an old merged PR and a newer abandoned one
is judged by the stale merged PR ("PR #old was merged") instead of the newest
disposition. PR lookup reads only the ten newest PRs with no pagination. And a
non-numeric `STALE_HOURS`/`REWORK_GRACE_HOURS` yields NaN, after which the
sweep silently never sweeps anything.

## Acceptance criteria
- [ ] A PR closed after a review whose only feedback is the review body receives the rework grace window before requeue
- [ ] When a claim branch has multiple PRs, the sweep acts on the newest PR's disposition and its comment names that PR
- [ ] An open PR is found regardless of how many other PRs the branch accumulated
- [ ] A non-numeric staleness/grace configuration fails the sweep run loudly instead of silently disabling sweeping
