#!/usr/bin/env node
// ratchet-metrics.test.mjs — behaviour tests for the loop-health metrics.
// Zero dependencies. Run:  node scripts/ratchet-metrics.test.mjs
//
// One test per acceptance criterion of issue #20, exercised through the public
// interface (computeMetrics + renderReport) with a fake fetch — no network:
//   1. Reports cycle time, rework rate, sweep count, and queue depth by state,
//      aggregated from GitHub data.
//   2. Read-only: it issues GET requests exclusively and never mutates anything.
//   3. A repo with little/no history yields a clear "not enough data" message
//      per metric, never an error or a misleading zero.

import assert from "node:assert/strict";
import { computeMetrics, renderReport } from "./ratchet-metrics.mjs";

const respond = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });

// Build a fake fetch over a fixture of issues + per-issue timelines. Records
// every request's method so the read-only guarantee can be asserted.
function makeFetch(issues, timelines) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET" });
    const { pathname, searchParams } = new URL(url);
    const page = Number(searchParams.get("page") || "1");
    if (pathname.endsWith("/issues")) return respond(page === 1 ? issues : []);
    const tl = pathname.match(/\/issues\/(\d+)\/timeline$/);
    if (tl) return respond(page === 1 ? (timelines[tl[1]] || []) : []);
    throw new Error(`unexpected request: ${url}`);
  };
  return { fetchImpl, calls };
}

const iso = (s) => new Date(Date.UTC(2026, 0, s)).toISOString(); // Jan <s>, 2026
const labeled = (name, day) => ({ event: "labeled", label: { name }, created_at: iso(day) });
const swept = (day) => ({ event: "commented", body: "Stale claim swept: no activity on `agent/issue-9`...", created_at: iso(day) });

// --- Criterion 1: reports all four metrics from GitHub data --------------
{
  const issues = [
    { number: 101, state: "open", labels: [{ name: "state:ready" }] },
    { number: 102, state: "open", labels: [{ name: "state:in-progress" }] },
    { number: 103, state: "open", labels: [{ name: "state:blocked" }] },
    { number: 201, state: "closed", state_reason: "completed", closed_at: iso(3), labels: [] },
    { number: 202, state: "closed", state_reason: "completed", closed_at: iso(9), labels: [] },
  ];
  const timelines = {
    201: [labeled("state:ready", 1)],                                  // 2-day cycle, no rework
    202: [labeled("state:ready", 5), labeled("state:changes-requested", 7), swept(6)], // 4-day cycle, reworked, 1 sweep
    102: [swept(8)],                                                   // sweep on an open issue
  };
  const { fetchImpl } = makeFetch(issues, timelines);
  const m = await computeMetrics({ fetchImpl, token: "t", repo: "o/r" });
  assert.equal(m.queueDepth.ready, 1, "queue depth counts state:ready");
  assert.equal(m.queueDepth["in-progress"], 1, "queue depth counts state:in-progress");
  assert.equal(m.queueDepth.blocked, 1, "queue depth counts state:blocked");
  assert.equal(m.cycles.length, 2, "both completed issues yield a cycle-time sample");
  assert.equal(m.completedConsidered, 2, "both completed issues counted for rework");
  assert.equal(m.reworked, 1, "one completed issue passed through changes-requested");
  assert.equal(m.sweepCount, 2, "sweeps counted on both closed and open issues");

  const report = renderReport(m);
  for (const section of ["Queue depth by state", "Cycle time (ready → merged)", "Rework rate", "Stale-claim sweeps"]) {
    assert.ok(report.includes(section), `report includes the ${section} section`);
  }
  assert.ok(/50%/.test(report), "rework rate renders as 50%");
  assert.ok(/2 sweep\(s\)/.test(report), "sweep count renders");
}

// --- Criterion 2: read-only — GET requests only, no mutation ------------
{
  const issues = [{ number: 301, state: "closed", state_reason: "completed", closed_at: iso(2), labels: [] }];
  const { fetchImpl, calls } = makeFetch(issues, { 301: [labeled("state:ready", 1)] });
  await computeMetrics({ fetchImpl, token: "t", repo: "o/r" });
  assert.ok(calls.length > 0, "the metrics run actually hit the API");
  for (const c of calls) {
    assert.equal(c.method, "GET", `every request must be GET (mutation attempted: ${c.method} ${c.url})`);
  }
}

