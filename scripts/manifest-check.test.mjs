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
// Plus #237 criteria 7-10 (excluded-runtime + shippable-test gates) and #248
// criteria 1-4 (manifest lists every scripts/*.test.mjs individually excluded
// with no gaps, manifest-check.mjs reports consistent, this suite passes, and
// one test block per #248 criterion).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGates } from "./gates-table.mjs";
import { checkReport, reportLines, collectReferents, collectTestFiles, loadManifest } from "./manifest-check.mjs";

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
  assert.equal(profileOf("scripts/herd.mjs"), "core");
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

// --- Criterion 7: the manifest classifies every file under scripts/ individually
// --- (each workflow-invoked or imported runtime script is framework with its
// --- owning profile; every *.test.mjs and framework-only dev helper is excluded)
{
  const { readdirSync, statSync } = await import("node:fs");
  // No glob entry may cover scripts/ — every file must have its own entry.
  const globScripts = realManifest.files.filter((e) => e.glob && e.path.startsWith("scripts/"));
  assert.equal(globScripts.length, 0, "no glob entry may cover scripts/ — every file must be classified individually");

  // Every file on disk under scripts/ has an individual manifest entry.
  const scriptFiles = readdirSync(join(repoRoot, "scripts"))
    .filter((n) => statSync(join(repoRoot, "scripts", n)).isFile())
    .map((n) => `scripts/${n}`)
    .sort();
  for (const f of scriptFiles) {
    const individual = realManifest.files.find((e) => !e.glob && (e.path === f || f.startsWith(e.path + "/")));
    assert.ok(individual, `scripts/ file ${f} must have an individual manifest entry`);
  }

  // Runtime scripts (referents) are framework with a declared profile.
  for (const ref of collectReferents(repoRoot)) {
    if (!ref.startsWith("scripts/")) continue;
    const entry = realManifest.files.find((e) => e.path === ref);
    assert.ok(entry, `runtime script ${ref} must be in the manifest`);
    assert.equal(entry.class, "framework", `runtime script ${ref} must be framework, got ${entry.class}`);
    assert.ok(entry.profile, `runtime script ${ref} must name a profile`);
  }

  // Test files are excluded.
  for (const f of collectTestFiles(repoRoot)) {
    const entry = realManifest.files.find((e) => e.path === f);
    assert.ok(entry, `test file ${f} must be in the manifest`);
    assert.equal(entry.class, "excluded", `test file ${f} must be excluded, got ${entry.class}`);
  }
}

// --- Criterion 8: a test fails when any script invoked by a shipped workflow or
// --- imported by a shipped script is classified `excluded`, printing the missing
// --- script names — the classification can never break a shipped workflow
{
  // A runtime script referenced by a workflow, but classified `excluded`.
  const dir = makeRepo({
    manifest: {
      profiles: { core: "base" },
      files: [
        { path: "scripts/used.mjs", class: "excluded" },
        { path: "scripts/main.mjs", class: "framework", profile: "core" },
      ],
    },
    workflows: { "run.yml": "steps:\n  - run: node scripts/used.mjs\n" },
    scripts: { "used.mjs": "// runtime\n", "main.mjs": "import { x } from './used.mjs'\n" },
  });
  const report = checkReport(dir);
  assert.deepEqual(report.excludedReferents, ["scripts/used.mjs"],
    "a referenced script classified `excluded` must appear in excludedReferents");
  const red = runCheck(dir);
  assert.notEqual(red.status, 0, "classifying a runtime script as excluded must fail the check");
  assert.ok(red.out.includes("scripts/used.mjs"), "must print the offending script name");
  assert.ok(/classified.*excluded/i.test(red.out), "must state the problem in words");
  noStack(red.out);

  // A clean manifest (same script classified framework) passes.
  const cleanDir = makeRepo({
    manifest: {
      profiles: { core: "base" },
      files: [
        { path: "scripts/used.mjs", class: "framework", profile: "core" },
        { path: "scripts/main.mjs", class: "framework", profile: "core" },
      ],
    },
    workflows: { "run.yml": "steps:\n  - run: node scripts/used.mjs\n" },
    scripts: { "used.mjs": "// runtime\n", "main.mjs": "import { x } from './used.mjs'\n" },
  });
  assert.deepEqual(checkReport(cleanDir).excludedReferents, [], "a properly classified runtime script does not trip the check");
}

