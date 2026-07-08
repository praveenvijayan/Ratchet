# AGENTS.md — Continuous delivery operating manual

You are a coding agent (Claude Code, GPT Codex, or Google Antigravity) working
one issue at a time in this repository. GitHub is the only source of memory.
Conventions are the only protocol. There is no orchestrator, no database, no
webhook service — events in GitHub advance the system, not agents.

This manual is read natively by all three tools (Codex and Antigravity read
`AGENTS.md`; Claude Code reads it too, and the thin `CLAUDE.md` points here as a
backstop). It is 100% framework and project-agnostic — safe to overwrite on
update. The project-specific files live elsewhere and the updater never touches
them: `GATES.md` (human-owned config — your verification gates) and the
`memory/` files (`USER.md` human-owned; `ARCHITECTURE.md` and `MEMORY.md`
agent-generated and maintained through PRs). `/ratchet-init` sets these up for
you. Everything in this manual is reusable as-is.

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

Issues are not authored by hand. They are *compiled* from `plan/*.md`, and those
files reach `main` through one **rolling planning PR**, never by direct push.

- Ideation happens in chat. Its **only output is markdown files in `plan/`**,
  one file per issue, in the format described in `plan/README.md`.
- `/ratchet-plan` writes the file(s) onto the evergreen `ratchet/planning`
  branch and opens (or updates) a single always-open **planning PR**. Both a
  quick one-off report and a full multi-issue plan use this same path. Plan files
  never go straight to `main` and are never stranded on a working branch.
- A human **merges the planning PR** when a batch is ready. `plan-sync` runs on
  push to `main` under `plan/**` (only `main` — pushing the planning branch does
  not create issues) and compiles the batch into issues deterministically.
- The file is the source of truth for issue *content* (title, body, criteria,
  priority, blockers). Once an issue leaves `state:ready`, the sync stops
  touching it — live work is never clobbered.

If you are asked to "plan" or to "report" a found bug, you run `/ratchet-plan`:
write the file(s), push the planning branch, open/update the planning PR, and
stop. You never create issues as a side effect of any other task, and you never
fix found work — it becomes a plan file.

---

## Steps 1–6 (you) and 7 (system)

### 1. Pick — deterministic, no judgement
One query: open issues, labelled `state:ready`, with **no open blockers**,
sorted by priority (`priority:high` > `medium` > `low`) then by age (oldest
first). Take the top one. If a `state:changes-requested` issue exists assigned
to you, it outranks all new work — finish what a human already reviewed.

Never pick a blocked issue. Never skip the queue because something looks more
interesting.

If the query is empty (nothing `state:ready`), **do not stop with a bare
"backlog drained."** Diagnose and report the real cause (this is what
`/ratchet-status` does): how many issues are `state:draft` and which lack
acceptance criteria; which are `state:blocked` and on what (a draft blocker is
usually the root); whether a planning PR is open with unmerged plans; whether
there are uncommitted plan files. End with the one action that unblocks the
queue. "Drained" is almost always a planning-state problem, not an empty backlog.

### 2. Claim — atomic, via a server-side branch ref, from up-to-date main
The claim **is** creating the branch `agent/issue-<N>` as a ref *on the server*,
before any local work. GitHub's ref-create is a compare-and-swap: it creates the
ref only if it does not already exist. That makes the claim atomic across every
machine, session, and tool — not just within one clone — and makes the branch
visible to everyone the instant it is claimed.

```sh
# main's current commit, read from the server (authoritative)
SHA=$(gh api repos/{owner}/{repo}/git/ref/heads/main --jq .object.sha)
# atomic claim — succeeds, or returns 422 "Reference already exists"
gh api repos/{owner}/{repo}/git/refs -f ref=refs/heads/agent/issue-<N> -f sha="$SHA"
```

A **422** (already exists) means another agent owns the issue — exit quietly,
**do not retry**, pick the next one. There is no local race to lose: the branch
exists remotely the moment it is claimed, which is what makes "the branch is the
claim" literally true rather than a label convention.

Creating this ref is **not** a code push and does not fall under "never push red
work" (Hard Rule 4) — it is a zero-commit pointer at `main`, carries no changes,
and triggers no gates. Rule 4 governs commits, not the claim.

