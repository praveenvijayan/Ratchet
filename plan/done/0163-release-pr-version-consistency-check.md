---
title: Run the version-consistency check on release PRs
priority: low
labels: [release, ci]
blocked_by: []
---

`pr-gates` skips any PR whose head is not `agent/issue-*` by design (it
backstops the agent's self-reported checklist), so the release version-bump PR
(head `release/vX.Y.Z`) merges with zero CI checks — a partial or malformed
bump would land unverified. Observed on PR #384 (v5.0.0): no checks ran.

## Acceptance criteria
- [ ] PRs from `release/*` branches run a CI check that executes the version-consistency check and fails on any drift among the known version locations
- [ ] When the check fails, the output names each disagreeing file and the version it carries next to the expected version
- [ ] PRs from `agent/issue-*` branches run exactly the gates they run today, unchanged
- [ ] Every criterion above has exactly one test named after it
