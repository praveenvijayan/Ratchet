---
title: Close the title and comment injection channels in ratchet-run
priority: medium
blocked_by: []
---

The runner's integrity check verifies only the issue *body* against the merged
plan file. The agent it launches reads the whole issue — title and comments
included — and both are editable by anyone with issue access, so the prompt-
injection surface the check was built to close has simply moved channels.
Separately, the plan slug extracted from the marker is attacker-influenced text
that flows into a filesystem path with no charset restriction; today it fails
closed only incidentally.

## Acceptance criteria
- [ ] Instruction text placed in the issue title or a comment does not reach the unattended agent as work instructions (verified against the plan, stripped, or explicitly excluded by the runner's prompt contract)
- [ ] A `plan-id` slug containing characters outside a safe slug charset fails verification closed, with a clear log line
- [ ] The DOCS.md threat model names title and comments as untrusted channels and states how each is neutralised
