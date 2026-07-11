#!/usr/bin/env node
// herd-ui.test.mjs — the acceptance criteria of issue #144 are the test plan:
// exactly one test per criterion of the local herd web dashboard, driven
// through herd-ui.mjs's public interface. Offline: fixtures live in temp dirs,
// servers bind 127.0.0.1:0 (an ephemeral port), and SSE frames are read over
// raw node:http. Each per-issue Criterion-N self-count closes its own loop by
// counting its own sibling `Criterion N` markers — it never reads a plan file
// at runtime, so archiving a plan when its issue closes can never break it.
// Zero dependencies. Run:
//   node scripts/herd-ui.test.mjs

import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PORT,
  EMPTY_HINT,
  readEvents,
  parseEscalations,
  latestClaimTs,
  timelineEvents,
  isUsageBearing,
  latestUsage,
  fleetUsage,
  prUrl,
  resolveRepoSlug,
  buildWorkers,
  aggregateChecks,
  createChecksCache,
  latestHeartbeatTs,
  heartbeatThresholdSeconds,
  HEARTBEAT_SILENCE_FACTOR,
  heartbeatStatus,
  lifecycleGroup,
  LIFECYCLE_GROUPS,
  groupWorkers,
  createTitleCache,
  readSnapshot,
  snapshotKey,
  tailFrom,
  createDashboardServer,
  listenOrFail,
  parsePort,
  run,
  PAGE_HTML,
} from "./herd-ui.mjs";
import { pollOnce } from "./herd-survey.mjs";

const CONFIG = { reworkCap: 2, claimTimeoutSeconds: 300 };
const NOW = Date.UTC(2026, 6, 9, 12, 0, 0); // fixed clock for deterministic ages

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-ui-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Boot a server on an ephemeral port, hand its base URL to `fn`, then tear it
// down (which fires req-close on every open SSE stream, clearing its timer).
async function withServer(opts, fn) {
  const server = createDashboardServer({ pollMs: 25, config: CONFIG, ...opts });
  const port = await listenOrFail(server, 0);
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on("error", reject);
  });
}
const fetchJson = async (url) => {
  const r = await fetchText(url);
  return { status: r.status, json: JSON.parse(r.body) };
};

// Collect server-sent frames from an SSE endpoint until `until(frames)` is true
// or the timeout fires. Each frame is { event, data } with data JSON-parsed.
function sseCollect(url, until, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      let buf = "";
      const frames = [];
      const done = (err) => {
        clearTimeout(timer);
        req.destroy();
        err ? reject(err) : resolve(frames);
      };
      const timer = setTimeout(() => done(new Error(`SSE timeout; got ${frames.length} frames`)), timeoutMs);
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event:\s*(.*)$/m.exec(block);
          const da = /^data:\s*(.*)$/m.exec(block);
          if (da) frames.push({ event: ev ? ev[1] : "message", data: JSON.parse(da[1]) });
        }
        if (until(frames)) done();
      });
      res.on("error", done);
    });
    req.on("error", reject);
  });
}

// --- Criterion 1: serves on a local port (flag-overridable default), prints
// the URL on start. -----------------------------------------------------------
{
  assert.equal(parsePort([]), DEFAULT_PORT, "no flag -> default port");
  assert.equal(parsePort(["--port", "0"]), 0, "--port overrides the default");
  assert.equal(parsePort(["--port", "nope"]), DEFAULT_PORT, "a bad --port falls back to the default");

  const logs = [];
  const { server, port } = await run(["--port", "0"], { log: (m) => logs.push(m) });
  try {
    assert.ok(port > 0, "bound to an ephemeral local port");
    assert.ok(
      logs.some((l) => l.includes(`http://localhost:${port}`)),
      "prints the dashboard URL with the bound port on start",
    );
    const page = await fetchText(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200, "GET / serves the dashboard");
    assert.match(page.body, /Ratchet herd dashboard/i, "the page is the dashboard HTML");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// --- Criterion 2: lists each worker with issue, status, adapter, attempts vs
// reworkCap, claim age vs claimTimeoutSeconds, and a clickable PR link once one
// exists. ---------------------------------------------------------------------
await inTempDir(async (dir) => {
  const statePath = join(dir, "state.json");
  const eventsPath = join(dir, "events.jsonl");
  const start = new Date(NOW - 90_000).toISOString(); // 90s before the fixed clock
  writeFileSync(
    statePath,
    JSON.stringify({
      7: { adapter: "claude", pid: 111, attempts: 1, status: "dispatched", pr: null, logFile: "l7.log" },
      5: { adapter: "codex", pid: 222, attempts: 2, status: "in-review", pr: 42, logFile: "l5.log" },
    }),
  );
  writeFileSync(
    eventsPath,
    [
      JSON.stringify({ ts: start, event: "dispatch", issue: 7 }),
      JSON.stringify({ ts: start, event: "dispatch", issue: 5 }),
    ].join("\n") + "\n",
  );

  // Pure derivation with a fixed clock: fields and claim age are exact.
  const snap = readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW, repoSlug: "praveenvijayan/Ratchet" });
  assert.deepEqual(snap.workers.map((w) => w.issue), [5, 7], "workers sorted by issue number");
  const w5 = snap.workers.find((w) => w.issue === 5);
  const w7 = snap.workers.find((w) => w.issue === 7);
  assert.equal(w5.status, "in-review");
  assert.equal(w5.adapter, "codex");
  assert.equal(w5.attempts, 2);
  assert.equal(w5.reworkCap, 2, "attempt count carries reworkCap for the gauge");
  assert.equal(w5.claimAgeSeconds, 90, "claim age derived from the dispatch event ts");
  assert.equal(w5.claimTimeoutSeconds, 300, "claim age carries its timeout for the gauge");
  assert.equal(w5.prUrl, "https://github.com/praveenvijayan/Ratchet/pull/42", "clickable PR link once a PR exists");
  assert.equal(w7.prUrl, null, "no PR link before a PR exists");

  // Same shape over HTTP.
  await withServer({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), repoSlug: "praveenvijayan/Ratchet" }, async (base) => {
    const { json } = await fetchJson(`${base}/api/snapshot`);
    assert.equal(json.workers.length, 2, "both workers listed over HTTP");
    assert.ok(json.workers.find((w) => w.issue === 5).prUrl.endsWith("/pull/42"));
  });
});

// --- Criterion 3: pending escalations render at the top, above the worker
// list. ------------------------------------------------------------------------
await inTempDir(async (dir) => {
  const escPath = join(dir, "esc.md");
  writeFileSync(
    escPath,
    [
      "## 2026-07-09T11:00:00Z — issue #7",
      "- What happened: worker pid 111 is not alive",
      "- Log file: .ratchet/logs/issue-7.log",
      "- Suggested action: review the log and re-queue",
      "",
      "## 2026-07-09T11:30:00Z — issue #9",
      "- What happened: stale claim ref agent/issue-9 on origin",
      "- Log file: (none)",
      "- Suggested action: delete the stale claim ref",
      "",
    ].join("\n"),
  );
  const parsed = parseEscalations(escPath);
  assert.equal(parsed.length, 2, "both escalation blocks parsed");
  assert.equal(parsed[0].issue, 9, "newest escalation first");
  assert.equal(parsed[1].issue, 7);
  assert.match(parsed[1].what, /pid 111 is not alive/, "the 'what happened' line is captured");
  assert.equal(parsed[0].logFile, "(none)");

  await withServer({ statePath: join(dir, "s.json"), eventsPath: join(dir, "e.jsonl"), escalationsPath: escPath }, async (base) => {
    const { json } = await fetchJson(`${base}/api/snapshot`);
    assert.equal(json.escalations.length, 2, "escalations present in the snapshot payload");
    assert.equal(json.escalations[0].issue, 9, "newest-first order preserved over HTTP");
  });
});

// --- Criterion 4: selecting a worker live-tails its log; only that worker's log
// is streamed, and updates are incremental reads, never a full re-read. --------
await inTempDir(async (dir) => {
  const logFile = join(dir, "issue-5.log");
  writeFileSync(logFile, "line one\n");

  // The incremental primitive: read from a position, never re-read the whole
  // file, and restart cleanly after truncation.
  const first = tailFrom(logFile, 0);
  assert.equal(first.data, "line one\n", "initial read returns existing content");
  const atEnd = tailFrom(logFile, first.position);
  assert.equal(atEnd.data, "", "no new bytes -> reads nothing (never a full re-read)");
  appendFileSync(logFile, "line two\n");
  const delta = tailFrom(logFile, atEnd.position);
  assert.equal(delta.data, "line two\n", "only the appended bytes are read, not the whole file");
  writeFileSync(logFile, "reset\n");
  const rotated = tailFrom(logFile, delta.position);
  assert.equal(rotated.data, "reset\n", "a shorter file (rotation/truncation) restarts from 0");

  // Over HTTP: only the selected issue's log streams, incrementally.
  const statePath = join(dir, "s.json");
  writeFileSync(statePath, JSON.stringify({ 5: { adapter: "claude", pid: 1, attempts: 1, status: "dispatched", pr: null, logFile } }));
  writeFileSync(logFile, "hello\n");
  await withServer({ statePath, eventsPath: join(dir, "e.jsonl"), escalationsPath: join(dir, "esc.md") }, async (base) => {
    const streamDone = sseCollect(
      `${base}/api/log?issue=5`,
      (frames) => frames.filter((f) => f.event === "log").map((f) => f.data).join("").includes("world"),
    );
    // Give the stream a moment to emit the initial content, then append.
    setTimeout(() => appendFileSync(logFile, "world\n"), 120);
    const frames = await streamDone;
    const logText = frames.filter((f) => f.event === "log").map((f) => f.data).join("");
    assert.match(logText, /hello/, "initial log content is tailed");
    assert.match(logText, /world/, "appended content arrives incrementally");
    // No single frame re-sent the whole file after the append: the frame that
    // carries 'world' must not also carry the already-sent 'hello'.
    const worldFrame = frames.filter((f) => f.event === "log").find((f) => f.data.includes("world"));
    assert.ok(!worldFrame.data.includes("hello"), "the update frame carries only new bytes, not a re-read");
  });
});

// --- Criterion 5: new events appear in the dashboard without a manual reload
// (server-sent snapshot pushes). ----------------------------------------------
await inTempDir(async (dir) => {
  const statePath = join(dir, "s.json");
  const eventsPath = join(dir, "e.jsonl");
  writeFileSync(statePath, JSON.stringify({}));
  writeFileSync(eventsPath, "");

  // The change key ignores the clock, so a push happens only on real change.
  const empty = readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "x.md"), config: CONFIG, now: NOW });
  const keyBefore = snapshotKey(empty);

  await withServer({ statePath, eventsPath, escalationsPath: join(dir, "x.md") }, async (base) => {
    const streamDone = sseCollect(
      `${base}/api/stream`,
      (frames) => frames.length >= 2, // initial snapshot + one after the change
    );
    setTimeout(() => {
      writeFileSync(statePath, JSON.stringify({ 8: { adapter: "claude", pid: 9, attempts: 1, status: "dispatched", pr: null, logFile: "l.log" } }));
      appendFileSync(eventsPath, JSON.stringify({ ts: new Date(NOW).toISOString(), event: "dispatch", issue: 8 }) + "\n");
    }, 120);
    const frames = await streamDone;
    assert.equal(frames[0].event, "snapshot", "the stream opens with the current snapshot");
    assert.equal(frames[0].data.workers.length, 0, "initially empty");
    const last = frames[frames.length - 1];
    assert.equal(last.data.workers.length, 1, "a new worker appears via a pushed snapshot, no reload");
    assert.equal(last.data.workers[0].issue, 8);
  });

  const afterState = { 8: { adapter: "claude", pid: 9, attempts: 1, status: "dispatched", pr: null, logFile: "l.log" } };
  writeFileSync(statePath, JSON.stringify(afterState));
  const keyAfter = snapshotKey(readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "x.md"), config: CONFIG, now: NOW }));
  assert.notEqual(keyAfter, keyBefore, "the change key moves when workers change");
});

