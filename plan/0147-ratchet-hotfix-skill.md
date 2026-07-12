---
title: Add ratchet-hotfix skill carrying the full hotfix/revert procedure
priority: medium
labels: [skills, agents]
blocked_by: []
---

The hotfix/revert fast lane is the rarest path in the manual yet occupies a
full section every session. Move the procedure into a human-invoked skill so
the manual keeps only the trigger prohibition and a route (see
0143-slim-agent-manual). The lane's constraints are safety-critical and must
survive the move intact.

## Acceptance criteria
- [ ] `.agents/skills/ratchet-hotfix/SKILL.md` exists with `disable-model-invocation: true` and frontmatter matching the conventions of the existing ratchet skills
- [ ] The skill states the lane exists only on an explicit human "hotfix" or "revert PR #M" trigger, that suspicion alone means report and wait, and that the agent never self-invokes the lane
- [ ] The skill's procedure prefers `git revert -m 1 <merge-sha>` of the causal merge on a fresh `hotfix/<slug>` branch from current `main` in a worktree, allows a minimal forward fix only when revert cannot express the correction, requires green `GATES.md` gates before the PR, requires a PR titled `hotfix: <what broke>` naming the offending merge, and ends at the PR with no merge
- [ ] The skill requires a follow-up root-cause plan file via `/ratchet-plan` and states a hotfix without one is unfinished
- [ ] `.claude/skills` and `plugin/skills` mirrors are identical to the canonical skill after running `./setup.sh`, and `scripts/skill-parity.mjs` passes
- [ ] `AGENTS.md` is unchanged by this PR (the manual shrink happens in 0143-slim-agent-manual)
- [ ] Every criterion above has exactly one test named after it
