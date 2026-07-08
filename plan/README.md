# `plan/` — the source of truth for issues

Every file in this folder compiles to exactly **one GitHub issue**. You author
intent here; the `plan-sync` workflow turns it into issues when the planning PR
merges to `main`. You never create issues by hand.

> **The one rule that matters most:** a file **must** have an
> `## Acceptance criteria` block with at least one `- [ ]` item. Without it the
> issue is created as `state:draft` — **unpickable** — and anything that depends
> on it stays **frozen** forever. Most "the queue is stuck" problems are simply
> drafts missing criteria. If you can't state a testable criterion, the work
> isn't ready to plan yet.

## Copy this template

```markdown
---
title: <imperative summary of the one change>
priority: high              # high | medium | low   (required)
labels: [area]              # optional extra labels
blocked_by: []              # other slugs like [0002-user-model], or []  (required)
---

One or two sentences: what this is and why it exists.

## Acceptance criteria
- [ ] <observable, testable outcome 1>
- [ ] <observable, testable outcome 2>
- [ ] <what the user sees when it fails — a clear message, never a raw error>
- [ ] Every criterion above has exactly one test named after it
```

**Good criteria are observable outcomes, not tasks.** "Returns 401 on bad
credentials" is testable; "handle errors properly" is not. If a criterion can't
be checked by reading code or running a test, rewrite it.

**Name the failure modes.** If the change can fail in front of a user, the
criteria must say what the user sees when it does — "Invalid credentials return
401 with a generic message", "Network failure shows a retry prompt, not a stack
trace". Error handling is part of every issue's definition of done (Hard Rule 8
in `AGENTS.md`), so criteria that spell out the failure behaviour give the
agent and the reviewer the same target.

**The criteria are the test plan.** Each `- [ ]` criterion gets exactly one
test, named after it, exercising behaviour through the public interface — never
mocks or implementation details. A test that maps back to no criterion (and no
bug being fixed) does not get written; test count is bounded by criteria count.
This is deliberate: it gives the building agent a stopping condition, and lets
the reviewer verify correctness by diffing test names against criteria. If more
tests seem genuinely needed, the criteria are incomplete — that is a planning
gap, so refine the plan file (or add one); never pad the suite.

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
  Resolution is order-independent: new issues are created (as `state:draft`)
  before any body is rendered, so a blocker on a brand-new file resolves on the
  first sync regardless of filename order, and a blocker whose plan file was
  since removed still resolves through its issue's marker. A slug that matches
  no plan file and no issue is a loud `WARNING` in the sync log, never a silent
  drop — check it for typos.
- **The file owns content; GitHub owns state.** Edit a file and push: the sync
  updates the matching issue's title, body, and labels — *but only while the
  issue is still `state:ready` or `state:draft`*. Once work starts, the file is
  ignored so live work is never overwritten.

## How dependencies and changes flow

- **New work / improvements / post-merge bugs** → add a new `plan/*.md` file.
  It enters the queue by priority. A `priority:high` file with no blockers jumps
  to the front automatically — that is the whole triage system.
- **Rework on an open PR** → handled as review comments, not a plan file. See
  `AGENTS.md` step 6.

The marker `<!-- plan-id: <slug> -->` embedded in each issue body is how the
sync recognises its own issues. Do not remove it.
