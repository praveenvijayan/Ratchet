#!/usr/bin/env node
// map-onboarding.test.mjs — the acceptance criteria of issue #429 (plan 0180,
// ship a generated MAP.md workers read before exploring) are the test plan:
// exactly one test per criterion. The staleness check itself lives here — a test
// wired into GATES.md IS the automated gate, run on the real checked-in MAP.md
// every CI pass. Fully offline, zero dependencies. Run:
//   node scripts/map-onboarding.test.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAP_PATH = join(ROOT, "MAP.md");

// The automated staleness check (criterion 3/4). Parse the map's leading bullet
// paths — lines of the form "- `<path>` — …" — and report every one that no
// longer exists under `root`. A missing map is not stale: it reports absent with
// an empty stale list, so a repo without MAP.md tolerates the check (criterion 4).
function mapStaleness(mapPath, { root = ROOT } = {}) {
  if (!existsSync(mapPath)) return { present: false, stale: [] };
  const md = readFileSync(mapPath, "utf8");
  const paths = [];
  for (const line of md.split("\n")) {
    const m = /^-\s+`([^`]+)`/.exec(line);
    if (m) paths.push(m[1]);
  }
  const stale = paths.filter((p) => !existsSync(join(root, p)));
  return { present: true, stale, checked: paths.length };
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// Criterion 1: a generated MAP.md exists at the repo root, carrying a generation
// date and a one-line instruction for regenerating it (the ratchet-map skill).
test("MAP.md exists at the repo root with a generation date and a ratchet-map regen instruction", () => {
  assert.ok(existsSync(MAP_PATH), "MAP.md exists at the repo root");
  const md = readFileSync(MAP_PATH, "utf8");
  assert.match(md, /Generated \d{4}-\d{2}-\d{2}/, "carries a machine-readable generation date");
  assert.match(md, /Regenerate with the `ratchet-map` skill/, "names the ratchet-map skill as its regenerator");
});

// Criterion 2: the AGENTS.md kernel directs agents to read MAP.md (when present)
// before exploring the codebase.
test("the AGENTS.md kernel directs agents to read MAP.md before exploring, when present", () => {
  const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  const row = agents.split("\n").find((l) => /`MAP\.md`/.test(l));
  assert.ok(row, "AGENTS.md references MAP.md");
  assert.match(row, /before exploring/i, "the directive is to read it before exploring the codebase");
  assert.match(row, /if present|when present/i, "the directive is conditional on MAP.md being present");
});

// Criterion 3: an automated staleness check fails when a path listed in MAP.md no
// longer exists, naming the stale entries — and the real checked-in MAP.md is
// itself never stale (this is the ongoing CI guard).
test("the staleness check flags and names a listed path that no longer exists, and the real map is current", () => {
  const real = mapStaleness(MAP_PATH);
  assert.equal(real.present, true, "the real map is read");
  assert.deepEqual(real.stale, [], `the checked-in MAP.md lists only real paths (stale: ${real.stale.join(", ")})`);
  assert.ok(real.checked >= 1, "at least one path is actually checked");

  // Synthetic map with one path that does not exist -> reported by name.
  const tmp = join(ROOT, "scripts", "__map_fixture_missing.md");
  writeFixture(tmp, "# m\n- `AGENTS.md` — real\n- `no/such/path.xyz` — gone\n");
  try {
    const { stale } = mapStaleness(tmp);
    assert.deepEqual(stale, ["no/such/path.xyz"], "the vanished path is named, the real one is not");
  } finally {
    removeFixture(tmp);
  }
});

// Criterion 4: a repo without MAP.md behaves exactly as today — the contract
// wording and the staleness check both tolerate absence.
test("a repo without MAP.md is tolerated by both the wording and the staleness check", () => {
  const absent = mapStaleness(join(ROOT, "scripts", "__map_does_not_exist.md"));
  assert.deepEqual(absent, { present: false, stale: [] }, "an absent map is not stale and does not throw");
  // The contract directive is conditional ("if present"), so an absent map leaves
  // today's behaviour unchanged — asserted structurally in criterion 2's row.
  const row = readFileSync(join(ROOT, "AGENTS.md"), "utf8").split("\n").find((l) => /`MAP\.md`/.test(l));
  assert.match(row, /if present|when present/i, "the directive stays conditional, not mandatory");
});

function writeFixture(path, content) {
  writeFileSync(path, content);
}
function removeFixture(path) {
  rmSync(path, { force: true });
}

console.log(`\n${passed} tests passed`);
