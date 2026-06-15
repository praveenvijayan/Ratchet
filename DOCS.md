# Ratchet — Complete Documentation

Version 1.2.0 · MIT · https://github.com/praveenvijayan/Ratchet

Ratchet is a continuous, GitHub-native software-delivery loop run by coding
agents (Claude Code, GPT Codex, or Google Antigravity) with a human reviewing
every pull request. It turns a repository into a self-feeding queue: you plan in
markdown, agents implement one issue at a time, and you review and merge. There
is no orchestrator, no database, and no service to operate — the entire protocol
lives in primitives GitHub already provides.

The name describes the core property: like a mechanical ratchet, work only moves
forward. Every failure path returns an issue to the queue rather than slipping
backward or stalling, and the merge is the one click that advances the mechanism
a tooth.

---

## 1. Philosophy

Five tenets shape every design decision in Ratchet.

**GitHub is the only memory.** Issues, branches, labels, pull requests, commit
history, and Actions are a complete substrate for state, work assignment,
episodic memory, and automation. Ratchet adds conventions on top of them rather
than a parallel system, which is why it needs no database and works with any
agent that can run `gh`.

**Conventions are the only protocol.** Coordination happens through agreed
meanings — a branch name *is* a claim, a label *is* a state, `Closes #N` *is* a
closure instruction. No message bus, no scheduler.

**The human gate is the merge.** Agents act autonomously within a single issue
but never merge, approve, close issues, or touch `main`. The pull request is the
terminal action of any agent run; a human's review and merge is the only thing
that advances the loop.

**Forward-only.** A crashed agent, a red test gate, an over-scoped issue, or a
requested change all resolve the same way: the issue returns to `state:ready`
(or `changes-requested`) with a comment explaining why. Nothing is ever silently
stuck, and no state is lost.

**Local-first, cross-tool.** Ratchet is designed for a developer running an
agent on their own machine, and works identically across Claude Code, Codex, and
Antigravity because the behavioural contract lives in `AGENTS.md`, which all
three read.

---

## 2. How the loop works

A single issue travels through a state machine projected onto GitHub labels. The
agent owns the middle; the human owns the gate; GitHub automation owns the edges.

```
plan/*.md ─sync→ issue(ready) → claim → build → verify → PR(in-review)
                     ▲                                        │
                     └──── unblock / next ◀── human merges ───┘
```

The seven steps, as defined in `AGENTS.md`:

1. **Pick** — one deterministic query: open issues, `state:ready`, no open
   blockers, sorted by priority then age. Take the top one. Rework outranks new
   work.
2. **Claim from fresh `main`** — sync first (`git fetch && git checkout main &&
   git pull --ff-only`), then create the branch `agent/issue-<N>`. Branch
   creation is the atomic claim; if it already exists, another agent owns the
   issue. Set `state:in-progress`. Pick → claim → build is one continuous motion
   — the agent does not pause to ask permission.
3. **Build** — implement exactly the acceptance criteria, in small commits,
   following existing repo patterns. If scope exceeds the issue (~400 lines or
   ~6 files), stop, propose a split, and requeue.
4. **Verify** — run the gates from `GATES.md` in order, fail-fast. Two fix
   attempts; if still red, comment the failure and reset to `state:ready`. Push
   only after gates pass, so red work triggers no CI.
5. **Hand off** — open a PR whose first line is `Closes #<N>`, with a summary
   and gate results; set `state:in-review`; then stop. Never open a second PR
   for the same issue.
6. **Rework** — when a human rejects (see §8), fix the same branch and PR,
   re-run gates, reply to comments with fixing SHAs, return to `state:in-review`.
7. **System closes the loop** — a human merges, GitHub closes the issue via
   `Closes #N`, and two workflows react (unblock dependents, sweep stale claims).

The states and their meaning:

