---
title: Lower the herd default poll interval and keep dashboard heartbeat liveness correct
priority: medium
labels: [scripts, herd]
blocked_by: [0174-herd-survey-conditional-requests]
---

With conditional requests making no-change ticks free, the default
`pollSeconds` (currently 60) can drop so GitHub-originated changes (new PRs,
review verdicts) are noticed within seconds. The dashboard derives supervisor
liveness from `pollSeconds × HEARTBEAT_SILENCE_FACTOR` (`herd-ui.mjs`), so the
new default must keep the "supervisor silent" banner accurate — neither
false-alarming nor going numb — at the default and at operator overrides.

## Acceptance criteria
- [ ] Default `pollSeconds` is 15; an operator-configured value still overrides it exactly as before
- [ ] Dashboard heartbeat threshold is derived from the configured `pollSeconds` at the new default: a healthy supervisor at default cadence never shows the "supervisor silent" banner
- [ ] Heartbeats stopping for longer than the derived threshold still raises the "supervisor silent" banner, at the default and at an operator-overridden `pollSeconds`
- [ ] Herd docs and config reference state the new default and why short ticks are affordable (conditional requests)
- [ ] Every criterion above has exactly one test named after it (the docs criterion maps to the existing docs-consistency check)

## Notes
Blocked on the conditional-request plan because a 15s tick without free 304s
would quadruple rate-limit spend. No change to `HEARTBEAT_SILENCE_FACTOR`
semantics — only the configured default moves.
