---
title: Extract workflow logic into testable scripts with regression tests
priority: medium
blocked_by: [0002-fix-stale-sweep-fresh-claims, 0003-unblock-recheck-criteria, 0010-sweep-all-stalled-states]
---

Only the plan compiler has a test. The sweep and unblock workflows — where the
two worst known bugs live — are untested inline `github-script` blocks. The
automation that guards everyone else's quality has the least of its own.
Blocked on the behaviour fixes so the extraction refactors stable logic
instead of conflicting with them.

## Acceptance criteria
- [ ] `sweep-stale-claims` and `unblock-dependents` logic lives in `scripts/*.mjs` files invoked by thin workflow YAML
- [ ] Each extracted script has a zero-dependency regression test runnable with plain `node`, following the `plan-sync.test.mjs` pattern
- [ ] Workflow behaviour (triggers, permissions, outcomes) is unchanged after the extraction
