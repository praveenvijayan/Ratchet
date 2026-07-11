#!/usr/bin/env node
// herd-verify.test.mjs — the criteria are the test plan. One test per acceptance
// criterion of issue #107 (verify herd-opened PRs deterministically and route
// conflict rework), driven through herd-verify.mjs's public interface. Offline:
// gh and spawn are injected, so no network and no real worker is launched, and
// every gh call is recorded to prove the verify path never merges/approves/
// closes/labels. Zero dependencies. Run:  node scripts/herd-verify.test.mjs

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyOnce, hasGatesSection } from "./herd-verify.mjs";
import { readState } from "./herd-survey.mjs";

const NOW = Date.UTC(2026, 6, 9, 12, 0, 0);
const noSpawn = (msg) => () => {
  throw new Error(msg);
};
const writeStateFile = (path, state) => writeFileSync(path, JSON.stringify(state) + "\n");

const mkConfig = (over = {}) => ({
  maxWorkers: 3,
  pollSeconds: 60,
  reworkCap: 2,
  logDir: "logs",
  adapters: { claude: { launch: ["claude", "-p", "{prompt}"], resume: ["claude", "--resume", "{issue}", "{prompt}"], promptTemplate: "issue {issue}", env: {} } },
  routing: { default: "claude", labels: {} },
  ...over,
});

// A gh stub that returns one PR-view object for `pr view` and records every call.
const mkGh = (view, calls) => async (args) => {
  calls.push(args);
  if (args[0] === "pr" && args[1] === "view") return view;
  throw new Error(`unexpected gh call: ${args.join(" ")}`);
};

