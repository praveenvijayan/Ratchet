---
title: Move RTK instructions out of AGENTS.md
priority: medium
labels: [documentation, framework]
blocked_by: []
---

Move the project-specific RTK command guidance out of the shared Ratchet operating manual and into `memory/MEMORY.md`, so Ratchet-enabled projects do not inherit a tool-specific command requirement from `AGENTS.md`.

## Acceptance criteria
- [ ] `AGENTS.md` contains no RTK/headroom instruction block and no directive requiring shell commands to be prefixed with `rtk`.
- [ ] `memory/MEMORY.md` contains the relocated RTK guidance, including its command examples and rules, without loss of content.
- [ ] A regression test named after each criterion verifies the RTK block is absent from `AGENTS.md` and preserved in `memory/MEMORY.md`.
