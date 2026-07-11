# Ratchet — Complete Documentation

Version 4.3.1 · MIT · https://github.com/praveenvijayan/Ratchet

**New in 3.6.0** — a herd route may declare a selection policy. The default stays
`failover` (first available adapter, unchanged), and `round-robin` cycles
successive dispatches across the available adapters so workers spread load
instead of piling onto the first. Rotation is deterministic (a cursor persisted
in `.ratchet/herd-routing.json`, no `Math.random`) and skips unavailable
adapters. See §14.

**New in 3.5.0** — the herd emits an adapter-agnostic event stream to
`.ratchet/events.jsonl` (dispatch, resume, rework, claim/PR detection, worker
exit/kill, escalation), so observability no longer depends on parsing any one
adapter's log format. See §14.

**New in 3.4.1** — a herd worker whose adapter binary is missing or unexecutable
no longer crashes the supervisor: the spawn failure marks the issue
`dispatch-failed` with its pid cleared and escalates the adapter, command, and
log file, so the fleet keeps polling. See §14.

**New in 3.4.0** — the `ratchet-herd` fleet supervisor (config, survey,
dispatch, monitor, verify, the `/ratchet-herd` skill, docs, and the cross-agent
skill-parity guard) ships as an optional headless lane that launches and
watches multiple workers across ready issues. See §14.

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
                     └──── unblock / next ◀── human merges ───┤
                                                              └→ release (opt-in): tag + changelog → deploy gate
