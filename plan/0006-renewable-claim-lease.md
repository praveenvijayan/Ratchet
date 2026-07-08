---
title: Make the claim lease renewable for legitimately long-running work
priority: medium
blocked_by: [0002-fix-stale-sweep-fresh-claims]
---

The protocol mandates "only push after gates pass", so an agent legitimately
working longer than `STALE_HOURS` with nothing pushed is indistinguishable from
a crashed one — the sweep reclaims its issue mid-flight. The lease needs a
renewal mechanism that doesn't require pushing red work.

## Acceptance criteria
- [ ] AGENTS.md documents a heartbeat an agent performs during long builds (e.g. an issue comment or claim-ref touch) that renews its lease without pushing code
- [ ] The sweep treats a claim with a fresh heartbeat as active and never sweeps it, even past `STALE_HOURS` since the original claim
- [ ] A claim whose heartbeat has stopped for more than `STALE_HOURS` is still swept (the crash-recovery path is preserved)
