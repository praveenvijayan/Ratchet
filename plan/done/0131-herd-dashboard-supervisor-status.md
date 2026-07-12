---
title: Surface supervisor status and details, live dot turns green when online
priority: medium
labels: [herd, dashboard]
blocked_by: []
---

The header only shows a small dot and a one-line liveness string, and the live
dot is lavender rather than green — there is no place that describes the
supervisor itself. Turn the live dot green when the supervisor is online, and
add a supervisor details area that reports its state, freshness, and poll
cadence so an operator can see the supervisor at a glance.

## Acceptance criteria
- [ ] When the last heartbeat is within the freshness threshold, the supervisor
      live dot is green
- [ ] When online, a supervisor details area shows the status ("live"/"online"),
      the age since the last heartbeat, and the poll interval
- [ ] When no heartbeat has ever been seen, the details show "not seen" and the
      dot is NOT green (no false-positive online state)
- [ ] When heartbeats have stopped (age exceeds the threshold), the details show
      "silent" with the time since the last heartbeat, and the dot is NOT green
- [ ] Every criterion above has exactly one test named after it
