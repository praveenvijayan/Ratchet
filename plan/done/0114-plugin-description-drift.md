---
title: Fix stale plugin descriptions that name only 3 of 11 skills
priority: low
labels: [docs]
blocked_by: []
---

`plugin/.claude-plugin/plugin.json` and the plugin entry in
`.claude-plugin/marketplace.json` describe the plugin as "ratchet-plan,
ratchet-sync, and ratchet-init skills" — a snapshot from when only three
skills existed. The plugin now ships eleven. Enumerated partial lists drift
every time a skill is added, so the description should characterize the set
rather than enumerate it (or be generated/checked from the skills directory).

## Acceptance criteria
- [ ] The `plugin.json` description no longer names a stale subset of skills — it either describes the full skill set generically or matches the actual contents of `plugin/skills/`
- [ ] The marketplace.json plugin entry description is consistent with the corrected plugin.json description
- [ ] A gate or test fails with the offending file named if a plugin description ever again enumerates skills that don't match the skills directory
- [ ] Every criterion above has exactly one test named after it
