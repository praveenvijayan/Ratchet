#!/usr/bin/env node
// manifest-check.test.mjs — behaviour tests for the install-manifest gate.
// Zero dependencies. Run: node scripts/manifest-check.test.mjs
//
// One test per acceptance criterion of issue #236, exercised through the public
// interface (CLI subprocess + exported report functions) against throwaway
// fixtures, never internals:
//   1. Every entry is classified framework | generated | excluded (all used).
//   2. `core` + the named optional profiles are declared; every framework entry
//      names exactly one of them.
//   3. A file referenced by a workflow / imported by a shipped script but absent
//      from the manifest fails, naming the offending path.
//   4. A manifest entry at a path that no longer exists fails, naming the path.
//   5. The check is wired into GATES.md as a gate, and the real repo passes it.
//   6. This suite holds exactly one test named after each criterion above.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGates } from "./gates-table.mjs";
import { checkReport, reportLines, collectReferents, loadManifest } from "./manifest-check.mjs";

const CHECK = fileURLToPath(new URL("./manifest-check.mjs", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const trees = [];
function makeRepo({ manifest, workflows = {}, scripts = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "manifest-check-"));
  trees.push(dir);
  if (manifest !== undefined) writeFileSync(join(dir, "ratchet-manifest.json"), JSON.stringify(manifest));
  if (Object.keys(workflows).length) mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  for (const [n, b] of Object.entries(workflows)) writeFileSync(join(dir, ".github", "workflows", n), b);
  if (Object.keys(scripts).length) mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const [n, b] of Object.entries(scripts)) writeFileSync(join(dir, "scripts", n), b);
  return dir;
}
function runCheck(root) {
  const res = spawnSync(process.execPath, [CHECK], { env: { ...process.env, MANIFEST_ROOT: root }, encoding: "utf8" });
  return { status: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}
const noStack = (out) => assert.ok(!/\n\s+at\s+/.test(out), "must not leak a stack trace");

const VALID = new Set(["framework", "generated", "excluded"]);
const realManifest = loadManifest(repoRoot);

// --- Criterion 1: every entry classified framework | generated | excluded ----
{
  for (const e of realManifest.files) assert.ok(VALID.has(e.class), `entry ${e.path} has invalid class "${e.class}"`);
  const classes = new Set(realManifest.files.map((e) => e.class));
  for (const c of VALID) assert.ok(classes.has(c), `manifest must use the "${c}" classification`);
}

// --- Criterion 2: core + named optional profiles; framework => one profile ---
{
  const profiles = realManifest.profiles || {};
  for (const p of ["core", "watcher", "release", "herd", "unattended-ci", "claude-plugin"]) {
    assert.ok(profiles[p], `manifest must declare the "${p}" profile`);
  }
  for (const e of realManifest.files.filter((e) => e.class === "framework")) {
    assert.ok(e.profile, `framework entry ${e.path} must name a profile`);
    assert.ok(profiles[e.profile], `framework entry ${e.path} names undeclared profile "${e.profile}"`);
  }
  const profileOf = (p) => realManifest.files.find((e) => e.path === p)?.profile;
  assert.equal(profileOf(".github/workflows/release.yml"), "release");
  assert.equal(profileOf(".github/workflows/ratchet-run.yml"), "unattended-ci");
  assert.equal(profileOf("scripts/herd.mjs"), "herd");
  assert.equal(profileOf(".agents/skills/ratchet-herd"), "herd");
  assert.equal(profileOf("scripts/ratchet-watch.sh"), "watcher");
}

// --- Criterion 3: referenced-but-unlisted file fails, naming the path --------
{
  // Both channels: a workflow `run:` reference and a shipped-script import.
  const dir = makeRepo({
    manifest: { profiles: { core: "base" }, files: [{ path: "scripts/main.mjs", class: "framework", profile: "core" }] },
    workflows: { "run.yml": "steps:\n  - run: node scripts/foo.mjs\n" },
    scripts: { "main.mjs": "import { x } from './helper.mjs'\n", "foo.mjs": "// x\n", "helper.mjs": "export const x = 1\n" },
  });
  assert.ok(collectReferents(dir).includes("scripts/foo.mjs"), "sees the workflow reference");
  assert.deepEqual(checkReport(dir).missingFromManifest, ["scripts/foo.mjs", "scripts/helper.mjs"]);
  const red = runCheck(dir);
  assert.notEqual(red.status, 0, "an unlisted referenced file must fail the check");
  assert.ok(red.out.includes("scripts/foo.mjs") && red.out.includes("scripts/helper.mjs"), "names the offending paths");
  assert.ok(/MISSING from the manifest/i.test(red.out), "states the problem in words");
  noStack(red.out);
}

// --- Criterion 4: manifest entry at a vanished path fails, naming the path ---
{
  const dir = makeRepo({ manifest: { profiles: { core: "base" }, files: [{ path: "scripts/ghost.mjs", class: "framework", profile: "core" }] } });
  assert.deepEqual(checkReport(dir).missingOnDisk, ["scripts/ghost.mjs"]);
  const red = runCheck(dir);
  assert.notEqual(red.status, 0, "a vanished manifest path must fail the check");
  assert.ok(red.out.includes("scripts/ghost.mjs"), "names the offending path");
  assert.ok(/MISSING on disk/i.test(red.out), "states the problem in words");
  noStack(red.out);

  // Error path: no manifest at all fails clearly, not a crash.
  const bare = makeRepo({ manifest: undefined });
  const missing = runCheck(bare);
  assert.notEqual(missing.status, 0, "a missing manifest must fail the check");
  assert.ok(missing.out.includes("ratchet-manifest.json"), "names the file it could not find");
  noStack(missing.out);
}

// --- Criterion 5: wired into GATES.md, and the real repo passes the gate -----
{
  const rows = parseGates(readFileSync(join(repoRoot, "GATES.md"), "utf8"));
  assert.ok(rows.some((r) => /manifest-check\.mjs/.test(r.command) && !/\.test\.mjs/.test(r.command)),
    "GATES.md must run `node scripts/manifest-check.mjs` as a gate");
  const report = checkReport(repoRoot);
  assert.ok(report.ok, `the real repo must pass manifest-check; got: ${reportLines(report).lines.join(" | ")}`);
}

// --- Criterion 6: exactly one test block named after each criterion ----------
{
  const src = readFileSync(SELF, "utf8");
  for (let n = 1; n <= 6; n++) {
    const hits = src.match(new RegExp(`--- Criterion ${n}:`, "g")) || [];
    assert.equal(hits.length, 1, `expected exactly one "Criterion ${n}" test block, found ${hits.length}`);
  }
}

for (const dir of trees) rmSync(dir, { recursive: true, force: true });
console.log("PASS manifest-check.test.mjs (6 criteria + error paths)");
