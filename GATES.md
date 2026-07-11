<!--
GATES.md — the project config you hand-author (the memory/ files are the other
project-specific files, but those are agent-generated). It holds the verification
gates the agent runs before opening a PR. /ratchet-init fills this in by
detecting your stack; edit it freely. Ratchet updates never overwrite this file.

Rules: run in order, fail-fast (stop at the first failure). A gate with no
command for your project should read `TODO: <gate> command`, not a guess.

Recommended security gates (detected by /ratchet-init from real evidence, or
hand-authored here): `audit` runs the ecosystem's dependency-vulnerability
scanner — `npm audit` / `pnpm audit` / `yarn audit`, `pip-audit`, `cargo audit`,
or `govulncheck ./...`; `secret-scan` runs a committed secret scanner such as
`gitleaks detect --no-banner --redact`. Keep them evidence-based: no matching
ecosystem manifest → `TODO: audit command`; no committed scanner config →
`TODO: secret-scan command`. Never guess a security command from nothing.
-->

# Gates

Run in order, fail-fast. Replace the commands with your stack's equivalents
(or let `/ratchet-init` detect them).

<!-- auto-detected by /ratchet-init on 2026-07-08; verify before first run.
     This repo is the Ratchet framework itself: markdown + zero-dependency
     Node scripts, no package manifest — only the compiler test is evidenced.
     No lockfile/manifest → no dependency auditor; no committed gitleaks config
     → secret-scan stays TODO. Both are recorded, never guessed. -->

| Order | Gate        | Command                           | Pass condition |
|-------|-------------|-----------------------------------|----------------|
| 1     | format      | TODO: format command              | —              |
| 2     | typecheck   | TODO: typecheck command           | —              |
| 3     | lint        | TODO: lint command                | —              |
| 4a    | test: plan-sync                 | `node scripts/plan-sync.test.mjs`                 | exit 0 |
| 4b    | test: plan-sync-concurrency     | `node scripts/plan-sync-concurrency.test.mjs`     | exit 0 |
| 4c    | test: release                   | `node scripts/release.test.mjs`                   | exit 0 |
| 4d    | test: sweep-stale-claims        | `node scripts/sweep-stale-claims.test.mjs`        | exit 0 |
| 4e    | test: archive-closed-plans      | `node scripts/archive-closed-plans.test.mjs`      | exit 0 |
| 4f    | test: archive-closed-plans-workflow | `node scripts/archive-closed-plans-workflow.test.mjs` | exit 0 |
| 4g    | test: unblock-dependents        | `node scripts/unblock-dependents.test.mjs`        | exit 0 |
| 4g2   | test: review-verdict            | `node scripts/review-verdict.test.mjs`            | exit 0 |
| 4g3   | test: review-verdict-workflow   | `node scripts/review-verdict-workflow.test.mjs`   | exit 0 |
| 4g4   | test: conflicted-prs            | `node scripts/conflicted-prs.test.mjs`             | exit 0 |
| 4h    | test: ratchet-update            | `node scripts/ratchet-update.test.mjs`            | exit 0 |
| 4i    | test: criteria                  | `node scripts/criteria.test.mjs`                  | exit 0 |
| 4j    | test: pr-size-check             | `node scripts/pr-size-check.test.mjs`             | exit 0 |
| 4k    | test: run-gates                 | `node scripts/run-gates.test.mjs`                 | exit 0 |
| 4l    | test: sweep-lease               | `node scripts/sweep-lease.test.mjs`               | exit 0 |
| 4m    | test: verify-issue-body         | `node scripts/verify-issue-body.test.mjs`         | exit 0 |
| 4n    | test: ratchet-metrics           | `node scripts/ratchet-metrics.test.mjs`           | exit 0 |
| 4o    | test: docs-refresh              | `node scripts/docs-refresh.test.mjs`              | exit 0 |
| 4p    | test: ratchet-init-skill        | `node scripts/ratchet-init-skill.test.mjs`        | exit 0 |
| 4q    | test: gates-coverage            | `node scripts/gates-coverage.test.mjs`            | exit 0 |
| 4s    | test: herd                      | `node scripts/herd.test.mjs`                      | exit 0 |
| 4t    | test: herd-survey               | `node scripts/herd-survey.test.mjs`               | exit 0 |
| 4u    | test: herd-dispatch             | `node scripts/herd-dispatch.test.mjs`             | exit 0 |
| 4v    | test: herd-monitor              | `node scripts/herd-monitor.test.mjs`              | exit 0 |
| 4w    | test: herd-verify               | `node scripts/herd-verify.test.mjs`               | exit 0 |
| 4w1   | test: herd-review               | `node scripts/herd-review.test.mjs`               | exit 0 |
| 4w2   | test: herd-retention            | `node scripts/herd-retention.test.mjs`            | exit 0 |
| 4x    | test: skill-parity              | `node scripts/skill-parity.test.mjs`              | exit 0 |
| 4y    | test: herd-ui                   | `node scripts/herd-ui.test.mjs`                   | exit 0 |
| 4y2   | test: herd-avatar               | `node scripts/herd-avatar.test.mjs`               | exit 0 |
| 4y3   | test: herd-ui-log-search        | `node scripts/herd-ui-log-search.test.mjs`        | exit 0 |
| 4y4   | test: herd-ui-escalation        | `node scripts/herd-ui-escalation.test.mjs`        | exit 0 |
| 4y5   | test: herd-ui-acknowledge       | `node scripts/herd-ui-acknowledge.test.mjs`       | exit 0 |
| 4y6   | test: herd-ui-adapter-failures  | `node scripts/herd-ui-adapter-failures.test.mjs`  | exit 0 |
| 4y7   | test: herd-ui-summary-strip     | `node scripts/herd-ui-summary-strip.test.mjs`     | exit 0 |
| 4y8   | test: herd-notify               | `node scripts/herd-notify.test.mjs`               | exit 0 |
| 4z1   | test: state-label-exclusivity   | `node scripts/state-label-exclusivity.test.mjs`   | exit 0 |
| 4z2   | test: state-instructions-symmetry | `node scripts/state-instructions-symmetry.test.mjs` | exit 0 |
| 4z3   | test: version-consistency       | `node scripts/version-consistency.test.mjs`       | exit 0 |
| 4z5   | test: manifest-check            | `node scripts/manifest-check.test.mjs`            | exit 0 |
| 4z7   | test: bootstrap                 | `node scripts/bootstrap.test.mjs`                 | exit 0 |
| 4z8   | test: ratchet-uninstall         | `node scripts/ratchet-uninstall.test.mjs`         | exit 0 |
| 4z9   | test: install-lifecycle         | `node scripts/install-lifecycle.test.mjs`         | exit 0 |
| 4r    | test-coverage                   | `node scripts/gates-coverage.mjs`                 | exit 0 |
| 4z    | skill-parity                    | `node scripts/skill-parity.mjs`                   | exit 0 |
| 4z4   | version-consistency             | `node scripts/version-consistency.mjs`            | exit 0 |
| 4z6   | manifest-check                  | `node scripts/manifest-check.mjs`                 | exit 0 |
| 5     | build       | TODO: build command               | —              |
| 6     | audit       | TODO: audit command               | —              |
| 7     | secret-scan | TODO: secret-scan command         | —              |

