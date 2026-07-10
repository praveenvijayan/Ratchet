---
title: Scaffold project-owned files during installation instead of copying Ratchet's
priority: medium
labels: [installer]
blocked_by: [0105-bootstrap-installer]
---

`GATES.md`, `memory/USER.md`, `memory/MEMORY.md`, `memory/ARCHITECTURE.md`,
`.env.example`, and the `plan/` directory are project-owned, but the
copy-the-repo flow ships Ratchet's own versions — a host project inherits
Ratchet's memory, Ratchet's gates, and Ratchet's backlog. The installer should
generate clean scaffolds for these files, marked `generated` in the manifest.

## Acceptance criteria
- [ ] After a fresh bootstrap, the host project has scaffolded `GATES.md`, `memory/USER.md`, `memory/MEMORY.md`, `memory/ARCHITECTURE.md`, and `.env.example` containing template/placeholder content, none of Ratchet's own project content
- [ ] After a fresh bootstrap, `plan/` contains only `plan/README.md` — no Ratchet plan files, no `plan/done/`, no `plan/examples/`
- [ ] A generated file that already exists in the host project is left byte-for-byte unchanged on install and on update, and the run reports it as skipped
- [ ] The installation manifest records scaffolded files as `generated`, distinct from `framework` files, so updates and uninstall can treat them differently
- [ ] Every criterion above has exactly one test named after it
