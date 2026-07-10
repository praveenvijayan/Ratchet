#!/usr/bin/env node
// herd-ui-summary-strip.test.mjs — the acceptance criteria of issue #177 are the
// test plan: exactly one test per criterion of the one-glance fleet-summary
// strip, driven through herd-ui.mjs's public interface (the pure summary builder,
// the ready-queue cache, and the SSE change key). Offline, zero deps. Run:
//   node scripts/herd-ui-summary-strip.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildSummary, createReadyQueueCache, snapshotKey } from "./herd-ui.mjs";

// A minimal snapshot the way snapshotKey consumes one — only the fields it reads.
const snap = (summary, workers = []) => ({
  workers,
  escalations: [],
  hint: null,
  totals: null,
  heartbeat: {},
  adapters: [],
  brokenAdapters: [],
  summary,
});

// --- #177 criterion 1: the strip shows ready-queue depth, live workers, open
// PRs awaiting review, and unresolved escalations. ---
{
  const workers = [
    { pid: 10, group: "live", pr: null },
    { pid: 12, group: "live", pr: null },
    { pid: null, group: "awaiting-review", pr: 5 },
    { pid: null, group: "awaiting-review", pr: 5 }, // same PR, counted once
    { pid: null, group: "awaiting-review", pr: 9 },
  ];
  const escalations = [{ resolved: false }, { resolved: true }, { resolved: false }];
  const summary = buildSummary({ workers, escalations, readyQueue: { count: 4 } });
  assert.deepEqual(summary.ready, { value: 4 }, "ready shows the state:ready queue depth");
  assert.deepEqual(summary.liveWorkers, { value: 2 }, "live workers counts alive pids in the live group");
  assert.deepEqual(summary.awaitingReview, { value: 2 }, "awaiting review counts distinct open PRs");
  assert.deepEqual(summary.unresolvedEscalations, { value: 2 }, "escalations counts only the unresolved ones");
}

// --- #177 criterion 2: the counts update live as state and events change,
// without a page reload — i.e. a changed count changes the SSE push key. ---
{
  const before = snapshotKey(snap(buildSummary({ workers: [{ pid: 1, group: "live", pr: null }], escalations: [], readyQueue: { count: 3 } })));
  const afterReady = snapshotKey(snap(buildSummary({ workers: [{ pid: 1, group: "live", pr: null }], escalations: [], readyQueue: { count: 4 } })));
  const afterWorkers = snapshotKey(snap(buildSummary({ workers: [], escalations: [], readyQueue: { count: 3 } })));
  assert.notEqual(before, afterReady, "a changed ready-queue count must change the push key so the strip repaints");
  assert.notEqual(before, afterWorkers, "a changed live-worker count must change the push key so the strip repaints");
}

// --- #177 criterion 3: a count whose source is unavailable shows a placeholder
// naming the failure, never a zero that reads as "all clear". ---
{
  // buildSummary surfaces the query error verbatim (the client renders it as a
  // "—" placeholder with the message in a tooltip), never a { value: 0 }.
  const summary = buildSummary({ workers: [], escalations: [], readyQueue: { error: "ready-queue query failed: gh not found" } });
  assert.deepEqual(summary.ready, { error: "ready-queue query failed: gh not found" }, "an unavailable ready count carries the failure, not a value");
  assert.equal(summary.ready.value, undefined, "an unavailable count must never render as a zero value");

  // The ready-queue cache turns a failed fetch into that { error } reading
  // rather than throwing or reporting a bogus zero.
  const cache = createReadyQueueCache({ fetchReadyCount: async () => { throw new Error("network down"); } });
  cache.ensure("owner/repo");
  await new Promise((r) => setTimeout(r, 10));
  const reading = cache.get();
  assert.ok(reading && reading.error && /network down/.test(reading.error), "a failed ready-queue fetch must surface as an error reading");
  assert.equal(reading.count, undefined, "a failed fetch must not report a count");
}

// --- #177 criterion 4: every criterion above has exactly one test named after
// it. ---
{
  const self = readFileSync(new URL("./herd-ui-summary-strip.test.mjs", import.meta.url), "utf8");
  for (const c of ["criterion 1", "criterion 2", "criterion 3", "criterion 4"]) {
    const hits = (self.match(new RegExp(`#177 ${c}:`, "g")) || []).length;
    assert.equal(hits, 1, `#177 ${c} must have exactly one test named after it`);
  }
}

console.log("PASS herd-ui-summary-strip.test.mjs (4 criteria)");
