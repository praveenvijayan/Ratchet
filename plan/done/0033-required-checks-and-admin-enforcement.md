---
title: Make the CI checks actually binding under branch protection
priority: medium
blocked_by: []
---

The enforcement machinery exists but doesn't bind. The protection config
`/ratchet-init` offers requires only the `gates` context — the `size` job is
advisory even when protection is on. It sets `enforce_admins: false` while
documenting that the requirement "still blocks every agent", which is wrong for
the prescribed deployment: agents authenticate with the owner's PAT, an admin
token, so protection doesn't apply to them at all. And a PR whose gates were
all `TODO:` rows shows a green check that verified nothing.

## Acceptance criteria
- [ ] The branch-protection offer requires both the `gates` and `size` contexts
- [ ] The protection step states the `enforce_admins` trade-off accurately: with an owner/admin PAT, `false` exempts agents — and offers `true` as the recommended default
- [ ] A pr-gates run in which every gate was `TODO` is visibly distinguished from one that verified real gates (the reviewer can tell "green" from "green but vacuous")
