---
title: Add ratchet-herd skill wrapping the supervisor
priority: medium
labels: [herd]
blocked_by: [0055-herd-verify-pr]
---

A thin skill over `scripts/herd.mjs`: validate config, start or attach to the
supervisor, summarize its state. The skill is convenience; the script is the
product.

## Acceptance criteria
- [ ] The skill validates `.ratchet/herd.json` and surfaces the init hint when it is missing, without starting anything
- [ ] The skill starts the supervisor when none is running, or attaches to and summarizes the state of a running one (live workers, attempts, pending escalations)
- [ ] Everything the skill does works standalone via plain `node scripts/herd.mjs` — the skill adds no behavior of its own

## Notes
Author the skill in `.agents/skills/ratchet-herd/SKILL.md` and run `./setup.sh`
to generate the mirrors — never edit the `.claude`/plugin copies directly.
