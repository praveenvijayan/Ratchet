---
title: Refresh DOCS, README, AGENTS and plan/README for the shipped mechanisms
priority: medium
blocked_by: []
---

The gap-fix wave updated AGENTS.md but left the other docs describing the old
system. DOCS.md still says the sweep "returns state:in-progress issues with no
branch commits for >2h" (no heartbeat, no renewable lease, no extended states),
lists 4–5 of the 6 workflows (pr-gates and release missing), and lists 5 of the
15 scripts; its plan-format section omits the optional sections. README's
skills list omits `/ratchet-next` and `/ratchet-metrics`. plan/README.md omits
the invalid-priority skip, unknown-key warning, and cycle gate. AGENTS.md never
mentions the pr-gates CI check or the extended sweep states.

## Acceptance criteria
- [ ] DOCS.md's sweep section describes the renewable lease, the heartbeat marker, and all three swept states, matching the code
- [ ] DOCS.md's workflow inventory and layout list all six workflows; its scripts listing names every shipped script
- [ ] DOCS.md's plan-format section shows the optional `## Non-functional` and `## Test notes` sections
- [ ] README's skills list includes `/ratchet-next` and `/ratchet-metrics`
- [ ] plan/README.md documents the invalid-priority hard-skip, the unknown-key warning, and the cycle gate
- [ ] AGENTS.md names the pr-gates CI check and the extended sweep states where it describes the loop
