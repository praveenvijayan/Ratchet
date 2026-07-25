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
estimated_lines: 120        # hand-written changed lines you expect (max 400)
locks: []                   # exclusive resources this plan takes  (optional)
risk: normal                # high | normal  (optional, defaults to normal)
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

### Every criterion names how the agent proves it

Observable is not enough on its own. **Every criterion must be provable by the
building agent through a named mechanism** — one of exactly three:

- a **test** the agent can run (`node scripts/foo.test.mjs` asserts the outcome),
- a **command** whose exit code decides (`node scripts/bar.mjs` exits `0`),
- an **observable check** the agent can make in the repo or in the program's
  output (a rendered page contains the control, an API response carries the
  field, a workflow file declares the step).

A criterion with no such mechanism cannot be closed by the agent: it either
stalls the issue or gets waved through on a hunch. Rewrite it until the
mechanism is named.

```markdown
Before — unverifiable: names an environment, not a proof
- [ ] Sign-in works on staging

After — verifiable: names the call, the outcome, and the test that runs it
- [ ] POST /session with valid credentials returns 200 and a session cookie
      (test: "sign-in returns a session")
```

The "before" form gives the agent no stopping condition and the reviewer nothing
to diff test names against. The "after" form gives both. If the only honest
version of a check needs a human — a real browser session, a third-party
account, production credentials, a subjective judgement — it is **not** an
acceptance criterion: move it to `## Human runbook` below.

**UI and behaviour criteria require behaviour tests, and a test that asserts on
source strings does not satisfy a criterion.** Grepping the implementation for a
class name, a label, a selector, or a function call proves only that some text
exists in a file — never that the behaviour happens. Render the component and
assert on what it produces; call the function and assert on what it returns; run
the command and assert on its output. A criterion whose only evidence is a
source-string assertion is **unmet**, and the reviewer rejects the PR for it
(`AGENTS.md` step 6).

**Encode ordering as `blocked_by`, never only in prose.** The sync sees
dependencies **only** through `blocked_by` slugs; prose ordering is invisible to
it. Any sequencing you state in a plan file's prose must **also** appear as
`blocked_by` slugs on the dependent file. The tell that you missed one: a
criterion that can only be satisfied *after* other issues merge means the blocker
list is incomplete — add the missing slugs so the issue syncs `state:blocked`
instead of `state:ready`.

**Phrase a repo-wide invariant as a check on a capstone, never as a bare
criterion on a member.** A batch-wide postcondition that only holds once every
member issue has merged cannot be satisfied or tested by any single member PR.
Do not write it as a bare assertion criterion on a member issue. Phrase it as
**"add an automated check that enforces X"** and place that criterion on a
**capstone** issue `blocked_by` every prerequisite — the check becomes a real,
testable outcome once the batch lands.

> **Counter-example — the #346 shape.** Issue #346 shipped `state:ready` while
> actually blocked on three sibling migrations. Two authoring mistakes caused it:
> its ordering ("the last two… completing the consolidation") lived only in the
> plan's prose instead of in `blocked_by`, and it carried a batch-wide
> postcondition as a plain criterion that no single PR could satisfy. Encoded as
> `blocked_by` slugs plus a capstone check, neither mis-scope can recur.

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
precisely in the cases the criteria didn't enumerate. Three **optional** sections
let a plan demand more without weakening the one-test-per-criterion rule. Put
them in the body below the criteria; the sync carries them into the issue
verbatim (no compiler change — a plan that omits them compiles and behaves
exactly as it always has), and the building agent must honour them.