// --- Criterion 9: a test fails when any scripts/*.test.mjs file is classified as
// --- shippable, so tests can never leak back into host installs
{
  // A test file classified `framework` — would ship to host installs.
  const dir = makeRepo({
    manifest: {
      profiles: { core: "base" },
      files: [
        { path: "scripts/main.mjs", class: "framework", profile: "core" },
        { path: "scripts/leaked.test.mjs", class: "framework", profile: "core" },
      ],
    },
    scripts: { "main.mjs": "// runtime\n", "leaked.test.mjs": "// test\n" },
  });
  const report = checkReport(dir);
  assert.deepEqual(report.shippableTests, ["scripts/leaked.test.mjs"],
    "a test file classified `framework` must appear in shippableTests");
  const red = runCheck(dir);
  assert.notEqual(red.status, 0, "classifying a test file as shippable must fail the check");
  assert.ok(red.out.includes("scripts/leaked.test.mjs"), "must print the offending test file name");
  assert.ok(/shippable/i.test(red.out), "must state the problem in words");
  noStack(red.out);

  // A test file classified `excluded` passes.
  const cleanDir = makeRepo({
    manifest: {
      profiles: { core: "base" },
      files: [
        { path: "scripts/main.mjs", class: "framework", profile: "core" },
        { path: "scripts/safe.test.mjs", class: "excluded" },
      ],
    },
    scripts: { "main.mjs": "// runtime\n", "safe.test.mjs": "// test\n" },
  });
  assert.deepEqual(checkReport(cleanDir).shippableTests, [], "a test file classified `excluded` does not trip the check");

  // The real repo passes: no test file is shippable.
  assert.deepEqual(checkReport(repoRoot).shippableTests, [], "the real repo has no shippable test files");
}

// --- Criterion 10: exactly one test block named after each criterion of #237 --
{
  const src = readFileSync(SELF, "utf8");
  for (let n = 7; n <= 10; n++) {
    const hits = src.match(new RegExp(`--- Criterion ${n}:`, "g")) || [];
    assert.equal(hits.length, 1, `expected exactly one "Criterion ${n}" test block, found ${hits.length}`);
  }
}

// --- #248 Criterion 1: ratchet-manifest.json lists every scripts/*.test.mjs file
// --- on disk as an individual `excluded` entry, with no gaps (no missing, no
// --- extra, no glob covering scripts/).
{
  const onDisk = collectTestFiles(repoRoot);
  const excludedIndividual = realManifest.files
    .filter((e) => e.class === "excluded" && !e.glob && /^scripts\/[^/]+\.test\.mjs$/.test(e.path))
    .map((e) => e.path)
    .sort();
  assert.deepEqual(excludedIndividual, onDisk,
    `every scripts/*.test.mjs on disk must have an individual excluded manifest entry, no gaps; disk has ${onDisk.length}, manifest has ${excludedIndividual.length}`);
  const globScripts = realManifest.files.filter((e) => e.glob && e.path.startsWith("scripts/"));
  assert.equal(globScripts.length, 0, "no glob entry may cover scripts/ — each test file is classified individually");
}

// --- #248 Criterion 2: node scripts/manifest-check.mjs reports the manifest is
// --- consistent with the repo (CLI subprocess, exit 0 + human message).
{
  const res = spawnSync(process.execPath, [CHECK], { encoding: "utf8" });
  assert.equal(res.status, 0, `manifest-check.mjs must exit 0 on the real repo (stderr: ${(res.stderr || "").slice(0, 200)})`);
  assert.match(res.stdout || "", /consistent with the repo/, "manifest-check.mjs must report the manifest is consistent");
}

// --- #248 Criterion 3: node scripts/manifest-check.test.mjs passes (the suite
// --- runs to completion and exits 0). To avoid infinite self-recursion, the
// --- child run sets MANIFEST_CHECK_CHILD=1 which makes this block skip the
// --- self-spawn; the outer run asserts the child exits 0 with a PASS line.
{
  if (process.env.MANIFEST_CHECK_CHILD) {
    assert.ok(true, "child run skips the self-spawn (recursion guard)");
  } else {
    const res = spawnSync(process.execPath, [SELF], {
      env: { ...process.env, MANIFEST_CHECK_CHILD: "1" },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `manifest-check.test.mjs must exit 0 (stderr: ${(res.stderr || "").slice(0, 200)})`);
    assert.match(res.stdout || "", /PASS manifest-check\.test\.mjs/, "child run must print the PASS line");
  }
}

// --- #248 Criterion 4: exactly one test block named after each #248 criterion.
{
  const src = readFileSync(SELF, "utf8");
  for (let n = 1; n <= 4; n++) {
    const hits = src.match(new RegExp(`--- #248 Criterion ${n}:`, "g")) || [];
    assert.equal(hits.length, 1, `expected exactly one "#248 Criterion ${n}" test block, found ${hits.length}`);
  }
}

for (const dir of trees) rmSync(dir, { recursive: true, force: true });
console.log("PASS manifest-check.test.mjs (6 #236 criteria + 4 #237 criteria + 4 #248 criteria + error paths)");
