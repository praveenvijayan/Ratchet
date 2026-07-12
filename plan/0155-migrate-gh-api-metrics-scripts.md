---
title: Migrate ratchet-metrics and pr-size-check to the shared gh-api client
priority: medium
labels: [scripts, refactor]
blocked_by: [0150-gh-api-shared-client]
---

`ratchet-metrics.mjs` (its own `ghGet` with injected fetch) and
`pr-size-check.mjs` (its own client, token resolution, and pagination) are the
last two GitHub-API scripts off the shared client. Migrate both to
`scripts/gh-api.mjs`, completing the consolidation: after this issue exactly
one fetch-based GitHub client exists under `scripts/`. Behavior-preserving
refactor.

## Acceptance criteria
- [ ] `ratchet-metrics.mjs` and `pr-size-check.mjs` import the client from `scripts/gh-api.mjs` and define no private fetch client, token resolution, or pagination loop
- [ ] No file under `scripts/` other than `gh-api.mjs` constructs a `fetch` request to `api.github.com`
- [ ] Each script's existing test suite passes unchanged in what it asserts (test plumbing may adapt to the injectable client)
- [ ] Every criterion above has exactly one test named after it
