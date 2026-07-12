---
name: ratchet-plan
description: Turn work into plan/*.md issue files and place them on the rolling planning PR for review. Handles both a quick single report ("/ratchet-plan google signin broken") and a full multi-issue plan from the conversation. Writes files onto the evergreen ratchet/planning branch, pushes, and opens or updates ONE always-open planning PR — then stops. Never edits code, never commits to main, never fixes anything.
argument-hint: [a bug/improvement to report, or a feature/scope to plan; omit to plan the whole idea discussed]
disable-model-invocation: true
allowed-tools: Read, Write, Bash(ls:*), Bash(git:*), Bash(gh:*)
---

# Plan → files → rolling planning PR

Convert work into `plan/*.md` files and place them on the **rolling planning
PR** so they can be reviewed and merged into `main`, which is what creates the
GitHub issues. You decide scale from the request:

- **Quick report** (a found bug/improvement, usually given as the argument) →
  ONE file.
- **Full plan** (an idea discussed in the conversation) → SEVERAL files, one per
  issue.

Either way you only write plan files and manage the planning PR. You never edit
code, never fix anything, never commit to `main`, never create issues directly.
If the request is actually feedback on a PR under review (the current work is
wrong), that's a rework via Request Changes — say so and stop.

## Format contract

Read `plan/README.md` first — it is authoritative. Each file needs frontmatter
(`title`, `priority`, optional `labels`, `blocked_by`) and a `## Acceptance
criteria` block with at least one testable `- [ ]` item. **No criteria → the
issue syncs to `state:draft` and never gets picked.** If you cannot write a
testable criterion, ask one clarifying question rather than writing a vague file.

## Step 1 — Prepare the rolling planning branch

The planning branch is the evergreen `ratchet/planning`; one open PR accumulates
plan files until you merge the batch. Get onto it correctly:

```
git fetch origin
```

- If a planning PR is already open (`gh pr list --head ratchet/planning --state open`):
  check out `ratchet/planning` and `git pull` — you will **append** to it.
- Otherwise (no open PR — first run, or the last batch was merged): create the
  branch fresh from main so the next PR contains only new files:
  `git checkout main && git pull --ff-only && git checkout -B ratchet/planning origin/main`.

Never write plan files onto `main` or onto an `agent/issue-*` working branch.

## Step 2 — Scan for duplicates, then write the plan file(s)

**Scan before create.** Every issue in this system starts as a `plan/*.md` file,
so after Step 1's pull the `plan/` directory on `ratchet/planning` is the
complete dedup surface: merged batches plus anything pending on the planning PR.
Read the frontmatter `title` and `## Acceptance criteria` of the existing files
and compare against what you are about to write **by meaning, not by slug or
wording** — "google signin broken" and "OAuth login fails" are the same plan.
For each item you were going to write:

- **Covered by a file pending on the planning PR** → update that file in place
  (tighten criteria, adjust priority) instead of creating a second one.
- **Covered by a file already merged to `main`** → the issue exists; do not
  recreate it. If your version adds something material, edit the existing file —
  plan-sync updates the issue on merge while it is still `state:draft`/
  `state:ready` and holds once work is live. Otherwise report it as already
  tracked (slug + title) and write nothing for that item.
- **Genuinely new** → create a new file as below.

List `plan/` for the highest existing slug number. For a quick report, write one
`plan/NNNN-slug.md`; for a full plan, decompose the idea into the smallest units
where one PR closes one issue, order them so dependencies precede dependents, and
write one file each. Use `blocked_by` with the **slugs** of files in this plan
(never issue numbers). Priority: a broken core flow/crash is `high`, a normal
defect `medium`, cosmetic `low`; state your choice. Keep acceptance criteria
outcome-focused, and when the change has user-visible failure modes, write them
as concrete criteria — what the user sees on invalid input, a failed call, a
timeout ("returns 401 with a generic message", "shows a retry prompt") — never
a vague "handles errors". Error handling is part of every issue's definition of
done (AGENTS.md Hard Rule 8). Write criteria knowing they are also the test
plan: each criterion becomes exactly one test named after it, and nothing else
gets tested — so every behaviour worth a test must appear as a criterion, and
anything not worth a test should not be one. If the user diagnosed a cause you
may add a short `## Notes`, but never prescribe the implementation.

**Encode ordering as `blocked_by`, never only in prose.** The state machine sees
dependencies **only** through `blocked_by` slugs — prose it cannot read. So any
ordering or sequencing you state in a plan file's prose (e.g. "do this after the
others", "the last two complete the consolidation") **must also** be encoded as
`blocked_by` slugs on the dependent file. A useful tell: if a criterion can only
be satisfied *after* other issues merge, the blocker list is incomplete — add the
missing `blocked_by` slugs so the dependent issue syncs `state:blocked` and is
never picked early. (This is the #346 mis-scope: the ordering lived only in
prose, so sync shipped the issue `state:ready` while it was really blocked.)

**Phrase a repo-wide invariant as a check on a capstone, never as a bare
criterion on a member.** A batch-wide postcondition — an invariant that only
holds once *every* member issue has merged (e.g. "all N call sites use the new
API", "no module still imports the old path") — cannot be satisfied or tested by
any single member PR. Never write it as a bare assertion criterion on a member
issue. Instead phrase it as **"add an automated check that enforces X"** and put
that criterion on a **capstone** issue `blocked_by` every prerequisite in the
batch. The capstone unblocks only after the batch lands, and its criterion is
now a real, testable outcome (the check) rather than a claim no PR can close.

## Step 3 — Push and open/update the planning PR

```
git add plan/
git commit -m "plan: <short summary of what you added>"
git push -u origin ratchet/planning
```

If no planning PR is open, create it:

```
gh pr create --base main --head ratchet/planning \
  --title "Ratchet planning — pending issues" \
  --body "Plan files awaiting review. Merge to create the issues (plan-sync runs on merge to main)."
```

If one is already open, the push updated it — do not open a second.

## Step 4 — Report, then stop

Print a table of what you added (slug, title, priority, blocked_by) and the PR
link. Tell the user: review the planning PR and **merge when the batch is ready**
— merging fires `plan-sync` on `main` and creates the issues (a `priority:high`
item jumps to the front of the queue). Then stop.

## Hard rules

- Plan files only, on `ratchet/planning`. Never edit code/config/deps, never
  touch `main` directly, never create a branch other than `ratchet/planning`.
- Never implement or apply a fix, even if urgent or obvious. Knowing the fix is
  not permission to apply it — the agent that claims the resulting issue fixes
  it, on its own branch, through a reviewed PR.
- One always-open planning PR. Append if open; reset from main and open a new one
  only when none is open. Never open a second concurrent planning PR.
- Scan before create: never add a plan file for work an existing `plan/*.md`
  already covers (match by meaning, not wording) — update the existing file or
  report it as already tracked. Duplicate plan files become duplicate issues.
- Every file has testable `## Acceptance criteria`, or it lands `state:draft`.
- `blocked_by` references slugs (e.g. `0002-user-model`), never `#numbers`.
