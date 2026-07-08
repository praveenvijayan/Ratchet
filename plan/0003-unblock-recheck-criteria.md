---
title: Make unblock-dependents re-check acceptance criteria before promoting to ready
priority: high
blocked_by: []
---

`plan-sync` collapses issue state to a single label, so "blocked AND missing
acceptance criteria" is stored as just `state:blocked`. When the last blocker
closes, `unblock-dependents` blindly promotes to `state:ready` — and an agent
then picks an issue with no acceptance criteria, violating the "criteria are
the test plan" invariant.

## Acceptance criteria
- [ ] When all blockers close, an issue whose body contains at least one `- [ ]` item under `## Acceptance criteria` is promoted to `state:ready`
- [ ] When all blockers close, an issue without such a criteria block is set to `state:draft`, never `state:ready`
- [ ] The comment posted on a draft demotion states that acceptance criteria are missing and names the plan file (slug from the `plan-id` marker) to fix
