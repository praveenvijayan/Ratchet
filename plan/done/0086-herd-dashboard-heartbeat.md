---
title: Dashboard shows a supervisor heartbeat, not just UI-server liveness
priority: medium
labels: [herd]
blocked_by: []
---

The "live" indicator means the UI server process is up — it says nothing about
whether the supervisor is still polling. A dead supervisor leaves the dashboard
looking healthy with slowly rotting data. The supervisor should emit a
heartbeat each poll and the dashboard should alarm when it goes silent.

## Acceptance criteria
- [ ] The supervisor appends a heartbeat event to the event stream once per poll pass
- [ ] The dashboard shows the time since the last heartbeat, updating live without a page reload
- [ ] When the last heartbeat is older than a threshold derived from the poll interval, the dashboard shows a prominent "supervisor silent since Xm" banner
- [ ] With no heartbeat event in the stream at all, the dashboard says the supervisor has not been seen, never an unlabelled green "live" dot
- [ ] Every criterion above has exactly one test named after it
