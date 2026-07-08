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
- (e.g.) Auth standardized on JWT after rejecting sessions — see #142.
- `scripts/criteria.mjs` is the single "has acceptance criteria" rule, shared by
  `plan-sync.mjs` and the `unblock-dependents` workflow so promote-vs-hold can
  never diverge from what the compiler decided at creation (#5).

## Gotchas & fragile areas
- (e.g.) Payments module has no test harness; integration tests hit the sandbox API (#88).

## Environment & operational facts
- (e.g.) CI requires Node 20; the build OOMs under 4 GB runners (PR #210).

## Recurring patterns
- (e.g.) New API routes follow the handler/validator/service split in `src/api/` (#175).
