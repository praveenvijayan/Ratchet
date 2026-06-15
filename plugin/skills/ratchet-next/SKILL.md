---
name: ratchet-next
description: After a human acts on a PR, do the right next thing — locally, no CI, no API key. If the PR was approved and merged, sync main and start the next ready issue. If it was rejected (Request Changes, closed with a comment, or new review comments) or the human gave feedback in chat, rework the same branch and PR. Use after a merge or review, or when the local watcher signals an event.
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Bash(git:*), Bash(gh:*)
---

# Ratchet next

Decide what happened to the work in flight and act on it, against the live repo.

## 1. Find the trigger

- If `.ratchet/last-event.json` exists (written by `ratchet-watch`), read it for
  the PR number and action (`advance` / `rework` / `note`).
- Otherwise locate the work in flight: the open PR whose head is
  `agent/issue-<N>`, or the issue labelled `state:in-progress`.
- Also use any feedback the human gave you directly in this chat.

## 2A. Advance — PR approved & merged

1. Sync to the merged code (never branch from stale main):
   `git checkout main && git fetch origin && git pull --ff-only origin main`
2. Run the normal loop from AGENTS.md step 1 onward: pick the top ready,
   unblocked issue (priority then age), claim it (branch from this fresh main),
   build to the acceptance criteria, run the gates in `GATES.md`, open a PR with
   `Closes #<N>`, then stop. Pick → claim → build is continuous; don't ask first.
3. If no issue is `state:ready`, **do not just say "drained" and stop.**
   Diagnose why (run the `/ratchet-status` checks): count states, find
   `state:draft` issues missing acceptance criteria, trace `state:blocked`
   chains to their root, and check for an open planning PR or uncommitted plan
   files. Report the specific cause and the single next action to unblock — then
   stop.

## 2B. Rework — PR rejected, or direct feedback

Recognise all three rejection channels:
- **Request Changes** → `gh pr view <N> --json reviewDecision` is `CHANGES_REQUESTED`.
- **Closed with a comment** (not merged) → read the closing comment; reopen with
  `gh pr reopen <N>` if the branch exists, or open a fresh PR after fixing.
- **Direct chat feedback** → use what the human told you.

Then:
1. Gather all feedback and reconcile it: review summary + line comments
   (`gh pr view <N> --json reviews,comments`; threads via
   `gh api repos/{owner}/{repo}/pulls/<N>/comments`) plus the chat message.
2. `git checkout agent/issue-<N> && git pull`. Set the issue to
   `state:changes-requested`.
3. Fix each point with a focused commit. Re-run the `GATES.md` gates, fail-fast;
   never push red.
4. Push — the existing PR updates (never open a second). Reply to each review
   comment with the commit SHA that resolves it.
5. Set the issue back to `state:in-review` and stop for re-review.

## Hard rules

- Advance always re-syncs `main` first, `--ff-only`.
- Rework stays on the same branch and PR; never duplicate.
- You never merge or approve — the human's merge/review is the only gate.
- One issue at a time, then stop. The next trigger is the next human decision.
