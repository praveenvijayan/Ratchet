# Ratchet — continuous, GitHub-native delivery for Claude Code, Codex & Antigravity

A forward-only delivery loop: work only moves toward shipped, and every failure
path returns to the queue rather than slipping backward or stalling. A drop-in
kit that turns any GitHub repo into a continuous loop run by coding agents, with
humans owning only two jobs: **writing good plan files** and **reviewing PRs**.
There is no orchestrator, no database, and no custom service — the protocol
lives entirely in GitHub (issues, branches, labels, Actions, PRs), so it works
with **any** agent that can run `gh` and read a markdown file.

## Why it's cross-tool

The protocol is in GitHub, not in any one tool. The only tool-specific layer is
the thin skill/slash-command ergonomics, and the three tools share open
standards:

| Layer | Claude Code | GPT Codex | Antigravity |
|-------|-------------|-----------|-------------|
| Operating manual | `AGENTS.md` (+ `CLAUDE.md` pointer) | `AGENTS.md` | `AGENTS.md` (+ `GEMINI.md` pointer) |
| Skills | `.claude/skills/` | `.agents/skills/` | `.agents/skills/` |
| GitHub core (workflows, sync, labels) | shared | shared | shared |

`.agents/skills/` is the **canonical** source and is read directly by Codex and
Antigravity. `.claude/skills/` is a mirror for Claude Code. `setup.sh` keeps them
in sync.

## Layout

```
AGENTS.md                      Operating manual (the 7-step loop). Canonical.
CLAUDE.md / GEMINI.md          One-line pointers to AGENTS.md for each tool.
.agents/skills/<name>/         Canonical skills (Codex + Antigravity)
  SKILL.md                       portable skill body
  agents/openai.yaml             Codex invocation policy (explicit-only)
.claude/skills/<name>/SKILL.md Mirror for Claude Code
plugin/                        Optional Claude Code plugin packaging
.claude-plugin/marketplace.json  Optional marketplace (Claude Code only)
AGENTS.md                      Operating manual (100% framework, overwrite-safe)
GATES.md                       The ONLY project-owned config (verification gates)
CLAUDE.md / GEMINI.md          One-line pointers to AGENTS.md for each tool
.ratchet-version              Installed framework version (managed by the updater)
.agents/skills/<name>/         Canonical skills (Codex + Antigravity)
  SKILL.md                       portable skill body
  agents/openai.yaml             Codex invocation policy (explicit-only)
.claude/skills/<name>/SKILL.md Mirror for Claude Code
plugin/                        Optional Claude Code plugin packaging
.claude-plugin/marketplace.json  Optional marketplace (Claude Code only)
plan/
  README.md                    The plan-file format contract
  0001-email-login.md          Worked example
memory/
  USER.md                      Human-owned preferences (agent reads, never edits)
  MEMORY.md                    Distilled knowledge cache (agent proposes via PR)
scripts/
  plan-sync.mjs                Zero-dep deterministic plan→issue compiler
  ratchet-update.sh            Pulls framework updates, preserves project files
.github/workflows/             plan-sync, unblock-dependents, sweep-stale-claims
.env.example                   PAT documentation for local runs
setup.sh                       Sync skills into each tool's location
```

The five skills: **`/plan-issues`** (idea → `plan/*.md`), **`/plan-sync`**
(compile plan files → issues now), **`/factory-init`** (one-time: labels, gate
detection into `GATES.md`, memory scaffold, PAT check), **`/memory-compact`**
(prune & dedupe `memory/MEMORY.md`), **`/ratchet-update`** (pull a newer
framework version, project files untouched).

## Install

1. Copy this kit into your repo (or "Use this template"), and commit it.
2. Make sure skills are where each tool expects them:
   ```
   ./setup.sh                 # repo-local mirrors (works for all three on clone)
   ./setup.sh user-claude     # optional: install for Claude Code across all repos
   ./setup.sh user-agents     # optional: install for Codex/Antigravity across all repos
   ```
   Codex and Antigravity also read `.agents/skills/` directly with no setup.