```markdown
## Non-functional
- p95 request latency stays under 200 ms at 100 rps
- all interactive controls reachable and operable by keyboard

## Test notes
- exercise the retry path under simulated network loss
- property test: encode∘decode is identity for any valid input

## Human runbook
- sign in on staging with a real Google account and confirm the session sticks
- confirm the invoice PDF prints correctly on A4
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
- **`## Human runbook`** — checks **only a human can perform**: a real browser
  session, a third-party account, production credentials, a subjective visual
  judgement. These are deliberately *not* acceptance criteria — the building
  agent cannot prove them, so they never gate its stopping condition and never
  stall the issue. The sync carries the section into the issue verbatim, exactly
  like the other two, and the human reviewing the PR walks it. This is the #289
  fix generalised: an unverifiable "works on staging" check becomes an explicit
  runbook item instead of a criterion no agent can close.

**Use plain `-` bullets in all three sections, never `- [ ]`.** Only a
`## Acceptance criteria` block makes an issue pickable, and the readiness check
looks for its checkboxes — reserving `- [ ]` for criteria keeps "which boxes are
the criteria" unambiguous for the reviewer and the sync alike.

## The size budget — `estimated_lines`

Declare, in frontmatter, how many **hand-written changed lines** you expect the
change to take. Count only lines a person writes: **generated files are
excluded** (lockfiles, generated skill mirrors, build output — the same
exclusions the PR size gate applies). The estimate is a budget, not a promise;
it exists to force the split decision while splitting is still free.

**Over 400 means split the plan before writing any code.** The sync refuses an
`estimated_lines` over 400 — it aborts non-zero, names the file and the value,
and changes nothing on GitHub. The fix is never to raise the number: break the
plan into several smaller plan files, one issue each, and let `blocked_by`
carry the ordering. This is the same 400-line cap the `pr-gates` size check
enforces on the finished PR, moved to the only point where honouring it is
cheap — after the code exists, an over-cap PR can only be renegotiated.

A plan with no `estimated_lines` still syncs (existing plans are
grandfathered), but it logs a warning naming the file. New plans declare it.

## Exclusive resources — `locks`

Two plans that both add a migration, both own the same route, or both rewrite
the same file collide the moment they are picked in parallel. Declare what a
plan takes exclusively:

```yaml
locks: [migration, route:/home, file:src/db/schema.ts]
```

**Token conventions** — a token is a name two authors agree on, nothing more:

- `migration` — the plan adds or edits a database migration.
- `route:<path>` — the plan owns a URL path, e.g. `route:/home`.
- `file:<path>` — the plan rewrites one file, e.g. `file:src/db/schema.ts`.

Invent others freely; the only rule is that both plans spell the token the same
way. **Tokens are compared as exact strings** — no case folding, no path
normalisation — so `route:/Home` and `route:/home` are different resources.

When two plans with open issues claim the same token, the sync makes at most one
of them `state:ready` and gives the other `state:blocked` with an ordinary
`Blocked by #N` line naming the token and the conflicting slug. The order is
deterministic: **priority first, then slug**. Nothing else changes — when the
holder's issue closes, `unblock-dependents` releases the waiting issue exactly
as it would for a `blocked_by` edge, with no manual edit. Every conflicting pair
is named in the sync log. Where a `blocked_by` edge already serializes the two
plans, no lock edge is added — the dependency is doing the job already.

`locks` is optional. A value that is not a list of strings aborts the sync
non-zero, naming the file and changing nothing on GitHub: a lock the compiler
cannot read would let the plan sync as ready and collide with the very work it
meant to exclude.

## Review tier — `risk`

Risk is cheapest to classify **now**, at plan time, and most expensive to
discover at merge. `risk` declares it once and the tier is inherited the whole
way down: `plan-sync` labels the issue `risk:high`, and the PR handoff
(`ratchet-submit.mjs`) copies that label onto the PR, so downstream review
tiering reads one label instead of re-deriving the risk from a diff.

```yaml
risk: high
```

`risk` is a **closed set: `high` or `normal`.** The key is optional and absent
means `normal`. Only `high` produces a label — a normal-risk plan carries no
risk label at all. Any other value aborts the sync non-zero before it touches
GitHub, naming the file and the invalid value, exactly like a bad `priority`:
an unreadable tier would sync as normal and route a dangerous change into the
cheap review lane.

