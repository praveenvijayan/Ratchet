---
title: Flag retroactive plans — a plan whose code already exists on a branch needs explicit human approval
priority: medium
labels: [scripts, planning]
blocked_by: []
---

Plan-before-code is invariant 1, but #229/#235 show it breaks silently for
side-branch work: code gets written first, then a plan is filed to paper over
it, converting the ratchet into paperwork. The planning PR gets a check that
detects plans whose work already exists on a branch and flags them loudly for
real human review instead of letting them sync as ordinary ready issues.

## Acceptance criteria
- [ ] A planning-PR check compares each added plan file against open branches and open PRs; a plan whose slug or title matches an existing branch name, PR title, or PR body is flagged with a comment on the planning PR listing the plan file and the matching branch/PR
- [ ] A flagged plan syncs `state:draft` (unpickable) until a human explicitly approves it; the approval mechanism is documented and leaves an audit trail on the issue
- [ ] A plan with no matching pre-existing branch or PR syncs exactly as before (regression)
- [ ] The check's output states why each plan was flagged, quoting the matching branch/PR reference — never a bare failure
