<!--
MAP.md — the coarse repository map a worker reads FIRST, before exploring. One
file read replaces the grep-crawl agents otherwise spend their earliest turns on.
Machine-oriented and provisional: when it disagrees with the code, the code wins.
Paths are repo-relative and staleness-checked in CI (see the map-onboarding gate);
a listed path that no longer exists fails the build.
-->

# Repository map

_Generated 2026-07-13. Regenerate with the `ratchet-map` skill (it refreshes the
coarse repo map); keep the listed paths current or the map-onboarding gate fails._

Ratchet is a framework- and project-agnostic continuous-delivery safety kernel:
markdown contracts plus zero-dependency Node scripts. There is no application
source tree — the "product" is the operating manual and the tooling that enforces
it. Start with the contracts, then the scripts that back them.

## Contracts (read these to know the rules)

- `AGENTS.md` — the always-loaded safety kernel: the loop, ownership, scope, and
  safety invariants. The single source of truth for how to work here.
- `GATES.md` — the verification gates (commands, order) run before every PR.
- `DOCS.md` — system internals: workflows, the herd supervisor, deeper explainers.
- `README.md` — project overview and entry point.
- `plan/` — human-authored plan files; `plan/README.md` documents their format.
- `memory/` — curated memory read every issue: `memory/USER.md` (human-owned),
  `memory/MEMORY.md` and `memory/ARCHITECTURE.md` (agent-maintained via PRs).

## Tooling (`scripts/` — zero-dependency Node, one JSON line per command)

- `scripts/` — every deterministic command and its `*.test.mjs` gate.
- `scripts/ratchet-start.mjs` — the loop commands: claim, requeue, heartbeat,
  submit (siblings `ratchet-requeue.mjs`, `ratchet-heartbeat.mjs`,
  `ratchet-submit.mjs`).
- `scripts/herd.mjs` — the ratchet-herd supervisor: survey, dispatch, monitor,
  verify, review, plus the `herd-ui.mjs` local dashboard (all `herd-*.mjs`).
- `scripts/run-gates.mjs` — runs the `GATES.md` gates fail-fast; `plan-sync.mjs`,
  `release.mjs`, and the `sweep-*.mjs` scripts drive the rest of the automation.

## Skills and packaging

- `.agents/skills/` — the canonical skills (edit here, then run `setup.sh`).
- `.claude/skills/` and `plugin/skills/` — generated mirrors; never edit directly.
- `setup.sh` — mirrors the canonical skills to each tool's expected location.
- `.github/workflows/` — the event-driven CI that backstops the handoff.
- `.claude-plugin/marketplace.json` — plugin/marketplace prose.
- `ratchet-manifest.json` — per-file classification the manifest gate checks.
