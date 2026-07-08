---
title: Harden the unattended runner against issue-body prompt injection
priority: medium
blocked_by: []
---

`ratchet-run` feeds issue bodies to an agent holding a write-scoped PAT. Issue
bodies are compiled from reviewed plan files, but anyone with issue-write
access can edit them afterwards — a malicious or careless edit becomes
instructions to an agent with contents and PR write access.

## Acceptance criteria
- [ ] The runner only works issues carrying the `plan-id` marker
- [ ] Before acting, the runner verifies the issue body matches the merged plan file's content; on mismatch it comments the discrepancy and skips the issue without making code changes
- [ ] DOCS.md documents the threat model: issue-body injection, required PAT scopes, and why the runner is opt-in
