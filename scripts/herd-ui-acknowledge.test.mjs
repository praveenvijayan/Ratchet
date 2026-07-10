#!/usr/bin/env node
// herd-ui-acknowledge.test.mjs — the acceptance criteria of issue #180 are the
// test plan: exactly one test per criterion of copy-command and acknowledge
// actions on escalation blocks in the herd dashboard, driven through herd-ui.mjs's
// public interface. Offline: fixtures in temp dirs, servers bind 127.0.0.1:0.
// Zero deps. Run: node scripts/herd-ui-acknowledge.test.mjs

import assert from "node:assert/strict";
import { get as httpGet, request as httpRequest } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PAGE_HTML,
  extractCommand,
  readResolutions,
  appendResolution,
  resolveEscalations,
  dedupEscalations,
  parseEscalations,
  escalationReason,
  readSnapshot,
  createDashboardServer,
  listenOrFail,
  RESOLUTIONS_FILE,
} from "./herd-ui.mjs";

const CONFIG = { reworkCap: 2, claimTimeoutSeconds: 300 };
const NOW = Date.UTC(2026, 6, 9, 12, 0, 0);

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-ack-"));
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
const fetchJson = async (url) => {
  const r = await fetchText(url);
  return { status: r.status, json: JSON.parse(r.body) };
};

function postJson(url, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(b) }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function escMd(blocks) {
  return blocks.map((b) =>
    [
      `## ${b.ts} — issue #${b.issue}`,
      `- What happened: ${b.what}`,
      `- Log file: ${b.logFile || "(none)"}`,
      `- Suggested action: ${b.action || "review the log and re-queue"}`,
      "",
    ].join("\n"),
  ).join("\n");
}

// --- #180 Criterion 1: An escalation whose action contains a command shows a
// copy control that puts the exact command on the clipboard. ---------------
await inTempDir(async (dir) => {
  const escPath = join(dir, "esc.md");
  const statePath = join(dir, "s.json");
  const eventsPath = join(dir, "e.jsonl");
  const resolutionsPath = join(dir, "res.jsonl");
  writeFileSync(escPath, escMd([
    {
      ts: "2026-07-09T10:00:00Z", issue: 7, what: "stale claim ref agent/issue-7 on origin: no live worker and no open PR",
      logFile: null, action: "run `gh api -X DELETE repos/o/r/git/refs/heads/agent/issue-7` to delete the stale claim ref",
    },
    {
      ts: "2026-07-09T10:30:00Z", issue: 9, what: "worker pid 444 is not alive",
      logFile: null, action: "review the log and re-queue the issue",
    },
  ]));
  writeFileSync(statePath, JSON.stringify({ 7: { adapter: null, pid: null, logFile: null, attempts: 0, status: "stale-claim", pr: null } }));
  writeFileSync(eventsPath, "");

  // extractCommand pulls the exact command out of the action text.
  assert.equal(
    extractCommand("run `gh api -X DELETE repos/o/r/git/refs/heads/agent/issue-7` to delete the stale claim ref"),
    "gh api -X DELETE repos/o/r/git/refs/heads/agent/issue-7",
    "extractCommand returns the exact backtick-quoted command",
  );
  assert.equal(extractCommand("review the log and re-queue"), null, "no command in an action without backticks");
  assert.equal(extractCommand(null), null, "null action yields no command");

  // The page renders a copy button with the command in a data attribute.
  assert.match(PAGE_HTML, /copyCmd/, "the page defines a copyCmd handler");
  assert.match(PAGE_HTML, /data-cmd=/, "the copy button carries the command in a data attribute");
  assert.match(PAGE_HTML, /Copy command/, "the copy button is labelled");
  assert.match(PAGE_HTML, /navigator\.clipboard\.writeText/, "the handler writes the command to the clipboard");

  // Over HTTP: the snapshot carries the action so the client can extract the command.
  await withServer({ statePath, eventsPath, escalationsPath: escPath, resolutionsPath }, async (base) => {
    const { json } = await fetchJson(`${base}/api/snapshot`);
    const e7 = json.escalations.find((e) => e.issue === 7);
    const e9 = json.escalations.find((e) => e.issue === 9);
    assert.ok(e7.action.includes("`gh api -X DELETE"), "escalation #7 carries the command in its action");
    assert.equal(extractCommand(e7.action), "gh api -X DELETE repos/o/r/git/refs/heads/agent/issue-7", "the exact command is extractable");
    assert.equal(extractCommand(e9.action), null, "escalation #9 has no command to copy");
  });
});

