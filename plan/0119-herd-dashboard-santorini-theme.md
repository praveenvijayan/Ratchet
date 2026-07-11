---
title: Restyle herd dashboard to the Santorini design
priority: medium
labels: [herd, dashboard, design]
blocked_by: []
---

The herd dashboard (`scripts/herd-ui.mjs`) works but its visual design is ad
hoc. A finished design exists — "Herd Dashboard Santorini" in the Claude Design
project — and the dashboard should follow it: paper/ink palette, serif/mono
type system, bordered cards with hard offset shadows, two-column layout with an
incidents aside. This issue covers the visual system and the existing sections;
the new Active Agents mascot deck is a separate issue
(`0120-herd-dashboard-mascot-deck`).

## Acceptance criteria
- [ ] Dashboard page defines the Santorini palette as CSS custom properties (`--paper:#e4e3f5`, `--paper-hi:#f4f2fc`, `--paper-lo:#d7d4ee`, `--ink:#3f3e78`, `--ink-deep:#2b2a58`, `--terra:#7c68c4`, plus the soft/faint/hair ink alphas) and uses them for page background, text, and borders
- [ ] Type system follows the design: Marcellus for display headings, Space Grotesk for body, Space Mono for labels/metrics — every `font-family` declaration ends in a generic fallback (`serif`/`sans-serif`/`monospace`) so the page renders correctly when the fonts CDN is unreachable
- [ ] Header renders the brand block (serif "Herd Dashboard" title with "Santorini" ordinal) and a right-aligned heartbeat: pulsing dot, supervisor liveness text, and time since last heartbeat
- [ ] Summary strip renders each stat as a bordered block with offset shadow (large serif number + mono uppercase label); the escalations stat and the errors chip get the accent (`--terra`) alert treatment with the error count in a filled pill
- [ ] Section headings render as serif uppercase title + circled count tally + horizontal rule ending in a diamond, per the design's `.sec` pattern
- [ ] Work rows (awaiting review, live, escalated) render as bordered cards with issue number link, uppercase status chip (distinct styling for dispatched / ready-for-review / stale-claim), assignee with avatar chip, title, and a dashed-rule telemetry strip (attempts, age, PR, cost, tokens in/out) where missing values show an em dash in faint style, never blank or "undefined"
- [ ] Errors & escalations panel renders as a bordered aside with inverted (ink background) panel head; each incident is a card, and flagged incidents get the accent border, accent-colored action buttons, and offset shadow
- [ ] Log console renders lines as timestamp / bold event / faint meta with escalation events in the accent color; the filter input matches the design styling and hides non-matching lines as typed
- [ ] Main content is a two-column grid (work rows + 400px incidents aside) that collapses to a single column below 1180px viewport width

## Non-functional
- Pure reskin: all existing dashboard behaviour (summary strip counts, escalation acknowledge/actions, log search, adapter failure display, PR checks) keeps working — the existing herd-ui test suites stay green
- No new runtime dependency and no build step: the dashboard stays a single self-contained server-rendered page; the fonts `<link>` is the only external reference and its failure must not block rendering

## Notes
Design source of truth: Claude Design project `040de050-b19a-4271-bf65-d8fa03b3c6f6`,
file `Herd Dashboard Santorini.html`. Retrieve it via the claude_design MCP
(`https://api.anthropic.com/v1/design/mcp`, auth via `/design-login`) or the
DesignSync tool (`get_file` on that project/path) and match the mockup's CSS —
palette, spacing, borders, shadows — rather than re-inventing values.
