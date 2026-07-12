#!/usr/bin/env node
// herd-ui-dashboard-columns.test.mjs — the acceptance criteria of issue #316 are
// the test plan: exactly one test per criterion of the flipped dashboard layout
// (workers / logs in the left column, errors & escalations in the right column).
// #319 revised the vertical behaviour: the 100vh cap is gone — the desktop page
// scrolls as one document and only the errors panel scrolls internally — and
// the log console became a modal <dialog>; criteria 2 and 3 track the revised
// design. Driven through herd-ui.mjs's public interface — the exported
// PAGE_HTML string (markup + inline stylesheet). Offline, zero deps. Run:
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

// --- #316 criterion 2: the workers pane renders in the left column inside the
// #deckwrap container, so agents and workers form one left-side column.
// (Revised by #319: the separate #deck bay grid is gone — the combined
// character cards render in the worker groups — and #logpane is a modal
// <dialog> hosted inside #deckwrap rather than an inline pane beneath it.) ---
{
  assert.match(
    PAGE_HTML,
    /id="deckwrap"[\s\S]*id="workers"[\s\S]*id="logpane"[\s\S]*<\/section>\s*<aside class="errpanel"/,
    "#workers and the #logpane dialog render inside #deckwrap before the errors panel",
  );
  assert.match(PAGE_HTML, /<dialog class="logpane" id="logpane">/, "the log console is a modal <dialog>, not an inline pane");
}

// --- #316 criterion 3: (revised by #319 — supersedes the 100vh cap) on a
// desktop-width viewport the page scrolls as one document: the desktop media
// query applies no overflow:hidden viewport cap to body or main, and only the
// errors panel keeps an internal scroll region. ---
{
  const desktop = /@media \(min-width:\s*1181px\)\s*\{([\s\S]*?)\n  \}/.exec(PAGE_HTML);
  assert.ok(desktop, "the desktop-width media query is present");
  const cap = desktop[1];
  assert.doesNotMatch(cap, /overflow:\s*hidden/i, "the desktop query never hides overflow — the page scrolls as one document");
  assert.doesNotMatch(cap, /html,\s*body\s*\{[^}]*height:\s*100%/i, "the desktop query no longer pins the page to the viewport height");
  assert.match(cap, /\.errpanel\s*\{[^}]*overflow-y:\s*scroll/i, "only the errors panel keeps its own scrollable region");
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