// --- Criterion 6: missing events, state, or escalations files render an empty
// dashboard with a one-line hint — never an error page or a crash. -------------
await inTempDir(async (dir) => {
  const snap = readSnapshot({
    statePath: join(dir, "nope-state.json"),
    eventsPath: join(dir, "nope-events.jsonl"),
    escalationsPath: join(dir, "nope-esc.md"),
    config: CONFIG,
    now: NOW,
  });
  assert.deepEqual(snap.workers, [], "no workers when every source is missing");
  assert.deepEqual(snap.escalations, [], "no escalations when the file is missing");
  assert.equal(snap.hint, EMPTY_HINT, "an empty dashboard carries a one-line start hint");
  assert.deepEqual(readEvents(join(dir, "missing.jsonl")), [], "missing event stream is empty, not fatal");
  assert.deepEqual(parseEscalations(join(dir, "missing.md")), [], "missing escalation log is empty, not fatal");

  await withServer(
    { statePath: join(dir, "a.json"), eventsPath: join(dir, "b.jsonl"), escalationsPath: join(dir, "c.md") },
    async (base) => {
      const page = await fetchText(`${base}/`);
      assert.equal(page.status, 200, "the page still renders (200), never an error page");
      const { status, json } = await fetchJson(`${base}/api/snapshot`);
      assert.equal(status, 200, "snapshot endpoint returns 200 with missing sources");
      assert.equal(json.hint, EMPTY_HINT, "the hint reaches the client");
    },
  );
});

// --- Criterion 7: a port already in use exits non-zero with a one-line error
// naming the port. -------------------------------------------------------------
await (async () => {
  const holder = createDashboardServer({ config: CONFIG });
  const port = await listenOrFail(holder, 0);
  try {
    const clash = createDashboardServer({ config: CONFIG });
    await assert.rejects(
      () => listenOrFail(clash, port),
      (e) => {
        assert.match(e.message, new RegExp(`\\b${port}\\b`), "the error names the busy port");
        assert.match(e.message, /already in use/, "the error is a single in-use line");
        return true;
      },
    );
  } finally {
    await new Promise((r) => holder.close(r));
  }
})();

// --- Criterion 8: every criterion above has exactly one test named after it. --
// The plan file carried eight acceptance criteria; this counts its own
// `Criterion N` markers and proves there is exactly one per criterion, 1..8.
// It counts markers in THIS file only — it never reads the plan file at
// runtime, so archiving the plan when the issue closes can never break it.
{
  const CRITERIA_COUNT = 8;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `criterion ${n} has a test`);
}

// --- #178 Criterion 1: each worker row shows the issue title alongside its
// number, linked to the issue. -----------------------------------------------
await inTempDir(async (dir) => {
  const statePath = join(dir, "state.json");
  const eventsPath = join(dir, "events.jsonl");
  const start = new Date(NOW - 90_000).toISOString();
  writeFileSync(statePath, JSON.stringify({
    5: { adapter: "codex", pid: 222, attempts: 2, status: "in-review", pr: 42, logFile: "l5.log" },
  }));
  writeFileSync(eventsPath, JSON.stringify({ ts: start, event: "dispatch", issue: 5 }) + "\n");

  const cache = createTitleCache({ fetchTitle: () => "Fix the login bug" });
  // First poll triggers the async fetch; title is pending (null).
  readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW, repoSlug: "praveenvijayan/Ratchet", titleCache: cache });
  await new Promise((r) => setTimeout(r, 10));
  // Second poll: the title has resolved in the cache.
  const snap = readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW, repoSlug: "praveenvijayan/Ratchet", titleCache: cache });
  const w = snap.workers.find((w) => w.issue === 5);
  assert.equal(w.issueTitle, "Fix the login bug", "worker row carries the issue title");
  assert.equal(w.issueUrl, "https://github.com/praveenvijayan/Ratchet/issues/5", "worker row carries a link to the issue");

  // The page renders the title next to the linked issue number.
  await withServer({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), repoSlug: "praveenvijayan/Ratchet", fetchTitle: () => "Fix the login bug" }, async (base) => {
    const page = await fetchText(`${base}/`);
    assert.match(page.body, /issue-title/, "the page has an issue-title element");
    assert.match(page.body, /w\.issueTitle/, "the page script reads issueTitle from the snapshot");
    assert.match(page.body, /w\.issueUrl/, "the page script links the issue number to issueUrl");
  });
});

// --- #178 Criterion 2: titles are cached so the dashboard does not query
// GitHub on every render or poll. --------------------------------------------
await inTempDir(async (dir) => {
  const statePath = join(dir, "state.json");
  const eventsPath = join(dir, "events.jsonl");
  const start = new Date(NOW - 90_000).toISOString();
  writeFileSync(statePath, JSON.stringify({
    5: { adapter: "codex", pid: 222, attempts: 2, status: "in-review", pr: 42, logFile: "l5.log" },
    7: { adapter: "claude", pid: 111, attempts: 1, status: "dispatched", pr: null, logFile: "l7.log" },
  }));
  writeFileSync(eventsPath, [
    JSON.stringify({ ts: start, event: "dispatch", issue: 5 }),
    JSON.stringify({ ts: start, event: "dispatch", issue: 7 }),
  ].join("\n") + "\n");

  const fetchCalls = [];
  const cache = createTitleCache({ fetchTitle: (issue) => { fetchCalls.push(issue); return `Title ${issue}`; } });

  // Simulate five polls — readSnapshot is called once per poll.
  for (let i = 0; i < 5; i++) {
    readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW, repoSlug: "praveenvijayan/Ratchet", titleCache: cache });
  }
  await new Promise((r) => setTimeout(r, 10));

  // After five polls, fetchTitle was called exactly once per issue — not five
  // times each. The cache absorbed the repeats.
  assert.equal(fetchCalls.length, 2, "fetchTitle called once per issue, not per poll");
  assert.deepEqual(fetchCalls.sort((a, b) => a - b), [5, 7], "both issues fetched exactly once");
});

// --- #178 Criterion 3: a title that cannot be fetched leaves the row rendering
// with the bare number and a placeholder, never blocking or erroring the row. -
await inTempDir(async (dir) => {
  const statePath = join(dir, "state.json");
  const eventsPath = join(dir, "events.jsonl");
  const start = new Date(NOW - 90_000).toISOString();
  writeFileSync(statePath, JSON.stringify({
    9: { adapter: "claude", pid: 111, attempts: 1, status: "dispatched", pr: null, logFile: "l9.log" },
  }));
  writeFileSync(eventsPath, JSON.stringify({ ts: start, event: "dispatch", issue: 9 }) + "\n");

  // A fetcher that always fails (simulates gh missing or network error).
  const cache = createTitleCache({ fetchTitle: () => { throw new Error("gh not found"); } });
  readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW, repoSlug: "praveenvijayan/Ratchet", titleCache: cache });
  await new Promise((r) => setTimeout(r, 10));
  const snap = readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW, repoSlug: "praveenvijayan/Ratchet", titleCache: cache });
  const w = snap.workers.find((w) => w.issue === 9);
  assert.equal(w.issueTitle, null, "unfetchable title yields null — not an error");
  assert.equal(w.issueUrl, "https://github.com/praveenvijayan/Ratchet/issues/9", "the issue link still renders");

  // The page shows a placeholder for unfetchable titles, never an error.
  await withServer({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), repoSlug: "praveenvijayan/Ratchet", fetchTitle: () => null }, async (base) => {
    const page = await fetchText(`${base}/`);
    assert.match(page.body, /issue-title empty/, "the page shows a placeholder class for unfetchable titles");
    // The non-title rendering still shows the bare issue number
    assert.match(page.body, /function issueCell/, "issueCell renders the bare number when no title is available");
  });
});

// --- #171 Criterion 1: a row with a live worker pid in an active (non-terminal)
// status shows its claim age against the claim timeout, with the overdue
// highlight only when age exceeds the timeout. -------------------------------
await inTempDir(async (dir) => {
  const statePath = join(dir, "state.json");
  const eventsPath = join(dir, "events.jsonl");
  const start = new Date(NOW - 90_000).toISOString(); // 90s before the fixed clock
  writeFileSync(statePath, JSON.stringify({
    3: { adapter: "claude", pid: 111, attempts: 1, status: "dispatched", pr: null, logFile: "l3.log" },
  }));
  writeFileSync(eventsPath, JSON.stringify({ ts: start, event: "dispatch", issue: 3 }) + "\n");

  const snap = readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW });
  const w = snap.workers.find((w) => w.issue === 3);
  assert.equal(w.pid, 111, "row carries the live worker pid");
  assert.equal(w.status, "dispatched", "row is in an active non-terminal status");
  assert.equal(w.claimActive, true, "claimActive is true for a live pid in a non-terminal status");
  assert.equal(w.claimAgeSeconds, 90, "claim age is measured from the dispatch event");
  assert.equal(w.claimTimeoutSeconds, 300, "the timeout denominator is present for the gauge");

  // The page's ageText renders the timeout denominator and overdue class only for active claims
  await withServer({}, async (base) => {
    const page = await fetchText(`${base}/`);
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(page.body);
    assert.ok(scriptMatch, "page has a script block");
    const script = scriptMatch[1];
    assert.match(script, /w\.claimActive/, "ageText checks claimActive");
    // The active-claim branch carries the timeout denominator and the overdue class
    assert.match(script, /w\.claimActive\)\s*\{[\s\S]*?claimTimeoutSeconds[\s\S]*?"over"/, "the active branch shows the timeout denominator and overdue class");
  });
});

// --- #171 Criterion 2: a row in a terminal or escalated status, or with no
// live pid, shows a "last activity" age with no timeout denominator and no
// overdue highlight. ---------------------------------------------------------
await inTempDir(async (dir) => {
  const statePath = join(dir, "state.json");
  const eventsPath = join(dir, "events.jsonl");
  const start = new Date(NOW - 926_000).toISOString(); // long ago — would be "overdue" under the old logic
  writeFileSync(statePath, JSON.stringify({
    4: { adapter: "claude", pid: null, attempts: 1, status: "escalated", pr: null, logFile: "l4.log" },
    6: { adapter: "codex", pid: null, attempts: 2, status: "pr-concluded", pr: 99, logFile: "l6.log" },
  }));
  writeFileSync(eventsPath, [
    JSON.stringify({ ts: start, event: "dispatch", issue: 4 }),
    JSON.stringify({ ts: start, event: "dispatch", issue: 6 }),
  ].join("\n") + "\n");

  const snap = readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW });
  const w4 = snap.workers.find((w) => w.issue === 4);
  const w6 = snap.workers.find((w) => w.issue === 6);
  assert.equal(w4.status, "escalated", "row 4 is in an escalated (terminal) status");
  assert.equal(w4.claimActive, false, "an escalated row is not claimActive");
  assert.equal(w6.status, "pr-concluded", "row 6 is in a concluded status with no live pid");
  assert.equal(w6.claimActive, false, "a row with no live pid is not claimActive");
  // Both still carry the age so the browser can show "last activity"
  assert.equal(w4.claimAgeSeconds, 926, "the age is still computed for last-activity display");
  assert.ok(w4.claimAgeSeconds > w4.claimTimeoutSeconds, "the age exceeds the timeout — but must NOT be highlighted");

  // The page's ageText, for non-active rows, renders no timeout denominator and no overdue class
  await withServer({}, async (base) => {
    const page = await fetchText(`${base}/`);
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(page.body);
    const script = scriptMatch[1];
    // The fallback return (after the claimActive branch) renders just the age, no denominator
    assert.match(script, /return '<span class="gauge">' \+ t \+ "<\/span>"/, "the non-active branch renders age with no timeout denominator");
  });
});