3. Run **`/factory-init`** in your agent. It creates the labels, detects your
   stack to fill the Gates table in `AGENTS.md`, and walks you through the PAT.

### Claude Code, one-command alternative

```
/plugin marketplace add praveenvijayan/Ratchet
/plugin install ratchet@ratchet
```
(Codex and Antigravity do not use this; they use `.agents/skills/` + `AGENTS.md`.)

## The PAT (read this)

The issue flow depends on workflows reacting to each other. GitHub's default
token can't trigger one workflow from another's events, so any **automated**
issue close would stall the loop. The workflows read
`${{ secrets.FACTORY_PAT || secrets.GITHUB_TOKEN }}`, so set a fine-grained PAT
as the `FACTORY_PAT` repo secret (and in `.env` as `GITHUB_PAT` for local runs).
With pure human merges the fallback works; the PAT makes it bulletproof.
`/factory-init` checks this and guides you. **Never commit a real token** —
`.env` is gitignored; only `.env.example` is committed.

## The loop

1. **Ideate** with the LLM until the idea is solid.
2. **`/plan-issues`** → writes `plan/*.md`, one file per issue, then stops.
3. **Review** the plan files; commit `plan/` (or run **`/plan-sync`**).
4. Issues appear (`state:ready`). The agent **picks** the top unblocked one,
   **claims** it by creating `agent/issue-N`, **builds** to the acceptance
   criteria, **verifies** the gates fail-fast, and opens a **PR** with
   `Closes #N` — then stops.
5. A **human reviews and merges**. GitHub closes the issue.
6. `unblock-dependents` flips newly-unblocked issues to `state:ready`;
   `sweep-stale-claims` returns abandoned work to the queue.
7. Repeat until the backlog is empty. New findings → new `plan/*.md`.

Every failure path (red gate, crash, oversized issue, requested changes) returns
the issue to `state:ready` with a comment — nothing gets silently stuck.

## Memory (so it scales to multi-year projects)

Three tiers, all GitHub-native — no vector DB, no external service:

1. **Working** — the claimed issue + acceptance criteria, in context.
2. **Durable curated** — `memory/USER.md` (human-owned preferences) and
   `memory/MEMORY.md` (agent-proposed, human-approved distilled knowledge),
   read at the start of every issue. `MEMORY.md` is a **cache, not a log**: each
   entry is 1–2 lines linking to the issue/PR that is its real source, so it
   stays small even as the project grows huge.
3. **Episodic** — closed issues, merged PRs, `git log`/`blame`, and `plan/*.md`,
   searched on demand. This is the unbounded long-term store.

The agent reads Tiers 1–2 each issue, searches Tier 3 when context is missing,
and proposes `MEMORY.md` edits **inside its PR** — so memory changes are reviewed
like code, never written silently. It never edits `USER.md`. Run
`/memory-compact` periodically to prune stale entries. Because all three tools
read `AGENTS.md`, this works identically in Claude Code, Codex, and Antigravity.

## Updating Ratchet

Repos created from the template don't auto-update (that's the template
trade-off), but upgrading is one command and never needs a manual merge, because
`AGENTS.md` is 100% framework and the only project-owned config is `GATES.md`.

```
/ratchet-update           # pull upstream main onto a review branch
/ratchet-update v1.2.0    # or a specific release tag
```

It pulls only framework paths (skills, workflows, scripts, `AGENTS.md`),
re-syncs the skill mirrors, bumps `.ratchet-version`, and stops for you to review
the diff and open a PR. It never touches `GATES.md`, `memory/`, your `plan/*.md`
issues, `.env`, `README.md`, `LICENSE`, or your code. (Claude Code users who
installed via the plugin can also update skills with
`/plugin marketplace update ratchet`; the git update covers all three tools.)
