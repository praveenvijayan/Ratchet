---
title: Restore the manifest-check gate — add missing scripts/*.test.mjs entries
priority: high
blocked_by: []
---

`ratchet-manifest.json` is missing an individual entry for at least
`scripts/bootstrap.test.mjs` (added by #238), so `node scripts/manifest-check.test.mjs`
fails on `main` right now — confirmed on the current `main` HEAD, and both PR #244
and PR #245 merged with a failing `gates` CI check as a result. Every agent PR's
`pr-gates` check is red until this is fixed, since `run-gates.mjs` runs the full
gate suite regardless of what the PR touches.

## Acceptance criteria
- [ ] `ratchet-manifest.json` lists every `scripts/*.test.mjs` file on disk as an individual `excluded` entry, with no gaps
- [ ] `node scripts/manifest-check.mjs` reports the manifest is consistent with the repo
- [ ] `node scripts/manifest-check.test.mjs` passes
- [ ] Every criterion above has exactly one test named after it