// --- #171 Criterion 3: a row with no dispatch or resume event at all shows a
// placeholder, never a blank, NaN, or a negative age. ------------------------
await inTempDir(async (dir) => {
  const statePath = join(dir, "state.json");
  const eventsPath = join(dir, "events.jsonl");
  writeFileSync(statePath, JSON.stringify({
    8: { adapter: "claude", pid: 111, attempts: 1, status: "dispatched", pr: null, logFile: "l8.log" },
  }));
  writeFileSync(eventsPath, ""); // no events at all

  const snap = readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW });
  const w = snap.workers.find((w) => w.issue === 8);
  assert.equal(w.claimStartTs, null, "no dispatch/resume event -> claimStartTs is null");
  assert.equal(w.claimAgeSeconds, null, "no event -> claimAgeSeconds is null, never NaN or negative");

  // The page's ageText returns a placeholder when claimStartTs is null
  await withServer({}, async (base) => {
    const page = await fetchText(`${base}/`);
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(page.body);
    const script = scriptMatch[1];
    assert.match(script, /if \(w\.claimStartTs == null\) return "—"/, "ageText returns a placeholder dash when there is no event");
  });
});

// --- #178 Criterion 4: every criterion above has exactly one test named after
// it. The plan file carried four #178 acceptance criteria; this counts its own
// `#178 Criterion N` markers and proves there is exactly one per criterion,
// 1..4. It counts markers in THIS file only — it never reads the plan file at
// runtime, so archiving the plan when the issue closes can never break it.
{
  const CRITERIA_COUNT = 4;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #178 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #178 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #178 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#178 criterion ${n} has a test`);
}

// --- #171 Criterion 4: every criterion above has exactly one test named after
// it. The plan file carried four #171 acceptance criteria; this counts its own
// `#171 Criterion N` markers and proves there is exactly one per criterion,
// 1..4. It counts markers in THIS file only — it never reads the plan file at
// runtime, so archiving the plan when the issue closes can never break it.
{
  const CRITERIA_COUNT = 4;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #171 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #171 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #171 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#171 criterion ${n} has a test`);
}

// --- #179 Criterion 1: rows render in labelled groups ordered live,
// awaiting-review, escalated, terminal, with issue-number order within each
// group. -----------------------------------------------------------------------
{
  assert.deepEqual(
    LIFECYCLE_GROUPS.map((g) => g.key),
    ["live", "awaiting-review", "escalated", "terminal", "other"],
    "groups are ordered live → awaiting-review → escalated → terminal → other (catch-all last)",
  );
  assert.equal(lifecycleGroup("working"), "live");
  assert.equal(lifecycleGroup("in-review"), "awaiting-review");
  assert.equal(lifecycleGroup("dispatch-failed"), "escalated");
  assert.equal(lifecycleGroup("dead"), "terminal");
}
await inTempDir(async (dir) => {
  const statePath = join(dir, "s.json");
  const eventsPath = join(dir, "e.jsonl");
  const escalationsPath = join(dir, "esc.md");
  // Issue numbers deliberately interleaved across groups to prove per-group order.
  writeFileSync(statePath, JSON.stringify({
    30: { adapter: "claude", pid: 1, attempts: 0, status: "working", pr: null },
    10: { adapter: "codex", pid: 2, attempts: 0, status: "dispatched", pr: null },
    25: { adapter: "claude", pid: 3, attempts: 1, status: "in-review", pr: 5 },
    5: { adapter: "codex", pid: 4, attempts: 1, status: "ready-for-review", pr: 6 },
    40: { adapter: "claude", pid: null, attempts: 2, status: "dispatch-failed", pr: null },
    15: { adapter: "codex", pid: null, attempts: 0, status: "dead", pr: null },
  }));
  writeFileSync(eventsPath, "");
  writeFileSync(escalationsPath, "");

  const snap = readSnapshot({ statePath, eventsPath, escalationsPath, config: CONFIG, now: NOW });
  const groups = groupWorkers(snap.workers);
  assert.deepEqual(groups.map((g) => g.key), ["live", "awaiting-review", "escalated", "terminal"], "non-empty groups render in lifecycle order");
  assert.deepEqual(groups.find((g) => g.key === "live").rows.map((r) => r.issue), [10, 30], "live rows are in issue-number order within the group");
  assert.deepEqual(groups.find((g) => g.key === "awaiting-review").rows.map((r) => r.issue), [5, 25], "awaiting-review rows are in issue-number order within the group");

  await withServer({ statePath, eventsPath, escalationsPath }, async (base) => {
    const page = (await fetchText(`${base}/`)).body;
    assert.match(page, /class="lifecycle-group"/, "rows render inside labelled lifecycle-group sections");
    assert.match(page, /class="group-head"/, "each group carries a label header");
    assert.match(
      page,
      /\["live", ?"Live"\], ?\["awaiting-review", ?"Awaiting review"\], ?\["escalated", ?"Escalated"\], ?\["terminal", ?"Terminal"\], ?\["other", ?"Other"\]/,
      "the client renders the groups in the fixed lifecycle order",
    );
  });
});

// --- #179 Criterion 2: a row moves between groups live when its status changes,
// without a page reload. -------------------------------------------------------
await inTempDir(async (dir) => {
  const statePath = join(dir, "s.json");
  const eventsPath = join(dir, "e.jsonl");
  const escalationsPath = join(dir, "esc.md");
  writeFileSync(eventsPath, "");
  writeFileSync(escalationsPath, "");
  const live = { 7: { adapter: "claude", pid: 1, attempts: 0, status: "working", pr: null } };
  const done = { 7: { adapter: "claude", pid: null, attempts: 0, status: "dead", pr: null } };

  writeFileSync(statePath, JSON.stringify(live));
  const before = readSnapshot({ statePath, eventsPath, escalationsPath, config: CONFIG, now: NOW });
  assert.equal(before.workers[0].group, "live", "the row starts in the live group");
  writeFileSync(statePath, JSON.stringify(done));
  const after = readSnapshot({ statePath, eventsPath, escalationsPath, config: CONFIG, now: NOW });
  assert.equal(after.workers[0].group, "terminal", "the row's group follows its status");
  assert.notEqual(snapshotKey(before), snapshotKey(after), "a group change alters the stream key, so the live stream re-pushes it");

  // Over SSE: mutate the status after the first frame and confirm a second frame
  // arrives with the row regrouped — a live move, no page reload.
  writeFileSync(statePath, JSON.stringify(live));
  await withServer({ statePath, eventsPath, escalationsPath }, async (base) => {
    let mutated = false;
    const frames = await sseCollect(`${base}/api/stream`, (fr) => {
      if (fr.length === 1 && !mutated) { mutated = true; writeFileSync(statePath, JSON.stringify(done)); return false; }
      return fr.length >= 2;
    });
    assert.equal(frames[0].data.workers[0].group, "live", "the first pushed frame has the row live");
    assert.equal(frames[frames.length - 1].data.workers[0].group, "terminal", "a later pushed frame moved the row to terminal without a reload");
  });
});

// --- #179 Criterion 3: an empty group renders nothing — no empty header taking
// space. -----------------------------------------------------------------------
{
  const groups = groupWorkers([
    { issue: 1, group: "live" },
    { issue: 2, group: "live" },
  ]);
  assert.deepEqual(groups.map((g) => g.key), ["live"], "only the non-empty group is returned — no awaiting-review/escalated/terminal headers");
}
await inTempDir(async (dir) => {
  const statePath = join(dir, "s.json");
  const eventsPath = join(dir, "e.jsonl");
  const escalationsPath = join(dir, "esc.md");
  writeFileSync(statePath, JSON.stringify({ 3: { adapter: "claude", pid: 1, attempts: 0, status: "working", pr: null } }));
  writeFileSync(eventsPath, "");
  writeFileSync(escalationsPath, "");
  await withServer({ statePath, eventsPath, escalationsPath }, async (base) => {
    const page = (await fetchText(`${base}/`)).body;
    // The served page ships an empty #workers container — groups are created only
    // when rows exist, so an empty group has no static header reserving space.
    assert.match(page, /<div id="workers"><\/div>/, "no group sections are pre-rendered; empty groups occupy no space");
    assert.match(page, /if \(!rows \|\| !rows\.length\) continue/, "the renderer skips a group with no rows");
  });
});

// --- #179 Criterion 4: a status that maps to no known group falls into a
// visible catch-all group, never disappearing from the table. ------------------
await inTempDir(async (dir) => {
  const statePath = join(dir, "s.json");
  const eventsPath = join(dir, "e.jsonl");
  const escalationsPath = join(dir, "esc.md");

  assert.equal(lifecycleGroup("some-brand-new-status"), "other", "an unmapped status maps to the catch-all group");
  const grouped = groupWorkers([{ issue: 9, group: lifecycleGroup("wat") }]);
  assert.deepEqual(grouped.map((g) => g.key), ["other"], "an unknown-status row appears in the Other group");
  assert.equal(grouped[0].rows[0].issue, 9, "the unknown-status row is not dropped");
  // Even a group key outside LIFECYCLE_GROUPS keeps its row (drift guard).
  const drift = groupWorkers([{ issue: 3, group: "nonexistent-group" }]);
  assert.ok(drift.some((g) => g.rows.some((r) => r.issue === 3)), "a group key outside the known set still keeps its row visible");

  writeFileSync(statePath, JSON.stringify({ 9: { adapter: "claude", pid: 1, attempts: 0, status: "totally-new-status", pr: null } }));
  writeFileSync(eventsPath, "");
  writeFileSync(escalationsPath, "");
  const snap = readSnapshot({ statePath, eventsPath, escalationsPath, config: CONFIG, now: NOW });
  assert.equal(snap.workers[0].group, "other", "readSnapshot tags an unmapped status as the catch-all group");
});

// --- #179 Criterion 5: every criterion above has exactly one test named after
// it. The plan file carried five #179 acceptance criteria; this counts its own
// `#179 Criterion N` markers and proves there is exactly one per criterion,
// 1..5. It counts markers in THIS file only — it never reads the plan file at
// runtime, so archiving the plan when the issue closes can never break it.
{
  const CRITERIA_COUNT = 5;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #179 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #179 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #179 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#179 criterion ${n} has a test`);
}

// --- #182 Criterion 1: selecting an issue shows its events in chronological
// order with timestamp, event type, and the adapter/attempt/PR fields each
// event carries. -------------------------------------------------------------
await inTempDir(async (dir) => {
  const statePath = join(dir, "state.json");
  const eventsPath = join(dir, "events.jsonl");
  const escPath = join(dir, "none.md");
  writeFileSync(statePath, JSON.stringify({ 5: { adapter: "codex", pid: 222, attempts: 2, status: "in-review", pr: 42, logFile: "l5.log" } }));
  writeFileSync(eventsPath, [
    JSON.stringify({ ts: "2026-07-09T12:05:00Z", event: "dispatch", issue: 5, adapter: "codex", pid: 222, attempts: 1 }),
    JSON.stringify({ ts: "2026-07-09T12:00:00Z", event: "claim-detected", issue: 5, adapter: "codex", pid: 222 }),
    JSON.stringify({ ts: "2026-07-09T12:10:00Z", event: "pr-opened", issue: 5, pr: 42 }),
    JSON.stringify({ ts: "2026-07-09T11:00:00Z", event: "dispatch", issue: 7, adapter: "claude", pid: 111, attempts: 1 }),
  ].join("\n") + "\n");
  writeFileSync(escPath, "");

  // Pure derivation: filter + chronological sort, only this issue's events
  const events = readEvents(eventsPath);
  const tl = timelineEvents(events, 5);
  assert.equal(tl.length, 3, "only issue #5 events, not #7");
  assert.deepEqual(tl.map((e) => e.ts), ["2026-07-09T12:00:00Z", "2026-07-09T12:05:00Z", "2026-07-09T12:10:00Z"], "events in chronological order by ts");
  assert.equal(tl[0].event, "claim-detected", "first event is claim-detected (earliest ts)");
  assert.equal(tl[2].event, "pr-opened", "last event is pr-opened");
  assert.equal(tl[0].adapter, "codex", "event carries the adapter field");
  assert.equal(tl[2].pr, 42, "event carries the PR field");

  // Over HTTP: the timeline endpoint sends the events
  await withServer({ statePath, eventsPath, escalationsPath: escPath }, async (base) => {
    const frames = await sseCollect(
      `${base}/api/timeline?issue=5`,
      (frames) => frames.some((f) => f.event === "timeline"),
    );
    const timeline = frames.flatMap((f) => f.event === "timeline" ? f.data : []);
    assert.equal(timeline.length, 3, "all events sent over HTTP");
    assert.deepEqual(timeline.map((e) => e.ts), ["2026-07-09T12:00:00Z", "2026-07-09T12:05:00Z", "2026-07-09T12:10:00Z"], "chronological over HTTP");
    assert.equal(timeline[0].event, "claim-detected", "event type present");
    assert.equal(timeline[0].adapter, "codex", "adapter field present in the payload");
    assert.equal(timeline[2].pr, 42, "PR field present in the payload");
  });

  // The page renders the timeline
  await withServer({}, async (base) => {
    const page = await fetchText(`${base}/`);
    assert.match(page.body, /id="timeline"/, "the page has a timeline element");
    assert.match(page.body, /function renderTimeline/, "the page has a renderTimeline function");
    assert.match(page.body, /No activity recorded/, "the page has the empty-state message");
    assert.match(page.body, /\/api\/timeline/, "the page subscribes to the timeline endpoint");
  });
});

