---
title: Dispatch herd workers with claim-window serialization
priority: medium
labels: [herd]
blocked_by: [0052-herd-state-survey]
---

The dispatcher: pick ready issues in queue order, choose the adapter via
routing, spawn detached workers with logs on disk, and serialize the claim
window so two workers never race claims in the shared clone.

## Acceptance criteria
- [ ] Dispatch picks the top ready issue by priority then age (the same ordering AGENTS.md prescribes) and the adapter via config routing
- [ ] Workers spawn detached with stdout+stderr redirected to `logDir/issue-<N>.log`, creating `logDir` if absent, with the adapter's `env` merged into the worker environment
- [ ] Live worker count never exceeds `maxWorkers`; `--max <n>` overrides it
- [ ] After spawning a worker, the next dispatch waits until that issue leaves `state:ready` (polling `gh` with a bounded timeout)
- [ ] Claim-window timeout kills the worker, marks it `dispatch-failed` in the state file, and appends an escalation
- [ ] An issue already present in the state file is never dispatched a second worker
- [ ] `--dry-run` on a repo with ready issues prints the dispatch plan (issue, adapter, command) without spawning anything

## Notes
One issue → one worker, ever: the state file is the lock, claim-window
serialization is the backstop. The supervisor never touches worktrees or
branches — ratchet-next handles worktree attach and `.ratchet-owner`.
Tests drive stub adapter CLIs (fake scripts that claim the label) so they run
offline.
