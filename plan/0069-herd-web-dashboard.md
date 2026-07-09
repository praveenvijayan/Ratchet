---
title: Local web dashboard for the herd (scripts/herd-ui.mjs)
priority: medium
labels: [herd]
blocked_by: [0068-herd-events-jsonl]
---

Herd workers run headless (`-p` CLIs), so the operator has no live view of
what is running, stuck, or escalated. A dependency-free local web dashboard —
one Node script serving inline HTML over `node:http` with server-sent events —
renders fleet state from `.ratchet/events.jsonl`, `.ratchet/herd-state.json`,
and `.ratchet/herd-escalations.md`, with per-worker log drill-down. Browser
over TUI: clickable PR links, real scrollback, no terminal constraints, zero
new dependencies.

## Acceptance criteria
- [ ] `node scripts/herd-ui.mjs` serves the dashboard on a local port (flag-overridable default) and prints the URL on start
- [ ] The dashboard lists each worker with its issue number, status, adapter, attempt count against `reworkCap`, claim age against `claimTimeoutSeconds`, and a clickable PR link once one exists
- [ ] Pending escalations from `.ratchet/herd-escalations.md` render at the top of the page, above the worker list
- [ ] Selecting a worker live-tails its log file; only the selected worker's log is streamed, and updates are incremental reads, never a full re-read of the file
- [ ] New events appear in the dashboard without a manual page reload
- [ ] Missing events, state, or escalations files render an empty dashboard with a one-line hint to start the herd — never an error page or a crash
- [ ] A port already in use exits non-zero with a one-line error naming the port
- [ ] Every criterion above has exactly one test named after it

## Non-functional
- Zero new runtime dependencies: Node stdlib only (`node:http`, `node:fs`), inline HTML/CSS/JS, no build step — same purity bar as the other `scripts/*.mjs`
- Server binds localhost only; logs and code diffs never leave the machine

## Notes
Worker state comes from the event stream and state file (adapter-agnostic),
never from parsing adapter log formats; raw logs are display-only drill-down.
