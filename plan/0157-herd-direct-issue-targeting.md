---
title: Herd issue targeting core — parse --issues and filter dispatch
priority: medium
labels: [scripts, herd]
blocked_by: [0159-herd-single-supervisor-lock]
---

First slice of direct issue targeting (split from the original scope after an
over-scope stop on issue #350): parsing and dispatch filtering only. Targeting
is a selection filter, never a state bypass — the target set intersects the
`state:ready` survey, so an ineligible issue can never be dispatched even
before per-issue rejection reporting exists. Interim limitation, resolved by
0158-herd-targeting-eligibility-lifecycle: ineligible targets are silently
absent from dispatch and a scoped run does not yet exit on its own. Blocked on
the single-supervisor lock so the feature never ships without the collision
protection its use case demands.

## Acceptance criteria
- [ ] `run --issues 123,134,445` and the repeated form `run --issue 123 --issue 134` parse to the same deduplicated integer target set; a non-integer entry exits 2 with a usage message and spawns nothing
- [ ] With a target set, the supervisor dispatches only issues in the set — an eligible `state:ready` issue outside the set is never dispatched during a scoped run
- [ ] Within the set, dispatch order follows the existing `pickNext` ordering (priority, then oldest), one worker per poll pass, respecting `maxWorkers`
- [ ] `--dry-run` combined with `--issues` prints the per-issue plan and spawns nothing
- [ ] Every criterion above has exactly one test named after it

## Test notes
- duplicate issue numbers across both flag forms deduplicate to one worker
- `--issues` with `--max 5` runs up to five live workers; without `--max` the config `maxWorkers` cap holds

## Notes
Bracket syntax (`--issue=[123, 134]`) was considered and rejected: brackets
glob in zsh and force quoting. A future GitHub-label-based pin (`herd:pin`)
could retarget a running supervisor; out of scope.
