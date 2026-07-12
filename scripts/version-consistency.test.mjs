#!/usr/bin/env node
// version-consistency.test.mjs — behaviour tests for the version-consistency
// gate. Zero dependencies. Run: node scripts/version-consistency.test.mjs
//
// One test per acceptance criterion of issue #82, exercised through the public
// interface (the CLI as a subprocess and the exported report functions), never
// against internals:
//   1. All four locations at the same semver -> exit 0.
//   2. Any one location different -> exit non-zero, printing each file and the
//      version it carries, as a clear message (never a stack trace).
//   3. A bare `3.3.6` and a `v`-prefixed `v3.3.6` are treated as equal.
//   4. The check is wired into GATES.md as an ordered gate, and the real repo
//      tree is consistent so the gate is green.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGates } from "./gates-table.mjs";
import { consistencyReport, normalizeVersion, reportLines } from "./version-consistency.mjs";

const CHECK = fileURLToPath(new URL("./version-consistency.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// The bare MAJOR.MINOR.PATCH of the first semver-looking value, so a fixture
// that does not set `index` defaults its static site to the tree's own version
// and never introduces spurious drift into a test aimed at another file.
function firstSemver(...vals) {
  for (const x of vals) {
    if (typeof x === "string" && /^v?\d+\.\d+\.\d+$/.test(x.trim())) return x.trim().replace(/^v/, "");
  }
  return undefined;
}

// Write an index.html carrying one `vX.Y.Z` per entry in `spec` (a string is a
// single occurrence; an array is one occurrence per element), mirroring the real
// site's hero eyebrow and install/bootstrap commands.
function writeIndex(dir, spec) {
  const list = Array.isArray(spec) ? spec : [spec];
  const body = list
    .map((v, i) => `<code>curl .../Ratchet/v${String(v).replace(/^v/, "")}/bootstrap.sh --version v${String(v).replace(/^v/, "")}</code><!--${i}-->`)
    .join("\n");
  writeFileSync(join(dir, "index.html"), `<main><p class="eyebrow">v${String(list[0]).replace(/^v/, "")}</p>${body}</main>\n`);
}

// Write a fixture tree with the five version locations. A key set to `undefined`
// omits that file entirely (to exercise the missing-file error path). `index`
// defaults to the tree's own version; pass a string or array to control the
// static site's occurrences explicitly, or `null` to omit index.html.
function makeTree(v) {
  const dir = mkdtempSync(join(tmpdir(), "version-consistency-"));
  if (v.ratchet !== undefined) writeFileSync(join(dir, ".ratchet-version"), `${v.ratchet}\n`);
  if (v.plugin !== undefined) {
    mkdirSync(join(dir, "plugin", ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(dir, "plugin", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "ratchet", version: v.plugin }, null, 2) + "\n",
    );
  }
  if (v.readme !== undefined) {
    writeFileSync(
      join(dir, "README.md"),
      `# Ratchet\n\n![framework version](https://img.shields.io/badge/framework-v${v.readme}-ea8f3c?style=for-the-badge)\n`,
    );
  }
  if (v.docs !== undefined) {
    writeFileSync(join(dir, "DOCS.md"), `# Ratchet — Docs\n\nVersion ${v.docs} · MIT\n`);
  }
  const idx = v.index !== undefined ? v.index : firstSemver(v.ratchet, v.plugin, v.readme, v.docs);
  if (idx !== undefined && idx !== null) writeIndex(dir, idx);
  return dir;
}

// Run the check CLI against a fixture root; return status + combined output.
function runCheck(root) {
  const res = spawnSync(process.execPath, [CHECK], {
    env: { ...process.env, VERSION_ROOT: root },
    encoding: "utf8",
  });
  return { status: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}

const trees = [];
const tree = (v) => {
  const dir = makeTree(v);
  trees.push(dir);
  return dir;
};

// --- Criterion 1: all four at the same semver exit 0 ---------------------
{
  const dir = tree({ ratchet: "3.6.0", plugin: "3.6.0", readme: "3.6.0", docs: "3.6.0" });
  const report = consistencyReport(dir);
  assert.equal(report.consistent, true, "matching versions must be consistent");
  assert.equal(report.version, "3.6.0");
  const green = runCheck(dir);
  assert.equal(green.status, 0, `matching tree must exit 0, got: ${green.out}`);
  assert.ok(green.out.includes("3.6.0"), "the ok message names the agreed version");
}

// --- Criterion 2: one differs -> non-zero, names each file + its version -
{
  const dir = tree({ ratchet: "3.6.0", plugin: "3.3.6", readme: "3.6.0", docs: "3.6.0" });
  const report = consistencyReport(dir);
  assert.equal(report.consistent, false, "a lone drifted file breaks consistency");

  const red = runCheck(dir);
  assert.notEqual(red.status, 0, "a disagreeing tree must exit non-zero");
  // Prints each disagreeing file with the version it carries.
  assert.ok(red.out.includes("plugin/.claude-plugin/plugin.json"), "names the drifted file");
  assert.ok(red.out.includes("3.3.6"), "prints the drifted version it carries");
  assert.ok(red.out.includes(".ratchet-version"), "prints the other files too");
  assert.ok(red.out.includes("3.6.0"), "prints the majority version it carries");
  // A clear message, never a stack trace.
  assert.ok(!/\n\s+at\s+/.test(red.out), "must not leak a stack trace");
  assert.ok(/disagree/i.test(red.out), "states the problem in words");
}

// --- Criterion 3: bare and v-prefixed are equal -------------------------
{
  // `.ratchet-version` and DOCS carry a leading `v`; the rest are bare.
  const dir = tree({ ratchet: "v3.6.0", plugin: "3.6.0", readme: "3.6.0", docs: "v3.6.0" });
  assert.equal(normalizeVersion("v3.6.0"), normalizeVersion("3.6.0"), "v-prefix normalizes away");
  const report = consistencyReport(dir);
  assert.equal(report.consistent, true, "v-prefix alone must not fail the check");
  assert.equal(runCheck(dir).status, 0, "a v-prefix-only difference must exit 0");
}

// --- Error path: a missing location fails clearly, no stack trace --------
{
  const dir = tree({ ratchet: "3.6.0", plugin: "3.6.0", readme: "3.6.0" }); // DOCS.md absent
  const red = runCheck(dir);
  assert.notEqual(red.status, 0, "an unreadable location must fail the check");
  assert.ok(red.out.includes("DOCS.md"), "names the location it could not read");
  assert.ok(!/\n\s+at\s+/.test(red.out), "read failure must not leak a stack trace");
}

// A non-semver value is reported, not thrown as a crash.
{
  const dir = tree({ ratchet: "not-a-version", plugin: "3.6.0", readme: "3.6.0", docs: "3.6.0" });
  const bad = reportLines(consistencyReport(dir));
  assert.equal(bad.code, 1, "a non-semver value fails the check");
  assert.ok(bad.lines.join("\n").includes(".ratchet-version"), "names the bad location");
}

// --- issue #331: static-site version sync -------------------------------
// #331 criterion 2: index.html versions are checked per occurrence — the gate
// fails with a clear per-occurrence report when any version in index.html
// disagrees with the rest of the tree, and passes when they agree.
{
  // Every occurrence agrees with the other locations -> green.
  const agree = tree({ ratchet: "3.6.0", plugin: "3.6.0", readme: "3.6.0", docs: "3.6.0", index: ["3.6.0", "3.6.0", "3.6.0"] });
  assert.equal(consistencyReport(agree).consistent, true, "agreeing index.html occurrences pass");
  assert.equal(runCheck(agree).status, 0, "a site whose occurrences all match the tree exits 0");

  // One occurrence drifted -> non-zero, naming that occurrence and its version.
  const drift = tree({ ratchet: "3.6.0", plugin: "3.6.0", readme: "3.6.0", docs: "3.6.0", index: ["3.6.0", "3.3.6", "3.6.0"] });
  const report = consistencyReport(drift);
  assert.equal(report.consistent, false, "a lone drifted occurrence breaks consistency");
  const red = runCheck(drift);
  assert.notEqual(red.status, 0, "a disagreeing site exits non-zero");
  assert.ok(/index\.html \(occurrence \d+\)/.test(red.out), "reports the drift per occurrence, not just the file");
  assert.ok(red.out.includes("3.3.6"), "prints the drifted version the occurrence carries");
  assert.ok(/disagree/i.test(red.out), "states the problem in words");
  assert.ok(!/\n\s+at\s+/.test(red.out), "a per-occurrence report is never a stack trace");

  // A site with no recognizable version at all is reported, not crashed.
  const empty = tree({ ratchet: "3.6.0", plugin: "3.6.0", readme: "3.6.0", docs: "3.6.0", index: null });
  writeFileSync(join(empty, "index.html"), "<main><p>no version here</p></main>\n");
  const bad = reportLines(consistencyReport(empty));
  assert.equal(bad.code, 1, "a site with no version occurrence fails the check");
  assert.ok(bad.lines.join("\n").includes("index.html"), "names index.html as the location at fault");
}

// --- Criterion 4: wired into GATES.md, and the real tree is consistent ---
{
  const gatesText = spawnSync("cat", [join(repoRoot, "GATES.md")], { encoding: "utf8" }).stdout || "";
  const rows = parseGates(gatesText);
  const wired = rows.some((r) => /version-consistency\.mjs/.test(r.command) && !/\.test\.mjs/.test(r.command));
  assert.ok(wired, "GATES.md must run `node scripts/version-consistency.mjs` as a gate");

  // The real repository tree must itself be consistent, so the gate is green.
  const report = consistencyReport(repoRoot);
  assert.equal(
    report.consistent,
    true,
    `the repo's four version locations must agree; got: ${report.entries.map((e) => `${e.file}=${e.error || e.version}`).join(", ")}`,
  );
}

for (const dir of trees) rmSync(dir, { recursive: true, force: true });
console.log("PASS version-consistency.test.mjs (4 criteria + #331 per-occurrence + error paths)");
