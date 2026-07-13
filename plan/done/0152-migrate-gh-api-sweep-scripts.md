---
title: Migrate sweep and label-exclusivity scripts to the shared gh-api client
priority: medium
labels: [scripts, refactor]
blocked_by: [0150-gh-api-shared-client]
---

`sweep-stale-claims.mjs`, `state-label-exclusivity.mjs`, and
`conflicted-prs.mjs` each carry the same byte-identical private `ghClient`,
token/repo resolution, and pagination loop. Replace all three copies with
imports from `scripts/gh-api.mjs`. Behavior-preserving refactor.

## Acceptance criteria
- [ ] `sweep-stale-claims.mjs`, `state-label-exclusivity.mjs`, and `conflicted-prs.mjs` import `ghClient`/`paginate`/`resolveAuth` from `scripts/gh-api.mjs` and define no private fetch client, token resolution, or pagination loop
- [ ] Each script's existing test suite passes unchanged in what it asserts (test plumbing may adapt to the injectable client)
- [ ] A missing token or repository produces the shared client's single clear error message in all three scripts
- [ ] Every criterion above has exactly one test named after it