const entry = (over = {}) => ({ adapter: "claude", pid: null, logFile: "logs/issue-7.log", attempts: 1, status: "awaiting-verification", pr: 42, ...over });

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-verify-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    return await fn(dir);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Criterion 1: a conflicting PR triggers exactly one rework dispatch, carrying
// the rework prompt (merge origin/main, resolve, re-run GATES.md gates, push),
// and the attempt is counted toward reworkCap.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 1 }) });
  const spawns = [];
  const spawn = (argv, env, logFile) => {
    spawns.push({ argv, env, logFile });
    return 4321;
  };
  const r = await verifyOnce({
    config: mkConfig(),
    statePath: "s.json",
    escalationsPath: "esc.md",
    gh: mkGh({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", body: "Closes #7\n\n## Gates\n- test: pass" }, []),
    spawn,
    now: () => NOW,
    log: () => {},
  });
  assert.equal(spawns.length, 1, "conflicting PR dispatches exactly one rework");
  const prompt = spawns[0].argv.join(" ");
  assert.match(prompt, /origin\/main/, "rework prompt says merge origin/main");
  assert.match(prompt, /GATES\.md/, "rework prompt says re-run GATES.md gates");
  assert.match(prompt, /push/, "rework prompt says push");
  assert.match(prompt, /#42/, "rework prompt names the PR");
  const s = readState("s.json")["7"];
  assert.equal(s.attempts, 2, "the rework is counted toward reworkCap (attempts bumped)");
  assert.equal(s.status, "reworking");
  assert.equal(s.pid, 4321);
  assert.equal(r.transitions[0].action, "rework");
});

// Criterion 2: a PR still conflicting once attempts have reached reworkCap is
// escalated instead of re-dispatched.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 2 }) });
  const r = await verifyOnce({
    config: mkConfig({ reworkCap: 2 }),
    statePath: "s.json",
    escalationsPath: "esc.md",
    gh: mkGh({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", body: "Closes #7\n\n## Gates" }, []),
    spawn: noSpawn("must not dispatch a rework at reworkCap"),
    now: () => NOW,
    log: () => {},
  });
  const s = readState("s.json")["7"];
  assert.equal(s.status, "verify-escalated", "capped conflict is escalated, not reworked");
  assert.equal(s.pid, null);
  const esc = readFileSync("esc.md", "utf8");
  assert.match(esc, /still conflicts/);
  assert.match(esc, /reworkCap 2 reached/);
  assert.equal(r.transitions[0].action, "escalate-conflict-capped");
});

// Criterion 3: a PR body missing `Closes #<N>` or a gates section is escalated
// on text checks alone — no rework dispatch, no content judgment.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry() });
  const r = await verifyOnce({
    config: mkConfig(),
    statePath: "s.json",
    escalationsPath: "esc.md",
    gh: mkGh({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", body: "A summary with no closing keyword and no gate checklist." }, []),
    spawn: noSpawn("must not dispatch on a body text failure"),
    now: () => NOW,
    log: () => {},
  });
  const s = readState("s.json")["7"];
  assert.equal(s.status, "verify-escalated");
  const esc = readFileSync("esc.md", "utf8");
  assert.match(esc, /Closes #7/, "escalation names the missing Closes reference");
  assert.match(esc, /gates section/, "escalation names the missing gates section");
  assert.equal(r.transitions[0].action, "escalate-body");
});

// hasGatesSection accepts a heading, a bold label, or a bare label line —
// AGENTS.md demands "the gate checklist" without mandating markdown, and a
// plain "Gates" line (PR #207 regression) must not escalate. A mention of the
// word inside a sentence is still not a section.
{
  assert.ok(hasGatesSection("Closes #7\n\n## Gates\n- test: pass"), "markdown heading");
  assert.ok(hasGatesSection("Closes #7\n\n**Gates**\n- test: pass"), "bold label");
  assert.ok(hasGatesSection("Closes #7\n\nSummary\n- x\n\nGates\n- [x] test"), "bare label line");
  assert.ok(hasGatesSection("Closes #7\n\nGate results:\n- test: pass"), "bare label with results and colon");
  assert.ok(!hasGatesSection("Re-run the gates before pushing."), "sentence mention is not a section");
  assert.ok(!hasGatesSection("gates are green today\n- x"), "label line with trailing words is not a section");
}

// Criterion 4: a PR passing every deterministic check produces an escalation
// entry telling the human "PR #X ready for review".
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ pr: 100 }) });
  const r = await verifyOnce({
    config: mkConfig(),
    statePath: "s.json",
    escalationsPath: "esc.md",
    gh: mkGh({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", body: "Closes #7\n\nSummary.\n\n## Gates\n- test: pass" }, []),
    spawn: noSpawn("a clean PR is never dispatched"),
    now: () => NOW,
    log: () => {},
  });
  const s = readState("s.json")["7"];
  assert.equal(s.status, "ready-for-review");
  const esc = readFileSync("esc.md", "utf8");
  assert.match(esc, /PR #100 ready for review/);
  assert.equal(r.transitions[0].action, "escalate-ready");
});

// Criterion 5: no verify path ever merges, approves, closes, or labels — the
// only gh command the stage issues is the read-only `pr view`.
await inTempDir(async () => {
  const forbidden = ["merge", "close", "edit", "review", "--approve", "ready"];
  const views = {
    conflict: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", body: "Closes #7\n\n## Gates" },
    body: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", body: "no closes, no gates" },
    ready: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", body: "Closes #7\n\n## Gates" },
  };
  for (const view of Object.values(views)) {
    writeStateFile("s.json", { 7: entry() });
    const calls = [];
    await verifyOnce({
      config: mkConfig(),
      statePath: "s.json",
      escalationsPath: "esc.md",
      gh: mkGh(view, calls),
      spawn: () => 999, // rework path is allowed to spawn a worker, not to call gh
      now: () => NOW,
      log: () => {},
    });
    for (const call of calls) {
      assert.deepEqual(call.slice(0, 2), ["pr", "view"], `verify only reads via 'gh pr view', saw: ${call.join(" ")}`);
      for (const bad of forbidden) assert.ok(!call.includes(bad), `verify must never call gh with '${bad}'`);
    }
  }
  assert.ok(!existsSync("merged"), "sanity: no merge side effect");
});

console.log("herd-verify.test.mjs: all criteria passed");
