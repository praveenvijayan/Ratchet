#!/usr/bin/env node
// herd-ui-mascot-deck.test.mjs — the acceptance criteria of issue #276 are the
// test plan: exactly one test per criterion of the Active Agents mascot deck,
// driven through herd-ui.mjs's public interface (the pure `buildDeck` projection
// and the server-rendered `PAGE_HTML`). Offline, zero deps. Run:
//   node scripts/herd-ui-mascot-deck.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildDeck, adapterFamily, DECK_CAPACITY, PAGE_HTML } from "./herd-ui.mjs";

// A config with three adapters across two families, one with its own avatar and
// one that has never dispatched — enough to exercise every card field.
const config = {
  adapters: {
    "claude-opus": { launch: ["x"], avatar: "https://host/opus.png" },
    codex: { launch: ["y"] },
    "opencode-glm": { launch: ["z"] }, // never dispatched → fresh adapter
  },
};
const adapters = [
  { adapter: "codex", dispatches: 3, failures: 0, successes: 3 },
  { adapter: "claude-opus", dispatches: 2, failures: 1, successes: 1 },
];
const workers = [
  { adapter: "codex", claimActive: true, issue: 160 },
  { adapter: "claude-opus", claimActive: false, issue: 5 },
];

// --- #276 criterion 1: Active Agents section renders one mascot card per
// configured adapter in an auto-fill grid (minmax(206px, 1fr)) that reflows from
// 1 to 10 adapters without layout changes. ---
{
  // One card per configured adapter, in config order, regardless of dispatch data.
  const deck = buildDeck({ config, adapters, workers });
  assert.equal(deck.length, 3, "one card per configured adapter");
  assert.deepEqual(deck.map((c) => c.name), ["claude-opus", "codex", "opencode-glm"], "cards follow config order");

  // The shape is identical whether there is 1 adapter or the full 10 — the grid,
  // not the card count, does the reflowing.
  const mk = (n) => ({ adapters: Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${i}`, { launch: ["x"] }])) });
  const one = buildDeck({ config: mk(1) });
  const ten = buildDeck({ config: mk(10) });
  assert.equal(one.length, 1, "a single adapter yields a single card");
  assert.equal(ten.length, 10, "ten adapters yield ten cards");
  assert.deepEqual(Object.keys(one[0]).sort(), Object.keys(ten[0]).sort(), "card shape is identical at 1 and 10 adapters");

  // The grid uses the design's auto-fill track so reflow needs no layout change.
  assert.ok(PAGE_HTML.includes("grid-template-columns:repeat(auto-fill, minmax(206px, 1fr))"), "deck grid is an auto-fill minmax(206px, 1fr) track");
}

// --- #276 criterion 2: each mascot card shows the adapter family label, its bay
// number, the mascot image, the adapter name, a duty chip, and a three-cell
// vitals strip (dispatched / failed / succeeded counts). ---
{
  const deck = buildDeck({ config, adapters, workers });
  const opus = deck[0];
  assert.equal(opus.family, "claude", "card carries the family label");
  assert.equal(opus.name, "claude-opus", "card carries the adapter name");
  assert.equal(opus.dispatches, 2, "vitals carry the dispatched count");
  assert.equal(opus.failures, 1, "vitals carry the failed count");
  assert.equal(opus.successes, 1, "vitals carry the succeeded count");
  assert.equal(adapterFamily("codex"), "codex", "a family-less name is its own family");

  // The client renders each of the six card parts. Bay number is derived from the
  // card's position (i + 1), the vitals strip has three labelled cells.
  for (const marker of ['class="family"', 'class="slot-no">bay ', 'class="mascot"><img', 'class="name"', 'class="duty', 'class="vitals"', 'vital("Disp.", c.dispatches)', 'vital("Fail", c.failures)', 'vital("Launched", c.successes)']) {
    assert.ok(PAGE_HTML.includes(marker), `card renders ${marker}`);
  }
}

// --- #276 criterion 3: duty chip shows active styling with "dispatched · #N"
// (the claimed issue number) when the adapter has a live worker, and idle styling
// with "standing by" otherwise. ---
{
  const deck = buildDeck({ config, adapters, workers });
  const byName = Object.fromEntries(deck.map((c) => [c.name, c]));
  assert.equal(byName.codex.activeIssue, 160, "an adapter with a live worker carries that worker's issue");
  assert.equal(byName["claude-opus"].activeIssue, null, "an adapter whose worker is not live is idle");
  assert.equal(byName["opencode-glm"].activeIssue, null, "an adapter with no worker is idle");

  // The client turns activeIssue into the active/idle chip variants.
  assert.ok(PAGE_HTML.includes('class="duty on"><span class="dot"></span>dispatched · #') , "a live adapter renders the active duty chip with its issue number");
  assert.ok(PAGE_HTML.includes('class="duty idle"><span class="dot"></span>standing by'), "an idle adapter renders the standing-by chip");
}

// --- #276 criterion 4: vitals render zero counts in the faint zero treatment
// rather than hiding the cell, so a fresh adapter still shows all three cells. ---
{
  const deck = buildDeck({ config, adapters, workers });
  const fresh = deck.find((c) => c.name === "opencode-glm");
  assert.deepEqual(
    { d: fresh.dispatches, f: fresh.failures, s: fresh.successes },
    { d: 0, f: 0, s: 0 },
    "a never-dispatched adapter reports all three counts as zero (present, not absent)",
  );
  // The client tags a zero value with the faint `zero` class instead of dropping
  // the cell, and the stylesheet defines that faint treatment.
  assert.ok(PAGE_HTML.includes('(n === 0 ? " zero" : "")'), "a zero vital keeps its cell and gains the faint zero class");
  assert.ok(PAGE_HTML.includes(".vitals .v.zero {"), "the faint zero treatment is defined in CSS");
}

// --- #276 criterion 5: bays beyond the configured adapters render as dashed
// empty-bay placeholders with bay number and "Bay open" label, up to the 10-bay
// capacity. ---
{
  assert.equal(DECK_CAPACITY, 10, "the deck capacity is 10 bays");
  // The client fills bays from live.length + 1 up to the capacity, so L live
  // workers leave (10 - L) open bays; a full 10 live workers leave none. (Since
  // #300 the deck cards the live fleet, not the configured roster, so bays fill
  // from the live count — see herd-ui-mascot-deck-live.test.mjs.)
  assert.ok(PAGE_HTML.includes("for (let n = live.length + 1; n <= 10; n++)"), "empty bays fill the remaining capacity up to 10");
  assert.ok(PAGE_HTML.includes('class="bay"><span class="ring">'), "an empty bay renders its bay number in a ring");
  assert.ok(PAGE_HTML.includes('class="k">Bay open</span>'), "an empty bay is labelled Bay open");
  assert.ok(PAGE_HTML.includes(".bay { border:1.5px dashed var(--ink-faint)"), "empty bays are dashed placeholders");
}

// --- #276 criterion 6: when an adapter's own avatar image fails to load, the
// card swaps to the bundled data-URI mascot — a broken-image icon is never
// shown. ---
{
  const deck = buildDeck({ config, adapters, workers });
  const opus = deck.find((c) => c.name === "claude-opus");
  assert.equal(opus.avatar, "https://host/opus.png", "an adapter's own avatar is tried first");
  // The bundled default is always a self-contained inline data URI — it can never
  // 404, so it is a safe fallback (and honours the framework-purity rule: no
  // network fetch, no asset directory).
  for (const c of deck) {
    assert.ok(c.defaultAvatar.startsWith("data:image/svg+xml,"), `${c.name} has a bundled inline-data-URI fallback`);
  }
  // The client wires that fallback onto the mascot <img>: onerror swaps to the
  // data-default, so a failed load shows the mascot, never a broken image.
  assert.ok(PAGE_HTML.includes('data-default="'), "the mascot img carries its bundled default");
  assert.ok(PAGE_HTML.includes('onerror="avatarFallback(this)"'), "a failed mascot load falls back via avatarFallback");
}

// --- #276 criterion 7: section heading shows the live adapter tally and the note
// "10 bays · new agents dock automatically". ---
{
  assert.ok(PAGE_HTML.includes('<span class="tally" id="decktally">'), "the heading has a live adapter tally element");
  assert.ok(PAGE_HTML.includes("cards.filter((c) => c.activeIssue != null)"), "the tally counts only adapters with a live worker");
  assert.ok(PAGE_HTML.includes("10 bays · new agents dock automatically"), "the heading carries the capacity note");
  assert.ok(PAGE_HTML.includes(">Active Agents<"), "the section is headed Active Agents");
}

// --- #276: every criterion above has exactly one test named after it. ---
{
  const self = readFileSync(new URL("./herd-ui-mascot-deck.test.mjs", import.meta.url), "utf8");
  for (let i = 1; i <= 7; i++) {
    const hits = (self.match(new RegExp(`#276 criterion ${i}:`, "g")) || []).length;
    assert.equal(hits, 1, `#276 criterion ${i} must have exactly one test named after it`);
  }
}

console.log("PASS herd-ui-mascot-deck.test.mjs (7 criteria)");
