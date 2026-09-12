---
title: Framework work goes through plans too — no second lane for scripts and workflows
priority: medium
labels: [scripts, planning]
blocked_by: []
---

Ratchet/herd framework changes have bypassed planning entirely (#190 landed
+9,397 lines as a "version update"). Framework work gets the same plan files,
same criteria, same size budgets as product work: a PR touching `scripts/**`
or `.github/workflows/**` must trace back to a planned issue.

## Acceptance criteria
- [ ] A required check fails any PR touching `scripts/**` or `.github/workflows/**` that does not reference an issue carrying a `plan-id` marker, with a message naming the offending paths and pointing at the plan protocol
- [ ] PRs touching neither path are unaffected by the check (regression)
- [ ] An explicit override exists for emergencies (same pattern as the size-gate override), and using it leaves a visible audit trail on the PR
- [ ] AGENTS.md states that framework changes (`scripts/**`, workflows) follow the same plan protocol — no version-update lane

## Notes
The check must read its own configuration from the base branch (the
pr-size-check pattern) so a framework PR cannot exempt itself.
