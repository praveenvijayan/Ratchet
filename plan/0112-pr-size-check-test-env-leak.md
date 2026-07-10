---
title: pr-size-check.test.mjs leaks ambient CI env into its subprocess fixtures
priority: high
blocked_by: []
---

`scripts/pr-size-check.test.mjs` spawns `scripts/pr-size-check.mjs` with
`env: {...process.env, ...}` and then overrides `PR_ADDITIONS` /
`PR_DELETIONS` / `PR_CHANGED_FILES` / `PR_FILES_JSON` for each fixture
scenario. Locally (no `GITHUB_TOKEN`/`GITHUB_REPOSITORY`/`PR_NUMBER` in the
shell) this works, since `pr-size-check.mjs`'s `fetchPrFiles()` has nothing to
fall back to except the test's injected env vars.

Inside the real `pr-gates` CI job those three vars ARE already set in the job
environment (so the real `size` step can call the GitHub API for the actual
PR), and the test's `spawnSync` inherits them via the `...process.env`
spread. `fetchPrFiles()` checks `token && repo && prNumber` before ever
looking at the test's synthetic aggregates, so every fixture scenario
silently fetches the **real, currently-open PR's** file list from the GitHub
API instead of exercising the scenario the test constructed — the assertions
then compare expectations for a synthetic PR against the real PR's actual
size, and fail or pass by coincidence depending on what's actually open.

Confirmed: the `gates` check has failed in CI on every recent PR checked
(#245, #251, #252) at exactly this test, while `node scripts/run-gates.mjs`
passes cleanly on the same commits when run locally/in a clean shell. This is
a test-isolation bug in the gate itself, not a defect in the PRs it ran
against.

## Acceptance criteria
- [ ] `scripts/pr-size-check.test.mjs`'s subprocess env excludes `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, and `PR_NUMBER` regardless of what the parent process's environment holds, so `fetchPrFiles()` only ever sees the fixture's own `PR_FILES_JSON`/aggregate overrides
- [ ] `node scripts/pr-size-check.test.mjs` passes when run with `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, and `PR_NUMBER` set in the ambient shell environment, simulating the CI job context
- [ ] `node scripts/pr-size-check.test.mjs` still passes with none of those three set (the existing local-shell case), so nothing regresses
- [ ] Every criterion above has exactly one test named after it
