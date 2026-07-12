#!/usr/bin/env node
// herd-ui-escalation.test.mjs — the acceptance criteria of issue #172 are the
// test plan: exactly one test per criterion of escalation deduplication and
// auto-resolution in the herd dashboard, driven through herd-ui.mjs's public
// interface. Offline: fixtures in temp dirs, mock title caches. Zero deps. Run:
//   node scripts/herd-ui-escalation.test.mjs

import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PAGE_HTML,
  escalationReason,
  dedupEscalations,
  resolveEscalations,
  limitEscalations,
  MAX_RESOLVED_SHOWN,
  parseEscalations,
  readSnapshot,
  createTitleCache,
  createDashboardServer,
  listenOrFail,
} from "./herd-ui.mjs";

const CONFIG = { reworkCap: 2, claimTimeoutSeconds: 300 };
const NOW = Date.UTC(2026, 6, 9, 12, 0, 0);

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-esc-"));
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

// --- #172 Criterion 1: Escalations with the same issue and same reason render
// as one block showing an occurrence count and the latest timestamp. --------
await inTempDir(async (dir) => {
  const escPath = join(dir, "esc.md");
  writeFileSync(escPath, escMd([
    { ts: "2026-07-09T10:00:00Z", issue: 5, what: "worker pid 111 is not alive", logFile: null, action: "re-queue" },
    { ts: "2026-07-09T11:00:00Z", issue: 5, what: "worker pid 222 is not alive", logFile: null, action: "re-queue" },
    { ts: "2026-07-09T11:30:00Z", issue: 7, what: "worker pid 333 is not alive", logFile: null, action: "re-queue" },
  ]));

  // escalationReason normalises variable parts so the same root cause maps to
  // one reason string regardless of the pid.
  assert.equal(
    escalationReason("worker pid 111 is not alive"),
    escalationReason("worker pid 222 is not alive"),
    "two 'worker pid N is not alive' escalations share the same reason",
  );
  assert.notEqual(
    escalationReason("worker pid 111 is not alive"),
    escalationReason("tracked PR #42 is no longer open (merged or closed)"),
    "different root causes map to different reasons",
  );

  // dedupEscalations groups by (issue, reason) and counts occurrences.
  const parsed = parseEscalations(escPath);
  const deduped = dedupEscalations(parsed);
  assert.equal(deduped.length, 2, "three escalations across two issue+reason pairs dedup to two blocks");
  const e5 = deduped.find((e) => e.issue === 5);
  const e7 = deduped.find((e) => e.issue === 7);
  assert.equal(e5.occurrences, 2, "issue #5 has two occurrences of the same reason");
  assert.equal(e7.occurrences, 1, "issue #7 has one occurrence");
  // The latest (newest-first input) block's ts is kept as the display ts.
  assert.equal(e5.ts, "2026-07-09T11:00:00Z", "the deduped block shows the latest timestamp");

  // The page renders the occurrence count.
  assert.match(PAGE_HTML, /occurrences/, "the page renders an occurrence count badge");
  assert.match(PAGE_HTML, /e\.occurrences/, "the page reads the occurrences field from the escalation");

  // Over HTTP: the snapshot carries deduped escalations with occurrence counts.
  await withServer({ statePath: join(dir, "s.json"), eventsPath: join(dir, "e.jsonl"), escalationsPath: escPath }, async (base) => {
    const { json } = await fetchJson(`${base}/api/snapshot`);
    const j5 = json.escalations.find((e) => e.issue === 5);
    assert.equal(j5.occurrences, 2, "the snapshot carries the deduped occurrence count over HTTP");
  });
});

