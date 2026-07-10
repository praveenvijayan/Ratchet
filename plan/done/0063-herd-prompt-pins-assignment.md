---
title: Pin the herd worker prompt to its dispatched issue — no pick, no fall-through
priority: medium
labels: [herd]
blocked_by: []
---

The default `promptTemplate` ("Pick up issue {issue} and take it to a PR,
following AGENTS.md.") leaves AGENTS.md's pick and fall-through rules live
inside a dispatched worker. `dispatchOne` waits for the claim ref
`agent/issue-<N>` of *the issue it dispatched*; a worker that follows
AGENTS.md's "foreign claim → fall through to the next `state:ready` issue"
starts working a different issue, never creates the expected ref, and gets
SIGTERM'd at `claimTimeoutSeconds` mid-work — an orphan claim branch on the
wrong issue and a wasted worker run. The prompt must make the dispatched issue
the worker's entire assignment.

## Acceptance criteria
- [ ] The default `promptTemplate` written by `herd init` tells the worker that issue {issue} is its entire assignment: skip AGENTS.md's pick step and never claim, work on, or fall through to any other issue
- [ ] The template treats an existing `agent/issue-{issue}` branch as belonging to this same supervisor assignment — resume it per AGENTS.md's resume rules — never as a foreign claim that triggers exit or fall-through (the monitor re-dispatches with the same template in a fresh session, so a resumed worker must not abandon its own claim)
- [ ] A worker whose issue already has a PR opened by someone else is told to exit without touching any branch, worktree, or other issue
- [ ] The `promptTemplate` examples in DOCS.md match the new default verbatim
- [ ] Every criterion above has exactly one test named after it

## Notes
Diagnosed while dogfooding the herd dispatcher (same investigation as
0061-herd-claim-signal-is-branch-ref). The template is data in
`.ratchet/herd.json`; changing `defaultConfig()` only affects future
`herd init` runs, so DOCS.md is the only in-repo surface operators copy from —
existing herd.json files must be updated by their operators (worth one line in
the docs near the template).
