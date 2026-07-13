---
title: Herd reconcile adopts a finished worker's PR instead of pruning it
priority: high
labels: [scripts, herd]
blocked_by: []
---

If a worker opens its PR and exits while the supervisor is down, only the
monitor's exit handler would have recorded `entry.pr` — so on restart the
entry has a dead pid and `pr: null`. `reconcileState` flags it `dead` and
writes a misleading "re-queue the issue if its work is unfinished" escalation,
then `pollOnce`'s prune deletes the entry (`pr == null` counts as
"concluded"). The open PR is orphaned from herd tracking entirely, and the
operator is invited to re-queue work that is already finished.

## Acceptance criteria
- [ ] `reconcileState` with a dead pid, `entry.pr == null`, and an open PR whose head is the claim branch `agent/issue-<N>` adopts the entry: status becomes `awaiting-verification`, `pr` is set to that PR, and no `dead` change or escalation is produced for it
- [ ] An adopted entry survives both of `pollOnce`'s prune passes and is routed into the existing verify stage
- [ ] `pollOnce` logs exactly one `pr-detected` event per adoption and reports the adoption count in its result
- [ ] A dead pid with no open PR on its claim branch behaves exactly as before: flagged `dead`, escalated, pruned
- [ ] `reconcileState` called without the open-PR-by-head-branch input keeps its current behavior (legacy callers unaffected)
- [ ] Every criterion above has exactly one test named after it

## Notes
Root cause: only the monitor's exit handler maps the claim branch to a PR;
a supervisor-downtime window overlapping a worker exit means that mapping
never happens, and reconcile runs before the monitor can classify the dead
pid. The same claim-branch lookup the monitor's `classifyExit` performs
resolves the ambiguity at reconcile time. A fix of this shape was validated
end-to-end in the simpleRatchet demo repo (dead pid + open PR on
`agent/issue-1` adopted with no escalation; verify stage then processed it
normally).
