---
title: pr-size-check stops counting generated skill mirrors against the file limit
priority: high
labels: []
blocked_by: []
---

Skills have one canonical source (`.agents/skills/`) and two generated mirrors
(`.claude/skills/`, `plugin/skills/`), so any PR touching one skill file ships
three changed files to the size gate. Instruction-wide changes (e.g. the
issue-#207 label-wording fix) become structurally impossible within the 6-file
limit even when the real change is small — and since `pr-size-check` reads its
thresholds from the base branch (by design, #84), no in-PR config change can
help. Exclude the mirrors from the count; the canonical source still counts.

## Acceptance criteria
- [ ] Files under the generated skill mirror directories are excluded from the pr-size-check changed-file count
- [ ] The canonical skill source under `.agents/skills/` still counts toward the limit
- [ ] A PR changing one canonical skill file plus its two regenerated mirrors counts as one changed file for the gate
- [ ] GATES.md documents the mirror exclusion alongside the existing lockfile exclusions
- [ ] Every criterion above has exactly one test named after it

## Notes
Split A of the issue-#207 rework (see the scope-split comment there). Must land
before 0101-state-instructions-remove-previous-label, which touches a skill and
cannot fit the gate until mirrors stop counting.
