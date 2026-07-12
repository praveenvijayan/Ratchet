---
title: Ensure ratchet-next and ratchet-status carry the manual detail they will own
priority: medium
labels: [skills, agents]
blocked_by: []
---

0143-slim-agent-manual removes situational detail from `AGENTS.md` — rework
detection commands, watcher continuation, empty-queue diagnosis — on the
premise that `/ratchet-next` and `/ratchet-status` own it. Make that premise
true before the manual shrinks: verify each piece exists in the owning skill
and add what is missing, using at most one `references/` hop.

## Acceptance criteria
- [ ] The `ratchet-next` skill (its SKILL.md or a `references/` file it explicitly says when to read) contains the three rejection channels with their detection commands: `gh pr view <N> --json reviewDecision` yielding `CHANGES_REQUESTED`, listing review line comments via the pulls comments API, and `gh pr reopen <N>` for a closed-unmerged PR
- [ ] The `ratchet-next` skill contains the post-merge continuation: fast-forward `main` in the shared clone, remove `../wt/issue-<N>`, begin the next pick
- [ ] The `ratchet-status` skill contains the empty-queue diagnosis: drafts missing criteria, blocked chains and their root, an unmerged planning PR, uncommitted plan files, ending with the single unblocking action
- [ ] No `references/` file points to another `references/` file, and every reference is named from its SKILL.md with an explicit read-when condition
- [ ] `.claude/skills` and `plugin/skills` mirrors are identical to the canonical skills after `./setup.sh`, and `scripts/skill-parity.mjs` passes
- [ ] `AGENTS.md` is unchanged by this PR
- [ ] Every criterion above has exactly one test named after it
