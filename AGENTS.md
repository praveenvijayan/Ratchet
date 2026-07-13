# AGENTS.md — Continuous-delivery safety kernel

You are a coding agent (Claude Code, GPT Codex, Google Antigravity) working one
issue at a time. GitHub is the only memory; conventions are the only protocol;
there is no orchestrator — events in GitHub advance the system. This file is
**always loaded**: it carries every invariant you must know *before* deciding
what to load next. **Defer procedures and explanations** to the skills, scripts,
`DOCS.md`, and `plan/README.md` named in the routing table; **never defer
authority, ownership, scope, or safety.** When a concern below routes to a file,
read that file before acting.

`AGENTS.md` is framework- and project-agnostic (safe to overwrite on update).
Project config lives outside it and the updater never touches it: `GATES.md`
(your gates) and `memory/` (`USER.md` human-owned; `ARCHITECTURE.md` and
`MEMORY.md` agent-maintained through PRs).

## The loop
`plan/*.md → sync → issues → pick → claim → build → verify → PR → human merge →
unblock dependents`. Humans do two things: **write plan files** and **review
PRs**. Everything between is mechanical.

## Routing table — read the file, don't guess
Every deferred concern routes to a file path, not a skill invocation. Read it.

| Concern | Read this file |
|---|---|
| Orient before exploring the codebase (read first, if present) | `MAP.md` |
| Plan or report a bug/idea (→ `plan/*.md` + planning PR) | `.agents/skills/ratchet-plan/SKILL.md` |
| Plan-file format & criteria rules | `plan/README.md` |
| Advance or rework after a human decision | `.agents/skills/ratchet-next/SKILL.md` |
| Queue looks empty — diagnose why | `.agents/skills/ratchet-status/SKILL.md` |
| Production breakage (hotfix / revert) | `.agents/skills/ratchet-hotfix/SKILL.md` |
| Refresh the architecture map | `.agents/skills/ratchet-map/SKILL.md` |
| Prune curated memory | `.agents/skills/ratchet-memory/SKILL.md` |
| Verification gates (commands, order) | `GATES.md` |
| System internals, workflows, herd | `DOCS.md` |
| Curated memory (read every issue) | `memory/USER.md`, `memory/MEMORY.md`, `memory/ARCHITECTURE.md` |

## Deterministic commands — one command, not a recipe
The fragile multi-step procedures are scripts. Run the command and act on its
exit code; each prints one JSON line to stdout.

- **Claim** — `node scripts/ratchet-start.mjs --issue <N> --owner "<id>"` — exit
  `0` claimed/resumed · `2` invalid args · `3` foreign (ref exists — another
  owner) · `4` unsafe (worktree owner mismatch) · `1` API/other failure.
- **Requeue** — `node scripts/ratchet-requeue.mjs --issue <N> --reason "<text>"`
  — exit `0` success · `2` invalid args · `1` API failure.
- **Heartbeat** — `node scripts/ratchet-heartbeat.mjs --issue <N>` — exit `0`
  success · `2` invalid args · `1` API failure.
- **Hand off** — `node scripts/ratchet-submit.mjs --issue <N> --body-file <path>`
  — exit `0` success/idempotent · `2` invalid args or bad body · `4` not
  integrated / would conflict · `5` red gate · `1` API/other failure.

## Steps

### 1. Pick — deterministic, no judgement
Open issues labelled `state:ready` with **no open blockers**, sorted by priority
(`priority:high` > `medium` > `low`) then oldest first; take the top one. A
`state:changes-requested` issue assigned to you outranks all new work. Never pick
a blocked issue or jump the queue. If nothing is `state:ready`, do **not** report
"drained" — route to `.agents/skills/ratchet-status/SKILL.md` and diagnose the
real cause (drafts missing criteria, a blocked chain's root, an open planning
PR).

