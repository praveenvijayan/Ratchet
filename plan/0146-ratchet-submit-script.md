---
title: Add deterministic handoff script scripts/ratchet-submit.mjs
priority: medium
labels: [scripts, agents]
blocked_by: [0150-gh-api-shared-client]
---

PR handoff bundles the transitions most often fumbled from prose: verifying
current `main` is integrated, running gates fail-fast, refusing conflicted or
red work, pushing, keeping the single PR, and flipping labels. A conflicted or
red push wastes the human review bottleneck. One script enforces the whole
preflight; the PR summary itself stays model-authored via `--body-file` (see
0143-slim-agent-manual).

## Acceptance criteria
- [ ] `node scripts/ratchet-submit.mjs --issue <N> --body-file <path>` exits 4 without pushing when the branch does not contain current `origin/main` or the merge would conflict
- [ ] The script runs the `GATES.md` gates via `scripts/run-gates.mjs` fail-fast; any red gate exits 5 and nothing is pushed
- [ ] A body file whose first line is not exactly `Closes #<N>` exits 2 without pushing
- [ ] On success the script pushes the branch, creates the PR when none exists or updates the existing one (never opens a second), sets `state:in-review`, and removes `state:in-progress`
- [ ] Re-running after success is idempotent: exit 0, still exactly one PR for the branch
- [ ] Missing or invalid arguments exit 2 with a usage message; every outcome prints exactly one line of JSON to stdout with a stable `result` field
- [ ] GitHub access goes through `scripts/gh-api.mjs` (`resolveAuth`/`ghClient`); the script defines no private fetch client or token resolution
- [ ] Every criterion above has exactly one test named after it

## Test notes
- exercise the conflicted-with-main path and the red-gate path via a stubbed runner, asserting no push occurred in either
- exercise update-existing-PR versus create-new-PR against a stubbed `gh`

## Non-functional
- no interactive prompts; depends only on node, git, and an authenticated `gh`