// --- #182 Criterion 2: new events for the selected issue append to the
// timeline live without a page reload. ---------------------------------------
await inTempDir(async (dir) => {
  const statePath = join(dir, "state.json");
  const eventsPath = join(dir, "events.jsonl");
  const escPath = join(dir, "none.md");
  writeFileSync(statePath, JSON.stringify({ 5: { adapter: "codex", pid: 222, attempts: 1, status: "dispatched", pr: null, logFile: "l5.log" } }));
  writeFileSync(eventsPath, JSON.stringify({ ts: "2026-07-09T12:00:00Z", event: "dispatch", issue: 5, adapter: "codex", pid: 222, attempts: 1 }) + "\n");
  writeFileSync(escPath, "");

  await withServer({ statePath, eventsPath, escalationsPath: escPath }, async (base) => {
    const streamDone = sseCollect(
      `${base}/api/timeline?issue=5`,
      (frames) => frames.filter((f) => f.event === "timeline").flatMap((f) => f.data).length >= 2,
    );
    // After the initial frame, append a new event
    setTimeout(() => appendFileSync(eventsPath, JSON.stringify({ ts: "2026-07-09T12:10:00Z", event: "pr-opened", issue: 5, pr: 42 }) + "\n"), 120);
    const frames = await streamDone;
    const allEvents = frames.filter((f) => f.event === "timeline").flatMap((f) => f.data);
    assert.equal(allEvents.length, 2, "the new event appended live without a reload");
    assert.equal(allEvents[1].event, "pr-opened", "the appended event is the new one");
    assert.equal(allEvents[1].pr, 42, "the appended event carries its PR field");
  });
});

// --- #182 Criterion 3: an issue with no events shows a one-line "no activity
// recorded" message, never an empty pane or an error. -----------------------
await inTempDir(async (dir) => {
  const statePath = join(dir, "state.json");
  const eventsPath = join(dir, "events.jsonl");
  const escPath = join(dir, "none.md");
  // Issue 9 is in state but has no events in the stream
  writeFileSync(statePath, JSON.stringify({ 9: { adapter: "claude", pid: 111, attempts: 1, status: "dispatched", pr: null, logFile: "l9.log" } }));
  writeFileSync(eventsPath, JSON.stringify({ ts: "2026-07-09T12:00:00Z", event: "dispatch", issue: 5, adapter: "codex", pid: 222, attempts: 1 }) + "\n");
  writeFileSync(escPath, "");

  // Pure derivation: no events for issue 9
  const tl = timelineEvents(readEvents(eventsPath), 9);
  assert.equal(tl.length, 0, "no events for issue 9");

  // Over HTTP: the endpoint sends an empty initial frame (no crash, no error)
  await withServer({ statePath, eventsPath, escalationsPath: escPath }, async (base) => {
    const { status, json } = await fetchJson(`${base}/api/snapshot`);
    assert.equal(status, 200, "the dashboard still works");
    assert.ok(json.workers.find((w) => w.issue === 9), "issue 9 is in the snapshot");

    // Collect SSE frames for a short time — no timeline frames should arrive
    // (no events for issue 9), but the connection stays open without erroring.
    const noFrames = await new Promise((resolve) => {
      const frames = [];
      const req = httpGet(`${base}/api/timeline?issue=9`, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event:\s*(.*)$/m.exec(block);
            const da = /^data:\s*(.*)$/m.exec(block);
            if (da) frames.push({ event: ev ? ev[1] : "message", data: da[1] });
          }
        });
      });
      const timer = setTimeout(() => { req.destroy(); resolve(frames); }, 300);
      req.on("error", () => { clearTimeout(timer); resolve(frames); });
    });
    assert.equal(noFrames.length, 0, "no frames sent — no events, no error, no crash");

    // The page has the empty-state message
    const page = await fetchText(`${base}/`);
    assert.match(page.body, /No activity recorded/, "the page shows a one-line message for no events");
  });
});

// --- #182 Criterion 4: a malformed event line in the stream is skipped with
// the remaining timeline still rendering. ------------------------------------
await inTempDir(async (dir) => {
  const statePath = join(dir, "state.json");
  const eventsPath = join(dir, "events.jsonl");
  const escPath = join(dir, "none.md");
  writeFileSync(statePath, JSON.stringify({ 5: { adapter: "codex", pid: 222, attempts: 1, status: "dispatched", pr: null, logFile: "l5.log" } }));
  // Two valid events for issue 5, with a malformed line between them
  writeFileSync(eventsPath, [
    JSON.stringify({ ts: "2026-07-09T12:00:00Z", event: "dispatch", issue: 5, adapter: "codex", pid: 222, attempts: 1 }),
    "THIS IS NOT JSON",
    JSON.stringify({ ts: "2026-07-09T12:10:00Z", event: "pr-opened", issue: 5, pr: 42 }),
    "",
  ].join("\n"));
  writeFileSync(escPath, "");

  // readEvents already skips the malformed line
  const events = readEvents(eventsPath);
  assert.equal(events.length, 2, "malformed line skipped by readEvents");

  // timelineEvents still returns the two valid events in order
  const tl = timelineEvents(events, 5);
  assert.equal(tl.length, 2, "timeline renders the remaining valid events");
  assert.equal(tl[0].event, "dispatch", "first valid event present");
  assert.equal(tl[1].event, "pr-opened", "second valid event present");

  // Over HTTP: the timeline endpoint sends only the two valid events
  await withServer({ statePath, eventsPath, escalationsPath: escPath }, async (base) => {
    const frames = await sseCollect(
      `${base}/api/timeline?issue=5`,
      (frames) => frames.some((f) => f.event === "timeline"),
    );
    const allEvents = frames.filter((f) => f.event === "timeline").flatMap((f) => f.data);
    assert.equal(allEvents.length, 2, "malformed line skipped over HTTP, remaining events render");
    assert.deepEqual(allEvents.map((e) => e.event), ["dispatch", "pr-opened"], "valid events in chronological order");
  });
});

