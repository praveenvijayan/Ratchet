---
title: Add protocol-coverage gate verifying kernel routes and invariants
priority: medium
labels: [scripts, gates]
blocked_by: [0143-slim-agent-manual]
---

Compressing the manual creates drift risk: a route can point at a deleted
skill, an invariant can vanish in a later edit, a referenced script can be
renamed. Add a structural gate that fails the build when the kernel and its
deferred artifacts disagree. It asserts machine-readable markers, never loose
English phrases. Mirror parity stays owned by `scripts/skill-parity.mjs`; this
gate does not duplicate it.

## Acceptance criteria
- [ ] `node scripts/protocol-coverage.mjs` exits non-zero, naming the offender, when a file path routed from the `AGENTS.md` routing table does not exist
- [ ] It exits non-zero when any required `<!-- ratchet:invariant:<id> -->` marker is missing from `AGENTS.md`, against a checked-in list of required invariant ids
- [ ] It exits non-zero when a `scripts/ratchet-*.mjs` command named in `AGENTS.md` has no corresponding script file
- [ ] It exits zero on the current repository state
- [ ] The gate is registered in `GATES.md` and the gates-coverage check passes
- [ ] Every criterion above has exactly one test named after it
