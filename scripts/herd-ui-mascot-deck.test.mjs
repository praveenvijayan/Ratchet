#!/usr/bin/env node
// herd-ui-mascot-deck.test.mjs — the acceptance criteria of issue #276 are the
// test plan: exactly one test per criterion of the mascot cards, driven through
// herd-ui.mjs's public interface (the pure `buildDeck` projection and the
// server-rendered `PAGE_HTML`). #319 merged the mascot cards into the worker
// cards (one combined character card per live worker, rendered inside the
// lifecycle groups) and deleted the bay grid and its DECK_CAPACITY, so the
// bay/duty-chip criteria track the revised design. Offline, zero deps. Run:
//   node scripts/herd-ui-mascot-deck.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as ui from "./herd-ui.mjs";
import { buildDeck, adapterFamily, PAGE_HTML } from "./herd-ui.mjs";

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

// --- #276 criterion 1: the roster projection carries one entry per configured
// adapter, and the combined cards render in an auto-fill grid that reflows from
// 1 to 10 without layout changes (revised by #319: the grid is the .rows grid
// inside each lifecycle group, minmax(250px, 1fr)). ---
{
  // One entry per configured adapter, in config order, regardless of dispatch data.
  const deck = buildDeck({ config, adapters, workers });
  assert.equal(deck.length, 3, "one roster entry per configured adapter");
  assert.deepEqual(deck.map((c) => c.name), ["claude-opus", "codex", "opencode-glm"], "entries follow config order");

  // The shape is identical whether there is 1 adapter or the full 10 — the grid,
  // not the card count, does the reflowing.
  const mk = (n) => ({ adapters: Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${i}`, { launch: ["x"] }])) });
  const one = buildDeck({ config: mk(1) });
  const ten = buildDeck({ config: mk(10) });
  assert.equal(one.length, 1, "a single adapter yields a single entry");
  assert.equal(ten.length, 10, "ten adapters yield ten entries");
  assert.deepEqual(Object.keys(one[0]).sort(), Object.keys(ten[0]).sort(), "entry shape is identical at 1 and 10 adapters");

  // The grid uses the design's auto-fill track so reflow needs no layout change.
  assert.ok(PAGE_HTML.includes("grid-template-columns:repeat(auto-fill, minmax(250px, 1fr))"), "the card grid is an auto-fill minmax(250px, 1fr) track");
}

// --- #276 criterion 2: each mascot card shows the adapter family label, the
// worked issue link (revised by #319: the slot carries the issue, not a bay
// number), the mascot image, the adapter name, a status chip, and a three-cell
// vitals strip (dispatched / failed / launched counts). ---
{
  const deck = buildDeck({ config, adapters, workers });
  const opus = deck[0];
  assert.equal(opus.family, "claude", "card carries the family label");
  assert.equal(opus.name, "claude-opus", "card carries the adapter name");
  assert.equal(opus.dispatches, 2, "vitals carry the dispatched count");
  assert.equal(opus.failures, 1, "vitals carry the failed count");
  assert.equal(opus.successes, 1, "vitals carry the launched count");
  assert.equal(adapterFamily("codex"), "codex", "a family-less name is its own family");

  // The client renders each card part in the combined character card (rowHtml's
  // rostered-adapter branch); the vitals strip has three labelled cells.
  for (const marker of ['class="family"', `'<span class="slot-no">' + issueLink(w)`, 'class="mascot"><img', 'class="name"', 'class="card-chips"', 'class="vitals"', 'vital("Disp.", d.dispatches)', 'vital("Fail", d.failures)', 'vital("Launched", d.successes)']) {
    assert.ok(PAGE_HTML.includes(marker), `card renders ${marker}`);
  }
}

// --- #276 criterion 3: the projection marks which adapter has a live worker,
// and the combined card wears the worker's own status chip (revised by #319:
// the duty chip is gone — the card lives inside the worker's lifecycle group,
// so liveness reads from the group and the chip shows the worker status). ---
{
  const deck = buildDeck({ config, adapters, workers });
  const byName = Object.fromEntries(deck.map((c) => [c.name, c]));
  assert.equal(byName.codex.activeIssue, 160, "an adapter with a live worker carries that worker's issue");
  assert.equal(byName["claude-opus"].activeIssue, null, "an adapter whose worker is not live is idle");
  assert.equal(byName["opencode-glm"].activeIssue, null, "an adapter with no worker is idle");

  // The duty chip is gone; the card's chip row carries the worker status chip.
  assert.ok(!PAGE_HTML.includes('class="duty'), "the duty chip no longer renders");
  assert.ok(PAGE_HTML.includes(`'<div class="card-chips">' + statusChip`), "the card's chip row carries the worker's status chip");
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

// --- #276 criterion 5: (revised by #319 — the decorative bays are deleted)
// no "Bay open" placeholders and no DECK_CAPACITY: the header shows real
// numbers only, and the hardcoded 10-bay capacity that contradicted
// config.maxWorkers is gone from the module's public interface. ---
{
  assert.ok(!("DECK_CAPACITY" in ui), "DECK_CAPACITY is no longer exported");
  assert.ok(!PAGE_HTML.includes("Bay open"), "no decorative Bay open placeholders render");
  assert.ok(!PAGE_HTML.includes('class="bay"'), "no empty-bay markup remains");
  assert.ok(PAGE_HTML.includes('"max " + snapshot.maxWorkers + " live'), "the header note shows the real dispatch cap from config.maxWorkers");
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

// --- #276 criterion 7: section heading shows the live worker tally and the
// docking note (revised by #319: headed "Live Workers", with the real
// "max <maxWorkers> live" cap instead of the decorative bay count). ---
{
  assert.ok(PAGE_HTML.includes('<span class="tally" id="decktally">'), "the heading has a live worker tally element");
  assert.ok(PAGE_HTML.includes("cards.filter((c) => c.activeIssue != null)"), "the tally counts only adapters with a live worker");
  assert.ok(PAGE_HTML.includes("new agents dock automatically"), "the heading carries the docking note");
  assert.ok(PAGE_HTML.includes(">Live Workers<"), "the section is headed Live Workers");
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