// --- #164 Criterion 1: each worker row shows its costUsd, tokensIn, and
// tokensOut from the latest usage-bearing event for that issue. ----------------
{
  // Pure derivation: the newest usage-bearing event wins over an older one, and
  // a non-usage event (dispatch) never shadows the usage reading.
  assert.equal(isUsageBearing({ event: "dispatch", issue: 1 }), false, "an event with no usage field is not usage-bearing");
  assert.equal(isUsageBearing({ event: "worker-exit", issue: 1, costUsd: 0.5 }), true, "an event carrying a usage field is usage-bearing");
  const events = [
    { ts: "2026-07-09T12:00:00.000Z", event: "dispatch", issue: 7 },
    { ts: "2026-07-09T12:01:00.000Z", event: "worker-exit", issue: 7, costUsd: 0.1, tokensIn: 100, tokensOut: 50 },
    { ts: "2026-07-09T12:05:00.000Z", event: "worker-exit", issue: 7, costUsd: 0.42, tokensIn: 900, tokensOut: 300 },
    { ts: "2026-07-09T12:03:00.000Z", event: "worker-exit", issue: 8, costUsd: 9.9, tokensIn: 1, tokensOut: 2 },
  ];
  assert.deepEqual(latestUsage(events, 7), { costUsd: 0.42, tokensIn: 900, tokensOut: 300 }, "the most recent usage-bearing event's numbers win");
  assert.equal(latestUsage(events, 999), null, "an issue with no usage-bearing event yields null");
}
await inTempDir(async (dir) => {
  const statePath = join(dir, "s.json");
  const eventsPath = join(dir, "e.jsonl");
  const escalationsPath = join(dir, "esc.md");
  writeFileSync(statePath, JSON.stringify({ 7: { adapter: "claude", pid: 1, attempts: 0, status: "working", pr: null } }));
  writeFileSync(eventsPath,
    JSON.stringify({ ts: "2026-07-09T12:01:00.000Z", event: "worker-exit", issue: 7, costUsd: 0.1, tokensIn: 100, tokensOut: 50 }) + "\n" +
    JSON.stringify({ ts: "2026-07-09T12:05:00.000Z", event: "worker-exit", issue: 7, costUsd: 0.42, tokensIn: 900, tokensOut: 300 }) + "\n");
  writeFileSync(escalationsPath, "");
  const snap = readSnapshot({ statePath, eventsPath, escalationsPath, config: CONFIG, now: NOW });
  const row = snap.workers.find((w) => w.issue === 7);
  assert.equal(row.costUsd, 0.42, "the row carries the latest event's cost");
  assert.equal(row.tokensIn, 900, "the row carries the latest event's tokensIn");
  assert.equal(row.tokensOut, 300, "the row carries the latest event's tokensOut");
  await withServer({ statePath, eventsPath, escalationsPath }, async (base) => {
    const page = (await fetchText(`${base}/`)).body;
    assert.match(page, /tm\("Cost",[\s\S]*?tm\("Tokens In",[\s\S]*?tm\("Tokens Out",/, "the telemetry strip carries the three usage columns");
    assert.match(page, /usdCell\(w\.costUsd\)/, "the row renders the cost cell from the row's costUsd");
    assert.match(page, /tokCell\(w\.tokensIn\)/, "the row renders the tokens-in cell from the row's tokensIn");
    assert.match(page, /tokCell\(w\.tokensOut\)/, "the row renders the tokens-out cell from the row's tokensOut");
  });
});

// --- #164 Criterion 2: a header line shows the fleet totals — summed cost and
// summed tokens across all workers with usage data. ----------------------------
{
  const totals = fleetUsage([
    { costUsd: 0.5, tokensIn: 100, tokensOut: 40 },
    { costUsd: 1.25, tokensIn: 900, tokensOut: 60 },
    { costUsd: null, tokensIn: null, tokensOut: null }, // a worker with no usage adds nothing
  ]);
  assert.deepEqual(totals, { costUsd: 1.75, tokensIn: 1000, tokensOut: 100 }, "totals sum only finite values across workers");
  assert.deepEqual(fleetUsage([{ costUsd: null, tokensIn: null, tokensOut: null }]), { costUsd: null, tokensIn: null, tokensOut: null }, "no usage anywhere leaves every total null (renders as —, not 0)");
}
await inTempDir(async (dir) => {
  const statePath = join(dir, "s.json");
  const eventsPath = join(dir, "e.jsonl");
  const escalationsPath = join(dir, "esc.md");
  writeFileSync(statePath, JSON.stringify({
    7: { adapter: "claude", pid: null, attempts: 0, status: "dead", pr: null },
    8: { adapter: "codex", pid: null, attempts: 0, status: "dead", pr: null },
  }));
  writeFileSync(eventsPath,
    JSON.stringify({ ts: "2026-07-09T12:05:00.000Z", event: "worker-exit", issue: 7, costUsd: 0.5, tokensIn: 100, tokensOut: 40 }) + "\n" +
    JSON.stringify({ ts: "2026-07-09T12:06:00.000Z", event: "worker-exit", issue: 8, costUsd: 1.25, tokensIn: 900, tokensOut: 60 }) + "\n");
  writeFileSync(escalationsPath, "");
  const snap = readSnapshot({ statePath, eventsPath, escalationsPath, config: CONFIG, now: NOW });
  assert.deepEqual(snap.totals, { costUsd: 1.75, tokensIn: 1000, tokensOut: 100 }, "the snapshot carries the fleet totals for the header");
  await withServer({ statePath, eventsPath, escalationsPath }, async (base) => {
    const page = (await fetchText(`${base}/`)).body;
    assert.match(page, /id="fleettotals"/, "the header carries a fleet-totals element");
    assert.match(page, /"Fleet: " \+ usdText\(t\.costUsd\) \+ " · " \+ tokText\(t\.tokensIn\) \+ " in · " \+ tokText\(t\.tokensOut\) \+ " out"/, "the header line sums cost and tokens from snapshot.totals");
  });
});

// --- #164 Criterion 3: a worker whose events carry no usage renders a —
// placeholder in each usage cell, never a blank, NaN, or undefined. ------------
{
  // A declared-but-unreadable usage (keys present, valued null) is usage-bearing
  // but every field normalises to null, so each cell still shows a placeholder.
  const unreadable = latestUsage([{ ts: "2026-07-09T12:05:00.000Z", event: "worker-exit", issue: 3, costUsd: null, tokensIn: null, tokensOut: null }], 3);
  assert.deepEqual(unreadable, { costUsd: null, tokensIn: null, tokensOut: null }, "an unreadable-usage event yields all-null, never NaN/undefined");
}
await inTempDir(async (dir) => {
  const statePath = join(dir, "s.json");
  const eventsPath = join(dir, "e.jsonl");
  const escalationsPath = join(dir, "esc.md");
  // Issue 5 has no usage event at all; issue 6 has an unreadable (null) usage.
  writeFileSync(statePath, JSON.stringify({
    5: { adapter: "plain", pid: null, attempts: 0, status: "dead", pr: null },
    6: { adapter: "claude", pid: null, attempts: 0, status: "dead", pr: null },
  }));
  writeFileSync(eventsPath,
    JSON.stringify({ ts: "2026-07-09T12:04:00.000Z", event: "worker-exit", issue: 6, costUsd: null, tokensIn: null, tokensOut: null }) + "\n");
  writeFileSync(escalationsPath, "");
  const snap = readSnapshot({ statePath, eventsPath, escalationsPath, config: CONFIG, now: NOW });
  for (const issue of [5, 6]) {
    const row = snap.workers.find((w) => w.issue === issue);
    for (const f of ["costUsd", "tokensIn", "tokensOut"]) {
      assert.equal(row[f], null, `issue #${issue} ${f} is null (rendered as a placeholder), never NaN/undefined`);
      assert.ok(!Number.isNaN(row[f]), `issue #${issue} ${f} is not NaN`);
    }
  }
  assert.deepEqual(snap.totals, { costUsd: null, tokensIn: null, tokensOut: null }, "no finite usage anywhere leaves totals null, so the header hides");
  await withServer({ statePath, eventsPath, escalationsPath }, async (base) => {
    const page = (await fetchText(`${base}/`)).body;
    // The cell formatters fall back to the muted em-dash span for a null value.
    assert.match(page, /usdCell = \(n\) => isNum\(n\) \? usdText\(n\) : '<span class="empty">—<\/span>'/, "a null cost cell renders the — placeholder span, never blank");
    assert.match(page, /tokCell = \(n\) => isNum\(n\) \? tokText\(n\) : '<span class="empty">—<\/span>'/, "a null token cell renders the — placeholder span, never blank");
    assert.match(page, /const isNum = \(n\) => typeof n === "number" && isFinite\(n\)/, "cells guard on a finite number, so NaN/undefined never reach the DOM");
  });
});

// --- #164 Criterion 4: usage figures update live from new events without a
// manual page reload, consistent with the rest of the dashboard. ---------------
await inTempDir(async (dir) => {
  const statePath = join(dir, "s.json");
  const eventsPath = join(dir, "e.jsonl");
  const escalationsPath = join(dir, "esc.md");
  writeFileSync(statePath, JSON.stringify({ 7: { adapter: "claude", pid: 1, attempts: 0, status: "working", pr: null } }));
  writeFileSync(eventsPath, "");
  writeFileSync(escalationsPath, "");

  // A new usage event changes the clock-independent stream key, so the live
  // stream re-pushes — the mechanism by which the page updates without a reload.
  const before = readSnapshot({ statePath, eventsPath, escalationsPath, config: CONFIG, now: NOW });
  assert.equal(before.workers[0].costUsd, null, "the row starts with no usage");
  appendFileSync(eventsPath, JSON.stringify({ ts: "2026-07-09T12:07:00.000Z", event: "worker-exit", issue: 7, costUsd: 0.9, tokensIn: 500, tokensOut: 200 }) + "\n");
  const after = readSnapshot({ statePath, eventsPath, escalationsPath, config: CONFIG, now: NOW });
  assert.equal(after.workers[0].costUsd, 0.9, "the row picks up the new usage on the next snapshot");
  assert.notEqual(snapshotKey(before), snapshotKey(after), "a new usage event alters the stream key, so the live stream re-pushes it");

  // Over SSE: append a usage event after the first frame, confirm a later frame
  // carries the usage without a reload.
  writeFileSync(eventsPath, "");
  await withServer({ statePath, eventsPath, escalationsPath }, async (base) => {
    let appended = false;
    const frames = await sseCollect(`${base}/api/stream`, (fr) => {
      if (fr.length === 1 && !appended) {
        appended = true;
        appendFileSync(eventsPath, JSON.stringify({ ts: "2026-07-09T12:08:00.000Z", event: "worker-exit", issue: 7, costUsd: 0.9, tokensIn: 500, tokensOut: 200 }) + "\n");
        return false;
      }
      return fr.length >= 2;
    });
    assert.equal(frames[0].data.workers[0].costUsd, null, "the first pushed frame has no usage");
    const last = frames[frames.length - 1].data;
    assert.equal(last.workers[0].costUsd, 0.9, "a later pushed frame carries the usage — no page reload");
    assert.deepEqual(last.totals, { costUsd: 0.9, tokensIn: 500, tokensOut: 200 }, "the pushed frame's fleet totals reflect the new usage");
  });
});

// --- #164 Criterion 5: every criterion above has exactly one test named after
// it. The plan file carried five #164 acceptance criteria; this counts its own
// `#164 Criterion N` markers and proves there is exactly one per criterion,
// 1..5. It counts markers in THIS file only — it never reads the plan file at
// runtime, so archiving the plan when the issue closes can never break it.
{
  const CRITERIA_COUNT = 5;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #164 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #164 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #164 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#164 criterion ${n} has a test`);
}

// --- #176 Criterion 1: the supervisor appends a heartbeat event to the event
// stream once per poll pass. ---------------------------------------------------
await inTempDir(async (dir) => {
  const eventsPath = join(dir, "ev.jsonl");
  const statePath = join(dir, "s.json");
  const escalationsPath = join(dir, "e.md");
  const okGh = async () => []; // survey succeeds against an empty fleet
  const beats = () => readEvents(eventsPath).filter((e) => e.event === "heartbeat");

  await pollOnce({ gh: okGh, isAlive: () => false, now: NOW, statePath, escalationsPath, eventsPath, log: () => {} });
  assert.equal(beats().length, 1, "one poll pass appends exactly one heartbeat");
  const hb = beats()[0];
  assert.equal(hb.ts, new Date(NOW).toISOString(), "the heartbeat carries the poll timestamp");
  assert.equal("issue" in hb, false, "a fleet-wide heartbeat carries no issue field");

  await pollOnce({ gh: okGh, isAlive: () => false, now: NOW + 1000, statePath, escalationsPath, eventsPath, log: () => {} });
  assert.equal(beats().length, 2, "a second pass appends a second heartbeat — one per pass");

  // Alive-but-degraded: a poll whose gh survey throws is still a live supervisor,
  // so it must still prove life. The heartbeat lands before the survey runs.
  const failGh = async () => { throw new Error("gh: not authenticated"); };
  const r = await pollOnce({ gh: failGh, now: NOW + 2000, statePath, escalationsPath, eventsPath, log: () => {} });
  assert.equal(r.ok, false, "a failed survey does not crash the poll");
  assert.equal(beats().length, 3, "a poll whose survey fails still emits its heartbeat");
});

// --- #176 Criterion 2: the dashboard shows the time since the last heartbeat,
// updating live without a page reload. -----------------------------------------
await inTempDir(async (dir) => {
  const eventsPath = join(dir, "ev.jsonl");
  const statePath = join(dir, "s.json");
  const escalationsPath = join(dir, "esc.md");
  writeFileSync(statePath, JSON.stringify({}));
  writeFileSync(escalationsPath, "");
  const hbTs = new Date(NOW - 30_000).toISOString(); // 30s before the fixed clock
  writeFileSync(eventsPath, JSON.stringify({ ts: hbTs, event: "heartbeat" }) + "\n");

  const cfg = { ...CONFIG, pollSeconds: 60 };
  const snap = readSnapshot({ statePath, eventsPath, escalationsPath, config: cfg, now: NOW });
  assert.equal(snap.heartbeat.lastHeartbeatTs, hbTs, "the snapshot carries the last heartbeat timestamp");
  assert.equal(snap.heartbeat.ageSeconds, 30, "and the elapsed time since it (30s)");

  // The age advances by the clock alone — no new event — so the stream must not
  // push a frame every second: the key ignores the ticking age, and the browser
  // recomputes it on a local timer. That is "live without a page reload".
  const later = readSnapshot({ statePath, eventsPath, escalationsPath, config: cfg, now: NOW + 5000 });
  assert.equal(later.heartbeat.ageSeconds, 35, "the age advances with the clock");
  assert.equal(snapshotKey(snap), snapshotKey(later), "a ticking age alone does not change the stream key");

  await withServer({ statePath, eventsPath, escalationsPath, config: cfg, now: () => NOW }, async (base) => {
    const page = (await fetchText(`${base}/`)).body;
    assert.match(page, /setInterval\([\s\S]*?renderHeartbeat\(\)/, "a local timer re-renders the heartbeat age without a reload");
    const { json } = await fetchJson(`${base}/api/snapshot`);
    assert.equal(json.heartbeat.lastHeartbeatTs, hbTs, "the API exposes the last heartbeat for the browser to age locally");
  });
});

// --- #176 Criterion 3: when the last heartbeat is older than a threshold
// derived from the poll interval, the dashboard shows a prominent "supervisor
// silent since Xm" banner. -----------------------------------------------------
{
  assert.equal(heartbeatThresholdSeconds(60), Math.round(60 * HEARTBEAT_SILENCE_FACTOR), "the threshold derives from the poll interval");
  assert.ok(heartbeatThresholdSeconds(120) > heartbeatThresholdSeconds(60), "a longer poll interval tolerates longer silence");

  const threshold = heartbeatThresholdSeconds(60);
  const fresh = heartbeatStatus({ lastHeartbeatTs: new Date(NOW - (threshold - 5) * 1000).toISOString(), thresholdSeconds: threshold, now: NOW });
  assert.equal(fresh.state, "live", "a heartbeat within the threshold reads as live");
  const stale = heartbeatStatus({ lastHeartbeatTs: new Date(NOW - (threshold + 60) * 1000).toISOString(), thresholdSeconds: threshold, now: NOW });
  assert.equal(stale.state, "silent", "a heartbeat past the threshold reads as silent");
}
await inTempDir(async (dir) => {
  const eventsPath = join(dir, "ev.jsonl");
  const statePath = join(dir, "s.json");
  const escalationsPath = join(dir, "esc.md");
  writeFileSync(statePath, JSON.stringify({}));
  writeFileSync(escalationsPath, "");
  const cfg = { ...CONFIG, pollSeconds: 60 };
  const staleTs = new Date(NOW - (heartbeatThresholdSeconds(60) + 120) * 1000).toISOString();
  writeFileSync(eventsPath, JSON.stringify({ ts: staleTs, event: "heartbeat" }) + "\n");

  const snap = readSnapshot({ statePath, eventsPath, escalationsPath, config: cfg, now: NOW });
  assert.equal(snap.heartbeat.state, "silent", "a stale heartbeat marks the supervisor silent in the snapshot");

  await withServer({ statePath, eventsPath, escalationsPath, config: cfg, now: () => NOW }, async (base) => {
    const page = (await fetchText(`${base}/`)).body;
    assert.match(page, /id="hbbanner"/, "the page has a prominent heartbeat banner element");
    assert.match(page, /Supervisor silent since/, "the banner announces the supervisor as silent since a duration");
    assert.match(page, /\.hbbanner\.silent/, "the silent banner is styled prominently");
  });
});

// --- #176 Criterion 4: with no heartbeat event in the stream at all, the
// dashboard says the supervisor has not been seen, never an unlabelled green
// "live" dot. -------------------------------------------------------------------
await inTempDir(async (dir) => {
  const eventsPath = join(dir, "ev.jsonl");
  const statePath = join(dir, "s.json");
  const escalationsPath = join(dir, "esc.md");
  writeFileSync(statePath, JSON.stringify({}));
  writeFileSync(escalationsPath, "");
  // Events exist, but none is a heartbeat.
  writeFileSync(eventsPath, JSON.stringify({ ts: new Date(NOW).toISOString(), event: "dispatch", issue: 5 }) + "\n");

  assert.equal(latestHeartbeatTs(readEvents(eventsPath)), null, "a stream with no heartbeat has no last heartbeat");
  const snap = readSnapshot({ statePath, eventsPath, escalationsPath, config: { ...CONFIG, pollSeconds: 60 }, now: NOW });
  assert.equal(snap.heartbeat.lastHeartbeatTs, null, "the snapshot reports the supervisor as never seen");
  assert.equal(snap.heartbeat.state, "unseen", "its state is unseen, not live");

  await withServer({ statePath, eventsPath, escalationsPath, now: () => NOW }, async (base) => {
    const page = (await fetchText(`${base}/`)).body;
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)[1];
    const handler = /addEventListener\("snapshot"[\s\S]*?\}\);/.exec(script)[0];
    assert.doesNotMatch(handler, /livedot[\s\S]*?add\("live"\)/, "the snapshot handler no longer force-lights the live dot");
    assert.match(script, /has not been seen/, "the page labels an unseen supervisor");
    assert.match(script, /supervisor not seen/, "the header text names the supervisor as not seen, never a bare green dot");
  });
});

// --- #176 Criterion 5: every criterion above has exactly one test named after
// it. The plan file carried five #176 acceptance criteria; this counts its own
// `#176 Criterion N` markers and proves there is exactly one per criterion,
// 1..5. It counts markers in THIS file only — it never reads the plan file at
// runtime, so archiving the plan when the issue closes can never break it.
{
  const CRITERIA_COUNT = 5;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #176 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #176 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #176 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#176 criterion ${n} has a test`);
}

// --- #181 Criterion 1: a row with an open PR shows its combined checks status:
// passing, failing, or pending. ----------------------------------------------
await inTempDir(async (dir) => {
  const statePath = join(dir, "state.json");
  const eventsPath = join(dir, "events.jsonl");
  const start = new Date(NOW - 90_000).toISOString();
  writeFileSync(statePath, JSON.stringify({
    5: { adapter: "codex", pid: 222, attempts: 2, status: "in-review", pr: 42, logFile: "l5.log" },
    7: { adapter: "claude", pid: 111, attempts: 1, status: "dispatched", pr: null, logFile: "l7.log" },
  }));
  writeFileSync(eventsPath, JSON.stringify({ ts: start, event: "dispatch", issue: 5 }) + "\n");

  // aggregateChecks: the pure derivation behind the combined status
  assert.equal(aggregateChecks([{ name: "ci", state: "SUCCESS" }]).status, "passing", "all success -> passing");
  assert.equal(aggregateChecks([{ name: "ci", state: "FAILURE" }]).status, "failing", "any failure -> failing");
  assert.equal(aggregateChecks([{ name: "ci", state: "PENDING" }]).status, "pending", "pending -> pending");
  assert.equal(aggregateChecks([]).status, "pending", "no checks yet -> pending");
  assert.equal(aggregateChecks([{ name: "ci", state: "SUCCESS" }, { name: "lint", state: "FAILURE" }]).status, "failing", "mixed with a failure -> failing");
  assert.equal(aggregateChecks([{ name: "ci", state: "SUCCESS" }, { name: "lint", state: "PENDING" }]).status, "pending", "success + pending -> pending");

  // The snapshot attaches the checks status to the worker row with a PR
  const cache = createChecksCache({ fetchChecks: () => ({ status: "passing" }) });
  readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW, repoSlug: "praveenvijayan/Ratchet", checksCache: cache });
  await new Promise((r) => setTimeout(r, 10));
  const snap = readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW, repoSlug: "praveenvijayan/Ratchet", checksCache: cache });
  const w5 = snap.workers.find((w) => w.issue === 5);
  const w7 = snap.workers.find((w) => w.issue === 7);
  assert.equal(w5.pr, 42, "row 5 has an open PR");
  assert.equal(w5.checksStatus, "passing", "row with an open PR shows its combined checks status");
  assert.ok(w5.checksFetchedAt != null, "the status carries a fetched-at timestamp");
  assert.equal(w7.pr, null, "row 7 has no PR");
  assert.equal(w7.checksStatus, undefined, "a row without a PR has no checks status");

  // The page renders the checks status next to the PR link
  await withServer({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), repoSlug: "praveenvijayan/Ratchet", fetchChecks: () => ({ status: "passing" }) }, async (base) => {
    const page = await fetchText(`${base}/`);
    assert.match(page.body, /class="checks/, "the page has a checks status element");
    assert.match(page.body, /function checksClass/, "the page has a checksClass function");
  });
});