### 2. Claim — server-side ref off fresh `main`, before any local work
The claim **is** creating the `agent/issue-<N>` ref on the server — an atomic
compare-and-swap off current `main`, before any local mutation. Run
`ratchet-start.mjs` (above): it claims, attaches the branch **as a worktree
only** while the shared clone stays parked on `main`, writes the `.ratchet-owner`
marker, flips labels, and self-assigns. Exit `3` (foreign) means another agent
owns it — stop, don't retry, pick the next. Integrate `main` only with
`--ff-only`; never branch off another agent's branch.

**Ownership / resume.** An existing in-progress issue, branch, or worktree is
yours **only if you can prove it**: this conversation claimed it, or a human
explicitly hands it to you (chat, rework aimed at its PR, or a `ratchet-herd`
supervisor dispatch). Proof is the `.ratchet-owner` marker matching your
OWNER_ID — invent one per conversation, state it in chat, reuse it verbatim. No
match, or no proof, → the work is **foreign**: never touch its branch, worktree,
or PR; pick the next `state:ready` issue instead. On an explicit handoff,
overwrite `.ratchet-owner` with your OWNER_ID. **Pick → claim → build is one
motion — don't ask "shall I start?"; start.**

### 3. Build — to the criteria, nothing more
Implement exactly the acceptance criteria, in small conventional commits,
following repo patterns. **The criteria are the test plan:** exactly one test per
criterion, named after it, exercised through the public interface — no
mock-verifying tests, no implementation-detail assertions. Write **also**
whatever an optional `## Test notes` or `## Non-functional` section in the plan
asks for, each named after its requirement; a test that maps to none of these is
padding — don't write it, and genuinely-missing coverage is a planning gap (a new
`plan/*.md`), not a bigger suite. A separate bug you notice becomes a new
`plan/*.md`, never an in-scope fix. **Over-scope (~400 changed lines or ~6
files) → stop:** requeue with `ratchet-requeue.mjs` and comment a proposed split.
On long builds, renew your lease **without pushing** code via
`ratchet-heartbeat.mjs`, so `sweep-stale-claims` keeps the claim yours while a
legitimate build runs past `STALE_HOURS` with nothing pushed.

### 4. Verify — locally, fail-fast, before pushing
Run the `GATES.md` gates in order; stop at the first failure. Walk your change's
**error paths** — an unhandled failure mode, or a raw error reaching a user, is a
red gate even when every command passes. You get two fix attempts, then requeue
with the gate name and error excerpt. An unpushed branch triggers no CI, so red
work costs nothing. After push, the `pr-gates` workflow backstops the handoff:
its `gates` job runs `scripts/run-gates.mjs` and its `size` job runs
`scripts/pr-size-check.mjs`.

### 5. Hand off — one PR, then stop
Hand off with `ratchet-submit.mjs` (above): it integrates `main`, runs the gates
fail-fast, refuses red or conflicted work, pushes, keeps a single PR whose first
line is `Closes #<N>`, and flips labels. Before that flip,
**bring the latest `main` into your branch and resolve any conflicts**, then
re-run the gates — because
**a PR with merge conflicts gets no event-driven CI at all**: GitHub cannot build
the merge ref, so `pr-gates` **and** `review-verdict` are silently *skipped* (not
failed), no checks run, no review can flip a label, and the work is
**not reviewable**. Only current, conflict-free, green work is review-ready.
Set the issue to `state:in-review` and remove `state:in-progress`. Then **full
stop** — no polling, no self-review, no nudging.

### 6. Rework — when a human rejects (review, close-with-comment, or chat)
Route to `.agents/skills/ratchet-next/SKILL.md`. Work the **same branch and PR**
in its worktree; apply the ownership rule first — a rework request aimed at you
is a handoff, so overwrite `.ratchet-owner` if it isn't yours; otherwise it is
foreign, leave it alone. Set the issue to `state:changes-requested` and remove
`state:in-review`; fix each point in a focused commit; re-run the gates; push
(the PR updates — never open a second); reply to each comment with the resolving
commit SHA. Then set the issue back to `state:in-review` and remove
`state:changes-requested`. New scope discovered in review becomes a new
`plan/*.md`, never this PR.

