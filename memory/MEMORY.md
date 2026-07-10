<!--
MEMORY.md — distilled project knowledge. A CACHE, NOT A LOG.

Rules:
- The agent PROPOSES entries here as part of a PR; a human approves them on merge.
  Never write to this file silently.
- An entry earns its place only if it saves a future agent from re-reading
  history. Raw detail lives in issues/PRs/commits — link to them, don't copy them.
- Each entry is 1–2 lines and cites its source: (#123) or (PR #456).
- Keep it small and current. Prune obsolete entries with /ratchet-memory — the
  full history in closed issues/PRs/git means pruning never loses information.
- Group by area. If this file outgrows ~300 lines, that's a signal to compact.
-->

# Project memory

## Architecture & decisions
- Gate commands have one source of truth: `scripts/run-gates.mjs` parses the
  `GATES.md` table; both local verify and the `pr-gates` CI check call it, so
  they can't drift. TODO rows are skipped, not passed (#9).
- (e.g.) Auth standardized on JWT after rejecting sessions — see #142.
- `scripts/criteria.mjs` is the single "has acceptance criteria" rule, shared by
  `plan-sync.mjs`, the `unblock-dependents` workflow, and `sweep-stale-claims`
  (via `classifyRequeue`) so promote/requeue-vs-hold can never diverge from what
  the compiler decided at creation (#5, #54).
- `sweep-stale-claims` re-reads each issue at write time before relabelling: if
  its state label changed since the initial listing the sweep skips it (never
  clobbers a concurrent transition), and it gates the requeue on the freshly
  read body — a claim that lost its criteria is held at `state:draft`, not
  re-exposed as `state:ready` (#54).
- `ratchet-run` treats the whole issue as a trust boundary, not just the body:
  `scripts/verify-issue-body.mjs` fails closed on edited body/title, unsafe
  `plan-id` slug, or slug/issue-number mismatch; the workflow passes the
  verified body snapshot into the prompt so later issue edits cannot change
  instructions. Comments stay untrusted prompt-contract text (#17, #55, #86).
- Claim leases are renewable: an agent posts a heartbeat comment
  (`<!-- ratchet-heartbeat -->`) during long builds; `sweep-stale-claims` times
  freshness from the newest of commit/heartbeat/claim via `scripts/sweep-lease.mjs`,
  so a live-but-quiet claim outlives `STALE_HOURS` but a crashed one is still swept (#8).
- Closed-issue plan hygiene is automatic: `.github/workflows/archive-closed-plans.yml`
  runs `archive-closed-plans.mjs` on a daily schedule and lands the moves as a PR
  from the stable `chore/archive-closed-plans` branch — never a push to main; a
  clean sweep (nothing maps to a closed issue) opens no PR (#51).
- `ratchet-metrics` derives loop health read-only from issue timelines: "merged"
  = issue closed with `state_reason: completed`; cycle time = first `state:ready`
  label → that close; sweeps are counted from `sweep-stale-claims`'
  `Stale claim swept:` comment marker. Engine `scripts/ratchet-metrics.mjs` (#40),
  skill (#20).
- The review-time label flip is system-closed: `review-verdict` (triggered on
  `pull_request_review: submitted`) is the single owner of the
  in-review → changes-requested transition; herd's supervisor and chat agents
  rely on it rather than duplicating the check. One-directional — the flip back
  to in-review after rework stays with the agent (#197).
- `ratchet-manifest.json` classifies every `scripts/` file individually (no
  globs): runtime scripts are `framework`+profile, tests and dev helpers are
  `excluded`. `scripts/manifest-check.mjs` gates both directions: a runtime
  script classified `excluded` fails (breaks shipped workflows), and a test
  file classified `framework`/`generated` fails (leaks tests to hosts) (#237).

## Gotchas & fragile areas
- (e.g.) Payments module has no test harness; integration tests hit the sandbox API (#88).
- Escalation acknowledgements persist in `.ratchet/herd-resolutions.jsonl` (one
  JSON object per line: `{ issue, reason, ts }`). The dashboard's acknowledge
  button only appends to this file — it never executes commands or mutates the
  escalations log, git refs, issues, or PRs. `resolveEscalations` derives
  resolved state from the state file, closed issues, AND the acknowledged set
  (#180).
- `scripts/*.test.mjs` per-criterion self-counts must derive from their own
  `Criterion N` markers and never read a closable issue's `plan/NNNN-*.md` at
  runtime — `archive-closed-plans` moves those files to `plan/done/` on close,
  which would break the test. A regression guard in `docs-refresh.test.mjs`
  greps every test source for a repo-plan-dir read + a `NNNN-` slug and fails
  (#191). Temp-dir fixtures and `plan/README.md` are exempt.
- `archive-closed-plans` archives a slug only when it has ≥1 issue and *every*
  issue bearing that `plan-id` marker is closed — one open issue vetoes the move
  (a duplicate/split marker must not let a closed twin archive live work). It
  also refuses to `rename` over an existing `plan/done/` file (POSIX rename
  overwrites silently), naming both paths and exiting non-zero (#50).

## Environment & operational facts
- (e.g.) CI requires Node 20; the build OOMs under 4 GB runners (PR #210).
- Project-local agent sessions use RTK command filtering to reduce shell-output
  token use; keep this guidance in project memory, not in the reusable
  `AGENTS.md` operating manual (#233).

### RTK (Rust Token Killer) command guidance

When running shell commands, always prefix with `rtk`. This reduces context
usage by 60-90% with zero behavior change. If RTK has no filter for a command,
it passes through unchanged, so it is always safe to use.

Key commands:

```bash
# Git (59-80% savings)
rtk git status          rtk git diff            rtk git log

# Files & Search (60-75% savings)
rtk ls <path>           rtk read <file>         rtk grep <pattern>
rtk find <pattern>      rtk diff <file>

# Test (90-99% savings) - shows failures only
rtk pytest tests/       rtk cargo test          rtk test <cmd>

# Build & Lint (80-90% savings) - shows errors only
rtk tsc                 rtk lint                rtk cargo build
rtk prettier --check    rtk mypy                rtk ruff check

# Analysis (70-90% savings)
rtk err <cmd>           rtk log <file>          rtk json <file>
rtk summary <cmd>       rtk deps                rtk env

# GitHub (26-87% savings)
rtk gh pr view <n>      rtk gh run list         rtk gh issue list

# Infrastructure (85% savings)
rtk docker ps           rtk kubectl get         rtk docker logs <c>

# Package managers (70-90% savings)
rtk pip list            rtk pnpm install        rtk npm run <script>
```

Rules:

- In command chains, prefix each segment: `rtk git add . && rtk git commit -m "msg"`.
- For debugging, use raw commands without the `rtk` prefix.
- `rtk proxy <cmd>` runs a command without filtering but tracks usage.

## Recurring patterns
- (e.g.) New API routes follow the handler/validator/service split in `src/api/` (#175).
