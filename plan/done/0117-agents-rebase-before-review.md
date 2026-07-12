---
title: AGENTS.md — require branch update onto main before requesting review; document the conflicted-PR CI gap
priority: medium
labels: []
blocked_by: []
---

A conflicted PR gets no event-driven CI at all: GitHub cannot build the merge
ref, so `pull_request` and `pull_request_review` workflows (`pr-gates`,
`review-verdict`) are silently skipped. Agents that move an issue to
`state:in-review` on a branch that has fallen behind `main` therefore present
un-gated, un-flippable work for review — exactly what happened in
digital-workforce when a version bump on `main` conflicted the open agent
branches minutes before review. AGENTS.md must make an up-to-date branch part
of the review-ready definition.

## Acceptance criteria
- [ ] AGENTS.md instructs agents to update their branch onto latest `main` (resolving conflicts) before moving the issue to `state:in-review`
- [ ] AGENTS.md documents that a PR with merge conflicts triggers no event-driven workflows — no gates, no review-verdict — and is therefore not reviewable until conflicts are resolved
