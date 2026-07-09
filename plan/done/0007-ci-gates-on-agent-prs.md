---
title: Run the GATES.md gates in CI on every agent PR
priority: high
blocked_by: []
---

Gates run only on the agent's machine, and the PR carries a self-reported
checklist — the human reviewer's trust anchor is an agent assertion, not a
machine-verified check. For a system whose bottleneck is human review, this is
the single biggest gap: the gates must also run server-side on the PR itself.

## Acceptance criteria
- [ ] A `pr-gates` workflow runs on every PR from an `agent/issue-*` branch and executes the gates defined in `GATES.md` in order, fail-fast
- [ ] Gate commands are parsed from `GATES.md` itself (single source of truth — local and CI always run the same commands)
- [ ] A failing gate marks the PR check red with the gate's name visible in the check summary
- [ ] A `TODO:` gate row is skipped with a visible notice in the check output, never silently treated as passed
