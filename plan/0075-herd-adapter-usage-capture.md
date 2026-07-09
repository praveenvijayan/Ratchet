---
title: Capture per-worker cost and token usage into the herd event stream
priority: medium
labels: [herd]
blocked_by: [0051-herd-config, 0068-herd-events-jsonl]
---

The dashboard can only show cost and token usage if the supervisor records it,
but that data lives in raw adapter logs whose format differs per CLI. To keep
`scripts/herd.mjs` pure, an adapter declares *how* to extract usage from its own
log (a config-driven `usage` mapping, in the same family as the `{model}`
placeholder in 0073), and the supervisor writes the extracted numbers onto the
worker-exit event so any consumer reads one adapter-agnostic source.

## Acceptance criteria
- [ ] An adapter may declare an optional `usage` mapping in `.ratchet/herd.json` naming how to read `costUsd`, `tokensIn`, and `tokensOut` from that adapter's log output
- [ ] When an adapter declares `usage`, the worker-exit event in `.ratchet/events.jsonl` carries the extracted `costUsd`, `tokensIn`, and `tokensOut` for that worker
- [ ] An adapter that declares no `usage` mapping dispatches and exits exactly as before, and its exit event omits the usage fields (back-compat)
- [ ] A `usage` mapping whose fields are missing or the wrong type exits nonzero at config-validation time with a one-line error naming the adapter and the field
- [ ] A log that lacks the declared usage values (adapter crashed, truncated output) records the usage fields as null and logs a one-line warning; the supervisor never crashes and the poll continues
- [ ] The framework purity test still passes — no adapter-specific log format or model name appears in `scripts/herd.mjs` logic; extraction is driven entirely by config
- [ ] Every criterion above has exactly one test named after it

## Notes
Extraction is config-driven so the core substitutes and reads values it was
handed without knowing any CLI's format — same purity bar as 0051/0073. The
dashboard render of these numbers is a separate issue
(0076-herd-dashboard-usage-metrics).
