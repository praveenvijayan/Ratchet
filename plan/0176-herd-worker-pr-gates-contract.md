---
title: Headless workers open PRs through ratchet-submit so verify's gates check passes
priority: high
labels: [herd, agents]
blocked_by: []
---

In a measured fleet run, every PR the workers produced hit `verify-escalated`
with "PR body is missing a gates section" — the happy path is structurally
unreachable headless. The framework ships `scripts/ratchet-submit.mjs`, which
formats a body that passes `herd-verify`'s deterministic text checks, but
nothing in the worker contract or the shipped `promptTemplate` routes workers
through it: they run raw `gh pr create` and dead-end. Workers finish code in
minutes; the pipeline then halts forever waiting for a human.

## Acceptance criteria
- [ ] The shipped default `promptTemplate` and the worker contract's submit step direct workers to open the PR via `node scripts/ratchet-submit.mjs`, never raw `gh pr create`
- [ ] Offline regression test: a PR body produced by `ratchet-submit` passes `herd-verify`'s gates-section and `Closes #<N>` text checks (this is the regression that shipped)
- [ ] Offline simulation with stub gh/spawn: a worker that succeeds and submits through the contract path takes its issue to `awaiting-review`, not `escalated`, with zero human intervention
- [ ] A PR that nonetheless lacks a gates section still verify-escalates exactly as today — verify is not weakened and the supervisor still never edits PR bodies
- [ ] `promptTemplate` examples in DOCS.md match the new default verbatim, with the existing note that operators of existing `.ratchet/herd.json` files must update by hand
- [ ] Every criterion above has exactly one test named after it
