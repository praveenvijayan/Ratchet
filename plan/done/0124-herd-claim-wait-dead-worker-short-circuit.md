---
title: Short-circuit the claim wait when the spawned worker has already exited
priority: medium
labels: [herd, supervisor]
blocked_by: []
---

`waitForClaim` (`scripts/herd-dispatch.mjs`) polls only for the claim ref on
origin. When the spawned worker dies immediately (observed: worker exited 1s
after spawn, claim wait still burned the full 300s), the supervisor blocks a
poll slot for the whole `claimTimeoutSeconds` waiting on a process that can no
longer claim anything — and starves the heartbeat for that long too.

## Acceptance criteria
- [ ] When the spawned worker's process exits before creating its claim ref, the claim wait ends within one claim-poll interval of the exit instead of running to the full timeout
- [ ] The resulting escalation says the worker exited without claiming (with the exit observed), distinct from the existing "still running but never claimed within Ns" message
- [ ] A worker that creates its claim ref and then exits is still reported as claimed — an early exit after claiming never produces a dispatch-failed
- [ ] A worker that stays alive and claims late (within the timeout) still succeeds exactly as today

## Notes
The kill-after-timeout path already re-checks origin for a raced claim ref;
that behaviour must be preserved for the early-exit path too.
