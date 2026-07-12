---
title: Scheduled reconciliation sweep for missed Request Changes verdicts
priority: medium
labels: []
blocked_by: []
---

GitHub silently skips `pull_request_review` workflows on conflicted PRs
(`mergeable_state: dirty`): it cannot build `refs/pull/N/merge`, so no run is
created — no failure, nothing on the run page — while the review event still
appears in the events API. Observed in host `mahmya-digital/digital-workforce`:
two `CHANGES_REQUESTED` reviews (PRs #189/#184) never flipped their issues
because both PRs were conflicted at review time. The label state machine must
not depend on single webhook delivery: the event-driven `review-verdict`
workflow stays as the fast path, and a scheduled pass self-heals anything it
missed for any reason (merge conflicts, Actions outage, future unknown gaps) —
the same pattern `sweep-stale-claims` and `unblock-dependents` already use.

## Acceptance criteria
- [ ] An open PR whose latest review is `CHANGES_REQUESTED` and whose mapped issue still carries `state:in-review` gets flipped: `state:changes-requested` added, `state:in-review` removed
- [ ] An open PR whose latest review is `APPROVED` or `COMMENTED` causes no label change
- [ ] An open PR that maps to no plan issue is a logged no-op, not an error
- [ ] Re-running the sweep on an already-flipped issue changes nothing (idempotent)
- [ ] A GitHub API failure while processing one PR is logged and does not abort processing of the remaining PRs

## Notes
Root-cause analysis in digital-workforce: probe PR #191 proved the trigger
works within seconds on a mergeable PR — the misses were conflict-driven, not
delivery failures. Repo convention applies: decision logic in a
regression-tested script, workflow as trigger only.
