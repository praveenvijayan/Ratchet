#!/usr/bin/env node
// herd-ui-log-search.test.mjs — the acceptance criteria of issue #184 are the
// test plan: exactly one test per criterion of the log drill-down search and
// filter feature, driven through herd-ui.mjs's public interface (PAGE_HTML and
// the live SSE log stream). Offline: fixtures in temp dirs, servers bind
// 127.0.0.1:0, SSE frames read over raw node:http. Zero dependencies. Run:
//   node scripts/herd-ui-log-search.test.mjs

import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PAGE_HTML, createDashboardServer, listenOrFail } from "./herd-ui.mjs";

const CONFIG = { reworkCap: 2, claimTimeoutSeconds: 300 };

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-ui-log-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

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

// Extract the inline <script> block from PAGE_HTML for structural assertions.
function pageScript() {
  const m = /<script>([\s\S]*?)<\/script>/.exec(PAGE_HTML);
  assert.ok(m, "page has a script block");
  return m[1];
}

// --- #184 Criterion 1: A search box filters the displayed log to lines matching
// the query, updating as the user types. --------------------------------------
{
  // The page carries a search input inside the log pane.
  assert.match(PAGE_HTML, /<input[^>]*id="logsearch"[^>]*/, "a search input exists inside the log pane");
  assert.match(PAGE_HTML, /type="search"/, "the search input is a type=search field");

  const script = pageScript();

  // renderLog filters by the query: it splits the buffer into lines and keeps
  // only those containing the query (case-insensitive).
  assert.match(script, /renderLog/, "a renderLog function exists");
  assert.match(script, /\.split\(/, "the buffer is split into lines for filtering");
  assert.match(script, /\.filter\(/, "lines are filtered by the query");
  assert.match(script, /\.toLowerCase\(\)\.includes\(/, "the match is case-insensitive substring");

  // The search input has an input event listener so filtering updates as the
  // user types (no submit button, no debounce gate).
  assert.match(script, /logsearch[\s\S]*addEventListener\("input"/, "the search input reacts on input, updating the filter as the user types");
}

// --- #184 Criterion 2: New tailed lines respect the active filter as they
// arrive. ---------------------------------------------------------------------
await inTempDir(async (dir) => {
  const logFile = join(dir, "issue-9.log");
  writeFileSync(logFile, "error: something broke\ninfo: starting up\n");

  const statePath = join(dir, "s.json");
  writeFileSync(statePath, JSON.stringify({ 9: { adapter: "claude", pid: 1, attempts: 1, status: "dispatched", pr: null, logFile } }));

  // The server still streams the raw log incrementally — the filter is applied
  // client-side, so the server side is unchanged. Verify the stream carries new
  // content that the client's renderLog would filter.
  await withServer({ statePath, eventsPath: join(dir, "e.jsonl"), escalationsPath: join(dir, "esc.md") }, async (base) => {
    const streamDone = sseCollect(
      `${base}/api/log?issue=9`,
      (frames) => frames.filter((f) => f.event === "log").map((f) => f.data).join("").includes("error: again"),
    );
    setTimeout(() => appendFileSync(logFile, "error: again\nwarning: low disk\n"), 120);
    const frames = await streamDone;
    const logText = frames.filter((f) => f.event === "log").map((f) => f.data).join("");
    assert.match(logText, /error: again/, "new tailed lines arrive at the client");

    // The client appends to a buffer and calls renderLog on each chunk, so the
    // active filter is applied to new lines as they arrive — verify the script
    // appends to the buffer and re-renders on every log event.
    const script = pageScript();
    assert.match(script, /logBuffer\s*\+=/, "new log data is appended to the buffer");
    assert.match(script, /"log"[\s\S]*logBuffer\s*\+=[\s\S]*renderLog/, "the log event handler calls renderLog after appending, re-applying the filter to new lines");
  });
});

// --- #184 Criterion 3: Clearing the search restores the full tail view at the
// current position. -----------------------------------------------------------
{
  const script = pageScript();

  // When the query is empty, renderLog writes the entire logBuffer to the pre
  // element — the full tail is restored.
  assert.match(script, /if\s*\(!q\)[\s\S]*pre\.textContent\s*=\s*logBuffer/, "an empty query restores the full buffer to the log pane");

  // The select function resets the search value and buffer when switching
  // workers, so a stale filter never persists across selections.
  assert.match(script, /logsearch[\s\S]*\.value\s*=\s*""/, "selecting a worker clears any active search, restoring the full view");
  assert.match(script, /logBuffer\s*=\s*""/, "selecting a worker resets the log buffer to start fresh");
}

// --- #184 Criterion 4: A query matching nothing shows a "no matches" message,
// never a blank pane. ---------------------------------------------------------
{
  // The page has a dedicated "no matches" element.
  assert.match(PAGE_HTML, /id="lognomatch"/, "a no-matches element exists in the log pane");
  assert.match(PAGE_HTML, /No matches\./, "the no-matches element carries a visible message");

  const script = pageScript();

  // renderLog hides the pre and shows the no-matches div when the query matches
  // zero lines — but only when the buffer actually has content (an empty buffer
  // shows nothing, not "no matches").
  assert.match(script, /matched\.length\s*===\s*0/, "renderLog checks for zero matched lines");
  assert.match(script, /pre\.hidden\s*=\s*true/, "the log pre is hidden when nothing matches");
  assert.match(script, /nomatch\.hidden\s*=\s*false/, "the no-matches message is shown when nothing matches");
  assert.match(script, /logBuffer\.length\s*>\s*0/, "the no-matches message only appears when there is content to search");
}

// --- #184 Criterion 5: Every criterion above has exactly one test named after
// it. The plan file carried five #184 acceptance criteria; this counts its own
// `#184 Criterion N` markers and proves there is exactly one per criterion,
// 1..5. It counts markers in THIS file only — it never reads the plan file at
// runtime, so archiving the plan when the issue closes can never break it.
{
  const CRITERIA_COUNT = 5;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #184 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #184 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #184 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#184 criterion ${n} has a test`);
}

console.log("PASS herd-ui-log-search.test.mjs (5 criteria for #184)");
