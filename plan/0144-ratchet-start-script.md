---
title: Add deterministic claim script scripts/ratchet-start.mjs
priority: medium
labels: [scripts, agents]
blocked_by: []
---

The claim sequence (server-side ref CAS, worktree attach, owner marker, label
flip, self-assign) is the most fragile prose procedure in `AGENTS.md`: every
agent re-derives a multi-step shell recipe on every issue. Replace it with one
low-freedom script so the transition is deterministic and the manual can shrink
to a single command (see 0143-slim-agent-manual).

## Acceptance criteria
- [ ] `node scripts/ratchet-start.mjs --issue <N> --owner "<id>"` creates the `agent/issue-<N>` ref server-side from current `origin/main` before any local mutation, then adds the worktree at `../wt/issue-<N>`, writes `.ratchet-owner` with the owner id, and registers `.ratchet-owner` in the shared `info/exclude`
- [ ] A pre-existing claim ref (HTTP 422) exits with code 3 and a single-line JSON result identifying the claim as foreign, with no local or remote mutation performed
- [ ] After a successful claim the issue has `state:in-progress`, no longer has `state:ready`, and is assigned to the authenticated user
- [ ] Re-running for an issue whose worktree exists resumes when `.ratchet-owner` matches the given owner (exit 0, worktree reused, no duplicate) and exits 4 with no mutation when it does not match
- [ ] The shared clone's checked-out branch is never changed; all attachment happens via the worktree
- [ ] Missing or invalid arguments exit 2 with a usage message and no mutation
- [ ] Every outcome (success, foreign, unsafe, usage error, API failure) prints exactly one line of JSON to stdout with a stable `result` field and never a raw stack trace
- [ ] Every criterion above has exactly one test named after it

## Test notes
- exercise the 422 path and a mid-run API failure via an injected/stubbed command runner, asserting no partial state (no worktree without owner marker, no label flip without claim ref)
- property: running the script twice with identical arguments is equivalent to running it once

## Non-functional
- no interactive prompts; runnable unattended by CI and supervisors
- depends only on node and an authenticated `gh`
