---
title: Add herd state file, survey/reconcile loop, and escalation writer
priority: medium
labels: [herd]
blocked_by: [0051-herd-config]
---

The supervisor's spine: a poll loop that surveys reality via `gh`, a state file
(`.ratchet/herd-state.json`, `issue → {adapter, pid, logFile, attempts, status,
pr}`) that is rebuilt from `gh` plus liveness checks on startup rather than
trusted blindly, and the escalation channel every later stage appends to. No
dispatching yet — this issue makes the loop observe and reconcile correctly.

## Acceptance criteria
- [ ] Each poll surveys `gh` for `state:ready` issues, `state:in-progress` issues, and open PRs
- [ ] On startup, state-file entries with dead pids or merged PRs are reconciled against reality instead of trusted
- [ ] A missing or corrupt state file is rebuilt from `gh` and liveness checks, never a crash
- [ ] A failed `gh` call logs one clear line and retries on the next poll instead of crashing the supervisor
- [ ] Escalations append human-readable entries to `.ratchet/herd-escalations.md` with timestamp, issue, what happened, log file path, and suggested action
- [ ] `--once` performs a single pass and exits; default keeps polling every `pollSeconds`
- [ ] With no ready issues and no live workers, the supervisor prints a `/ratchet-status`-style diagnosis pointer, then exits under `--once` or keeps polling otherwise

## Notes
Invariant to restate in code comments: the supervisor never merges, approves,
closes, or labels PRs/issues; escalation over improvisation.
