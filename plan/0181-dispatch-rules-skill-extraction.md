---
title: Extract pinned-dispatch worker rules into a skill file and slim the shipped promptTemplate
priority: medium
labels: [herd, skills]
blocked_by: [0176-herd-worker-pr-gates-contract]
---

The shipped `promptTemplate` carries the pinned-single-issue dispatch rules
(0063) inline: every worker ingests the long template as part of its startup
reading, and the rules drift per-repo because the template is data in each
`.ratchet/herd.json`. Move the rules to a canonical skill file and shrink the
shipped template to a short reference — shorter startup reading, one
authoritative copy.

## Acceptance criteria
- [ ] The pinned-dispatch rules (issue {issue} is the entire assignment; own claim branch is resumable, never foreign; exit untouched when someone else's PR exists; submit via ratchet-submit) live in one canonical `.agents/skills/` file, with `./setup.sh` mirrors identical and `scripts/skill-parity.mjs` passing
- [ ] The shipped default `promptTemplate` is reduced to naming the issue and directing the worker to read that skill file, and preserves 0063's semantics end to end
- [ ] A worker prompt rendered from the new default contains the dispatched issue number and the skill file path — the two things a fresh headless session cannot discover on its own
- [ ] DOCS.md `promptTemplate` examples match the new default verbatim, note that existing `.ratchet/herd.json` operators must update by hand, and document that a short shared prompt prefix plus tight dispatch improves prompt-cache hit rate
- [ ] Every criterion above has exactly one test named after it

## Notes
Companion to the local-event dispatch plan (0173): tighter dispatch spacing
keeps staggered worker launches inside the provider prompt-cache TTL; this
plan only documents that — the mechanism ships with 0173.
