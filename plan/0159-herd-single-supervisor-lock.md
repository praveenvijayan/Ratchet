---
title: Herd single-supervisor pidfile lock
priority: medium
labels: [scripts, herd]
blocked_by: []
---

No script-level lock prevents two herd supervisors from running against the
same state file today; direct issue targeting (0157-herd-direct-issue-targeting)
makes collision likely — an ad-hoc scoped run started while a long-lived queue
supervisor is up. Add a pidfile lock under `.ratchet/` guarding every `run`
mode. Split from issue #350; reusable beyond targeting, so it lands first.

## Acceptance criteria
- [ ] Invoking `run` while a supervisor is already running is refused with a message naming the live supervisor's pid, leaving the running supervisor and its state file untouched
- [ ] A stale pidfile whose pid is no longer alive does not block: the new run replaces the lock and its report states a stale lock from the dead pid was replaced
- [ ] The lock is released on clean supervisor exit, so an immediate subsequent `run` starts without any stale-lock notice
- [ ] `--dry-run` neither takes the lock nor is refused by an existing one
- [ ] Every criterion above has exactly one test named after it

## Test notes
- two near-simultaneous starts: exactly one acquires the lock; the loser's refusal names the winner's pid
