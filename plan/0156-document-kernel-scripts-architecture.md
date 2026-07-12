---
title: Document the kernel, deterministic scripts, and shared client in DOCS.md and README.md
priority: medium
labels: [docs]
blocked_by: [0143-slim-agent-manual, 0149-protocol-coverage-gate, 0155-migrate-gh-api-metrics-scripts]
---

The manual-compression batch changes the operating architecture: `AGENTS.md`
becomes an always-loaded safety kernel routing to skills and references, the
fragile claim/requeue/heartbeat/handoff transitions become `ratchet-*.mjs`
scripts with exit-code contracts, a `ratchet-hotfix` skill carries the fast
lane, `scripts/gh-api.mjs` becomes the single GitHub API client, and a
protocol-coverage gate guards the routing. The human-facing documentation
still describes the old shape. Update it once the surface has stabilized —
blocked on the terminal issues of the batch so the docs describe shipped
reality, never intent.

## Acceptance criteria
- [ ] DOCS.md sections 2 (loop), 4 (repository layout), and 6 (workflows) describe the kernel-plus-routing manual architecture: what stays always-loaded, what defers to skills/references, and the invariant-marker scheme the protocol-coverage gate checks
- [ ] DOCS.md section 13 (command reference) lists `ratchet-start.mjs`, `ratchet-requeue.mjs`, `ratchet-heartbeat.mjs`, and `ratchet-submit.mjs` with their arguments and exit-code meanings
- [ ] DOCS.md section 5 (skills) includes `ratchet-hotfix` alongside the existing skills
- [ ] DOCS.md documents `scripts/gh-api.mjs` as the single GitHub API client for contributors, including the token resolution order and that no other script constructs its own client
- [ ] README.md's loop section shows the one-command script invocations where it currently shows or implies raw multi-step shell
- [ ] The docs-refresh gate passes against the updated documents
- [ ] Every criterion above has exactly one test named after it