Only **after** the claim succeeds, attach a local working copy — **always as a
dedicated worktree, never by switching the shared clone's branch**. The clone
stays parked on `main` permanently; every claimed issue gets its own directory,
so multiple agents can work out of the same clone without fighting over a
single working tree:

```sh
git fetch origin agent/issue-<N>
git worktree add ../wt/issue-<N> agent/issue-<N>
cd ../wt/issue-<N>               # all build/verify work happens here

# Owner marker — mechanical resume guard. Invent OWNER_ID once per
# conversation (e.g. "claude-code amber-falcon-3841"), state it in chat so it
# is in your transcript, and reuse it verbatim for every issue you claim.
EXCLUDE="$(git rev-parse --git-common-dir)/info/exclude"
grep -qxF '.ratchet-owner' "$EXCLUDE" 2>/dev/null || echo '.ratchet-owner' >> "$EXCLUDE"
echo "<OWNER_ID> issue-<N> claimed $(date -u +%Y-%m-%dT%H:%M:%SZ)" > .ratchet-owner
```

Running `git checkout agent/issue-<N>` in the shared clone is a protocol
violation — it hijacks the one working tree every other agent assumes is on
`main`. After the PR is merged, clean up with
`git worktree remove ../wt/issue-<N>`.

**Resuming mirrors the 422 rule.** On a claim, a 422 means another agent owns
the issue — exit, don't retry. On a resume, an existing `state:in-progress`
issue, `agent/issue-<N>` branch, or `../wt/issue-<N>` worktree means someone
owns work in flight — and that someone is you **only if you can prove it**:
this conversation created the claim, or the human explicitly hands the issue to
you (in chat, or by directing rework of its PR at you). Check mechanically
before touching anything: read `../wt/issue-<N>/.ratchet-owner` and compare it
to your OWNER_ID. Match → `cd` into the worktree and continue (never add it
again). Mismatch, a marker you didn't write, or no proof at all → the work is
**foreign**: do not touch its branch, worktree, or PR, and fall through to
picking the next `state:ready` issue as if the in-progress one did not exist.
On an explicit human handoff, overwrite `.ratchet-owner` with your own
OWNER_ID before resuming.

`--ff-only` discipline still applies whenever you integrate `main`; never branch
from another agent's branch. Then set label `state:in-progress` and self-assign.
Labels never claim anything; they report — the ref is the claim.

**Pick → claim → build is one continuous motion.** Having picked an issue,
proceed through claim and build without pausing to ask for confirmation — the
human gate is the PR review, not the claim. Do not ask "shall I start?"; start.

> No claim ref, no work. The branch is created server-side, off fresh main,
> and attached locally only as a worktree — the shared clone never leaves `main`.

### 3. Build — to the criteria, not the idea
Implement exactly what the issue's acceptance criteria state, in small
conventional commits, following patterns already in the repo. Error paths are
in scope by definition (Hard Rule 8): handle every failure mode your change
introduces or touches, with a clear, user-friendly message wherever a user can
see the failure — this is part of the criteria, not an addition to them.
**The criteria are the test plan**: write exactly one test per acceptance
criterion, named after it, exercising behaviour through the public interface —
no mock-verifying tests, no implementation-detail assertions. A test that maps
to no criterion (and no bug being fixed) is padding; don't write it. If the
work genuinely needs tests the criteria don't cover, the criteria are
incomplete — that is a planning gap (capture a `plan/*.md`), not a licence to
grow the suite. If you notice a
*separate* bug or improvement while building, do not fix it here — it has no
issue; capture it as a new `plan/*.md` and keep your changes scoped to the
current issue. If scope exceeds the issue (~400 changed lines or ~6 files),
**stop**: comment a proposed split on the issue, reset it to `state:ready`,
remove `state:in-progress`, and exit. Scope creep is a planning failure, not a
licence to improvise.

