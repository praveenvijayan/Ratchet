#!/usr/bin/env node
// ratchet-watch.mjs — minimal, zero-dependency receiver for `gh webhook forward`.
// Classifies PR / review / comment events on agent branches into a Ratchet
// action and signals it locally. Optionally runs $RATCHET_ON_EVENT (e.g. a
// headless agent command) on actionable events. Node 20+.
//
// Started for you by scripts/ratchet-watch.sh — you normally don't run it directly.

import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const port = Number(process.argv[2] || process.env.RATCHET_PORT || 8765);
const branchPrefix = process.env.RATCHET_BRANCH_PREFIX || "agent/issue-";
const onEvent = process.env.RATCHET_ON_EVENT; // optional command for actionable events
mkdirSync(".ratchet", { recursive: true });

// Only react to PRs from agent branches.
const isAgentPR = (pr) => pr && typeof pr.head?.ref === "string" && pr.head.ref.startsWith(branchPrefix);

function classify(event, body) {
  if (event === "pull_request" && body.action === "closed" && isAgentPR(body.pull_request)) {
    const pr = body.pull_request;
    return pr.merged
      ? { action: "advance", pr: pr.number, summary: `PR #${pr.number} MERGED` }
      : { action: "rework",  pr: pr.number, summary: `PR #${pr.number} CLOSED without merge` };
  }
  if (event === "pull_request_review" && body.action === "submitted" && isAgentPR(body.pull_request)) {
    const st = body.review?.state;
    if (st === "changes_requested") return { action: "rework", pr: body.pull_request.number, summary: `PR #${body.pull_request.number} CHANGES REQUESTED` };
    if (st === "approved")          return { action: "note",   pr: body.pull_request.number, summary: `PR #${body.pull_request.number} APPROVED (awaiting merge)` };
  }
  if (event === "pull_request_review_comment" && body.action === "created" && isAgentPR(body.pull_request)) {
    return { action: "rework", pr: body.pull_request.number, summary: `New review comment on PR #${body.pull_request.number}` };
  }
  return null;
}

createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(200); return res.end("ok"); }
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    res.writeHead(200); res.end("ok");
    let body; try { body = JSON.parse(data); } catch { return; }
    const c = classify(req.headers["x-github-event"], body);
    if (!c) return;
    console.log(`\n[ratchet] ${c.summary}  →  run /ratchet-next  (${c.action})`);
    writeFileSync(".ratchet/last-event.json", JSON.stringify({ ...c, at: new Date().toISOString() }, null, 2));
    if (onEvent && c.action !== "note") {
      try { execSync(onEvent, { stdio: "inherit" }); }
      catch (e) { console.error("[ratchet] RATCHET_ON_EVENT failed:", e.message); }
    }
  });
}).listen(port, () => console.log(`[ratchet] receiver listening on http://localhost:${port}/webhook`));
