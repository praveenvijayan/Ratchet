---
title: Offer branch protection for main during ratchet-init
priority: medium
blocked_by: [0007-ci-gates-on-agent-prs]
---

"Never merge, never push to main" is Hard Rule 6, but nothing enforces it —
`/ratchet-init` doesn't configure branch protection, so an agent with push
access can violate every rule mechanically. The human gate should be a GitHub
mechanism, not prompt obedience.

## Acceptance criteria
- [ ] `/ratchet-init` offers to protect `main`: require a PR, require the `pr-gates` check, and block force pushes
- [ ] Protection is applied only after explicit user confirmation; declining leaves repo settings untouched and is reported
- [ ] When the token lacks permission to set protection, init reports exactly that with the manual steps, rather than failing or claiming success
- [ ] Init's report always states the current protection status of `main`
