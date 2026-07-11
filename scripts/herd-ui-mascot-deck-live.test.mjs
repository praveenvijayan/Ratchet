#!/usr/bin/env node
// herd-ui-mascot-deck-live.test.mjs — the acceptance criteria of issue #300 are
// the test plan: exactly one test per criterion of the Active Agents deck
// tracking the *live* fleet (a mascot card per adapter with a live worker, not
// per configured adapter). Driven through herd-ui.mjs's public interface — the
// pure `buildDeck` projection and the server-rendered `PAGE_HTML`. Supersedes
// the "all configured adapters still render a card" behaviour of closed #276 and
// #287. Offline, zero deps. Run:
//   node scripts/herd-ui-mascot-deck-live.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildDeck, DECK_CAPACITY, PAGE_HTML } from "./herd-ui.mjs";

// The render draws a mascot card only for deck entries with a live worker — the
// same filter renderDeck applies. This mirrors the client's card set so the
// data-level criteria below assert the exact thing the browser renders.
const liveCards = (deck) => deck.filter((c) => c.activeIssue != null);

// Six configured adapters (roster 6), only some with a live worker.
const config = {
  adapters: {
    "claude-opus": { launch: ["a"] },
    "claude-sonnet": { launch: ["b"] },
    codex: { launch: ["c"] },
    "codex-mini": { launch: ["d"] },
    "opencode-glm": { launch: ["e"] },
    gemini: { launch: ["f"] },
  },
};
const adapters = [
  { adapter: "codex", dispatches: 4, failures: 1, successes: 3 },
  { adapter: "claude-opus", dispatches: 2, failures: 0, successes: 2 },
];
// Two live workers (claude-opus #101, codex #202); the third worker is not live
// (claimActive false), the other three adapters have no worker at all.
const workers = [
  { adapter: "claude-opus", claimActive: true, issue: 101 },
  { adapter: "codex", claimActive: true, issue: 202 },
  { adapter: "opencode-glm", claimActive: false, issue: 9 },
];

// --- #300 criterion 1: the deck renders a mascot card only for adapters with a
// live worker (`activeIssue` set); a configured adapter with no live worker
// renders no mascot card. ---
{
  const deck = buildDeck({ config, adapters, workers });
  const cards = liveCards(deck);
  assert.deepEqual(
    cards.map((c) => c.name).sort(),
    ["claude-opus", "codex"],
    "only the two adapters with a live worker become cards",
  );
  // The four adapters without a live worker (inactive worker or none) are absent
  // from the rendered set — configured, but not carded.
  for (const idle of ["claude-sonnet", "codex-mini", "opencode-glm", "gemini"]) {
    assert.ok(!cards.some((c) => c.name === idle), `${idle} has no live worker, so renders no card`);
  }
  // The client filters the roster to the live subset and maps only that to cards.
  assert.ok(PAGE_HTML.includes("const live = cards.filter((c) => c.activeIssue != null)"), "renderDeck derives the live subset from the roster");
  assert.ok(PAGE_HTML.includes("let html = live.map("), "renderDeck renders a card only for each live entry, not each configured adapter");
}

// --- #300 criterion 2: with zero live workers the deck renders zero mascot cards
// and all bays as dashed "Bay open" placeholders — never a broken or empty
// section. ---
{
  const deck = buildDeck({ config, adapters, workers: [] });
  assert.equal(liveCards(deck).length, 0, "zero live workers → zero mascot cards");
  // Bays fill from the live count, so zero live workers leaves every bay open.
  assert.ok(PAGE_HTML.includes("for (let n = live.length + 1; n <= " + DECK_CAPACITY + "; n++)"), "open bays fill from the live count up to capacity");
  assert.ok(PAGE_HTML.includes('class="k">Bay open</span>'), "an open bay is labelled Bay open");
  assert.ok(PAGE_HTML.includes(".bay { border:1.5px dashed var(--ink-faint)"), "open bays are dashed placeholders");
  // The section hides only when nothing is configured — not merely when nothing
  // is live — so a configured-but-idle fleet still renders (all bays open),
  // never a broken or blank section.
  assert.ok(PAGE_HTML.includes("if (!cards.length) { wrap.hidden = true"), "the deck hides only when no adapter is configured, so an idle fleet still renders");
}