Each `scripts/*.test.mjs` suite gets its own named `test:` row so `run-gates`
lists every suite it ran (coverage at a glance). The `test-coverage` gate
(`scripts/gates-coverage.mjs`) fails if a suite exists that no row above runs,
so a new suite can never be added without wiring it in here.

## PR size limit (agent PRs)

Enforced server-side by the `pr-gates` workflow (`scripts/pr-size-check.mjs`) on
every `agent/issue-*` PR — a PR over either threshold fails the check and the
red message repeats the split-and-requeue protocol from AGENTS.md step 3. Tune
the numbers here; they default to the manual's ~400 changed lines / ~6 files.

- max_changed_lines: 400
- max_changed_files: 6
- exclude_paths: [package-lock.json, pnpm-lock.yaml, yarn.lock, Cargo.lock, poetry.lock, go.sum, ratchet-manifest.json]

`exclude_paths` accepts comma-separated path patterns. The lockfiles above are
excluded by default even if this line is omitted; add generated artifacts here
when they should not count toward review-size limits.

Also excluded by default, alongside the lockfiles: the generated skill mirrors
`.claude/skills/**` and `plugin/skills/**`. Skills have one canonical source
under `.agents/skills/` (which still counts) and two mirrors regenerated by
`setup.sh`, so one real skill edit ships three changed files; excluding the
mirrors keeps the gate counting the single canonical change.

### Exclude-pattern matching rules

A pattern is matched against each changed file's full repo-relative path (the
whole path must match, not a prefix). These semantics are **not** gitignore's —
read them before writing a pattern:

- **`*` matches within a single path segment only — it never crosses a `/`.**
  So `*.min.js` matches `app.min.js` but **not** `dist/app.min.js`; write
  `**/*.min.js` (or `dist/**`) to reach nested files. Use `**` to cross
  directory separators.
- **A bare filename (no `/` and no `*`) matches that file at any depth.** So
  `Cargo.lock` matches both `Cargo.lock` and `crates/api/Cargo.lock` — this is
  why the default lockfile names catch nested lockfiles without a `**/` prefix.
- **A pattern containing `/` is anchored at the repo root.** So `docs/report.md`
  matches only the top-level file, and `generated/**` matches everything under a
  root-level `generated/` directory.