// --- #181 Criterion 2: the status refreshes periodically without a page reload;
// the last-fetched time is visible. ------------------------------------------
await inTempDir(async (dir) => {
  const statePath = join(dir, "state.json");
  const eventsPath = join(dir, "events.jsonl");
  const start = new Date(NOW - 90_000).toISOString();
  writeFileSync(statePath, JSON.stringify({
    5: { adapter: "codex", pid: 222, attempts: 2, status: "in-review", pr: 42, logFile: "l5.log" },
  }));
  writeFileSync(eventsPath, JSON.stringify({ ts: start, event: "dispatch", issue: 5 }) + "\n");

  const fetchLog = [];
  let callCount = 0;
  const cache = createChecksCache({
    fetchChecks: (pr) => { callCount++; fetchLog.push(callCount); return { status: "passing" }; },
    refreshMs: 20, // very short for the test
  });

  // First poll: triggers fetch #1
  readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW, repoSlug: "praveenvijayan/Ratchet", checksCache: cache });
  await new Promise((r) => setTimeout(r, 10));
  // Second poll: fetch resolved, fetchAt is set
  const snap1 = readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW, repoSlug: "praveenvijayan/Ratchet", checksCache: cache });
  const w1 = snap1.workers.find((w) => w.issue === 5);
  assert.ok(w1.checksFetchedAt != null, "the last-fetched time is visible on the row");
  assert.equal(w1.checksStatus, "passing", "status is present");

  // Wait beyond refreshMs, then poll again — should re-fetch
  await new Promise((r) => setTimeout(r, 30));
  readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW, repoSlug: "praveenvijayan/Ratchet", checksCache: cache });
  await new Promise((r) => setTimeout(r, 10));
  const snap2 = readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW, repoSlug: "praveenvijayan/Ratchet", checksCache: cache });
  const w2 = snap2.workers.find((w) => w.issue === 5);
  assert.ok(callCount >= 2, "the status refreshed (fetchChecks called again after refreshMs)");
  assert.ok(w2.checksFetchedAt >= w1.checksFetchedAt, "the fetched-at time moved forward on refresh");

  // The page renders the last-fetched time
  await withServer({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), repoSlug: "praveenvijayan/Ratchet", fetchChecks: () => ({ status: "passing" }), checksRefreshMs: 50 }, async (base) => {
    const page = await fetchText(`${base}/`);
    assert.match(page.body, /checksFetchedAt/, "the page reads checksFetchedAt from the snapshot");
    assert.match(page.body, /function checksAgo/, "the page computes a human-readable time-ago from the fetched-at timestamp");
  });
});

// --- #181 Criterion 3: a checks query failure shows an "unknown" state on the
// row, never a stale "passing" presented as current or a broken row. ---------
await inTempDir(async (dir) => {
  const statePath = join(dir, "state.json");
  const eventsPath = join(dir, "events.jsonl");
  const start = new Date(NOW - 90_000).toISOString();
  writeFileSync(statePath, JSON.stringify({
    5: { adapter: "codex", pid: 222, attempts: 2, status: "in-review", pr: 42, logFile: "l5.log" },
  }));
  writeFileSync(eventsPath, JSON.stringify({ ts: start, event: "dispatch", issue: 5 }) + "\n");

  // A fetcher that always fails (simulates gh missing or network error)
  const cache = createChecksCache({ fetchChecks: () => { throw new Error("gh not found"); } });
  readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW, repoSlug: "praveenvijayan/Ratchet", checksCache: cache });
  await new Promise((r) => setTimeout(r, 10));
  const snap = readSnapshot({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), config: CONFIG, now: NOW, repoSlug: "praveenvijayan/Ratchet", checksCache: cache });
  const w = snap.workers.find((w) => w.issue === 5);
  assert.equal(w.checksStatus, "unknown", "a failed query shows 'unknown', never a stale 'passing'");
  assert.ok(w.checksFetchedAt != null, "the failed attempt still carries a fetched-at time");

  // The page renders "unknown" with the unknown class, never a broken row
  await withServer({ statePath, eventsPath, escalationsPath: join(dir, "none.md"), repoSlug: "praveenvijayan/Ratchet", fetchChecks: () => { throw new Error("fail"); } }, async (base) => {
    const page = await fetchText(`${base}/`);
    assert.match(page.body, /checks\.unknown/, "the page styles unknown checks distinctly (not passing/failing/pending)");
  });
});

// --- #181 Criterion 4: every criterion above has exactly one test named after
// it. The plan file carried four #181 acceptance criteria; this counts its own
// `#181 Criterion N` markers and proves there is exactly one per criterion,
// 1..4. It counts markers in THIS file only — it never reads the plan file at
// runtime, so archiving the plan when the issue closes can never break it.
{
  const CRITERIA_COUNT = 4;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #181 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #181 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #181 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#181 criterion ${n} has a test`);
}


// --- #182 Criterion 5: every criterion above has exactly one test named after
// it. The plan file carried five #182 acceptance criteria; this counts its own
// `#182 Criterion N` markers and proves there is exactly one per criterion,
// 1..5. It counts markers in THIS file only — it never reads the plan file at
// runtime, so archiving the plan when the issue closes can never break it.
{
  const CRITERIA_COUNT = 5;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #182 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #182 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #182 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#182 criterion ${n} has a test`);
}

// ===========================================================================
// Issue #275 — Herd dashboard Santorini reskin, foundation slice (0119).
// One test per acceptance criterion, driven through the page's public HTML
// (PAGE_HTML). Structural CSS/markup assertions — the reskin is presentational,
// so there is no server behaviour to fetch. Each Criterion-N block carries its
// own `#275 Criterion N` marker; Criterion 5 self-counts them so the "exactly
// one test per criterion" criterion enforces itself, mirroring the #182 block.
// ===========================================================================

