---
title: Detect herd worker claims by the branch ref, not the state:ready label
priority: high
labels: [herd]
blocked_by: []
---

`waitForClaim` polls for the `state:ready` label disappearing within a
hardcoded 60s, but AGENTS.md §2 defines the atomic claim as the server-side
branch ref `agent/issue-<N>` — labels only report, and the flip happens later
in the worker's run. A correctly-claiming worker therefore gets SIGTERM'd at
60s, marked `dispatch-failed`, and escalated; every poll then grabs the next
ready issue and kills it too, a runaway that burns worker runs and strands
orphan claim branches.

## Acceptance criteria
- [ ] `waitForClaim` reports claimed as soon as the server ref `agent/issue-<N>` exists, even while `state:ready` is still on the issue
- [ ] A worker that has not created the ref by the timeout is killed, marked `dispatch-failed`, and escalated with its log file named — same conclusion as today, on the correct signal
- [ ] A transient `gh` failure while polling counts as still waiting — never as a claim and never as a dispatch failure
- [ ] `claimTimeoutSeconds` is an optional `.ratchet/herd.json` knob with a default long enough for an agent CLI to start and reach the claim step (minutes, not 60s); a non-positive or non-integer value exits non-zero with a one-line error naming the file and field

## Notes
Observed dogfooding: five consecutive dispatches false-failed with SIGTERM
(exit 143) at the 60s wall while the claim branch (e.g. `agent/issue-166`)
already existed on origin. The label-based wait came from plan 0053's own
criterion ("waits until that issue leaves `state:ready`"), which contradicted
AGENTS.md ("the ref is the claim; labels never claim anything").
