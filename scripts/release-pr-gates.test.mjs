#!/usr/bin/env node
// release-pr-gates.test.mjs — behaviour tests for issue #387: the release
// version-bump PR (head `release/vX.Y.Z`) must run a CI check, because pr-gates
// carries no notion of version-string agreement and would otherwise let a
// malformed bump merge unverified (observed on PR #384).
//
// One test per acceptance criterion, exercised through the public interface
// (the workflow YAML as the CI contract, and the version-consistency CLI as a
// subprocess), never against internals:
//   1. `release/*` PRs run a CI check that executes version-consistency and
//      fails on any drift among the known version locations.
//   2. When the check fails, the output names each disagreeing file and the
//      version it carries next to the expected version.
//   3. `agent/issue-*` PRs still run the same gates+size jobs pr-gates always
//      ran for them.
//
// Also carries the issue #479 criteria for pr-gates.yml itself (no
// branch/path carve-out anywhere in that workflow):
//   4. The `gates` and `size` jobs trigger on every PR to main, regardless of
//      head-branch name, and still run the exact same commands they always
//      did — the only change is which PRs reach them, so a passing PR merges
//      exactly as it did before.
//   5. The docs no longer describe a failing gate as advisory, and name the
//      hotfix/revert lane as the sanctioned alternative to bypassing one.
//
// Zero dependencies. Run:  node scripts/release-pr-gates.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(
  fileURLToPath(new URL("../.github/workflows/release-pr-gates.yml", import.meta.url)),
  "utf8",
);
const prGates = readFileSync(
  fileURLToPath(new URL("../.github/workflows/pr-gates.yml", import.meta.url)),
  "utf8",
);
const docs = readFileSync(fileURLToPath(new URL("../DOCS.md", import.meta.url)), "utf8");
const gatesConfig = readFileSync(fileURLToPath(new URL("../GATES.md", import.meta.url)), "utf8");
const CHECK = fileURLToPath(new URL("./version-consistency.mjs", import.meta.url));

// Isolate a top-level job block in pr-gates.yml by name, so assertions about
// its trigger condition and steps can't be satisfied by text elsewhere in the
// file (e.g. another job's `if:` line, or a comment).
function prGatesJob(name) {
  // Only lines indented 3+ spaces (the job's own body) or blank belong to this
  // job; a sibling job key sits back at 2 spaces and ends the capture.
  return prGates.match(new RegExp(`\\n {2}${name}:\\n((?: {3,}\\S.*\\n|\\n)+)`))?.[1] ?? "";
}

// Write a fixture tree with the five version locations; `plugin` may drift from
// the rest to exercise the disagreement report.
function makeTree({ base, plugin }) {
  const dir = mkdtempSync(join(tmpdir(), "release-pr-gates-"));
  writeFileSync(join(dir, ".ratchet-version"), `${base}\n`);
  mkdirSync(join(dir, "plugin", ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(dir, "plugin", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "ratchet", version: plugin ?? base }, null, 2) + "\n",
  );
  writeFileSync(
    join(dir, "README.md"),
    `# Ratchet\n\n![framework version](https://img.shields.io/badge/framework-v${base}-ea8f3c?style=for-the-badge)\n`,
  );
  writeFileSync(join(dir, "DOCS.md"), `# Ratchet — Docs\n\nVersion ${base} · MIT\n`);
  writeFileSync(join(dir, "index.html"), `<main><p class="eyebrow">v${base}</p></main>\n`);
  return dir;
}

