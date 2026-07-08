---
title: Enforce the agent PR size limit mechanically in CI
priority: low
blocked_by: [0007-ci-gates-on-agent-prs]
---

The ~400-changed-lines / ~6-files scope limit in AGENTS.md step 3 is
honor-system only. Oversized agent PRs are the biggest drain on review quality,
and review is the loop's bottleneck resource — the limit should be checked at
PR time.

## Acceptance criteria
- [ ] The gates workflow fails (or labels) an `agent/issue-*` PR exceeding the configured size limit
- [ ] The failure message quotes the PR's actual line/file counts, the limits, and the split-and-requeue protocol from AGENTS.md step 3
- [ ] The thresholds are configurable in `GATES.md`, defaulting to the manual's ~400 lines / ~6 files
