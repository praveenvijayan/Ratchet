#!/usr/bin/env node
// ratchet-update.test.mjs — the criteria are the test plan. One test per
// acceptance criterion of issue #46 (plan 0021-updater-ships-workflow-scripts).
// Reads the real ratchet-update.sh, .github/workflows/*.yml, and scripts/*.mjs,
// and asserts that FRAMEWORK_PATHS ships every script a shipped workflow invokes
// or a shipped script imports — so the updater can never silently drift behind
// the workflows. Zero dependencies. Run:  node scripts/ratchet-update.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // scripts/
const repo = dirname(here);
const workflowsDir = join(repo, ".github", "workflows");

// Parse the FRAMEWORK_PATHS=( ... ) array out of the updater shell script.
function frameworkPaths() {
  const sh = readFileSync(join(here, "ratchet-update.sh"), "utf8");
  const m = sh.match(/FRAMEWORK_PATHS=\(([^)]*)\)/s);
  assert.ok(m, "FRAMEWORK_PATHS=( ... ) array not found in ratchet-update.sh");
  return m[1]
    .split("\n")
    .map((line) => line.replace(/#.*$/, "")) // strip trailing comments
    .join(" ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// A referenced path resolves after an update iff it is listed verbatim or sits
// under a listed directory entry (e.g. "scripts" covers "scripts/foo.mjs").
function isCovered(relPath, paths) {
  return paths.some((p) => relPath === p || relPath.startsWith(p + "/"));
}

// Every scripts/*.mjs a shipped workflow invokes.
function workflowScriptRefs() {
  const refs = new Set();
  for (const f of readdirSync(workflowsDir)) {
    if (!f.endsWith(".yml") && !f.endsWith(".yaml")) continue;
    const body = readFileSync(join(workflowsDir, f), "utf8");
    for (const m of body.matchAll(/scripts\/[A-Za-z0-9_.-]+\.mjs/g)) refs.add(m[0]);
  }
  return [...refs];
}

// Every scripts/*.mjs a shipped (non-test) script imports.
function importedScriptRefs() {
  const refs = new Set();
  for (const f of readdirSync(here)) {
    if (!f.endsWith(".mjs") || f.endsWith(".test.mjs")) continue;
    const body = readFileSync(join(here, f), "utf8");
    for (const m of body.matchAll(/from\s+['"](\.\/[A-Za-z0-9_.-]+\.mjs)['"]/g)) {
      refs.add("scripts/" + m[1].slice(2));
    }
  }
  return [...refs];
}

const paths = frameworkPaths();

// Criterion 1: after an update, every `node scripts/<file>` referenced by any
// shipped workflow resolves in the consumer repo — it is shipped by
// FRAMEWORK_PATHS and present on disk.
{
  const refs = workflowScriptRefs();
  assert.ok(refs.length >= 1, "expected at least one workflow to invoke a scripts/*.mjs");
  const missing = refs.filter((r) => !isCovered(r, paths));
  assert.deepEqual(missing, [], `workflow-invoked scripts not shipped by FRAMEWORK_PATHS: ${missing.join(", ")}`);
  for (const r of refs) {
    assert.ok(existsSync(join(repo, r)), `${r} is invoked by a workflow but missing on disk`);
  }
}

// Criterion 2: the guard fails when a script referenced by a workflow (or
// imported by a shipped script) is missing from FRAMEWORK_PATHS — so the list
// can never silently drift again.
{
  const refs = [...new Set([...workflowScriptRefs(), ...importedScriptRefs()])];
  const missing = refs.filter((r) => !isCovered(r, paths));
  assert.deepEqual(missing, [], `referenced/imported scripts not shipped by FRAMEWORK_PATHS: ${missing.join(", ")}`);

  // The guard must genuinely reject drift, not vacuously pass: an uncovered
  // reference has to be reported missing, and a listed dir must cover its files.
  assert.equal(
    isCovered("scripts/not-shipped.mjs", ["scripts/plan-sync.mjs"]),
    false,
    "coverage check must reject a script absent from FRAMEWORK_PATHS",
  );
  assert.equal(
    isCovered("scripts/foo.mjs", ["scripts"]),
    true,
    "a listed directory entry must cover the scripts beneath it",
  );
}

// Criterion 3: DOCS.md's updater table matches the paths the script pulls —
// every FRAMEWORK_PATHS entry appears in the framework column of that table.
{
  const docs = readFileSync(join(repo, "DOCS.md"), "utf8");
  const start = docs.indexOf("Framework (pulled");
  assert.ok(start !== -1, "updater 'Framework (pulled…)' table not found in DOCS.md");
  const table = docs.slice(start, docs.indexOf("\n\n", start));
  for (const p of paths) {
    assert.ok(table.includes(p), `DOCS.md updater table is missing framework path: ${p}`);
  }
}

// Criterion 4: the updater's closing hint names /ratchet-init, not /factory-init.
{
  const sh = readFileSync(join(here, "ratchet-update.sh"), "utf8");
  assert.ok(!/factory-init/.test(sh), "ratchet-update.sh must not mention the nonexistent /factory-init");
  assert.ok(/\/ratchet-init/.test(sh), "ratchet-update.sh closing hint must name /ratchet-init");
}

function runGit(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    res.status,
    0,
    `git ${args.join(" ")} failed in ${cwd}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
  );
  return res;
}

function writeFile(root, rel, text) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function writeFrameworkTree(root, version) {
  writeFile(root, ".agents/skills/ratchet-update/SKILL.md", "name: ratchet-update\n");
  writeFile(root, ".claude/skills/ratchet-update/SKILL.md", "name: ratchet-update\n");
  writeFile(root, "plugin/skills/ratchet-update/SKILL.md", "name: ratchet-update\n");
  writeFile(root, ".claude-plugin/plugin.json", JSON.stringify({ name: "ratchet" }, null, 2) + "\n");
  writeFile(root, ".github/workflows/ratchet.yml", "name: ratchet\n");
  writeFile(root, "scripts/ratchet-update.sh", readFileSync(join(here, "ratchet-update.sh"), "utf8"));
  writeFile(root, "setup.sh", "#!/usr/bin/env sh\nexit 0\n");
  writeFile(root, "plan/README.md", "# Plan format\n");
  writeFile(root, "AGENTS.md", "# Agents\n");
  writeFile(root, "CLAUDE.md", "# Claude\n");
  writeFile(root, "GEMINI.md", "# Gemini\n");
  writeFile(root, "DOCS.md", "# Docs\n");
  if (version !== null) writeFile(root, ".ratchet-version", `${version}\n`);
}

function makeRemote(tag, version) {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-update-remote-"));
  runGit(dir, ["init", "-b", "main"]);
  runGit(dir, ["config", "user.email", "ratchet@example.invalid"]);
  runGit(dir, ["config", "user.name", "Ratchet Test"]);
  writeFrameworkTree(dir, version);
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", `release ${tag}`]);
  runGit(dir, ["tag", tag]);
  return dir;
}

function makeConsumer(initialVersion) {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-update-consumer-"));
  runGit(dir, ["init", "-b", "main"]);
  runGit(dir, ["config", "user.email", "ratchet@example.invalid"]);
  runGit(dir, ["config", "user.name", "Ratchet Test"]);
  writeFile(dir, "scripts/ratchet-update.sh", readFileSync(join(here, "ratchet-update.sh"), "utf8"));
  chmodSync(join(dir, "scripts", "ratchet-update.sh"), 0o755);
  writeFile(dir, ".ratchet-version", `${initialVersion}\n`);
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", "consumer"]);
  return dir;
}

function runUpdate(consumer, remote, ref) {
  return spawnSync("bash", ["scripts/ratchet-update.sh", ref], {
    cwd: consumer,
    env: { ...process.env, RATCHET_REMOTE: remote },
    encoding: "utf8",
  });
}

const tempRoots = [];
function tempRemote(tag, version) {
  const dir = makeRemote(tag, version);
  tempRoots.push(dir);
  return dir;
}
function tempConsumer(initialVersion) {
  const dir = makeConsumer(initialVersion);
  tempRoots.push(dir);
  return dir;
}

// Criterion 5: After ./scripts/ratchet-update.sh <tag>, the consumer's
// .ratchet-version equals the version that tag carries, under bare-vs-v
// normalisation.
{
  const remote = tempRemote("v1.4.0", "1.4.0");
  const consumer = tempConsumer("0.1.0");
  const res = runUpdate(consumer, remote, "v1.4.0");
  assert.equal(res.status, 0, `ratchet-update should succeed:\n${res.stdout}\n${res.stderr}`);
  assert.equal(readFileSync(join(consumer, ".ratchet-version"), "utf8"), "1.4.0\n");
}

// Criterion 6: Updating to a tag whose tree has no .ratchet-version records
// that tag's own version string, normalised, never a stale or empty value.
{
  const remote = tempRemote("v1.5.0", null);
  const consumer = tempConsumer("0.1.0");
  const res = runUpdate(consumer, remote, "v1.5.0");
  assert.equal(
    res.status,
    0,
    `ratchet-update should succeed without upstream .ratchet-version:\n${res.stdout}\n${res.stderr}`,
  );
  assert.equal(readFileSync(join(consumer, ".ratchet-version"), "utf8"), "1.5.0\n");
}

// Criterion 7: An unresolvable ref fails with a clear "cannot resolve ref"
// message and leaves the existing .ratchet-version unchanged.
{
  const remote = tempRemote("v1.6.0", "1.6.0");
  const consumer = tempConsumer("0.1.0");
  const res = runUpdate(consumer, remote, "does-not-exist");
  const output = `${res.stdout}\n${res.stderr}`;
  assert.notEqual(res.status, 0, "ratchet-update must fail for an unresolvable ref");
  assert.match(output, /Cannot resolve ref 'does-not-exist' upstream\./);
  assert.ok(!/\n\s+at\s+/.test(output), "failure must not leak a stack trace");
  assert.equal(readFileSync(join(consumer, ".ratchet-version"), "utf8"), "0.1.0\n");
}

for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });

console.log("PASS ratchet-update.test.mjs (all assertions)");
