---
title: Weekly failure-pattern review is scheduled, not ad hoc
priority: medium
labels: [scripts, planning]
blocked_by: []
---

Scanning a week's fix-PRs for repeat failure classes is the project's best
improvement mechanism — it produced the identity and config gates — but it is
currently ad hoc and skippable. Make it a scheduled job: once a week, collect
the week's merged fix/rework PRs, group them by failure class, and publish a
report a human reviews in ~30 minutes, with each repeat class ending as a gate
or plan rule via the normal planning protocol.

## Acceptance criteria
- [ ] A scheduled weekly job collects the week's merged fix/rework PRs (identified by the existing labels/conventions, host-configurable) and publishes a report grouping them by failure class with links to the member PRs
- [ ] The report lands somewhere durable and reviewable (a recurring issue or a checked-in report file), one per week, findable from the previous week's
- [ ] A week with zero fix-PRs still publishes a report saying so — silence is never ambiguous between "nothing failed" and "the job broke"
- [ ] The report's failure output (API errors, missing config) is published in the same channel, never a silently skipped week
- [ ] Docs state the human's 30-minute contract: review the report, and file a plan file per repeat class worth a rule — the job surfaces patterns, the planning protocol consumes them
