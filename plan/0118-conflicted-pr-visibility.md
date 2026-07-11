---
title: Label conflicted open PRs so reviewers see unmergeable work before reviewing
priority: low
labels: []
blocked_by: []
---

Nothing surfaces a PR's merge-conflict state on the board, so humans spend
reviews on work whose verdict can never be delivered (see
0116-review-verdict-reconciliation-sweep: conflicted PRs get no event-driven
CI). A scheduled pass should mark conflicted open PRs with a visible label so
reviewers skip them until the agent rebases.

## Acceptance criteria
- [ ] An open PR with merge conflicts (`mergeable_state: dirty`) receives a conflict label
- [ ] The conflict label is removed once the PR becomes mergeable again
- [ ] A PR whose mergeability GitHub has not yet computed (`mergeable: null`) is skipped, not labeled
- [ ] Re-running the pass on an already-labeled conflicted PR changes nothing (idempotent)
