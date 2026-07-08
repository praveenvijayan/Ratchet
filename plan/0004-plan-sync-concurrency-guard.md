---
title: Add a concurrency guard to the plan-sync workflow
priority: medium
blocked_by: []
---

`plan-sync.yml` has no `concurrency:` group. Two merges touching `plan/**` in
quick succession run two syncs in parallel; both list issues before either
creates, both see a slug as new, and both create it — duplicate issues with the
same `plan-id` marker, making blocker resolution ambiguous.

## Acceptance criteria
- [ ] `plan-sync.yml` declares a concurrency group so at most one sync runs at a time
- [ ] A sync triggered while another is running queues (`cancel-in-progress: false`) rather than being cancelled, so no batch is ever dropped
- [ ] Two rapid merges touching `plan/**` result in exactly one issue per new slug
