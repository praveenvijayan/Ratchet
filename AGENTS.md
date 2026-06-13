# AGENTS.md — Continuous delivery operating manual

You are a coding agent (Claude Code, GPT Codex, or Google Antigravity) working
one issue at a time in this repository. GitHub is the only source of memory.
Conventions are the only protocol. There is no orchestrator, no database, no
webhook service — events in GitHub advance the system, not agents.

This manual is read natively by all three tools (Codex and Antigravity read
`AGENTS.md`; Claude Code reads it too, and the thin `CLAUDE.md` points here as a
backstop). It is project-agnostic. The only thing you edit per project is the
**Gates** table below — and `/factory-init` fills that in for you. Everything else is reusable as-is.

---

## The loop

```
plan/*.md  ──sync──▶  issues  ──▶  pick  ──▶  claim  ──▶  build  ──▶  verify  ──▶  PR  ──▶  human merge
                         ▲                                                                      │
                         └────────────── unblock dependents / close issue ◀────────────────────┘
```

Humans have exactly two jobs: **write good plan files** and **review PRs**.
Everything between is mechanical.

---

## Phase 0 — Plan (source of truth: `plan/*.md`)

Issues are not authored by hand. They are *compiled* from `plan/*.md`.

- Ideation happens in chat. Its **only output is markdown files in `plan/`**,
  one file per issue, in the format described in `plan/README.md`.
- On push to `plan/**`, the `plan-sync` workflow creates or updates issues
  deterministically. You do **not** create issues yourself unless explicitly
  asked; you let the sync do it.
- The file is the source of truth for issue *content* (title, body, criteria,
  priority, blockers). Once an issue leaves `state:ready`, the sync stops
  touching it — live work is never clobbered.

If you are asked to "plan" something, you write `plan/*.md` files and commit
them. You never create issues as a side effect of any other task.

---

## Steps 1–6 (you) and 7 (system)

### 1. Pick — deterministic, no judgement
One query: open issues, labelled `state:ready`, with **no open blockers**,
sorted by priority (`priority:high` > `medium` > `low`) then by age (oldest
first). Take the top one. If a `state:changes-requested` issue exists assigned
to you, it outranks all new work — finish what a human already reviewed.

Never pick a blocked issue. Never skip the queue because something looks more
interesting.

### 2. Claim — atomic, via branch creation
The claim **is** creating the branch `agent/issue-<N>`. Branch creation
succeeds or fails atomically. If it fails, another agent owns the issue — exit
quietly. After the branch exists, set label `state:in-progress` and self-assign.
Labels never claim anything; they only report.

> No branch, no work.

### 3. Build — to the criteria, not the idea
Implement exactly what the issue's acceptance criteria state, in small
conventional commits, following patterns already in the repo. If scope exceeds
the issue (~400 changed lines or ~6 files), **stop**: comment a proposed split
on the issue, reset it to `state:ready`, remove `state:in-progress`, and exit.
Scope creep is a planning failure, not a licence to improvise.

### 4. Verify — locally, fail-fast, before pushing
Run the **Gates** in order. Stop at the first failure. You get two fix attempts.
If still red, comment the gate name + error excerpt on the issue, reset to
`state:ready`, remove `state:in-progress`, and exit. Only push the branch after
all gates pass — an unpushed branch triggers no CI, so red work costs nothing.

> Never open a PR with red checks. Human attention is the bottleneck resource.

### 5. Hand off — one PR, then stop
Push, then open a PR whose **first line is `Closes #<N>`**, followed by a summary
and the gate checklist with real results. If an open PR already exists for
`agent/issue-<N>`, update it — never open a second. Set the issue to
`state:in-review`. Then **full stop**: no polling, no self-review, no nudging.

> You never merge, never approve, never close issues, never push to `main`.
> The PR is your terminal action.

### 6. Rework — only when a human requests changes
When a PR gets a "Request changes" review, the issue flips to
`state:changes-requested` and you are re-invoked. Work the **same branch and
same PR**: read every review comment, fix each with a focused commit, re-run all
gates, and reply to each comment with the commit SHA that addresses it. New
scope discovered in review does **not** expand this PR — it becomes a new
`plan/*.md` file. Merge what is correct; queue what is new.

### 7. System closes the loop (no agent involved)
A human merges. GitHub closes the issue via `Closes #<N>`. Two workflows react:
`unblock-dependents` flips newly-unblocked issues to `state:ready` (this is what
makes step 1 fire again), and `sweep-stale-claims` returns abandoned
`state:in-progress` issues to `state:ready`. Nothing waits on anyone
remembering anything.

---

## Gates (EDIT THIS TABLE PER PROJECT — the only project-specific part)

Run in order, fail-fast. Replace the commands with your stack's equivalents.

| Order | Gate      | Command              | Pass condition       |
|-------|-----------|----------------------|----------------------|
| 1     | format    | `npm run format:check` | no diff            |
| 2     | typecheck | `npm run typecheck`  | exit 0               |
| 3     | lint      | `npm run lint`       | exit 0               |
| 4     | test      | `npm test`           | exit 0               |
| 5     | build     | `npm run build`      | exit 0               |

---

## Labels (the state machine — create these once per repo)

State (exactly one at a time): `state:draft`, `state:ready`,
`state:in-progress`, `state:in-review`, `state:changes-requested`,
`state:blocked`.

Priority (exactly one): `priority:high`, `priority:medium`, `priority:low`.

Labels are a *projection* of state, never the authority. The branch is the
claim; the labels make state visible to humans.

---

## Hard rules (never violated)

1. Issues come only from `plan/*.md` via sync. Never hand-author issues unless
   explicitly told to.
2. The claim is the branch. No branch, no work. Branch-creation failure means
   "someone else has it" — exit, don't retry.
3. Implement the issue's acceptance criteria, nothing more. Over-scope → split
   and requeue.
4. Never open a PR with red gates. Verify locally before pushing.
5. One issue, one branch, one PR. Rework updates the existing PR; never open a
   second.
6. You never merge, approve, close, or touch `main`. The PR is terminal.
7. Every exit path leaves the issue in a labelled state with a comment
   explaining why. A loud failure costs minutes; a silent one costs trust.
