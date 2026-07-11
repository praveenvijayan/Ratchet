#!/usr/bin/env node
// workflow-checkout-permissions.test.mjs — issue #310. A GitHub Actions workflow
// that declares a non-empty top-level `permissions:` block drops every scope it
// does not list to `none`. A workflow that also runs `actions/checkout` therefore
// MUST list `contents` (read or write, since write implies read) or checkout
// fails with `fatal: repository not found` on private repos and the job dies
// before its script runs. This test scans every framework workflow and fails the
// moment one that checks out omits `contents` — guarding the four fixed here
// (unblock-dependents, state-label-exclusivity, review-verdict-sweep,
// conflicted-prs) and any future workflow against the same regression.
//
// Zero dependencies. Run: node scripts/workflow-checkout-permissions.test.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const wfDir = fileURLToPath(new URL("../.github/workflows/", import.meta.url));

// Isolate the top-level `permissions:` block (its indented lines, up to the next
// top-level key) so a `permissions:` nested inside a job — or a mention in a
// comment — never counts. Returns {} when the workflow has no such block, which
// is safe: with no block at all GitHub keeps its default grants, including
// contents:read, so checkout still works.
function topLevelPermissions(wf) {
  const block = wf.match(/\npermissions:\n((?:[ \t]+\S[^\n]*\n)+)/)?.[1];
  if (!block) return null;
  return Object.fromEntries(
    [...block.matchAll(/^[ \t]+([a-z-]+):[ \t]*([a-z-]+)/gim)].map((m) => [m[1], m[2]]),
  );
}

const usesCheckout = (wf) => /uses:\s*actions\/checkout/.test(wf);

// --- Criterion 2: every workflow running actions/checkout grants contents:read.
const files = readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
assert.ok(files.length > 0, "there is at least one workflow to check");

const checkoutWorkflows = [];
for (const f of files) {
  const wf = readFileSync(new URL(f, new URL("../.github/workflows/", import.meta.url)), "utf8");
  if (!usesCheckout(wf)) continue;
  const grants = topLevelPermissions(wf);
  // No explicit block → default grants include contents:read → nothing to assert.
  if (grants === null) continue;
  checkoutWorkflows.push(f);
  const contents = grants.contents;
  assert.ok(
    contents === "read" || contents === "write",
    `${f} runs actions/checkout under a non-empty permissions block, so it must grant ` +
      `contents: read (or write, which implies read); found contents=${contents ?? "<omitted>"}`,
  );
}

// --- Criterion 1: the four named workflows are among those checked and each now
// grants contents. Guards against the scan silently skipping any of them (e.g. a
// checkout step removed) and asserts the specific fix landed.
for (const named of [
  "unblock-dependents.yml",
  "state-label-exclusivity.yml",
  "review-verdict-sweep.yml",
  "conflicted-prs.yml",
]) {
  assert.ok(checkoutWorkflows.includes(named), `${named} must be covered by the checkout-permissions guard`);
  const grants = topLevelPermissions(readFileSync(new URL(named, new URL("../.github/workflows/", import.meta.url)), "utf8"));
  assert.ok(grants && (grants.contents === "read" || grants.contents === "write"), `${named} must grant contents: read`);
  // The existing scopes must survive the patch — the fix adds, never replaces.
  assert.ok(Object.keys(grants).length >= 2, `${named} must keep its existing scopes alongside contents`);
}

console.log(`PASS workflow-checkout-permissions.test.mjs (${checkoutWorkflows.length} checkout workflows)`);
