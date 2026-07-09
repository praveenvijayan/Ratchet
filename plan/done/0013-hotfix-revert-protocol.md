---
title: Define a sanctioned hotfix/revert fast lane for production breakage
priority: medium
blocked_by: []
---

Forward-only has no answer for "the merged PR broke prod". Today an agent must
refuse to hotfix (Hard Rule 0) until a planning-PR round trip completes. A
production system needs a defined revert path that is fast without abandoning
the human merge gate.

## Acceptance criteria
- [ ] AGENTS.md defines a fast lane for production breakage that skips the planning-PR round trip but still ends in a reviewed, human-merged PR
- [ ] The fast lane covers both a clean `git revert` of the offending merge and a forward hotfix, and states when each applies
- [ ] The fast lane requires an explicit human trigger (it can never be self-invoked by an agent that merely suspects breakage)
- [ ] After the fast lane completes, the incident is captured as a normal plan file so the root cause re-enters the queue