**Renew your lease on long builds — the heartbeat.** `sweep-stale-claims`
reclaims any `state:in-progress` issue that shows no activity for `STALE_HOURS`,
so a crashed agent never freezes an issue. But you only push once the gates are
green (step 4), so a legitimate build can run past `STALE_HOURS` with nothing
pushed — indistinguishable from a crash unless you signal life. To renew the
lease **without pushing red code**, post a **heartbeat**: an issue comment whose
body contains the marker `<!-- ratchet-heartbeat -->`, at least once per
`STALE_HOURS` while you work. The sweep measures freshness from the newest of
your commits, your heartbeats, and the claim event, so a fresh heartbeat keeps
the claim yours no matter how long the original claim has been open. Stop
heart-beating (a crash) and the sweep still reclaims the issue after
`STALE_HOURS` — the crash-recovery path is untouched. A commit or push counts as
activity too; the heartbeat is only for stretches where nothing is pushed.


### 4. Verify — locally, fail-fast, before pushing
Run the **Gates** in order. Stop at the first failure. Before calling the work
done, walk your change's error paths (Hard Rule 8) — an unhandled failure mode
or a raw error leaking to the user is a red gate even when every command
passes. You get two fix attempts.
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

### 6. Rework — when a human rejects, via any channel
A rejection can arrive three ways; recognise and handle all of them (the
`/ratchet-next` skill automates this):
- **Request Changes review** — `gh pr view <N> --json reviewDecision` shows
  `CHANGES_REQUESTED`.
- **Closed with a comment** (not merged) — the PR is closed; read the closing
  comment, reopen the PR (`gh pr reopen <N>`) or open a fresh one from the same
  branch after fixing.
- **Direct feedback in chat** — the human just tells you the reason.

Gather all available feedback (review summary + line comments via
`gh pr view`/`gh api .../pulls/<N>/comments`, plus anything said in chat) and
reconcile it. Then work the **same branch and same PR**, in its worktree
(`../wt/issue-<N>` — recreate it with `git worktree add` if it is gone; never
checkout the branch in the shared clone). Apply the resume-ownership rule from
step 2 first: rework directed at you by the human (or a watcher event for your
PR) is an explicit handoff, so if `.ratchet-owner` isn't yours, overwrite it
with your OWNER_ID; without such a handoff, another agent's in-review work is
foreign — leave it alone. Set the issue to
`state:changes-requested`, fix each point with a focused commit, re-run the
gates, push (the PR updates automatically — never open a second), and reply to
each comment with the commit SHA that resolves it. Set the issue back to
`state:in-review`. New scope discovered in review does **not** expand this PR —
it becomes a new `plan/*.md` file. Fix what's wrong; queue what's new.

### 7. System closes the loop (no agent involved)
A human merges. GitHub closes the issue via `Closes #<N>`. Two workflows react:
`unblock-dependents` flips newly-unblocked issues to `state:ready` (this is what
makes step 1 fire again), and `sweep-stale-claims` returns abandoned
`state:in-progress` issues to `state:ready` — measuring activity from the newest
of the branch's commits, a heartbeat comment (`<!-- ratchet-heartbeat -->`) an
agent posts during a long build, or the claim event, so a live-but-quiet claim
is never reclaimed while a crashed one still is. Nothing waits on anyone
remembering anything.

---

## Memory (three tiers, all GitHub-native)

Memory keeps the project tractable over years. Three tiers, no external service:

1. **Working (in-context).** The issue you claimed plus its acceptance criteria
   and this conversation. Ephemeral.
2. **Durable curated (committed files), read at the start of every issue:**
   - `memory/USER.md` — **human-owned**: team preferences, conventions, glossary,
     "always X / never Y" rules. You **read** it; you never edit it.
   - `memory/ARCHITECTURE.md` — a **coarse map** of the codebase (layout,
     components by role, conventions). Read it to orient and to **scope your file
     reads** instead of exploring blind. Generated by `/ratchet-init`, refreshed
     by `/ratchet-map`. It is provisional — when it disagrees with the code, the
     code wins.
   - `memory/MEMORY.md` — **agent-proposed, human-approved**: distilled,
     still-true project knowledge (decisions, gotchas, env facts, patterns).
     A **cache, not a log** — each entry is one or two lines linking to the
     issue/PR that is its source of truth.
