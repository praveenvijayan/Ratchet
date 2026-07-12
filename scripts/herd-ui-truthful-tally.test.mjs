#!/usr/bin/env node
// herd-ui-truthful-tally.test.mjs — the acceptance criteria of issue #287 are
// the test plan: exactly one test per criterion of the Active Agents deck
// header tally and vitals labelling, driven through herd-ui.mjs's public
// interface (the pure `buildDeck` projection and the server-rendered
// `PAGE_HTML`). Offline, zero deps. Run:
//   node scripts/herd-ui-truthful-tally.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildDeck, PAGE_HTML } from "./herd-ui.mjs";

// A config with three adapters; one has a live worker, one has an inactive
// worker, one has no worker at all — enough to exercise every tally path.
const config = {
  adapters: {
    "claude-opus": { launch: ["x"] },
    codex: { launch: ["y"] },
    "opencode-glm": { launch: ["z"] },
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

// --- #287 criterion 1: the deck header tally counts only adapters with a live
// worker (`activeIssue` set), and a snapshot with zero live workers renders the
// tally as 0. ---
{
  // buildDeck marks only the codex adapter as active (claimActive + matching
  // adapter); the other two are idle/absent.
  const deck = buildDeck({ config, adapters, workers });
  const live = deck.filter((c) => c.activeIssue != null);
  assert.equal(live.length, 1, "only one adapter has a live worker");
  assert.equal(live[0].name, "codex", "the live adapter is codex");

  // A snapshot with zero live workers: no worker has claimActive.
  const idleDeck = buildDeck({
    config,
    adapters,
    workers: [{ adapter: "codex", claimActive: false, issue: 5 }],
  });
  assert.equal(idleDeck.filter((c) => c.activeIssue != null).length, 0, "zero live workers → zero active issues");

  // The client counts only live adapters for the tally, not cards.length.
  assert.ok(PAGE_HTML.includes("cards.filter((c) => c.activeIssue != null)"), "the tally filters by activeIssue != null");
}

// --- #287 criterion 2: the configured-adapter count remains visible in the
// header, so fleet composition is not lost (revised by #319: the roster reads
// "N agents" and the note shows the real "max <maxWorkers> live" cap — the
// decorative bay capacity is gone). ---
{
  // The header carries a roster element showing the configured count.
  assert.ok(PAGE_HTML.includes('class="roster"'), "the deck header has a roster element");
  assert.ok(PAGE_HTML.includes('id="deckroster"'), "the roster element has a stable id");
  // The client updates it with the configured-adapter count at render time.
  assert.ok(PAGE_HTML.includes('rosterEl.textContent = String(cards.length) + " agents"'), "the roster reads the configured count as 'N agents'");
  // The note shows the real dispatch cap, never a decorative bay count.
  assert.ok(PAGE_HTML.includes('"max " + snapshot.maxWorkers + " live'), "the note shows the real max-workers cap");
  assert.ok(!PAGE_HTML.includes("bays"), "no decorative bay capacity is mentioned");
}

// --- #287 criterion 3: the third vitals cell is labelled so it reads as
// successful spawns/launches, not completed work — the string "OK" no longer
// appears as that cell's label. ---
{
  // The vitals strip uses "Launched" (spawn/launch succeeded), not "OK".
  assert.ok(PAGE_HTML.includes('vital("Launched", d.successes)'), 'the third vitals cell is labelled Launched');
  // The string "OK" must not appear as a vitals label in the deck cards.
  assert.ok(!PAGE_HTML.includes('vital("OK"'), 'the string "OK" no longer appears as a vitals cell label');
}

// --- #287 criterion 4: buildDeck still projects one entry per configured
// adapter (the roster source) even with zero live workers, and the deck section
// is hidden only when nothing is configured — not merely because nothing is
// active. (Since #300 the *render* draws a mascot card only for live workers;
// this projection still carries every configured adapter so the roster count
// stays truthful — see herd-ui-mascot-deck-live.test.mjs.) ---
{
  // With no live workers, buildDeck still returns one entry per configured
  // adapter — the projection is the roster, so its count is never empty just
  // because nothing is active.
  const deck = buildDeck({ config, adapters, workers: [] });
  assert.equal(deck.length, 3, "all three configured adapters remain in the roster projection with zero live workers");
  assert.deepEqual(deck.map((c) => c.name), ["claude-opus", "codex", "opencode-glm"], "roster order follows config, not liveness");
  assert.ok(deck.every((c) => c.activeIssue === null), "no entry has an active issue when no worker is live");

  // The client always shows the section once a snapshot arrives (the worker
  // groups live inside it), and paints the friendly empty state — never a
  // blank grid — when nothing is live (revised by #319).
  assert.ok(PAGE_HTML.includes("wrap.hidden = false"), "the section always shows once a snapshot arrives");
  assert.ok(PAGE_HTML.includes("emptyEl.hidden = live.length > 0"), "the empty state shows exactly when nothing is live");
  assert.ok(PAGE_HTML.includes('id="deckempty"'), "the friendly empty-state block exists");
}

// --- #287 criterion 5: every criterion above has exactly one test named after
// it. ---
{
  const self = readFileSync(new URL("./herd-ui-truthful-tally.test.mjs", import.meta.url), "utf8");
  for (let i = 1; i <= 5; i++) {
    const hits = (self.match(new RegExp(`#287 criterion ${i}:`, "g")) || []).length;
    assert.equal(hits, 1, `#287 criterion ${i} must have exactly one test named after it`);
  }
}

console.log("PASS herd-ui-truthful-tally.test.mjs (5 criteria)");
