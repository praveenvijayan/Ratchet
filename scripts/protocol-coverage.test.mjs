#!/usr/bin/env node
// protocol-coverage.test.mjs — behaviour tests for issue #340: a structural gate
// that fails when the AGENTS.md kernel and its deferred artifacts disagree.
// Zero dependencies. Run: node scripts/protocol-coverage.test.mjs
//
// One test per acceptance criterion, exercised through the public interface (the
// exported guard functions and the CLI as a subprocess against a temp kernel +
// temp repo root), never against parser internals:
//   1. A routing-table entry pointing at a missing file fails, naming the path.
//   2. A missing required `<!-- ratchet:invariant:<id> -->` marker fails.
//   3. A `scripts/ratchet-*.mjs` command with no script file fails.
//   4. The guard exits zero against the current repository.
//   5. The gate is registered in GATES.md and gates-coverage passes.
//   6. Every criterion above is covered by exactly one test named after it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { missingRoutedFiles, missingInvariants, missingScripts } from "./protocol-coverage.mjs";

// fileURLToPath (not url.pathname) so a repo path containing spaces resolves to a
// real filename rather than a percent-encoded one node cannot open.
const GUARD = fileURLToPath(new URL("./protocol-coverage.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const realAgents = join(repoRoot, "AGENTS.md");
const gatesFile = join(repoRoot, "GATES.md");

const INVARIANTS = [
  "no-issue-no-edits", "plan-source", "claim-ref", "criteria-only",
  "never-red-pr", "one-pr", "never-merge", "labelled-exit", "error-paths",
];

// Build a well-formed kernel that passes the gate, so each test can break
// exactly one thing. Params let a test omit an invariant, route to a bad file,
// or name a missing script.
function kernel({ routedFiles = ["DOCS.md"], invariants = INVARIANTS, scripts = ["scripts/ratchet-start.mjs"] } = {}) {
  const rows = routedFiles.map((f) => `| Some concern | \`${f}\` |`).join("\n");
  const markers = invariants.map((id, i) => `${i}. <!-- ratchet:invariant:${id} --> rule ${id}.`).join("\n");
  const scriptLines = scripts.map((s) => `- Claim — \`node ${s} --issue <N>\``).join("\n");
  return [
    "# AGENTS.md — kernel",
    "",
    "## Routing table",
    "| Concern | Read this file |",
    "|---|---|",
    rows,
    "",
    "## Deterministic commands",
    scriptLines,
    "",
    "## Hard rules",
    markers,
    "",
  ].join("\n");
}

// Materialise a temp repo root containing the kernel plus the given real files
// (routed targets and script files), so the CLI resolves paths on disk.
function fixture({ agentsText, presentFiles = [] }) {
  const root = mkdtempSync(join(tmpdir(), "protocol-coverage-"));
  writeFileSync(join(root, "AGENTS.md"), agentsText);
  for (const rel of presentFiles) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "");
  }
  return root;
}

function runGuard(root) {
  const res = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, AGENTS_FILE: join(root, "AGENTS.md"), REPO_ROOT: root },
  });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

// --- Criterion 1: a routing-table entry pointing at a missing file fails, ----
//     naming the offending path.
{
  const agentsText = kernel({ routedFiles: ["DOCS.md", "memory/GONE.md"] });
  // Only DOCS.md exists; the routed memory/GONE.md is absent.
  const root = fixture({ agentsText, presentFiles: ["DOCS.md", "scripts/ratchet-start.mjs"] });

  assert.deepEqual(
    missingRoutedFiles(agentsText, root),
    ["memory/GONE.md"],
    "the guard flags exactly the routed file that does not exist",
  );
  const { status, out } = runGuard(root);
  assert.notEqual(status, 0, "the CLI exits non-zero when a routed file is missing");
  assert.ok(out.includes("memory/GONE.md"), `the failure names the offending path (out: ${out})`);
}

// --- Criterion 2: a missing required invariant marker fails ------------------
{
  const without = INVARIANTS.filter((id) => id !== "never-merge");
  const agentsText = kernel({ invariants: without });
  const root = fixture({ agentsText, presentFiles: ["DOCS.md", "scripts/ratchet-start.mjs"] });

  assert.deepEqual(
    missingInvariants(agentsText),
    ["never-merge"],
    "the guard reports the required invariant id whose marker is absent",
  );
  const { status, out } = runGuard(root);
  assert.notEqual(status, 0, "the CLI exits non-zero when a required invariant marker is missing");
  assert.ok(out.includes("never-merge"), `the failure names the missing invariant id (out: ${out})`);
}

// --- Criterion 3: a `scripts/ratchet-*.mjs` command with no file fails -------
{
  const agentsText = kernel({ scripts: ["scripts/ratchet-start.mjs", "scripts/ratchet-ghost.mjs"] });
  // ratchet-ghost.mjs is named in the kernel but never created on disk.
  const root = fixture({ agentsText, presentFiles: ["DOCS.md", "scripts/ratchet-start.mjs"] });

  assert.deepEqual(
    missingScripts(agentsText, root),
    ["scripts/ratchet-ghost.mjs"],
    "the guard reports the named ratchet script that has no file",
  );
  const { status, out } = runGuard(root);
  assert.notEqual(status, 0, "the CLI exits non-zero when a named ratchet script is missing");
  assert.ok(out.includes("scripts/ratchet-ghost.mjs"), `the failure names the missing script (out: ${out})`);
}

// --- Criterion 4: the guard exits zero against the current repository --------
{
  const res = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, AGENTS_FILE: realAgents, REPO_ROOT: repoRoot },
  });
  const out = (res.stdout || "") + (res.stderr || "");
  assert.equal(res.status, 0, `the guard must pass against this repo's AGENTS.md (out: ${out})`);
  assert.ok(/protocol coverage OK/i.test(out), "the guard reports the coverage it verified");
}

// --- Criterion 5: the gate is registered in GATES.md and gates-coverage passes
{
  const gates = readFileSync(gatesFile, "utf8");
  assert.ok(
    gates.includes("node scripts/protocol-coverage.mjs"),
    "GATES.md must register the protocol-coverage gate",
  );
  assert.ok(
    gates.includes("node scripts/protocol-coverage.test.mjs"),
    "GATES.md must register the protocol-coverage test suite so gates-coverage sees it wired",
  );
  const cov = spawnSync("node", [join(repoRoot, "scripts", "gates-coverage.mjs")], {
    encoding: "utf8",
    env: { ...process.env, SCRIPTS_DIR: join(repoRoot, "scripts"), GATES_FILE: gatesFile },
  });
  const out = (cov.stdout || "") + (cov.stderr || "");
  assert.equal(cov.status, 0, `gates-coverage must pass with this suite wired in (out: ${out})`);
}

// --- Criterion 6: every criterion above is covered by exactly one test -------
//     named after it.
{
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  for (let n = 1; n <= 6; n++) {
    const hits = (self.match(new RegExp(`--- Criterion ${n}:`, "g")) || []).length;
    assert.equal(hits, 1, `expected exactly one "Criterion ${n}" test block, found ${hits}`);
  }
}

console.log("protocol-coverage.test.mjs: all criteria pass");