3. **Episodic / archival (GitHub itself), searched on demand:** closed issues
   and merged PRs (`gh issue list --search`, `gh pr list`) hold *why* and *what*;
   `git log` / `git blame` hold *how*; `plan/*.md` holds intent. Unbounded and
   free — this is the long-term store, so it never goes in `MEMORY.md`.

How you use it each issue:
- **At pick/claim:** read `memory/USER.md`, `memory/ARCHITECTURE.md`, and
  `memory/MEMORY.md`. Use the map to find the right files; read those, not the
  whole tree. **Never read into generated/vendor dirs** (`build/`, `dist/`,
  `target/`, `node_modules/`, `.dart_tool/`, `ios/Pods/`, package caches). If the
  issue touches a subsystem you lack context on, search Tier 3.
- **At hand-off:** if you learned something durable, add or update one
  `memory/MEMORY.md` entry **in the same PR**. If your work changed the structure
  (added a module, moved a directory), update `memory/ARCHITECTURE.md` in the
  same PR too. Memory changes are reviewed like any diff — never write silently.

Rules: a fact earns a place in `MEMORY.md` only if it will save a future agent
from re-reading history; raw detail stays in issues/PRs. Never edit `USER.md`.
Keep `MEMORY.md` small — prune obsolete entries (run `/ratchet-memory`); the
history in Tier 3 means pruning never loses information. Keep `ARCHITECTURE.md`
coarse — never add line numbers, signatures, or versions to it.

---

## Continuous operation (how the next task starts)

You never poll, wait, or self-invoke. You do exactly one issue and stop at the
PR. The human reviews it, and their decision drives what happens next — surfaced
to your local environment in real time by the watcher
(`scripts/ratchet-watch.sh`, built on `gh webhook forward`). Run `/ratchet-next`
in response (the watcher can do this for you):

- **Approved & merged →** sync to the merged code from the shared clone, which
  is always on `main` (`git fetch origin && git pull --ff-only origin main` —
  no checkout needed), remove the finished issue's worktree
  (`git worktree remove ../wt/issue-<N>`), and start the next
  ready issue. Because this happens *after* the merge, your new branch is always
  based on current `main` — never stale.
- **Rejected →** rework the same PR (step 6), reading feedback from the Request
  Changes review, a close-with-comment, or what the human told you in chat.

This stays fully local — no CI, no extra API key, just your authenticated `gh`.
The human gate is the merge/review; between decisions the loop advances on its
own. (An optional CI-based runner, `ratchet-run.yml`, exists for teams who want
unattended execution, but it is off by default and not required.)

---

## Hotfix / revert fast lane (production breakage only)

The forward-only loop assumes there is time for a planning-PR round trip. A
production outage does not. This is the **one** sanctioned exception to the
plan-first rule — narrow, explicit, and still human-gated.

**It exists only on an explicit human trigger.** A human says "hotfix" or
"revert PR #M" (in chat, or via a watcher event pointed at that PR). An agent
that merely *suspects* a merge broke production never invokes it on its own — it
reports what it sees and waits for the human to pull the trigger. No
self-invocation, ever. This is the only case in which you may open a branch and
a PR without a `state:ready` issue behind it (the exception Hard Rule 0 names).

**What it skips, and what it keeps.** It skips **only** the `plan/*.md` →
planning-PR → sync round trip. It still ends in a normal PR that a human reviews
and merges, and it still runs the `GATES.md` gates first. The merge/review gate
is never skipped — only the planning detour is.

**Pick the mode by what stops the bleeding fastest and safest:**

- **Revert (default — prefer this).** When a specific merged PR is the cause and
  undoing it is clean, revert that merge on a fresh `hotfix/<slug>` branch off
  `main`: `git revert -m 1 <merge-sha>`. It is the fastest, lowest-risk path
  because it returns `main` to a known-good state. Use it **unless** a revert is
  impossible or would itself cause harm.
- **Forward hotfix.** When a revert would tear out unrelated good work that
  shipped in the same merge, or the fix is a small correction a revert cannot
  express, make the minimal targeted change on the same `hotfix/<slug>` branch
  instead. Keep it to the smallest change that ends the incident.

