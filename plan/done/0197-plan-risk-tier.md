---
title: Risk tier declared in the plan header and inherited by the issue and PR
priority: medium
labels: [scripts, planning]
blocked_by: [0192-plan-resource-locks]
---

Risk is currently discovered (or not) at merge — the most expensive place.
The cheapest place to classify is the plan: a `risk` field set at plan time,
inherited by the issue and its PR, is what downstream review tiering keys on.
Anything touching schema, auth, secrets, billing, `infra/**`, or `.github/**`
is `risk: high` by rule.

## Acceptance criteria
- [ ] A plan file may declare `risk: high` or `risk: normal` in frontmatter; the sync accepts the key without an unknown-frontmatter-key warning, and any other value aborts the sync non-zero naming the file and the invalid value (same shape as the priority validation)
- [ ] An issue created from a `risk: high` plan carries a `risk:high` label; a plan without the key defaults to normal and gets no risk label
- [ ] The PR that closes a `risk:high` issue inherits the `risk:high` label automatically
- [ ] `plan/README.md` documents the closed set and the rule: schema, auth, secrets, billing, `infra/**`, and `.github/**` work must declare `risk: high`
