---
title: Untrack editor state and review notes from the template
priority: low
blocked_by: []
---

Four `.obsidian/*.json` files (editor state) and `Gaps found as part of the
review.md` (the maintainer's private review notes) are committed, so they ship
to everyone who uses the repo as a template. Neither belongs in a framework
that sells discipline.

## Acceptance criteria
- [ ] `git ls-files` shows no `.obsidian/` entries and no review-notes file
- [ ] `.gitignore` covers `.obsidian/` so the editor state cannot be re-committed accidentally