```

The dashed branch off `human merges` is the **release lane** (§6, `release`):
an opt-in, post-merge "ship" stage that tags a version, publishes a changelog
from the merged PR titles, and can run a repo-owned deploy command after the
tag/release exists. It is off by default and never blocks the loop.

The seven steps, as defined in `AGENTS.md`:

1. **Pick** — one deterministic query: open issues, `state:ready`, no open
   blockers, sorted by priority then age. Take the top one. Rework outranks new
   work.
2. **Claim — atomic, server-side** — the claim *is* creating the branch
   `agent/issue-<N>` as a ref on the server, before any local work:
   `gh api repos/{owner}/{repo}/git/refs -f ref=refs/heads/agent/issue-<N> -f sha=<main-sha>`.
   GitHub's ref-create is a compare-and-swap, so this is atomic across every
   machine, session, and tool — not just one clone. A **422** ("Reference
   already exists") means another agent owns the issue; exit quietly, don't
   retry. Only after the claim succeeds, attach a local working copy — always
   as a dedicated worktree (`git fetch origin agent/issue-<N>` then
   `git worktree add ../wt/issue-<N> agent/issue-<N>`), never by checking the
   branch out in the shared clone, which stays parked on `main` so parallel
   agents never fight over one working tree — and
   set `state:in-progress`. Creating the ref is a zero-commit pointer, not a
   code push, so it triggers no gates. Pick → claim → build is one continuous
   motion — the agent does not pause to ask permission.
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

State labels describe **open** work only. When an issue closes,
`unblock-dependents` strips its `state:*` label — closed is the terminal state,
and a leftover `state:in-review` on a closed issue would mislead.

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
.gitignore                      Ignores .env and .ratchet/ runtime state (incl. herd .ratchet/logs/ and .ratchet/herd-state.json)
setup.sh                        Mirror skills into each tool's location

plan/
  README.md                     The plan-file format contract
  examples/0001-email-login.md  Worked example (not synced — kept for reference)
memory/
  USER.md                       Human-owned preferences (agent reads, never edits)
  ARCHITECTURE.md               Coarse codebase map (generated; agent scopes reads with it)
  MEMORY.md                     Distilled knowledge cache (agent proposes via PR)
scripts/
  archive-closed-plans-workflow.test.mjs Regression test for the archive workflow
  archive-closed-plans.mjs      Move closed issue plans into plan/done/
  bootstrap.sh                  Install Ratchet into a host project from a pinned release (manifest + profiles)
  bootstrap.test.mjs            End-to-end test for the bootstrap installer
  install-lifecycle.test.mjs    End-to-end test for bootstrap-install -> update -> uninstall
  archive-closed-plans.test.mjs Regression test for the archive sweep
  criteria.mjs                  Shared acceptance-criteria readiness rule
  criteria.test.mjs             Regression test for the readiness rule
  docs-refresh.test.mjs         Regression test for documentation inventory
  gates-coverage.mjs            Guard: every *.test.mjs runs in a GATES.md row
  gates-coverage.test.mjs       Regression test for the coverage guard
  gates-table.mjs               Shared parser for the GATES.md markdown table
  herd.mjs                      ratchet-herd config loader, validator, init
  herd.test.mjs                 Regression test for herd config
  herd-survey.mjs               ratchet-herd survey/reconcile poll loop
  herd-survey.test.mjs          Regression test for herd survey loop
  herd-dispatch.mjs             ratchet-herd worker dispatcher
  herd-dispatch.test.mjs        Regression test for herd dispatcher
  herd-monitor.mjs              ratchet-herd worker monitor: verify/resume/escalate
  herd-monitor.test.mjs         Regression test for herd monitor
  herd-retention.mjs            ratchet-herd retention: prune events.jsonl + herd-escalations.md
  herd-retention.test.mjs       Regression test for herd retention
  herd-verify.mjs               ratchet-herd PR verifier: conflict rework/escalate
  herd-verify.test.mjs          Regression test for herd PR verify
  herd-review.mjs               ratchet-herd review-verdict reactor: changes-requested rework/escalate
  herd-review.test.mjs          Regression test for herd review reactor
  herd-ui.mjs                   ratchet-herd local web dashboard (node:http + SSE)
  herd-ui.test.mjs              Regression test for the herd web dashboard
  herd-notify.mjs               Desktop notifications for new herd escalations
  herd-notify.test.mjs          Regression test for herd escalation notifications
  herd-avatars.mjs              Bundled default mascot avatars for the dashboard
  herd-avatar.test.mjs          Regression test for dashboard adapter avatars
  herd-ui-log-search.test.mjs   Regression test for log drill-down search/filter
  herd-ui-escalation.test.mjs   Regression test for escalation dedup/resolution
  herd-ui-acknowledge.test.mjs  Regression test for escalation copy/acknowledge
  herd-ui-adapter-failures.test.mjs Regression test for per-adapter dispatch-failure aggregation
  herd-ui-summary-strip.test.mjs Regression test for the one-glance fleet-summary strip
  herd-ui-mascot-deck.test.mjs  Regression test for the Active Agents mascot deck
  herd-ui-truthful-tally.test.mjs Regression test for truthful deck header tally and vitals
  herd-ui-vinyl-deck.test.mjs   Regression test for the vinyl-figure pop-out deck revision
  herd-ui-mascot-deck-live.test.mjs Regression test for deck cards tracking live workers
  herd-mascots-install.test.mjs  Regression test for mascots/ install manifest delivery
  manifest-check.mjs            Gate: validate ratchet-manifest.json against the repo (no drift in/out)
  manifest-check.test.mjs       Regression test for the install-manifest gate
  plan-sync-concurrency.test.mjs Workflow concurrency regression test
  plan-sync.mjs                 Deterministic plan→issue compiler
  plan-sync.test.mjs            Regression test for the compiler
  pr-size-check.mjs             Enforce the agent PR size limit in CI
  pr-size-check.test.mjs        Regression test for the size gate
  ratchet-init-skill.test.mjs   Regression test for the init skill contract
  ratchet-metrics.mjs           Read-only loop health metrics
  ratchet-metrics.test.mjs      Regression test for loop metrics
  ratchet-uninstall.sh          Remove exactly what bootstrap.sh installed, per .ratchet-install.json
  ratchet-uninstall.test.mjs    End-to-end test for the manifest-driven uninstaller
  ratchet-update.sh             Pull framework updates, preserve project files
  ratchet-update.test.mjs       Regression test for the updater
  ratchet-watch.mjs             Webhook receiver / event classifier
  ratchet-watch.sh              Real-time GitHub→local bridge
  release.mjs                   Opt-in release tag + changelog publisher
  release.test.mjs              Regression test for releases
   conflicted-prs.mjs            Label conflicted open PRs so reviewers skip them
   conflicted-prs.test.mjs       Regression test for conflicted-PR labeling
   review-verdict.mjs            Flip issue to state:changes-requested on a Request Changes review
   review-verdict-sweep.mjs      Scheduled reconciliation: flip issues the review-verdict event path missed
   review-verdict.test.mjs       Regression test for the review-verdict flip
   review-verdict-sweep.test.mjs Regression test for the review-verdict reconciliation sweep
   review-verdict-workflow.test.mjs  Guards review-verdict.yml's permissions block (contents:read + issues:write)
  run-gates.mjs                 Run GATES.md locally and in CI
  run-gates.test.mjs            Regression test for the gate runner
  skill-parity.mjs              Guard: every skill has agents/openai.yaml + byte-identical .claude/plugin mirrors
  skill-parity.test.mjs         Regression test for the cross-agent parity guard
  state-label-exclusivity.mjs   Enforce one state:* label per issue on a labeled event
  state-label-exclusivity.test.mjs Regression test for state-label exclusivity
  state-instructions-symmetry.test.mjs Regression test that state-set instructions remove the previous label
  sweep-lease.mjs               Shared claim lease freshness rule
  sweep-lease.test.mjs          Regression test for renewable leases
  sweep-stale-claims.mjs        Return abandoned work to the queue
  sweep-stale-claims.test.mjs   Regression test for stale-claim decisions
  unblock-dependents.mjs        Promote issues after blockers close
  unblock-dependents.test.mjs   Regression test for unblock logic
  verify-issue-body.mjs         Trust-boundary check for ratchet-run
  verify-issue-body.test.mjs    Regression test for issue-body verification
  version-consistency.mjs       Version single source of truth + gate: fail a tree whose four version strings disagree
  version-consistency.test.mjs  Regression test for the version-consistency gate
.github/workflows/
   archive-closed-plans.yml      Archive closed-issue plans via an automatic PR
   conflicted-prs.yml            Label conflicted open PRs on a schedule
   plan-sync.yml                 Compile plan/*.md → issues on push
  pr-gates.yml                  Run GATES.md gates and PR size check on agent PRs
  ratchet-run.yml               OPTIONAL CI runner (off by default)
  release.yml                   OPTIONAL release tag + changelog lane
  review-verdict.yml            On a Request Changes review, flip the mapped issue to state:changes-requested
  unblock-dependents.yml        On issue close, promote unblocked dependents
  state-label-exclusivity.yml   On label add, keep one state:* label per issue
  sweep-stale-claims.yml        Return abandoned work to the queue
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
| `/ratchet-status` | When nothing seems ready | Read-only diagnosis of the queue: why nothing is pickable (drafts without criteria, blocked chains, unmerged planning PR) and the next action to unblock. |
| `/ratchet-metrics` | To inspect loop health | Read-only report from GitHub data: cycle time, rework rate, stale-claim sweeps, and queue depth by state. |
| `/ratchet-memory` | Periodically (e.g. quarterly) | Prunes and dedupes `memory/MEMORY.md`, verifies issue/PR links, stops for review. |
| `/ratchet-map` | When structure drifts | Regenerates the coarse codebase map `memory/ARCHITECTURE.md` (language-agnostic), stops for review. |
| `/ratchet-herd` | To run the fleet supervisor | Validates `.ratchet/herd.json` (init hint when missing, starting nothing), then starts `scripts/herd.mjs` if none is running or attaches to a running one and summarizes its state — live workers, attempts, pending escalations. Thin convenience over the script. |
| `/ratchet-update` | To upgrade | Pulls newer framework files onto a review branch; never touches project-owned files. |
| `/ratchet-uninstall` | To remove Ratchet | Removes framework files (keeps your `memory/` and plans by default) and offers GitHub-side cleanup; never deletes issues or branch protection. |

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
| `unblock-dependents` | `issues: closed` | Strips the closed issue's own `state:*` label (closed is terminal; a lingering `state:in-review` misleads), then promotes every issue whose blockers are now all closed to `state:ready`. This re-feeds the queue. |
| `review-verdict` | `pull_request_review: submitted` | Flips the issue mapped to a PR (by `agent/issue-<N>` branch or a `Closes #<N>` body marker) from `state:in-review` to `state:changes-requested` when a Request Changes review is submitted. APPROVED/COMMENTED reviews change nothing; a PR mapping to no issue is a logged no-op. One-directional — the flip back to `state:in-review` after rework stays with the agent (AGENTS.md step 6). |
| `review-verdict-sweep` | every 30 min, or manual | Self-heals `review-verdict` misses: GitHub silently skips `pull_request_review` workflows on conflicted PRs (`mergeable_state: dirty`), so a Request Changes review can land without ever flipping its issue. This sweep walks every open PR, reads its latest review, and flips the mapped issue from `state:in-review` to `state:changes-requested` when the latest verdict is `CHANGES_REQUESTED` — the same self-healing pattern `sweep-stale-claims` and `unblock-dependents` use. APPROVED/COMMENTED latest reviews change nothing; a PR mapping to no issue is a logged no-op; an already-changes-requested issue is left untouched (idempotent); a per-PR API failure is logged and never aborts the rest. The decision logic lives in `scripts/review-verdict-sweep.mjs`; this workflow is only its trigger and env. |
| `conflicted-prs` | every 30 min, or manual | Marks open PRs with merge conflicts (`mergeable_state: dirty`) with a `conflict` label so reviewers can see unmergeable work before spending a review. The label is removed once the PR becomes mergeable again. A PR whose mergeability GitHub has not yet computed (`mergeable: null`) is skipped, not labeled. Idempotent: re-running on an already-labeled conflicted PR changes nothing. All logic lives in `scripts/conflicted-prs.mjs`; this workflow is only its trigger and env. |
| `archive-closed-plans` | daily schedule, or manual | Moves each `plan/*.md` whose issue is closed into `plan/done/` and opens a reviewable PR for the moves — never pushes to `main`. When nothing maps to a closed issue the tree stays clean and no PR is opened. The archive decision lives in `scripts/archive-closed-plans.mjs`; this workflow is only its trigger and the branch/PR plumbing. |
| `state-label-exclusivity` | `issues: labeled` | Enforces that at most one `state:*` label survives on an issue. When a new state label is added, any older state label is stripped — so a missed removal during claim/rework transitions can't leave two state labels side by side. Non-state labels (`priority:*`, etc.) are never touched. All logic lives in `scripts/state-label-exclusivity.mjs`; this workflow is only its trigger. |
| `sweep-stale-claims` | every 30 min, or manual | Patrols `state:in-progress`, `state:in-review`, and `state:changes-requested`. Freshness is the newest proof of life: a branch commit, a claim event, or a heartbeat issue comment containing `<!-- ratchet-heartbeat -->`. Stale zero-commit claims return to `state:ready` and have the orphan ref deleted; committed branches are kept. In-review issues with no live PR are requeued, while merged PRs whose issue stayed open are moved to `state:blocked` for human cleanup. Changes-requested work is requeued only after the inactivity window. Two knobs control the thresholds: `STALE_HOURS` (default `2`) is the inactivity window for `state:in-progress` and `state:in-review`; `REWORK_GRACE_HOURS` (default matches `STALE_HOURS`) is the separate window for `state:changes-requested`, giving rework extra time after a human review. Both are env vars on the workflow. |
| `pr-gates` | agent PR opened, synchronized, or reopened | Runs `scripts/run-gates.mjs` as the `gates` job and `scripts/pr-size-check.mjs` as the `size` job on every `agent/issue-*` PR. Both jobs judge the PR by the **base branch's** `GATES.md`, not the copy the PR ships (see *Security: gate config is judged from the base branch* below). Branch protection should require both contexts. |
| `ratchet-run` | PR merged, or manual | OPTIONAL, off by default. Runs an agent in CI to work the next issue. Requires `RATCHET_AUTO=true` and an agent API key. Before handing work to the agent it verifies the body/title against the reviewed plan, binds the plan marker to the picked issue number, and passes the verified issue body snapshot into the prompt (see *Security* below); most users do not enable this — the local loop (§8) is the recommended path. |
| `release` | manual (`workflow_dispatch`) | OPTIONAL, off by default — the post-merge "ship" stage. Requires `RATCHET_RELEASE=true`. On demand it tags the next semver version (bump chosen at dispatch) and publishes a changelog built from the titles of the PRs merged since the last release. With no merges since the last tag it exits with a "nothing to release" message, not an error. The first release on a repo with no prior tags seeds its version from `.ratchet-version` (the installed framework version) rather than defaulting to `v0.0.1`. Deploy is a second opt-in: set `RATCHET_DEPLOY=true` and `RATCHET_DEPLOY_COMMAND` to a repo-owned shell command. Repos that do not opt in have no deploy job and no deploy config. If deploy fails, the workflow is visibly red after publication; it does not delete or mutate the tag/release. |

