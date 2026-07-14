---
title: Routing skips an adapter after consecutive claim failures (circuit breaker)
priority: medium
labels: [herd]
blocked_by: []
---

A misconfigured adapter fails identically every time — in a measured run one
exited 0 without ever claiming, yet round-robin kept routing new dispatches to
it, burning a full claim-timeout each try. Static availability checks (0071)
catch a missing binary or env var but not an adapter that launches and then
fails at runtime. Track consecutive claim failures per adapter and stop
routing to a tripped adapter for the rest of the run.

## Acceptance criteria
- [ ] An adapter that accumulates `adapterFailureThreshold` (default 2) consecutive claim failures — exited without ever claiming, or died within the claim grace window after claiming — is skipped by routing for the remainder of the run
- [ ] A successful claim resets that adapter's consecutive-failure count
- [ ] A tripped adapter is surfaced once as degraded (escalation naming the adapter and its failure shapes), not re-reported every tick
- [ ] When every adapter in a route is tripped, dispatch for the affected issues stops with a single escalation listing each adapter and its failure count — the supervisor never spins retrying
- [ ] `adapterFailureThreshold` is validated config: a non-positive or non-numeric value exits nonzero naming the key
- [ ] The framework purity check still passes — the breaker logic references no specific CLI, model, or vendor name
- [ ] Every criterion above has exactly one test named after it
