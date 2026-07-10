#!/usr/bin/env node
// herd-retention.test.mjs — the criteria are the test plan. One test per
// acceptance criterion of issue #175 (bound events.jsonl and herd-escalations.md
// growth with retention), driven through herd-retention.mjs's public interface.
// Offline: gh is injected and only the temp-dir files are touched. Zero
// dependencies. Run:  node scripts/herd-retention.test.mjs

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneEvents, pruneEscalations, retentionOnce } from "./herd-retention.mjs";
import { normalizeConfig, defaultConfig } from "./herd.mjs";

const DAY = 86400 * 1000;
const NOW = Date.UTC(2026, 6, 10, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const OLD = iso(NOW - 20 * DAY); // past a 14-day window
const RECENT = iso(NOW - 1 * DAY); // inside it

const evLine = (ts, over = {}) => JSON.stringify({ ts, event: "worker-exit", ...over });
const escBlock = (ts, issue, what) =>
  `## ${ts} — issue #${issue}\n- What happened: ${what}\n- Log file: (none)\n- Suggested action: do X\n\n`;

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-retention-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    return await fn(dir);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

// #175 AC1: event lines older than the retention window are pruned, using the
// same retention knob as worker logs — an invalid `logRetentionDays` fails config
// load with a one-line error naming the file and the field.
await inTempDir(async () => {
  writeFileSync("events.jsonl", [evLine(OLD, { issue: 7 }), evLine(RECENT, { issue: 7 }), JSON.stringify({ ts: OLD, event: "heartbeat" })].join("\n") + "\n");
  const pruned = pruneEvents({ eventsPath: "events.jsonl", retentionDays: 14, state: {}, isAlive: () => false, now: NOW });
  assert.equal(pruned, 2, "the two old lines (worker-exit + heartbeat) are pruned");
  const left = readFileSync("events.jsonl", "utf8").trim().split("\n");
  assert.equal(left.length, 1, "only the in-window line remains");
  assert.match(left[0], new RegExp(RECENT), "the surviving line is the recent one");

  // Same retention knob, same validation: an invalid value names the file and field.
  for (const bad of [0, -1, "x", 1.5]) {
    assert.throws(
      () => normalizeConfig({ ...defaultConfig(), logRetentionDays: bad }),
      (e) => /herd\.json/.test(e.message) && /logRetentionDays/.test(e.message),
      `logRetentionDays=${bad} must fail naming the file and the field`,
    );
  }
});

// #175 AC2: an escalation block older than the window is pruned only when it is
// resolved per the 0082 model (stale-claim ref gone, or PR-concluded issue since
// closed); an unresolved block is never pruned regardless of age.
await inTempDir(async () => {
  const md =
    escBlock(OLD, 7, "stale claim ref agent/issue-7 on origin: no live worker and no open PR. Delete it: gh ...") + // resolved (no sentinel in state) + old -> prune
    escBlock(OLD, 8, "issue #8 is no longer open (closed); its PR-concluded escalation.") + // resolved via closedIssues + old -> prune
    escBlock(OLD, 9, "worker exited 0 without opening a PR — the agent reported a stop.") + // unresolved + old -> KEEP
    escBlock(RECENT, 10, "stale claim ref agent/issue-10 on origin: no live worker."); // resolved but recent -> KEEP
  writeFileSync("esc.md", md);
  const pruned = pruneEscalations({
    escalationsPath: "esc.md",
    retentionDays: 14,
    state: {}, // no stale-claim sentinels -> the stale-claim blocks are resolved
    closedIssues: new Set([8]),
    now: NOW,
  });
  assert.equal(pruned, 2, "the old resolved stale-claim and PR-concluded blocks are pruned");
  const left = readFileSync("esc.md", "utf8");
  assert.ok(!left.includes("issue #7"), "the old resolved stale-claim block is gone");
  assert.ok(!left.includes("issue #8"), "the old resolved PR-concluded block is gone");
  assert.ok(left.includes("issue #9"), "the old UNRESOLVED block survives regardless of age");
  assert.ok(left.includes("issue #10"), "the recent block survives regardless of resolution");
});

// #175 AC3: an event line whose issue still has a live worker survives pruning
// regardless of its age.
await inTempDir(async () => {
  writeFileSync("events.jsonl", [evLine(OLD, { issue: 7 }), evLine(OLD, { issue: 8 })].join("\n") + "\n");
  const state = { 7: { pid: 5555, status: "reworking" }, 8: { pid: null, status: "ready-for-review" } };
  const pruned = pruneEvents({ eventsPath: "events.jsonl", retentionDays: 14, state, isAlive: (pid) => pid === 5555, now: NOW });
  assert.equal(pruned, 1, "only the old line whose issue has no live worker is pruned");
  const left = readFileSync("events.jsonl", "utf8");
  assert.ok(left.includes('"issue":7'), "the old line for the live worker's issue survives");
  assert.ok(!left.includes('"issue":8'), "the old line for the dead worker's issue is pruned");
});

// #175 AC4: the poll summary line reports how many event lines and escalation
// blocks were pruned this pass. The PR-concluded resolution is gathered from a
// bounded `gh issue view` per issue.
await inTempDir(async () => {
  writeFileSync("events.jsonl", [evLine(OLD, { issue: 7 }), evLine(RECENT, { issue: 7 })].join("\n") + "\n");
  writeFileSync("esc.md", escBlock(OLD, 8, "issue #8 is no longer open (closed)."));
  const logs = [];
  const gh = async (args) => {
    assert.deepEqual(args, ["issue", "view", "8", "--json", "state"], "closed-issue resolution is a bounded per-issue lookup");
    return { state: "CLOSED" };
  };
  const r = await retentionOnce({
    config: { ...defaultConfig(), logRetentionDays: 14 },
    statePath: "state.json",
    eventsPath: "events.jsonl",
    escalationsPath: "esc.md",
    gh,
    isAlive: () => false,
    now: () => NOW,
    log: (m) => logs.push(m),
  });
  assert.equal(r.prunedEvents, 1);
  assert.equal(r.prunedEscalations, 1);
  const summary = logs.find((l) => /retention/.test(l));
  assert.ok(summary, "a poll summary line is emitted");
  assert.match(summary, /1 event line/, "the summary reports the pruned event count");
  assert.match(summary, /1 escalation block/, "the summary reports the pruned escalation count");
});

// #175 AC5: every criterion above has exactly one test named after it — this file
// declares AC1–AC4 once each, no padding.
{
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  for (const ac of ["AC1", "AC2", "AC3", "AC4"]) {
    const hits = (self.match(new RegExp(`#175 ${ac}:`, "g")) || []).length;
    assert.equal(hits, 1, `#175 ${ac} has exactly one test named after it`);
  }
}

console.log("PASS herd-retention.test.mjs");