**Work in any of these areas must declare `risk: high`** — the closed set:

- **schema** — migrations, or any change to a persisted data shape
- **auth** — authentication, authorization, sessions, permissions
- **secrets** — credentials, tokens, keys, or how they are stored or read
- **billing** — payments, pricing, invoicing, quota that costs money
- **`infra/**`** — infrastructure and deployment definitions
- **`.github/**`** — workflows and repository automation

If a plan touches one of those and does not say `risk: high`, the plan is
wrong — fix the plan file, not the review.

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
estimated_lines: 120        # hand-written changed lines you expect (max 400)
locks: [route:/login]       # exclusive resources this plan takes  (optional)
risk: high                  # high | normal  (optional, defaults to normal)
---

One or two sentences: what this is and why it exists.

## Acceptance criteria
- [ ] User submits email + password and receives a session token
- [ ] Invalid credentials return 401 with a generic message
- [ ] Passwords are verified against the stored hash, never compared in plain text
```

### Rules the sync enforces

- **`title` + `priority` required.** Without them the sync aborts: it logs
  the offending file and exits non-zero, changing nothing — no file is
  partially synced, no issue is created or updated.
- **Priority is a closed set.** `priority` must be exactly `high`, `medium`, or
  `low`. Any other value aborts the sync the same way (the file is not
  "skipped" — the entire run stops, logged as an invalid priority, because
  silently sorting a bad value would corrupt triage order.
- **`estimated_lines` is capped at 400.** A value over the cap, or one that is
  not a non-negative whole number, aborts the sync before it touches GitHub:
  the offending file and value are logged with the instruction to split the
  plan. A file that omits the key syncs as before with a warning naming it.
- **`risk` is a closed set: `high` or `normal`.** Absent means normal. A
  `risk: high` plan's issue carries the `risk:high` label and its PR inherits it;
  any other value aborts the sync non-zero, naming the file and the value. Work
  touching schema, auth, secrets, billing, `infra/**`, or `.github/**` must
  declare `risk: high`. See "Review tier" above.
- **Unknown frontmatter keys are ignored with a warning.** `title`, `priority`,
  `labels`, `blocked_by`, `estimated_lines`, `locks`, `risk`, and
  `retroactive_ok` are the only keys the compiler understands. Any other key is logged as
  `WARNING: <file> has unknown frontmatter key '<key>'` and ignored; the file
  still compiles.
- **`locks` serializes plans that claim the same resource.** Two plans with open
  issues claiming the same lock token are never both `state:ready`: the loser —
  chosen by priority, then slug — gets `state:blocked` behind the winner and is
  released by `unblock-dependents` when the winner closes. A `locks` value that
  is not a list of strings aborts the sync before it touches GitHub, naming the
  file. See "Exclusive resources" above.
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
- **Blocked-by cycles are a hard gate.** A dependency cycle is a deadlock: no
  issue in the cycle can ever unblock. The sync detects cycles before mutating
  GitHub, prints every slug in each cycle, and exits non-zero. Break the
  `blocked_by` edge and re-sync.
- **A plan whose work already exists is flagged, not queued.** Plan-before-code
  is hard rule 0. When a planning PR adds a plan file whose slug or title matches
  a live branch or an open PR, the `retroactive-plans` check comments on the PR
  naming the plan file and what it matched, and the sync gives that issue
  `state:draft` — **unpickable** — however complete its criteria. A human
  approves it by adding `retroactive_ok: spike merged as PR 229, written up
  afterwards` to the plan's frontmatter in a planning PR: the approval lands in
  git history, and the next sync flips the issue to ready and records the
  approval, with what it matched, as a comment on the issue. Avoid `#` in the
  note; the frontmatter parser reads it as an inline comment.
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
