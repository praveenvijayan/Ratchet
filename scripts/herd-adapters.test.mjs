#!/usr/bin/env node
// herd-adapters.test.mjs — behaviour tests for issue #393, one per acceptance
// criterion, through the public interface (module exports + their real source):
//   1. resolveAdapter, substitute, extractUsage are exported from a new module
//      that imports nothing from herd.mjs, directly or transitively.
//   2. herd.mjs still exports the same three names with identical behavior, and
//      every pre-existing test passes unchanged.
// Zero dependencies. Run:  node scripts/herd-adapters.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as leaf from "./herd-adapters.mjs";
import * as herd from "./herd.mjs";

const scriptsDir = fileURLToPath(new URL("./", import.meta.url));
const herdPath = resolve(scriptsDir, "herd.mjs");

// Transitive closure of local (`./`-relative) modules reachable from `entry`,
// following every static import. node: builtins and packages are leaves. Lets a
// test assert a forbidden module appears nowhere in the graph — the
// "transitively" half of criterion 1.
function transitiveLocalImports(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    const specs = [...src.matchAll(/\bimport\b[^;]*?\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
    specs.push(...[...src.matchAll(/\bimport\s*["']([^"']+)["']/g)].map((m) => m[1]));
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue; // node: builtin or package — a leaf
      visit(resolve(dirname(file), spec));
    }
  };
  visit(entry);
  return seen;
}

// --- Criterion 1: the three helpers live in a new leaf module that imports
// nothing from herd.mjs, directly or transitively -----------------------------
{
  const leafPath = resolve(scriptsDir, "herd-adapters.mjs");
  assert.ok(existsSync(leafPath), "the new leaf module scripts/herd-adapters.mjs exists");
  for (const name of ["resolveAdapter", "substitute", "extractUsage"]) {
    assert.equal(typeof leaf[name], "function", `herd-adapters.mjs exports ${name}`);
  }
  // The leaf must not reach herd.mjs through any import chain — that is the
  // cycle it exists to break.
  const graph = transitiveLocalImports(leafPath);
  assert.ok(!graph.has(herdPath), "herd-adapters.mjs must not import herd.mjs, directly or transitively");
}

// --- Criterion 2: herd.mjs re-exports the same three names with identical
// behavior, and the pre-existing herd suite passes unchanged ------------------
{
  // Identity of the binding is the strongest form of "identical behavior": the
  // name re-exported from herd.mjs IS the leaf's function, not a reimplementation.
  for (const name of ["resolveAdapter", "substitute", "extractUsage"]) {
    assert.equal(typeof herd[name], "function", `herd.mjs still exports ${name}`);
    assert.equal(herd[name], leaf[name], `herd.mjs's ${name} is the same function as the leaf's`);
  }
  // The pre-existing suite must still pass unchanged against the split module.
  const res = spawnSync(process.execPath, [join(scriptsDir, "herd.test.mjs")], { encoding: "utf8" });
  assert.equal(res.status, 0, `pre-existing herd.test.mjs must pass unchanged; got:\n${res.stdout}${res.stderr}`);
}

console.log("PASS herd-adapters.test.mjs (2 criteria)");