// --- #172 Criterion 2: A stale-claim escalation whose ref no longer exists on
// origin, and a PR-concluded escalation whose issue has since closed, render as
// resolved (visually de-emphasised), not as open alerts. -------------------
await inTempDir(async (dir) => {
  const escPath = join(dir, "esc.md");
  const statePath = join(dir, "s.json");
  writeFileSync(escPath, escMd([
    { ts: "2026-07-09T10:00:00Z", issue: 3, what: "stale claim ref agent/issue-3 on origin: no live worker and no open PR, yet the ref still holds the claim. Delete it to free the issue: git push origin :agent/issue-3", logFile: null, action: "delete the ref" },
    { ts: "2026-07-09T10:30:00Z", issue: 4, what: "tracked PR #44 is no longer open (merged or closed)", logFile: null, action: "re-queue if unfinished" },
  ]));

  // Stale-claim: the ref is gone (no sentinel in state) → resolved.
  writeFileSync(statePath, JSON.stringify({})); // no stale-claim sentinel for issue #3
  const parsed = parseEscalations(escPath);
  const deduped = dedupEscalations(parsed);
  const resolved = resolveEscalations(deduped, { state: {}, closedIssues: new Set([4]) });
  const e3 = resolved.find((e) => e.issue === 3);
  const e4 = resolved.find((e) => e.issue === 4);
  assert.equal(e3.resolved, true, "stale-claim escalation with no sentinel in state is resolved");
  assert.equal(e4.resolved, true, "PR-concluded escalation whose issue is closed is resolved");

  // Stale-claim: the sentinel IS in state (ref still exists) → unresolved.
  writeFileSync(statePath, JSON.stringify({ 3: { adapter: null, pid: null, logFile: null, attempts: 0, status: "stale-claim", pr: null } }));
  const stateWithSentinel = JSON.parse(readFileSync(statePath, "utf8"));
  const unresolved = resolveEscalations(deduped, { state: stateWithSentinel, closedIssues: new Set() });
  const u3 = unresolved.find((e) => e.issue === 3);
  assert.equal(u3.resolved, false, "stale-claim escalation with an active sentinel is not resolved");

  // PR-concluded: the issue is still OPEN → unresolved.
  const u4 = resolveEscalations(deduped, { state: {}, closedIssues: new Set() });
  assert.equal(u4.find((e) => e.issue === 4).resolved, false, "PR-concluded escalation with an open issue is not resolved");

  // The page visually de-emphasises resolved escalations.
  assert.match(PAGE_HTML, /esc resolved/, "the page has a resolved CSS class for de-emphasised escalations");
  assert.match(PAGE_HTML, /opacity:\s*0\.6/, "resolved escalations are visually de-emphasised (reduced opacity)");

  // Over HTTP: the snapshot carries the resolved flag.
  const cache = createTitleCache({ fetchTitle: (issue) => ({ title: `T${issue}`, state: issue === 4 ? "CLOSED" : "OPEN" }) });
  writeFileSync(statePath, JSON.stringify({})); // no sentinel
  // First poll triggers the async title/state fetch.
  readSnapshot({ statePath, eventsPath: join(dir, "e.jsonl"), escalationsPath: escPath, config: CONFIG, now: NOW, titleCache: cache });
  await new Promise((r) => setTimeout(r, 50));
  // Second poll: the fetch has resolved and the cache carries the issue state.
  const snap = readSnapshot({ statePath, eventsPath: join(dir, "e.jsonl"), escalationsPath: escPath, config: CONFIG, now: NOW, titleCache: cache });
  const s3 = snap.escalations.find((e) => e.issue === 3);
  const s4 = snap.escalations.find((e) => e.issue === 4);
  assert.equal(s3.resolved, true, "snapshot marks the stale-claim escalation as resolved (no sentinel in state)");
  assert.equal(s4.resolved, true, "snapshot marks the PR-concluded escalation as resolved (issue is closed)");
});

// --- #172 Criterion 3: The open-escalation count shown to the operator counts
// only unresolved escalations. -----------------------------------------------
await inTempDir(async (dir) => {
  const escPath = join(dir, "esc.md");
  const statePath = join(dir, "s.json");
  writeFileSync(escPath, escMd([
    { ts: "2026-07-09T10:00:00Z", issue: 3, what: "stale claim ref agent/issue-3 on origin: no live worker. Delete it: git push origin :agent/issue-3", logFile: null, action: "delete" },
    { ts: "2026-07-09T10:30:00Z", issue: 4, what: "worker pid 444 is not alive", logFile: null, action: "re-queue" },
  ]));
  // No sentinel for #3 (resolved); #4 is a worker death (always unresolved).
  writeFileSync(statePath, JSON.stringify({}));

  const cache = createTitleCache({ fetchTitle: () => ({ title: "T", state: "OPEN" }) });
  const snap = readSnapshot({ statePath, eventsPath: join(dir, "e.jsonl"), escalationsPath: escPath, config: CONFIG, now: NOW, titleCache: cache });
  const unresolvedCount = snap.escalations.filter((e) => !e.resolved).length;
  const totalCount = snap.escalations.length;
  assert.equal(totalCount, 2, "two escalations in the snapshot (one resolved + one unresolved)");
  assert.equal(unresolvedCount, 1, "only the unresolved escalation counts toward the open-escalation count");

  // The page's renderErrToggle counts only unresolved.
  assert.match(PAGE_HTML, /\.filter\(\(e\)\s*=>\s*!e\.resolved\)/, "the badge count filters to unresolved escalations only");
});

