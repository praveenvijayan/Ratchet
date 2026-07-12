---
title: Herd dashboard — deck and workers/log side-by-side grid, natural page scroll on desktop
priority: medium
labels: [herd, dashboard, design]
blocked_by: []
---

Revision — supersedes the two-column deck/log grid draft. That layout was
prototyped downstream and iterated past: the log console became a modal
`<dialog>` instead of an inline pane, and the per-agent mascot cards merged
*into* the worker cards, so one combined character card carries the agent and
its issue through the lifecycle groups. This plan describes the delivered
design; the earlier grid criteria no longer apply. Alongside the dashboard,
the same iteration hardened config reloading (dashboard and supervisor) and
fixed the `hasGatesSection` detector in `scripts/herd-verify.mjs`.

## Acceptance criteria
- [ ] Combined character card: a worker whose adapter is on the configured
      roster renders inside its lifecycle group as a single mascot-card
      carrying the adapter family label, figure, adapter name, the worked
      issue link, a status chip, the issue-title cell, the telemetry grid
      (Attempts / Age / PR / Cost / Tokens In / Tokens Out), and the adapter
      vitals (Disp. / Fail / Launched) — one card per worker, no separate
      deck card, and the card moves between groups with its issue
- [ ] A worker whose adapter is not on the configured roster renders as the
      plain row card with the same issue link, status chip, title cell, and
      telemetry — never dropped
- [ ] The log console is a modal: `#logpane` is a `<dialog>` and selecting a
      card opens it via `showModal()`, not an always-visible inline pane
- [ ] Every close path — the `#logclose` × button, a backdrop click, and Esc
      — routes through one idempotent cleanup that closes the dialog, drops
      the selection, and closes both EventSources (log + timeline)
- [ ] The section header shows "Live Workers" with real numbers only: the
      tally counts live workers, the roster reads "N agents" (configured
      count), and the note reads "max `<maxWorkers>` live" from the
      snapshot's new `maxWorkers` field; `DECK_CAPACITY` and the decorative
      "Bay open" placeholder tiles are gone
- [ ] With zero live workers the section shows the friendly `#deckempty`
      empty-state block instead of a blank grid
- [ ] The summary strip renders an agent roster tile listing every configured
      adapter (image + name), and selection activity rides on it: exported
      `routingActivity(config, cursors, events)` returns the route, its
      policy, the next-up adapter (round-robin cursor from
      `.ratchet/herd-routing.json`; first adapter under failover), and the
      last dispatch; the next-up agent wears the NEXT chip, the label names
      the policy, and the meta line shows "last: `<adapter>` → #N · `<ago>`"
- [ ] Status chips show GitHub's own labels: claim states map to
      `state:in-progress`, PR-open states to `state:in-review`, herd-internal
      statuses stay verbatim, and the raw status is preserved in the chip's
      `title` attribute
- [ ] Superseded escalations: an unresolved (issue, reason) group
      auto-resolves when the issue moved on after the group's newest
      occurrence — a newer different-reason escalation, a newer
      dispatch/resume, or the issue closing — while a recurring same-reason
      problem keeps its group newest and is never hidden
- [ ] The escalations panel renders the newest 10 blocks with a
      "Show N older" toggle that reveals the rest
- [ ] The adapter breakdown table filters to adapters currently in herd.json
      and heads the spawn-success column "Launched", not "OK"
- [ ] Config resilience end-to-end: a dashboard started by `run()` re-reads
      herd.json per snapshot (`configPath` and `routingPath` are wired into
      `createDashboardServer`); when the file turns invalid the snapshot
      keeps serving the last good config and carries `configError` naming the
      exact error, which the page surfaces as the `#configbanner` banner
- [ ] `hasGatesSection` in `scripts/herd-verify.mjs` also accepts a bare
      label line ("Gates", "Gate results:") since AGENTS.md demands the gate
      checklist without mandating markdown; a word-in-sentence mention still
      does not count
- [ ] On a desktop-width viewport the page scrolls as one document: the
      desktop media query applies no `overflow:hidden` viewport cap to
      `body`/`main`, only the errors panel keeps an internal scroll region,
      and `main` spans near full viewport width
- [ ] The embedded `PAGE_HTML` stylesheet contains no `//` line comments and
      no empty placeholder rules
- [ ] Every criterion above has exactly one test named after it

## Non-functional
- Keep the existing element ids and test hooks: `#deckwrap`, `#layout`,
  `#workers`, `#logpane`, `#errpanel`, `#escalations`, `#logsearch`,
  `#lognomatch` all still exist. Exception: `#deck` (the separate bay grid)
  is removed together with the deck it hosted — the combined cards render in
  the `.rows` grid inside the lifecycle groups instead.
- The supervisor (`scripts/herd.mjs`) gains the matching per-poll herd.json
  re-read: adapter add/remove takes effect on the next pass without a
  restart; an invalid file keeps the last good config with one warning per
  poll; `pollSeconds` alone still needs a restart. This lives behind the CLI
  main guard, so it is exercised through the shared `loadConfig` contract and
  the dashboard-side reload tests rather than a unit test of the loop.
- Suites written against the superseded designs (the #316 grid/100vh layout,
  the bay deck, `DECK_CAPACITY`) must be updated to the delivered design, not
  deleted: `herd-ui.test.mjs`, `herd-ui-dashboard-columns.test.mjs`,
  `herd-ui-mascot-deck.test.mjs`, `herd-ui-mascot-deck-live.test.mjs`,
  `herd-ui-truthful-tally.test.mjs`, `herd-ui-vinyl-deck.test.mjs`,
  `herd-ui-deck-card-issue-status.test.mjs`.
- No new runtime dependency and no build step.
- This ships as one coherent port PR (owner-authorized): the tested patch
  plus the suite updates exceed the ~400-changed-line size gate, so the
  `pr-size` check is expected red on this one PR — the human reviewer has
  pre-authorized the single-PR port.

## Notes
The change is ported from a downstream product repo that iterated on ratchet
4.4.0's dashboard and supervisor and shipped a tested patch; `scripts/` here
is byte-identical to that repo's base, so the patch applies cleanly. It also
carries a production bugfix: `run()` previously did not pass `configPath`
(or `routingPath`) into `createDashboardServer`, so the per-snapshot
herd.json re-read and the config-error banner were dead in production.
