---
title: Detect blocked_by cycles in plan-sync and report them in ratchet-status
priority: medium
blocked_by: []
---

Two plan files blocking each other are both labeled `state:blocked` forever:
`unblock-dependents` never fires for either, and nothing warns. That is a
silent deadlock — the exact failure mode the forward-only philosophy promises
cannot happen.

## Acceptance criteria
- [ ] `plan-sync` detects any `blocked_by` cycle among plan files and fails loudly, naming every slug in the cycle
- [ ] A cycle-free plan set syncs exactly as before (covered by the compiler regression test)
- [ ] `/ratchet-status` reports cycles among open `state:blocked` issues and names the members of each cycle
