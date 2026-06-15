---
name: ratchet-status
description: Diagnose the queue and explain why work is or isn't flowing, especially when nothing is state:ready (a "backlog drained" report). Read-only — counts issues by state, finds drafts missing acceptance criteria, traces blocked chains to their root, flags an unmerged planning PR or uncommitted plan files, and recommends the single next action to unblock. Never changes anything.
disable-model-invocation: true
allowed-tools: Read, Bash(gh:*), Bash(git:*)
---

# Ratchet status — why is nothing ready?

A **read-only** diagnosis. Never create, edit, label, branch, or commit — only
report. The goal: turn "backlog drained" into a specific, actionable picture.

## Steps

1. **Count open issues by state.**
   `gh issue list --state open --limit 200 --json number,title,labels` and
   tally `state:ready / in-progress / in-review / changes-requested / blocked /
   draft`.

2. **If there is pickable work** (`state:ready` or `state:changes-requested`),
   say so and stop — the queue is fine; the agent should just pick (run
   `/ratchet-next`). No further diagnosis needed.

3. **If nothing is pickable, find the cause(s):**
   - **Drafts** — list `state:draft` issues. They lack testable acceptance
     criteria (`- [ ]`), so they are unpickable by design. For each, name the
     `plan/*.md` slug that produced it (or the issue) that needs criteria added.
   - **Blocked chains** — for each `state:blocked` issue, read `Blocked by #N`
     and check whether the blockers are open. If a blocker is itself a draft,
     that draft is the **root** freezing the chain — call it out.
   - **In-flight** — note any `state:in-progress` (claimed; maybe abandoned →
     `sweep-stale-claims` will requeue) or `state:in-review` (waiting on a human
     to merge/review — the loop advances when they do).
   - **Unmerged plans** — `gh pr list --head ratchet/planning --state open`. If a
     planning PR is open, its plan files have NOT become issues yet — merging it
     creates them.
   - **Uncommitted plans** — `git status --short plan/`. Untracked/modified
     plan files aren't on the planning PR yet; `/ratchet-plan` will place them.

4. **Recommend the single best next action**, e.g.:
   - "Merge planning PR #52 → creates 3 issues, then `/ratchet-next`."
   - "Issues #18–#22 are draft (no criteria). Add `- [ ]` criteria to their plan
     files and re-plan, or they'll never be picked."
   - "All open issues are blocked on #18 (a draft). Fix #18 first; the chain
     unblocks itself on merge."
   - "Queue genuinely empty — plan new work with `/ratchet-plan`."

## Hard rules

- Read-only. Never change labels, issues, files, branches, or anything else.
- Always end with the one most useful next action, not just a state dump.
