#!/usr/bin/env node
// herd-ui-adapter-failures.test.mjs — the acceptance criteria of issue #185 are
// the test plan: exactly one test per criterion of per-adapter dispatch-failure
// aggregation in the herd dashboard, driven through herd-ui.mjs's public
// interface (the pure functions that compute the snapshot from the event
// stream). Offline, zero deps. Run:
//   node scripts/herd-ui-adapter-failures.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { adapterDispatchStats, brokenAdapters, BROKEN_ADAPTER_THRESHOLD } from "./herd-ui.mjs";

// A dispatch event as herd-dispatch.mjs writes it: the routed adapter and a
// status of "dispatched" (worker started) or "dispatch-failed" (it never did).
const dispatch = (adapter, status) => ({ event: "dispatch", issue: 1, adapter, status });

// --- #185 criterion 1: an all-failing adapter is surfaced as ONE aggregate
// alert naming the adapter and its failure ratio, not one per failure. ---
{
  const events = [
    dispatch("opencode-glm", "dispatch-failed"),
    dispatch("opencode-glm", "dispatch-failed"),
    dispatch("opencode-glm", "dispatch-failed"),
  ];
  const alerts = brokenAdapters(adapterDispatchStats(events));
  assert.equal(alerts.length, 1, "three failures on one adapter must fold into a single aggregate alert, not multiply");
  assert.equal(alerts[0].adapter, "opencode-glm", "the alert must name the failing adapter");
  assert.equal(alerts[0].ratio, "3/3", "the alert must state the failure ratio");
}

// --- #185 criterion 2: a per-adapter breakdown shows dispatches, failures, and
// successes computed from the event stream. ---
{
  const events = [
    dispatch("opencode-glm", "dispatch-failed"),
    dispatch("opencode-glm", "dispatched"),
    dispatch("claude", "dispatched"),
    dispatch("claude", "dispatched"),
  ];
  const stats = adapterDispatchStats(events);
  const glm = stats.find((s) => s.adapter === "opencode-glm");
  const claude = stats.find((s) => s.adapter === "claude");
  assert.deepEqual(
    { dispatches: glm.dispatches, failures: glm.failures, successes: glm.successes },
    { dispatches: 2, failures: 1, successes: 1 },
    "opencode-glm breakdown must count 2 dispatches, 1 failure, 1 success",
  );
  assert.deepEqual(
    { dispatches: claude.dispatches, failures: claude.failures, successes: claude.successes },
    { dispatches: 2, failures: 0, successes: 2 },
    "claude breakdown must count 2 dispatches, 0 failures, 2 successes",
  );
}

// --- #185 criterion 3: an adapter with a mix of failures and successes is not
// flagged as broken. ---
{
  const events = [
    dispatch("opencode-glm", "dispatch-failed"),
    dispatch("opencode-glm", "dispatch-failed"),
    dispatch("opencode-glm", "dispatch-failed"),
    dispatch("opencode-glm", "dispatched"),
  ];
  // Four dispatches, three failed — above the threshold — but one succeeded.
  assert.ok(BROKEN_ADAPTER_THRESHOLD <= 3, "the test assumes a small threshold");
  const alerts = brokenAdapters(adapterDispatchStats(events));
  assert.equal(alerts.length, 0, "an adapter with any success must not be flagged as broken");
}

// --- #185 criterion 4: adapters with no recorded dispatches are omitted from
// the breakdown rather than shown as 0/0. ---
{
  const events = [
    dispatch("opencode-glm", "dispatch-failed"),
    // claude appears only in a non-dispatch event and in a null-adapter route
    // failure — neither is an attributable dispatch, so it must not appear.
    { event: "worker-exit", issue: 2, adapter: "claude", status: "in-review" },
    { event: "dispatch", issue: 3, adapter: null, status: "dispatch-failed" },
  ];
  const stats = adapterDispatchStats(events);
  assert.deepEqual(
    stats.map((s) => s.adapter),
    ["opencode-glm"],
    "only adapters with a recorded dispatch appear; no 0/0 rows, no null-adapter row",
  );
}

// --- #185 criterion 5: every criterion above has exactly one test named after
// it. ---
{
  const self = readFileSync(new URL("./herd-ui-adapter-failures.test.mjs", import.meta.url), "utf8");
  for (const c of ["criterion 1", "criterion 2", "criterion 3", "criterion 4", "criterion 5"]) {
    const hits = (self.match(new RegExp(`#185 ${c}:`, "g")) || []).length;
    assert.equal(hits, 1, `#185 ${c} must have exactly one test named after it`);
  }
}

console.log("PASS herd-ui-adapter-failures.test.mjs (5 criteria)");
