---
title: Herd dashboard auto-picks a free port when the default is taken
priority: low
labels: [herd, dashboard]
blocked_by: []
---

Running herd in two repositories at once fails on the second dashboard: both
default to port 4780 and the second exits with "port already in use". When the
operator did not ask for a specific port, the dashboard should find a free one
itself instead of making the operator pick.

## Acceptance criteria
- [ ] With no `--port` flag and the default port free, the dashboard binds the default port as today
- [ ] With no `--port` flag and the default port busy, the dashboard binds the next free port and serves normally
- [ ] On startup the dashboard prints the URL with the actually bound port, so the operator always knows where it is
- [ ] With an explicit `--port` that is busy, the dashboard still exits non-zero with the existing "port N is already in use" message — never a silent fallback to a different port
- [ ] When no free port is found within the scan range, the dashboard exits non-zero with a message naming the range it tried
- [ ] Every criterion above has exactly one test named after it