The GitHub-mutating workflows read `${{ secrets.FACTORY_PAT || secrets.GITHUB_TOKEN }}`
so they work with the default token and upgrade automatically when the PAT is
set (see §10).

### Security: the unattended runner's trust boundary

The three core workflows (`plan-sync`, `unblock-dependents`, `sweep-stale-claims`)
only move labels and refs — they never execute issue content. `ratchet-run` is
different: it feeds an **issue body** to an agent that holds a **write-scoped
PAT** (contents + pull-requests + issues write). That makes the issue body a
trust boundary, and it is why the runner is **opt-in** (off unless
`RATCHET_AUTO=true`).

- **Threat — issue prompt injection, on every mutable channel.** Issue bodies
  are compiled from plan files that a human reviewed and merged. But anyone with
  issue-write access can edit a body, edit the **title**, or add a **comment**
  *after* compilation, and GitHub issue edits are not code-reviewed. The agent
  the runner launches reads the whole issue — title and comments included — so
  any of these channels can become instructions to an agent that can push
  branches and open PRs: a privilege-escalation path from "can edit an issue" to
  "can run code with the PAT". A fourth channel is the `plan-id` **slug** itself:
  it is attacker-influenced text that flows into a filesystem path.
- **Control — verify against the reviewed plan before acting; neutralise each
  channel.** On each run, after picking the next issue, `ratchet-run` runs
  `scripts/verify-issue-body.mjs`, which fails **closed** on every check:
  - **Body** — must carry a `<!-- plan-id: <slug> -->` marker and still match
    `plan/<slug>.md` on `main` (the reviewed source of truth). The workflow then
    hands the agent the verified issue body snapshot — the exact content captured
    before verification — inside the prompt. A later issue-body edit therefore
    cannot change the instructions the unattended agent executes.
  - **Title** — must still equal the plan file's `title:` frontmatter. An edited
    title fails verification exactly as an edited body does; title text is never
    treated as work instructions.
  - **Slug** — must match the safe slug charset (lowercase letters, digits, and
    hyphen-joined segments). A slug carrying a dot, a slash, `..`, or any other
    character is rejected before it is ever joined into a path, so a crafted
    marker cannot traverse the filesystem to a look-alike plan file — the guard
    fails closed on principle, not by accident.
  - **Issue-number binding** — the `plan-id` slug must be uniquely bound to the
    picked GitHub issue number. If another issue carries the same reviewed marker
    and content, or the slug resolves to a different issue, verification fails
    with an issue/plan mismatch instead of letting issue #A send the agent to
    work plan B on issue #A's branch.
  - **Comments** — have no reviewed source to match against, so they are
    excluded by the runner's **prompt contract**: the "Work the issue" step
    instructs the agent that only the verified body and its plan file are trusted
    instructions and that titles and comments are untrusted display text to be
    obeyed by nothing.

  On any body/title/slug/binding mismatch — missing marker, unsafe slug, missing
  plan file, edited body/title, or marker copied onto the wrong issue — the
  runner comments the specific discrepancy on the issue and **skips it without
  creating a branch or changing code**.
  Restoring the issue to its plan (or re-syncing from the plan file) re-enables
  automation. The bound-changing content lives in reviewed, version-controlled
  files, never in a mutable issue field.
