#!/usr/bin/env node
// release-pr-gates.test.mjs — behaviour tests for issue #387: the release
// version-bump PR (head `release/vX.Y.Z`) must run a CI check, because pr-gates
// only fires for `agent/issue-*` heads and would otherwise let a malformed bump
// merge unverified (observed on PR #384).
//
// One test per acceptance criterion, exercised through the public interface
// (the workflow YAML as the CI contract, and the version-consistency CLI as a
// subprocess), never against internals:
//   1. `release/*` PRs run a CI check that executes version-consistency and
//      fails on any drift among the known version locations.
//   2. When the check fails, the output names each disagreeing file and the
//      version it carries next to the expected version.
//   3. `agent/issue-*` PRs run exactly the gates they run today, unchanged.
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
const CHECK = fileURLToPath(new URL("./version-consistency.mjs", import.meta.url));

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

// --- Criterion 3: agent/issue-* PRs run exactly today's gates, unchanged -----
{
  // The new workflow never fires on an agent head: no `if:` condition keys off
  // an agent/issue-* head, so it cannot change what an agent PR runs.
  assert.ok(
    ![...jobBlock.matchAll(/^\s*if:.*$/gm)].some((m) => /agent\/issue-/.test(m[0])),
    "no release-check condition keys off an agent/issue-* head",
  );
  // pr-gates.yml still gates both of its jobs on agent/issue-* — untouched by
  // this change, so agent PRs run the same two jobs they run today.
  const agentGuards = [...prGates.matchAll(/if:\s*startsWith\(github\.head_ref,\s*'agent\/issue-'\)/g)];
  assert.equal(agentGuards.length, 2, "pr-gates still gates its gates+size jobs on agent/issue-*");
  assert.ok(
    !/release\//.test(prGates),
    "pr-gates is unchanged — it carries no release/* condition",
  );
}

for (const dir of trees) rmSync(dir, { recursive: true, force: true });
console.log("PASS release-pr-gates.test.mjs (3 criteria)");
