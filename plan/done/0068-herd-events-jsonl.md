---
title: Emit an adapter-agnostic herd event stream to .ratchet/events.jsonl
priority: medium
labels: [herd]
blocked_by: []
---

The supervisor knows every worker lifecycle transition (dispatch, claim, PR,
rework, escalation, exit) but records nothing machine-readable — only raw
adapter logs, whose format differs per CLI, and a human-oriented escalations
file. Any observability tooling built on log parsing breaks per adapter. An
append-only JSONL event stream written by the supervisor itself gives every
future consumer (dashboard, notifications, metrics) one stable, adapter-agnostic
source.

## Acceptance criteria
- [ ] Every dispatch, resume, claim detection, PR detection, worker exit, kill, and escalation appends one JSON line to `.ratchet/events.jsonl` with an ISO-8601 `ts`, an `event` type from a fixed documented set, and the issue number
- [ ] Worker-scoped events carry the adapter name, pid, log file path, and attempt count, so a reader can render fleet state without parsing any adapter log
- [ ] The file is append-only: a supervisor restart appends to an existing file, never truncates or rewrites prior lines
- [ ] A failed event write (unwritable directory, disk full) prints a one-line warning naming the file and the poll continues; the supervisor never crashes or stops dispatching because of event-log errors
- [ ] Every criterion above has exactly one test named after it

## Notes
Consumers tail this file; raw adapter logs stay the drill-down detail, never
the source of state. Retention can piggyback on the log-retention pass
(0067-herd-log-retention) later — out of scope here.
