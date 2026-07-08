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
mocks or implementation details. This gives the building agent a stopping
condition and lets the reviewer verify correctness by diffing test names against
criteria. By default the test count is bounded by the criteria count: a test
that maps to no criterion, no bug being fixed, and no section below is padding
and does not get written. If more coverage seems genuinely needed, don't
improvise it into the suite — say so *in the plan*, using the optional sections
below (or refine the criteria). Planned tests are welcome; unplanned ones are
padding.

### Optional sections — raising the floor above the happy path

Acceptance criteria are the floor, not the ceiling: production defects live
precisely in the cases the criteria didn't enumerate. Two **optional** sections
let a plan demand more without weakening the one-test-per-criterion rule. Put
them in the body below the criteria; the sync carries them into the issue
verbatim (no compiler change — a plan that omits both compiles and behaves
exactly as it always has), and the building agent must honour them.

```markdown
## Non-functional
- p95 request latency stays under 200 ms at 100 rps
- all interactive controls reachable and operable by keyboard

## Test notes
- exercise the retry path under simulated network loss
- property test: encode∘decode is identity for any valid input
```

- **`## Non-functional`** — constraints the change must satisfy that aren't a
  single observable behaviour: performance budgets, accessibility, load,
  security, migration safety. A building agent treats each as a requirement to
  meet **and verify** — a stated latency budget means adding the check that
  proves it, not hoping.
- **`## Test notes`** — specific tests the plan wants **beyond** the
  criteria-mapped set: edge cases, property/regression/integration coverage. A
  building agent writes these in addition to the per-criterion tests, each named
  after the case it covers. Because the plan asked for them, they are planned
  coverage, not padding (see `AGENTS.md` step 3).

**Use plain `-` bullets in both sections, never `- [ ]`.** Only a
`## Acceptance criteria` block makes an issue pickable, and the readiness check
looks for its checkboxes — reserving `- [ ]` for criteria keeps "which boxes are
the criteria" unambiguous for the reviewer and the sync alike.

## File naming

`NNNN-short-slug.md` — e.g. `0001-email-login.md`. The stem (`0001-email-login`)
is the **slug**: it is the permanent identity of the issue and how other files
reference it as a dependency. Never rename a file after its issue is created;
the rename orphans the link and creates a duplicate.

## Archiving closed plans

Plan files are not deleted when their issues close — they are **archived**. Run
the dedicated sweep periodically (for example alongside `/ratchet-memory`):

```sh
node scripts/archive-closed-plans.mjs
```

It moves every `plan/*.md` whose issue is **closed** into `plan/done/`, keeping
the active `plan/` directory a map of live work while history stays on disk and
in git. It only *moves* files — review the renames and commit them, so the
archive lands as one reviewable change. This is safe: `plan-sync` never scans
`plan/done/`, and it resolves every `blocked_by` through the issue's
`<!-- plan-id: slug -->` marker, so a dependency on an archived slug keeps
working. Never edit files under `plan/done/`; they are frozen history.

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
