#!/usr/bin/env node
// herd-ui-supervisor-status.test.mjs — the acceptance criteria of issue #305 are
// the test plan: exactly one test per criterion of the supervisor-status header
// (the live dot turns green only when online, and a details area reports the
// supervisor's state, freshness, and poll cadence). Driven through herd-ui.mjs's
// public interface — the pure liveness classifier, the snapshot builder, and the
// served PAGE_HTML whose client-side renderHeartbeat drives the dot and details.
// Offline, zero deps. Run:
//   node scripts/herd-ui-supervisor-status.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PAGE_HTML,
  readSnapshot,
  heartbeatStatus,
  heartbeatThresholdSeconds,
} from "./herd-ui.mjs";
import { DEFAULTS } from "./herd.mjs";

const NOW = Date.parse("2026-07-11T12:00:00.000Z");
const POLL = 60;
const threshold = heartbeatThresholdSeconds(POLL);

// Write an events stream carrying a single heartbeat `ageSeconds` before NOW
// (or none when null) and read the snapshot the dashboard would serve.
function snapAt(ageSeconds) {
  const dir = mkdtempSync(join(tmpdir(), "herd-supstatus-"));
  try {
    const eventsPath = join(dir, "events.jsonl");
    const lines = [];
    if (ageSeconds != null) {
      const ts = new Date(NOW - ageSeconds * 1000).toISOString();
      lines.push(JSON.stringify({ ts, event: "heartbeat" }));
    }
    writeFileSync(eventsPath, lines.join("\n") + (lines.length ? "\n" : ""));
    return readSnapshot({
      statePath: join(dir, "state.json"),
      eventsPath,
      escalationsPath: join(dir, "escalations.jsonl"),
      resolutionsPath: join(dir, "resolutions.jsonl"),
      config: { ...DEFAULTS, pollSeconds: POLL },
      now: NOW,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- #305 criterion 1: when the last heartbeat is within the freshness
// threshold, the supervisor live dot is green. ---
{
  // The classifier reads a within-threshold heartbeat as live...
  const fresh = heartbeatStatus({ lastHeartbeatTs: new Date(NOW - (threshold - 1) * 1000).toISOString(), thresholdSeconds: threshold, now: NOW });
  assert.equal(fresh.state, "live", "a heartbeat within the threshold classifies as live");

  // ...and the served page paints the .dot.live in the green token, never the
  // old lavender, and its live branch adds the `live` class to the dot.
  assert.match(PAGE_HTML, /--live:\s*#1f9d78/, "a dedicated green token backs the live dot");
  assert.match(PAGE_HTML, /header \.dot\.live \{ background:var\(--live\)/, "the live dot uses the green token");
  assert.doesNotMatch(PAGE_HTML, /\.dot\.live \{ background:#8f9ad0/, "the live dot is no longer lavender");
  assert.match(PAGE_HTML, /dot\.classList\.add\("live"\)/, "the live branch turns the dot green");
}

// --- #305 criterion 2: when online, a supervisor details area shows the status
// ("live"/"online"), the age since the last heartbeat, and the poll interval. ---
{
  const snap = snapAt(30);
  assert.equal(snap.heartbeat.state, "live", "a 30s-old heartbeat is online");
  assert.equal(snap.heartbeat.ageSeconds, 30, "the snapshot carries the freshness (age)");
  assert.equal(snap.heartbeat.pollSeconds, POLL, "the snapshot carries the poll cadence");

  // The details area exists in the page and its live branch fills status, age,
  // and poll interval.
  assert.match(PAGE_HTML, /id="hbdetails"/, "the header has a supervisor details area");
  assert.match(PAGE_HTML, /id="hbstatus"[\s\S]*id="hbmeta"/, "the details area has a status and a meta slot");
  assert.match(PAGE_HTML, /statusEl\.textContent = "live"/, "the live branch reports the status");
  assert.match(PAGE_HTML, /"polls every " \+ durText\(hb\.pollSeconds\)/, "the details report the poll interval");
  assert.match(PAGE_HTML, /metaEl\.textContent = "heartbeat " \+ durText\(age\)/, "the live details report the age since the last heartbeat");
}

// --- #305 criterion 3: when no heartbeat has ever been seen, the details show
// "not seen" and the dot is NOT green (no false-positive online state). ---
{
  const snap = snapAt(null);
  assert.equal(snap.heartbeat.lastHeartbeatTs, null, "no heartbeat has been seen");
  assert.equal(snap.heartbeat.state, "unseen", "the classifier reports unseen, never a live guess");

  // The page's unseen branch removes the green and labels the details "not seen".
  assert.match(PAGE_HTML, /statusEl\.textContent = "not seen"/, "the unseen details read 'not seen'");
  assert.match(PAGE_HTML, /hb\.lastHeartbeatTs == null[\s\S]*?dot\.classList\.remove\("live"\)/, "the unseen branch clears the green dot");
}

// --- #305 criterion 4: when heartbeats have stopped (age exceeds the
// threshold), the details show "silent" with the time since the last heartbeat,
// and the dot is NOT green. ---
{
  const snap = snapAt(threshold + 120);
  assert.equal(snap.heartbeat.state, "silent", "a past-threshold heartbeat classifies as silent");
  assert.ok(snap.heartbeat.ageSeconds > threshold, "the age exceeds the freshness threshold");

  // The page's silent branch removes the green and reports the elapsed silence.
  assert.match(PAGE_HTML, /statusEl\.textContent = "silent"/, "the silent details read 'silent'");
  assert.match(PAGE_HTML, /metaEl\.textContent = "last heartbeat " \+ durText\(age\) \+ " ago"/, "the silent details report the time since the last heartbeat");
  assert.match(PAGE_HTML, /age > hb\.thresholdSeconds[\s\S]*?dot\.classList\.remove\("live"\)/, "the silent branch clears the green dot");
}

// --- #305 criterion 5: every criterion above has exactly one test named after
// it. ---
{
  const self = readFileSync(new URL("./herd-ui-supervisor-status.test.mjs", import.meta.url), "utf8");
  for (const c of ["criterion 1", "criterion 2", "criterion 3", "criterion 4", "criterion 5"]) {
    const hits = (self.match(new RegExp(`#305 ${c}:`, "g")) || []).length;
    assert.equal(hits, 1, `#305 ${c} must have exactly one test named after it`);
  }
}

console.log("PASS herd-ui-supervisor-status.test.mjs (5 criteria)");
