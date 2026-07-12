---
title: Migrate ratchet-metrics and pr-size-check to the shared gh-api client
priority: medium
labels: [scripts, refactor]
blocked_by: [0150-gh-api-shared-client, 0151-migrate-gh-api-verdict-scripts, 0152-migrate-gh-api-sweep-scripts, 0153-migrate-gh-api-sync-scripts]
---

`ratchet-metrics.mjs` (its own `ghGet` with injected fetch) and
`pr-size-check.mjs` (its own client, token resolution, and pagination) are the
last two GitHub-API scripts off the shared client. This is the capstone of the
gh-api consolidation: it runs after every sibling migration (hence the full
blocker list) and turns the batch's postcondition — exactly one fetch-based
GitHub client under `scripts/` — into a permanent automated check rather than
a one-time assertion. Re-planned from issue #346, which was mis-labelled
`state:ready` because the original file under-declared its sibling blockers
and stated the ordering only in prose.

## Acceptance criteria
- [ ] `ratchet-metrics.mjs` and `pr-size-check.mjs` import the client from `scripts/gh-api.mjs` and define no private fetch client, token resolution, or pagination loop
- [ ] An automated check fails whenever any file under `scripts/` other than `gh-api.mjs` constructs a `fetch` request to `api.github.com`, and passes on the repository as left by this PR
- [ ] Each script's existing test suite passes unchanged in what it asserts (test plumbing may adapt to the injectable client)
- [ ] Every criterion above has exactly one test named after it