| Label | Meaning | Set by |
|-------|---------|--------|
| `state:draft` | Synced from a plan file but not ready (no acceptance criteria) | plan-sync |
| `state:ready` | Unblocked and pickable | plan-sync / unblock-dependents / sweep |
| `state:in-progress` | Claimed; `agent/issue-<N>` branch exists | agent |
| `state:in-review` | PR open, awaiting human review | agent |
| `state:changes-requested` | Human requested changes; agent reworking | agent / ratchet-next |
| `state:blocked` | Has an open blocker; not pickable | plan-sync |

Priority labels `priority:high` / `medium` / `low` determine pick order. Exactly
one state label and one priority label per issue at any time; labels are a
*projection* of state, never the authority — the branch is the real claim.

---

## 3. Cross-tool design

The behavioural contract is `AGENTS.md`, read natively by Codex and Antigravity
and by Claude Code. Two thin pointer files, `CLAUDE.md` and `GEMINI.md`, simply
say "follow `AGENTS.md`" so each tool converges on one manual.

Skills (the slash-command ergonomics) use the open Agent Skills format —
a `SKILL.md` with `name` and `description` frontmatter. The same skill bodies are
shipped to each tool's directory:

| Location | Used by |
|----------|---------|
| `.agents/skills/<name>/SKILL.md` | Codex and Antigravity (read directly) |
| `.agents/skills/<name>/agents/openai.yaml` | Codex invocation policy (explicit-only) |
| `.claude/skills/<name>/SKILL.md` | Claude Code |
| `plugin/skills/<name>/SKILL.md` | The optional Claude Code plugin |

`.agents/skills/` is the canonical source; `setup.sh` mirrors it to the other
locations. Skill bodies avoid tool-specific templating so they execute
identically everywhere.

---

## 4. Repository layout

```
AGENTS.md                       Operating manual — the 7-step loop (100% framework)
GATES.md                        Project config you hand-author: verification gates
CLAUDE.md / GEMINI.md           One-line pointers to AGENTS.md
DOCS.md                         This document
README.md                       Overview and quick start
LICENSE                         MIT
.ratchet-version                Installed framework version
.env.example                    PAT documentation for local runs
.gitignore                      Ignores .env and .ratchet/ runtime state
setup.sh                        Mirror skills into each tool's location

plan/
  README.md                     The plan-file format contract
  0001-email-login.md           Worked example
memory/
  USER.md                       Human-owned preferences (agent reads, never edits)
  ARCHITECTURE.md               Coarse codebase map (generated; agent scopes reads with it)
  MEMORY.md                     Distilled knowledge cache (agent proposes via PR)
scripts/
  plan-sync.mjs                 Deterministic plan→issue compiler (zero-dep, Node 20+)
  ratchet-update.sh             Pull framework updates, preserve project files
  ratchet-watch.sh              Real-time GitHub→local bridge (gh webhook forward)
  ratchet-watch.mjs             Zero-dep webhook receiver / event classifier
.github/workflows/
  plan-sync.yml                 Compile plan/*.md → issues on push
  unblock-dependents.yml        On issue close, promote unblocked dependents
  sweep-stale-claims.yml        Return abandoned in-progress issues to ready
  ratchet-run.yml               OPTIONAL CI runner (off by default)
.agents/skills/<name>/          Canonical skills (Codex + Antigravity)
.claude/skills/<name>/          Mirror for Claude Code
plugin/                         Optional Claude Code plugin packaging
.claude-plugin/marketplace.json Optional marketplace manifest (Claude Code only)
```

---

## 5. Skills

All skills are explicit-only (user-invoked, never auto-fired) because each has
side effects. Invoke as `/name` in Claude Code or Antigravity, or `/skills` /
`$name` in Codex.

