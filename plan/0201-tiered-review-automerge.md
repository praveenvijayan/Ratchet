---
title: Tiered review — normal-risk PRs auto-merge on green plus recorded verdict, risk-high waits for a human
priority: high
labels: [scripts, review]
blocked_by: [0197-plan-risk-tier, 0200-gates-on-every-pr]
---

Uniform review is the bottleneck and the gap at once: low-risk PRs wait on a
human who adds little, while high-risk PRs get the same skim as everything
else. Tier it on the plan-declared risk label (0197): every PR gets the
automated adversarial review verdict (already recorded by review-verdict);
normal-risk PRs merge automatically on green gates plus an approving verdict —
no human wait; `risk:high` PRs additionally require a human approval and a
minimum delay before merge. Faster than today for the common case, stricter
for the dangerous one.

## Acceptance criteria
- [ ] A PR without the `risk:high` label, with all required checks green and an approving recorded review verdict, is merged automatically with no human action
- [ ] A normal-risk PR with green checks but a changes-requested verdict is not auto-merged — it follows the existing rework path
- [ ] A PR carrying `risk:high` is never auto-merged: it requires a human approval, and at least 15 minutes must elapse between the PR becoming mergeable and the merge
- [ ] Every auto-merge records what it acted on — the verdict, the check state, and the risk tier are visible on the PR after the fact
- [ ] When auto-merge fails (race with a new push, API error), the PR is left un-merged with a comment stating why — never a silent retry loop
