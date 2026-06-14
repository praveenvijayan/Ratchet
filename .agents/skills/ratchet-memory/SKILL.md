---
name: ratchet-memory
description: Curate memory/MEMORY.md — merge duplicate entries, prune obsolete ones, and verify that each entry's linked issue/PR still resolves. Use periodically (e.g. quarterly) or when MEMORY.md grows past ~300 lines. Edits the file and stops for human review; never commits.
disable-model-invocation: true
allowed-tools: Read, Edit, Bash(gh:*)
---

# Memory compaction

Keep `memory/MEMORY.md` a small, current cache. Raw history lives in closed
issues/PRs/git, so pruning here never loses information.

## Steps

1. **Read** `memory/MEMORY.md`. (Do not touch `memory/USER.md` — it is
   human-owned.)

2. **Verify links.** For each entry citing `#N` or `PR #N`, check it resolves
   with `gh issue view N` / `gh pr view N`. Flag dead or wrong references; do not
   delete the entry just because a link is stale — surface it for the human.

3. **Merge duplicates.** Combine entries that say the same thing into one,
   keeping the clearest wording and all distinct source links.

4. **Prune the obsolete.** Remove entries that are no longer true (superseded
   decisions, fixed gotchas, retired environment facts). When you are *unsure*
   whether something is still true, KEEP it and add a `(verify?)` marker rather
   than guessing it away.

5. **Tighten.** Each surviving entry should be 1–2 lines and cite its source.
   Keep the area groupings. If the file is still very large after pruning,
   suggest splitting by area in your report (do not split automatically).

6. **Report, then stop.** Summarise: entries kept / merged / pruned / flagged
   (dead links or `verify?`). Do **not** commit or push — leave the diff for the
   human to review, exactly like any other memory change.

## Hard rules

- Never edit `memory/USER.md`.
- Never delete an entry whose truth is uncertain — flag it instead.
- Never commit or push; compaction is reviewed like any other PR.
- Pruning removes cache entries only; the underlying facts remain in the issues,
  PRs, and commits the entries pointed to.