| Skill | When to run | What it does |
|-------|-------------|--------------|
| `/ratchet-init` | Once per repo | Creates the 9 state/priority labels, detects the stack and fills `GATES.md`, scaffolds `memory/`, and verifies the PAT. Idempotent. |
| `/ratchet-plan` | Planning, or reporting a found bug | Writes plan file(s) — one for a quick report, several for a full plan — onto the rolling planning branch and opens/updates the always-open planning PR, then stops. Never fixes or creates issues directly. |
| `/ratchet-sync` | Only without the PR flow | Local/no-PR escape hatch: compiles working-tree `plan/*.md` into issues now. Normally unused — merging the planning PR does this. |
| `/ratchet-next` | After a merge or review | Advances (sync main + next issue) on approval, or reworks the same PR on rejection. The heart of the continuous local loop. |
| `/ratchet-memory` | Periodically (e.g. quarterly) | Prunes and dedupes `memory/MEMORY.md`, verifies issue/PR links, stops for review. |
| `/ratchet-map` | When structure drifts | Regenerates the coarse codebase map `memory/ARCHITECTURE.md` (language-agnostic), stops for review. |
| `/ratchet-update` | To upgrade | Pulls newer framework files onto a review branch; never touches project-owned files. |

### Detail: `/ratchet-init`

Run once in a new repo. It is the only setup step beyond installing the skills.
It creates labels with `--force` (idempotent), detects the project's package
manager and real gate commands from manifests/lockfiles and writes them into
`GATES.md` (using `TODO` rows rather than guesses where evidence is missing),
scaffolds `memory/USER.md` and `memory/MEMORY.md`, and checks that the
`FACTORY_PAT` secret and `.env` `GITHUB_PAT` are present (by presence only —
it never reads, writes, or prints a token). On a greenfield repo it leaves the
default `GATES.md` and asks you to re-run once code exists.

### Detail: `/ratchet-plan`

Decomposes the current conversation's idea into issue-sized units (one PR closes
one issue), assigns sequential slugs continuing from the highest existing
`plan/` number, wires dependencies by slug, and writes the files. It stops
without committing so you review the plan first; committing `plan/` is what
triggers issue creation.

### Detail: `/ratchet-next`

See §8 — this is the routine that responds to a human's PR decision.

---

## 6. Workflows

| Workflow | Trigger | Effect |
|----------|---------|--------|
| `plan-sync` | push to `plan/**` on `main` (i.e. planning-PR merge), or manual | Compiles `plan/*.md` into issues, idempotently (dedup via a `<!-- plan-id -->` marker). Scoped to `main` so the planning branch doesn't create issues early. |
| `unblock-dependents` | `issues: closed` | Promotes every issue whose blockers are now all closed to `state:ready`. This re-feeds the queue. |
| `sweep-stale-claims` | every 30 min, or manual | Returns `state:in-progress` issues with no branch commits for >2h to `state:ready` — a poor-man's lease expiry for crashed agents. |
| `ratchet-run` | PR merged, or manual | OPTIONAL, off by default. Runs an agent in CI to work the next issue. Requires `RATCHET_AUTO=true` and an agent API key. Most users do not enable this — the local loop (§8) is the recommended path. |

All three core workflows read `${{ secrets.FACTORY_PAT || secrets.GITHUB_TOKEN }}`
so they work with the default token and upgrade automatically when the PAT is
set (see §10).

---

## 7. The plan format and memory

### Plan files (`plan/*.md`)

Each file compiles to exactly one GitHub issue. The filename stem
(`0001-email-login`) is the permanent slug and the dependency reference.

```markdown
---
title: Add email/password login
priority: high              # high | medium | low (required)
labels: [auth]              # optional extra labels
blocked_by: [0002-user-model]   # other slugs, or [] (required, may be empty)
---

Short description of what and why.

## Acceptance criteria
- [ ] User submits email + password and receives a session token
- [ ] Invalid credentials return 401 with a generic message
```

`title` and `priority` are required. A file with at least one `- [ ]` acceptance
criterion becomes `state:ready`; without criteria it becomes `state:draft` and
no agent picks it. `blocked_by` slugs are resolved to `Blocked by #N` lines, and
an issue with any open blocker is `state:blocked`. The file owns issue *content*;
once an issue leaves `ready`/`draft`, sync stops touching it so live work is
never clobbered.