- **Required PAT scopes.** `FACTORY_PAT` is a fine-grained token scoped to this
  repository with **Contents: write** (push branches), **Pull requests: write**
  (open PRs), and **Issues: write** (labels, comments, assignment). Grant no
  more than these, and only to a repo you trust the automation in. The local
  loop (§8) needs no CI secret at all — it runs under your own `gh` auth, which
  is the recommended path for exactly this reason.

### Security: gate config is judged from the base branch

`GATES.md` is itself a trust boundary. The `pr-gates` jobs run the gate commands,
size thresholds, and exclude patterns it declares — so if those jobs read
`GATES.md` from the PR's own checkout, a PR could raise its own size limit, add
an `exclude_paths` covering its files, or blank the gate rows *in the same diff*
and turn both checks green. Checks sold as "binding" would then bind only against
an honest PR.

- **Control — judge by the base copy, never the PR's.** Each `pr-gates` job first
  extracts `GATES.md` from the PR's **base branch** (`git show <base-sha>:GATES.md`)
  into a temp file and passes its path as `BASE_GATES_FILE`. `run-gates.mjs` and
  `pr-size-check.mjs` treat that base copy as the authoritative config; the
  `GATES.md` in the PR's working tree is never used to decide the outcome. A PR
  therefore cannot change what it is judged by — the config that binds it is the
  config already reviewed and merged.
- **When a config change takes effect.** A `GATES.md` edit is judged by the base
  config like any other change and takes effect **only after it merges** — from
  the *next* PR onward, once it is part of the base branch. It never loosens (or
  tightens) the gates for the PR that introduces it.
- **Legitimate changes stay visible.** When a PR does modify `GATES.md`, both
  jobs emit a visible notice in the check output (and the job summary) saying the
  gates ran from the base config and the edit applies only after merge. The
  change is deferred to the human reviewer — flagged, never silently honored and
  never silently ignored. Review the `GATES.md` diff deliberately: it changes how
  *future* PRs are judged.
- **Local runs are unaffected.** `BASE_GATES_FILE` is set only by CI. The local
  verify step (§8, AGENTS.md step 4) runs `run-gates.mjs` against the working
  tree's `GATES.md` exactly as before — there is no base/head split on a
  developer's machine.

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

## Non-functional
- Login response p95 stays under 200 ms in the existing load harness

