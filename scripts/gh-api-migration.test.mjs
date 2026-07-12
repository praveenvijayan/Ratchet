#!/usr/bin/env node
// gh-api-migration.test.mjs — one test per acceptance criterion of issue #343:
// "Migrate sweep and label-exclusivity scripts to the shared gh-api client".
// Zero dependencies. Run:  node scripts/gh-api-migration.test.mjs
//
// The three migrated scripts are exercised through their public surface: their
// source (for "no private copies remain") and their exported main() (for the
// shared error message). The behaviour-preserving half is covered by each
// script's own suite, which Criterion 2 runs unchanged.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveAuth } from "./gh-api.mjs";
import { main as sweepMain } from "./sweep-stale-claims.mjs";
import { main as labelMain } from "./state-label-exclusivity.mjs";
import { main as conflictMain } from "./conflicted-prs.mjs";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const src = (name) => readFileSync(here(`./${name}`), "utf8");

// The scripts under migration, and the shared names each must import. Only the
// two that page a list endpoint import `paginate`; the label enforcer never
// paginates, so requiring an unused import would be noise, not migration.
const MIGRATED = [
  { file: "sweep-stale-claims.mjs", main: sweepMain, imports: ["ghClient", "paginate", "resolveAuth"] },
  { file: "state-label-exclusivity.mjs", main: labelMain, imports: ["ghClient", "resolveAuth"] },
  { file: "conflicted-prs.mjs", main: conflictMain, imports: ["ghClient", "paginate", "resolveAuth"] },
];

// --- Criterion 1: all three scripts import ghClient/paginate/resolveAuth from
// scripts/gh-api.mjs and define no private fetch client, token resolution, or
// pagination loop. ------------------------------------------------------------
{
  for (const { file, imports } of MIGRATED) {
    const text = src(file);

    const importLine = text.match(/import\s*\{([^}]*)\}\s*from\s*["']\.\/gh-api\.mjs["']/);
    assert.ok(importLine, `${file} must import from ./gh-api.mjs`);
    const imported = importLine[1].split(",").map((s) => s.trim());
    for (const name of imports) {
      assert.ok(imported.includes(name), `${file} must import ${name} from ./gh-api.mjs`);
    }

    // No private copy of the migrated helpers or the resolution it replaced.
    assert.doesNotMatch(text, /function\s+ghClient\s*\(/, `${file} must not define its own ghClient`);
    assert.doesNotMatch(text, /function\s+paginate\s*\(/, `${file} must not define its own paginate`);
    assert.doesNotMatch(text, /const\s+API\s*=\s*["']https:\/\/api\.github\.com/, `${file} must not hardcode the API base`);
    assert.doesNotMatch(text, /Missing token or repo/, `${file} must not carry its own token/repo error`);
    assert.doesNotMatch(
      text,
      /process\.env\.GITHUB_TOKEN\s*\|\|\s*process\.env\.GITHUB_PAT/,
      `${file} must not resolve the token itself`,
    );
  }
}

// --- Criterion 2: each script's existing suite still passes unchanged in what
// it asserts (only the test plumbing may adapt to the injectable client). -----
{
  for (const { file } of MIGRATED) {
    const suite = file.replace(/\.mjs$/, ".test.mjs");
    const r = spawnSync(process.execPath, [here(`./${suite}`)], { encoding: "utf8" });
    assert.equal(r.status, 0, `existing suite ${suite} must pass unchanged:\n${r.stdout}\n${r.stderr}`);
  }
}

// --- Criterion 3: a missing token or repository produces the shared client's
// single clear error message in all three scripts. ----------------------------
{
  // resolveAuth resolved off an empty environment with no `gh` fallback: the
  // exact failure a real run hits when nothing is configured. Injecting it
  // through main({ auth }) proves each script surfaces the shared message
  // rather than crashing or inventing its own.
  const noToken = () => resolveAuth({ env: {}, readEnv: () => ({}), runCommand: () => undefined });
  const noRepo = () =>
    resolveAuth({ env: { GITHUB_TOKEN: "t" }, readEnv: () => ({}), runCommand: () => undefined });

  for (const { file, main } of MIGRATED) {
    await assert.rejects(main({ auth: noToken }), /Missing GitHub token\./, `${file} must surface the shared token error`);
    await assert.rejects(main({ auth: noRepo }), /Missing GitHub repository\./, `${file} must surface the shared repo error`);
  }
}

// --- Criterion 4: every criterion above has exactly one test named after it. --
{
  const CRITERIA_COUNT = 4;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each criterion tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `criterion ${n} has a test`);
}

console.log("PASS gh-api-migration.test.mjs (4 criteria)");
