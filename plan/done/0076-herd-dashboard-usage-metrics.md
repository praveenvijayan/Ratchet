---
title: Show per-worker cost and token usage in the herd dashboard
priority: medium
labels: [herd]
blocked_by: [0069-herd-web-dashboard, 0075-herd-adapter-usage-capture]
---

The dashboard lists issue, status, adapter, attempts, claim age, and PR, but not
the cost or token spend of each worker — the operator can't see which issues are
expensive or which adapter burns the most budget. Surface the usage figures the
supervisor now records (0075) alongside each worker, plus a fleet total.

## Acceptance criteria
- [ ] Each worker row shows its `costUsd`, `tokensIn`, and `tokensOut` from the latest usage-bearing event for that issue
- [ ] A header line shows the fleet totals: summed cost and summed tokens across all workers with usage data
- [ ] A worker whose events carry no usage (adapter without a `usage` mapping, or usage not yet emitted) renders a `—` placeholder in each usage cell, never a blank, `NaN`, or `undefined`
- [ ] Usage figures update live from new events without a manual page reload, consistent with the rest of the dashboard
- [ ] Every criterion above has exactly one test named after it

## Notes
Read-only consumer of `.ratchet/events.jsonl`; the dashboard never parses raw
adapter logs for usage — it renders the numbers 0075 already extracted.
