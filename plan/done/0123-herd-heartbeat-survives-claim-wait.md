---
title: Herd heartbeat must not starve during the dispatch claim wait
priority: medium
labels: [herd, supervisor, dashboard]
blocked_by: []
---

The supervisor writes one heartbeat per poll pass, at pass start
(`herd-survey.mjs`), and the dashboard alarms after `pollSeconds × 2.5` of
silence (150s at the default 60s poll). But a single pass can block up to
`claimTimeoutSeconds` (default 300s) inside the dispatch claim wait, so every
stuck dispatch guarantees a false "Supervisor silent" banner while the
supervisor is alive and busy-waiting. Observed live: heartbeat 13:52:18,
dispatch 13:52:24, next event 13:57:25 — zero heartbeats across the full 300s
claim wait.

## Acceptance criteria
- [ ] A poll pass that blocks in the claim wait for the full `claimTimeoutSeconds` never lets the dashboard's heartbeat age exceed its silence threshold while the supervisor process is alive
- [ ] When the supervisor actually stops, the dashboard reports it silent within one silence threshold of the last heartbeat, same as today
- [ ] A heartbeat write failure during the claim wait is swallowed without aborting the wait or the pass, matching the existing heartbeat error policy

## Notes
Cause chain confirmed at `scripts/herd-survey.mjs` (heartbeat once at pass
start), `scripts/herd-ui.mjs` (`HEARTBEAT_SILENCE_FACTOR = 2.5`), and
`scripts/herd-dispatch.mjs` (`waitForClaim` blocking up to `claimTimeoutMs`
inside the pass). Any approach satisfying the criteria is fine — heartbeat on
an independent timer, heartbeats inside the claim-wait loop, or a threshold
that accounts for `claimTimeoutSeconds` — as long as real supervisor death is
still detected promptly.
