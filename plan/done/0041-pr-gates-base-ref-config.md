---
title: Judge PRs against base-branch gate config, not their own edits
priority: medium
blocked_by: []
---

The `gates` and `size` jobs read GATES.md — commands, size thresholds, exclude
patterns — from the PR's own checkout. A PR can raise its own limits, add
exclusions covering its files, or blank the gate rows in the same diff, and
both checks go green. The reviewer can see the GATES.md diff, but checks sold
as "binding" currently bind only against an honest PR.

## Acceptance criteria
- [ ] The gates and size checks evaluate a PR using the GATES.md from the base branch, so editing GATES.md in the PR cannot change what that PR is judged by
- [ ] A PR that modifies GATES.md gets a visible notice in the check output, so legitimate config changes are flagged for the reviewer rather than silently deferred
- [ ] DOCS.md's trust-boundary material states how gate config changes are reviewed and when they take effect