function runCheck(root) {
  const res = spawnSync(process.execPath, [CHECK], {
    env: { ...process.env, VERSION_ROOT: root },
    encoding: "utf8",
  });
  return { status: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}

// Isolate the job that guards release PRs, so assertions about its trigger
// condition and command can't be satisfied by text elsewhere in the file.
const jobBlock = workflow.match(/\n {2}version-consistency:\n((?:[ \t]+\S[^\n]*\n|\n)+)/)?.[1] ?? "";

const trees = [];

// --- Criterion 1: release/* PRs run a CI check that runs version-consistency
// and fails on any drift -----------------------------------------------------
{
  // The workflow is a pull_request check.
  assert.ok(/\non:\n\s+pull_request:/.test(workflow), "the check runs on pull_request events");
  // Its job fires only for release/* heads.
  assert.ok(
    /if:\s*startsWith\(github\.head_ref,\s*'release\/'\)/.test(jobBlock),
    "the job is gated on a release/* head",
  );
  // And it executes the shared version-consistency check.
  assert.ok(
    /run:\s*node scripts\/version-consistency\.mjs/.test(jobBlock),
    "the job runs `node scripts/version-consistency.mjs`",
  );
  // The check it runs actually fails on drift among the known locations.
  const drift = makeTree({ base: "5.0.0", plugin: "4.9.0" });
  trees.push(drift);
  assert.notEqual(runCheck(drift).status, 0, "the check exits non-zero when a version location drifts");
  // ...and stays green when every location agrees.
  const agree = makeTree({ base: "5.0.0" });
  trees.push(agree);
  assert.equal(runCheck(agree).status, 0, "the check exits 0 when every version location agrees");
}

// --- Criterion 2: on failure, names each disagreeing file and its version
// next to the expected version ------------------------------------------------
{
  const drift = makeTree({ base: "5.0.0", plugin: "4.9.0" });
  trees.push(drift);
  const red = runCheck(drift);
  assert.notEqual(red.status, 0, "a drifted tree fails");
  assert.ok(red.out.includes("plugin/.claude-plugin/plugin.json"), "names the disagreeing file");
  assert.ok(red.out.includes("4.9.0"), "prints the version the disagreeing file carries");
  assert.ok(/expected 5\.0\.0/.test(red.out), "prints the expected version next to the drift");
  assert.ok(!/\n\s+at\s+/.test(red.out), "a clear message, never a stack trace");
}

// --- Criterion 3: agent/issue-* PRs still run the same gates+size jobs -----
{
  // The new workflow never fires on an agent head: no `if:` condition keys off
  // an agent/issue-* head, so it cannot change what an agent PR runs.
  assert.ok(
    ![...jobBlock.matchAll(/^\s*if:.*$/gm)].some((m) => /agent\/issue-/.test(m[0])),
    "no release-check condition keys off an agent/issue-* head",
  );
  // pr-gates.yml still defines both jobs and still runs the same commands —
  // an agent/issue-* PR still gets exactly the checks it always got.
  const gatesJob = prGatesJob("gates");
  const sizeJob = prGatesJob("size");
  assert.ok(/run:\s*node scripts\/run-gates\.mjs/.test(gatesJob), "the gates job still runs run-gates.mjs");
  assert.ok(/run:\s*node scripts\/pr-size-check\.mjs/.test(sizeJob), "the size job still runs pr-size-check.mjs");
  assert.ok(
    !/release\//.test(prGates),
    "pr-gates carries no release/* condition",
  );
}

// --- Criterion 4 (#479): gates/size trigger on every PR to main, no carve-out,
// same commands as before (so a passing PR merges exactly as it did) --------
{
  const gatesJob = prGatesJob("gates");
  const sizeJob = prGatesJob("size");
  assert.ok(gatesJob && sizeJob, "pr-gates.yml still defines both the gates and size jobs");
  // No branch-name or path condition gates either job anymore.
  assert.ok(!/^\s*if:/m.test(gatesJob), "the gates job carries no `if:` condition");
  assert.ok(!/^\s*if:/m.test(sizeJob), "the size job carries no `if:` condition");
  assert.ok(!/agent\/issue-/.test(gatesJob), "the gates job no longer keys off an agent/issue-* head");
  assert.ok(!/agent\/issue-/.test(sizeJob), "the size job no longer keys off an agent/issue-* head");
  // The workflow fires on every opened/synchronize/reopened PR, with no base
  // branch restriction, so a PR targeting main is always in scope.
  assert.ok(
    /\non:\n\s+pull_request:\n\s+types:\s*\[opened,\s*synchronize,\s*reopened\]/.test(prGates),
    "pr-gates fires on every opened/synchronize/reopened pull_request",
  );
  // Regression: everything else about the two jobs — checkout, node setup, the
  // base-branch GATES.md extraction, and the exact commands — is untouched, so
  // a PR whose gates all pass merges exactly as it did before this change.
  assert.ok(
    /uses:\s*actions\/checkout@/.test(gatesJob) && /uses:\s*actions\/setup-node@/.test(gatesJob),
    "the gates job still checks out the PR and sets up node as before",
  );
  assert.ok(
    /BASE_GATES_FILE:\s*\$\{\{\s*steps\.base_gates\.outputs\.file\s*\}\}/.test(gatesJob) &&
      /BASE_GATES_FILE:\s*\$\{\{\s*steps\.base_gates\.outputs\.file\s*\}\}/.test(sizeJob),
    "both jobs still judge the PR by the base branch's GATES.md, unchanged",
  );
}

// --- Criterion 5 (#479): docs no longer call a failing gate advisory, and name
// the hotfix/revert lane as the sanctioned alternative to bypassing one -----
{
  assert.ok(!/advisory/i.test(docs), "DOCS.md no longer describes any gate as advisory");
  assert.ok(!/advisory/i.test(gatesConfig), "GATES.md no longer describes any gate as advisory");
  assert.ok(
    !/on every `agent\/issue-\*` PR/.test(docs) && !/on agent PRs/.test(docs),
    "DOCS.md no longer scopes pr-gates' checks to agent PRs only",
  );
  const hotfixMentions = [...docs.matchAll(/ratchet-hotfix/g)].map((m) => m.index);
  assert.ok(
    hotfixMentions.some((i) => /pr-gates/.test(docs.slice(Math.max(0, i - 800), i + 200))),
    "DOCS.md names the hotfix/revert lane near its pr-gates discussion, as the sanctioned alternative to bypassing a red check",
  );
}

for (const dir of trees) rmSync(dir, { recursive: true, force: true });
console.log("PASS release-pr-gates.test.mjs (5 criteria)");
