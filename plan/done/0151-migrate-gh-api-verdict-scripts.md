---
title: Migrate verdict and unblock scripts to the shared gh-api client
priority: medium
labels: [scripts, refactor]
blocked_by: [0150-gh-api-shared-client]
---

`unblock-dependents.mjs`, `review-verdict.mjs`, and `review-verdict-sweep.mjs`
each carry a byte-identical private `ghClient`, token/repo resolution, and
pagination loop. Replace all three copies with imports from
`scripts/gh-api.mjs`. Behavior-preserving refactor: the workflows these back
must not change observably.

## Acceptance criteria
- [ ] `unblock-dependents.mjs`, `review-verdict.mjs`, and `review-verdict-sweep.mjs` import `ghClient`/`paginate`/`resolveAuth` from `scripts/gh-api.mjs` and define no private fetch client, token resolution, or pagination loop
- [ ] Each script's existing test suite passes unchanged in what it asserts (test plumbing may adapt to the injectable client)
- [ ] A missing token or repository produces the shared client's single clear error message in all three scripts
- [ ] Every criterion above has exactly one test named after it