// --- Criterion 3: little/no history → "not enough data", never a zero ---
{
  const issues = [{ number: 401, state: "open", labels: [{ name: "state:ready" }] }];
  const { fetchImpl } = makeFetch(issues, { 401: [] });
  const m = await computeMetrics({ fetchImpl, token: "t", repo: "o/r" });
  const report = renderReport(m);
  assert.ok(/Cycle time[\s\S]*?Not enough data/.test(report), "cycle time reports 'not enough data' with no completions");
  assert.ok(/Rework rate[\s\S]*?Not enough data/.test(report), "rework rate reports 'not enough data' with no completions");
  assert.ok(!/0%/.test(report), "a data-poor repo must not show a misleading 0%");
  assert.ok(!/0\.0h/.test(report), "a data-poor repo must not show a misleading 0.0h cycle time");
  assert.ok(/state:ready|- ready: 1/.test(report), "queue depth still renders from the one open issue");
}

console.log("PASS ratchet-metrics.test.mjs (3 criteria, 20 assertions)");

// --- issue #52: count all three sweep types, tied to the sweep script -------
import { decideSweep, SWEPT_STATES, SWEEP_COMMENT_PREFIXES } from "./sweep-stale-claims.mjs";
import { SWEEP_PREFIXES } from "./ratchet-metrics.mjs";

// #52 AC1: each of the three sweep comment prefixes emitted by
// sweep-stale-claims.mjs is counted as a sweep event (the old code matched only
// `Stale claim swept:` and silently dropped the review and rework sweeps).
{
  const day = (n) => ({ event: "commented", created_at: iso(n) });
  const issues = [{ number: 501, state: "open", labels: [{ name: "state:blocked" }] }];
  const timelines = {
    501: [
      { ...day(1), body: `${SWEEP_COMMENT_PREFIXES["state:in-progress"]} \`agent/issue-1\` had no work...` },
      { ...day(2), body: `${SWEEP_COMMENT_PREFIXES["state:in-review"]} \`agent/issue-1\` is state:in-review but has no open PR...` },
      { ...day(3), body: `${SWEEP_COMMENT_PREFIXES["state:changes-requested"]} \`agent/issue-1\` is state:changes-requested with no activity...` },
    ],
  };
  const { fetchImpl } = makeFetch(issues, timelines);
  const m = await computeMetrics({ fetchImpl, token: "t", repo: "o/r" });
  assert.equal(m.sweepCount, 3, "all three sweep types (claim, review, rework) are counted");
}

// #52 AC2: a drift test ties the metric's prefixes to the sweep script's — the
// metric matches whatever prefix decideSweep can actually post for every swept
// state, so adding a fourth sweep type cannot silently undercount again.
{
  // The metric's match set is derived from the sweep's own definition, not a
  // hand-copied list — that shared definition is what prevents drift.
  assert.deepEqual(
    SWEEP_PREFIXES, Object.values(SWEEP_COMMENT_PREFIXES),
    "the metric matches exactly the prefixes the sweep script defines",
  );
  // Every swept state must have a prefix, or its comment could not be built.
  for (const state of SWEPT_STATES) {
    assert.ok(SWEEP_COMMENT_PREFIXES[state], `every swept state defines a prefix (missing: ${state})`);
  }
  // Drive decideSweep to a real sweep for each swept state, then assert the
  // metric would count the exact comment it produces. Inputs are stale enough
  // to trip every time-based state.
  const HOUR = 3600 * 1000, nowMs = 1_700_000_000_000, staleMs = 2 * HOUR;
  const past = nowMs - staleMs - HOUR;
  const inputs = {
    "state:in-progress": { aheadBy: 0, lastCommitAt: null, claimAt: past, heartbeatAt: null, updatedAt: past },
    "state:in-review": { hasOpenPr: false },
    "state:changes-requested": { lastCommitAt: past, heartbeatAt: null, updatedAt: past },
  };
  for (const state of SWEPT_STATES) {
    const d = decideSweep({ state, now: nowMs, staleMs, staleHours: "2", branch: "agent/issue-9", ...inputs[state] });
    assert.equal(d.sweep, true, `decideSweep must sweep ${state} for this drift check`);
    assert.ok(
      SWEEP_PREFIXES.some((p) => d.comment.startsWith(p)),
      `the metric counts the comment the sweep emits for ${state}: ${d.comment}`,
    );
  }
}

console.log("PASS ratchet-metrics.test.mjs #52 (2 criteria, 8 assertions)");
