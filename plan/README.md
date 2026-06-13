# `plan/` — the source of truth for issues

Every file in this folder compiles to exactly **one GitHub issue**. You author
intent here; the `plan-sync` workflow turns it into issues on push. You never
create issues by hand.

## File naming

`NNNN-short-slug.md` — e.g. `0001-email-login.md`. The stem (`0001-email-login`)
is the **slug**: it is the permanent identity of the issue and how other files
reference it as a dependency. Never rename a file after its issue is created;
the rename orphans the link and creates a duplicate.

## Format

```markdown
---
title: Add email/password login
priority: high              # high | medium | low   (required)
labels: [auth, backend]     # optional extra labels
blocked_by: [0002-user-model]   # other slugs, or []  (required, may be empty)
---

One or two sentences: what this is and why it exists.

## Acceptance criteria
- [ ] User submits email + password and receives a session token
- [ ] Invalid credentials return 401 with a generic message
- [ ] Passwords are verified against the stored hash, never compared in plain text
```

### Rules the sync enforces

- **`title` + `priority` required.** Without them the file is skipped and logged.
- **Acceptance criteria decide readiness.** A file with at least one `- [ ]`
  item under `## Acceptance criteria` becomes `state:ready`. Without criteria it
  becomes `state:draft` and no agent will pick it. If you cannot write the
  criteria as a testable sentence, the issue is not ready — and that is the
  signal to refine the plan, not to ship a vague issue.
- **`blocked_by` lists slugs, not issue numbers.** The sync resolves each slug
  to its issue number and writes `Blocked by #N` into the body. An issue with
  any open blocker is given `state:blocked` until `unblock-dependents` clears it.
- **The file owns content; GitHub owns state.** Edit a file and push: the sync
  updates the matching issue's title, body, and labels — *but only while the
  issue is still `state:ready` or `state:draft`*. Once work starts, the file is
  ignored so live work is never overwritten.

## How dependencies and changes flow

- **New work / improvements / post-merge bugs** → add a new `plan/*.md` file.
  It enters the queue by priority. A `priority:high` file with no blockers jumps
  to the front automatically — that is the whole triage system.
- **Rework on an open PR** → handled as review comments, not a plan file. See
  `AGENT.md` step 6.

The marker `<!-- plan-id: <slug> -->` embedded in each issue body is how the
sync recognises its own issues. Do not remove it.
