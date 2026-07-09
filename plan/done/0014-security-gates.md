---
title: Detect and add security gates (dependency audit, secret scan) in ratchet-init
priority: medium
blocked_by: []
---

`GATES.md` covers format/typecheck/lint/test/build but no security checks — no
dependency audit, secret scan, or SAST. Agent-generated code arguably needs
these more than human code: a leaked secret or vulnerable dependency in an
agent commit is currently caught by no one.

## Acceptance criteria
- [ ] `/ratchet-init` detects evidence-based security gates (e.g. `npm audit` / `pip-audit` / `cargo audit` when the matching ecosystem is present, gitleaks when configured) and appends them to `GATES.md`
- [ ] Where no evidence exists, security gate rows are written as `TODO:` entries, never guessed
- [ ] The `GATES.md` template documents the recommended security gates so hand-authors see them too
- [ ] Detection never executes any of the tools (consistent with init's existing detection-only rule)
