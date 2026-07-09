---
title: Verify herd-opened PRs deterministically and route conflict rework
priority: medium
labels: [herd]
blocked_by: [0054-herd-monitor-resume]
---

Deterministic PR checks only — conflicts, `Closes #N`, gates section. Scope and
quality judgment stays with the human; the supervisor's last act on a clean PR
is telling the human it is ready for review.

## Acceptance criteria
- [ ] `gh pr view --json mergeable,mergeStateStatus` reporting conflicts triggers exactly one rework dispatch with the rework prompt (merge origin/main in the worktree, resolve, re-run GATES.md gates, push), counted toward `reworkCap`
- [ ] A PR still conflicting after the rework dispatch, or one already at `reworkCap`, is escalated instead of re-dispatched
- [ ] A PR body missing `Closes #<N>` or the gates section is escalated (text checks only, no content judgment)
- [ ] A PR passing all deterministic checks produces an escalation entry telling the human "PR #X ready for review"
- [ ] The supervisor never merges, approves, closes, or labels a PR in any verify path

## Notes
Conflicting-PR and clean-PR paths are tested against mocked `gh` JSON so tests
run offline. A `judge` adapter for scope review is explicitly out of scope for
v1 — the escalation file covers it.
