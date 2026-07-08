---
title: Hand the unattended agent the verified bytes and bind plans to issues
priority: medium
blocked_by: []
---

The runner verifies the issue body and title, then launches an agent that
re-fetches the issue live — the verified bytes are never handed over, and the
prompt tells the agent the body "has already been verified". An issue edit in
the window between verification and the agent's own fetch delivers unverified
instructions pre-blessed. Separately, verification doesn't bind slug to issue:
a reviewed plan's compiled body copied wholesale onto a *different* issue
verifies, sending an agent to work plan B on issue A's branch.

## Acceptance criteria
- [ ] The agent works from the exact content that passed verification — an issue-body edit made after the verify step does not change what the agent executes
- [ ] An issue whose body carries another plan's marker/content fails verification with a reason naming the mismatch
- [ ] The DOCS.md threat model describes both controls
