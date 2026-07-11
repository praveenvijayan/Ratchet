---
title: Herd dashboard Santorini reskin — foundation (palette, type, header, grid)
priority: medium
labels: [herd, dashboard, design]
blocked_by: []
---

The herd dashboard (`scripts/herd-ui.mjs`) works but its visual design is ad
hoc. A finished design exists — "Herd Dashboard Santorini" in the Claude Design
project — and the dashboard should follow it. The full reskin is too large for
one review-sized PR, so it is split into three slices that land in order. This
**foundation** slice lays the design tokens and page chrome every later slice
builds on: the palette, the type system, the header, and the two-column grid
shell. The section-heading pattern and content cards come in `0121`; the
incidents aside and log console come in `0122`; the Active Agents mascot deck is
separate again (`0120`).

## Acceptance criteria
- [ ] Dashboard page defines the Santorini palette as CSS custom properties (`--paper:#e4e3f5`, `--paper-hi:#f4f2fc`, `--paper-lo:#d7d4ee`, `--ink:#3f3e78`, `--ink-deep:#2b2a58`, `--terra:#7c68c4`, plus the soft/faint/hair ink alphas) and uses them for the page background, text, and borders
- [ ] Type system follows the design: Marcellus for display headings, Space Grotesk for body, Space Mono for labels/metrics — every `font-family` declaration ends in a generic fallback (`serif`/`sans-serif`/`monospace`) so the page still renders correctly when the fonts CDN is unreachable (the fonts `<link>` is the only external reference and its failure must not block rendering)
- [ ] Header renders the brand block (serif "Herd Dashboard" title with "Santorini" ordinal) and a right-aligned heartbeat: pulsing dot, supervisor liveness text, and time since last heartbeat, keeping the existing heartbeat states (live / silent / not-seen)
- [ ] Main content is a two-column grid (work column + 400px incidents aside) that collapses to a single column below 1180px viewport width, with the existing errors-panel toggle behaviour intact
- [ ] Every criterion above has exactly one test named after it

## Non-functional
- Pure reskin: all existing dashboard behaviour keeps working and the existing herd-ui test suites (`herd-ui`, `herd-ui-*`, `herd-avatar`) stay green
- No new runtime dependency and no build step: the dashboard stays a single self-contained server-rendered page

## Notes
Design source of truth: Claude Design project `040de050-b19a-4271-bf65-d8fa03b3c6f6`,
file `Herd Dashboard Santorini.html`. Retrieve it via the claude_design MCP
(`https://api.anthropic.com/v1/design/mcp`, auth via `/design-login`) or the
DesignSync tool (`get_file` on that project/path) and match the mockup's CSS —
palette, spacing, borders, shadows — rather than re-inventing values. This slice
covers only `:root`, the type system, `header`, and the `.cols` grid shell;
leave the section, stat-strip, row, incident, and log markup untouched (they are
restyled in `0121`/`0122`) — they may look un-themed until those land.
