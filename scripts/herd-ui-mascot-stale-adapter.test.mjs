#!/usr/bin/env node
// herd-ui-mascot-stale-adapter.test.mjs — the acceptance criteria of issue #407
// (plan 0170) are the test plan: exactly one test per criterion, driven through
// herd-ui.mjs's public interface (the exported buildWorkers / buildDeck
// projections and the server-rendered PAGE_HTML script). A state entry pins the
// adapter's config name at dispatch time; renaming or removing that adapter
// afterwards makes the deck-roster lookup miss on the stale name. This suite
// pins the render-side fallback: the worker still gets its mascot character
// card, self-described from its own avatar and recorded name, minus the vitals
// that belong to configured adapters. Offline, zero deps. Run:
//   node scripts/herd-ui-mascot-stale-adapter.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildWorkers, buildDeck, adapterFamily, PAGE_HTML } from "./herd-ui.mjs";

// A herd where config knows only "beta", but a live worker's state entry was
// dispatched under "alpha-old" — an adapter since renamed or removed. A second
// worker carries no adapter at all (the survey's stale-claim sentinel shape).
const config = { adapters: { beta: {} }, reworkCap: 2, claimTimeoutSeconds: 300 };
const state = {
  5: { adapter: "alpha-old", status: "working", pid: 111 },
  6: { status: "stale-claim" },
};
const workers = buildWorkers({ state, events: [], config, now: 1_000_000 });
const stale = workers.find((w) => w.issue === 5);
const bare = workers.find((w) => w.issue === 6);
// The deck roster projects only configured adapters, so "alpha-old" is absent —
// this is exactly the lookup the client's rowHtml misses on.
const deck = buildDeck({ config, adapters: [], workers });

// The client branch that renders the stale-adapter fallback card: everything
// from its `if (w.adapter)` guard up to the plain-row assignee comment. Isolated
// so criterion 2 can assert on this branch alone, not the rostered card above.
const FALLBACK = /\n\s*if \(w\.adapter\) \{([\s\S]*?)\n\s*\/\/ Assignee with avatar chip/.exec(PAGE_HTML);

// --- #407 criterion 1: a worker whose recorded adapter is absent from the deck
// roster still renders the mascot character card, using the row's own avatar
// (or the bundled default) and the recorded adapter name. ---
{
  assert.equal(stale.adapter, "alpha-old", "the worker keeps its recorded adapter name");
  assert.equal(stale.family, adapterFamily("alpha-old"), "the row carries the family derived by adapterFamily — one implementation, no client drift");
  assert.equal(stale.family, "alpha", "the family is the segment before the first hyphen of the recorded name");
  assert.equal(stale.avatar, null, "no configured adapter means no resolved avatar — the card falls back to the bundled default");
  assert.ok(typeof stale.defaultAvatar === "string" && stale.defaultAvatar.startsWith("data:"), "the row carries a bundled default avatar as a valid data URI");
  assert.ok(!deck.some((c) => c.name === "alpha-old"), "the deck roster has no entry for the renamed-away adapter, so rowHtml's deck lookup misses");

  assert.ok(FALLBACK, "rowHtml has an `if (w.adapter)` fallback branch after the rostered `if (d)` card");
  const body = FALLBACK[1];
  assert.ok(body.includes('<article class="mascot-card'), "the fallback still renders the mascot character card, not the plain row");
  assert.ok(body.includes("const src = w.avatar || w.defaultAvatar;"), "the card's figure uses the row's own avatar, falling back to the bundled default");
  assert.ok(body.includes("esc(w.adapter)"), "the card names the worker's recorded adapter");
  assert.ok(body.includes("esc(w.family)"), "the card labels the family from the row's own family field");
}

// --- #407 criterion 2: that card omits the per-adapter vitals block
// (dispatches/failures/successes) — those stats belong to configured adapters
// only. ---
{
  assert.ok(FALLBACK, "the fallback branch is present");
  const body = FALLBACK[1];
  assert.ok(!body.includes("vital("), "the stale-adapter card renders no vital() cells");
  assert.ok(!body.includes('class="vitals"'), "the stale-adapter card has no vitals block");
  assert.ok(!/dispatches|failures|successes/.test(body), "no per-adapter dispatch tally leaks onto the unconfigured adapter's card");
  // The rostered card still carries its vitals — the omission is specific to the
  // stale-adapter fallback, not a global removal.
  assert.ok(PAGE_HTML.includes('vital("Disp.", d.dispatches)'), "the rostered adapter's card keeps its vitals block");
}

// --- #407 criterion 3: an adapterless row (e.g. the survey's stale-claim
// sentinel) keeps the plain row with the faint em dash. ---
{
  assert.equal(bare.adapter, null, "a worker with no recorded adapter has a null adapter");
  // The fallback card is guarded by `if (w.adapter)`, so a null adapter falls
  // through it to the plain-row branch below.
  assert.ok(/\n\s*if \(w\.adapter\) \{/.test(PAGE_HTML), "the mascot fallback is gated on a truthy adapter, so an adapterless row skips it");
  assert.ok(PAGE_HTML.includes('<span class="who"><span class="empty">—</span></span>'), "the plain row shows the faint em dash for an unassigned worker");
  assert.ok(PAGE_HTML.includes(`'<article class="row' + sel + '" data-issue="'`), "the adapterless worker still renders the plain row article");
}

// --- #407 criterion 4: every criterion above has exactly one test named after
// it. ---
{
  const self = readFileSync(new URL("./herd-ui-mascot-stale-adapter.test.mjs", import.meta.url), "utf8");
  for (let i = 1; i <= 4; i++) {
    const hits = (self.match(new RegExp(`#407 criterion ${i}:`, "g")) || []).length;
    assert.equal(hits, 1, `#407 criterion ${i} must have exactly one test named after it`);
  }
}

console.log("PASS herd-ui-mascot-stale-adapter.test.mjs (4 criteria)");
