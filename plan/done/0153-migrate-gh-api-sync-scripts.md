---
title: Migrate plan-sync, archive, and release scripts to the shared gh-api client
priority: medium
labels: [scripts, refactor]
blocked_by: [0150-gh-api-shared-client]
---

`plan-sync.mjs`, `archive-closed-plans.mjs`, and `release.mjs` carry
near-variant private clients (`release` adds `allow404`; the others omit
parameters) plus their own token/repo resolution and pagination. Migrate them
to `scripts/gh-api.mjs`, extending the shared client where a variant needs it
(for example an option to tolerate 404) rather than keeping a fork.
Behavior-preserving refactor.

## Acceptance criteria
- [ ] `plan-sync.mjs`, `archive-closed-plans.mjs`, and `release.mjs` import the client from `scripts/gh-api.mjs` and define no private fetch client, token resolution, or pagination loop
- [ ] The `allow404` behavior `release.mjs` relies on is provided by the shared client as an option and covered by a test in the shared module's suite
- [ ] Each script's existing test suite passes unchanged in what it asserts (test plumbing may adapt to the injectable client)
- [ ] Every criterion above has exactly one test named after it