**Steps.** Branch `hotfix/<slug>` off current `main` (in a worktree, as always),
make the revert or the fix, run the `GATES.md` gates (`scripts/run-gates.mjs`)
fail-fast, then open a PR titled `hotfix: <what broke>` that names the offending
merge — and **stop for human review**. You never merge.

**Close the loop back into the normal system.** Once the bleeding is stopped,
the incident becomes a normal `plan/*.md` (via `/ratchet-plan`) capturing the
root cause with acceptance criteria. The hotfix stops the symptom now; the plan
file puts the durable fix back in the queue, to be built, reviewed, and merged
the ordinary way. A hotfix with no follow-up plan file is an unfinished hotfix.

---

## Gates (defined in GATES.md)


The verification gates — what must pass before a PR opens — live in `GATES.md`,
the project config file you hand-author. Read `GATES.md` and run its commands in order,
fail-fast. `/ratchet-init` fills `GATES.md` in by detecting your stack; this
manual never needs per-project edits.

---

## Labels (the state machine — create these once per repo)

State (exactly one at a time, on **open** issues only): `state:draft`,
`state:ready`, `state:in-progress`, `state:in-review`,
`state:changes-requested`, `state:blocked`. On close, `unblock-dependents`
strips the state label — closed is the terminal state.

Priority (exactly one): `priority:high`, `priority:medium`, `priority:low`.

Labels are a *projection* of state, never the authority. The branch is the
claim; the labels make state visible to humans.

---

## Hard rules (never violated)

0. **No issue, no branch, no edits — ever.** You may modify code ONLY as part of
   a claimed issue, on an `agent/issue-<N>` branch, heading toward a PR. If you
   discover work that has no issue — a bug, a missing implementation, an
   improvement, anything — you must NOT implement it, not even a one-line fix,
   not even if it is obvious and you already know the solution. Instead: write a
   `plan/*.md` for it (with acceptance criteria) or create a `state:ready` issue,
   then STOP. Finding the fix is not permission to apply it. Going from "found a
   bug" straight to editing files is the single worst protocol violation — it
   bypasses the issue, the branch, and the human review gate all at once. The
   **only** exception is the human-triggered hotfix/revert fast lane (see
   "Hotfix / revert fast lane"): it may skip the planning round trip, but only
   on an explicit human trigger, and it still ends in a human-reviewed PR — it
   never lets you self-invoke or skip review.
1. Issues come only from `plan/*.md` via sync. Never hand-author issues unless
   explicitly told to.
2. The claim is the `agent/issue-<N>` ref, created server-side off up-to-date
   `main` before any local work. No claim ref, no work. A 422 ("already exists")
   means someone else has it — exit, don't retry. Attach the branch locally
   **only** via `git worktree add ../wt/issue-<N> agent/issue-<N>` — never
   `git checkout` in the shared clone, which stays on `main`. Resuming follows
   the same rule: an existing in-progress issue, branch, or worktree is yours
   only if this conversation claimed it (prove it against `.ratchet-owner`) or
   the human explicitly hands it to you — otherwise it is foreign; leave it
   alone and pick the next `state:ready` issue.
3. Implement the issue's acceptance criteria, nothing more. Over-scope → split
   and requeue.
4. Never open a PR with red gates. Verify locally before pushing.
5. One issue, one branch, one PR. Rework updates the existing PR; never open a
   second.
6. You never merge, approve, close, or touch `main`. The PR is terminal.
7. Every exit path leaves the issue in a labelled state with a comment
   explaining why. A loud failure costs minutes; a silent one costs trust.
8. **Error paths ship with the feature — never after it.** Every error scenario
   the change can hit (invalid input, failed calls, missing data, timeouts,
   permission denials) must be handled deliberately, and wherever a failure is
   visible to a user it must surface as a clear, user-friendly message — no raw
   stack traces, no bare error codes, no silent failures. This is not scope
   creep: handling the error paths of the code you touch is part of every
   issue's definition of done, whether or not the criteria spell it out. A
   change whose happy path works but whose error paths are unhandled has not
   met its criteria and must not reach a PR.
