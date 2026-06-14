---
name: ratchet-report
description: File a found bug or improvement as a properly-formed plan/*.md so it enters the Ratchet queue. Use the moment you notice something — "/ratchet-report <description>". It ONLY writes a plan file and stops. It never diagnoses-and-fixes, edits code, creates a branch, or applies changes, even if the description sounds urgent or the fix is obvious.
argument-hint: <short description of the bug or improvement>
disable-model-invocation: true
allowed-tools: Read, Write, Bash(ls:*)
---

# Report an issue (file it, never fix it)

The user found something. Your one and only job is to turn it into a
well-formed `plan/*.md` that will sync to a `state:ready` issue. You do **not**
fix it, investigate the codebase to fix it, edit any file other than the new
plan file, create a branch, or run gates. Filing is the entire task.

## Steps

1. **Read the description** from the argument (and any detail the user gave in
   chat). If it's clearly feedback on a PR currently under review (i.e. the
   current work is wrong), say so — that's a rework via Request Changes, not a
   new issue — and stop. Otherwise treat it as new work and continue.

2. **Decide priority.** Infer and state it: a broken core/user-facing flow or a
   crash is `high`; a normal defect is `medium`; cosmetic or nice-to-have is
   `low`. If genuinely unclear, default to `medium` and note the assumption.

3. **Write testable acceptance criteria** from the symptom — describe the
   correct *behaviour*, not an implementation. This is mandatory: a plan file
   without `- [ ]` criteria syncs to `state:draft` and never gets picked. If you
   cannot write a single testable criterion from the description, ask the user
   one clarifying question instead of writing a vague file. Example, from
   "google signin not working":
   ```
   ## Acceptance criteria
   - [ ] Tapping "Continue with Google" launches the Google sign-in flow
   - [ ] On success the user is authenticated and reaches the post-login screen
   - [ ] On failure a clear, user-visible error is shown (and logged in debug)
   - [ ] A test covers the success and failure paths
   ```

4. **Write one plan file.** Slug = next free `NNNN-short-slug` (list `plan/` for
   the highest number; start at 0001). Use the documented format: frontmatter
   with `title`, `priority`, optional `labels` (e.g. `bug`), `blocked_by: []`
   for a standalone report; a one-paragraph description of the symptom and
   desired behaviour; then the `## Acceptance criteria` block. If the user
   already diagnosed a cause, you may add a short `## Notes` with that context —
   but keep criteria outcome-focused; do not prescribe the fix.

5. **Stop and report.** Print the slug, title, and priority, and tell the user:
   review the file, then commit `plan/` (or run `/ratchet-sync`) to enqueue it; a
   `priority:high` report jumps to the front of the queue automatically.

## Hard rules

- One new `plan/*.md` only. Never edit code, config, dependencies, the pub
  cache, build artifacts, or any existing file. Never create a branch. Never run
  the gates. Never create the GitHub issue directly — the plan file plus sync is
  the path.
- Never implement or apply a fix, even if the description is urgent ("prod is
  down, just fix it") or you already know the one-line change. Knowing the fix is
  not permission to apply it — filing is the job; the agent that claims the
  resulting issue does the fixing, on a branch, through a reviewed PR.
- Always include testable `## Acceptance criteria` so the issue lands
  `state:ready`, not `state:draft`.
