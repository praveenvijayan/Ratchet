---
name: ratchet-hotfix
description: The human-triggered hotfix/revert fast lane for production breakage. Runs only when a human says "hotfix" or "revert PR #M" — never self-invoked on suspicion. Reverts the causal merge with `git revert -m 1` on a fresh `hotfix/<slug>` branch off current main in a worktree (or a minimal forward fix only when revert cannot express the correction), runs the GATES.md gates, opens a PR titled `hotfix: <what broke>` naming the offending merge, then requires a follow-up root-cause plan file via /ratchet-plan. The one sanctioned exception to plan-first.
argument-hint: [the merged PR to revert, e.g. "revert PR #123", or what broke]
disable-model-invocation: true
allowed-tools: Read, Bash(ls:*), Bash(git:*), Bash(gh:*)
---

# Hotfix / revert fast lane (production breakage only)

The forward-only loop assumes there is time for a planning-PR round trip. A
production outage does not. This is the **one** sanctioned exception to the
plan-first rule (Hard Rule 0) — narrow, explicit, and still human-gated. This
skill carries the full procedure so the manual keeps only the trigger
prohibition and a route to it.

## 0. Trigger — explicit human, only

**The lane exists only on an explicit human trigger.** A human says "hotfix" or
"revert PR #M" (in chat, or via a watcher event pointed at that PR). An agent
that merely *suspects* a merge broke production **never** invokes this lane on
its own — it reports what it sees and waits for the human to pull the trigger.
**No self-invocation, ever.** This is the only case in which you may open a
branch and a PR without a `state:ready` issue behind it (the exception Hard
Rule 0 names). If you arrived here without an explicit human trigger, stop and
report instead.

## 1. What it skips, and what it keeps

It skips **only** the `plan/*.md` → planning-PR → sync round trip. It still ends
in a normal PR that a human reviews and merges, and it still runs the
`GATES.md` gates first. **The merge/review gate is never skipped — only the
planning detour is.** You never merge, never approve, never push to `main`.

## 2. Pick the mode by what stops the bleeding fastest and safest

- **Revert (default — prefer this).** When a specific merged PR is the cause and
  undoing it is clean, revert that merge on a fresh `hotfix/<slug>` branch off
  `main`: `git revert -m 1 <merge-sha>`. It is the fastest, lowest-risk path
  because it returns `main` to a known-good state. Use it **unless** a revert is
  impossible or would itself cause harm.
- **Forward hotfix.** When a revert would tear out unrelated good work that
  shipped in the same merge, or the fix is a small correction a revert cannot
  express, make the minimal targeted change on the same `hotfix/<slug>` branch
  instead. Keep it to the smallest change that ends the incident.

## 3. Steps

```
# main's current commit, read from the server (authoritative) — never branch
# from stale main.
git fetch origin
git pull --ff-only origin main
```

Then attach the branch **only as a dedicated worktree, never by switching the
shared clone off `main`** (the shared clone stays parked on `main` permanently):

```
git checkout -b hotfix/<slug>
git worktree add ../wt/hotfix-<slug> hotfix/<slug>
cd ../wt/hotfix-<slug>
```

Now make the change:
- **Revert** — find the causal merge SHA (`gh pr view <M> --json mergeCommit
  --jq .mergeCommit.oid`) and run `git revert -m 1 <merge-sha>`.
- **Forward fix** — make the minimal targeted change only.

Run the `GATES.md` gates (`scripts/run-gates.mjs`) fail-fast. Never open a PR
with red gates — an unpushed branch triggers no CI, so red work costs nothing.

Push the branch and open a PR titled `hotfix: <what broke>` whose body names the
offending merge (the PR number and its merge SHA) and states whether this is a
revert or a forward fix and why. Then **stop for human review**. You never merge.

## 4. Close the loop back into the normal system

Once the bleeding is stopped, the incident becomes a normal `plan/*.md` (via
`/ratchet-plan`) capturing the root cause with acceptance criteria. The hotfix
stops the symptom now; the plan file puts the durable fix back in the queue, to
be built, reviewed, and merged the ordinary way. **A hotfix with no follow-up
plan file is an unfinished hotfix.** Open that plan file (or hand the human the
draft to file) before considering the lane complete.

## Hard rules

- **Explicit human trigger only.** Suspicion alone means report and wait — the
  agent never self-invokes this lane, ever. This is Hard Rule 0's one exception.
- Skips only the planning round trip; the `GATES.md` gates and the human
  merge/review gate are never skipped.
- Prefer `git revert -m 1 <merge-sha>` of the causal merge on a fresh
  `hotfix/<slug>` branch off current `main`. Use a minimal forward fix only when
  revert cannot express the correction.
- Branch lives only in a `../wt/hotfix-<slug>` worktree; the shared clone never
  changes branches.
- Never open a PR with red gates; never push to `main`.
- The PR title is `hotfix: <what broke>` and names the offending merge. You
  never merge or approve.
- A hotfix with no follow-up root-cause plan file via `/ratchet-plan` is
  unfinished.