### Reporting something you found (bug, improvement, follow-up)

When you spot a problem or an improvement, first decide which of two paths it is —
they are handled differently on purpose:

- **It blocks the PR you're reviewing** → that's a **rejection, not a new issue**.
  Request Changes (or comment), and `/ratchet-next` reworks the same branch (§8).
  Do not open an issue for it.
- **It's separate or new work** (a bug in unrelated code, an improvement, anything
  noticed after merge) → it becomes a **new plan-backed issue** and re-enters the
  queue.

For new work, **do not hand-create the issue on github.com.** Issues are compiled
from `plan/*.md`, and a hand-made issue almost always lacks acceptance criteria —
which parks it in `state:draft`, unpickable, forever. The disciplined path:

1. **The front door is `/ratchet-plan <description>`** — e.g.
   `/ratchet-plan google signin not working`. It writes a well-formed
   `plan/*.md` (slug, priority, and a real `## Acceptance criteria` block derived
   from the symptom) onto the rolling planning branch and opens/updates the
   planning PR, then **stops** — it never edits code, fixes anything, or creates
   issues directly, even if the fix is obvious or the report is urgent. The same
   skill plans a whole idea into many files when you describe a feature.
2. Review and **merge the planning PR**; `plan-sync` runs on `main` and creates the issue(s).
3. The agent picks it up automatically on its next advance. **Priority is how you
   triage:** a `priority:high` issue with no blockers jumps to the front of the
   deterministic pick order, preempting lower-priority ready work — so an urgent
   bug is worked next without any manual assignment.

If you must create an issue directly on GitHub for speed, you own the contract by
hand: include the `## Acceptance criteria` + `- [ ]` block in the body and apply
`state:ready` plus a `priority:*` label yourself, or no agent will pick it. The
label is not the fix — the criteria are.

### Memory (three tiers)


Ratchet keeps a long-running project tractable without a vector database:

1. **Working** — the claimed issue and conversation, in context. Ephemeral.
2. **Durable curated** — two committed files, read at the start of every issue:
   - `memory/USER.md` — human-owned preferences, conventions, glossary,
     "always/never" rules. The agent reads it and never edits it.
   - `memory/ARCHITECTURE.md` — a coarse, machine-generated codebase map (layout,
     components by role, conventions) the agent reads to scope its file reads.
     Generated by `/ratchet-init`, refreshed by `/ratchet-map`; provisional.
   - `memory/MEMORY.md` — agent-proposed, human-approved distilled knowledge:
     decisions, gotchas, environment facts, patterns. It is a **cache, not a
     log** — each entry is one or two lines linking to the issue/PR that is its
     real source, so it stays small even as the project grows huge.
3. **Episodic** — closed issues, merged PRs, `git log`/`blame`, and `plan/*.md`,
   searched on demand (`gh issue list --search`, `gh pr list`). This is the
   unbounded long-term store; raw detail lives here, never in `MEMORY.md`.

The agent reads tiers 1–2 each issue, searches tier 3 when context is missing,
and proposes `MEMORY.md` edits **inside its PR** — so memory changes are reviewed
like code, never written silently. `/ratchet-memory` prunes the cache; because
the real record is in tier 3, pruning never loses information.

---

## 8. The continuous local loop

This is how the next task starts after a human decision — locally, with no CI
and no extra API key, using your existing `gh` login.

### Real-time channel

`scripts/ratchet-watch.sh` uses `gh webhook forward` (the official
`cli/gh-webhook` extension) to open a WebSocket from GitHub to your machine and
forward `pull_request`, `pull_request_review`, and review-comment events to a
local zero-dependency receiver (`ratchet-watch.mjs`). No public endpoint, no
tunnel, no deploy.

```
./scripts/ratchet-watch.sh            # watch current repo; notify on merge/review
```

