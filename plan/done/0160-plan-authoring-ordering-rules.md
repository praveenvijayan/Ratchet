---
title: Codify plan-authoring rules for ordering and repo-wide invariants
priority: medium
labels: [skills, docs]
blocked_by: []
---

Issue #346 shipped `state:ready` while actually blocked on three sibling
migrations: its plan file stated the ordering only in prose ("the last two…
completing the consolidation") and carried a batch-wide postcondition as a
plain criterion no single PR could satisfy. The state machine can only see
`blocked_by`. Codify two authoring rules where plans are written and reviewed
so the same mis-scope cannot recur.

## Acceptance criteria
- [ ] The `ratchet-plan` skill's plan-writing step instructs that any ordering or sequencing stated in a plan file's prose must also be encoded as `blocked_by` slugs, and that a criterion satisfiable only after other issues merge means the blocker list is incomplete
- [ ] The `ratchet-plan` skill's plan-writing step instructs that a repo-wide invariant is phrased as "add an automated check that enforces X", placed on a capstone issue blocked on every prerequisite, never as a bare assertion criterion on a member issue
- [ ] `plan/README.md`'s criteria guidance documents both rules with the #346 shape as the counter-example
- [ ] The `.claude/skills` and `plugin/skills` mirrors are identical to the canonical skill after `./setup.sh`, and `scripts/skill-parity.mjs` passes
- [ ] Every criterion above has exactly one test named after it