// --- #300 criterion 3: a card appears on the first dashboard refresh after an
// adapter's worker spawns and disappears on the first refresh after that worker
// exits. ---
{
  // Refresh 1 — before spawn: gemini has no live worker, so no card.
  const before = liveCards(buildDeck({ config, adapters, workers }));
  assert.ok(!before.some((c) => c.name === "gemini"), "no gemini card before its worker spawns");

  // Refresh 2 — gemini's worker has spawned: a card appears immediately.
  const spawned = liveCards(buildDeck({
    config,
    adapters,
    workers: [...workers, { adapter: "gemini", claimActive: true, issue: 303 }],
  }));
  assert.ok(spawned.some((c) => c.name === "gemini" && c.activeIssue === 303), "gemini's card appears on the first refresh after its worker spawns");

  // Refresh 3 — gemini's worker has exited (gone from the list): the card is gone.
  const exited = liveCards(buildDeck({ config, adapters, workers }));
  assert.ok(!exited.some((c) => c.name === "gemini"), "gemini's card disappears on the first refresh after its worker exits");
}

// --- #300 criterion 4: the deck header tally equals the number of mascot cards
// rendered. ---
{
  const deck = buildDeck({ config, adapters, workers });
  const cards = liveCards(deck);
  assert.equal(cards.length, 2, "two mascot cards are rendered for this snapshot");
  // The tally is set from the same live subset the cards are mapped from, so it
  // can never disagree with the number of cards on screen.
  assert.ok(PAGE_HTML.includes("tallyEl.textContent = String(live.length)"), "the tally is the count of live cards");
  assert.ok(PAGE_HTML.includes("let html = live.map("), "the cards are mapped from the same live subset the tally counts");
}

// --- #300 criterion 5: the roster count (configured adapters out of bay
// capacity, e.g. 6/10) remains visible in the deck header so fleet composition
// is not lost. ---
{
  // buildDeck's projection carries every configured adapter regardless of
  // liveness — it is the roster source, so its length is the configured count.
  const deck = buildDeck({ config, adapters, workers });
  assert.equal(deck.length, 6, "the roster projection counts all six configured adapters");
  assert.equal(DECK_CAPACITY, 10, "the bay capacity is 10");
  // The header renders configured-count / capacity (e.g. 6/10) into a stable
  // roster element, independent of how many workers are live.
  assert.ok(PAGE_HTML.includes('id="deckroster"'), "the header has a stable roster element");
  assert.ok(PAGE_HTML.includes('rosterEl.textContent = String(cards.length) + "/' + DECK_CAPACITY + '"'), "roster reads configured count over capacity");
  assert.ok(PAGE_HTML.includes("String(cards.length)"), "the roster count is the configured (roster) adapter count, not the live count");
}

// --- #300 criterion 6: an adapter entry with missing or malformed worker data is
// treated as idle (no card) — the deck never throws or renders a partial card. ---
{
  // A null worker entry, a live worker with no issue, one with a NaN issue, one
  // with an empty-string issue, and one with a non-scalar issue — every
  // malformed shape must be treated as idle, and buildDeck must not throw.
  const malformed = [
    null,
    { adapter: "claude-opus", claimActive: true },              // issue missing
    { adapter: "claude-sonnet", claimActive: true, issue: NaN },// NaN issue
    { adapter: "codex", claimActive: true, issue: "" },          // empty issue
    { adapter: "codex-mini", claimActive: true, issue: {} },     // non-scalar issue
  ];
  let deck;
  assert.doesNotThrow(() => { deck = buildDeck({ config, adapters, workers: malformed }); }, "malformed worker data never throws");
  assert.equal(liveCards(deck).length, 0, "every adapter with malformed worker data is idle — no card");
  assert.ok(deck.every((c) => c.activeIssue === null), "no entry carries a partial/garbage active issue");

  // A well-formed live worker alongside the malformed ones still cards normally —
  // malformed data is isolated to its own adapter, never poisoning the deck.
  const mixed = buildDeck({ config, adapters, workers: [...malformed, { adapter: "gemini", claimActive: true, issue: 404 }] });
  assert.deepEqual(liveCards(mixed).map((c) => c.name), ["gemini"], "a valid live worker still cards while malformed ones stay idle");
}

// --- #300: every criterion above has exactly one test named after it. ---
{
  const self = readFileSync(new URL("./herd-ui-mascot-deck-live.test.mjs", import.meta.url), "utf8");
  for (let i = 1; i <= 6; i++) {
    const hits = (self.match(new RegExp(`#300 criterion ${i}:`, "g")) || []).length;
    assert.equal(hits, 1, `#300 criterion ${i} must have exactly one test named after it`);
  }
}

console.log("PASS herd-ui-mascot-deck-live.test.mjs (6 criteria)");