### 7. System closes the loop (no agent involved)
A human merges; `Closes #<N>` closes the issue. `unblock-dependents` flips
newly-unblocked issues to `state:ready`; `sweep-stale-claims` returns abandoned
work across `state:in-progress`, `state:in-review`, and `state:changes-requested`,
measuring freshness from the newest of a commit, a heartbeat
(`<!-- ratchet-heartbeat -->`), or the claim event.

## Labels — the state machine (create once per repo)
Exactly one **state** on an open issue: `state:draft`, `state:ready`,
`state:in-progress`, `state:in-review`, `state:changes-requested`,
`state:blocked`; closing strips it. Exactly one **priority**: `priority:high`,
`priority:medium`, `priority:low`. Labels are a projection of state — the branch
ref is the claim, not the label.

## Memory (three tiers, GitHub-native)
At the start of every issue read `memory/USER.md` (human-owned — **you never edit
it**), `memory/ARCHITECTURE.md` (a coarse map; when it disagrees with the code,
the code wins), and `memory/MEMORY.md` (curated, human-approved cache). Use the
map to scope your reads and **never read generated/vendor dirs**. At hand-off,
add or update at most one `MEMORY.md` entry — and `ARCHITECTURE.md` if the
structure changed — **in the same PR**, never silently. Deep history (closed
issues, merged PRs, `git log`, `plan/*.md`) is the archival tier; search it on
demand. Details: `DOCS.md`.

## Hotfix / revert (production breakage only)
The **one** exception to plan-first, and only on an **explicit human trigger**
("hotfix" / "revert PR #M"). Suspicion alone → report and wait; **never
self-invoke**. It skips only the planning round trip — it still runs the
`GATES.md` gates and still ends in a human-reviewed PR. Full procedure:
`.agents/skills/ratchet-hotfix/SKILL.md`.

## Hard rules (never violated)
0. <!-- ratchet:invariant:no-issue-no-edits --> **No issue, no branch, no
   edits.** Modify code only under a claimed issue, on an `agent/issue-<N>`
   branch, heading to a PR. Discovered work — any size, however obvious —
   becomes a `plan/*.md`, then you STOP; finding a fix is not permission to apply
   it. Only exception: the human-triggered hotfix lane, which still ends in a
   reviewed PR.
1. <!-- ratchet:invariant:plan-source --> Issues come only from `plan/*.md` via
   sync; never hand-author issues unless explicitly told to.
2. <!-- ratchet:invariant:claim-ref --> The claim is the `agent/issue-<N>` ref,
   created server-side off fresh `main` before any local work; no ref, no work.
   Foreign (ref exists, or owner mismatch) → exit, don't retry. Attach only as a
   worktree; the shared clone never changes branches. Resume only work you can
   prove is yours against `.ratchet-owner`.
3. <!-- ratchet:invariant:criteria-only --> Implement the acceptance criteria,
   nothing more. Over-scope → split and requeue.
4. <!-- ratchet:invariant:never-red-pr --> Never open a PR with red gates; verify
   locally before pushing.
5. <!-- ratchet:invariant:one-pr --> One issue, one branch, one PR. Rework
   updates the existing PR; never open a second.
6. <!-- ratchet:invariant:never-merge --> You never merge, approve, close, or
   touch `main`. The PR is your terminal action.
7. <!-- ratchet:invariant:labelled-exit --> Every exit path leaves the issue in a
   labelled state with a comment explaining why.
8. <!-- ratchet:invariant:error-paths --> **Error paths ship with the feature.**
   Every failure mode you touch is handled deliberately; anything a user can see
   surfaces as a clear message, never a raw trace or bare code. Unhandled error
   paths mean the criteria are not met.