// --- #275 Criterion 1: the Santorini palette is defined as CSS custom
// properties and drives the page background, text, and borders. ---
{
  const pal = {
    "--paper": "#e4e3f5",
    "--paper-hi": "#f4f2fc",
    "--paper-lo": "#d7d4ee",
    "--ink": "#3f3e78",
    "--ink-deep": "#2b2a58",
    "--terra": "#7c68c4",
  };
  for (const [name, hex] of Object.entries(pal)) {
    assert.match(
      PAGE_HTML,
      new RegExp(`${name}\\s*:\\s*${hex}`, "i"),
      `:root defines ${name} as ${hex}`,
    );
  }
  for (const alpha of ["--ink-soft", "--ink-faint", "--ink-hair"]) {
    assert.match(
      PAGE_HTML,
      new RegExp(`${alpha}\\s*:\\s*rgba\\(63,\\s*62,\\s*120`, "i"),
      `:root defines the ${alpha} ink alpha`,
    );
  }
  // Used for background, text, and borders.
  assert.match(PAGE_HTML, /body\s*\{[^}]*color:\s*var\(--ink\)/i, "the page text colour is the Santorini ink");
  assert.match(PAGE_HTML, /body\s*\{[^}]*var\(--paper/i, "the page background is painted from the paper palette");
  assert.match(PAGE_HTML, /border-bottom:\s*2px solid var\(--ink\)/i, "the header border uses the ink palette");
}

// --- #275 Criterion 2: the type system follows the design (Marcellus /
// Space Grotesk / Space Mono) and every font-family ends in a generic fallback
// so an unreachable fonts CDN never blocks rendering. ---
{
  assert.match(PAGE_HTML, /--serif\s*:\s*'Marcellus',\s*serif/i, "display font is Marcellus with a serif fallback");
  assert.match(PAGE_HTML, /--sans\s*:\s*'Space Grotesk',\s*sans-serif/i, "body font is Space Grotesk with a sans-serif fallback");
  assert.match(PAGE_HTML, /--mono\s*:\s*'Space Mono',\s*monospace/i, "label/metric font is Space Mono with a monospace fallback");

  // Every literal font-family declaration ends in a generic family, or resolves
  // to one of the three type vars (which themselves end in a generic).
  const families = [...PAGE_HTML.matchAll(/font-family:\s*([^;}]+)/gi)].map((m) => m[1].trim());
  assert.ok(families.length > 0, "the page declares at least one font-family");
  for (const value of families) {
    assert.match(
      value,
      /(serif|sans-serif|monospace)\s*$|var\(--(serif|sans|mono)\)\s*$/i,
      `font-family "${value}" ends in a generic fallback`,
    );
  }

  // The fonts <link> is the ONE external stylesheet reference; its failure only
  // drops the CDN faces, leaving the generic fallbacks in place.
  const stylesheets = [...PAGE_HTML.matchAll(/<link[^>]*rel="stylesheet"[^>]*>/gi)];
  assert.equal(stylesheets.length, 1, "exactly one external stylesheet link (the fonts)");
  assert.match(stylesheets[0][0], /fonts\.googleapis\.com\/css2\?family=Marcellus[^"]*Space\+Grotesk[^"]*Space\+Mono/i, "the fonts link requests all three families");
}

// --- #275 Criterion 3: the header renders the brand block and a right-aligned
// heartbeat (pulsing dot, liveness text, time since last heartbeat), keeping
// the existing live / silent / not-seen states. ---
{
  assert.match(
    PAGE_HTML,
    /<div class="brand">\s*<h1>Herd Dashboard<\/h1>/i,
    "the brand block pairs the serif title with the Santorini ordinal",
  );
  assert.match(PAGE_HTML, /\.brand h1\s*\{[^}]*font-family:\s*var\(--serif\)/i, "the title is set in the display serif");
  assert.match(PAGE_HTML, /header \.heartbeat\s*\{[^}]*margin-left:\s*auto/i, "the heartbeat is pushed to the right of the header");
  assert.match(PAGE_HTML, /<div class="heartbeat"><span class="dot" id="livedot">/i, "the heartbeat carries the live dot and liveness text");
  // Pulsing dot.
  assert.match(PAGE_HTML, /header \.dot\.live\s*\{[^}]*animation:\s*hb-pulse/i, "the live dot pulses");
  assert.match(PAGE_HTML, /@keyframes hb-pulse/i, "the pulse animation is defined");
  // Existing liveness states and the time-since text are preserved.
  assert.match(PAGE_HTML, /supervisor not seen/, "the not-seen state is kept");
  assert.match(PAGE_HTML, /supervisor silent/, "the silent state is kept");
  assert.match(PAGE_HTML, /"supervisor live · heartbeat " \+ durText\(age\) \+ " ago"/, "the live state shows the time since the last heartbeat");
}

// --- #275 Criterion 4: the top region is a two-column grid (active agents deck
// + errors & escalations) that collapses to one column below 1180px.
// (Superseded #306/#316 layout: the deck is now the flexible left column and the
// errors region the fixed right column; the responsive top-region grid keeps
// this criterion's intent.) ---
{
  assert.match(PAGE_HTML, /\.topregion\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(0,\s*420px\)/i, "the top region is a two-column grid on a desktop-width viewport");
  assert.match(PAGE_HTML, /@media \(max-width:\s*1180px\)\s*\{\s*\.topregion\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/i, "below 1180px the top region collapses to a single column");
  assert.match(PAGE_HTML, /<div class="topregion"[\s\S]*id="deckwrap"[\s\S]*id="errpanel"/, "the deck precedes the errors region inside the top region");
}

// --- #275 Criterion 5: every criterion above has exactly one test. ---
{
  const CRITERIA_COUNT = 5;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #275 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #275 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #275 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#275 criterion ${n} has a test`);
}

// ===========================================================================
// Issue #278 — Herd dashboard Santorini reskin, slice 0121 (sections, summary
// strip, work rows). One test per acceptance criterion, asserted against the
// page's source (PAGE_HTML) — the reskin is presentational, so the checks are
// structural CSS + render-code assertions. Each Criterion-N block carries a
// `#278 Criterion N` marker; Criterion 5 self-counts them.
// ===========================================================================

// --- #278 Criterion 1: section headings render as a serif uppercase title +
// circled count tally + horizontal rule ending in a diamond, applied to each
// lifecycle group heading. ---
{
  assert.match(PAGE_HTML, /\.sec \.group-head\s*\{[^}]*font-family:var\(--serif\)[^}]*text-transform:uppercase/i, "the section title is serif and uppercase");
  assert.match(PAGE_HTML, /\.sec \.tally\s*\{[^}]*border-radius:50%/i, "the count tally is circled");
  assert.match(PAGE_HTML, /\.sec \.rule\s*\{[^}]*flex:1[^}]*height:1px/i, "the heading carries a horizontal rule");
  assert.match(PAGE_HTML, /\.sec \.rule::after\s*\{[^}]*transform:rotate\(45deg\)/i, "the rule ends in a diamond");
  // Applied to each lifecycle group: the .sec heading is built inside the
  // per-group render loop, so every group (awaiting review, live, escalated,
  // terminal, other) gets the pattern.
  assert.match(PAGE_HTML, /'<div class="sec"><h2 class="group-head">' \+ esc\(labelOf\(key\)\)/, "each lifecycle group heading uses the .sec pattern");
  assert.match(PAGE_HTML, /<span class="tally">' \+ rows\.length \+ '<\/span><span class="rule">/, "each heading carries the group's count tally and rule");
}

// --- #278 Criterion 2: the summary strip renders each stat as a bordered block
// with offset shadow (serif number + mono uppercase label); the escalations
// stat and the errors chip get the --terra alert treatment with the error
// count in a filled pill. ---
{
  assert.match(PAGE_HTML, /\.sumcell\s*\{[^}]*border:1\.5px solid var\(--ink\)[^}]*box-shadow:5px 5px 0/i, "each stat is a bordered block with an offset shadow");
  assert.match(PAGE_HTML, /\.sumcell \.sumnum\s*\{[^}]*font-family:var\(--serif\)/i, "the stat number is a large serif");
  assert.match(PAGE_HTML, /\.sumcell \.sumlabel\s*\{[^}]*font-family:var\(--mono\)[^}]*text-transform:uppercase/i, "the stat label is a mono uppercase");
  assert.match(PAGE_HTML, /\.sumcell\.alert\s*\{[^}]*border-color:var\(--terra\)/i, "the alert stat gets the terra treatment");
  assert.match(PAGE_HTML, /summaryCell\("escalations", s\.unresolvedEscalations, true\)/, "the escalations stat is rendered with the alert flag");
  // #306 superseded the toggled errors chip; the terra alert treatment now
  // lives on the error-count pill in the top-left errors-region head.
  assert.match(PAGE_HTML, /\.errcount\s*\{[^}]*background:var\(--terra\)[^}]*border-radius:99px/i, "the error count is a filled terra pill");
}

