<div align="center">

<img src="https://github.com/user-attachments/assets/6cc454f7-b616-4415-9571-fe8938a98c53" alt="Ratchet — forward-only delivery for coding agents" width="100%">

<br>

**A continuous, GitHub-native delivery loop for coding agents — Claude Code, Codex & Antigravity.**

<br>

![last commit](https://img.shields.io/github/last-commit/praveenvijayan/Ratchet?style=for-the-badge&logo=github&labelColor=15191e&color=ea8f3c)
![open issues](https://img.shields.io/github/issues/praveenvijayan/Ratchet?style=for-the-badge&logo=github&labelColor=15191e&color=ea8f3c)
![open pull requests](https://img.shields.io/github/issues-pr/praveenvijayan/Ratchet?style=for-the-badge&logo=github&labelColor=15191e&color=ea8f3c)
![license](https://img.shields.io/github/license/praveenvijayan/Ratchet?style=for-the-badge&labelColor=15191e&color=8b97a3)
![framework version](https://img.shields.io/badge/framework-v5.0.1-ea8f3c?style=for-the-badge&labelColor=15191e)

[Install](#install) · [The loop](#the-loop) · [Memory](#memory-so-it-scales-to-multi-year-projects) · [Updating](#updating-ratchet) · [Continuous execution](#hands-off-continuous-execution-opt-in) · [Cross-tool](#why-its-cross-tool) · [The PAT](#the-pat-read-this) · [License](LICENSE)

</div>

---

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
AGENTS.md                        Operating manual (the 7-step loop). Canonical, overwrite-safe.
CLAUDE.md / GEMINI.md            One-line pointers to AGENTS.md for each tool.
GATES.md                         Project config you hand-author (verification gates).
.ratchet-version                 Installed framework version (managed by the updater).
.agents/skills/<name>/           Canonical skills (Codex + Antigravity)
  SKILL.md                         portable skill body
  agents/openai.yaml               Codex invocation policy (explicit-only)
.claude/skills/<name>/SKILL.md   Mirror for Claude Code
plugin/                          Optional Claude Code plugin packaging
.claude-plugin/marketplace.json  Optional marketplace (Claude Code only)
plan/
  README.md                        The plan-file format contract
  examples/0001-email-login.md     Worked example (not synced — kept for reference)
memory/
  USER.md                          Human-owned preferences (agent reads, never edits)
  ARCHITECTURE.md                  Coarse codebase map (generated; scopes the agent's reads)
  MEMORY.md                        Distilled knowledge cache (agent proposes via PR)
scripts/
  plan-sync.mjs                    Zero-dep deterministic plan→issue compiler
  plan-sync.test.mjs               Regression test for the compiler (node scripts/plan-sync.test.mjs)
  ratchet-update.sh                Pulls framework updates, preserves project files
.github/workflows/               plan-sync, unblock-dependents, sweep-stale-claims, pr-gates, review-verdict, release, ratchet-run
.env.example                     PAT documentation for local runs
setup.sh                         Sync skills into each tool's location
```

The skills: **`/ratchet-plan`** (idea → `plan/*.md`), **`/ratchet-sync`**
(compile plan files → issues now), **`/ratchet-init`** (one-time: labels, gate
detection into `GATES.md`, memory scaffold, codebase map, PAT check),
**`/ratchet-next`** (advance after merge, or rework after review),
**`/ratchet-status`** (read-only: why is nothing ready, and what to do),
**`/ratchet-metrics`** (read-only loop health: cycle time, rework, sweeps,
queue depth), **`/ratchet-memory`** (prune & dedupe `memory/MEMORY.md`),
**`/ratchet-map`** (regenerate the coarse codebase map),
**`/ratchet-update`** (pull a newer framework version, project files untouched),
**`/ratchet-uninstall`** (cleanly remove Ratchet; keeps your data by default).

An **optional** headless fleet supervisor, **`ratchet-herd`** (`node
scripts/herd.mjs run`), runs the same loop across many issues at once — one
agent CLI per ready issue, watched to a PR — with adapters, prompts, and env
configured per operator in `.ratchet/herd.json`. It never merges or reviews;
anything it can't resolve is escalated to a human. See DOCS.md §14.

## Install

Install from a pinned release with the bootstrap script, run from inside your
project's git repo. It downloads the tag you name, reads
`ratchet-manifest.json`, and copies in only the framework files your chosen
profile(s) need — it never touches `.env` or other local secrets (they aren't
in the manifest, so they're never selected).

Download it, inspect it, then run it — the safe default for anything you pipe
into `bash`. `TAG` resolves to the latest published release (a ref that is
guaranteed to exist), so the commands run verbatim with nothing to fill in:

```
TAG=$(curl -fsSL https://api.github.com/repos/praveenvijayan/Ratchet/releases/latest | grep -m1 '"tag_name":' | cut -d'"' -f4)
curl -fsSL "https://raw.githubusercontent.com/praveenvijayan/Ratchet/${TAG}/scripts/bootstrap.sh" -o bootstrap.sh
less bootstrap.sh          # read it before you run it
bash bootstrap.sh --version "${TAG}"
```

A default install ships the **core** delivery loop plus the **herd** fleet
supervisor (`scripts/herd*.mjs`, the `ratchet-herd` skill, and the `mascots/`
assets), so `node scripts/herd.mjs run` and `/ratchet-herd` work out of the box.
Or, once you trust the source, the one-line convenience form. It pins to that
same resolved release tag, so the install stays reproducible — piping an
unpinned `main` straight into `bash` is not reproducible, so always install
from a resolved release tag (to install a specific older version instead,
replace the `${TAG}` lookup with a tag from the [Releases](https://github.com/praveenvijayan/Ratchet/releases) page):

```
TAG=$(curl -fsSL https://api.github.com/repos/praveenvijayan/Ratchet/releases/latest | grep -m1 '"tag_name":' | cut -d'"' -f4) \
  && curl -fsSL "https://raw.githubusercontent.com/praveenvijayan/Ratchet/${TAG}/scripts/bootstrap.sh" | bash -s -- --version "${TAG}"
```

`--profile` selects profiles on top of the always-included `core`
(comma-separated). The default is `--profile herd`; pass `--profile core` for a
core-only install with no supervisor, or extend it (e.g.
`--profile herd,watcher` to add the local real-time watcher). The available
profiles:

| Profile | Installs |
|---------|----------|
| `core` | The base delivery loop — always installed. Plan sync, claim/verify gates, PR-size and issue-body checks, the skills, and the agent manuals. |
| `herd` | Headless fleet supervisor (`scripts/herd*.mjs` + the `ratchet-herd` skill + `mascots/`). **On by default.** |
| `watcher` | Local real-time watcher (`scripts/ratchet-watch.*`) that turns a merge/review into a `/ratchet-next` trigger. |
| `release` | Versioned-release tooling for teams that cut tagged Ratchet releases. |
| `unattended-ci` | Optional CI-based runner for unattended execution. Off by default. |
| `claude-plugin` | Claude Code plugin marketplace packaging. |

See DOCS.md §9 for the full file list per profile. `--dry-run` reports what
would change without writing anything; `--force` is required to overwrite a
conflicting existing file. If you later install into a core-only project and
try the herd, `node scripts/herd.mjs` prints the exact `bootstrap.sh --profile
herd` command to add the supervisor files — never a raw module-not-found error.

Then:

1. **`./setup.sh`** — generate the skill mirrors your agent reads (or
   `./setup.sh user-claude` / `./setup.sh user-agents` to install across all
   your repos; Codex and Antigravity also read `.agents/skills/` directly with
   no setup).
2. Run **`/ratchet-init`** in your agent. It creates the labels, detects your
   stack to fill `GATES.md`, and walks you through the PAT.

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
`/ratchet-init` checks this and guides you. **Never commit a real token** —
`.env` is gitignored; only `.env.example` is committed.

## The loop

1. **Ideate** with the LLM until the idea is solid.
2. **`/ratchet-plan`** → writes `plan/*.md` (one for a report, many for a plan)
   onto the rolling planning branch and opens/updates the planning PR.
3. **Review and merge the planning PR**; `plan-sync` creates the issues on `main`.
4. Issues appear (`state:ready`). The agent runs the loop as **one-command
   scripts**, not hand-typed multi-step shell — each returns a stable exit code:
   - **claim** — `node scripts/ratchet-start.mjs --issue <N> --owner "<id>"`
     (atomic server-side `agent/issue-<N>` ref off fresh `main`, worktree, owner
     marker, label flip; exit `3` means another agent already holds it),
   - **build** to the acceptance criteria — renew the lease on long builds with
     `node scripts/ratchet-heartbeat.mjs --issue <N>`, or return the issue to the
     queue with `node scripts/ratchet-requeue.mjs --issue <N> --reason "…"`,
   - **verify** the gates fail-fast, then
   - **hand off** — `node scripts/ratchet-submit.mjs --issue <N> --body-file <path>`
     integrates `main`, runs the gates, and opens a single PR with `Closes #N`.

   Then it stops. (See DOCS.md §13 for every argument and exit code.)
5. A **human reviews and merges**. GitHub closes the issue.
6. `unblock-dependents` flips newly-unblocked issues to `state:ready`;
   `sweep-stale-claims` returns abandoned work to the queue.
7. Repeat until the backlog is empty. New findings → new `plan/*.md`.

Every failure path (red gate, crash, oversized issue, requested changes) returns
the issue to `state:ready` with a comment — nothing gets silently stuck.

## Memory (so it scales to multi-year projects)

Three tiers, all GitHub-native — no vector DB, no external service:

1. **Working** — the claimed issue + acceptance criteria, in context.
2. **Durable curated** — `memory/USER.md` (human-owned preferences),
   `memory/ARCHITECTURE.md` (a coarse, generated codebase map that scopes the
   agent's reads), and `memory/MEMORY.md` (agent-proposed distilled knowledge),
   read at the start of every issue. `MEMORY.md` is a **cache, not a log**: each
   entry is 1–2 lines linking to the issue/PR that is its real source, so it
   stays small even as the project grows huge.
3. **Episodic** — closed issues, merged PRs, `git log`/`blame`, and `plan/*.md`,
   searched on demand. This is the unbounded long-term store.

The agent reads Tiers 1–2 each issue, searches Tier 3 when context is missing,
and proposes `MEMORY.md` edits **inside its PR** — so memory changes are reviewed
like code, never written silently. It never edits `USER.md`. Run
`/ratchet-memory` periodically to prune stale entries. Because all three tools
read `AGENTS.md`, this works identically in Claude Code, Codex, and Antigravity.

## Updating Ratchet

Repos created from the template don't auto-update (that's the template
trade-off), but upgrading is one command and never needs a manual merge, because
`AGENTS.md` is 100% framework; the project-specific files (`GATES.md` config
plus the `memory/` files) live outside it and the updater never touches them.

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

## Hands-off continuous execution (opt-in)

By default a human re-invokes the agent after each merge ("pick the next issue").
To make the loop fully hands-off — human involvement ends at the merge until the
next PR — enable the `ratchet-run` workflow:

```
gh variable set RATCHET_AUTO --body true
gh secret set ANTHROPIC_API_KEY        # the agent runtime in CI (or swap to Codex)
# FACTORY_PAT is already set by /ratchet-init
gh workflow run ratchet-run            # kick off the first task after planning
```

Then every human merge triggers `ratchet-run`: it checks out the latest `main`
(fresh, so the next branch is never stale), picks the top ready issue, and an
agent works it to a PR and stops. You merge; it advances. The backlog drains one
merge at a time, and the merge is the only thing you do.

It is **safe by default**: without `RATCHET_AUTO=true` the workflow exists but
no-ops, so nothing runs or fails unexpectedly. The agent step uses Claude Code;
swap that one step for an OpenAI Codex action if you prefer. (Antigravity is used
interactively rather than in CI.) Mind the cost — each run spends agent API
tokens; set a budget/alert on your provider.
