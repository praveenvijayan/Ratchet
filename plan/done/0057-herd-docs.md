---
title: Document herd config schema, adapter contract, and invariants
priority: medium
labels: [herd, docs]
blocked_by: [0055-herd-verify-pr]
---

Docs for the shipped supervisor across DOCS.md, AGENTS.md, README, and the
gitignore guidance, written once the behavior is final.

## Acceptance criteria
- [ ] DOCS.md documents the `.ratchet/herd.json` schema, the adapter contract (`launch`/`resume`/`promptTemplate`, `{prompt}`/`{issue}` substitutions), and the env passthrough with a generic "route workers through a local proxy" example naming no specific tool
- [ ] DOCS.md documents the escalation file format and the supervisor invariants (never merges/approves/closes/labels; one issue one worker; escalation over improvisation)
- [ ] AGENTS.md gains a paragraph with a pointer: a supervisor dispatch counts as an explicit human handoff for the ownership rule ("if a supervisor dispatched you, the prompt you received is your human handoff")
- [ ] README mentions ratchet-herd alongside the other entry points
- [ ] Gitignore guidance covers `.ratchet/logs/` and `.ratchet/herd-state.json`
