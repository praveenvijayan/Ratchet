---
title: Extract herd adapter helpers into a leaf module (cycle-break prep)
priority: high
labels: [scripts, herd]
blocked_by: []
---

Prep slice for 0164-herd-circular-import-deadlock, split because the atomic
cycle-break exceeds the PR file cap. `resolveAdapter`, `substitute`, and
`extractUsage` live in `herd.mjs` but are only consumed by the four profile
modules (`herd-dispatch`/`-monitor`/`-verify`/`-review`) — herd.mjs core never
calls them. Move them to a new leaf module so the profile modules gain an
import target outside the cycle. `herd.mjs` re-exports the three names, so
every existing importer (including `herd.test.mjs`) keeps working and no
consumer is repointed in this PR. Pure move; no behavior change. The deadlock
itself is NOT fixed by this issue — 0164 repoints the consumers.

## Acceptance criteria
- [ ] `resolveAdapter`, `substitute`, and `extractUsage` are exported from a new module that imports nothing from `herd.mjs`, directly or transitively
- [ ] `herd.mjs` still exports the same three names with identical behavior, and every pre-existing test passes unchanged
- [ ] Every criterion above has exactly one test named after it
