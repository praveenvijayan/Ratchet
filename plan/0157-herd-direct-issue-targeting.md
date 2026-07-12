---
title: Herd direct issue targeting via --issues
priority: medium
labels: [scripts, herd]
blocked_by: []
---

Let an operator point the herd supervisor at specific issues —
`node scripts/herd.mjs run --issues 123,134,445,567,545 --max 5` — instead of
the full ready queue. Targeting is a selection filter, never a state bypass:
every requested issue must still be open, `state:ready`, unblocked, and not
already owned by a live worker. The dispatch loop, one-worker-per-issue state
lock, claim-window serialization, and `maxWorkers` cap are unchanged.

## Acceptance criteria
- [ ] `run --issues 123,134,445` and the repeated form `run --issue 123 --issue 134` both parse to the same deduplicated target set; a non-integer entry exits 2 with a usage message and spawns nothing
- [ ] With a target set, the supervisor dispatches only issues in the set — an eligible `state:ready` issue outside the set is never dispatched during a scoped run
- [ ] Within the set, dispatch order follows the existing `pickNext` ordering (priority, then oldest), one worker per poll pass, respecting `maxWorkers`
- [ ] A requested issue that is closed, `state:blocked`, not `state:ready`, or already present in the state file is rejected with a per-issue reason on the report and an escalation entry, and is never spawned
- [ ] When every requested issue is invalid, the supervisor exits non-zero with the per-issue reasons and zero workers spawned
- [ ] A scoped run exits once every target issue has reached a terminal status in the state file, rather than polling forever
- [ ] `--dry-run` combined with `--issues` prints the per-issue plan (adapter or rejection reason) and spawns nothing
- [ ] Invoking a scoped run while a supervisor is already running is refused with a message naming the live supervisor's pid, leaving the running supervisor untouched
- [ ] Every criterion above has exactly one test named after it

## Test notes
- target issue closes mid-run: the scoped run treats it as terminal, reports it, and exits when the rest finish
- duplicate issue numbers in the flag are deduplicated to one worker
- `--issues` with `--max 5` runs up to five live workers; without `--max` the config `maxWorkers` cap holds

## Notes
Bracket syntax (`--issue=[123, 134]`) was considered and rejected: brackets
glob in zsh and force quoting. A future GitHub-label-based pin (`herd:pin`)
could retarget a running supervisor; out of scope here.
