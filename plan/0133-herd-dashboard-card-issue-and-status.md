---
title: Show the worked issue number and agent status on each active agent card
priority: medium
labels: [herd, dashboard]
blocked_by: []
---

An active agent card names the mascot and its dispatch counts but does not make
the issue it is working on or the agent's current status legible. Show both the
issue number and the live status on each active agent card.

## Acceptance criteria
- [ ] Each active agent card shows the issue number the agent is working on
      (e.g. "#123")
- [ ] Each active agent card shows the agent's current worker status (the same
      status the worker row reports)
- [ ] A card whose agent has no active issue shows an idle/standing-by state
      rather than a blank value or "#undefined"
- [ ] Every criterion above has exactly one test named after it
