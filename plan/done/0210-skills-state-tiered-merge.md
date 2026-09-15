---
title: The skills stop claiming human review is the only merge gate
priority: high
labels: [docs]
blocked_by: [0209-kernel-states-tiered-merge]
estimated_lines: 120
risk: normal
---

Four skills still carry the pre-0201 rule as a flat statement of fact:
`ratchet-next` ends "the human's merge/review is the only gate", `ratchet-herd`
repeats "human review is the only gate", `ratchet-status` diagnoses every
`state:in-review` issue as waiting on a human, and `ratchet-init` justifies
branch protection as making "the human's merge the only way onto `main`". Each
sentence is now false about the system while remaining true about the agent, and
the conflation is the bug: an agent reading them will wait on a human that the
`auto-merge` workflow has already replaced, and `ratchet-status` will report a
queue as human-blocked when it is flowing.

This lands after 0209 so the skills echo the kernel's wording rather than
inventing a second phrasing of the same rule — the skills defer to the kernel,
they do not restate it differently.

## Acceptance criteria
- [ ] `ratchet-next` states that the agent never merges *and* that a normal-risk PR can advance without a human merge, so its advance path triggers on the merge event rather than on a human acting (test: "ratchet-next separates the agent ban from the merge gate", in `scripts/skill-detail.test.mjs`)
- [ ] `ratchet-herd`'s supervisor rules still forbid the supervisor from merging, approving, closing, or labelling, without claiming human review is the only gate (test: "the herd rules keep the supervisor ban without the only-gate claim")
- [ ] `ratchet-status` distinguishes a `state:in-review` issue genuinely waiting on a human (`risk:high`, or a changes-requested verdict) from one the `auto-merge` sweep will take, and does not report the second as human-blocked (test: "ratchet-status does not report auto-mergeable work as human-blocked")
- [ ] `ratchet-init`'s branch-protection step explains protection as blocking direct pushes to `main` — with `gates` and `size` required for automated and human merges alike — instead of as making a human merge the only way in (test: "ratchet-init explains protection without the human-only-way claim")
- [ ] `./setup.sh` has been run so `.claude/skills/**` and `plugin/skills/**` match the canonical `.agents/skills/**` sources (command: `node scripts/skill-parity.mjs` exits `0`)
- [ ] Every criterion above has exactly one test named after it
