---
title: Guard cross-agent skill parity so ratchet-herd (and every skill) works on all three agents
priority: medium
labels: [herd]
blocked_by: []
---

The ratchet-herd skill must be invocable from Claude Code, Codex, and
Antigravity, not just Claude Code. Nothing currently enforces that a skill
carries its Codex invocation policy (`agents/openai.yaml`) or that `setup.sh`'s
mirrors stay in sync with the canonical source — a skill can ship usable on one
agent and broken on another, and no gate catches it. Add a guard, modelled on
`gates-coverage.mjs`, that makes cross-agent parity a checked invariant for
every skill including `ratchet-herd`.

## Acceptance criteria
- [ ] A guard script exits non-zero and names the offending skill when any `.agents/skills/<name>/` is missing `agents/openai.yaml`
- [ ] The guard exits non-zero and names the skill and path when a canonical `.agents/skills/<name>/SKILL.md` has no byte-identical mirror at both `.claude/skills/<name>/SKILL.md` and `plugin/skills/<name>/SKILL.md`
- [ ] The guard exits zero on the current tree, confirming `ratchet-herd` is present with its `openai.yaml` and both mirrors (parity across all three agents)
- [ ] The guard is wired into `GATES.md` as a named gate row so it runs on every PR and in local verify
- [ ] `DOCS.md` lists the new guard script in its script inventory (so `docs-refresh` stays green)

## Test notes
- fixture case: a skill dir with a SKILL.md but no `agents/openai.yaml` → guard reports that exact skill
- fixture case: a mirror whose SKILL.md content differs from canonical by one byte → guard reports the mismatched path, not a generic failure
- fixture case: a fully consistent skill set → guard exits zero
