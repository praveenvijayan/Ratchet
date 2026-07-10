---
title: State labels are mutually exclusive — claim flip removes state:ready, and the invariant is enforced
priority: high
labels: []
blocked_by: []
---

Issue #181 carries `state:ready` and `state:in-review` together. Cause: the
claim instructions (AGENTS.md step 2 and the ratchet-run prompt) say to *add*
`state:in-progress` but never to *remove* `state:ready`, so the orphaned ready
label survives every later flip. Nothing anywhere enforces that an issue has at
most one `state:*` label, so any slip becomes permanent. The damage is not
cosmetic: the pick step selects by `state:ready`, so an issue under review
looks pickable and can be dispatched a second time.

## Acceptance criteria
- [ ] Every instruction that sets a `state:*` label (AGENTS.md, workflow prompts, skills) states the removal of the previous state label in the same step, symmetric with the existing exit-path wording
- [ ] When any `state:*` label is added to an issue that already has a different one, the system removes the older state label so exactly one remains, without human action
- [ ] The enforcement treats the newest label as the truth and never removes the only state label an issue has
- [ ] Non-state labels (`priority:*`, `herd`, others) are never touched by the enforcement
- [ ] An enforcement API failure fails its run visibly naming the issue, never silently leaving the dual state
- [ ] Every criterion above has exactly one test named after it

## Notes
Observed sequence on #181: plan-sync set `state:ready`; the worker added
`state:in-progress` without removing it (as instructed — the removal is simply
missing from the claim wording, unlike AGENTS.md's exit paths which do say
"remove state:in-progress"); the in-review flip then removed only in-progress.
Enforcement belongs GitHub-side (labeled-event driven), same closed-loop
pattern as unblock-dependents and 0098-review-verdict-label-workflow, so no
agent-side discipline is load-bearing.