The receiver reacts only to PRs on `agent/issue-*` branches and classifies each
event into an action, writing `.ratchet/last-event.json` and printing a line:

| Event | Action |
|-------|--------|
| PR merged | `advance` |
| Review: Changes Requested | `rework` |
| PR closed without merge | `rework` |
| New review comment | `rework` |
| Review: Approved | `note` (awaiting merge) |

### The response: `/ratchet-next`

In response to an event (or whenever you ask), the agent runs `/ratchet-next`:

- **Approve → merged:** it syncs to the merged code
  (`git checkout main && git fetch && git pull --ff-only`) and starts the next
  ready issue. Because this happens *after* the merge, the new branch is always
  based on current `main` — the stale-base problem cannot occur.
- **Reject:** it reworks the same PR, reading feedback from any of three
  channels — a Request Changes review, a close-with-comment, or what you told it
  directly in chat — reconciling them, fixing the same branch, re-running gates,
  and replying to each comment with the fixing SHA.

### Notify vs auto-run

By default the watcher only notifies and you run `/ratchet-next` yourself (full
human-in-loop). To make it act automatically after your decision, point
`RATCHET_ON_EVENT` at a local headless agent command — which uses your
already-logged-in CLI, not an API key:

```
RATCHET_ON_EVENT="claude -p 'Run /ratchet-next per AGENTS.md'" ./scripts/ratchet-watch.sh
RATCHET_ON_EVENT="codex exec 'Run /ratchet-next per AGENTS.md'" ./scripts/ratchet-watch.sh
```

Either way the human gate stays exactly where you put it: the merge/review
decision. The watcher is a foreground dev process — it runs while your terminal
is open; close it and you simply run `/ratchet-next` manually next time, which
also works because it can inspect PR state directly.

---

## 9. Installation and setup

Ratchet is published as a GitHub **template repository** and (for Claude Code) a
**plugin marketplace**.

1. **Get the files.** Click "Use this template" on the Ratchet repo, or
   `gh repo create my-project --template praveenvijayan/Ratchet`. This copies the
   full tree to your new repo's root.
2. **Place the skills for your tool:**
   ```
   ./setup.sh                 # repo-local mirrors (all three tools work on clone)
   ./setup.sh user-claude     # optional: ~/.claude/skills for all projects
   ./setup.sh user-agents     # optional: ~/.agents/skills for all projects
   ```
   Codex and Antigravity read `.agents/skills/` directly with no setup.
3. **Run `/ratchet-init`** in your agent — labels, gate detection into
   `GATES.md`, memory scaffold, PAT check.
4. **Set the PAT** (see §10).

Claude Code one-command alternative for the skills:
```
/plugin marketplace add praveenvijayan/Ratchet
/plugin install ratchet@ratchet
```

---

## 10. The Personal Access Token

The issue flow depends on workflows reacting to each other's events. GitHub's
default `GITHUB_TOKEN` does not trigger one workflow from another's events, so if
an issue is ever closed by automation rather than a human click,
`unblock-dependents` would not fire and dependents would stall. A fine-grained
PAT used as the workflow token removes this, and also powers local `plan-sync`.

Set it two places:

```
gh secret set FACTORY_PAT          # for GitHub Actions
# and in .env (gitignored), for local runs:
GITHUB_PAT=<your fine-grained PAT>
```

Scope it to the repo with **Issues: Read/Write, Contents: Read/Write, Pull
requests: Read/Write**. With pure human merges the default-token fallback works;
the PAT makes the loop bulletproof against any automated close. `/ratchet-init`
checks presence (never the value). **Never commit a real token** — `.env` is
gitignored; only `.env.example` is committed.

---

## 11. Updating Ratchet

Repos created from the template do not auto-update — upgrading is a deliberate,
zero-merge command, because `AGENTS.md` is 100% framework; the project-specific
files (`GATES.md` plus everything under `memory/`) live outside it.