// --- #172 Criterion 4: The dashboard renders all unresolved escalations plus
// at most a fixed number of the most recent resolved ones, never the unbounded
// full history. --------------------------------------------------------------
await inTempDir(async (dir) => {
  const escPath = join(dir, "esc.md");
  const statePath = join(dir, "s.json");
  // Create 8 resolved escalations (stale-claims with no sentinel) + 2
  // unresolved (worker deaths). The dashboard must show all 2 unresolved + at
  // most MAX_RESOLVED_SHOWN of the 8 resolved.
  const blocks = [];
  for (let i = 1; i <= 8; i++) {
    blocks.push({ ts: `2026-07-09T0${i}:00:00Z`, issue: 100 + i, what: `stale claim ref agent/issue-${100 + i} on origin. Delete it: git push origin :agent/issue-${100 + i}`, logFile: null, action: "delete" });
  }
  blocks.push({ ts: "2026-07-09T09:00:00Z", issue: 200, what: "worker pid 999 is not alive", logFile: null, action: "re-queue" });
  blocks.push({ ts: "2026-07-09T09:30:00Z", issue: 201, what: "worker pid 888 is not alive", logFile: null, action: "re-queue" });
  writeFileSync(escPath, escMd(blocks));
  writeFileSync(statePath, JSON.stringify({})); // no sentinels → all stale-claims resolved

  const cache = createTitleCache({ fetchTitle: () => ({ title: "T", state: "OPEN" }) });
  const snap = readSnapshot({ statePath, eventsPath: join(dir, "e.jsonl"), escalationsPath: escPath, config: CONFIG, now: NOW, titleCache: cache });
  const unresolved = snap.escalations.filter((e) => !e.resolved);
  const resolved = snap.escalations.filter((e) => e.resolved);
  assert.equal(unresolved.length, 2, "all unresolved escalations are shown");
  assert.equal(resolved.length, MAX_RESOLVED_SHOWN, `at most ${MAX_RESOLVED_SHOWN} resolved escalations are shown`);
  assert.ok(snap.escalations.length < blocks.length, "the unbounded full history is never rendered");

  // limitEscalations as a pure function: keeps all unresolved + caps resolved.
  const limited = limitEscalations(
    Array.from({ length: 10 }, (_, i) => ({ issue: i, resolved: true })),
    3,
  );
  assert.equal(limited.length, 3, "limitEscalations caps resolved blocks at the given maximum");
  const mixed = limitEscalations([
    { issue: 1, resolved: false },
    { issue: 2, resolved: true },
    { issue: 3, resolved: false },
    { issue: 4, resolved: true },
    { issue: 5, resolved: true },
    { issue: 6, resolved: true },
  ], 2);
  assert.equal(mixed.filter((e) => !e.resolved).length, 2, "all unresolved are kept");
  assert.equal(mixed.filter((e) => e.resolved).length, 2, "at most N resolved are kept");
});

// --- #172 Criterion 5: Every criterion above has exactly one test named after
// it. The plan file carried five #172 acceptance criteria; this counts its own
// `#172 Criterion N` markers and proves there is exactly one per criterion,
// 1..5. It counts markers in THIS file only — it never reads the plan file at
// runtime, so archiving the plan when the issue closes can never break it.
{
  const CRITERIA_COUNT = 5;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #172 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #172 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #172 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#172 criterion ${n} has a test`);
}

// --- #319 criterion 9: superseded escalations — an unresolved group
// auto-resolves when its issue moved on after the group's newest occurrence
// (a newer escalation with a different reason, a newer dispatch/resume, or the
// issue closing). A recurring problem keeps re-appending, stays the newest
// group, and is never superseded. ---
{
  const blocks = dedupEscalations(parseEscalations(escMd([
    // issue 7: old concern, then a newer different concern → old one superseded.
    { ts: "2026-07-09T10:00:00Z", issue: 7, what: "worker exited 0 without opening a PR", logFile: null, action: "inspect" },
    { ts: "2026-07-09T11:00:00Z", issue: 7, what: "PR #70 body is missing a gates section", logFile: null, action: "add gates" },
    // issue 8: one concern, then the supervisor re-dispatched → superseded.
    { ts: "2026-07-09T10:00:00Z", issue: 8, what: "worker pid 11 is not alive", logFile: null, action: "re-queue" },
    // issue 9: recurring concern (newest group for its issue) → stays unresolved.
    { ts: "2026-07-09T10:00:00Z", issue: 9, what: "worker pid 22 is not alive", logFile: null, action: "re-queue" },
    { ts: "2026-07-09T11:30:00Z", issue: 9, what: "worker pid 23 is not alive", logFile: null, action: "re-queue" },
    // issue 10: any concern on a closed issue → resolved.
    { ts: "2026-07-09T10:00:00Z", issue: 10, what: "worker exited 0 without opening a PR", logFile: null, action: "inspect" },
  ]), { isPath: false }));
  const events = [{ ts: "2026-07-09T11:00:00Z", event: "dispatch", issue: 8 }];
  const marked = resolveEscalations(blocks, { state: {}, closedIssues: new Set([10]), events });
  const by = (issue, re) => marked.find((b) => b.issue === issue && re.test(b.what));
  assert.equal(by(7, /without opening a PR/).resolved, true, "older concern is superseded by a newer different concern");
  assert.equal(by(7, /gates section/).resolved, false, "the newest concern for an issue stays unresolved");
  assert.equal(by(8, /not alive/).resolved, true, "a concern is superseded by a later dispatch of the issue");
  assert.equal(by(9, /not alive/).resolved, false, "a recurring concern (newest occurrence wins the group ts) is never superseded");
  assert.equal(by(9, /not alive/).occurrences, 2, "recurrences stay one group");
  assert.equal(by(10, /without opening a PR/).resolved, true, "any concern on a closed issue is resolved");
}

console.log("PASS herd-ui-escalation.test.mjs (5 criteria for #172 + superseded rules)");
