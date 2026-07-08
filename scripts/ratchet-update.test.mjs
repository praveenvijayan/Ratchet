#!/usr/bin/env node
// ratchet-update.test.mjs — the criteria are the test plan. One test per
// acceptance criterion of issue #46 (plan 0021-updater-ships-workflow-scripts).
// Reads the real ratchet-update.sh, .github/workflows/*.yml, and scripts/*.mjs,
// and asserts that FRAMEWORK_PATHS ships every script a shipped workflow invokes
// or a shipped script imports — so the updater can never silently drift behind
// the workflows. Zero dependencies. Run:  node scripts/ratchet-update.test.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
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

console.log("PASS ratchet-update.test.mjs (all assertions)");
