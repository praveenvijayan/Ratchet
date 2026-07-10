---
title: Every state-setting instruction removes the previous state label in the same step
priority: medium
labels: []
blocked_by: [0100-size-gate-excludes-skill-mirrors]
---

The claim instructions (AGENTS.md step 2, the ratchet-run prompt, the
ratchet-next skill) say to *add* `state:in-progress` but never to *remove*
`state:ready` — unlike AGENTS.md's exit paths, which do say "remove
state:in-progress". A worker following the wording exactly produced the #181
dual state. Make every state-setting instruction symmetric: add the new label,
remove the old one, in the same step.

## Acceptance criteria
- [ ] Every instruction that sets a `state:*` label (AGENTS.md, workflow prompts, skills) states the removal of the previous state label in the same step, symmetric with the existing exit-path wording
- [ ] Every criterion above has exactly one test named after it

## Notes
Split C of the original issue-#207 scope (see its scope-split comment); the
enforcement half is 0099-state-label-exclusivity. Blocked on 0100 because this
change touches a skill, whose generated mirrors currently overflow the size
gate. A built implementation exists in `issue-207-built.patch` per the comment
— reuse, don't rebuild.
