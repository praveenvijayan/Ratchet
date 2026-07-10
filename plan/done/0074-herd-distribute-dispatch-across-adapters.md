---
title: Distribute herd dispatch across available adapters instead of always the first
priority: medium
labels: [herd]
blocked_by: [0071-herd-adapter-fallback-routing]
---

A route with several adapters still always dispatches the first available one
(0071 is failover, not balancing), so a herd configured with claude, codex, and
several OpenRouter adapters funnels every worker to claude and the rest sit idle.
A route can opt into a round-robin policy so successive workers cycle across the
available adapters, spreading load — the deterministic form of the "shuffle
across agents" the operator wants.

## Acceptance criteria
- [ ] A route may declare its selection policy; the default policy stays `failover` (first available, unchanged from 0071) so existing configs behave identically
- [ ] Under a `round-robin` policy, successive dispatches to the same route cycle through the available adapters in order before any adapter repeats
- [ ] Round-robin skips adapters that are unavailable (per 0071's availability check) and never blocks on them
- [ ] When exactly one adapter in the route is available, every worker uses it with no error — rotation degrades gracefully
- [ ] An unknown policy value exits nonzero with a one-line error naming the route and the bad policy
- [ ] The framework purity test still passes — the selection policy names no specific CLI or model
- [ ] Every criterion above has exactly one test named after it

## Notes
Round-robin is deterministic (rotation state carried in the herd state file),
which keeps it testable offline and avoids `Math.random`. Combined with 0073
(per-adapter `model`), this is what lets the supervisor spread work across a set
of OpenRouter model-adapters instead of pinning one agent.