```
/ratchet-update           # pull upstream main onto a review branch
/ratchet-update v1.2.0    # or a specific release tag
```

It pulls only framework paths (skills, workflows, scripts, `AGENTS.md`,
pointers, `.env.example`), re-syncs the skill mirrors, bumps `.ratchet-version`,
and stops for you to review the diff and open a PR. It never touches the
project-owned set:

| Framework (pulled, overwrite-safe) | Project-owned (never touched) |
|------------------------------------|-------------------------------|
| `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `DOCS.md` | `GATES.md` (config) |
| `.agents/`, `.claude/`, `plugin/`, `.claude-plugin/` | `memory/` (`USER.md`, `ARCHITECTURE.md`, `MEMORY.md`) |
| `.github/workflows/`, `scripts/*` | your `plan/*.md` issue files |
| `.env.example` | `.env`, `README.md`, `LICENSE`, `.gitignore`, your code |

`.ratchet-version` records the installed version. Tag releases upstream
(`git tag v1.2.0 && git push --tags`) so consumers can pin to a known version.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Dotfolders (`.github`, `.agents`, `.claude`) missing after upload | macOS Finder hides dotfiles, so a browser drag-and-drop skips them | Upload via `git` (`cp -R src/. .` copies hidden files), never the web file picker |
| Dependents don't become `state:ready` after a merge | `FACTORY_PAT` not set, so workflow-chaining is blocked | Set the `FACTORY_PAT` secret (§10) |
| Agent's PR conflicts / re-does merged work | Branched from stale local `main` | The claim step now does `git pull --ff-only` first; ensure you're on the current framework (`/ratchet-update`) |
| `/ratchet-init` doesn't create `GATES.md` | Legacy repo created before the GATES extraction; gates still inline in `AGENTS.md` | `/ratchet-update` to get the new `AGENTS.md`, then `/ratchet-init` to write `GATES.md` |
| Agent pauses and asks "shall I start?" | Claim-step autonomy not in older `AGENTS.md`, or tool needs permission for `gh`/`git` | Update via `/ratchet-update`; grant the agent standing `Bash(gh:*)` / `Bash(git:*)` permission |
| Watcher receives nothing | `gh webhook forward` needs the `cli/gh-webhook` extension and a running receiver | `ratchet-watch.sh` installs the extension and starts the receiver; check it's still in the foreground |
| `ratchet-run` workflow does nothing | It is off by default | Set repo variable `RATCHET_AUTO=true` and an agent API key — only if you want CI execution |

---

## 13. Command reference

```
# Setup (once per repo)
./setup.sh                         # place skills for all three tools
/ratchet-init                      # labels, gates, memory, PAT check
gh secret set FACTORY_PAT          # enable workflow chaining

# Plan
/ratchet-plan [desc]               # plan, or report a found bug → rolling planning PR
#   (review & MERGE the planning PR to create the issues)
/ratchet-sync                      # local/no-PR escape hatch only

# Run the loop (local)
./scripts/ratchet-watch.sh         # real-time merge/review signals
/ratchet-next                      # advance after merge, or rework after reject

# Maintain
/ratchet-memory                    # prune memory/MEMORY.md
/ratchet-map                       # regenerate memory/ARCHITECTURE.md
/ratchet-update [vX.Y.Z]           # upgrade the framework
```

---

## 14. Glossary

- **Claim** — creating the branch `agent/issue-<N>`; an atomic, GitHub-native
  lock on an issue.
- **Gate** — a verification command (format/typecheck/lint/test/build) defined in
  `GATES.md` that must pass before a PR opens.
- **Projection** — labels reflecting state; the branch, not the label, is the
  authority.
- **Slug** — the `plan/` filename stem; an issue's permanent identity and
  dependency reference.
- **Framework vs project-owned** — files Ratchet owns and overwrites on update
  versus files your repo owns and Ratchet never touches.
- **Forward-only** — the property that work only advances or returns to the
  queue, never silently stalls or regresses.
