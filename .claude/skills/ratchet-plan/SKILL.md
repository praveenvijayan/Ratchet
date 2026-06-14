---
name: ratchet-plan
description: Convert the solidified idea from the current conversation into plan/*.md issue files, following the contract in plan/README.md. Use after ideation is complete and the user wants to generate the project issue files. Creates files only — never creates GitHub issues directly (the plan-sync workflow does that on push) and never commits.
argument-hint: [optional feature or scope to limit which part of the idea to plan]
disable-model-invocation: true
allowed-tools: Read, Write, Bash(ls:*)
---

# Plan → issue files

Turn the idea discussed in this conversation into one markdown file per issue
under `plan/`, ready for the `plan-sync` workflow to compile into GitHub issues.

## Format contract

Read `plan/README.md` first — it is the authoritative format. Follow it exactly.
List the existing files in `plan/` to find the highest current number.

## Steps

1. **Scope.** If an argument is given, plan only that feature/area; otherwise
   plan the whole idea as discussed. If the idea is still vague, STOP and ask the
   user to firm it up — never invent scope to fill gaps.

2. **Decompose.** Break the idea into the smallest units where one PR closes one
   issue (about half a day each). Prefer many small issues over a few large ones.
   For each unit decide: title, priority (high/medium/low), dependencies, and
   testable acceptance criteria.

3. **Order & number.** Sort units so dependencies come before dependents. Assign
   sequential slugs `NNNN-short-slug`, continuing from the highest existing
   number in `plan/` (start at 0001 if empty). The slug is the issue's permanent
   identity — choose it well; never plan to rename it later.

4. **Write files.** Create `plan/NNNN-slug.md` for each unit in the documented
   format. Express dependencies in `blocked_by` using the **slugs** of the files
   you just created — never issue numbers. Every issue gets at least one
   `- [ ]` acceptance criterion, or it is not ready.

5. **Self-check.** Verify: every file has `title` + `priority`; every
   `blocked_by` slug matches a real file; no dependency cycles; each acceptance
   criterion is a testable sentence, not a restatement of the title.

6. **Report, then stop.** Print a table of what you created — slug, title,
   priority, blocked_by — plus the dependency order. Do NOT commit, push, or
   create issues. Tell the user to review the files and commit `plan/`, which is
   what triggers `plan-sync`.

## Hard rules

- Files only. Never create GitHub issues here; never commit or push.
- One file = one issue = one PR's worth of work.
- No testable acceptance criteria → the issue is not ready. Refine instead.
- `blocked_by` references slugs (e.g. `0002-user-model`), never `#numbers`.
