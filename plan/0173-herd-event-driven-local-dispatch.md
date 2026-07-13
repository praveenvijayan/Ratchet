---
title: Herd supervisor reacts to local worker events instead of waiting for the tick
priority: medium
labels: [scripts, herd]
blocked_by: []
---

The supervisor is purely tick-driven: worker exits, claim confirmations, and
the next dispatch all wait for the next poll tick (`pollSeconds`, default 60s),
and `dispatchOne` launches at most one worker per tick — so a 3-issue scoped
run spends ~2 minutes just launching workers. The supervisor already owns every
worker pid and watches the claim ref itself; events that originate locally
should trigger the existing passes immediately, with the periodic tick kept as
the fallback/reconcile heartbeat. Event-driven reactions change *when* existing
passes run, never *what* they do.

## Acceptance criteria
- [ ] A worker exit immediately triggers the monitor/reconcile pass for that issue and, when capacity and eligible targets remain, the next dispatch — without waiting for the next tick (offline test with stub spawn/clock observes both from the exit event alone)
- [ ] With 3 scoped targets and `maxWorkers 3`, all three workers launch as each preceding claim is observed, not one per tick
- [ ] An event-driven dispatch attempt while at `maxWorkers`, or for an issue that already has a worker, launches nothing
- [ ] Claim-window serialization holds: an exit or claim event arriving while another dispatch's claim window is open never starts a second concurrent claim window
- [ ] The periodic tick still runs and heartbeats are still written at the configured `pollSeconds` cadence; event-driven passes neither add nor suppress heartbeats
- [ ] A scoped run (`--issues`) exits once every target reaches a terminal state, including when the final transition is observed via a local event rather than a tick
- [ ] An error thrown inside an event-triggered pass is logged as a herd event and does not crash the supervisor; the next periodic tick reconciles normally
- [ ] Every criterion above has exactly one test named after it

## Non-functional
- Zero npm dependencies; Node 20+. New event listeners stay injectable (spawn, clock, sleep) so all tests run offline with no network.
- Supervisor authority unchanged: it still never merges, approves, closes, labels, or touches worktrees/branches. Pidfile lock semantics unchanged.

## Notes
Non-goals: no GitHub webhooks/tunnels/Actions relays (local-only supervisor
stays local-only), no worker cold-start work, no change to worker prompts,
adapters, or the AGENTS.md contract. GitHub-originated events (new PRs, review
verdicts) are out of scope here — see the conditional-polling plan.
