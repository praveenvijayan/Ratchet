---
title: Standing red gates go green — SSE timing flake and gh-api-migration CI failure fixed
priority: high
labels: [scripts, gates]
blocked_by: []
---

The gate suite is red on a clean checkout of `main` for reasons unrelated to
any change under review: the herd-ui SSE test's 120ms timing assumption fails
locally (and cascades into docs-refresh and agents-kernel), and
gh-api-migration fails in CI. A standing red trains humans to merge past red,
which is how 25 red merges and the false-green era happened. Required checks
(0200) are only feasible once a clean tree is green everywhere — this is the
prerequisite.

## Acceptance criteria
- [ ] The full gate suite passes on a clean checkout of `main`, locally and in CI, with no test skipped or marked allowed-to-fail to get there
- [ ] The herd-ui SSE test passes deterministically — it no longer depends on a wall-clock timing window, and 20 consecutive local runs produce 20 passes
- [ ] The gh-api-migration gate passes in CI for the same tree that passes locally, or its failure output names the exact environmental difference when it cannot
- [ ] A genuinely broken gate still fails loudly — the fix removes the flake, not the signal (a deliberately injected failure in the SSE path is still caught)
