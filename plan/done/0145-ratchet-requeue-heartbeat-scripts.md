---
title: Add deterministic requeue and heartbeat scripts
priority: medium
labels: [scripts, agents]
blocked_by: [0150-gh-api-shared-client]
---

Two label/comment transitions agents currently perform by hand from prose:
returning an issue to the queue on failure or over-scope, and posting the
stale-claim lease heartbeat. Both are mechanical and both corrupt the state
machine when half-done. Make them one-command scripts (see
0143-slim-agent-manual for the manual shrink that depends on them).

## Acceptance criteria
- [ ] `node scripts/ratchet-requeue.mjs --issue <N> --reason "<text>"` posts an issue comment containing the reason, adds `state:ready`, and removes whichever of `state:in-progress`, `state:in-review`, or `state:changes-requested` was present
- [ ] Requeue is idempotent: re-running leaves the issue with exactly one state label (`state:ready`) and does not duplicate the reason comment
- [ ] The comment is posted before the label flip, so an interrupted run never leaves an unexplained state change
- [ ] `node scripts/ratchet-heartbeat.mjs --issue <N>` posts an issue comment containing the `<!-- ratchet-heartbeat -->` marker that `sweep-stale-claims` recognises as lease activity
- [ ] Missing or invalid arguments exit 2 with a usage message; an API failure exits non-zero with a single-line JSON error and no partial label state
- [ ] Every outcome prints exactly one line of JSON to stdout with a stable `result` field
- [ ] GitHub access goes through `scripts/gh-api.mjs` (`resolveAuth`/`ghClient`); the script defines no private fetch client or token resolution
- [ ] Every criterion above has exactly one test named after it

## Non-functional
- no interactive prompts; depends only on node and an authenticated `gh`