## Test notes
- Regression-test the lockout path after five failed attempts
```

`title` and `priority` are required. A file with at least one `- [ ]` acceptance
criterion becomes `state:ready`; without criteria it becomes `state:draft` and
no agent picks it. `blocked_by` slugs are resolved to `Blocked by #N` lines, and
an issue with any open blocker is `state:blocked`. Resolution is
order-independent — the sync creates issues for new files before rendering any
body, so a blocker on a brand-new file resolves on the first run, and a slug
that matches nothing is a loud `WARNING`, never a silent drop. The file owns issue *content*;
once an issue leaves `ready`/`draft`, sync stops touching it so live work is
never clobbered.

Optional `## Non-functional` and `## Test notes` sections are copied into the
issue body. They let a plan require performance, accessibility, migration, edge
case, regression, or integration coverage beyond the acceptance-criteria
checkboxes without making those extra checks look like readiness criteria.

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

- **Approve → merged:** it syncs to the merged code from the shared clone,
  which always sits on `main` (`git fetch && git pull --ff-only` — no checkout),
  removes the finished issue's worktree, and starts the next
  ready issue — in a fresh worktree (`git worktree add ../wt/issue-<N>
  agent/issue-<N>`). Because this happens *after* the merge, the new branch is
  always based on current `main` — the stale-base problem cannot occur.
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

Ratchet installs from a pinned release via `scripts/bootstrap.sh`, run from
inside your project's git repo. It downloads the tag you name, reads
`ratchet-manifest.json` at that ref, and copies in only the `framework` files
your chosen profile(s) select — it never creates GitHub labels, secrets, or
branch protection, and never touches `.env` or other local secrets (they
aren't in the manifest, so they're never selected).

1. **Download, inspect, then run it** — the safe default for anything piped
   into `bash`:
   ```
   curl -fsSL https://raw.githubusercontent.com/praveenvijayan/Ratchet/<tag>/scripts/bootstrap.sh -o bootstrap.sh
   less bootstrap.sh          # read it before you run it
   bash bootstrap.sh --version <tag> --profile core
   ```
   Or, once you trust the source, the one-line convenience form — **always
   pin a real release tag**; `--version main` installs but warns it is not
   reproducible, so avoid piping an unpinned ref straight into `bash`:
   ```
   curl -fsSL https://raw.githubusercontent.com/praveenvijayan/Ratchet/<tag>/scripts/bootstrap.sh | bash -s -- --version <tag>
   ```
   `--dry-run` reports what would change without writing anything; an
   existing file blocks the install until you pass `--force`.
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

### Manifest classifications and profiles

`ratchet-manifest.json` is the single source of truth for what an install
ships. Every path is classified:

| Class | Meaning |
|-------|---------|
| `framework` | Ratchet-owned; safe to overwrite on `/ratchet-update`. Each entry also names the profile that ships it. |
| `generated` | Scaffolded once by `bootstrap.sh` into the host project (e.g. `GATES.md`, `memory/`, `.env.example`); never overwritten again. |
| `excluded` | Never shipped to a host project at all (tests, plan content, this repo's own README/DOCS/branding). |

`core` is always installed. `--profile` adds any of:

| Profile | Installs |
|---------|----------|
| `watcher` | The local real-time watcher (`scripts/ratchet-watch.*`) that turns a human's merge/review into a `/ratchet-next` trigger. Needs an authenticated `gh`. |
| `release` | Versioned-release tooling (`release.mjs` + `release.yml`) for teams that cut tagged Ratchet releases. |
| `herd` | The headless fleet supervisor (`herd*.mjs` + the `ratchet-herd` skill) that dispatches and monitors multiple agents at once. |
| `unattended-ci` | The optional CI-based runner (`ratchet-run.yml`) for unattended execution. Off by default. |
| `claude-plugin` | Claude Code plugin packaging (`.claude-plugin/`, `plugin/.claude-plugin/`) so Ratchet can ship through the plugin marketplace. |

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

## 11. Updating and uninstalling Ratchet

Repos installed via `scripts/bootstrap.sh` do not auto-update — upgrading is a
deliberate, zero-merge command. `scripts/ratchet-update.sh` is manifest- and
profile-aware: it reads `ratchet-manifest.json` at the target ref and pulls
only the `framework` files for the profile(s) recorded at install time in
`.ratchet-install.json` — never the whole tree, and never `generated`/
project-owned paths (they are never selected).

```
/ratchet-update           # pull upstream main onto a review branch
/ratchet-update v1.2.0    # or a specific released tag (must exist upstream)
```

It checks each recorded framework path against the content hash it saved the
last time it wrote that path. A path the host has locally modified since
install is skipped and listed, not silently overwritten — pass `--force` to
replace it anyway. A clean run refreshes the selected framework files,
re-syncs the skill mirrors, bumps `.ratchet-version` and the install record,
and stops for you to review the diff and open a PR. It never touches:

| Preserved (never touched) |
|----------------------------|
| `GATES.md` (config), `memory/` (`USER.md`, `ARCHITECTURE.md`, `MEMORY.md`) |
| your `plan/*.md` issue files |
| `.env`, `.env.example`, `README.md`, `LICENSE`, `.gitignore`, your code |

`.ratchet-version` records the installed version. Pinning an update to a tag
(`/ratchet-update v1.2.0`) only works for a version the upstream has actually
released; those tags are cut by the opt-in release lane (§6), which creates each
one idempotently. Until a release is cut there may be no tags to pin to, so plain
`/ratchet-update` tracks `main`.

### Uninstalling Ratchet

`scripts/ratchet-uninstall.sh` removes exactly what `bootstrap.sh` recorded in
`.ratchet-install.json` — dry-run by default, `--yes` to apply:

```
/ratchet-uninstall                  # or: ./scripts/ratchet-uninstall.sh --yes
```

- A recorded `framework` file the host has locally modified since install
  (hash mismatch) is **kept**, not removed.
- `generated` files (`GATES.md`, `memory/`, `.env.example`, `.ratchet-version`,
  skill mirrors) are **kept** unless you pass `--purge-memory` (removes
  `memory/`) or `--purge-generated=path,path` (removes any named path).
- `plan/*.md` (your issue specs) is **kept** unless you pass `--purge-plans`.
- `.env` is never removed.
- GitHub-side state — issues, labels, secrets, branches, branch protection —
  is never touched; the script prints the `gh` commands to remove them by
  hand if you want them gone too.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Dotfolders (`.github`, `.agents`, `.claude`) missing after upload | macOS Finder hides dotfiles, so a browser drag-and-drop skips them | Upload via `git` (`cp -R src/. .` copies hidden files), never the web file picker |
| Dependents don't become `state:ready` after a merge | `FACTORY_PAT` not set, so workflow-chaining is blocked | Set the `FACTORY_PAT` secret (§10) |
| Agent's PR conflicts / re-does merged work | Branched from a stale base | The claim now creates the ref from the server's current `main` SHA, and the local copy syncs `--ff-only` before building; ensure you're on the current framework (`/ratchet-update`) |
| `/ratchet-init` doesn't create `GATES.md` | Legacy repo created before the GATES extraction; gates still inline in `AGENTS.md` | `/ratchet-update` to get the new `AGENTS.md`, then `/ratchet-init` to write `GATES.md` |
| Agent pauses and asks "shall I start?" | Claim-step autonomy not in older `AGENTS.md`, or tool needs permission for `gh`/`git` | Update via `/ratchet-update`; grant the agent standing `Bash(gh:*)` / `Bash(git:*)` permission |
| Watcher receives nothing | `gh webhook forward` needs the `cli/gh-webhook` extension and a running receiver | `ratchet-watch.sh` installs the extension and starts the receiver; check it's still in the foreground |
| `ratchet-run` workflow does nothing | It is off by default | Set repo variable `RATCHET_AUTO=true` and an agent API key — only if you want CI execution |
| "Backlog drained" but you have work | Issues are `state:draft` (no acceptance criteria) or `state:blocked` on a draft, or the planning PR isn't merged so no issues exist yet | Run `/ratchet-status` — it names the exact cause and the next action. Usually: add `- [ ]` criteria to the plan files and merge the planning PR |

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
/ratchet-status                    # why is nothing ready? (read-only diagnosis)

# Maintain
/ratchet-memory                    # prune memory/MEMORY.md
/ratchet-map                       # regenerate memory/ARCHITECTURE.md
/ratchet-update [vX.Y.Z]           # upgrade the framework
/ratchet-uninstall                 # remove Ratchet (files via PR; data kept by default)

# Fleet supervisor (optional, ratchet-herd)
node scripts/herd.mjs init         # write a default .ratchet/herd.json
node scripts/herd.mjs run          # survey → monitor → verify → review → retention → dispatch, one issue per worker
```

---

## 14. The herd supervisor (`ratchet-herd`)

`ratchet-herd` is an **optional**, headless fleet supervisor: it runs the loop
of §2 across *many* issues at once by launching one agent CLI per ready issue,
watching each worker to a PR, and escalating anything it cannot resolve to a
human. It is a convenience layer on top of the same GitHub-native protocol —
nothing else in Ratchet depends on it, and a single agent driving `/ratchet-next`
by hand needs none of it. The supervisor lives in `scripts/herd*.mjs` and, like
the rest of the framework, is **project-agnostic and pure**: which agent CLIs
exist, their flags, prompt wording, and environment are never in the code — they
live entirely in one per-operator config file, `.ratchet/herd.json`.

### The config file: `.ratchet/herd.json`

Created by `node scripts/herd.mjs init` (which refuses to overwrite an existing
file) and edited by hand. Running the supervisor with no config exits non-zero
with a one-line hint to run `init`. Because it sits under the gitignored
`.ratchet/` directory, it is local to each operator — like `.env`, it is
configuration, not committed framework.

```jsonc
{
  // Optional top-level knobs — omit any to take the default shown.
  "maxWorkers": 3,              // most workers alive at once (one issue each)
  "pollSeconds": 60,            // seconds between survey passes
  "reworkCap": 2,               // resume attempts before an issue is escalated, never retried again
  "logDir": ".ratchet/logs",    // where per-worker logs are written
  "claimTimeoutSeconds": 300,   // how long to wait for a worker to create its claim ref before killing it as dispatch-failed
  "logRetentionDays": 14,       // days a worker log survives after its worker is gone; the poll prunes older logs whose issue has no live worker

  // Required. Each key is an adapter *name* (a CLI, never a model).
  "adapters": {
    "claude": {
      "launch": ["claude", "-p", "--dangerously-skip-permissions", "{prompt}"],
      "promptTemplate": "Issue {issue} is your entire assignment: take only issue {issue} to a PR, following AGENTS.md. Skip AGENTS.md's pick step — do not survey the ready queue, and never claim, work on, or fall through to any other issue. An existing agent/issue-{issue} branch is your own prior claim on this same assignment: resume it under AGENTS.md's resume rules, never as a foreign claim to exit or fall through from. If issue {issue} already has a pull request opened by someone else, exit immediately without touching any branch, worktree, or other issue.",
      "env": {}
    },
    "codex": {
      "launch": ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "{prompt}"],
      "promptTemplate": "Issue {issue} is your entire assignment: take only issue {issue} to a PR, following AGENTS.md. Skip AGENTS.md's pick step — do not survey the ready queue, and never claim, work on, or fall through to any other issue. An existing agent/issue-{issue} branch is your own prior claim on this same assignment: resume it under AGENTS.md's resume rules, never as a foreign claim to exit or fall through from. If issue {issue} already has a pull request opened by someone else, exit immediately without touching any branch, worktree, or other issue.",
      "env": {}
    }
  },

  // Required. Which adapter handles an issue.
  "routing": {
    "default": "claude",         // used when no label matches; must name a defined adapter
    "labels": { "rust": "codex" }// optional label → adapter overrides
  }
}
```

Malformed JSON, an empty `adapters` object, or `routing` without a valid
`default` each exit non-zero with a one-line error naming the file and the
problem — no stack trace ever reaches the operator.

### The adapter contract

An adapter tells the supervisor how to start and restart one worker CLI:

- **`launch`** (required) — a non-empty command array, run to start a worker on
  a fresh issue. A herd worker is non-interactive, so a headless CLI must run
  with its permission/approval prompts bypassed — otherwise the claim step
  (which touches `.git`) blocks on a prompt nobody can answer, the worker never
  creates its claim ref, and the supervisor kills it at `claimTimeoutSeconds` as
  `dispatch-failed`. The shipped `claude` and `codex` defaults carry the right
  flag (`--dangerously-skip-permissions` and
  `--dangerously-bypass-approvals-and-sandbox`). Loading a `claude` or `codex`
  adapter whose `launch` omits that flag prints a one-line `WARNING` and
  continues — a config predating this default only needs the flag added by hand.
  A custom adapter is never second-guessed.
- **`resume`** (optional) — the command array used to nudge an existing worker's
  issue forward after a rework signal. **Omit it and the adapter resumes exactly
  the way it launches** — `resume` defaults to `launch`.
- **`promptTemplate`** (optional string) — the instruction handed to the worker.
  The supervisor renders it, then substitutes the result wherever the command
  array contains `{prompt}`. The default pins the worker to the dispatched issue:
  it is that worker's entire assignment, so the worker skips AGENTS.md's pick
  step and never falls through to another issue (a fall-through leaves the
  dispatched issue's claim ref uncreated, so the supervisor SIGTERMs the worker
  at `claimTimeoutSeconds`). **Changing `defaultConfig()` only affects future
  `herd init` runs** — an existing `.ratchet/herd.json` keeps whatever template
  it was created with, so update the `promptTemplate` in yours by hand to pick
  up this behaviour.
- **`env`** (optional object) — see the env passthrough below.

**Substitution is deliberately tiny: only `{prompt}` and `{issue}` are
replaced**, in both prompt templates and command arrays. `{issue}` becomes the
issue number; `{prompt}` becomes the rendered `promptTemplate`. **Every other
brace token — `{model}`, `{branch}`, `${SHELL_VAR}` — passes through
byte-for-byte**, so an adapter can carry literal braces a CLI needs without the
supervisor mangling them.

### Env passthrough — routing workers through a local proxy

Each adapter's `env` map is merged into that worker's process environment
**untouched** (over the supervisor's own environment); Ratchet never reads or
interprets a value. This is the seam for anything a worker needs in its
environment but the framework should stay ignorant of — for example, routing a
worker's traffic through a local proxy by pointing the standard proxy variables
at it:

```jsonc
"adapters": {
  "claude": {
    "launch": ["claude", "-p", "--dangerously-skip-permissions", "{prompt}"],
    "env": {
      "HTTPS_PROXY": "http://127.0.0.1:8080",
      "HTTP_PROXY": "http://127.0.0.1:8080"
    }
  }
}
```

The supervisor forwards these verbatim; naming and running the proxy is entirely
the operator's business.

### A fallback adapter: opencode via OpenRouter

`claude` and `codex` are API-key CLIs; when neither is installed an operator can
keep the herd moving by falling back to [opencode](https://opencode.ai) driven
through [OpenRouter](https://openrouter.ai). opencode gives the worker the same
first-class terminal, filesystem, and git access the AGENTS.md protocol needs,
and OpenRouter turns a capable model into an `OPENROUTER_API_KEY`-gated backend —
exactly the `requiresEnv` availability gate above. Add this adapter and put it
last in the route so it only runs when the preferred CLIs are unavailable:

```jsonc
"adapters": {
  // ... your "claude" and "codex" adapters ...
  "opencode": {
    // `run` is opencode's non-interactive (headless) subcommand; {model} is
    // pinned below and {prompt} is the rendered dispatch instruction.
    "launch": ["opencode", "run", "--model", "openrouter/{model}", "{prompt}"],
    // Pin a capable model — a weak one will not drive the AGENTS.md protocol.
    "model": "anthropic/claude-3.5-sonnet",
    // opencode reaches OpenRouter through this key; unset ⇒ adapter unavailable.
    "requiresEnv": ["OPENROUTER_API_KEY"]
    // promptTemplate omitted here for brevity — carry the same dispatch
    // instruction the "claude"/"codex" adapters above use, or the worker is
    // dispatched with an empty prompt.
  }
},
"routing": {
  // Try claude, then codex, then fall back to opencode — the first adapter
  // whose binary is on PATH and whose requiresEnv vars are all set wins.
  "default": ["claude", "codex", "opencode"],
  "labels": {}
}
```

**opencode must run fully non-interactive.** `opencode run` is opencode's
headless mode — unlike the interactive TUI it presents no approval dialog. Just
as the shipped `claude` and `codex` adapters carry
`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`,
the opencode worker must execute git, shell, and filesystem actions **without
pausing for a permission or approval prompt**; configure opencode's permissions
to run autonomously. If it blocks on a prompt nobody can answer, the claim step —
which touches `.git` — never completes, the worker never creates its
`agent/issue-<N>` claim ref, and the supervisor kills it at
`claimTimeoutSeconds` as `dispatch-failed` (**the headless-claim failure mode**
described under the adapter contract above).

Availability then decides dispatch with no framework change: with
`OPENROUTER_API_KEY` unset (or the `opencode` binary missing) opencode is
unavailable, so the route dispatches no opencode worker; and when `claude` and
`codex` are both absent from `PATH` but `OPENROUTER_API_KEY` is set, the same
route dispatches the opencode worker. `scripts/herd.mjs` never names opencode or
OpenRouter — they live only in this config.

### Escalations: `.ratchet/herd-escalations.md`

When the supervisor cannot resolve something on its own, it **escalates instead
of improvising**: it appends a factual, human-readable block to
`.ratchet/herd-escalations.md` and leaves the decision to a person. Each block
has a fixed shape:

```markdown
## 2026-07-09T11:00:01.000Z — issue #142
- What happened: worker exited 0 but opened no PR
- Log file: .ratchet/logs/issue-142.log
- Suggested action: review the log and re-queue the issue if its work is unfinished
```

Escalation triggers include: a worker that exits without opening a PR (its log
tail is quoted), a worker that does not create its claim ref
(`agent/issue-<N>`) within `claimTimeoutSeconds` — killed and marked
dispatch-failed, its log named — an issue that has hit `reworkCap` (never
retried again), an adapter that has disappeared from the config, and any case
where reconciled reality contradicts the state file. The runtime state the supervisor rebuilds
each pass lives in `.ratchet/herd-state.json` — an issue→worker map (adapter,
pid, log file, attempts, status, PR) reconciled against `gh` and process
liveness every poll, so a stale pid or a concluded PR can never masquerade as a
live worker.

### Log retention: bounding `logDir` growth

Worker logs append per dispatch and per resume, and stream-json adapters
multiply their size, so an unpruned `logDir` grows without bound. Each poll
deletes `*.log` files older than `logRetentionDays` (default 14) whose issue has
**no live worker** in the state file; a log of a still-running worker is kept
regardless of age. The poll summary line reports how many logs it pruned that
pass, and every filesystem hiccup is swallowed so log hygiene never crashes a
poll. Set `logRetentionDays` in `.ratchet/herd.json`; a non-positive or
non-integer value is rejected on load with a one-line error naming the file and
field.

The same `logRetentionDays` window bounds the two other append-only files —
`events.jsonl` and `herd-escalations.md` — via the `retention` stage
(`scripts/herd-retention.mjs`), which runs every poll (dry-run included, like log
pruning). An event line older than the window is dropped unless its issue still
has a live worker, whose history is kept regardless of age; an undated or
unparseable line is always kept. An escalation block is dropped only when it is
**both** older than the window **and** resolved per the same model the dashboard
uses (a stale-claim escalation whose ref is gone, or a PR-concluded escalation
whose issue has since closed) — an unresolved escalation never ages out, so a live
alert is never lost. Blocks are sliced from the raw text, so multi-line log tails
survive verbatim. The stage reports how many event lines and escalation blocks it
pruned on its poll summary line.

### Events: `.ratchet/events.jsonl`

The supervisor also appends machine-readable lifecycle events to
`.ratchet/events.jsonl`. This is the stable source for dashboards,
notifications, and metrics; adapter logs remain drill-down detail, not state.
Each line is one JSON object with:

- `ts` — ISO-8601 timestamp.
- `event` — one of `dispatch`, `resume`, `rework`, `claim-detected`,
  `pr-detected`, `worker-exit`, `worker-kill`, `escalation`.
- `issue` — issue number.
- Worker-scoped fields when known: `adapter`, `pid`, `logFile`, `attempts`,
  plus `pr` or `status` when relevant.

The file is append-only across supervisor restarts. If writing the event stream
fails, the supervisor prints one warning naming `.ratchet/events.jsonl` and
keeps polling; observability must never stop dispatch.

### Reacting to review verdicts

Verification ends a worker at the terminal status `ready-for-review`, and nothing
reopens it — so in chat mode a human notices a Request Changes review and runs
`/ratchet-next` to rework it, but a headless herd worker has already exited. The
`review` stage (`scripts/herd-review.mjs`, last in each poll) plays that human
role: it reads the `reviewDecision` of every tracked, ready-for-review PR and, on
`CHANGES_REQUESTED`, dispatches exactly one rework worker on the issue's existing
branch, its prompt pointing at the PR's review feedback. The rework counts against
the same `reworkCap` as conflict rework and monitor resume; at the cap the PR is
escalated naming it and the cap, never re-dispatched.

The stage is detection + dispatch only — it never sets a label. The review-time
flip to `state:changes-requested` is owned by the `review-verdict` workflow, and
the flip back to `state:in-review` is the dispatched worker's own last step
(AGENTS.md step 6). That label is the reactor's dedup: a `reviewDecision` stays
`CHANGES_REQUESTED` until a new review is submitted, so it does not change when the
rework lands; the reactor dispatches only while the issue still carries
`state:changes-requested`, and stands down once the worker flips it back. A live
rework worker on the entry is never dispatched twice, and a transient failure
reading the verdict leaves every entry untouched for the next poll.

### Supervisor invariants

These hold no matter what the config says:

- **It never merges, approves, closes, or labels** a PR or an issue. Every one
  of the two human jobs — writing plans and reviewing PRs — stays with the
  human. The supervisor only observes, dispatches, and escalates.
- **One issue, one worker.** At most `maxWorkers` run at once, and each owns a
  single issue; dispatch uses the same server-side branch-ref claim as a solo
  agent (§2), so two workers can never collide on one issue.
- **Escalation over improvisation.** When reality and the state file disagree,
  or a worker's outcome is ambiguous, the supervisor writes an escalation for a
  human rather than guessing.
- **A dispatch is a human handoff.** A worker the supervisor launches onto an
  issue treats the prompt it received as an explicit human handoff for the
  ownership rule (see AGENTS.md step 2) — the operator who started the
  supervisor is delegating that issue through it.

---

## 15. Glossary

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