// --- #180 Criterion 2: Acknowledging an escalation records it (issue, reason,
// timestamp) in a resolutions file and the block renders as resolved from then
// on, surviving dashboard restarts. -----------------------------------------
await inTempDir(async (dir) => {
  const escPath = join(dir, "esc.md");
  const statePath = join(dir, "s.json");
  const eventsPath = join(dir, "e.jsonl");
  const resolutionsPath = join(dir, "res.jsonl");
  writeFileSync(escPath, escMd([
    { ts: "2026-07-09T10:00:00Z", issue: 5, what: "worker pid 111 is not alive", logFile: null, action: "re-queue" },
  ]));
  writeFileSync(statePath, JSON.stringify({}));
  writeFileSync(eventsPath, "");

  // Before acknowledging: the escalation is unresolved.
  let snap = readSnapshot({ statePath, eventsPath, escalationsPath: escPath, resolutionsPath, config: CONFIG, now: NOW });
  assert.equal(snap.escalations[0].resolved, false, "the escalation starts unresolved");

  // The reason is the normalised what text.
  const reason = escalationReason("worker pid 111 is not alive");

  // Acknowledge over HTTP: POST /api/acknowledge.
  await withServer({ statePath, eventsPath, escalationsPath: escPath, resolutionsPath, now: () => NOW }, async (base) => {
    const resp = await postJson(`${base}/api/acknowledge`, { issue: 5, reason });
    assert.equal(resp.status, 200, "the acknowledge endpoint returns 200");
    assert.equal(resp.json.ok, true, "the response confirms success");
  });

  // The resolutions file now has one entry with issue, reason, and a timestamp.
  const resolutions = readResolutions(resolutionsPath);
  assert.equal(resolutions.length, 1, "exactly one resolution was recorded");
  assert.equal(resolutions[0].issue, 5, "the resolution records the issue number");
  assert.equal(resolutions[0].reason, reason, "the resolution records the normalised reason");
  assert.ok(resolutions[0].ts, "the resolution records a timestamp");

  // The snapshot now marks the escalation as resolved.
  snap = readSnapshot({ statePath, eventsPath, escalationsPath: escPath, resolutionsPath, config: CONFIG, now: NOW });
  assert.equal(snap.escalations[0].resolved, true, "the escalation is resolved after acknowledging");

  // Survives a dashboard restart: a fresh server with the same resolutions
  // file still marks the escalation as resolved.
  await withServer({ statePath, eventsPath, escalationsPath: escPath, resolutionsPath, now: () => NOW }, async (base) => {
    const { json } = await fetchJson(`${base}/api/snapshot`);
    assert.equal(json.escalations[0].resolved, true, "the escalation stays resolved across a dashboard restart");
  });

  // The page renders an acknowledge button for unresolved escalations.
  assert.match(PAGE_HTML, /ackEsc/, "the page defines an ackEsc handler");
  assert.match(PAGE_HTML, /Acknowledge/, "the acknowledge button is labelled");
  assert.match(PAGE_HTML, /\/api\/acknowledge/, "the handler posts to /api/acknowledge");
  // Resolved escalations hide the actions (CSS).
  assert.match(PAGE_HTML, /\.esc\.resolved \.actions \{ display:\s*none/, "resolved escalations hide their action buttons");
});

// --- #180 Criterion 3: Acknowledging never executes any command and never
// mutates the escalations log, git refs, issues, or PRs. ---------------------
await inTempDir(async (dir) => {
  const escPath = join(dir, "esc.md");
  const statePath = join(dir, "s.json");
  const eventsPath = join(dir, "e.jsonl");
  const resolutionsPath = join(dir, "res.jsonl");
  writeFileSync(escPath, escMd([
    {
      ts: "2026-07-09T10:00:00Z", issue: 3, what: "stale claim ref agent/issue-3 on origin: no live worker and no open PR",
      logFile: null, action: "run `gh api -X DELETE repos/o/r/git/refs/heads/agent/issue-3` to delete the stale claim ref",
    },
  ]));
  writeFileSync(statePath, JSON.stringify({ 3: { adapter: null, pid: null, logFile: null, attempts: 0, status: "stale-claim", pr: null } }));
  writeFileSync(eventsPath, "");

  const escBefore = readFileSync(escPath, "utf8");
  const stateBefore = readFileSync(statePath, "utf8");

  // The page's ackEsc handler only uses fetch — no exec, no spawn, no
  // XMLHttpRequest that could trigger a side effect.
  assert.match(PAGE_HTML, /window\.ackEsc/, "the page defines ackEsc");
  const ackFnMatch = /window\.ackEsc = function \(btn\) \{([\s\S]*?)\};\s*\n/.exec(PAGE_HTML);
  assert.ok(ackFnMatch, "ackEsc function body is present");
  assert.doesNotMatch(ackFnMatch[1], /exec|spawn|eval|Function\(/, "ackEsc never executes a command");
  assert.match(ackFnMatch[1], /fetch\("\/api\/acknowledge"/, "ackEsc only posts to the acknowledge endpoint");

  // appendResolution only does appendFileSync — never reads/rewrites the
  // escalations log, never touches git, issues, or PRs.
  assert.doesNotMatch(appendResolution.toString(), /exec|spawn|execSync/, "appendResolution never spawns a process");

  // Acknowledge over HTTP and verify the escalations log and state file are
  // byte-for-byte unchanged.
  await withServer({ statePath, eventsPath, escalationsPath: escPath, resolutionsPath, now: () => NOW }, async (base) => {
    const resp = await postJson(`${base}/api/acknowledge`, { issue: 3, reason: escalationReason("stale claim ref agent/issue-3 on origin: no live worker and no open PR") });
    assert.equal(resp.json.ok, true, "acknowledge succeeded");
  });

  assert.equal(readFileSync(escPath, "utf8"), escBefore, "the escalations log is unchanged after acknowledging");
  assert.equal(readFileSync(statePath, "utf8"), stateBefore, "the state file is unchanged after acknowledging");
  // Only the resolutions file was written.
  assert.ok(existsSync(resolutionsPath), "only the resolutions file was created");
});

// --- #180 Criterion 4: A failed write of the resolution shows the operator a
// visible error on the block; the escalation stays unresolved. ---------------
await inTempDir(async (dir) => {
  const escPath = join(dir, "esc.md");
  const statePath = join(dir, "s.json");
  const eventsPath = join(dir, "e.jsonl");
  // A resolutions path inside a non-existent directory → write fails.
  const resolutionsPath = join(dir, "nodir", "res.jsonl");
  writeFileSync(escPath, escMd([
    { ts: "2026-07-09T10:00:00Z", issue: 11, what: "worker pid 999 is not alive", logFile: null, action: "re-queue" },
  ]));
  writeFileSync(statePath, JSON.stringify({}));
  writeFileSync(eventsPath, "");

  // The page shows a visible error on the block when the write fails.
  assert.match(PAGE_HTML, /esc-error/, "the page has an error class for failed acknowledges");
  assert.match(PAGE_HTML, /Failed to acknowledge/, "the error text names the failure");

  // Over HTTP: the acknowledge endpoint returns a 500 with the error.
  await withServer({ statePath, eventsPath, escalationsPath: escPath, resolutionsPath, now: () => NOW }, async (base) => {
    const resp = await postJson(`${base}/api/acknowledge`, { issue: 11, reason: "worker pid N is not alive" });
    assert.equal(resp.status, 500, "a failed write returns 500");
    assert.equal(resp.json.ok, false, "the response signals failure");
    assert.ok(resp.json.error, "the response carries an error message");
  });

  // The escalation stays unresolved: no resolution file was written.
  assert.ok(!existsSync(resolutionsPath), "no resolution file was written on failure");
  const snap = readSnapshot({ statePath, eventsPath, escalationsPath: escPath, resolutionsPath, config: CONFIG, now: NOW });
  assert.equal(snap.escalations[0].resolved, false, "the escalation stays unresolved after a failed write");
});

// --- #180 Criterion 5: Every criterion above has exactly one test named after
// it. The plan file carried five #180 acceptance criteria; this counts its own
// `#180 Criterion N` markers and proves there is exactly one per criterion,
// 1..5. It counts markers in THIS file only — it never reads the plan file at
// runtime, so archiving the plan when the issue closes can never break it.
{
  const CRITERIA_COUNT = 5;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #180 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #180 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #180 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#180 criterion ${n} has a test`);
}

console.log("PASS herd-ui-acknowledge.test.mjs (5 criteria for #180)");
