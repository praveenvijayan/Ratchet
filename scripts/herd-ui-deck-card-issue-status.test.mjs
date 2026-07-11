#!/usr/bin/env node
// herd-ui-deck-card-issue-status.test.mjs — the acceptance criteria of issue
// #307 are the test plan: exactly one test per criterion of the active agent
// card showing the worked issue number and the agent's current worker status.
// Driven through herd-ui.mjs's public interface — the pure `buildDeck`
// projection and the server-rendered `PAGE_HTML`. Offline, zero deps. Run:
//   node scripts/herd-ui-deck-card-issue-status.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildDeck, PAGE_HTML } from "./herd-ui.mjs";

// Six configured adapters (roster 6); three carry a live worker with a status,
// one is inactive, two have no worker at all. The live workers carry distinct
// statuses so every card-mirror assertion can target a known value.
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
const workers = [
  { adapter: "claude-opus", claimActive: true, issue: 101, status: "in-review" },
  { adapter: "codex", claimActive: true, issue: 202, status: "reworking" },
  { adapter: "opencode-glm", claimActive: false, issue: 9, status: "dispatched" },
];

// --- #307 criterion 1: each active agent card shows the issue number the agent
// is working on (e.g. "#123"). ---
{
  const deck = buildDeck({ config, adapters, workers });
  const byName = Object.fromEntries(deck.map((c) => [c.name, c]));
  // A live worker's issue is carried onto its card as the worked issue number.
  assert.equal(byName.codex.activeIssue, 202, "a live card carries the worker's issue number");
  assert.equal(byName["claude-opus"].activeIssue, 101, "a live card carries the worker's issue number");
  // An adapter with no live worker carries no issue (never a partial "#undefined").
  assert.equal(byName.gemini.activeIssue, null, "an idle adapter carries no issue");
  assert.equal(byName["opencode-glm"].activeIssue, null, "an inactive worker is idle");
  // The client renders that issue number on the card as "#<issue>" inside the
  // duty chip, so the worked issue is legible at a glance.
  assert.ok(PAGE_HTML.includes("dispatched · #' + String(c.activeIssue)"), "the card renders the worked issue number prefixed with #");
  assert.ok(!PAGE_HTML.includes("#undefined"), "no #undefined is ever rendered on a card");
}

// --- #307 criterion 2: each active agent card shows the agent's current worker
// status (the same status the worker row reports). ---
{
  const deck = buildDeck({ config, adapters, workers });
  const byName = Object.fromEntries(deck.map((c) => [c.name, c]));
  // The card carries the live worker's status verbatim — the same `status` field
  // buildWorkers reads from the state entry, so the card and the row agree.
  assert.equal(byName.codex.activeStatus, "reworking", "the card carries the live worker's current status");
  assert.equal(byName["claude-opus"].activeStatus, "in-review", "the card carries the live worker's current status");
  // An adapter with no live worker has no status to mirror.
  assert.equal(byName.gemini.activeStatus, null, "an idle adapter carries no status");
  // The client renders that status in a chip styled via the same statusClass the
  // worker row uses, so the card's status visually matches the row's.
  assert.ok(PAGE_HTML.includes("statusClass(c.activeStatus)"), "the card applies the worker-row statusClass to the live status");
  assert.ok(PAGE_HTML.includes("esc(c.activeStatus)"), "the card renders the live status text");
}

// --- #307 criterion 3: a card whose agent has no active issue shows an
// idle/standing-by state rather than a blank value or "#undefined". ---
{
  // No live workers at all: every adapter is idle — activeIssue and activeStatus
  // are both null, never undefined or a partial "#undefined" string.
  const idle = buildDeck({ config, adapters, workers: [] });
  for (const c of idle) {
    assert.equal(c.activeIssue, null, `${c.name} with no live worker has no active issue`);
    assert.equal(c.activeStatus, null, `${c.name} with no live worker has no active status`);
  }
  // The client renders "standing by" for the idle branch, never a blank.
  assert.ok(PAGE_HTML.includes('class="duty idle"><span class="dot"></span>standing by'), "an idle card renders the standing-by state");
  assert.ok(!PAGE_HTML.includes("#undefined"), "no #undefined is ever rendered on a card");
  // A live worker that omits its status field still cards on its issue, and its
  // status reads null (omitted chip), never the literal string "undefined".
  const noStatus = buildDeck({
    config,
    adapters,
    workers: [{ adapter: "codex", claimActive: true, issue: 5 }],
  });
  const codex = noStatus.find((c) => c.name === "codex");
  assert.equal(codex.activeIssue, 5, "a worker without a status field still cards on its issue");
  assert.equal(codex.activeStatus, null, "a missing status yields null, not the string undefined");
}

// --- #307 criterion 4: every criterion above has exactly one test named after
// it. ---
{
  const self = readFileSync(new URL("./herd-ui-deck-card-issue-status.test.mjs", import.meta.url), "utf8");
  for (let i = 1; i <= 4; i++) {
    const hits = (self.match(new RegExp(`#307 criterion ${i}:`, "g")) || []).length;
    assert.equal(hits, 1, `#307 criterion ${i} must have exactly one test named after it`);
  }
}

console.log("PASS herd-ui-deck-card-issue-status.test.mjs (4 criteria)");
