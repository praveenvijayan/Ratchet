---
name: factory-init
description: One-time setup for a repo adopting the factory. Creates the state:* and priority:* labels, detects the project's stack and fills the Gates table in AGENTS.md, and ensures the Personal Access Token the issue-flow automation depends on is configured (informs the user; never handles the token itself). Idempotent — safe to re-run.
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Glob, Grep, Bash(gh:*)
---

# Factory init (one-time per repo)

Three jobs: create the state machine's labels, make `AGENTS.md` match this
project's stack, and ensure the PAT the issue flow depends on is in place.

## Preflight

Run `gh auth status` and `gh repo view --json nameWithOwner`. If `gh` is not
authenticated or this is not a GitHub repo, STOP and tell the user how to fix it.

## Step 1 — Create labels

`--force` makes this idempotent (creates, or updates colour/description).

```
gh label create "state:draft"             --color "ededed" --description "Synced but not ready (no acceptance criteria)" --force
gh label create "state:ready"             --color "0e8a16" --description "Unblocked and pickable by an agent" --force
gh label create "state:in-progress"       --color "fbca04" --description "Claimed; agent/issue-<N> branch exists" --force
gh label create "state:in-review"         --color "1d76db" --description "PR open, awaiting human review" --force
gh label create "state:changes-requested" --color "d93f0b" --description "Human requested changes; agent reworking" --force
gh label create "state:blocked"           --color "b60205" --description "Has an open blocker; not pickable" --force
gh label create "priority:high"           --color "5319e7" --description "Pick before medium/low" --force
gh label create "priority:medium"         --color "8a63d2" --description "Default priority" --force
gh label create "priority:low"            --color "c5b3f0" --description "Pick last" --force
```

## Step 2 — Detect the stack and fill the Gates table

**Does code exist?** Look for a manifest (`package.json`, `pyproject.toml`,
`requirements.txt`, `Cargo.toml`, `go.mod`, `Makefile`, etc.). If none, this is
greenfield: leave the default Gates table, note that the user should re-run
`/factory-init` once code lands, and skip to Step 3.

If code exists, detect commands **from real evidence only**:

1. **Package manager / build tool** — for Node the lockfile decides:
   `pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn, `bun.lockb`→bun,
   `package-lock.json`→npm; else the `packageManager` field; else npm.
2. **Per gate, find the real command.** Prefer scripts/targets the project
   already defines (`package.json` scripts, `Makefile` targets, `pyproject.toml`
   `[tool.*]`). Fall back to a direct tool invocation only when that tool's
   config file is present.

   | Ecosystem | Evidence | format | typecheck | lint | test | build |
   |-----------|----------|--------|-----------|------|------|-------|
   | Node/TS | `package.json` (+lockfile) | `<pm> run format:check` / `prettier --check .` | `<pm> run typecheck` / `tsc --noEmit` | `<pm> run lint` / `eslint .` | `<pm> test` | `<pm> run build` |
   | Python | `pyproject.toml` / `requirements.txt` | `ruff format --check .` / `black --check .` | `mypy .` / `pyright` | `ruff check .` / `flake8` | `pytest` | `python -m build` |
   | Rust | `Cargo.toml` | `cargo fmt --check` | `cargo check` | `cargo clippy -- -D warnings` | `cargo test` | `cargo build --release` |
   | Go | `go.mod` | `gofmt -l .` | `go vet ./...` | `golangci-lint run` | `go test ./...` | `go build ./...` |
   | Make present | `Makefile` targets | `make format` | — | `make lint` | `make test` | `make build` |

   Commands to **recognise**, not invent. If a gate has no matching
   script/config, or the script is a stub, write `TODO: <gate> command` instead
   of guessing.
3. **Edit `AGENTS.md`** — replace the body rows of the Gates table with the
   detected commands, keeping the columns. Add one comment above it:
   `<!-- auto-detected by /factory-init on <date>; verify before first run -->`.
4. **Never run a gate.** Detection only.

## Step 3 — Scaffold the memory files

Ensure the durable-memory files exist (create from the kit templates if absent;
never overwrite existing ones):
- `memory/USER.md` — human-owned preferences/conventions.
- `memory/MEMORY.md` — agent-proposed, human-approved distilled knowledge.

If you created them fresh, tell the user to seed `memory/USER.md` with the
team's conventions. Do not populate `MEMORY.md` — it fills up through PRs over
time. Both files are committed (not gitignored); they are the project's memory.

## Step 4 — Personal Access Token (CRITICAL for the issue flow)

The issue lifecycle relies on workflows reacting to each other's events.
GitHub's default `GITHUB_TOKEN` **does not trigger another workflow** from events
it produces. So if an issue is ever closed by automation (auto-merge, a bot, or
another action) rather than a human click, `unblock-dependents` never fires and
dependent issues stay stuck — the loop silently stalls. A fine-grained PAT used
as the workflow token removes this and also drives local `/plan-sync` runs.

The workflows already read `${{ secrets.FACTORY_PAT || secrets.GITHUB_TOKEN }}`,
so they upgrade automatically once the PAT exists.

**What you (the agent) do — setup and verification only:**
- Ensure `.env` is gitignored: if `.gitignore` lacks a `.env` line, append it.
- Ensure `.env.example` exists documenting `GITHUB_PAT` (create from the kit's
  template if missing).
- Check presence only: `gh secret list` (is `FACTORY_PAT` listed?) and a
  non-empty `GITHUB_PAT=` line in `.env`. Never read, echo, log, or write the
  token value.

**If either is missing, STOP and INSTRUCT the user** (do NOT perform these —
creating a token and setting a secret are credential actions the user owns):
  1. Create a fine-grained PAT scoped to this repo with **Issues: Read/Write**,
     **Contents: Read/Write**, **Pull requests: Read/Write**.
  2. For Actions: `gh secret set FACTORY_PAT` and paste it when prompted.
  3. For local runs: copy `.env.example` to `.env` and set `GITHUB_PAT=<token>`.
  4. State clearly: until both are set, automation falls back to the default
     token and the loop may stall on automated issue closes.

## Step 5 — Report and hand off

- Confirm the nine labels (`gh label list`).
- Confirm `memory/USER.md` and `memory/MEMORY.md` exist; if just created, remind
  the user to seed `USER.md` with team conventions.
- Show the filled Gates table; call out every `TODO` row.
- State PAT status: `FACTORY_PAT` secret present? `.env` `GITHUB_PAT` present?
  If either is missing, repeat the Step 3 instruction.
- Remaining human-owned steps: verify the detected gates; confirm the three
  workflows are under `.github/workflows/`; recommended — protect `main`.

## Hard rules

- Token safety: never create the PAT, set the secret value, write a real token
  into any file, or print/log a token. Inform and verify presence only.
- Evidence-based gates: never fabricate a command; unknown → `TODO`.
- Detection never executes the project's build/test commands.
- File edits, labels, and read-only checks only — never change branch
  protection, repo settings, or visibility.
- Idempotent: safe to re-run any time the stack, labels, or token drift.
