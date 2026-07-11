---
title: Separate runtime scripts from framework tests and development files
priority: medium
labels: [installer]
blocked_by: [0103-install-manifest-and-profiles]
---

`scripts/` mixes workflow-invoked runtime scripts with Ratchet's own test files
(`*.test.mjs`) and framework-only development helpers, and the updater ships
the whole directory. Host projects end up carrying Ratchet's test suite and
tools they never invoke. The manifest classification from
`0103-install-manifest-and-profiles` must become real: runtime scripts
shippable per profile, tests and dev-only files excluded.

## Acceptance criteria
- [ ] The manifest classifies every file under `scripts/` individually: each workflow-invoked or imported runtime script is `framework` (with its owning profile), and every `*.test.mjs` and framework-only development helper is `excluded`
- [ ] A test fails when any script invoked by a shipped `.github/workflows/*.yml` or imported by a shipped script is classified `excluded`, printing the missing script names — the classification can never break a shipped workflow
- [ ] A test fails when any `scripts/*.test.mjs` file is classified as shippable, so tests can never leak back into host installs
- [ ] Every criterion above has exactly one test named after it