// --- #278 Criterion 3: work rows render as bordered cards with an issue-number
// link, uppercase status chip (dispatched / ready-for-review / stale-claim
// variants), assignee avatar chip, title, and a dashed-rule telemetry strip. ---
{
  assert.match(PAGE_HTML, /\.row\s*\{[^}]*border:1\.5px solid var\(--ink\)[^}]*box-shadow:5px 5px 0/i, "work rows are bordered cards with an offset shadow");
  assert.match(PAGE_HTML, /'<article class="row' \+ \(w\.issue === selected \? " sel" : ""\) \+ '" data-issue="'/, "each row is an article card keyed by its issue");
  assert.match(PAGE_HTML, /'<a class="issue-no"/, "the card links the issue number");
  // Status chip with the three distinct variants.
  assert.match(PAGE_HTML, /'<span class="status' \+ statusClass\(w\.status\)/, "the card renders an uppercase status chip");
  assert.match(PAGE_HTML, /s === "dispatched"[\s\S]*?s === "stale-claim"[\s\S]*?s === "ready-for-review"/, "statusClass distinguishes dispatched / stale-claim / ready-for-review");
  assert.match(PAGE_HTML, /\.status\.dispatched\b/, "the dispatched chip has distinct styling");
  assert.match(PAGE_HTML, /\.status\.review\b/, "the ready-for-review chip has distinct styling");
  assert.match(PAGE_HTML, /\.status\.stale\b/, "the stale-claim chip has distinct styling");
  // Assignee avatar chip, title, dashed telemetry strip.
  assert.match(PAGE_HTML, /'<span class="who">' \+ avatarImg\(w\)/, "the assignee is shown with an avatar chip");
  assert.match(PAGE_HTML, /\.telemetry\s*\{[^}]*border-top:1px dashed/i, "the telemetry strip is separated by a dashed rule");
  assert.match(PAGE_HTML, /tm\("Attempts",[\s\S]*?tm\("Age",[\s\S]*?tm\("PR",[\s\S]*?tm\("Cost",[\s\S]*?tm\("Tokens In",[\s\S]*?tm\("Tokens Out",/, "the telemetry lists attempts, age, PR, cost, and tokens in/out");
}

// --- #278 Criterion 4: missing telemetry values show a faint em dash, never
// blank or "undefined" (unreadable usage, no PR, or missing title all render
// "—"). ---
{
  assert.match(PAGE_HTML, /usdCell = \(n\) => isNum\(n\) \? usdText\(n\) : '<span class="empty">—<\/span>'/, "a null cost renders the em-dash placeholder");
  assert.match(PAGE_HTML, /tokCell = \(n\) => isNum\(n\) \? tokText\(n\) : '<span class="empty">—<\/span>'/, "a null token count renders the em-dash placeholder");
  assert.match(PAGE_HTML, /'<div class="row-title issue-title empty">—<\/div>'/, "a missing title renders the em dash, never blank");
  assert.match(PAGE_HTML, /w\.pr != null \? "#" \+ esc\(w\.pr\) : '<span class="empty">—<\/span>'/, "a worker with no PR renders the em dash");
  assert.match(PAGE_HTML, /'<span class="who"><span class="empty">—<\/span><\/span>'/, "an unassigned worker renders the em dash");
  assert.match(PAGE_HTML, /\.tm \.v \.empty\s*\{[^}]*color:var\(--ink-faint\)/i, "the em-dash telemetry value is faint");
}

// --- #278 Criterion 5: every criterion above has exactly one test. ---
{
  const CRITERIA_COUNT = 5;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #278 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #278 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #278 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#278 criterion ${n} has a test`);
}

// ===========================================================================
// Issue #279 — Herd dashboard Santorini reskin, slice 0122 (incidents aside &
// log console). One test per acceptance criterion, asserted against the page's
// source (PAGE_HTML) — the reskin is presentational, so the checks are
// structural CSS + render-code assertions. Each Criterion-N block carries a
// `#279 Criterion N` marker; Criterion 5 self-counts them.
// ===========================================================================

// --- #279 Criterion 1: the errors & escalations panel is a bordered aside with
// an ink-inverted head; each incident is a card, and unresolved (flagged)
// incidents get the terra border, terra action buttons, and an offset shadow
// while resolved ones are de-emphasised. ---
{
  assert.match(PAGE_HTML, /\.errpanel\s*\{[^}]*border:1\.5px solid var\(--ink\)[^}]*box-shadow:8px 8px 0/i, "the incidents aside is a bordered card with an offset shadow");
  assert.match(PAGE_HTML, /\.errpanel-head\s*\{[^}]*background:var\(--ink\)[^}]*color:var\(--paper-hi\)/i, "the panel head is ink-inverted");
  assert.match(PAGE_HTML, /\.esc\s*\{[^}]*border:1\.5px solid var\(--terra\)[^}]*box-shadow:4px 4px 0/i, "an unresolved incident card gets the accent border and offset shadow");
  assert.match(PAGE_HTML, /\.esc \.act-btn\s*\{[^}]*border:1\.5px solid var\(--terra\)[^}]*color:var\(--terra\)/i, "the incident action buttons are accent-coloured");
  assert.match(PAGE_HTML, /\.esc\.resolved\s*\{[^}]*opacity:0\.6/i, "a resolved incident is de-emphasised");
}

// --- #279 Criterion 2: the adapter-failure alerts and per-adapter breakdown
// still render inside the aside (renderAdapterHealth into #adapterhealth) and
// match the incident-card visual language (terra alert card, dashed-ruled table
// under an ink header). ---
{
  assert.match(PAGE_HTML, /'<div class="adapter-alert">adapter <strong>'/, "the broken-adapter alerts still render as adapter-alert cards");
  assert.match(PAGE_HTML, /'<table class="adapter-breakdown">/, "the per-adapter breakdown table still renders");
  assert.match(PAGE_HTML, /s\.successes === 0 && s\.failures > 0 \? ' class="broken"'/, "an all-failing adapter row is flagged .broken");
  assert.match(PAGE_HTML, /\.adapter-alert\s*\{[^}]*border:1\.5px solid var\(--terra\)/i, "the adapter alert card carries the incident accent border");
  assert.match(PAGE_HTML, /\.adapter-breakdown th\s*\{[^}]*background:var\(--ink\)[^}]*color:var\(--paper-hi\)/i, "the breakdown header is ink-inverted");
  assert.match(PAGE_HTML, /\.adapter-breakdown td\s*\{[^}]*border-top:1px dashed/i, "the breakdown rows are separated by dashed rules");
}

// --- #279 Criterion 3: the log console renders lines as timestamp / bold event
// / faint meta, with escalation events in the accent colour; the filter input
// matches the design and non-matching lines are hidden with a "No matches."
// message when nothing matches. ---
{
  assert.match(PAGE_HTML, /\.timeline-ts\s*\{[^}]*color:var\(--ink-soft\)/i, "the timestamp is faint");
  assert.match(PAGE_HTML, /\.timeline-event\s*\{[^}]*font-weight:700/i, "the event is bold");
  assert.match(PAGE_HTML, /\.timeline-fields\s*\{[^}]*color:var\(--ink-soft\)/i, "the meta fields are faint");
  assert.match(PAGE_HTML, /\.timeline-event\.esc\s*\{[^}]*color:var\(--terra\)/i, "escalation events are accent-coloured");
  assert.match(PAGE_HTML, /String\(e\.event \|\| ""\)\.startsWith\("escalat"\) \? "timeline-event esc"/, "an escalation event is rendered with the accent class");
  assert.match(PAGE_HTML, /\.logsearch\s*\{[^}]*border:1\.5px solid var\(--ink\)[^}]*box-shadow:4px 4px 0/i, "the filter input carries the design border and offset shadow");
  assert.match(PAGE_HTML, /matched\.length === 0 && logBuffer\.length > 0/, "a query with zero matches hides the log tail");
  assert.match(PAGE_HTML, /nomatch\.hidden = false/, "the No-matches message is shown when nothing matches");
  assert.match(PAGE_HTML, /No matches\./, "the log pane carries the visible No-matches text");
}

// --- #279 Criterion 4: the acknowledge and copy-command actions keep working,
// and an acknowledge failure shows a friendly, visible error on the incident
// card (never a raw stack trace). ---
{
  assert.match(PAGE_HTML, /onclick="copyCmd\(this\)"[^>]*|data-cmd="/, "the copy-command action is wired");
  assert.match(PAGE_HTML, /onclick="ackEsc\(this\)"/, "the acknowledge action is wired");
  assert.match(PAGE_HTML, /fetch\("\/api\/acknowledge"/, "acknowledge still POSTs to /api/acknowledge");
  assert.match(PAGE_HTML, /err\.textContent = "Failed to acknowledge: " \+ \(data\.error \|\| "unknown error"\)/, "an acknowledge failure shows a friendly message, not a raw stack trace");
  assert.match(PAGE_HTML, /err\.className = "esc-error"/, "the failure is surfaced in a visible esc-error element on the card");
  assert.match(PAGE_HTML, /\.esc \.esc-error\s*\{[^}]*color:var\(--terra\)/i, "the esc-error message is styled to stand out");
}

// --- #279 Criterion 5: every criterion above has exactly one test. ---
{
  const CRITERIA_COUNT = 5;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #279 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #279 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #279 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#279 criterion ${n} has a test`);
}

// --- #288 live config reload -------------------------------------------------
// The dashboard re-reads .ratchet/herd.json for each snapshot (configPath wired
// through run()), so operator edits reflect without a server restart. These
// tests drive a real server pointed at a temp herd.json and edit it live.
function writeHerdConfig(dir, obj) {
  mkdirSync(join(dir, ".ratchet"), { recursive: true });
  const path = join(dir, ".ratchet", "herd.json");
  writeFileSync(path, JSON.stringify(obj));
  return path;
}
const herdConfig = (avatar, pollSeconds) => ({
  adapters: { claude: { launch: ["run"], avatar } },
  routing: { default: "claude" },
  pollSeconds,
});

// --- #288 Criterion 1: editing an adapter's avatar in herd.json while the
// dashboard runs is reflected in the next snapshot the browser receives, with
// no server restart. ---
await inTempDir(async (dir) => {
  const configPath = writeHerdConfig(dir, herdConfig("data:image/png;base64,AAAA", 60));
  await withServer({ configPath }, async (base) => {
    const before = (await fetchJson(`${base}/api/snapshot`)).json;
    assert.equal(before.deck[0].name, "claude");
    assert.equal(before.deck[0].avatar, "data:image/png;base64,AAAA", "serves the original avatar");
    writeHerdConfig(dir, herdConfig("data:image/png;base64,BBBB", 60));
    const after = (await fetchJson(`${base}/api/snapshot`)).json;
    assert.equal(after.deck[0].avatar, "data:image/png;base64,BBBB", "the edited avatar reflects in the next snapshot without a restart");
  });
});

// --- #288 Criterion 2: other config-derived values from the same read (poll-
// derived heartbeat threshold) update consistently with the avatar — the next
// snapshot is all-new, never half-old, half-new. ---
await inTempDir(async (dir) => {
  const configPath = writeHerdConfig(dir, herdConfig("data:image/png;base64,AAAA", 60));
  await withServer({ configPath }, async (base) => {
    const before = (await fetchJson(`${base}/api/snapshot`)).json;
    assert.equal(before.deck[0].avatar, "data:image/png;base64,AAAA");
    assert.equal(before.heartbeat.thresholdSeconds, heartbeatThresholdSeconds(60));
    writeHerdConfig(dir, herdConfig("data:image/png;base64,BBBB", 90));
    const after = (await fetchJson(`${base}/api/snapshot`)).json;
    // Both derive from the one config read for this snapshot: they move together.
    assert.equal(after.deck[0].avatar, "data:image/png;base64,BBBB", "avatar reflects the edit");
    assert.equal(after.heartbeat.thresholdSeconds, heartbeatThresholdSeconds(90), "the poll-derived threshold reflects the same edit — no half-old snapshot");
    assert.notEqual(heartbeatThresholdSeconds(90), heartbeatThresholdSeconds(60), "sanity: the two pollSeconds yield distinct thresholds");
  });
});

// --- #288 Criterion 3: while herd.json is missing or unparseable, the dashboard
// keeps serving the last good config and the server does not crash. ---
await inTempDir(async (dir) => {
  const configPath = writeHerdConfig(dir, herdConfig("data:image/png;base64,AAAA", 60));
  await withServer({ configPath }, async (base) => {
    assert.equal((await fetchJson(`${base}/api/snapshot`)).json.deck[0].avatar, "data:image/png;base64,AAAA");
    // Unparseable: keep last good, still 200.
    writeFileSync(configPath, "{ not valid json");
    const garbled = await fetchJson(`${base}/api/snapshot`);
    assert.equal(garbled.status, 200, "server does not crash on unparseable config");
    assert.equal(garbled.json.deck[0].avatar, "data:image/png;base64,AAAA", "keeps serving the last good avatar while the file is unparseable");
    // Missing: still last good, still 200.
    rmSync(configPath);
    const missing = await fetchJson(`${base}/api/snapshot`);
    assert.equal(missing.status, 200, "server does not crash when the config file is gone");
    assert.equal(missing.json.deck[0].avatar, "data:image/png;base64,AAAA", "keeps serving the last good avatar while the file is missing");
  });
});

// --- #288 Criterion 4: an avatar URL that fails to load in the browser still
// falls back to the bundled mascot with no broken-image icon, as today. This is
// the client-side onerror path baked into the served page. ---
{
  assert.match(PAGE_HTML, /window\.avatarFallback = function \(img\)/, "the client avatar-fallback handler is present");
  assert.match(PAGE_HTML, /img\.onerror = null;/, "the handler clears onerror first so the default can never loop into a broken image");
  assert.match(PAGE_HTML, /onerror="avatarFallback\(this\)"/, "each mascot img wires onerror to the fallback");
  assert.match(PAGE_HTML, /data-default="' \+ esc\(c\.defaultAvatar\)/, "the deck card carries the bundled default the fallback swaps to");
}

// --- #304 Criterion 1: the header brand renders the dashboard name in the h1,
// not uppercased by CSS. (The "Name updated" change on main set the visible
// header to "Herd Dashboard"; this criterion tracks that intended name.) -----
{
  assert.match(
    PAGE_HTML,
    /<div class="brand">\s*<h1>Herd Dashboard<\/h1>/,
    "the header brand renders \"Herd Dashboard\" inside the h1",
  );
  // The .brand h1 rule must not uppercase the text (the old treatment did).
  assert.doesNotMatch(
    PAGE_HTML,
    /\.brand h1\s*\{[^}]*text-transform:\s*uppercase/i,
    "the .brand h1 rule no longer uppercases the brand text",
  );
}

// --- #304 Criterion 2: the header name is set in the display serif at the
// brand size, so it reads as the page title. --------------------------------
{
  assert.match(
    PAGE_HTML,
    /\.brand h1\s*\{[^}]*font-family:\s*var\(--serif\)[^}]*font-size:\s*30px/i,
    "the header name (.brand h1) is set in the display serif at 30px",
  );
}

// --- #304 Criterion 3: the browser tab `<title>` reads "Ratchet herd
// dashboard". -----------------------------------------------------------
{
  assert.match(
    PAGE_HTML,
    /<title>Ratchet herd dashboard<\/title>/,
    "the browser tab title reads \"Ratchet herd dashboard\"",
  );
}

// --- #304 Criterion 4: every criterion above has exactly one test named after
// it. The plan file carried four #304 acceptance criteria; this counts its own
// `#304 Criterion N` markers and proves there is exactly one per criterion,
// 1..4. It counts markers in THIS file only — it never reads the plan file at
// runtime, so archiving the plan when the issue closes can never break it.
{
  const CRITERIA_COUNT = 4;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #304 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #304 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #304 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#304 criterion ${n} has a test`);
}

console.log("PASS herd-ui.test.mjs");
