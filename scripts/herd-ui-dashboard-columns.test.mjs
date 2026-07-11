#!/usr/bin/env node
// herd-ui-dashboard-columns.test.mjs — the acceptance criteria of issue #316 are
// the test plan: exactly one test per criterion of the flipped dashboard layout
// (active agents / workers / logs in the left column, errors & escalations in
// the right column, capped at 100vh with each column scrolling its own content).
// Driven through herd-ui.mjs's public interface — the exported PAGE_HTML string
// (markup + inline stylesheet). Offline, zero deps. Run:
//   node scripts/herd-ui-dashboard-columns.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PAGE_HTML } from "./herd-ui.mjs";

// --- #316 criterion 1: on a desktop-width viewport the active agents deck
// renders in the left column and the errors & escalations panel renders in the
// right column. The top region is a two-column grid whose first (flexible)
// track holds the deck and whose second (fixed 420px) track holds the errors
// region, and #deckwrap precedes #errpanel in source order. ---
{
  assert.match(
    PAGE_HTML,
    /\.topregion\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(0,\s*420px\)/i,
    "the top region is a two-column grid with a flexible left track and a fixed 420px right track",
  );
  assert.match(
    PAGE_HTML,
    /<div class="topregion"[^>]*>\s*<section class="deckwrap"[\s\S]*<aside class="errpanel"/,
    "the active agents deck (left column) precedes the errors & escalations panel (right column)",
  );
}

// --- #316 criterion 2: the workers pane and the log console render in the left
// column beneath the active agents deck, inside the same #deckwrap container,
// so agents, workers, and logs form one left-side column. Source order inside
// #deckwrap is deck, then #workers, then #logpane — all before #errpanel. ---
{
  assert.match(
    PAGE_HTML,
    /id="deckwrap"[\s\S]*id="deck"[\s\S]*id="workers"[\s\S]*id="logpane"[\s\S]*<\/section>\s*<aside class="errpanel"/,
    "#deck, #workers, and #logpane all render inside #deckwrap (deck first, then workers, then logs) before the errors panel",
  );
}

// --- #316 criterion 3: the page layout is capped at 100vh — the header/top
// strip stays visible and each column scrolls its own overflowing content
// instead of the whole page growing past the viewport. On a desktop-width
// viewport the body is a fixed-height flex column that hides its own overflow,
// the top region flexes to fill the remaining height, and each column
// (#deckwrap, #errpanel) scrolls internally. ---
{
  const desktop = /@media \(min-width:\s*1181px\)\s*\{([\s\S]*?)\n  \}/.exec(PAGE_HTML);
  assert.ok(desktop, "a desktop-width media query caps the layout height");
  const cap = desktop[1];
  assert.match(cap, /body\s*\{[^}]*overflow:\s*hidden[^}]*display:\s*flex[^}]*flex-direction:\s*column/i, "the body is a fixed flex column that hides its own overflow so the page cannot grow past the viewport");
  assert.match(cap, /main\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/i, "main fills the space below the header and clips its own overflow");
  assert.match(cap, /\.topregion\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0/i, "the top region flexes to fill the remaining height");
  assert.match(cap, /\.deckwrap,\s*\.errpanel\s*\{[^}]*overflow-y:\s*auto/i, "each column scrolls its own overflowing content");
}

// --- #316 criterion 4: on a narrow viewport the columns stack vertically
// without overlapping and the 100vh cap does not clip content — the page
// scrolls normally. The single-column collapse lives in a max-width:1180px
// query, and the height cap is scoped to min-width:1181px only, so it never
// applies at narrow widths. ---
{
  assert.match(
    PAGE_HTML,
    /@media \(max-width:\s*1180px\)\s*\{\s*\.topregion\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/i,
    "below 1180px the top region collapses to a single stacked column",
  );
  const narrow = /@media \(max-width:\s*1180px\)\s*\{([\s\S]*?)\}\s*\}/.exec(PAGE_HTML)
    || /@media \(max-width:\s*1180px\)\s*\{([^}]*\{[^}]*\})/.exec(PAGE_HTML);
  assert.ok(narrow, "the narrow-viewport query is present");
  assert.doesNotMatch(narrow[1], /overflow:\s*hidden/i, "the narrow-viewport query never hides overflow, so the page scrolls normally and the cap cannot clip content");
}

// --- #316 criterion 5: with zero escalations and zero adapter-health issues the
// right column shows its empty state rather than a blank or broken column. The
// escalations renderer paints an explicit "No errors." empty state when there
// are no escalations, and the adapter-health block collapses when empty, so the
// panel is never left blank. ---
{
  assert.match(
    PAGE_HTML,
    /if \(!snapshot\.escalations\.length\) \{\s*el\.innerHTML = '<div class="empty">No errors\.<\/div>';\s*return;/,
    "an empty escalations list renders a 'No errors.' empty state in the right column",
  );
  assert.match(
    PAGE_HTML,
    /\.adapterhealth:empty\s*\{[^}]*display:\s*none/i,
    "an empty adapter-health block collapses instead of leaving a broken gap",
  );
}

// --- #316 criterion 6: every criterion above has exactly one test named after
// it. ---
{
  const self = readFileSync(new URL("./herd-ui-dashboard-columns.test.mjs", import.meta.url), "utf8");
  for (const c of ["criterion 1", "criterion 2", "criterion 3", "criterion 4", "criterion 5", "criterion 6"]) {
    const hits = (self.match(new RegExp(`#316 ${c}:`, "g")) || []).length;
    assert.equal(hits, 1, `#316 ${c} must have exactly one test named after it`);
  }
}

console.log("PASS herd-ui-dashboard-columns.test.mjs (6 criteria)");
