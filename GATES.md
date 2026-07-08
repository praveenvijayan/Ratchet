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
| 4     | test        | `node scripts/plan-sync.test.mjs` | exit 0         |
| 4b    | test      | `node scripts/plan-sync-concurrency.test.mjs` | exit 0 |
| 4c    | test      | `node scripts/sweep-stale-claims.test.mjs` | exit 0 |
| 5     | build       | TODO: build command               | —              |
| 6     | audit       | TODO: audit command               | —              |
| 7     | secret-scan | TODO: secret-scan command         | —              |
